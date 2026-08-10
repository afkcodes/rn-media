#pragma once

///
/// PcmTap.hpp — the visualizer engine: samples mpv's PCM tap on its own thread,
/// windows it, transforms it, and hands the spectrum to whoever is listening.
///
/// Pure std plus `Fft.hpp`: no mpv headers, no Nitro, no platform headers. mpv
/// is reached through the injected `TapSource`, which is what lets the whole
/// class be host-compiled and unit-tested (cpp/tests/PcmTapTests.cc) with a
/// fake source instead of a device.
///
/// =========================== WHY THERE IS A THREAD =========================
///
/// ARCHITECTURE §6 forbids polling for *state*, and rightly: state changes are
/// discrete and rare, so sampling them is both wasteful and lossy. A spectrum
/// display is the opposite kind of signal — it is a fixed-rate render of a
/// continuous one, and "30 frames per second" is the requirement, not a
/// compromise. So this samples on a timer, and the timer is a native thread
/// because a JS timer would (a) be on the thread we must not block and (b)
/// freeze outright in the background (Platform truths).
///
/// The rate the caller asks for is the *delivery* rate. New spectral content
/// arrives no faster than the audio device consumes chunks — measured at
/// ~20-45 Hz on Android, where `ao_audiotrack` writes one `getMinBufferSize()*2`
/// chunk at a time under `WRITE_BLOCKING`. Delivering faster than that is still
/// worth doing: the asymmetric EMA in the TypeScript layer is what turns a
/// stepped target into smooth motion, and it can only do that on frames it is
/// given. Ticks that find no new audio re-deliver the cached spectrum instead
/// of recomputing an identical FFT.
///
/// ============================= BACK PRESSURE ===============================
///
/// One frame in flight, newest wins. A tick that finds the previous frame still
/// unacknowledged by JS drops itself and counts it (`AnalysedFrame::dropped`)
/// rather than queueing — a stale spectrum has no value whatsoever, so there is
/// nothing to preserve. This is the same clock the event batch runs on (§6):
/// the JS completion promise is the pacing signal.
///

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "Fft.hpp"

namespace rnmedia {

/// Everything `PcmTap` needs from mpv, injected so this file never includes
/// `mpv/client.h`.
struct TapSource {
  /// Arm the tap for `frames` samples per channel, or disarm it with 0.
  /// Returns false when mpv has no `pcm-tap` property at all, i.e. the linked
  /// libmpv predates the rn-media patch.
  std::function<bool(int frames)> configure;

  /// Read the newest window into `out` as interleaved float32.
  /// Implementations must reuse `out`'s capacity — this runs up to 60 times a
  /// second. Returns false when nothing is available (disarmed, or no audio has
  /// reached the device yet).
  std::function<bool(std::vector<float>& out, int& channels, int& rate, std::int64_t& seq)> read;
};

/// One analysed window, ready to cross into JS. The byte vectors carry float32
/// in host order and are moved into Nitro `ArrayBuffer`s, never copied.
struct AnalysedFrame {
  /// `fftSize / 2 + 1` linear magnitudes, normalised so that a full-scale
  /// sinusoid lands on 1.0. dB mapping and band aggregation happen in
  /// TypeScript, per subscriber.
  std::vector<std::uint8_t> magnitudes;
  /// `fftSize` mono time-domain samples in [-1, 1], **unwindowed**. Empty
  /// unless the caller asked for it.
  std::vector<std::uint8_t> waveform;
  int fftSize = 0;
  int sampleRate = 0;
  /// `Date.now()`-comparable milliseconds, taken when the window was analysed.
  double capturedAt = 0.0;
  /// mpv's tap sequence number. Unchanged between frames means the device
  /// consumed no new audio; two frames with the same `seq` carry the same
  /// spectrum by construction.
  std::int64_t seq = 0;
  /// Ticks dropped since the previous delivery because JS had not finished
  /// with the last frame. Steady non-zero values mean the listener is too slow
  /// for the requested rate.
  int dropped = 0;
};

/// Bounds enforced by `start()`. The FFT size is additionally required to be a
/// power of two.
inline constexpr int kMinFftSize = 64;
inline constexpr int kMaxFftSize = 16384;
inline constexpr int kMinVisualizerFps = 1;
inline constexpr int kMaxVisualizerFps = 60;

class PcmTap final {
public:
  /// Invoked on the sampler thread. The implementation marshals to JS and must
  /// eventually call `onDeliveryComplete()` exactly once per invocation.
  using Deliver = std::function<void(AnalysedFrame&&)>;

  PcmTap(TapSource source, Deliver deliver);
  ~PcmTap();

  PcmTap(const PcmTap&) = delete;
  PcmTap& operator=(const PcmTap&) = delete;
  PcmTap(PcmTap&&) = delete;
  PcmTap& operator=(PcmTap&&) = delete;

  /// Arm mpv's tap and start sampling. Restarts cleanly if already running.
  ///
  /// @param fftSize Power of two in [kMinFftSize, kMaxFftSize].
  /// @param fps Delivery rate in [kMinVisualizerFps, kMaxVisualizerFps].
  /// @param waveform Also deliver time-domain samples.
  /// @throws std::invalid_argument on out-of-range parameters, and
  /// `std::runtime_error` tagged `[visualizer:unavailable]` when the linked
  /// libmpv has no PCM tap.
  void start(int fftSize, int fps, bool waveform);

  /// Stop sampling and disarm mpv's tap. Idempotent and never throws. Safe
  /// from any thread except the sampler thread itself — it joins, so a
  /// `Deliver` implementation must marshal rather than call back inline.
  void stop() noexcept;

  bool active() const noexcept {
    return _running.load(std::memory_order_acquire);
  }

  /// Acknowledge the frame handed to `Deliver`. Must be called exactly once per
  /// delivery, including when the delivery failed.
  void onDeliveryComplete() noexcept;

private:
  void run() noexcept;
  /// Builds one frame. Returns false when there is nothing to show at all.
  bool analyse(AnalysedFrame& out);
  void joinThread() noexcept;

  const TapSource _source;
  const Deliver _deliver;

  std::thread _thread;
  std::mutex _wakeMutex;
  std::condition_variable _wake;
  std::atomic<bool> _running{false};
  std::atomic<bool> _stopRequested{false};
  std::atomic<bool> _inFlight{false};
  std::atomic<int> _dropped{0};

  // Sampler-thread-only state below this line.
  int _fftSize = 0;
  int _fps = 0;
  bool _waveform = false;
  std::unique_ptr<Fft> _fft;
  std::vector<float> _window;   // Hann coefficients
  std::vector<float> _pcm;      // interleaved, as read from mpv
  std::vector<float> _mono;     // downmixed, unwindowed
  std::vector<float> _real;
  std::vector<float> _imag;
  std::vector<float> _magnitudes; // linear, `fftSize / 2 + 1` long
  /// The previous frame's magnitudes, re-sent verbatim when mpv reports the
  /// same `seq` — an identical window cannot produce a different spectrum.
  std::vector<std::uint8_t> _lastMagnitudes;
  std::int64_t _lastSeq = 0;
  /// `capturedAt` of the last frame whose `seq` actually moved, so a stalled
  /// device can be told apart from a merely slow one.
  double _lastAdvanceAt = 0.0;
};

} // namespace rnmedia
