///
/// Host-compiled tests for `SourceResolution.hpp` — the resolved-URL cache and
/// the play-time hold. Both are pure std, so everything below runs without
/// libmpv, without Nitro and without a device.
///
/// The clock is injected rather than slept on: an expiry test that sleeps is a
/// flaky test on a loaded CI box, and the thing under test is the comparison,
/// not the passage of time.
///

#include "SourceResolution.hpp"
#include "TestRunner.h"

#include <atomic>
#include <chrono>
#include <thread>

using rnmedia::ResolutionGate;
using rnmedia::ResolvedSourceCache;

namespace {

/// A hand-cranked monotonic clock, in the same milliseconds the real one uses.
struct FakeClock {
  std::shared_ptr<std::int64_t> nowMs = std::make_shared<std::int64_t>(1'000);

  ResolvedSourceCache::Clock fn() const {
    auto cell = nowMs;
    return [cell]() { return *cell; };
  }

  void advance(std::int64_t ms) const {
    *nowMs += ms;
  }
};

} // namespace

// ---------------------------------------------------------------------------
// ResolvedSourceCache
// ---------------------------------------------------------------------------

TEST(SourceResolution, cacheReturnsWhatWasPut) {
  FakeClock clock;
  ResolvedSourceCache cache(clock.fn());

  cache.put("track://1", "https://cdn/1?sig=a", 1'000);

  const auto hit = cache.lookup("track://1");
  CHECK(hit.has_value());
  CHECK_EQ(*hit, std::string("https://cdn/1?sig=a"));
  CHECK(!cache.lookup("track://2").has_value());
}

TEST(SourceResolution, cacheReplaysTheSameAnswerForTheSecondHookPass) {
  // The determinism guarantee, as a test: mpv fires `on_prefetch_load` and then
  // `on_load` for the same entry and compares the two resulting URLs
  // byte-for-byte. Two lookups of one entry must be indistinguishable.
  FakeClock clock;
  ResolvedSourceCache cache(clock.fn());

  cache.put("track://1", "https://cdn/1?sig=a", 60'000);
  const auto prefetchPass = cache.lookup("track://1");
  clock.advance(30'000);
  const auto playPass = cache.lookup("track://1");

  CHECK(prefetchPass.has_value());
  CHECK(playPass.has_value());
  CHECK_EQ(*prefetchPass, *playPass);
}

TEST(SourceResolution, cacheExpiresOnItsTtl) {
  FakeClock clock;
  ResolvedSourceCache cache(clock.fn());

  cache.put("track://1", "https://cdn/1", 500);
  clock.advance(499);
  CHECK(cache.lookup("track://1").has_value());

  clock.advance(1); // exactly on the deadline counts as expired
  CHECK(!cache.lookup("track://1").has_value());
  // …and the dead entry is gone, not merely hidden.
  CHECK_EQ(cache.size(), static_cast<std::size_t>(0));
}

TEST(SourceResolution, cacheRefusesANonPositiveTtl) {
  FakeClock clock;
  ResolvedSourceCache cache(clock.fn());

  cache.put("track://1", "https://cdn/1", 0);
  cache.put("track://2", "https://cdn/2", -1);

  CHECK(!cache.lookup("track://1").has_value());
  CHECK(!cache.lookup("track://2").has_value());
  CHECK_EQ(cache.size(), static_cast<std::size_t>(0));
}

TEST(SourceResolution, cachePutReplacesAndDoesNotGrow) {
  FakeClock clock;
  ResolvedSourceCache cache(clock.fn());

  cache.put("track://1", "https://cdn/old", 1'000);
  cache.put("track://1", "https://cdn/new", 1'000);

  CHECK_EQ(cache.size(), static_cast<std::size_t>(1));
  CHECK_EQ(*cache.lookup("track://1"), std::string("https://cdn/new"));
}

TEST(SourceResolution, cacheIsBoundedAndEvictsTheSoonestToExpire) {
  FakeClock clock;
  ResolvedSourceCache cache(clock.fn());

  // The entry that expires first is the one whose answer is worth least.
  cache.put("track://doomed", "https://cdn/doomed", 10);
  for (std::size_t i = 0; i < ResolvedSourceCache::kMaxEntries; i++) {
    cache.put("track://" + std::to_string(i), "https://cdn/" + std::to_string(i), 100'000);
  }

  CHECK_EQ(cache.size(), ResolvedSourceCache::kMaxEntries);
  CHECK(!cache.lookup("track://doomed").has_value());
  CHECK(cache.lookup("track://0").has_value());
}

TEST(SourceResolution, cacheClearForgetsEverything) {
  FakeClock clock;
  ResolvedSourceCache cache(clock.fn());

  cache.put("track://1", "https://cdn/1", 1'000);
  cache.clear();

  CHECK(!cache.lookup("track://1").has_value());
  CHECK_EQ(cache.size(), static_cast<std::size_t>(0));
}

// ---------------------------------------------------------------------------
// ResolutionGate
// ---------------------------------------------------------------------------

TEST(SourceResolution, gateReturnsTheAnswerItWasGiven) {
  ResolutionGate gate;
  gate.begin("track://1");
  CHECK(gate.open());

  std::thread answerer([&gate]() {
    // The JS thread, arriving whenever it arrives.
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    gate.complete("track://1", std::string("https://cdn/1"));
  });

  const auto resolved = gate.await(5'000);
  answerer.join();

  CHECK(resolved.has_value());
  CHECK_EQ(*resolved, std::string("https://cdn/1"));
  CHECK(!gate.open());
}

TEST(SourceResolution, gateTimesOutWithNoAnswer) {
  ResolutionGate gate;
  gate.begin("track://1");

  const auto start = std::chrono::steady_clock::now();
  const auto resolved = gate.await(20);
  const auto elapsed = std::chrono::steady_clock::now() - start;

  CHECK(!resolved.has_value());
  CHECK(elapsed >= std::chrono::milliseconds(15));
  CHECK(!gate.open());
}

TEST(SourceResolution, gateZeroTimeoutNeverWaits) {
  // `resolverTimeoutMs: 0` means "only the pre-warmed cache counts" — it must
  // not park the event thread for even one scheduling quantum.
  ResolutionGate gate;
  gate.begin("track://1");

  const auto start = std::chrono::steady_clock::now();
  const auto resolved = gate.await(0);
  const auto elapsed = std::chrono::steady_clock::now() - start;

  CHECK(!resolved.has_value());
  CHECK(elapsed < std::chrono::milliseconds(50));
}

TEST(SourceResolution, gateTreatsANullAnswerAsNoAnswer) {
  ResolutionGate gate;
  gate.begin("track://1");
  CHECK(gate.complete("track://1", std::nullopt));

  // Distinct from a timeout in *latency* only: the hook continues unrewritten
  // either way, which is what makes mpv fail on its own terms.
  CHECK(!gate.await(5'000).has_value());
}

TEST(SourceResolution, gateIgnoresAnAnswerForAnotherUrl) {
  // The normal case for a prefetch answer landing while a different entry is
  // being held at play time.
  ResolutionGate gate;
  gate.begin("track://1");

  CHECK(!gate.complete("track://2", std::string("https://cdn/2")));
  CHECK(!gate.await(20).has_value());
}

TEST(SourceResolution, gateIgnoresAnAnswerWithNoHoldOpen) {
  // Every prefetch answer looks like this: the hook was continued long ago and
  // only the cache write matters.
  ResolutionGate gate;
  CHECK(!gate.complete("track://1", std::string("https://cdn/1")));
}

TEST(SourceResolution, gateKeepsTheFirstAnswer) {
  ResolutionGate gate;
  gate.begin("track://1");

  CHECK(gate.complete("track://1", std::string("https://cdn/first")));
  CHECK(!gate.complete("track://1", std::string("https://cdn/second")));

  CHECK_EQ(*gate.await(5'000), std::string("https://cdn/first"));
}

TEST(SourceResolution, gateCancelReleasesTheHoldAndStaysUsable) {
  // `uninstallSourceResolver()` while a hook is parked.
  ResolutionGate gate;
  gate.begin("track://1");

  std::thread canceller([&gate]() {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    gate.cancel();
  });
  const auto resolved = gate.await(5'000);
  canceller.join();
  CHECK(!resolved.has_value());

  // Still usable — a resolver can be installed again.
  gate.begin("track://2");
  CHECK(gate.complete("track://2", std::string("https://cdn/2")));
  CHECK_EQ(*gate.await(5'000), std::string("https://cdn/2"));
}

TEST(SourceResolution, gateAbortReleasesTheHoldAndRefusesFutureOnes) {
  // `destroy()`: the event thread must not be waited out on the way down.
  ResolutionGate gate;
  gate.begin("track://1");

  std::thread aborter([&gate]() {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    gate.abort();
  });
  CHECK(!gate.await(5'000).has_value());
  aborter.join();

  gate.begin("track://2");
  const auto start = std::chrono::steady_clock::now();
  const auto resolved = gate.await(5'000);
  const auto elapsed = std::chrono::steady_clock::now() - start;
  CHECK(!resolved.has_value());
  CHECK(elapsed < std::chrono::milliseconds(500));
}

TEST(SourceResolution, gateSurvivesAnAnswerRacingTheWait) {
  // The answer can legitimately arrive between `begin()` and `await()`: the
  // request is emitted before the wait starts, and a synchronous resolver plus
  // a fast dispatcher can beat it back.
  for (int attempt = 0; attempt < 200; attempt++) {
    ResolutionGate gate;
    gate.begin("track://1");
    std::atomic<bool> go{false};
    std::thread answerer([&gate, &go]() {
      while (!go.load(std::memory_order_acquire)) {
      }
      gate.complete("track://1", std::string("https://cdn/1"));
    });
    go.store(true, std::memory_order_release);
    const auto resolved = gate.await(5'000);
    answerer.join();
    CHECK(resolved.has_value());
  }
}
