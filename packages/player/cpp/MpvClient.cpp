#include "MpvClient.hpp"

#include <mpv/client.h>

#include <cstring>
#include <utility>

namespace rnmedia {

namespace {

/// Audio-only defaults, applied before any user option so users can override
/// them. `vid=no` + `audio-display=no` keep the video chain out of the picture
/// entirely (the core must never touch `render.h`); `force-window=no` stops mpv
/// from ever trying to create one; `idle=yes` keeps the core alive with an
/// empty playlist instead of shutting down.
constexpr const char* kAudioOnlyDefaults[][2] = {
    {"vid", "no"},
    {"force-window", "no"},
    {"idle", "yes"},
    {"audio-display", "no"},
};

#if defined(__APPLE__)
/// Apple-only defaults. Same ordering rule as `kAudioOnlyDefaults` — applied
/// before the caller's options, so an app can put any of them back.
///
/// `AVAudioSession` is a **process-wide singleton**, and stock `ao_audiounit`
/// treats it as if it owned it: `init()` sets category, mode, active state and
/// preferred channel count, and it does so on every AO open — i.e. at every
/// playback start, not once. That is wrong for this library twice over.
///
/// 1. **Ownership.** `@rn-media/audio-session` is the package that owns the
///    session (categories, interruptions, route changes), exactly as it owns
///    audio focus on Android — where this player requests none. Two owners is
///    worse than either, which is why our fork's patch 007 added this option
///    in the first place (rn-media-engine
///    `patches/007-mpv-audiounit-shared-session`, whose docs name
///    `packages/audio-session` as the intended owner). Not setting it left the
///    engine and the host fighting, and the engine — reopening its AO on every
///    playback start — always configured last and won.
/// 2. **It broke the iOS now-playing surface.** mpv calls
///    `setCategory:withOptions:error:`, the variant that cannot carry a route
///    sharing policy, so the `.longFormAudio` policy
///    `@rn-media/audio-session` sets was reset to `.default` and the mode was
///    forced to `.moviePlayback` — after which CoreAudio refused the output
///    client (`AQIONode.cpp: is NOT Now Playing eligible`) and iOS showed no
///    Lock Screen / Control Center card, however correct
///    `MPNowPlayingInfoCenter` and `MPRemoteCommandCenter` were.
///
/// What is proven, and what is not (2026-08-16, iPhone 17 Pro + iOS 26.2
/// simulator — this project's first on-device iOS run): the clobber is proven
/// from the shipped `Mpv.framework` itself (`nm -u` lists
/// `_AVAudioSessionCategoryPlayback` and `_AVAudioSessionModeMoviePlayback`;
/// the policy-carrying setter appears zero times), and the missing card was
/// observed on the device. That this option *restores* the card is **not**
/// confirmed: the simulator's `AVAudioSession` is a shim that reports the
/// client ineligible either way, so only a device run of the fixed build can
/// close it. See ARCHITECTURE §26, which carries the same caveat.
///
/// Tolerated rather than required (see `setOptionIfKnown`): the option only
/// exists on a libmpv carrying patch 007, and a player that refuses to be
/// created because an engine predates a patch would be a worse failure than
/// the one this fixes.
constexpr const char* kAppleOnlyDefaults[][2] = {
    {"audiounit-skip-session-management", "yes"},
};
#endif

/// Reserved key in the options map: it is the argument to
/// `mpv_request_log_messages`, not an mpv option (mpv has no `log-level`
/// option, so this cannot shadow a real one).
constexpr const char* kLogLevelKey = "log-level";
constexpr const char* kDefaultLogLevel = "warn";

/// The hook mpv fires on its **prefetch** path. Not an upstream hook: stock
/// `prefetch_next()` calls `start_open()` on the raw playlist filename and
/// never enters the hook pipeline (mpv 0.41.0 `player/loadfile.c:1276-1286`),
/// and upstream documents that as permanent ("This does not work with URLs
/// resolved by the youtube-dl wrapper, and it won't" — `options.rst`, on
/// `--prefetch-playlist`). Our forks add it. On a libmpv that does not, this
/// name simply never fires — `mpv_hook_add` accepts unknown names by design
/// (`client.h`: "if the name is unknown, the hook event will simply be never
/// raised"), so registering it costs nothing and breaks nothing.
constexpr const char* kPrefetchLoadHook = "on_prefetch_load";
/// Stock mpv's load hook, fired between "assign the raw URL to
/// `stream_open_filename`" and "open it" (`loadfile.c:1725`). It fires for the
/// same entry the prefetch hook already saw, which is exactly why the cache has
/// to be deterministic.
constexpr const char* kLoadHook = "on_load";
/// `client.h`: "Use 0 as a neutral default." Lua scripts conventionally use 50
/// and lower priorities run first, so ours runs ahead of any script — which is
/// what we want, since we are the ones who know the resolved URL.
constexpr int kHookPriority = 0;

/// The property a load hook rewrites. mpv `input.rst`: "This property should be
/// set only during the `on_load` or `on_load_fail` hooks, otherwise it will
/// have no effect."
///
/// NOTE (mpv 0.41.0 `player/command.c:564`): the *getter* runs the value
/// through `mp_normalize_path`, which passes URLs and `-` through verbatim but
/// makes a **relative local path absolute against the CWD**. So the key this
/// cache sees for a relative path is not the string the caller passed. Key
/// resolutions off URLs (or absolute paths); the TypeScript layer documents the
/// same constraint.
constexpr const char* kStreamOpenFilename = "stream-open-filename";
/// Read-only int64 added by the rn-media fork alongside `on_prefetch_load`, and
/// readable ONLY while that hook is open — at prefetch time mpv's own
/// `playlist-current-pos` still points at the *playing* entry, and
/// `MPV_EVENT_START_FILE` (which carries `playlist_entry_id` on the normal
/// path) has not been sent for the entry being prefetched. Hence: read it
/// before `mpv_hook_continue`, never after.
constexpr const char* kPrefetchEntryId = "prefetch-playlist-entry-id";

std::string tagged(int code, const std::string& message) {
  return std::string(kErrorTagPrefix) + std::to_string(code) + "] " + message + ": " + mpv_error_string(code);
}

EndFileReason toEndFileReason(int reason) {
  switch (reason) {
    case MPV_END_FILE_REASON_EOF:
      return EndFileReason::EndOfFile;
    case MPV_END_FILE_REASON_STOP:
      return EndFileReason::Stop;
    case MPV_END_FILE_REASON_QUIT:
      return EndFileReason::Quit;
    case MPV_END_FILE_REASON_ERROR:
      return EndFileReason::Error;
    case MPV_END_FILE_REASON_REDIRECT:
      return EndFileReason::Redirect;
    default:
      // client.h: "Unknown values should be treated as unknown."
      return EndFileReason::Unknown;
  }
}

LogLevel toLogLevel(int level) {
  switch (level) {
    case MPV_LOG_LEVEL_FATAL:
      return LogLevel::Fatal;
    case MPV_LOG_LEVEL_ERROR:
      return LogLevel::Error;
    case MPV_LOG_LEVEL_WARN:
      return LogLevel::Warn;
    case MPV_LOG_LEVEL_INFO:
      return LogLevel::Info;
    case MPV_LOG_LEVEL_V:
      return LogLevel::Verbose;
    case MPV_LOG_LEVEL_DEBUG:
      return LogLevel::Debugging;
    case MPV_LOG_LEVEL_TRACE:
      return LogLevel::Trace;
    default:
      return LogLevel::Info;
  }
}

mpv_format toMpvFormat(PropertyFormat format) {
  switch (format) {
    case PropertyFormat::String:
      return MPV_FORMAT_STRING;
    case PropertyFormat::Number:
      return MPV_FORMAT_DOUBLE;
    case PropertyFormat::Bool:
      return MPV_FORMAT_FLAG;
  }
  return MPV_FORMAT_NONE;
}

} // namespace

MpvError::MpvError(int code, const std::string& message) : std::runtime_error(tagged(code, message)), _code(code) {}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

MpvClient::MpvClient(BatchReadyFn onBatchReady, CommandReplyFn onCommandReply,
                     ResolutionRequestFn onResolutionRequest, PrefetchStartedFn onPrefetchStarted)
    : _onBatchReady(std::move(onBatchReady)), _onCommandReply(std::move(onCommandReply)),
      _onResolutionRequest(std::move(onResolutionRequest)), _onPrefetchStarted(std::move(onPrefetchStarted)) {
  mpv_handle* handle = mpv_create();
  if (handle == nullptr) {
    throw MpvError(MPV_ERROR_NOMEM, "mpv_create() failed");
  }
  _handle = handle;
}

MpvClient::~MpvClient() {
  destroy();
}

void MpvClient::setOptionOrThrow(mpv_handle* handle, const std::string& name, const std::string& value) {
  const int status = mpv_set_option_string(handle, name.c_str(), value.c_str());
  if (status < 0) {
    throw MpvError(status, "mpv_set_option_string(\"" + name + "\", \"" + value + "\")");
  }
}

void MpvClient::setOptionIfKnown(mpv_handle* handle, const std::string& name, const std::string& value) {
  const int status = mpv_set_option_string(handle, name.c_str(), value.c_str());
  // `MPV_ERROR_OPTION_NOT_FOUND` is the one tolerated outcome: it means this
  // libmpv does not carry the option, which is a fact about the engine and not
  // a caller error. Every other failure is still a hard error — a *known*
  // option that will not take the value we ask for is a real bug.
  if (status < 0 && status != MPV_ERROR_OPTION_NOT_FOUND) {
    throw MpvError(status, "mpv_set_option_string(\"" + name + "\", \"" + value + "\")");
  }
}

void MpvClient::initialize(const std::unordered_map<std::string, std::string>& options) {
  // Serialises against `destroy()` and guarantees `_handle` stays alive for
  // the whole of initialize.
  std::shared_lock<std::shared_mutex> lock(_handleMutex);
  if (_handle == nullptr) {
    throw DisposedError("initialize");
  }
  mpv_handle* handle = _handle;

  for (const auto& option : kAudioOnlyDefaults) {
    setOptionOrThrow(handle, option[0], option[1]);
  }

#if defined(__APPLE__)
  for (const auto& option : kAppleOnlyDefaults) {
    setOptionIfKnown(handle, option[0], option[1]);
  }
#endif

  std::string logLevel = kDefaultLogLevel;
  for (const auto& [name, value] : options) {
    if (name == kLogLevelKey) {
      logLevel = value;
      continue;
    }
    setOptionOrThrow(handle, name, value);
  }

  const int logStatus = mpv_request_log_messages(handle, logLevel.c_str());
  if (logStatus < 0) {
    throw MpvError(logStatus, "mpv_request_log_messages(\"" + logLevel + "\")");
  }

  const int status = mpv_initialize(handle);
  if (status < 0) {
    throw MpvError(status, "mpv_initialize()");
  }

  // Both load hooks, always, before the event thread exists — see
  // `registerLoadHooks`. Anything mpv raises before the thread starts simply
  // waits in mpv's own queue, and nothing can be loaded yet anyway.
  registerLoadHooks(handle);

  // Only flip the state once mpv is actually running, so a failed initialize
  // leaves the client in `Created` (still destroyable, not usable).
  _state.markInitialized();
  _eventThread = std::thread([this, handle]() { eventLoop(handle); });
}

///
/// Register `on_prefetch_load` and `on_load`, unconditionally.
///
/// This used to be lazy — registered on the first `installSourceResolver()` —
/// so that a core with no resolver ran a byte-for-byte stock load path. Two
/// things bought the change:
///
///  1. **The prefetch hook is now an observation, not just a rewrite point.**
///     `PrefetchStartedFn` reports the exact instant mpv releases its opener
///     thread on the next entry, and a hook that is registered only once an app
///     happens to install a resolver cannot report anything about the app that
///     does not.
///  2. **"Stock" is a property of the hook name having no client at all**, and
///     it is the *only* thing the fork guarantees. Quoting the patch's own
///     header (`006.rn_media_prefetch_hook.patch`, "THREADING AND COST"): "With
///     no client registered the added cost is one `mp_hook_exists()` call — a
///     walk of the (usually empty) hook array — and nothing else. […] that path
///     allocates nothing, swaps nothing, and hands `start_open()` exactly the
///     arguments upstream hands it." The moment *any* client holds the name,
///     `prefetch_next()` takes the hook branch and `process_hooks()` becomes a
///     blocking pump on mpv's core thread. Registering late therefore does not
///     buy stock behaviour; it only moves the instant at which behaviour
///     changes into the middle of a session, where it is unobservable.
///
/// The price, paid deliberately: one immediate `mpv_hook_continue` per load
/// boundary — mpv's core thread parks in `process_hooks()`'s `mp_idle()` loop
/// for as long as it takes this client's event thread to see the hook event and
/// continue it, with nothing read and nothing rewritten while the resolver is
/// disarmed. Registration is permanent either way; mpv has no unregister call.
///
void MpvClient::registerLoadHooks(mpv_handle* handle) {
  // `on_prefetch_load` is unknown to a stock libmpv, and `client.h` guarantees
  // that is harmless: "if the name is unknown, the hook event will simply be
  // never raised". So this is one registration, not a per-binary branch.
  const int prefetchStatus = mpv_hook_add(handle, 0, kPrefetchLoadHook, kHookPriority);
  if (prefetchStatus < 0) {
    throw MpvError(prefetchStatus, std::string("mpv_hook_add(\"") + kPrefetchLoadHook + "\")");
  }
  const int loadStatus = mpv_hook_add(handle, 0, kLoadHook, kHookPriority);
  if (loadStatus < 0) {
    throw MpvError(loadStatus, std::string("mpv_hook_add(\"") + kLoadHook + "\")");
  }
}

void MpvClient::destroy() noexcept {
  if (!_state.markDestroyed()) {
    return; // somebody else already destroyed (or is destroying) this client
  }

  mpv_handle* handle = nullptr;
  {
    // Exclusive: waits out any in-flight mpv call on another thread, then
    // makes the handle unreachable for every future one.
    std::unique_lock<std::shared_mutex> lock(_handleMutex);
    handle = _handle;
    _handle = nullptr;
  }
  if (handle == nullptr) {
    return;
  }

  _stopRequested.store(true, std::memory_order_release);
  // Before the join, not after: the event thread may be parked in a play-time
  // `on_load` hold for up to `resolverTimeoutMs`, and nothing is going to
  // answer it now. `abort()` releases it and refuses any future hold, so this
  // join stays bounded and short.
  _resolverActive.store(false, std::memory_order_release);
  _resolutionGate.abort();
  if (_eventThread.joinable()) {
    mpv_wakeup(handle);
    _eventThread.join();
  }
  _resolutionCache.clear();
  _batch.reset();

  // `mpv_terminate_destroy` blocks. Nothing else can reach `handle` any more:
  // `_handle` is null and the only other holder (the event thread) is joined.
  std::thread([handle]() { mpv_terminate_destroy(handle); }).detach();
}

// ---------------------------------------------------------------------------
// Commands & properties — callable from any thread (mpv is thread-safe here)
// ---------------------------------------------------------------------------

void MpvClient::commandAsync(const std::vector<std::string>& args, std::uint64_t replyId) {
  _state.requireInitialized("command");
  std::shared_lock<std::shared_mutex> lock(_handleMutex);
  if (_handle == nullptr) {
    throw DisposedError("command");
  }

  std::vector<const char*> argv;
  argv.reserve(args.size() + 1);
  for (const auto& arg : args) {
    argv.push_back(arg.c_str());
  }
  argv.push_back(nullptr); // mpv_command_async wants a NULL-terminated array

  const int status = mpv_command_async(_handle, replyId, argv.data());
  if (status < 0) {
    throw MpvError(status, "mpv_command_async()");
  }
}

std::optional<std::string> MpvClient::getPropertyString(const std::string& name) {
  _state.requireInitialized("getPropertyString");
  std::shared_lock<std::shared_mutex> lock(_handleMutex);
  if (_handle == nullptr) {
    throw DisposedError("getPropertyString");
  }

  char* raw = nullptr;
  const int status = mpv_get_property(_handle, name.c_str(), MPV_FORMAT_STRING, &raw);
  if (status == MPV_ERROR_PROPERTY_UNAVAILABLE) {
    return std::nullopt;
  }
  if (status < 0) {
    throw MpvError(status, "mpv_get_property(\"" + name + "\", STRING)");
  }
  if (raw == nullptr) {
    return std::nullopt;
  }
  std::string value(raw);
  mpv_free(raw);
  return value;
}

std::optional<double> MpvClient::getPropertyNumber(const std::string& name) {
  _state.requireInitialized("getPropertyNumber");
  std::shared_lock<std::shared_mutex> lock(_handleMutex);
  if (_handle == nullptr) {
    throw DisposedError("getPropertyNumber");
  }

  double value = 0.0;
  const int status = mpv_get_property(_handle, name.c_str(), MPV_FORMAT_DOUBLE, &value);
  if (status == MPV_ERROR_PROPERTY_UNAVAILABLE) {
    return std::nullopt;
  }
  if (status < 0) {
    throw MpvError(status, "mpv_get_property(\"" + name + "\", DOUBLE)");
  }
  return value;
}

std::optional<bool> MpvClient::getPropertyBool(const std::string& name) {
  _state.requireInitialized("getPropertyBool");
  std::shared_lock<std::shared_mutex> lock(_handleMutex);
  if (_handle == nullptr) {
    throw DisposedError("getPropertyBool");
  }

  int value = 0;
  const int status = mpv_get_property(_handle, name.c_str(), MPV_FORMAT_FLAG, &value);
  if (status == MPV_ERROR_PROPERTY_UNAVAILABLE) {
    return std::nullopt;
  }
  if (status < 0) {
    throw MpvError(status, "mpv_get_property(\"" + name + "\", FLAG)");
  }
  return value != 0;
}

void MpvClient::setPropertyString(const std::string& name, const std::string& value) {
  _state.requireInitialized("setPropertyString");
  std::shared_lock<std::shared_mutex> lock(_handleMutex);
  if (_handle == nullptr) {
    throw DisposedError("setPropertyString");
  }
  const int status = mpv_set_property_string(_handle, name.c_str(), value.c_str());
  if (status < 0) {
    throw MpvError(status, "mpv_set_property_string(\"" + name + "\")");
  }
}

void MpvClient::setPropertyNumber(const std::string& name, double value) {
  _state.requireInitialized("setPropertyNumber");
  std::shared_lock<std::shared_mutex> lock(_handleMutex);
  if (_handle == nullptr) {
    throw DisposedError("setPropertyNumber");
  }
  const int status = mpv_set_property(_handle, name.c_str(), MPV_FORMAT_DOUBLE, &value);
  if (status < 0) {
    throw MpvError(status, "mpv_set_property(\"" + name + "\", DOUBLE)");
  }
}

void MpvClient::setPropertyBool(const std::string& name, bool value) {
  _state.requireInitialized("setPropertyBool");
  std::shared_lock<std::shared_mutex> lock(_handleMutex);
  if (_handle == nullptr) {
    throw DisposedError("setPropertyBool");
  }
  int flag = value ? 1 : 0;
  const int status = mpv_set_property(_handle, name.c_str(), MPV_FORMAT_FLAG, &flag);
  if (status < 0) {
    throw MpvError(status, "mpv_set_property(\"" + name + "\", FLAG)");
  }
}

namespace {

/// mpv owns a node handed out by `mpv_get_property(MPV_FORMAT_NODE)`; this frees
/// it on every path out of the read, including a throwing visitor.
struct NodeGuard {
  mpv_node* node;
  ~NodeGuard() {
    mpv_free_node_contents(node);
  }
};

} // namespace

bool MpvClient::getPropertyNodeMapArray(
    const std::string& name, const std::function<void(std::size_t, const NodeMember&)>& visit) {
  _state.requireInitialized("getPropertyNodeMapArray");
  std::shared_lock<std::shared_mutex> lock(_handleMutex);
  if (_handle == nullptr) {
    throw DisposedError("getPropertyNodeMapArray");
  }

  mpv_node node{};
  const int status = mpv_get_property(_handle, name.c_str(), MPV_FORMAT_NODE, &node);
  if (status == MPV_ERROR_PROPERTY_UNAVAILABLE) {
    return false;
  }
  if (status < 0) {
    throw MpvError(status, "mpv_get_property(\"" + name + "\", NODE)");
  }
  NodeGuard guard{&node};

  // The walk itself is `NodeReader.hpp` — no handle, no libmpv, unit-tested
  // against hand-built node trees.
  return visitNodeMapArray(node, visit);
}

bool MpvClient::getPropertyNodeMap(const std::string& name,
                                   const std::function<void(const NodeMember&)>& visit) {
  _state.requireInitialized("getPropertyNodeMap");
  std::shared_lock<std::shared_mutex> lock(_handleMutex);
  if (_handle == nullptr) {
    throw DisposedError("getPropertyNodeMap");
  }

  mpv_node node{};
  const int status = mpv_get_property(_handle, name.c_str(), MPV_FORMAT_NODE, &node);
  if (status == MPV_ERROR_PROPERTY_UNAVAILABLE) {
    return false;
  }
  if (status < 0) {
    throw MpvError(status, "mpv_get_property(\"" + name + "\", NODE)");
  }
  NodeGuard guard{&node};

  return visitNodeMap(node, visit);
}

bool MpvClient::configurePcmTap(int frames) {
  _state.requireInitialized("configurePcmTap");
  std::shared_lock<std::shared_mutex> lock(_handleMutex);
  if (_handle == nullptr) {
    throw DisposedError("configurePcmTap");
  }

  std::int64_t value = frames;
  const int status = mpv_set_property(_handle, "pcm-tap", MPV_FORMAT_INT64, &value);
  if (status == MPV_ERROR_PROPERTY_NOT_FOUND || status == MPV_ERROR_OPTION_NOT_FOUND) {
    // Not an error: this libmpv predates the rn-media PCM tap patch. The caller
    // turns it into a typed `unsupported`, identically on both platforms.
    return false;
  }
  if (status < 0) {
    throw MpvError(status, "mpv_set_property(\"pcm-tap\", INT64)");
  }
  return true;
}

bool MpvClient::readPcmTapWindow(std::vector<float>& out, int& channels, int& rate, std::int64_t& seq) {
  bool haveSamples = false;
  const bool present = getPropertyNodeMap("pcm-tap-frame", [&](const NodeMember& member) {
    if (member.key == "channels") {
      channels = static_cast<int>(member.integer.value_or(0));
    } else if (member.key == "sample_rate") {
      rate = static_cast<int>(member.integer.value_or(0));
    } else if (member.key == "seq") {
      seq = member.integer.value_or(0);
    } else if (member.key == "samples" && member.bytes != nullptr) {
      const std::size_t count = member.byteCount / sizeof(float);
      // `resize` keeps the capacity across frames, so the steady state is a
      // memcpy and nothing else — this runs up to 60 times a second.
      out.resize(count);
      if (count > 0) {
        std::memcpy(out.data(), member.bytes, count * sizeof(float));
      }
      haveSamples = true;
    }
  });
  return present && haveSamples;
}

// ---------------------------------------------------------------------------
// Dynamic source resolution — JS thread
// ---------------------------------------------------------------------------

void MpvClient::installSourceResolver(std::int64_t timeoutMs) {
  _state.requireInitialized("installSourceResolver");
  std::shared_lock<std::shared_mutex> lock(_handleMutex);
  if (_handle == nullptr) {
    throw DisposedError("installSourceResolver");
  }

  // Two flag writes over a handler mpv already calls: `initialize()` registered
  // both hooks (see `registerLoadHooks`). Nothing here can fail on mpv's side,
  // which is also why re-installing is free.
  _resolverTimeoutMs.store(timeoutMs > 0 ? timeoutMs : 0, std::memory_order_release);
  _resolverActive.store(true, std::memory_order_release);
}

void MpvClient::uninstallSourceResolver() noexcept {
  _resolverActive.store(false, std::memory_order_release);
  _resolutionCache.clear();
  // A hook may be parked on the gate right now with nobody left to answer it.
  // `cancel()` (not `abort()`) releases it and leaves the gate usable, because
  // a resolver can be installed again later.
  _resolutionGate.cancel();
}

void MpvClient::setResolvedSource(const std::string& logical, const std::string& resolved, std::int64_t ttlMs) {
  _resolutionCache.put(logical, resolved, ttlMs);
}

void MpvClient::clearResolvedSources() {
  _resolutionCache.clear();
}

void MpvClient::completeResolution(const std::string& logical, const std::optional<std::string>& resolved,
                                   std::int64_t ttlMs) {
  // Cache first, settle second. The order matters for the prefetch path, which
  // has no hold to settle: by the time this returns, a `on_load` arriving for
  // the same entry finds the answer already in the cache and never asks again.
  if (resolved.has_value()) {
    _resolutionCache.put(logical, *resolved, ttlMs);
  }
  _resolutionGate.complete(logical, resolved);
}

void MpvClient::observeProperty(const std::string& name, PropertyFormat format) {
  _state.requireInitialized("observeProperty");
  std::shared_lock<std::shared_mutex> lock(_handleMutex);
  if (_handle == nullptr) {
    throw DisposedError("observeProperty");
  }

  std::lock_guard<std::mutex> observedLock(_observedMutex);
  if (auto existing = _observed.find(name); existing != _observed.end()) {
    // Re-observing replaces: drop the old registration first, otherwise mpv
    // would deliver two change events per update.
    mpv_unobserve_property(_handle, existing->second);
    _observed.erase(existing);
  }

  const std::uint64_t id = nextReplyId();
  const int status = mpv_observe_property(_handle, id, name.c_str(), toMpvFormat(format));
  if (status < 0) {
    throw MpvError(status, "mpv_observe_property(\"" + name + "\")");
  }
  _observed.emplace(name, id);
}

void MpvClient::unobserveProperty(const std::string& name) {
  _state.requireInitialized("unobserveProperty");
  std::shared_lock<std::shared_mutex> lock(_handleMutex);
  if (_handle == nullptr) {
    throw DisposedError("unobserveProperty");
  }

  std::lock_guard<std::mutex> observedLock(_observedMutex);
  auto existing = _observed.find(name);
  if (existing == _observed.end()) {
    return; // not observed — idempotent by contract
  }
  const int status = mpv_unobserve_property(_handle, existing->second);
  _observed.erase(existing);
  if (status < 0) {
    throw MpvError(status, "mpv_unobserve_property(\"" + name + "\")");
  }
}

std::uint64_t MpvClient::rawHandle() {
  _state.requireInitialized("getRawHandle");
  std::shared_lock<std::shared_mutex> lock(_handleMutex);
  if (_handle == nullptr) {
    throw DisposedError("getRawHandle");
  }
  return static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(_handle));
}

// ---------------------------------------------------------------------------
// Event thread
// ---------------------------------------------------------------------------

void MpvClient::notifyPrefetchStarted(const std::string& logical, std::optional<std::int64_t> entryId) noexcept {
  if (!_onPrefetchStarted) {
    return;
  }
  try {
    _onPrefetchStarted(logical, entryId);
  } catch (...) {
    // The JS runtime (or its Dispatcher) is gone. This is a notification with
    // nothing waiting on it, so there is nothing to fall back to and nothing
    // to report — the hook was continued before we got here.
  }
}

void MpvClient::handleHook(mpv_handle* handle, const std::string& name, std::uint64_t id) noexcept {
  const bool prefetch = name == kPrefetchLoadHook;
  const bool active = _resolverActive.load(std::memory_order_acquire);

  if (!active && !prefetch) {
    // Registered but disarmed, and this is the play-time hook — nobody is
    // waiting to hear about it. Continue at once: a pass-through must be
    // indistinguishable from stock mpv, which is exactly what an unrewritten
    // continue is, and reading a property nobody asked for would not be.
    mpv_hook_continue(handle, id);
    return;
  }

  char* raw = nullptr;
  if (mpv_get_property(handle, kStreamOpenFilename, MPV_FORMAT_STRING, &raw) < 0 || raw == nullptr) {
    mpv_hook_continue(handle, id);
    return;
  }
  std::string logical(raw);
  mpv_free(raw);

  // BEFORE the continue below, never after: the property exists only while this
  // hook is open (see `kPrefetchEntryId`). A libmpv without the fork patch
  // answers "no such property", which is a missing id, not an error.
  std::optional<std::int64_t> entryId;
  if (prefetch) {
    std::int64_t value = 0;
    if (mpv_get_property(handle, kPrefetchEntryId, MPV_FORMAT_INT64, &value) >= 0) {
      entryId = value;
    }
  }

  if (!active) {
    // Prefetch, with no resolver. The hook exists purely as an observation
    // point now, so continue unrewritten and report the boundary.
    mpv_hook_continue(handle, id);
    notifyPrefetchStarted(logical, entryId);
    return;
  }

  if (std::optional<std::string> hit = _resolutionCache.lookup(logical); hit.has_value()) {
    // The whole design in three lines: a cache hit is a synchronous map lookup
    // plus one property write, with no JavaScript anywhere near mpv's core.
    if (*hit != logical) {
      mpv_set_property_string(handle, kStreamOpenFilename, hit->c_str());
    }
    mpv_hook_continue(handle, id);
    if (prefetch) {
      notifyPrefetchStarted(logical, entryId);
    }
    return;
  }

  if (prefetch) {
    // NEVER wait here. This hook fires mid-track, over live audio, backed only
    // by what the AO already has queued (0.2 s by default; 816/826 ms measured
    // on our device, ARCHITECTURE §12). Continue unrewritten — the prefetch
    // open then succeeds (a URL that needed no resolving) or fails exactly as
    // stock mpv's would, and either way the entry is opened for real later —
    // then ask JavaScript, so the answer is in the cache long before the
    // boundary. mpv arms this hook seconds into the current track, not near its
    // end, so "long before" is usually a whole track's worth of wall time.
    mpv_hook_continue(handle, id);
    // Before the resolution request, because it is the earlier fact and both
    // are scheduled onto the same JS thread in call order: a listener sees "a
    // prefetch of X started" and only then "…and X needs resolving".
    notifyPrefetchStarted(logical, entryId);
    if (_onResolutionRequest) {
      try {
        _onResolutionRequest(logical, entryId);
      } catch (...) {
        // The JS runtime (or its Dispatcher) is gone. Nothing to do: the hook
        // is already continued and the next load will simply ask again.
      }
    }
    return;
  }

  // Play time. Holding is safe here in a way it is not on the prefetch path:
  // this entry has not opened yet, so there is no audio of its own to starve,
  // and the previous entry has already ended.
  _resolutionGate.begin(logical);
  bool asked = false;
  if (_onResolutionRequest) {
    try {
      _onResolutionRequest(logical, std::nullopt);
      asked = true;
    } catch (...) {
      // The JS runtime is gone. Do not hold mpv open waiting for it.
    }
  }
  if (!asked) {
    _resolutionGate.cancel();
  }
  const std::optional<std::string> resolved =
      _resolutionGate.await(asked ? _resolverTimeoutMs.load(std::memory_order_acquire) : 0);

  if (resolved.has_value() && *resolved != logical) {
    mpv_set_property_string(handle, kStreamOpenFilename, resolved->c_str());
  }
  // On a timeout, a null answer, or no listener at all the URL is left exactly
  // as mpv wrote it. mpv then opens the logical URL and fails on its own terms,
  // which arrives as an ordinary `end-file` error and lands in the existing
  // typed taxonomy. There is deliberately no second error channel for this.
  mpv_hook_continue(handle, id);
}

bool MpvClient::handleEvent(mpv_handle* handle, void* rawEvent) {
  auto* event = static_cast<mpv_event*>(rawEvent);

  switch (event->event_id) {
    case MPV_EVENT_HOOK: {
      auto* hook = static_cast<mpv_event_hook*>(event->data);
      if (hook == nullptr) {
        return false;
      }
      // Copy both fields out before doing anything: `mpv_event` and everything
      // it points at are invalidated by the next `mpv_wait_event()`, and this
      // handler can park for seconds.
      //
      // Hooks never enter the batch. Two reasons, both load-bearing: a batch is
      // delivered one at a time behind a JS completion promise, so a hook event
      // riding in one would add the whole batch's JS time to a stall that is
      // holding mpv's core; and mpv defers a hook event behind all pending
      // property changes anyway (`player/client.c`, `hook_pending`), so the
      // ordering the batch preserves has already been established upstream.
      const std::string name = hook->name != nullptr ? hook->name : "";
      const std::uint64_t id = hook->id;
      handleHook(handle, name, id);
      return false;
    }

    case MPV_EVENT_COMMAND_REPLY: {
      // Replies never enter the batch: they resolve a specific Promise and
      // must not be coalesced with, or delayed behind, the event stream.
      _onCommandReply(event->reply_userdata, event->error);
      return false;
    }

    case MPV_EVENT_PROPERTY_CHANGE: {
      auto* property = static_cast<mpv_event_property*>(event->data);
      if (property == nullptr || property->name == nullptr) {
        return false;
      }
      PropertyValue value{};
      switch (property->format) {
        case MPV_FORMAT_NONE:
          // Property currently unavailable — a real state transition, so it is
          // forwarded as a value-less property event, not dropped.
          break;
        case MPV_FORMAT_STRING: {
          auto* text = *static_cast<char**>(property->data);
          value = text != nullptr ? std::string(text) : std::string();
          break;
        }
        case MPV_FORMAT_DOUBLE:
          value = *static_cast<double*>(property->data);
          break;
        case MPV_FORMAT_FLAG:
          value = *static_cast<int*>(property->data) != 0;
          break;
        default:
          return false; // a format we never asked for
      }
      return _batch.push(Event::property(property->name, std::move(value)));
    }

    case MPV_EVENT_START_FILE:
      return _batch.push(Event::discrete(EventKind::StartFile));

    case MPV_EVENT_END_FILE: {
      auto* endFile = static_cast<mpv_event_end_file*>(event->data);
      if (endFile == nullptr) {
        return _batch.push(Event::endFile(EndFileReason::Unknown));
      }
      std::string errorText;
      if (endFile->reason == MPV_END_FILE_REASON_ERROR && endFile->error < 0) {
        errorText = mpv_error_string(endFile->error);
      }
      return _batch.push(Event::endFile(toEndFileReason(endFile->reason), std::move(errorText)));
    }

    case MPV_EVENT_SEEK:
      return _batch.push(Event::discrete(EventKind::Seek));

    case MPV_EVENT_PLAYBACK_RESTART:
      return _batch.push(Event::discrete(EventKind::PlaybackRestart));

    case MPV_EVENT_LOG_MESSAGE: {
      auto* message = static_cast<mpv_event_log_message*>(event->data);
      if (message == nullptr) {
        return false;
      }
      return _batch.push(Event::log(toLogLevel(message->log_level), message->prefix != nullptr ? message->prefix : "",
                                    message->text != nullptr ? message->text : ""));
    }

    case MPV_EVENT_QUEUE_OVERFLOW:
      // We fell behind and mpv dropped events. Surfacing this as a warning is
      // the only honest option: state derived from the stream may now be stale.
      return _batch.push(Event::log(LogLevel::Warn, "mpv", "event queue overflow — events were dropped\n"));

    case MPV_EVENT_SHUTDOWN:
      // The core is going away (e.g. the `quit` command). Stop reading; the
      // handle stays valid until `destroy()` terminates it.
      _stopRequested.store(true, std::memory_order_release);
      return _batch.push(Event::discrete(EventKind::Shutdown));

    default:
      // Deprecated (`MPV_EVENT_IDLE`, `MPV_EVENT_TICK`), video-only
      // (`VIDEO_RECONFIG`) or unused-by-us events. Ignored on purpose; the
      // equivalent state is observed via properties.
      return false;
  }
}

void MpvClient::eventLoop(mpv_handle* handle) noexcept {
  while (!_stopRequested.load(std::memory_order_acquire)) {
    // The only blocking call in this class, and the only `mpv_wait_event` in
    // the whole library. Woken by mpv events or by `mpv_wakeup()` in destroy().
    mpv_event* event = mpv_wait_event(handle, -1.0);
    if (_stopRequested.load(std::memory_order_acquire)) {
      break;
    }

    bool scheduleFlush = false;
    // Drain mpv's queue completely before flushing: client.h prescribes this
    // loop shape, and mpv emits property changes once the queue empties, so
    // one wake-up carries one coherent set of updates.
    while (event->event_id != MPV_EVENT_NONE) {
      try {
        scheduleFlush |= handleEvent(handle, event);
      } catch (...) {
        // A translation/callback failure must never take down the event
        // thread — that would silently freeze the player forever.
      }
      if (_stopRequested.load(std::memory_order_acquire)) {
        break;
      }
      event = mpv_wait_event(handle, 0.0);
    }

    if (scheduleFlush) {
      try {
        _onBatchReady();
      } catch (...) {
        // Same reasoning: the JS side going away must not kill this thread.
      }
    }
  }
}

} // namespace rnmedia
