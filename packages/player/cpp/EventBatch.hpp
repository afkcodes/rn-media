#pragma once

///
/// EventBatch.hpp — batch buffer + coalescing for the mpv event stream.
///
/// Deliberately depends on nothing but the C++ standard library: no `mpv/*`,
/// no Nitro. That is what makes it host-unit-testable (see `cpp/tests/`).
///
/// One `EventBatch` sits between the mpv event thread (producer, `push`) and
/// the JS thread (consumer, `drain`/`endFlush`). It owns the "is a flush
/// already scheduled?" bit, because the decision *whether to schedule* and the
/// decision *what is in the batch* have to be made under one lock, or a flush
/// completing concurrently with a push can lose a wakeup.
///

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <variant>
#include <vector>

namespace rnmedia {

/// Which kind of mpv event this is. Mirrors `MpvEventKind` in the Nitro spec.
/// `None` is not a real event: it is the tombstone left behind when a property
/// event is superseded by a newer value for the same property. `drain()`
/// compacts them away, so a tombstone is never observable from outside.
enum class EventKind : std::uint8_t {
  None = 0,
  Property,
  StartFile,
  EndFile,
  Seek,
  PlaybackRestart,
  Log,
  Shutdown,
};

/// Mirrors `mpv_end_file_reason` / the `MpvEndFileReason` Nitro enum.
enum class EndFileReason : std::uint8_t {
  EndOfFile,
  Stop,
  Quit,
  Error,
  Redirect,
  Unknown,
};

/// Mirrors `mpv_log_level` / the `MpvLogLevel` Nitro enum.
enum class LogLevel : std::uint8_t {
  Fatal,
  Error,
  Warn,
  Info,
  Verbose,
  Debugging,
  Trace,
};

/// An observed property's value. `std::monostate` means mpv reported the
/// property as currently unavailable (`MPV_FORMAT_NONE`), which is distinct
/// from "empty string" or "0".
using PropertyValue = std::variant<std::monostate, bool, std::string, double>;

/// One already-translated mpv event. Flat rather than a variant so the batch
/// buffer stays a single contiguous `std::vector` whose capacity is reused
/// across flushes — the hot path allocates only for the strings it carries.
///
/// Which fields are meaningful depends on `kind`:
///   Property        -> name, value
///   EndFile         -> endFileReason, text (mpv's error string, if any)
///   Log             -> logLevel, name (mpv's prefix), text
///   everything else -> none
struct Event {
  EventKind kind = EventKind::None;
  EndFileReason endFileReason = EndFileReason::Unknown;
  LogLevel logLevel = LogLevel::Info;
  std::string name;
  std::string text;
  PropertyValue value;

  static Event property(std::string name, PropertyValue value) {
    Event e;
    e.kind = EventKind::Property;
    e.name = std::move(name);
    e.value = std::move(value);
    return e;
  }

  static Event discrete(EventKind kind) {
    Event e;
    e.kind = kind;
    return e;
  }

  static Event endFile(EndFileReason reason, std::string errorText = {}) {
    Event e;
    e.kind = EventKind::EndFile;
    e.endFileReason = reason;
    e.text = std::move(errorText);
    return e;
  }

  static Event log(LogLevel level, std::string prefix, std::string text) {
    Event e;
    e.kind = EventKind::Log;
    e.logLevel = level;
    e.name = std::move(prefix);
    e.text = std::move(text);
    return e;
  }
};

///
/// Thread-safe buffer with property coalescing.
///
/// Contract:
///  - `push()` returns `true` exactly once per flush cycle — for the event that
///    took the batch from "no flush scheduled" to "flush scheduled". Only that
///    caller may start a flush.
///  - `drain()` moves the live events out. The flush stays marked as in flight,
///    so concurrent pushes accumulate instead of scheduling a second flush.
///  - `endFlush()` closes the cycle. It returns `true` if events arrived while
///    the flush was in flight, in which case the caller must `drain()` again
///    (the flush stays marked in flight). It returns `false` when the batch is
///    empty, and only then is a fresh `push()` allowed to schedule again.
///
/// Coalescing rules:
///  - Two `Property` events with the same name collapse into one, keeping the
///    newest value **at the newest position**. Keeping the newest position
///    (rather than updating in place) preserves causality against discrete
///    events: `pause=true, endFile, pause=false` drains as
///    `endFile, pause=false`, never as `pause=false, endFile`.
///  - Discrete events (start-file, end-file, seek, playback-restart, log,
///    shutdown) never coalesce and keep their relative order.
///
class EventBatch {
public:
  EventBatch() = default;
  EventBatch(const EventBatch&) = delete;
  EventBatch& operator=(const EventBatch&) = delete;

  /// Producer side. Returns `true` if the caller must schedule a flush.
  bool push(Event&& event) {
    std::lock_guard<std::mutex> lock(_mutex);
    if (event.kind == EventKind::Property) {
      auto [it, inserted] = _propertyIndex.try_emplace(event.name, Slot{_generation, _events.size()});
      if (!inserted) {
        if (it->second.generation == _generation) {
          // Same property, same batch: tombstone the older entry.
          _events[it->second.index].kind = EventKind::None;
          ++_tombstones;
        }
        it->second = Slot{_generation, _events.size()};
      }
    }
    _events.push_back(std::move(event));

    if (_flushScheduled) {
      return false;
    }
    _flushScheduled = true;
    return true;
  }

  /// Consumer side. Moves every live event into `out` (cleared first), in
  /// order. `out`'s capacity is reused, and so is the batch's own storage.
  void drain(std::vector<Event>& out) {
    std::lock_guard<std::mutex> lock(_mutex);
    out.clear();
    if (out.capacity() < _events.size()) {
      out.reserve(_events.size());
    }
    for (auto& event : _events) {
      if (event.kind == EventKind::None) {
        continue; // superseded property value
      }
      out.push_back(std::move(event));
    }
    _events.clear(); // keeps capacity
    _tombstones = 0;
    // Invalidate every property slot without freeing the (reusable) keys.
    ++_generation;
  }

  /// Consumer side. Closes a flush cycle; see the class contract.
  bool endFlush() {
    std::lock_guard<std::mutex> lock(_mutex);
    if (_events.size() > _tombstones) {
      return true; // more work arrived while we were flushing
    }
    _flushScheduled = false;
    return false;
  }

  /// Drop everything and disarm. Used when the client is destroyed.
  void reset() {
    std::lock_guard<std::mutex> lock(_mutex);
    _events.clear();
    _propertyIndex.clear();
    _tombstones = 0;
    _flushScheduled = false;
    ++_generation;
  }

  /// Test/diagnostic helpers.
  bool flushScheduled() const {
    std::lock_guard<std::mutex> lock(_mutex);
    return _flushScheduled;
  }

  std::size_t pendingCount() const {
    std::lock_guard<std::mutex> lock(_mutex);
    return _events.size() - _tombstones;
  }

private:
  /// Where the newest live entry for a property name lives. `generation` makes
  /// stale entries from previous batches self-invalidating, so the key strings
  /// (which repeat every batch: `pause`, `duration`, …) are allocated once for
  /// the lifetime of the client instead of once per batch.
  struct Slot {
    std::uint64_t generation;
    std::size_t index;
  };

  mutable std::mutex _mutex;
  std::vector<Event> _events;
  std::unordered_map<std::string, Slot> _propertyIndex;
  std::size_t _tombstones = 0;
  std::uint64_t _generation = 1;
  bool _flushScheduled = false;
};

} // namespace rnmedia
