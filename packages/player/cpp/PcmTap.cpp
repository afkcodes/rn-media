#include "PcmTap.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <stdexcept>

namespace rnmedia {

namespace {

/// How long mpv's tap sequence may stand still before the device is treated as
/// stopped rather than merely slow.
///
/// It has to clear the slowest realistic chunk period: `ao_audiotrack` writes
/// one `AudioTrack.getMinBufferSize() * 2` chunk per iteration under
/// WRITE_BLOCKING, which measures ~23-45 ms on current devices. 300 ms is an
/// order of magnitude above that and still fast enough that a pause reads as
/// immediate — below it, a slow device would blink to silence between chunks.
constexpr double kStallMs = 300.0;

double nowMs() noexcept {
  using namespace std::chrono;
  return duration<double, std::milli>(system_clock::now().time_since_epoch()).count();
}

bool isPowerOfTwo(int value) noexcept {
  return value >= 2 && (value & (value - 1)) == 0;
}

/// Copies `count` floats into a fresh byte vector. The extra memcpy (4 KB at a
/// 2048-point transform) buys strict aliasing/alignment correctness over
/// reinterpret_cast'ing a `vector<uint8_t>`'s storage, which is not free to do
/// portably and is not worth arguing about at this size.
std::vector<std::uint8_t> toBytes(const float* data, std::size_t count) {
  std::vector<std::uint8_t> out(count * sizeof(float));
  if (count > 0) {
    std::memcpy(out.data(), data, count * sizeof(float));
  }
  return out;
}

} // namespace

PcmTap::PcmTap(TapSource source, Deliver deliver)
    : _source(std::move(source)), _deliver(std::move(deliver)) {}

PcmTap::~PcmTap() {
  stop();
}

void PcmTap::start(int fftSize, int fps, bool waveform) {
  if (!isPowerOfTwo(fftSize) || fftSize < kMinFftSize || fftSize > kMaxFftSize) {
    throw std::invalid_argument("PcmTap: fftSize must be a power of two in [" +
                                std::to_string(kMinFftSize) + ", " + std::to_string(kMaxFftSize) + "]");
  }
  if (fps < kMinVisualizerFps || fps > kMaxVisualizerFps) {
    throw std::invalid_argument("PcmTap: fps must be in [" + std::to_string(kMinVisualizerFps) + ", " +
                                std::to_string(kMaxVisualizerFps) + "]");
  }

  // Restart rather than reject: `subscribe()` resolves the union of every
  // subscriber's native parameters and re-applies it, so a second subscriber
  // asking for a bigger window arrives here while the first is still running.
  stop();

  if (!_source.configure(fftSize)) {
    throw std::runtime_error(
        "[visualizer:unavailable] this libmpv has no PCM tap. The visualizer needs a libmpv built "
        "from the rn-media forks (Android >= v1.1.9-rnmedia.3, iOS >= v0.7.2-rnmedia.3), which add "
        "the `pcm-tap` property.");
  }

  _fftSize = fftSize;
  _fps = fps;
  _waveform = waveform;
  _fft = std::make_unique<Fft>(static_cast<std::size_t>(fftSize));

  // Every buffer the sampler thread touches is sized once, here, so the hot
  // path allocates nothing except the two vectors it hands to JS.
  _window.resize(static_cast<std::size_t>(fftSize));
  Fft::hann(_window.data(), _window.size());
  _mono.assign(static_cast<std::size_t>(fftSize), 0.0F);
  _real.assign(static_cast<std::size_t>(fftSize), 0.0F);
  _imag.assign(static_cast<std::size_t>(fftSize), 0.0F);
  _magnitudes.assign(static_cast<std::size_t>(fftSize) / 2 + 1, 0.0F);
  _pcm.clear();
  _lastMagnitudes.clear();
  _lastSeq = 0;
  _lastAdvanceAt = 0.0;

  _dropped.store(0, std::memory_order_relaxed);
  _inFlight.store(false, std::memory_order_release);
  _stopRequested.store(false, std::memory_order_release);
  _running.store(true, std::memory_order_release);
  _thread = std::thread([this] { run(); });
}

void PcmTap::stop() noexcept {
  const bool wasRunning = _running.exchange(false, std::memory_order_acq_rel);
  {
    std::lock_guard<std::mutex> lock(_wakeMutex);
    _stopRequested.store(true, std::memory_order_release);
  }
  _wake.notify_all();
  joinThread();

  if (wasRunning) {
    // Disarm mpv last: after the sampler thread is gone, so nothing can re-read
    // a tap we just released. A throw here would come from a destroyed client,
    // which is exactly the case where there is nothing left to disarm.
    try {
      _source.configure(0);
    } catch (...) {
    }
  }
  _inFlight.store(false, std::memory_order_release);
}

void PcmTap::onDeliveryComplete() noexcept {
  _inFlight.store(false, std::memory_order_release);
}

void PcmTap::joinThread() noexcept {
  if (_thread.joinable()) {
    _thread.join();
  }
}

void PcmTap::run() noexcept {
  using clock = std::chrono::steady_clock;
  const auto interval = std::chrono::nanoseconds(1'000'000'000LL / _fps);
  auto next = clock::now() + interval;

  for (;;) {
    {
      std::unique_lock<std::mutex> lock(_wakeMutex);
      _wake.wait_until(lock, next, [this] { return _stopRequested.load(std::memory_order_acquire); });
      if (_stopRequested.load(std::memory_order_acquire)) {
        return;
      }
    }

    next += interval;
    const auto now = clock::now();
    if (next < now) {
      // Fell behind (a long GC, a suspended process). Re-base instead of
      // firing a burst of catch-up ticks nobody wants to see.
      next = now + interval;
    }

    if (_inFlight.load(std::memory_order_acquire)) {
      _dropped.fetch_add(1, std::memory_order_relaxed);
      continue;
    }

    AnalysedFrame frame;
    try {
      if (!analyse(frame)) {
        continue;
      }
    } catch (...) {
      // The client was destroyed underneath us. Stopping the loop is the only
      // sane response; `stop()` from the owner will tidy up the rest.
      return;
    }
    frame.dropped = _dropped.exchange(0, std::memory_order_relaxed);

    _inFlight.store(true, std::memory_order_release);
    _deliver(std::move(frame));
  }
}

bool PcmTap::analyse(AnalysedFrame& out) {
  int channels = 0;
  int rate = 0;
  std::int64_t seq = 0;
  if (!_source.read(_pcm, channels, rate, seq) || channels <= 0 || rate <= 0) {
    return false;
  }

  const double now = nowMs();
  const int available = static_cast<int>(_pcm.size() / static_cast<std::size_t>(channels));
  const int used = std::min(available, _fftSize);
  if (used <= 0) {
    return false;
  }

  // Downmix the newest `used` frames to mono, right-aligned in the window so a
  // partially-filled tap zero-pads its *past* rather than its present.
  std::fill(_mono.begin(), _mono.end(), 0.0F);
  const std::size_t offset = static_cast<std::size_t>(_fftSize - used);
  const std::size_t first = static_cast<std::size_t>(available - used) * static_cast<std::size_t>(channels);
  const float scale = 1.0F / static_cast<float>(channels);
  for (int i = 0; i < used; i++) {
    const float* frame = _pcm.data() + first + static_cast<std::size_t>(i) * static_cast<std::size_t>(channels);
    float sum = 0.0F;
    for (int c = 0; c < channels; c++) {
      sum += frame[c];
    }
    _mono[offset + static_cast<std::size_t>(i)] = sum * scale;
  }

  const bool advanced = seq != _lastSeq;
  if (advanced || _lastMagnitudes.empty()) {
    std::copy(_mono.begin(), _mono.end(), _real.begin());
    for (std::size_t i = 0; i < _real.size(); i++) {
      _real[i] *= _window[i];
    }
    std::fill(_imag.begin(), _imag.end(), 0.0F);
    _fft->forward(_real.data(), _imag.data());

    // Normalised so a full-scale sinusoid reads 1.0: the transform spreads a
    // real sinusoid's amplitude over the positive and negative frequency, and
    // the Hann window costs its coherent gain — hence 2 / (N * gain). DC and
    // Nyquist have no mirror image, so they take half of that.
    const float gain = 2.0F / (static_cast<float>(_fftSize) * Fft::kHannCoherentGain);
    const std::size_t bins = _magnitudes.size();
    for (std::size_t k = 0; k < bins; k++) {
      const float magnitude = std::hypot(_real[k], _imag[k]);
      const bool edge = (k == 0 || k == bins - 1);
      _magnitudes[k] = magnitude * (edge ? gain * 0.5F : gain);
    }
    _lastMagnitudes = toBytes(_magnitudes.data(), bins);
    _lastSeq = seq;
    _lastAdvanceAt = now;
  } else if (now - _lastAdvanceAt > kStallMs) {
    // The device has consumed nothing for long enough that this is a pause, not
    // a slow chunk. Report silence so the smoothing decays the display to rest
    // instead of freezing it mid-bounce.
    std::fill(_lastMagnitudes.begin(), _lastMagnitudes.end(), std::uint8_t{0});
    std::fill(_mono.begin(), _mono.end(), 0.0F);
  }

  out.magnitudes = _lastMagnitudes;
  if (_waveform) {
    out.waveform = toBytes(_mono.data(), _mono.size());
  }
  out.fftSize = _fftSize;
  out.sampleRate = rate;
  out.capturedAt = now;
  out.seq = seq;
  return true;
}

} // namespace rnmedia
