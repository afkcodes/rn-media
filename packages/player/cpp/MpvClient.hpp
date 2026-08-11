#pragma once

///
/// MpvClient.hpp — RAII owner of one `mpv_handle`, its event thread, and its
/// event batch. Pure mpv + std: this file and its .cpp include no Nitro, no
/// JSI, no platform headers. The Nitro glue lives in `HybridMpvClient.*`.
///
/// ============================ THREADING CONTRACT ==========================
///
/// Three threads touch an `MpvClient`, and the split is not negotiable:
///
/// 1. The **JS thread** (or whichever thread calls into the HybridObject).
///    Owns construction, `initialize()`, `destroy()`, and every command /
///    property / observe call. All of those are `mpv_*` functions that mpv
///    documents as callable from any thread (client.h §"Threading"), so they
///    run inline — no hop, no blocking, which is what keeps the JS thread free.
///
/// 2. The **event thread**, one per instance, started by `initialize()`.
///    It is the *only* thread that ever calls `mpv_wait_event()`. mpv permits
///    exactly one concurrent `mpv_wait_event()` per handle (client.h: "no
///    other thread is allowed to call this ... concurrent calls to this
///    function are not allowed"), and the `mpv_event*` it returns is owned by
///    the handle and invalidated by the next `mpv_wait_event()` call — so this
///    thread copies everything it needs out of the event before looping.
///    It never calls back into mpv except `mpv_wait_event`.
///
///    Per wake-up it drains mpv's whole queue (`mpv_wait_event(handle, 0)`
///    until `MPV_EVENT_NONE`, the loop shape client.h itself prescribes) and
///    only then asks for at most one flush. mpv already emits property changes
///    "when the event queue becomes empty", so one wake-up ≈ one logical
///    update; batching at that boundary is free.
///
/// 3. A **detached teardown thread**, spawned once by `destroy()`, whose only
///    job is `mpv_terminate_destroy()`. That call blocks (it waits for the
///    core to shut down and may join mpv's internal threads), so it must never
///    run on the JS thread. By the time it runs, the handle is unreachable
///    from everywhere else: `destroy()` has already nulled `_handle` under the
///    handle lock and joined the event thread.
///
/// ------------------------------ FLUSH DESIGN ------------------------------
///
/// The event thread never calls JS. It pushes into `EventBatch`, and `push()`
/// tells it whether it is the one that must schedule a flush (see
/// EventBatch.hpp for the exact contract). The scheduling itself is a
/// `std::function<void()>` supplied by the Nitro glue — `MpvClient` has no
/// idea what a JS thread is. That callback is set once at construction and
/// never mutated, so the event thread can call it without a lock.
///
/// --------------------------- DESTROY ORDERING -----------------------------
///
/// `destroy()`:
///   1. CAS the lifecycle to Destroyed (idempotent; loser returns immediately).
///   2. Take `_handleMutex` exclusively and steal `_handle`. The exclusive
///      lock is what makes this safe against an in-flight `getProperty` on
///      another thread: every mpv call holds the lock shared, so after step 2
///      no thread is inside an `mpv_*` call with this handle.
///   3. Set `_stopRequested`, `mpv_wakeup()` (client.h: interrupts the current
///      `mpv_wait_event()`; if none is running the *next* one returns
///      immediately, so the wakeup can never be lost), join the event thread.
///   4. Hand the handle to a detached thread for `mpv_terminate_destroy()`.
///
/// Steps 2–3 are bounded and short; the JS thread is not blocked on mpv
/// teardown, only on the event thread noticing the wakeup.
///
/// --------------------------- SOURCE RESOLUTION ----------------------------
///
/// One more thing happens on the event thread, and it is the only place in this
/// class that ever *waits*: `MPV_EVENT_HOOK`. See `handleHook()` in the .cpp and
/// `SourceResolution.hpp` for the full reasoning. In one paragraph:
/// `on_prefetch_load` (our fork) fires mid-track over live audio, so a miss is
/// continued immediately and JavaScript is asked afterwards; stock `on_load`
/// fires between entries with nothing playing, so a miss holds the hook for at
/// most `resolverTimeoutMs` while JavaScript answers. The wait lives on the
/// event thread because a hook already blocks mpv's core by construction —
/// nothing else can proceed for this core while it is open, so moving the wait
/// to another thread would buy nothing and cost a hop. `destroy()` calls
/// `ResolutionGate::abort()` *before* joining, so teardown never waits out a
/// resolver timeout.
///
/// ==========================================================================
///

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <vector>

#include "ClientState.hpp"
#include "EventBatch.hpp"
#include "SourceResolution.hpp"

struct mpv_handle;

namespace rnmedia {

/// An error reported by libmpv. `code` is the raw `mpv_error` value; the
/// message is tagged (see `kErrorTagPrefix`) so the TS layer can classify it.
class MpvError final : public std::runtime_error {
public:
  MpvError(int code, const std::string& message);

  int code() const noexcept {
    return _code;
  }

private:
  int _code;
};

/// The formats a property can be observed/read in. 1:1 with `mpv_format`.
enum class PropertyFormat : std::uint8_t {
  String,
  Number,
  Bool,
};

/// One member of an `MPV_FORMAT_NODE_MAP` property, as handed to the visitor of
/// `MpvClient::getPropertyNodeMap`.
///
/// Everything here points into mpv's own node, which is freed the moment the
/// visit returns — a visitor that wants to keep a value must copy it. That is
/// the whole reason this is a visitor rather than a returned struct: the
/// visualizer reads a multi-kilobyte byte array up to 60 times a second, and a
/// value-returning API would allocate and copy it twice per frame.
struct NodeMember {
  std::string_view key;
  /// Set for `INT64`, `DOUBLE` and `FLAG` members (flags arrive as 0 / 1).
  std::optional<double> number;
  /// Set for `INT64` and `FLAG` members, without the double round-trip.
  std::optional<std::int64_t> integer;
  /// Set for `STRING` members.
  std::optional<std::string_view> text;
  /// Set for `BYTE_ARRAY` members; `nullptr` otherwise.
  const std::uint8_t* bytes = nullptr;
  std::size_t byteCount = 0;
};

class MpvClient final {
public:
  /// Invoked on the **event thread** when a batch went from "no flush
  /// scheduled" to "flush scheduled". Must be cheap and must not block.
  using BatchReadyFn = std::function<void()>;
  /// Invoked on the **event thread** for every `MPV_EVENT_COMMAND_REPLY`.
  /// `error` is 0 on success or a negative `mpv_error`.
  using CommandReplyFn = std::function<void(std::uint64_t replyId, int error)>;
  /// Invoked on the **event thread** when a load hook asked for a URL the cache
  /// could not answer. `entryId` is mpv's playlist entry id, available *only*
  /// on the prefetch path (see `installSourceResolver`).
  ///
  /// Must be cheap and must not block: on the prefetch path the hook has
  /// already been continued and the core is running live audio; on the play
  /// path this thread is holding mpv's core open.
  using ResolutionRequestFn = std::function<void(const std::string& url, std::optional<std::int64_t> entryId)>;

  /// Calls `mpv_create()`. Throws `MpvError` if mpv could not allocate a core.
  /// All three callbacks are captured once and never replaced, which is what
  /// lets the event thread invoke them without synchronisation.
  MpvClient(BatchReadyFn onBatchReady, CommandReplyFn onCommandReply, ResolutionRequestFn onResolutionRequest);
  ~MpvClient();

  MpvClient(const MpvClient&) = delete;
  MpvClient& operator=(const MpvClient&) = delete;
  MpvClient(MpvClient&&) = delete;
  MpvClient& operator=(MpvClient&&) = delete;

  /// Applies the audio-only defaults, then `options`, then `mpv_initialize()`,
  /// then starts the event thread. See the Nitro spec for the reserved
  /// `log-level` key.
  void initialize(const std::unordered_map<std::string, std::string>& options);

  /// Idempotent; see DESTROY ORDERING above. Never throws.
  void destroy() noexcept;

  bool isDestroyed() const noexcept {
    return _state.isDestroyed();
  }

  /// `mpv_command_async`. The reply arrives on the event thread as
  /// `CommandReplyFn(replyId, error)`. Throws if mpv rejected the call
  /// outright (in which case no reply will ever arrive).
  void commandAsync(const std::vector<std::string>& args, std::uint64_t replyId);

  /// `std::nullopt` == `MPV_ERROR_PROPERTY_UNAVAILABLE`. Any other mpv error
  /// throws `MpvError`.
  std::optional<std::string> getPropertyString(const std::string& name);
  std::optional<double> getPropertyNumber(const std::string& name);
  std::optional<bool> getPropertyBool(const std::string& name);

  void setPropertyString(const std::string& name, const std::string& value);
  void setPropertyNumber(const std::string& name, double value);
  void setPropertyBool(const std::string& name, bool value);

  /// Read `name` as `MPV_FORMAT_NODE` and visit each member of the resulting
  /// map exactly once, in mpv's order. Returns false when the property is
  /// unavailable or is not a map; throws `MpvError` on any other mpv error.
  ///
  /// The node is freed before this returns, including when `visit` throws.
  bool getPropertyNodeMap(const std::string& name, const std::function<void(const NodeMember&)>& visit);

  /// Arm mpv's PCM tap for `frames` samples per channel, or disarm it with 0.
  ///
  /// Returns **false** when this libmpv has no `pcm-tap` property, i.e. it was
  /// not built from the rn-media forks. That is a capability answer, not an
  /// error, and it is the same answer on both platforms.
  bool configurePcmTap(int frames);

  /// Read the newest tapped window into `out` as interleaved float32.
  /// `out` is resized and overwritten, reusing its capacity. Returns false when
  /// the tap is disarmed or no audio has reached the device yet.
  bool readPcmTapWindow(std::vector<float>& out, int& channels, int& rate, std::int64_t& seq);

  // ------------------------- Dynamic source resolution ---------------------

  /// Arm the load hooks, registering them with mpv on the first call.
  ///
  /// Registration is lazy and permanent, and both halves of that matter:
  ///
  ///  - **Lazy**, because a core that never installs a resolver must be
  ///    byte-for-byte stock. Our fork's `on_prefetch_load` costs nothing when
  ///    no client has registered for that name, and stock `on_load` costs
  ///    nothing either — but only while we stay out of them.
  ///  - **Permanent**, because mpv has no unregister call (`client.h`:
  ///    "Currently, hooks can't be removed explicitly. But they will be
  ///    implicitly removed if the mpv_handle it was registered with is
  ///    destroyed"). So `uninstallSourceResolver()` can only *disarm* the
  ///    handler, which then continues every hook immediately — an unrewritten
  ///    pass-through, which is what stock mpv does anyway.
  ///
  /// `mpv_hook_add` takes the core lock (`player/client.c`, `lock_core`), so it
  /// waits for the core to reach a dispatch point. Call it at setup time, never
  /// from a latency-sensitive path.
  ///
  /// @param timeoutMs How long a play-time `on_load` miss may hold mpv's core
  /// while JavaScript resolves. `0` disables holding entirely.
  void installSourceResolver(std::int64_t timeoutMs);

  /// Disarm the handler and drop every cached resolution. Idempotent, and safe
  /// while a hook is parked: an open hold is released at once.
  void uninstallSourceResolver() noexcept;

  /// Pre-seed the cache, so the hook never has to ask. This is the whole point
  /// of the design — see `SourceResolution.hpp`.
  void setResolvedSource(const std::string& logical, const std::string& resolved, std::int64_t ttlMs);

  /// Forget every resolution. The next hook for any URL asks JavaScript again.
  void clearResolvedSources();

  /// Answer a `ResolutionRequestFn`. Caches a successful answer (so the second,
  /// play-time `on_load` pass for the same entry replays it verbatim) and
  /// releases a matching play-time hold. An answer without a value means "could
  /// not resolve": nothing is cached and the hook continues unrewritten.
  void completeResolution(const std::string& logical, const std::optional<std::string>& resolved,
                          std::int64_t ttlMs);

  /// Re-observing a name replaces the previous observation.
  void observeProperty(const std::string& name, PropertyFormat format);
  /// No-op if `name` was not observed.
  void unobserveProperty(const std::string& name);

  /// The `mpv_handle*` as a `uintptr_t`, for the future video plugin.
  std::uint64_t rawHandle();

  /// Monotonic ids for `commandAsync` / property observation.
  std::uint64_t nextReplyId() noexcept {
    return _nextReplyId.fetch_add(1, std::memory_order_relaxed);
  }

  /// Batch access for the flush coordinator. See EventBatch.hpp for the
  /// drain/endFlush contract. Safe after `destroy()` (the batch is emptied).
  void drainEvents(std::vector<Event>& out) {
    _batch.drain(out);
  }
  bool endFlush() {
    return _batch.endFlush();
  }

private:
  void eventLoop(mpv_handle* handle) noexcept;
  /// Translates one mpv event and pushes it. Returns true if a flush must be
  /// scheduled. Command replies and hooks are dispatched here and never enter
  /// the batch — a hook must not wait behind unrelated JS work, and a reply
  /// resolves one specific Promise.
  bool handleEvent(mpv_handle* handle, void* event);
  /// Event thread. Resolves (or declines to resolve) one load hook and always
  /// continues it. `handle` is the event thread's own copy: `destroy()` joins
  /// this thread before `mpv_terminate_destroy()` can run, so the pointer stays
  /// valid here without `_handleMutex` — which must NOT be held across the
  /// bounded wait, or teardown would block on it.
  void handleHook(mpv_handle* handle, const std::string& name, std::uint64_t id) noexcept;
  void setOptionOrThrow(mpv_handle* handle, const std::string& name, const std::string& value);

  ClientState _state;

  /// Guards `_handle` against teardown while another thread is inside an
  /// `mpv_*` call. Shared = "I am using the handle", exclusive = "I am taking
  /// it away". The event thread does not participate; it holds its own copy of
  /// the pointer and is joined before the handle is released.
  mutable std::shared_mutex _handleMutex;
  mpv_handle* _handle = nullptr;

  std::thread _eventThread;
  std::atomic<bool> _stopRequested{false};

  EventBatch _batch;
  const BatchReadyFn _onBatchReady;
  const CommandReplyFn _onCommandReply;
  const ResolutionRequestFn _onResolutionRequest;

  /// Resolved URLs, and the single play-time hold. Both are pure logic and both
  /// are unit-tested on the host; see `SourceResolution.hpp`.
  ResolvedSourceCache _resolutionCache;
  ResolutionGate _resolutionGate;
  /// Read on the event thread inside a hook, written from the JS thread by
  /// install/uninstall. Atomic rather than mutexed because the hook path must
  /// not contend with anything.
  std::atomic<bool> _resolverActive{false};
  std::atomic<std::int64_t> _resolverTimeoutMs{0};
  /// Guards the two registration flags. JS-thread only in practice, but
  /// `installSourceResolver` is a public method and "JS thread" is not a
  /// guarantee we can enforce.
  std::mutex _hookMutex;
  bool _prefetchHookRegistered = false;
  bool _loadHookRegistered = false;

  std::atomic<std::uint64_t> _nextReplyId{1};

  /// name -> `reply_userdata` handed to `mpv_observe_property`, needed because
  /// `mpv_unobserve_property` unregisters by id, not by name. JS-thread only,
  /// but mutexed because "JS thread" is not a guarantee we can enforce.
  std::mutex _observedMutex;
  std::unordered_map<std::string, std::uint64_t> _observed;
};

} // namespace rnmedia
