#include "PcmTap.hpp"
#include "TestRunner.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

namespace {

constexpr double kTwoPi = 6.283185307179586476925286766559;

/// A `TapSource` that stands in for mpv: it hands back whatever PCM the test
/// puts in it, and records what the tap asked for. This is the whole reason
/// `PcmTap` takes an injected source — the engine, its threading and its
/// back-pressure are all exercised here with no device and no libmpv.
class FakeSource {
public:
  explicit FakeSource(bool supported = true) : _supported(supported) {}

  rnmedia::TapSource source() {
    return rnmedia::TapSource{
        .configure =
            [this](int frames) {
              std::lock_guard<std::mutex> lock(_mutex);
              _configured.push_back(frames);
              return _supported;
            },
        .read =
            [this](std::vector<float>& out, int& channels, int& rate, std::int64_t& seq) {
              std::lock_guard<std::mutex> lock(_mutex);
              _reads++;
              if (!_available) {
                return false;
              }
              out = _pcm;
              channels = _channels;
              rate = _rate;
              seq = _seq;
              return true;
            },
    };
  }

  void setPcm(std::vector<float> pcm, int channels, int rate) {
    std::lock_guard<std::mutex> lock(_mutex);
    _pcm = std::move(pcm);
    _channels = channels;
    _rate = rate;
    _available = true;
  }

  void advanceSeq() {
    std::lock_guard<std::mutex> lock(_mutex);
    _seq++;
  }

  void setAvailable(bool available) {
    std::lock_guard<std::mutex> lock(_mutex);
    _available = available;
  }

  std::vector<int> configured() {
    std::lock_guard<std::mutex> lock(_mutex);
    return _configured;
  }

  int reads() {
    std::lock_guard<std::mutex> lock(_mutex);
    return _reads;
  }

private:
  std::mutex _mutex;
  bool _supported;
  bool _available = false;
  std::vector<float> _pcm;
  int _channels = 2;
  int _rate = 48000;
  std::int64_t _seq = 1;
  std::vector<int> _configured;
  int _reads = 0;
};

/// Collects delivered frames and acknowledges each one, the way the Nitro glue
/// does once JavaScript has consumed it.
class FrameSink {
public:
  explicit FrameSink(bool autoAcknowledge = true) : _auto(autoAcknowledge) {}

  void bind(rnmedia::PcmTap* tap) {
    _tap = tap;
  }

  rnmedia::PcmTap::Deliver deliver() {
    return [this](rnmedia::AnalysedFrame&& frame) {
      {
        std::lock_guard<std::mutex> lock(_mutex);
        _frames.push_back(std::move(frame));
      }
      _arrived.notify_all();
      if (_auto && _tap != nullptr) {
        _tap->onDeliveryComplete();
      }
    };
  }

  /// Waits for at least `count` frames. Returns false on timeout, so a broken
  /// engine fails the test instead of hanging the suite.
  bool wait(std::size_t count, std::chrono::milliseconds timeout = std::chrono::milliseconds(3000)) {
    std::unique_lock<std::mutex> lock(_mutex);
    return _arrived.wait_for(lock, timeout, [&] { return _frames.size() >= count; });
  }

  std::vector<rnmedia::AnalysedFrame> frames() {
    std::lock_guard<std::mutex> lock(_mutex);
    return _frames;
  }

  std::size_t size() {
    std::lock_guard<std::mutex> lock(_mutex);
    return _frames.size();
  }

  void acknowledge() {
    if (_tap != nullptr) {
      _tap->onDeliveryComplete();
    }
  }

private:
  std::mutex _mutex;
  std::condition_variable _arrived;
  std::vector<rnmedia::AnalysedFrame> _frames;
  bool _auto;
  rnmedia::PcmTap* _tap = nullptr;
};

std::vector<float> interleavedSine(int frames, int channels, double bin, float amplitude) {
  std::vector<float> out(static_cast<std::size_t>(frames) * static_cast<std::size_t>(channels));
  for (int i = 0; i < frames; i++) {
    const float sample =
        amplitude * static_cast<float>(std::sin(kTwoPi * bin * static_cast<double>(i) / static_cast<double>(frames)));
    for (int c = 0; c < channels; c++) {
      out[static_cast<std::size_t>(i) * channels + c] = sample;
    }
  }
  return out;
}

std::vector<float> asFloats(const std::vector<std::uint8_t>& bytes) {
  std::vector<float> out(bytes.size() / sizeof(float));
  if (!out.empty()) {
    std::memcpy(out.data(), bytes.data(), out.size() * sizeof(float));
  }
  return out;
}

std::size_t argmax(const std::vector<float>& values) {
  std::size_t best = 0;
  for (std::size_t i = 1; i < values.size(); i++) {
    if (values[i] > values[best]) {
      best = i;
    }
  }
  return best;
}

TEST(PcmTap, rejects_an_fft_size_that_is_not_a_power_of_two) {
  FakeSource source;
  FrameSink sink;
  rnmedia::PcmTap tap(source.source(), sink.deliver());
  CHECK_THROWS(tap.start(1000, 30, false), std::invalid_argument);
  CHECK(!tap.active());
}

TEST(PcmTap, rejects_an_out_of_range_frame_rate) {
  FakeSource source;
  FrameSink sink;
  rnmedia::PcmTap tap(source.source(), sink.deliver());
  CHECK_THROWS(tap.start(1024, 0, false), std::invalid_argument);
  CHECK_THROWS(tap.start(1024, 120, false), std::invalid_argument);
  CHECK(!tap.active());
}

TEST(PcmTap, reports_an_unpatched_libmpv_as_unavailable) {
  // The one capability probe that matters: an older binary has no `pcm-tap`
  // property, and the failure must be typed rather than a silent dead display.
  FakeSource source(/* supported */ false);
  FrameSink sink;
  rnmedia::PcmTap tap(source.source(), sink.deliver());
  CHECK_THROWS(tap.start(1024, 30, false), std::runtime_error);
  CHECK(!tap.active());
}

TEST(PcmTap, arms_mpv_with_the_requested_window_and_disarms_on_stop) {
  FakeSource source;
  FrameSink sink;
  rnmedia::PcmTap tap(source.source(), sink.deliver());
  sink.bind(&tap);
  tap.start(512, 30, false);
  CHECK(tap.active());
  tap.stop();
  CHECK(!tap.active());

  const auto configured = source.configured();
  CHECK_EQ(configured.size(), std::size_t{2});
  CHECK_EQ(configured[0], 512);
  // Disarming is what makes the feature free when nobody is looking; if this
  // regresses, mpv keeps converting every device chunk forever.
  CHECK_EQ(configured[1], 0);
}

TEST(PcmTap, stop_is_idempotent_and_start_restarts_cleanly) {
  FakeSource source;
  FrameSink sink;
  rnmedia::PcmTap tap(source.source(), sink.deliver());
  sink.bind(&tap);
  tap.start(256, 30, false);
  tap.start(512, 60, false); // a second subscriber widening the union
  tap.stop();
  tap.stop();
  CHECK(!tap.active());

  const auto configured = source.configured();
  // arm(256) → disarm → arm(512) → disarm. The restart must disarm first, or
  // mpv would keep a ring sized for the previous subscriber.
  CHECK_EQ(configured.size(), std::size_t{4});
  CHECK_EQ(configured[0], 256);
  CHECK_EQ(configured[1], 0);
  CHECK_EQ(configured[2], 512);
  CHECK_EQ(configured[3], 0);
}

TEST(PcmTap, delivers_a_spectrum_whose_peak_is_the_tone_in_the_pcm) {
  FakeSource source;
  FrameSink sink;
  rnmedia::PcmTap tap(source.source(), sink.deliver());
  sink.bind(&tap);
  source.setPcm(interleavedSine(1024, 2, 32, 1.0F), 2, 48000);

  tap.start(1024, 60, false);
  CHECK(sink.wait(1));
  tap.stop();

  const auto frames = sink.frames();
  CHECK(!frames.empty());
  const auto& frame = frames.front();
  CHECK_EQ(frame.fftSize, 1024);
  CHECK_EQ(frame.sampleRate, 48000);
  const auto magnitudes = asFloats(frame.magnitudes);
  CHECK_EQ(magnitudes.size(), std::size_t{1024 / 2 + 1});
  const std::size_t peak = argmax(magnitudes);
  CHECK(peak >= 31 && peak <= 33);
  CHECK(magnitudes[peak] > 0.5F);
}

TEST(PcmTap, downmixes_channels_rather_than_reading_only_the_first) {
  // Two channels in antiphase must cancel: proof the downmix sums all channels
  // instead of taking channel 0 and calling it mono.
  FakeSource source;
  FrameSink sink;
  rnmedia::PcmTap tap(source.source(), sink.deliver());
  sink.bind(&tap);

  std::vector<float> pcm(512 * 2);
  for (int i = 0; i < 512; i++) {
    const float sample = static_cast<float>(std::sin(kTwoPi * 16.0 * i / 512.0));
    pcm[static_cast<std::size_t>(i) * 2] = sample;
    pcm[static_cast<std::size_t>(i) * 2 + 1] = -sample;
  }
  source.setPcm(pcm, 2, 44100);

  tap.start(512, 60, false);
  CHECK(sink.wait(1));
  tap.stop();

  for (const float value : asFloats(sink.frames().front().magnitudes)) {
    CHECK(value < 1e-4F);
  }
}

TEST(PcmTap, omits_the_waveform_unless_it_was_asked_for) {
  FakeSource source;
  FrameSink sink;
  rnmedia::PcmTap tap(source.source(), sink.deliver());
  sink.bind(&tap);
  source.setPcm(interleavedSine(256, 1, 8, 0.5F), 1, 44100);

  tap.start(256, 60, /* waveform */ false);
  CHECK(sink.wait(1));
  tap.stop();
  CHECK(sink.frames().front().waveform.empty());
}

TEST(PcmTap, delivers_mono_time_domain_samples_when_asked) {
  FakeSource source;
  FrameSink sink;
  rnmedia::PcmTap tap(source.source(), sink.deliver());
  sink.bind(&tap);
  source.setPcm(interleavedSine(256, 2, 8, 0.5F), 2, 44100);

  tap.start(256, 60, /* waveform */ true);
  CHECK(sink.wait(1));
  tap.stop();

  const auto waveform = asFloats(sink.frames().front().waveform);
  CHECK_EQ(waveform.size(), std::size_t{256});
  float peak = 0.0F;
  for (const float value : waveform) {
    peak = std::fmax(peak, std::fabs(value));
  }
  // Unwindowed: a 0.5 amplitude sine must still peak at ~0.5, not at a
  // window-tapered fraction of it.
  CHECK(peak > 0.45F && peak <= 0.51F);
}

TEST(PcmTap, zero_pads_a_window_the_tap_has_not_filled_yet) {
  // Right after `subscribe()` mpv's ring holds only a few milliseconds. The
  // newest samples must sit at the END of the window, or the spectrum would be
  // computed from data that is mostly stale silence in the wrong place.
  FakeSource source;
  FrameSink sink;
  rnmedia::PcmTap tap(source.source(), sink.deliver());
  sink.bind(&tap);
  std::vector<float> pcm(64, 0.25F); // 64 mono frames for a 512-point window
  source.setPcm(pcm, 1, 48000);

  tap.start(512, 60, /* waveform */ true);
  CHECK(sink.wait(1));
  tap.stop();

  const auto waveform = asFloats(sink.frames().front().waveform);
  CHECK_EQ(waveform.size(), std::size_t{512});
  CHECK(std::fabs(waveform[0]) < 1e-6F);
  CHECK(std::fabs(waveform[447]) < 1e-6F);
  CHECK(std::fabs(waveform[448] - 0.25F) < 1e-6F);
  CHECK(std::fabs(waveform[511] - 0.25F) < 1e-6F);
}

TEST(PcmTap, delivers_nothing_while_the_tap_has_no_audio) {
  FakeSource source;
  FrameSink sink;
  rnmedia::PcmTap tap(source.source(), sink.deliver());
  sink.bind(&tap);
  source.setAvailable(false);

  tap.start(256, 60, false);
  std::this_thread::sleep_for(std::chrono::milliseconds(120));
  tap.stop();

  CHECK_EQ(sink.size(), std::size_t{0});
  // It kept asking, though — a tap that stopped polling would never recover
  // when playback finally starts.
  CHECK(source.reads() > 0);
}

TEST(PcmTap, drops_ticks_instead_of_queueing_them_when_js_is_slow) {
  // Back-pressure: with no acknowledgement, exactly one frame may be in flight
  // and every later tick is dropped and counted.
  FakeSource source;
  FrameSink sink(/* autoAcknowledge */ false);
  rnmedia::PcmTap tap(source.source(), sink.deliver());
  sink.bind(&tap);
  source.setPcm(interleavedSine(256, 1, 8, 0.5F), 1, 44100);

  tap.start(256, 60, false);
  CHECK(sink.wait(1));
  std::this_thread::sleep_for(std::chrono::milliseconds(150));
  CHECK_EQ(sink.size(), std::size_t{1});

  // Release the slot; the next tick reports how many were skipped.
  sink.acknowledge();
  CHECK(sink.wait(2));
  tap.stop();

  const auto frames = sink.frames();
  CHECK_EQ(frames[0].dropped, 0);
  CHECK(frames[1].dropped > 0);
}

TEST(PcmTap, reuses_the_spectrum_while_mpv_reports_the_same_sequence) {
  // The device consumes chunks at ~20-45 Hz; delivering at 60 means most ticks
  // see the same samples. Those must not each pay for an FFT, and they must
  // carry the same spectrum — anything else would be noise in the display.
  FakeSource source;
  FrameSink sink;
  rnmedia::PcmTap tap(source.source(), sink.deliver());
  sink.bind(&tap);
  source.setPcm(interleavedSine(512, 1, 16, 0.8F), 1, 48000);

  tap.start(512, 60, false);
  CHECK(sink.wait(3));
  tap.stop();

  const auto frames = sink.frames();
  CHECK(frames.size() >= 3);
  CHECK(frames[0].magnitudes == frames[1].magnitudes);
  CHECK_EQ(frames[0].seq, frames[1].seq);
}

TEST(PcmTap, decays_to_silence_once_the_device_stops_consuming) {
  // A paused player must not leave the bars frozen mid-bounce. After the stall
  // window the tap reports zeros so the smoothing can settle to rest.
  FakeSource source;
  FrameSink sink;
  rnmedia::PcmTap tap(source.source(), sink.deliver());
  sink.bind(&tap);
  source.setPcm(interleavedSine(256, 1, 8, 1.0F), 1, 48000);

  tap.start(256, 60, false);
  CHECK(sink.wait(1));
  // kStallMs is 300 ms; wait comfortably past it with the sequence frozen.
  std::this_thread::sleep_for(std::chrono::milliseconds(450));
  tap.stop();

  const auto frames = sink.frames();
  CHECK(frames.size() >= 2);
  float firstPeak = 0.0F;
  for (const float value : asFloats(frames.front().magnitudes)) {
    firstPeak = std::fmax(firstPeak, value);
  }
  float lastPeak = 0.0F;
  for (const float value : asFloats(frames.back().magnitudes)) {
    lastPeak = std::fmax(lastPeak, value);
  }
  CHECK(firstPeak > 0.5F);
  CHECK(lastPeak < 1e-6F);
}

TEST(PcmTap, resumes_after_a_stall_when_the_sequence_advances_again) {
  FakeSource source;
  FrameSink sink;
  rnmedia::PcmTap tap(source.source(), sink.deliver());
  sink.bind(&tap);
  source.setPcm(interleavedSine(256, 1, 8, 1.0F), 1, 48000);

  tap.start(256, 60, false);
  CHECK(sink.wait(1));
  std::this_thread::sleep_for(std::chrono::milliseconds(400));
  const std::size_t stalledCount = sink.size();
  source.advanceSeq();
  CHECK(sink.wait(stalledCount + 2));
  tap.stop();

  float peak = 0.0F;
  for (const float value : asFloats(sink.frames().back().magnitudes)) {
    peak = std::fmax(peak, value);
  }
  CHECK(peak > 0.5F);
}

TEST(PcmTap, destructor_stops_the_sampler_thread) {
  FakeSource source;
  FrameSink sink;
  {
    rnmedia::PcmTap tap(source.source(), sink.deliver());
    sink.bind(&tap);
    source.setPcm(interleavedSine(256, 1, 8, 0.5F), 1, 44100);
    tap.start(256, 60, false);
    CHECK(sink.wait(1));
  }
  const auto configured = source.configured();
  CHECK(!configured.empty());
  CHECK_EQ(configured.back(), 0);
}

} // namespace
