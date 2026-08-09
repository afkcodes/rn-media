#include "HybridMpvClient.hpp"

#include <stdexcept>
#include <utility>
#include <variant>

namespace margelo::nitro::rnmediaplayer {

namespace {

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
// HybridMpvClient
// ---------------------------------------------------------------------------

HybridMpvClient::HybridMpvClient()
    : HybridObject(TAG), _flusher(std::make_shared<MpvFlushCoordinator>()),
      _pending(std::make_shared<PendingCommands>()) {
  // Captured by value: both are shared_ptrs, so the event thread can call them
  // even while HybridMpvClient is being torn down.
  auto flusher = _flusher;
  auto pending = _pending;
  _client = std::make_unique<rnmedia::MpvClient>([flusher]() { flusher->onBatchReady(); },
                                                 [pending](std::uint64_t replyId, int error) {
                                                   pending->settle(replyId, error);
                                                 });
  _flusher->attach(_client.get());
}

HybridMpvClient::~HybridMpvClient() {
  destroy();
}

void HybridMpvClient::destroy() {
  if (_client != nullptr) {
    _client->destroy(); // joins the event thread; mpv teardown goes background
  }
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
