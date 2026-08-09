#include "MpvClient.hpp"

#include <mpv/client.h>

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

/// Reserved key in the options map: it is the argument to
/// `mpv_request_log_messages`, not an mpv option (mpv has no `log-level`
/// option, so this cannot shadow a real one).
constexpr const char* kLogLevelKey = "log-level";
constexpr const char* kDefaultLogLevel = "warn";

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

MpvClient::MpvClient(BatchReadyFn onBatchReady, CommandReplyFn onCommandReply)
    : _onBatchReady(std::move(onBatchReady)), _onCommandReply(std::move(onCommandReply)) {
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

  // Only flip the state once mpv is actually running, so a failed initialize
  // leaves the client in `Created` (still destroyable, not usable).
  _state.markInitialized();
  _eventThread = std::thread([this, handle]() { eventLoop(handle); });
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
  if (_eventThread.joinable()) {
    mpv_wakeup(handle);
    _eventThread.join();
  }
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

bool MpvClient::handleEvent(void* rawEvent) {
  auto* event = static_cast<mpv_event*>(rawEvent);

  switch (event->event_id) {
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
        scheduleFlush |= handleEvent(event);
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
