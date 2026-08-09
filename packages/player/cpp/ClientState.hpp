#pragma once

///
/// ClientState.hpp — the `MpvClient` lifecycle state machine, factored out so
/// it can be unit-tested on the host without linking libmpv.
///
/// Depends on nothing but the C++ standard library (no `mpv/*`, no Nitro).
///
/// States and the only legal transitions:
///
///     Created ──initialize()──> Initialized ──destroy()──> Destroyed
///        └────────────────────  destroy()  ──────────────────┘
///
/// `destroy()` is idempotent: only the first caller wins the transition, every
/// later call is a no-op. Every operation other than `destroy()` throws
/// `DisposedError` once the state is `Destroyed` — the contract is "never
/// crashes after destroy".
///

#include <atomic>
#include <cstdint>
#include <stdexcept>
#include <string>

namespace rnmedia {

/// Prefix every message we surface to JS carries, so the TypeScript layer can
/// map C++ exceptions onto the typed error taxonomy without string sniffing
/// the whole message. `[mpv:disposed]`, `[mpv:unsupported]`, `[mpv:-12]`, …
inline constexpr const char* kErrorTagPrefix = "[mpv:";

/// Thrown by every method called after `destroy()`.
class DisposedError final : public std::runtime_error {
public:
  explicit DisposedError(const std::string& operation)
      : std::runtime_error(std::string(kErrorTagPrefix) + "disposed] Cannot call `" + operation +
                           "` — this MpvClient has already been destroyed.") {}
};

/// Thrown when an operation is called in the wrong lifecycle state (but the
/// client is still alive), e.g. reading a property before `initialize()`.
class InvalidStateError final : public std::runtime_error {
public:
  explicit InvalidStateError(const std::string& message)
      : std::runtime_error(std::string(kErrorTagPrefix) + "invalid-state] " + message) {}
};

enum class LifecycleState : std::uint8_t {
  Created = 0,
  Initialized,
  Destroyed,
};

///
/// Lock-free lifecycle guard.
///
/// Reads are `acquire` loads so a thread that observes `Destroyed` also
/// observes everything the destroying thread published beforehand. The
/// `Created -> Initialized` and `* -> Destroyed` transitions are CAS'd, which
/// is what makes double-initialize and double-destroy safe under concurrency
/// rather than merely unlikely.
///
class ClientState {
public:
  ClientState() = default;
  ClientState(const ClientState&) = delete;
  ClientState& operator=(const ClientState&) = delete;

  LifecycleState state() const noexcept {
    return _state.load(std::memory_order_acquire);
  }

  bool isDestroyed() const noexcept {
    return state() == LifecycleState::Destroyed;
  }

  bool isInitialized() const noexcept {
    return state() == LifecycleState::Initialized;
  }

  /// Guard for operations that need a live, initialized core.
  /// Throws `DisposedError` after destroy, `InvalidStateError` before init.
  void requireInitialized(const char* operation) const {
    switch (state()) {
      case LifecycleState::Initialized:
        return;
      case LifecycleState::Destroyed:
        throw DisposedError(operation);
      case LifecycleState::Created:
        throw InvalidStateError(std::string("Cannot call `") + operation +
                                "` before `initialize()` — the mpv core is not running yet.");
    }
  }

  /// `Created -> Initialized`. Throws if already initialized or destroyed.
  void markInitialized() {
    LifecycleState expected = LifecycleState::Created;
    if (_state.compare_exchange_strong(expected, LifecycleState::Initialized, std::memory_order_acq_rel,
                                       std::memory_order_acquire)) {
      return;
    }
    if (expected == LifecycleState::Destroyed) {
      throw DisposedError("initialize");
    }
    throw InvalidStateError("`initialize()` has already been called on this MpvClient.");
  }

  /// `* -> Destroyed`. Returns `true` for the single caller that won the
  /// transition; every other caller gets `false` and must do nothing.
  bool markDestroyed() noexcept {
    LifecycleState previous = _state.exchange(LifecycleState::Destroyed, std::memory_order_acq_rel);
    return previous != LifecycleState::Destroyed;
  }

private:
  std::atomic<LifecycleState> _state{LifecycleState::Created};
};

} // namespace rnmedia
