#pragma once

///
/// SourceResolution.hpp — the two pure-logic pieces of dynamic source
/// resolution: the per-core cache of resolved URLs, and the bounded hold that a
/// play-time `on_load` hook parks on while JavaScript answers.
///
/// Deliberately depends on nothing but the C++ standard library: no `mpv/*`, no
/// Nitro. That is what makes both host-unit-testable (`cpp/tests/
/// SourceResolutionTests.cc`). Everything that actually talks to mpv — reading
/// `stream-open-filename`, `mpv_hook_add`, `mpv_hook_continue` — lives in
/// `MpvClient.cpp` and uses these two as plain values.
///
/// ========================== WHY A CACHE AT ALL =============================
///
/// The cache is **correctness, not optimisation**. Our fork fires
/// `on_prefetch_load` on mpv's prefetch path, but stock mpv still fires
/// `on_load` again for the same entry at play time, and
/// `open_demux_reentrant()` decides whether the prefetched demuxer can be
/// reused by a byte-exact `strcmp` of the pre- and post-hook URLs
/// (mpv 0.41.0 `player/loadfile.c:1223`). A resolver that answers differently
/// on the second pass makes mpv log "Dropping finished prefetch of wrong URL",
/// `cancel_open()` (which joins the opener thread on the core thread, at the
/// boundary) and open cold — i.e. *worse* than never prefetching. Keying an
/// answer to its logical URL and replaying it is what makes the two passes
/// agree.
///
/// ========================= WHY A BOUNDED HOLD ==============================
///
/// `process_hooks()` is a busy-wait on mpv's core thread (`loadfile.c:1061`);
/// while a hook is open mpv does not decode and does not refill the audio
/// output, so the only thing keeping sound coming is what the AO already has
/// queued — 0.2 s by default (`--audio-buffer`), measured at 816/826 ms on our
/// own device (ARCHITECTURE §12). mpv has no timeout of its own: a client that
/// never continues freezes the player forever.
///
/// That budget is why the two hooks are handled completely differently:
///
///  - `on_prefetch_load` fires **mid-track, over live audio** (it is armed by
///    `handle_update_cache` the first time the *demuxer* hits EOF, i.e. seconds
///    into the current track, not near the boundary). A miss there is answered
///    by continuing the hook immediately and warming the cache afterwards —
///    this gate is never used on that path.
///  - `on_load` fires between entries, with the new entry not yet open and the
///    previous one already ended. There is no audio of this track to starve, so
///    a *bounded* hold is safe, and it is the only way an async resolver can
///    influence the URL mpv is about to open.
///

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>

namespace rnmedia {

/// Milliseconds off a monotonic clock. Never wall time: a resolution TTL must
/// not move when the user changes the device clock or a timezone rolls over.
inline std::int64_t steadyNowMs() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

///
/// logical URL -> resolved URL, with an expiry.
///
/// Small on purpose: it holds at most {@link kMaxEntries} entries, because the
/// only thing it has to survive is the window between "JavaScript resolved
/// ahead" and "mpv asks", which spans a couple of playlist entries. When it is
/// full the entry that expires soonest is evicted — the one whose answer is
/// worth least.
///
/// Thread-safe: written from the JS thread (`setResolvedSource`,
/// `completeResolution`), read from the mpv event thread inside a hook.
///
class ResolvedSourceCache final {
public:
  /// Injected so the expiry logic is testable without sleeping.
  using Clock = std::function<std::int64_t()>;

  static constexpr std::size_t kMaxEntries = 64;

  explicit ResolvedSourceCache(Clock clock = &steadyNowMs) : _clock(std::move(clock)) {}

  ResolvedSourceCache(const ResolvedSourceCache&) = delete;
  ResolvedSourceCache& operator=(const ResolvedSourceCache&) = delete;

  /// Remember that `logical` resolves to `resolved` for the next `ttlMs`.
  ///
  /// A `ttlMs <= 0` stores nothing at all: an entry that is already expired can
  /// only cost a lookup, and silently keeping it would make "no TTL" mean
  /// "forever" — the one value a signed URL must never have.
  void put(const std::string& logical, const std::string& resolved, std::int64_t ttlMs) {
    if (ttlMs <= 0) {
      return;
    }
    const std::int64_t expiresAt = _clock() + ttlMs;
    std::lock_guard<std::mutex> lock(_mutex);
    auto existing = _entries.find(logical);
    if (existing != _entries.end()) {
      existing->second = Entry{resolved, expiresAt};
      return;
    }
    if (_entries.size() >= kMaxEntries) {
      evictSoonest();
    }
    _entries.emplace(logical, Entry{resolved, expiresAt});
  }

  /// The unexpired answer for `logical`, if there is one. An expired entry is
  /// dropped on the way out, so a stale URL is never handed to mpv twice.
  std::optional<std::string> lookup(const std::string& logical) {
    const std::int64_t now = _clock();
    std::lock_guard<std::mutex> lock(_mutex);
    auto entry = _entries.find(logical);
    if (entry == _entries.end()) {
      return std::nullopt;
    }
    if (entry->second.expiresAt <= now) {
      _entries.erase(entry);
      return std::nullopt;
    }
    return entry->second.resolved;
  }

  void clear() {
    std::lock_guard<std::mutex> lock(_mutex);
    _entries.clear();
  }

  std::size_t size() const {
    std::lock_guard<std::mutex> lock(_mutex);
    return _entries.size();
  }

private:
  struct Entry {
    std::string resolved;
    std::int64_t expiresAt;
  };

  /// Caller holds `_mutex`. Drops the entry closest to expiry — including any
  /// already-expired one, which is what keeps a long-lived core from carrying
  /// dead entries around.
  void evictSoonest() {
    auto soonest = _entries.begin();
    for (auto it = _entries.begin(); it != _entries.end(); ++it) {
      if (it->second.expiresAt < soonest->second.expiresAt) {
        soonest = it;
      }
    }
    if (soonest != _entries.end()) {
      _entries.erase(soonest);
    }
  }

  mutable std::mutex _mutex;
  const Clock _clock;
  std::unordered_map<std::string, Entry> _entries;
};

///
/// The bounded hold a play-time `on_load` hook waits on.
///
/// At most one hold is ever open per core: mpv delivers hook events one at a
/// time, and the mpv event thread — the only thread that handles them — is
/// inside `await()` for the whole hold. So this is a single slot, not a table.
///
/// Threading contract:
///  - `begin()` / `await()`  — mpv event thread, in that order, always paired.
///  - `complete()`           — JS thread, from `completeResolution`.
///  - `cancel()` / `abort()` — any thread; `abort()` is called by `destroy()`
///                             so teardown never waits out a resolver timeout.
///
class ResolutionGate final {
public:
  ResolutionGate() = default;
  ResolutionGate(const ResolutionGate&) = delete;
  ResolutionGate& operator=(const ResolutionGate&) = delete;

  /// Arm the hold for `logical`. Must be followed by exactly one `await()`.
  void begin(const std::string& logical) {
    std::lock_guard<std::mutex> lock(_mutex);
    _open = true;
    _logical = logical;
    _answered = false;
    _answer.reset();
  }

  /// Block until `complete()` names the same URL, `timeoutMs` elapses, or the
  /// gate is cancelled/aborted. Always closes the hold.
  ///
  /// @returns The resolved URL, or `std::nullopt` for "no answer" — on which
  /// the caller continues the hook *unrewritten* and lets mpv fail the load
  /// naturally, so the failure arrives on the existing typed error path
  /// instead of a second, parallel one.
  std::optional<std::string> await(std::int64_t timeoutMs) {
    std::unique_lock<std::mutex> lock(_mutex);
    if (!_aborted && !_answered && timeoutMs > 0) {
      _settled.wait_for(lock, std::chrono::milliseconds(timeoutMs), [this] { return _answered || _aborted; });
    }
    std::optional<std::string> answer = _answered ? _answer : std::nullopt;
    _open = false;
    _answered = false;
    _answer.reset();
    _logical.clear();
    return answer;
  }

  /// Answer an open hold. A `resolved` without a value means "could not be
  /// resolved"; the hook is then continued unrewritten.
  ///
  /// An answer for a URL nobody is holding is dropped — that is the normal case
  /// for a prefetch request, which never holds anything (its cache write
  /// happens separately, before this is called).
  ///
  /// @returns whether an open hold was settled.
  bool complete(const std::string& logical, const std::optional<std::string>& resolved) {
    {
      std::lock_guard<std::mutex> lock(_mutex);
      if (!_open || _answered || _logical != logical) {
        return false;
      }
      _answered = true;
      _answer = resolved;
    }
    _settled.notify_all();
    return true;
  }

  /// Release an open hold with no answer, leaving the gate usable. Used when
  /// the resolver is uninstalled while a hook is parked on it.
  void cancel() {
    release(false);
  }

  /// Release an open hold and refuse every future one. Used by `destroy()`.
  void abort() {
    release(true);
  }

  bool open() const {
    std::lock_guard<std::mutex> lock(_mutex);
    return _open;
  }

private:
  void release(bool permanent) {
    {
      std::lock_guard<std::mutex> lock(_mutex);
      if (permanent) {
        _aborted = true;
      }
      if (_open && !_answered) {
        _answered = true;
        _answer.reset();
      }
    }
    _settled.notify_all();
  }

  mutable std::mutex _mutex;
  std::condition_variable _settled;
  bool _open = false;
  bool _answered = false;
  bool _aborted = false;
  std::string _logical;
  std::optional<std::string> _answer;
};

} // namespace rnmedia
