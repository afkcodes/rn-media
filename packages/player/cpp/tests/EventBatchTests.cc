///
/// Host tests for the batch buffer + coalescing rules that back the
/// "one batched callback per JS turn" contract in docs/specs/player-core.md §1.
///

#include "TestRunner.h"

#include "../EventBatch.hpp"

#include <atomic>
#include <string>
#include <thread>
#include <vector>

using rnmedia::EndFileReason;
using rnmedia::Event;
using rnmedia::EventBatch;
using rnmedia::EventKind;
using rnmedia::LogLevel;

namespace {

std::string propertyName(const Event& event) {
  return event.name;
}

double propertyNumber(const Event& event) {
  return std::get<double>(event.value);
}

std::string propertyString(const Event& event) {
  return std::get<std::string>(event.value);
}

} // namespace

// --------------------------------------------------------------------------
// Flush scheduling state machine
// --------------------------------------------------------------------------

TEST(EventBatch, FirstPushSchedulesFlushAndLaterPushesDoNot) {
  EventBatch batch;
  CHECK(batch.push(Event::discrete(EventKind::Seek)));
  CHECK(!batch.push(Event::discrete(EventKind::Seek)));
  CHECK(!batch.push(Event::discrete(EventKind::PlaybackRestart)));
  CHECK(batch.flushScheduled());
}

TEST(EventBatch, DrainKeepsFlushArmedSoConcurrentPushesDoNotRescheduleIt) {
  EventBatch batch;
  CHECK(batch.push(Event::discrete(EventKind::StartFile)));

  std::vector<Event> drained;
  batch.drain(drained);
  CHECK_EQ(drained.size(), std::size_t{1});
  CHECK(batch.flushScheduled());

  // Arrived while the flush was in flight: rides the *next* batch, does not
  // schedule a second one.
  CHECK(!batch.push(Event::discrete(EventKind::Seek)));
  CHECK(batch.endFlush()); // more work waiting

  batch.drain(drained);
  CHECK_EQ(drained.size(), std::size_t{1});
  CHECK_EQ(drained[0].kind, EventKind::Seek);
  CHECK(!batch.endFlush()); // now idle
  CHECK(!batch.flushScheduled());
}

TEST(EventBatch, EndFlushDisarmsSoTheNextPushSchedulesAgain) {
  EventBatch batch;
  CHECK(batch.push(Event::discrete(EventKind::Seek)));
  std::vector<Event> drained;
  batch.drain(drained);
  CHECK(!batch.endFlush());
  CHECK(batch.push(Event::discrete(EventKind::Seek)));
}

TEST(EventBatch, EndFlushReportsWorkWhenOnlyTombstonedEventsRemain) {
  // Two updates of the same property while a flush is in flight leave one live
  // event and one tombstone; endFlush must not be fooled by the raw size.
  EventBatch batch;
  CHECK(batch.push(Event::discrete(EventKind::Seek)));
  std::vector<Event> drained;
  batch.drain(drained);

  CHECK(!batch.push(Event::property("volume", 10.0)));
  CHECK(!batch.push(Event::property("volume", 20.0)));
  CHECK_EQ(batch.pendingCount(), std::size_t{1});
  CHECK(batch.endFlush());

  batch.drain(drained);
  CHECK_EQ(drained.size(), std::size_t{1});
  CHECK_EQ(propertyNumber(drained[0]), 20.0);
  CHECK(!batch.endFlush());
}

// --------------------------------------------------------------------------
// Coalescing
// --------------------------------------------------------------------------

TEST(EventBatch, PropertyEventsCoalesceByNameKeepingTheLatestValue) {
  EventBatch batch;
  batch.push(Event::property("time-pos", 1.0));
  batch.push(Event::property("time-pos", 2.0));
  batch.push(Event::property("time-pos", 3.0));

  std::vector<Event> drained;
  batch.drain(drained);
  CHECK_EQ(drained.size(), std::size_t{1});
  CHECK_EQ(propertyName(drained[0]), std::string("time-pos"));
  CHECK_EQ(propertyNumber(drained[0]), 3.0);
}

TEST(EventBatch, DifferentPropertiesDoNotCoalesceAndKeepFirstSeenOrder) {
  EventBatch batch;
  batch.push(Event::property("pause", true));
  batch.push(Event::property("duration", 120.0));
  batch.push(Event::property("volume", 80.0));

  std::vector<Event> drained;
  batch.drain(drained);
  CHECK_EQ(drained.size(), std::size_t{3});
  CHECK_EQ(propertyName(drained[0]), std::string("pause"));
  CHECK_EQ(propertyName(drained[1]), std::string("duration"));
  CHECK_EQ(propertyName(drained[2]), std::string("volume"));
}

TEST(EventBatch, DiscreteEventsNeverCoalesce) {
  EventBatch batch;
  batch.push(Event::discrete(EventKind::StartFile));
  batch.push(Event::discrete(EventKind::Seek));
  batch.push(Event::discrete(EventKind::Seek));
  batch.push(Event::discrete(EventKind::PlaybackRestart));
  batch.push(Event::endFile(EndFileReason::EndOfFile));
  batch.push(Event::endFile(EndFileReason::Error, "loading failed"));
  batch.push(Event::log(LogLevel::Warn, "ao", "device lost\n"));
  batch.push(Event::log(LogLevel::Warn, "ao", "device lost\n"));
  batch.push(Event::discrete(EventKind::Shutdown));

  std::vector<Event> drained;
  batch.drain(drained);
  CHECK_EQ(drained.size(), std::size_t{9});
  CHECK_EQ(drained[0].kind, EventKind::StartFile);
  CHECK_EQ(drained[1].kind, EventKind::Seek);
  CHECK_EQ(drained[2].kind, EventKind::Seek);
  CHECK_EQ(drained[3].kind, EventKind::PlaybackRestart);
  CHECK_EQ(drained[4].endFileReason, EndFileReason::EndOfFile);
  CHECK_EQ(drained[5].endFileReason, EndFileReason::Error);
  CHECK_EQ(drained[5].text, std::string("loading failed"));
  CHECK_EQ(drained[6].kind, EventKind::Log);
  CHECK_EQ(drained[7].kind, EventKind::Log);
  CHECK_EQ(drained[8].kind, EventKind::Shutdown);
}

TEST(EventBatch, CoalescedPropertyTakesTheLatestPositionNotTheOldest) {
  // Causality: `pause=true` then `end-file` then `pause=false` must NOT drain
  // as `pause=false, end-file` — the newest value happened after the end-file.
  EventBatch batch;
  batch.push(Event::property("pause", true));
  batch.push(Event::endFile(EndFileReason::EndOfFile));
  batch.push(Event::property("pause", false));

  std::vector<Event> drained;
  batch.drain(drained);
  CHECK_EQ(drained.size(), std::size_t{2});
  CHECK_EQ(drained[0].kind, EventKind::EndFile);
  CHECK_EQ(drained[1].kind, EventKind::Property);
  CHECK_EQ(std::get<bool>(drained[1].value), false);
}

TEST(EventBatch, CoalescingIsScopedToOneBatch) {
  EventBatch batch;
  batch.push(Event::property("pause", true));
  std::vector<Event> drained;
  batch.drain(drained);
  CHECK_EQ(drained.size(), std::size_t{1});
  batch.endFlush();

  // Same property again in the *next* batch must be delivered, not swallowed
  // by a stale index entry.
  batch.push(Event::property("pause", false));
  batch.drain(drained);
  CHECK_EQ(drained.size(), std::size_t{1});
  CHECK_EQ(std::get<bool>(drained[0].value), false);
}

TEST(EventBatch, UnavailablePropertyValueSurvivesCoalescing) {
  EventBatch batch;
  batch.push(Event::property("duration", 120.0));
  batch.push(Event::property("duration", std::monostate{}));

  std::vector<Event> drained;
  batch.drain(drained);
  CHECK_EQ(drained.size(), std::size_t{1});
  CHECK(std::holds_alternative<std::monostate>(drained[0].value));
}

TEST(EventBatch, StringPropertyValuesRoundTrip) {
  EventBatch batch;
  batch.push(Event::property("media-title", std::string("first")));
  batch.push(Event::property("media-title", std::string("second")));

  std::vector<Event> drained;
  batch.drain(drained);
  CHECK_EQ(drained.size(), std::size_t{1});
  CHECK_EQ(propertyString(drained[0]), std::string("second"));
}

// --------------------------------------------------------------------------
// Drain semantics
// --------------------------------------------------------------------------

TEST(EventBatch, DrainClearsTheOutputVectorBeforeFilling) {
  EventBatch batch;
  std::vector<Event> drained;
  drained.push_back(Event::discrete(EventKind::Shutdown));

  batch.push(Event::discrete(EventKind::Seek));
  batch.drain(drained);
  CHECK_EQ(drained.size(), std::size_t{1});
  CHECK_EQ(drained[0].kind, EventKind::Seek);
}

TEST(EventBatch, DrainOnAnEmptyBatchYieldsNothing) {
  EventBatch batch;
  std::vector<Event> drained;
  batch.drain(drained);
  CHECK(drained.empty());
  CHECK(!batch.endFlush());
}

TEST(EventBatch, DrainReusesCapacityAcrossFlushes) {
  EventBatch batch;
  std::vector<Event> drained;
  for (int i = 0; i < 64; ++i) {
    batch.push(Event::discrete(EventKind::Seek));
  }
  batch.drain(drained);
  const auto capacityAfterBigBatch = drained.capacity();
  batch.endFlush();

  batch.push(Event::discrete(EventKind::Seek));
  batch.drain(drained);
  CHECK_EQ(drained.size(), std::size_t{1});
  CHECK_EQ(drained.capacity(), capacityAfterBigBatch); // no shrink, no realloc
}

TEST(EventBatch, ResetDropsEverythingAndDisarms) {
  EventBatch batch;
  CHECK(batch.push(Event::property("pause", true)));
  batch.push(Event::discrete(EventKind::Seek));
  batch.reset();

  CHECK(!batch.flushScheduled());
  CHECK_EQ(batch.pendingCount(), std::size_t{0});
  std::vector<Event> drained;
  batch.drain(drained);
  CHECK(drained.empty());
  // Fully reusable afterwards, including the property index.
  CHECK(batch.push(Event::property("pause", false)));
  batch.drain(drained);
  CHECK_EQ(drained.size(), std::size_t{1});
}

// --------------------------------------------------------------------------
// Concurrency
// --------------------------------------------------------------------------

TEST(EventBatch, ProducerAndConsumerNeverLoseAWakeup) {
  // Mirrors the real topology: one producer (mpv event thread) pushing
  // discrete events, one consumer running the schedule/drain/endFlush cycle.
  // Every event must come out exactly once, and the batch must end idle.
  constexpr int kEventCount = 20000;
  EventBatch batch;
  std::atomic<int> scheduled{0};
  std::atomic<bool> producing{true};

  std::thread producer([&]() {
    for (int i = 0; i < kEventCount; ++i) {
      if (batch.push(Event::discrete(EventKind::Seek))) {
        scheduled.fetch_add(1, std::memory_order_relaxed);
      }
    }
    producing.store(false, std::memory_order_release);
  });

  int consumed = 0;
  std::vector<Event> drained;
  while (producing.load(std::memory_order_acquire) || batch.pendingCount() > 0 || batch.flushScheduled()) {
    if (!batch.flushScheduled()) {
      std::this_thread::yield();
      continue;
    }
    do {
      batch.drain(drained);
      consumed += static_cast<int>(drained.size());
    } while (batch.endFlush());
  }
  producer.join();

  // Anything the producer pushed after the last endFlush is still pending.
  do {
    batch.drain(drained);
    consumed += static_cast<int>(drained.size());
  } while (batch.endFlush());

  CHECK_EQ(consumed, kEventCount);
  CHECK(!batch.flushScheduled());
  CHECK(scheduled.load() >= 1);
}
