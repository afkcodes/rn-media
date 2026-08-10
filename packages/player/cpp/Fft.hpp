#pragma once

///
/// Fft.hpp — a radix-2 complex FFT with everything precomputed.
///
/// Pure std: no mpv, no Nitro, no platform headers, so it is host-compiled and
/// unit-tested (cpp/tests/FftTests.cc) rather than guessed at on a device.
///
/// The visualizer runs this up to 60 times a second on the sampler thread, so
/// the shape is dictated by one rule: **no allocation and no transcendental
/// call per frame**. The bit-reversal permutation and the twiddle table are
/// built once in the constructor; `forward()` only reads them.
///
/// Why plain radix-2 and not a real-input (`rfft`) split, or a vendored
/// library: a 2048-point transform is ~11 stages × 1024 butterflies ≈ 135 k
/// flops, which is ~8 Mflop/s at 60 fps — far below the point where the extra
/// factor of two would be worth either the algebra or a dependency. If it ever
/// is, the seam is `forward()` and nothing above it changes.
///

#include <cstddef>
#include <cstdint>
#include <vector>

namespace rnmedia {

/// In-place complex FFT of a fixed, power-of-two size.
///
/// Not thread-safe to *construct* concurrently with use, but `forward()` is
/// `const` and touches no member state, so one instance can serve many
/// threads. The visualizer uses exactly one.
class Fft final {
public:
  /// @param size Transform length. Must be a power of two and >= 2; anything
  /// else throws `std::invalid_argument` (a silently-wrong FFT is worse than a
  /// crash at construction).
  explicit Fft(std::size_t size);

  std::size_t size() const noexcept {
    return _size;
  }

  /// Transforms `real`/`imag` in place. Both arrays must be `size()` long.
  void forward(float* real, float* imag) const noexcept;

  /// Fills `out[0 .. size]` with a periodic Hann window.
  ///
  /// Periodic (`/ N`) rather than symmetric (`/ (N - 1)`): this window is used
  /// for spectral analysis of a continuous signal, not for filter design, and
  /// the periodic form is the one whose bins land where the maths says they do.
  static void hann(float* out, std::size_t size) noexcept;

  /// Coherent gain of the Hann window — the factor by which it attenuates a
  /// sinusoid's amplitude. Exported because the magnitude normalisation has to
  /// divide it back out, and a magic `0.5` at the call site would be a riddle.
  static constexpr float kHannCoherentGain = 0.5F;

private:
  std::size_t _size;
  /// `_reversed[i]` is `i` with its `log2(size)` bits reversed.
  std::vector<std::uint32_t> _reversed;
  /// `cos`/`sin` of `-2*pi*k/size` for `k < size/2`, shared by every stage.
  std::vector<float> _cos;
  std::vector<float> _sin;
};

} // namespace rnmedia
