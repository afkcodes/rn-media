#include "Fft.hpp"
#include "TestRunner.h"

#include <cmath>
#include <cstddef>
#include <stdexcept>
#include <vector>

namespace {

constexpr double kTwoPi = 6.283185307179586476925286766559;

bool near(float actual, float expected, float tolerance) {
  return std::fabs(actual - expected) <= tolerance;
}

/// One magnitude spectrum of `input`, normalised exactly the way `PcmTap` does
/// it — so these tests assert on the numbers the visualizer actually sees, not
/// on raw transform output.
std::vector<float> spectrumOf(const std::vector<float>& input, bool window) {
  const std::size_t n = input.size();
  rnmedia::Fft fft(n);
  std::vector<float> real(input);
  std::vector<float> imag(n, 0.0F);
  if (window) {
    std::vector<float> hann(n);
    rnmedia::Fft::hann(hann.data(), n);
    for (std::size_t i = 0; i < n; i++) {
      real[i] *= hann[i];
    }
  }
  fft.forward(real.data(), imag.data());

  const std::size_t bins = n / 2 + 1;
  const float gain = 2.0F / (static_cast<float>(n) * (window ? rnmedia::Fft::kHannCoherentGain : 1.0F));
  std::vector<float> out(bins);
  for (std::size_t k = 0; k < bins; k++) {
    const bool edge = (k == 0 || k == bins - 1);
    out[k] = std::hypot(real[k], imag[k]) * (edge ? gain * 0.5F : gain);
  }
  return out;
}

std::vector<float> sine(std::size_t n, double bin, float amplitude) {
  std::vector<float> out(n);
  for (std::size_t i = 0; i < n; i++) {
    out[i] = amplitude * static_cast<float>(std::sin(kTwoPi * bin * static_cast<double>(i) / static_cast<double>(n)));
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

TEST(Fft, rejects_sizes_that_are_not_powers_of_two) {
  CHECK_THROWS(rnmedia::Fft(1000), std::invalid_argument);
  CHECK_THROWS(rnmedia::Fft(0), std::invalid_argument);
  CHECK_THROWS(rnmedia::Fft(1), std::invalid_argument);
}

TEST(Fft, silence_transforms_to_silence) {
  const auto spectrum = spectrumOf(std::vector<float>(256, 0.0F), true);
  for (const float value : spectrum) {
    CHECK(near(value, 0.0F, 1e-6F));
  }
}

TEST(Fft, a_bin_centred_sine_lands_in_exactly_that_bin) {
  // Rectangular window on purpose: a sine completing a whole number of periods
  // is already periodic in the frame, so nothing leaks and the peak is exact.
  const auto spectrum = spectrumOf(sine(256, 8, 1.0F), false);
  CHECK_EQ(argmax(spectrum), std::size_t{8});
  // A full-scale sine reads 1.0. The whole dB mapping in TypeScript is
  // calibrated against this, so it is asserted rather than assumed.
  CHECK(near(spectrum[8], 1.0F, 1e-3F));
  CHECK(near(spectrum[7], 0.0F, 1e-3F));
  CHECK(near(spectrum[9], 0.0F, 1e-3F));
}

TEST(Fft, normalisation_is_linear_in_amplitude) {
  const auto half = spectrumOf(sine(512, 16, 0.5F), false);
  CHECK(near(half[16], 0.5F, 1e-3F));
  const auto quarter = spectrumOf(sine(512, 16, 0.25F), false);
  CHECK(near(quarter[16], 0.25F, 1e-3F));
}

TEST(Fft, hann_coherent_gain_keeps_a_windowed_sine_at_full_scale) {
  // Half a bin off centre — the worst case, and the realistic one. Without the
  // coherent-gain correction this would read ~0.5 and every level in the UI
  // would be 6 dB low.
  const auto spectrum = spectrumOf(sine(1024, 64.5, 1.0F), true);
  const std::size_t peak = argmax(spectrum);
  CHECK(peak == 64 || peak == 65);
  // Hann's worst-case scalloping loss is ~1.4 dB, so the peak sits a little
  // under 1.0 — nowhere near 0.5.
  CHECK(spectrum[peak] > 0.8F);
  CHECK(spectrum[peak] <= 1.05F);
}

TEST(Fft, hann_suppresses_leakage_far_from_the_tone) {
  const auto windowed = spectrumOf(sine(1024, 64.5, 1.0F), true);
  const auto rectangular = spectrumOf(sine(1024, 64.5, 1.0F), false);
  // 40 bins away, a rectangular window is still smearing the tone across the
  // whole spectrum. That difference is the difference between a visualizer that
  // shows a spectrum and one that shows a wall.
  CHECK(windowed[104] < rectangular[104] * 0.1F);
}

TEST(Fft, dc_lands_in_bin_zero) {
  const auto spectrum = spectrumOf(std::vector<float>(128, 0.5F), false);
  CHECK_EQ(argmax(spectrum), std::size_t{0});
  CHECK(near(spectrum[0], 0.5F, 1e-3F));
}

TEST(Fft, nyquist_lands_in_the_last_bin) {
  std::vector<float> alternating(128);
  for (std::size_t i = 0; i < alternating.size(); i++) {
    alternating[i] = (i % 2 == 0) ? 0.5F : -0.5F;
  }
  const auto spectrum = spectrumOf(alternating, false);
  CHECK_EQ(argmax(spectrum), spectrum.size() - 1);
  CHECK(near(spectrum.back(), 0.5F, 1e-3F));
}

TEST(Fft, is_linear_over_a_sum_of_tones) {
  const auto low = sine(512, 10, 0.4F);
  const auto high = sine(512, 100, 0.2F);
  std::vector<float> mixed(512, 0.0F);
  for (std::size_t i = 0; i < mixed.size(); i++) {
    mixed[i] = low[i] + high[i];
  }
  const auto spectrum = spectrumOf(mixed, false);
  CHECK(near(spectrum[10], 0.4F, 1e-3F));
  CHECK(near(spectrum[100], 0.2F, 1e-3F));
  CHECK(near(spectrum[50], 0.0F, 1e-3F));
}

TEST(Fft, hann_window_is_periodic_not_symmetric) {
  std::vector<float> window(8);
  rnmedia::Fft::hann(window.data(), window.size());
  // Periodic Hann starts at 0 and its centre is exactly 1; the symmetric
  // variant would put 1 between two samples instead.
  CHECK(near(window[0], 0.0F, 1e-6F));
  CHECK(near(window[4], 1.0F, 1e-6F));
  CHECK(near(window[2], 0.5F, 1e-6F));
  CHECK(near(window[6], 0.5F, 1e-6F));
}

} // namespace
