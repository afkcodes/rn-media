#include "HybridMpvClient.hpp"

#include <stdexcept>
#include <utility>
#include <variant>

namespace margelo::nitro::rnmediaplayer {

namespace {

/// mpv's playlist property. Named here rather than inline because it is the one
/// property this layer reads on its own initiative (everything else is a name
/// the TypeScript side passed down).
constexpr const char* kPlaylistProperty = "playlist";

MpvEventKind toNitroKind(rnmedia::EventKind kind) {
  switch (kind) {
    case rnmedia::EventKind::Property:
      return MpvEventKind::PROPERTY;
    case rnmedia::EventKind::StartFile:
      return MpvEventKind::STARTFILE;
    case rnmedia::EventKind::EndFile:
      return MpvEventKind::ENDFILE;
    case rnmedia::EventKind::Seek:
      return MpvEventKind::SEEK;
    case rnmedia::EventKind::PlaybackRestart:
      return MpvEventKind::PLAYBACKRESTART;
    case rnmedia::EventKind::Log:
      return MpvEventKind::LOG;
    case rnmedia::EventKind::Shutdown:
    case rnmedia::EventKind::None:
      break;
  }
  return MpvEventKind::SHUTDOWN;
}

MpvEndFileReason toNitroEndFileReason(rnmedia::EndFileReason reason) {
  switch (reason) {
    case rnmedia::EndFileReason::EndOfFile:
      return MpvEndFileReason::ENDOFFILE;
    case rnmedia::EndFileReason::Stop:
      return MpvEndFileReason::STOP;
    case rnmedia::EndFileReason::Quit:
      return MpvEndFileReason::QUIT;
    case rnmedia::EndFileReason::Error:
      return MpvEndFileReason::ERROR;
    case rnmedia::EndFileReason::Redirect:
      return MpvEndFileReason::REDIRECT;
    case rnmedia::EndFileReason::Unknown:
      break;
  }
  return MpvEndFileReason::UNKNOWN;
}

MpvLogLevel toNitroLogLevel(rnmedia::LogLevel level) {
  switch (level) {
    case rnmedia::LogLevel::Fatal:
      return MpvLogLevel::FATAL;
    case rnmedia::LogLevel::Error:
      return MpvLogLevel::ERROR;
    case rnmedia::LogLevel::Warn:
      return MpvLogLevel::WARN;
    case rnmedia::LogLevel::Verbose:
      return MpvLogLevel::VERBOSE;
    case rnmedia::LogLevel::Debugging:
      return MpvLogLevel::DEBUGGING;
    case rnmedia::LogLevel::Trace:
      return MpvLogLevel::TRACE;
    case rnmedia::LogLevel::Info:
      break;
  }
  return MpvLogLevel::INFO;
}

rnmedia::PropertyFormat toNativeFormat(MpvFormat format) {
  switch (format) {
    case MpvFormat::STRING:
      return rnmedia::PropertyFormat::String;
    case MpvFormat::NUMBER:
      return rnmedia::PropertyFormat::Number;
    case MpvFormat::BOOL:
      break;
  }
  return rnmedia::PropertyFormat::Bool;
}

/// `std::monostate` (property unavailable) maps to an absent optional, which is
/// `undefined` in JS — distinct from `''`/`0`/`false`.
std::optional<std::variant<bool, std::string, double>> toNitroValue(rnmedia::PropertyValue&& value) {
  if (std::holds_alternative<bool>(value)) {
    return std::get<bool>(value);
  }
  if (std::holds_alternative<double>(value)) {
    return std::get<double>(value);
  }
  if (std::holds_alternative<std::string>(value)) {
    return std::move(std::get<std::string>(value));
  }
  return std::nullopt;
}

MpvEvent toNitroEvent(rnmedia::Event&& event) {
  MpvEvent out;
  out.kind = toNitroKind(event.kind);
  switch (event.kind) {
    case rnmedia::EventKind::Property:
      out.name = std::move(event.name);
      out.value = toNitroValue(std::move(event.value));
      break;
    case rnmedia::EventKind::EndFile:
      out.endFileReason = toNitroEndFileReason(event.endFileReason);
      if (!event.text.empty()) {
        out.error = std::move(event.text);
      }
      break;
    case rnmedia::EventKind::Log:
      out.logLevel = toNitroLogLevel(event.logLevel);
      out.name = std::move(event.name);
      out.text = std::move(event.text);
      break;
    case rnmedia::EventKind::StartFile:
    case rnmedia::EventKind::Seek:
    case rnmedia::EventKind::PlaybackRestart:
    case rnmedia::EventKind::Shutdown:
    case rnmedia::EventKind::None:
      break;
  }
  return out;
}

[[noreturn]] void throwUnsupported(const char* what) {
  throw std::runtime_error(std::string(rnmedia::kErrorTagPrefix) + "unsupported] `" + what +
                           "` is not implemented in the audio core. Install the video plugin, which attaches to the "
                           "handle returned by `getRawHandle()`.");
}

} // namespace

// ---------------------------------------------------------------------------
// PendingCommands
// ---------------------------------------------------------------------------

void PendingCommands::add(std::uint64_t replyId, const std::shared_ptr<Promise<void>>& promise) {
  std::lock_guard<std::mutex> lock(_mutex);
  _promises.emplace(replyId, promise);
}

std::shared_ptr<Promise<void>> PendingCommands::take(std::uint64_t replyId) {
  std::lock_guard<std::mutex> lock(_mutex);
  auto it = _promises.find(replyId);
  if (it == _promises.end()) {
    return nullptr;
  }
  auto promise = std::move(it->second);
  _promises.erase(it);
  return promise;
}

void PendingCommands::settle(std::uint64_t replyId, int error) {
  auto promise = take(replyId);
  if (promise == nullptr) {
    return; // reply for a command we already gave up on (e.g. after destroy)
  }
  if (error < 0) {
    promise->reject(std::make_exception_ptr(rnmedia::MpvError(error, "command failed")));
    return;
  }
  promise->resolve();
}

void PendingCommands::rejectAll(const std::exception_ptr& error) {
  std::unordered_map<std::uint64_t, std::shared_ptr<Promise<void>>> promises;
  {
    std::lock_guard<std::mutex> lock(_mutex);
    promises.swap(_promises);
  }
  for (auto& [id, promise] : promises) {
    (void)id;
    promise->reject(error);
  }
}

// ---------------------------------------------------------------------------
// MpvFlushCoordinator
// ---------------------------------------------------------------------------

void MpvFlushCoordinator::attach(rnmedia::MpvClient* client) {
  std::lock_guard<std::mutex> lock(_mutex);
  _client = client;
}

void MpvFlushCoordinator::detach() {
  std::lock_guard<std::mutex> lock(_mutex);
  _client = nullptr;
  _listener = nullptr;
  _deferred = false;
}

void MpvFlushCoordinator::setListener(const Listener& listener) {
  bool hadDeferredBatch = false;
  {
    std::lock_guard<std::mutex> lock(_mutex);
    _listener = listener;
    hadDeferredBatch = _deferred;
  }
  if (hadDeferredBatch) {
    // Events arrived before anyone was listening; the batch is still armed.
    flush();
  }
}

void MpvFlushCoordinator::clearListener() {
  std::lock_guard<std::mutex> lock(_mutex);
  _listener = nullptr;
}

void MpvFlushCoordinator::onBatchReady() {
  flush();
}

bool MpvFlushCoordinator::continueAfterFlush() {
  std::lock_guard<std::mutex> lock(_mutex);
  if (_client == nullptr) {
    return false;
  }
  return _client->endFlush();
}

void MpvFlushCoordinator::flush() {
  {
    std::lock_guard<std::mutex> lock(_mutex);
    if (_flushRunning) {
      // Re-entered (a listener Promise resolved synchronously). Let the
      // running loop pick it up instead of recursing.
      _flushAgain = true;
      return;
    }
    _flushRunning = true;
  }

  for (;;) {
    const bool again = runOneFlush();
    std::lock_guard<std::mutex> lock(_mutex);
    if (again || _flushAgain) {
      _flushAgain = false;
      continue;
    }
    _flushRunning = false;
    return;
  }
}

bool MpvFlushCoordinator::runOneFlush() {
  Listener listener;
  {
    std::lock_guard<std::mutex> lock(_mutex);
    if (_client == nullptr) {
      return false;
    }
    if (!_listener) {
      // Keep the EventBatch armed so nothing schedules a second flush, and
      // remember to deliver as soon as a listener shows up.
      _deferred = true;
      return false;
    }
    _deferred = false;
    listener = _listener;

    _native.clear();
    _client->drainEvents(_native);
    _js.clear();
    if (_js.capacity() < _native.size()) {
      _js.reserve(_native.size());
    }
    for (auto& event : _native) {
      _js.push_back(toNitroEvent(std::move(event)));
    }
    _native.clear();
  }

  if (_js.empty()) {
    return continueAfterFlush();
  }

  std::shared_ptr<Promise<bool>> completion;
  try {
    // Nitro marshals `_js` onto the JS thread; the Promise resolves once the
    // JS listener has actually returned.
    completion = listener(_js);
  } catch (...) {
    // The JS runtime (or its Dispatcher) is gone. Stop delivering rather than
    // spinning on a dead callback.
    clearListener();
    continueAfterFlush();
    return false;
  }

  if (completion == nullptr) {
    return continueAfterFlush();
  }

  std::weak_ptr<MpvFlushCoordinator> weakSelf = weak_from_this();
  completion->addOnResolvedListener([weakSelf](const bool& keepListening) {
    auto self = weakSelf.lock();
    if (self == nullptr) {
      return;
    }
    if (!keepListening) {
      self->clearListener();
    }
    if (self->continueAfterFlush()) {
      self->flush();
    }
  });
  completion->addOnRejectedListener([weakSelf](const std::exception_ptr&) {
    auto self = weakSelf.lock();
    if (self == nullptr) {
      return;
    }
    // The listener threw. Keep it registered (a throwing listener is a JS bug,
    // not a reason to silently stop the player) but close the flush cycle.
    if (self->continueAfterFlush()) {
      self->flush();
    }
  });
  return false;
}

// ---------------------------------------------------------------------------
// VisualizerDelivery
// ---------------------------------------------------------------------------

void VisualizerDelivery::attach(rnmedia::PcmTap* tap) {
  std::lock_guard<std::mutex> lock(_mutex);
  _tap = tap;
}

void VisualizerDelivery::detach() {
  std::lock_guard<std::mutex> lock(_mutex);
  _tap = nullptr;
  _listener = nullptr;
}

void VisualizerDelivery::setListener(const Listener& listener) {
  std::lock_guard<std::mutex> lock(_mutex);
  _listener = listener;
}

void VisualizerDelivery::clearListener() {
  std::lock_guard<std::mutex> lock(_mutex);
  _listener = nullptr;
}

void VisualizerDelivery::complete() {
  rnmedia::PcmTap* tap = nullptr;
  {
    std::lock_guard<std::mutex> lock(_mutex);
    tap = _tap;
  }
  if (tap != nullptr) {
    tap->onDeliveryComplete();
  }
}

void VisualizerDelivery::deliver(rnmedia::AnalysedFrame&& frame) {
  Listener listener;
  {
    std::lock_guard<std::mutex> lock(_mutex);
    listener = _listener;
  }
  if (!listener) {
    complete();
    return;
  }

  VisualizerCapture capture;
  // `move`, not `copy`: the vectors were built for exactly this hop, so the
  // spectrum reaches JS without a second allocation.
  capture.magnitudes = ArrayBuffer::move(std::move(frame.magnitudes));
  if (!frame.waveform.empty()) {
    capture.waveform = ArrayBuffer::move(std::move(frame.waveform));
  }
  capture.fftSize = static_cast<double>(frame.fftSize);
  capture.sampleRate = static_cast<double>(frame.sampleRate);
  capture.capturedAt = frame.capturedAt;
  capture.seq = static_cast<double>(frame.seq);
  capture.dropped = static_cast<double>(frame.dropped);

  std::shared_ptr<Promise<bool>> completion;
  try {
    completion = listener(capture);
  } catch (...) {
    // The JS runtime (or its Dispatcher) is gone. Stop delivering rather than
    // spinning on a dead callback.
    clearListener();
    complete();
    return;
  }

  if (completion == nullptr) {
    complete();
    return;
  }

  std::weak_ptr<VisualizerDelivery> weakSelf = weak_from_this();
  completion->addOnResolvedListener([weakSelf](const bool& keepListening) {
    auto self = weakSelf.lock();
    if (self == nullptr) {
      return;
    }
    if (!keepListening) {
      self->clearListener();
    }
    self->complete();
  });
  completion->addOnRejectedListener([weakSelf](const std::exception_ptr&) {
    auto self = weakSelf.lock();
    if (self == nullptr) {
      return;
    }
    // A throwing listener is a JS bug, not a reason to stop the visualizer.
    // Release the slot so the next tick can still be delivered.
    self->complete();
  });
}

// ---------------------------------------------------------------------------
// SourceResolutionDelivery
// ---------------------------------------------------------------------------

void SourceResolutionDelivery::setListener(const Listener& listener) {
  std::lock_guard<std::mutex> lock(_mutex);
  _listener = listener;
}

void SourceResolutionDelivery::clearListener() {
  std::lock_guard<std::mutex> lock(_mutex);
  _listener = nullptr;
}

void SourceResolutionDelivery::deliver(const std::string& url, std::optional<std::int64_t> entryId) {
  Listener listener;
  {
    std::lock_guard<std::mutex> lock(_mutex);
    listener = _listener;
  }
  if (!listener) {
    // No listener means nobody can answer. Throwing is how the caller learns
    // not to hold mpv's core open waiting for one.
    throw std::runtime_error("no source-resolution listener");
  }

  SourceResolutionRequest request;
  request.uri = url;
  if (entryId.has_value()) {
    // int64 -> double. mpv's playlist entry ids are a monotonic counter per
    // core, so this is exact for any playlist a human could build.
    request.entryId = static_cast<double>(*entryId);
  }
  listener(request);
}

// ---------------------------------------------------------------------------
// PrefetchDelivery
// ---------------------------------------------------------------------------

void PrefetchDelivery::setListener(const Listener& listener) {
  std::lock_guard<std::mutex> lock(_mutex);
  _listener = listener;
}

void PrefetchDelivery::clearListener() {
  std::lock_guard<std::mutex> lock(_mutex);
  _listener = nullptr;
}

void PrefetchDelivery::deliver(const std::string& url, std::optional<std::int64_t> entryId) {
  Listener listener;
  {
    std::lock_guard<std::mutex> lock(_mutex);
    listener = _listener;
  }
  if (!listener) {
    // Unlike a resolution request, no listener is not an error: nothing in mpv
    // is waiting to be told, so an unobserved prefetch is simply unobserved.
    return;
  }

  PrefetchStartedEvent event;
  event.uri = url;
  if (entryId.has_value()) {
    // int64 -> double, exact for any playlist a human could build; same
    // conversion and same reasoning as `SourceResolutionDelivery`.
    event.entryId = static_cast<double>(*entryId);
  }
  listener(event);
}

// ---------------------------------------------------------------------------
// HybridMpvClient
// ---------------------------------------------------------------------------

HybridMpvClient::HybridMpvClient()
    : HybridObject(TAG), _flusher(std::make_shared<MpvFlushCoordinator>()),
      _pending(std::make_shared<PendingCommands>()), _visualizer(std::make_shared<VisualizerDelivery>()),
      _resolution(std::make_shared<SourceResolutionDelivery>()), _prefetch(std::make_shared<PrefetchDelivery>()) {
  // Captured by value: all four are shared_ptrs, so the event thread can call
  // them even while HybridMpvClient is being torn down.
  auto flusher = _flusher;
  auto pending = _pending;
  auto resolution = _resolution;
  auto prefetch = _prefetch;
  _client = std::make_unique<rnmedia::MpvClient>(
      [flusher]() { flusher->onBatchReady(); },
      [pending](std::uint64_t replyId, int error) { pending->settle(replyId, error); },
      [resolution](const std::string& url, std::optional<std::int64_t> entryId) {
        resolution->deliver(url, entryId);
      },
      [prefetch](const std::string& url, std::optional<std::int64_t> entryId) {
        prefetch->deliver(url, entryId);
      });
  _flusher->attach(_client.get());
}

HybridMpvClient::~HybridMpvClient() {
  destroy();
}

void HybridMpvClient::destroy() {
  // Order matters. `stop()` joins the sampler thread, so after it returns
  // nothing can read a property or deliver a frame; only then is it safe to
  // take the mpv handle away.
  if (_tap != nullptr) {
    _tap->stop();
  }
  _visualizer->detach();
  if (_client != nullptr) {
    // `MpvClient::destroy()` aborts the resolution gate *before* joining, so an
    // event thread parked in a play-time hook hold is released rather than
    // waited out. The listener is dropped afterwards, once nothing can call it.
    _client->destroy(); // joins the event thread; mpv teardown goes background
  }
  _resolution->clearListener();
  _prefetch->clearListener();
  _pending->rejectAll(std::make_exception_ptr(rnmedia::DisposedError("command")));
  _flusher->detach();
}

void HybridMpvClient::dispose() {
  destroy();
}

void HybridMpvClient::initialize(const std::unordered_map<std::string, std::string>& options) {
  _client->initialize(options);
}

std::shared_ptr<Promise<void>> HybridMpvClient::command(const std::vector<std::string>& args) {
  auto promise = Promise<void>::create();
  const std::uint64_t replyId = _client->nextReplyId();
  // Registered before the call, so a reply arriving on the event thread the
  // instant `mpv_command_async` returns can never find an empty table.
  _pending->add(replyId, promise);
  try {
    _client->commandAsync(args, replyId);
  } catch (...) {
    if (auto pending = _pending->take(replyId); pending != nullptr) {
      pending->reject(std::current_exception());
    }
  }
  return promise;
}

std::optional<std::string> HybridMpvClient::getPropertyString(const std::string& name) {
  return _client->getPropertyString(name);
}

std::optional<double> HybridMpvClient::getPropertyNumber(const std::string& name) {
  return _client->getPropertyNumber(name);
}

std::optional<bool> HybridMpvClient::getPropertyBool(const std::string& name) {
  return _client->getPropertyBool(name);
}

std::optional<std::unordered_map<std::string, std::string>>
HybridMpvClient::getPropertyMap(const std::string& name) {
  std::unordered_map<std::string, std::string> out;
  // One `mpv_get_property(MPV_FORMAT_NODE)`, and mpv's node is freed before
  // `getPropertyNodeMap` returns — so the only copies made are the ones that
  // end up in `out`. Non-string members are skipped, per the spec's contract.
  const bool present = _client->getPropertyNodeMap(name, [&out](const rnmedia::NodeMember& member) {
    if (!member.text.has_value()) {
      return;
    }
    out.emplace(std::string(member.key), std::string(*member.text));
  });
  if (!present) {
    return std::nullopt;
  }
  return out;
}

std::vector<PlaylistEntry> HybridMpvClient::getPlaylistEntries() {
  std::vector<PlaylistEntry> out;
  // One `mpv_get_property("playlist", MPV_FORMAT_NODE)`. The walker hands us
  // every member of every element tagged with the element index, so the entries
  // are filled in place and each string is copied exactly once — mpv's node is
  // freed before the read returns.
  //
  // Field names and formats are mpv 0.41.0 `input.rst`, verbatim:
  //   "filename" STRING, "id" INT64, "current" FLAG (might be missing),
  //   "playing" FLAG (might be missing), "title" STRING (optional).
  // `current` missing is read as `false`, which is what mpv means by it — the
  // flag is only emitted for the entry `playlist-current-pos` points at.
  _client->getPropertyNodeMapArray(kPlaylistProperty,
                                   [&out](std::size_t index, const rnmedia::NodeMember& member) {
                                     if (out.size() <= index) {
                                       out.resize(index + 1, PlaylistEntry(std::string(), 0, false));
                                     }
                                     PlaylistEntry& entry = out[index];
                                     if (member.key == "filename") {
                                       if (member.text.has_value()) {
                                         entry.uri = std::string(*member.text);
                                       }
                                     } else if (member.key == "id") {
                                       if (member.number.has_value()) {
                                         entry.entryId = *member.number;
                                       }
                                     } else if (member.key == "current") {
                                       entry.current = member.integer.value_or(0) != 0;
                                     }
                                   });
  // An unavailable property (idle core) and an empty playlist are the same
  // answer to the caller, so `false` needs no separate branch: `out` is empty.
  return out;
}

void HybridMpvClient::setPropertyString(const std::string& name, const std::string& value) {
  _client->setPropertyString(name, value);
}

void HybridMpvClient::setPropertyNumber(const std::string& name, double value) {
  _client->setPropertyNumber(name, value);
}

void HybridMpvClient::setPropertyBool(const std::string& name, bool value) {
  _client->setPropertyBool(name, value);
}

void HybridMpvClient::observeProperty(const std::string& name, MpvFormat format) {
  _client->observeProperty(name, toNativeFormat(format));
}

void HybridMpvClient::unobserveProperty(const std::string& name) {
  _client->unobserveProperty(name);
}

void HybridMpvClient::setEventBatchListener(
    const std::function<std::shared_ptr<Promise<bool>>(const std::vector<MpvEvent>&)>& onEventBatch) {
  _flusher->setListener(onEventBatch);
}

void HybridMpvClient::startVisualizer(double fftSize, double fps, bool waveform) {
  if (_tap == nullptr) {
    // `_client` is a unique_ptr member that outlives the tap (declaration
    // order, and `destroy()` stops the tap first), so capturing the raw pointer
    // is safe for the tap's whole lifetime.
    rnmedia::MpvClient* client = _client.get();
    rnmedia::TapSource source{
        .configure = [client](int frames) { return client->configurePcmTap(frames); },
        .read = [client](std::vector<float>& out, int& channels, int& rate, std::int64_t& seq) {
          return client->readPcmTapWindow(out, channels, rate, seq);
        },
    };
    auto delivery = _visualizer;
    _tap = std::make_unique<rnmedia::PcmTap>(
        std::move(source), [delivery](rnmedia::AnalysedFrame&& frame) { delivery->deliver(std::move(frame)); });
    _visualizer->attach(_tap.get());
  }
  _tap->start(static_cast<int>(fftSize), static_cast<int>(fps), waveform);
}

void HybridMpvClient::stopVisualizer() {
  if (_tap == nullptr) {
    return;
  }
  // `stop()` first: it joins the sampler thread and disarms mpv's ring, so
  // nothing can be mid-analysis when the tap is destroyed.
  _tap->stop();
  // Then detach *before* freeing, because `VisualizerDelivery` holds a raw
  // pointer to the tap and calls `onDeliveryComplete()` on it when a capture's
  // JS promise settles. Both this method and that settlement run on the JS
  // thread, so there is no window between the two lines — but the order still
  // has to be right for the case where a capture is in flight.
  _visualizer->attach(nullptr);
  // Freeing is the point: the FFT tables, the Hann window, the PCM/mono/real/
  // imag scratch and the magnitude buffers are ~75 KB at the default
  // 2048-point transform and ~600 KB at the 16384 ceiling, per player. The
  // lifetime contract for the whole feature is "derived from the listener set"
  // (ARCHITECTURE §21), and holding a disarmed tap's buffers for the life of
  // the player was the one place that was not true. `startVisualizer()`
  // rebuilds and re-attaches on the next subscribe.
  _tap.reset();
}

void HybridMpvClient::setVisualizerListener(
    const std::function<std::shared_ptr<Promise<bool>>(const VisualizerCapture&)>& onCapture) {
  _visualizer->setListener(onCapture);
}

void HybridMpvClient::setSourceResolutionListener(
    const std::function<void(const SourceResolutionRequest&)>& onRequest) {
  _resolution->setListener(onRequest);
}

void HybridMpvClient::setPrefetchStartedListener(
    const std::function<void(const PrefetchStartedEvent&)>& onPrefetchStarted) {
  _prefetch->setListener(onPrefetchStarted);
}

void HybridMpvClient::installSourceResolver(double timeoutMs) {
  _client->installSourceResolver(static_cast<std::int64_t>(timeoutMs));
}

void HybridMpvClient::uninstallSourceResolver() {
  _client->uninstallSourceResolver();
}

void HybridMpvClient::setResolvedSource(const std::string& logical, const std::string& resolved, double ttlMs) {
  _client->setResolvedSource(logical, resolved, static_cast<std::int64_t>(ttlMs));
}

void HybridMpvClient::clearResolvedSources() {
  _client->clearResolvedSources();
}

void HybridMpvClient::completeResolution(const std::string& logical, const std::optional<std::string>& resolved,
                                         double ttlMs) {
  _client->completeResolution(logical, resolved, static_cast<std::int64_t>(ttlMs));
}

void HybridMpvClient::attachVideoOutput(uint64_t /* handle */) {
  throwUnsupported("attachVideoOutput");
}

void HybridMpvClient::detachVideoOutput() {
  throwUnsupported("detachVideoOutput");
}

uint64_t HybridMpvClient::getRawHandle() {
  return _client->rawHandle();
}

} // namespace margelo::nitro::rnmediaplayer
