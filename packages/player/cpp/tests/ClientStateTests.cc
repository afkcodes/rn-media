///
/// Host tests for the disposed-state machine that backs the
/// "every method after destroy throws a typed error, never crashes" contract
/// in docs/specs/player-core.md §1.
///

#include "TestRunner.h"

#include "../ClientState.hpp"

#include <atomic>
#include <string>
#include <thread>
#include <vector>

using rnmedia::ClientState;
using rnmedia::DisposedError;
using rnmedia::InvalidStateError;
using rnmedia::LifecycleState;

namespace {

bool hasTag(const std::exception& error, const std::string& tag) {
  return std::string(error.what()).find(tag) == 0;
}

} // namespace

TEST(ClientState, StartsInCreated) {
  ClientState state;
  CHECK_EQ(state.state(), LifecycleState::Created);
  CHECK(!state.isDestroyed());
  CHECK(!state.isInitialized());
}

TEST(ClientState, OperationsBeforeInitializeThrowInvalidState) {
  ClientState state;
  CHECK_THROWS(state.requireInitialized("getPropertyString"), InvalidStateError);
  try {
    state.requireInitialized("getPropertyString");
  } catch (const InvalidStateError& error) {
    CHECK(hasTag(error, "[mpv:invalid-state]"));
    CHECK(std::string(error.what()).find("getPropertyString") != std::string::npos);
  }
}

TEST(ClientState, InitializeMovesToInitialized) {
  ClientState state;
  state.markInitialized();
  CHECK_EQ(state.state(), LifecycleState::Initialized);
  CHECK(state.isInitialized());
  state.requireInitialized("command"); // must not throw
}

TEST(ClientState, DoubleInitializeThrows) {
  ClientState state;
  state.markInitialized();
  CHECK_THROWS(state.markInitialized(), InvalidStateError);
}

TEST(ClientState, DestroyIsIdempotentAndOnlyOneCallerWins) {
  ClientState state;
  state.markInitialized();
  CHECK(state.markDestroyed());
  CHECK(!state.markDestroyed());
  CHECK(!state.markDestroyed());
  CHECK(state.isDestroyed());
}

TEST(ClientState, DestroyFromCreatedIsAllowed) {
  // destroy() before initialize() (e.g. initialize threw) must still work.
  ClientState state;
  CHECK(state.markDestroyed());
  CHECK(state.isDestroyed());
}

TEST(ClientState, EveryOperationAfterDestroyThrowsDisposed) {
  ClientState state;
  state.markInitialized();
  state.markDestroyed();

  CHECK_THROWS(state.requireInitialized("command"), DisposedError);
  try {
    state.requireInitialized("command");
  } catch (const DisposedError& error) {
    CHECK(hasTag(error, "[mpv:disposed]"));
    CHECK(std::string(error.what()).find("command") != std::string::npos);
  }
}

TEST(ClientState, InitializeAfterDestroyThrowsDisposedNotInvalidState) {
  ClientState state;
  state.markDestroyed();
  CHECK_THROWS(state.markInitialized(), DisposedError);
}

TEST(ClientState, DestroyWhileLoadingStillTransitionsExactlyOnce) {
  // "destroy while loading": the client is Initialized and busy; destroy must
  // win the transition once and every later call must be a no-op.
  ClientState state;
  state.markInitialized();

  constexpr int kThreads = 16;
  std::atomic<int> winners{0};
  std::atomic<bool> go{false};
  std::vector<std::thread> threads;
  threads.reserve(kThreads);
  for (int i = 0; i < kThreads; ++i) {
    threads.emplace_back([&]() {
      while (!go.load(std::memory_order_acquire)) {
        std::this_thread::yield();
      }
      if (state.markDestroyed()) {
        winners.fetch_add(1, std::memory_order_relaxed);
      }
    });
  }
  go.store(true, std::memory_order_release);
  for (auto& thread : threads) {
    thread.join();
  }

  CHECK_EQ(winners.load(), 1);
  CHECK(state.isDestroyed());
}

TEST(ClientState, ConcurrentInitializeHasExactlyOneWinner) {
  ClientState state;
  constexpr int kThreads = 16;
  std::atomic<int> winners{0};
  std::atomic<bool> go{false};
  std::vector<std::thread> threads;
  threads.reserve(kThreads);
  for (int i = 0; i < kThreads; ++i) {
    threads.emplace_back([&]() {
      while (!go.load(std::memory_order_acquire)) {
        std::this_thread::yield();
      }
      try {
        state.markInitialized();
        winners.fetch_add(1, std::memory_order_relaxed);
      } catch (const std::exception&) {
        // expected for the losers
      }
    });
  }
  go.store(true, std::memory_order_release);
  for (auto& thread : threads) {
    thread.join();
  }

  CHECK_EQ(winners.load(), 1);
  CHECK(state.isInitialized());
}
