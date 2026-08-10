#include "Fft.hpp"

#include <cmath>
#include <stdexcept>
#include <utility>

namespace rnmedia {

namespace {

constexpr double kTwoPi = 6.283185307179586476925286766559;

bool isPowerOfTwo(std::size_t value) noexcept {
  return value >= 2 && (value & (value - 1)) == 0;
}

} // namespace

Fft::Fft(std::size_t size) : _size(size) {
  if (!isPowerOfTwo(size)) {
    throw std::invalid_argument("Fft: size must be a power of two >= 2");
  }

  std::size_t bits = 0;
  while ((static_cast<std::size_t>(1) << bits) < size) {
    bits++;
  }

  _reversed.resize(size);
  for (std::size_t i = 0; i < size; i++) {
    std::uint32_t reversed = 0;
    for (std::size_t bit = 0; bit < bits; bit++) {
      if ((i >> bit) & 1U) {
        reversed |= static_cast<std::uint32_t>(1) << (bits - 1 - bit);
      }
    }
    _reversed[i] = reversed;
  }

  // One shared table instead of one per stage: stage `len` reads it with a
  // stride of `size / len`, which is exactly the sub-sampling the algorithm
  // wants and costs nothing.
  _cos.resize(size / 2);
  _sin.resize(size / 2);
  for (std::size_t i = 0; i < size / 2; i++) {
    const double angle = -kTwoPi * static_cast<double>(i) / static_cast<double>(size);
    _cos[i] = static_cast<float>(std::cos(angle));
    _sin[i] = static_cast<float>(std::sin(angle));
  }
}

void Fft::forward(float* real, float* imag) const noexcept {
  // Decimation in time: permute into bit-reversed order, then butterfly.
  for (std::size_t i = 0; i < _size; i++) {
    const std::size_t j = _reversed[i];
    if (j > i) {
      std::swap(real[i], real[j]);
      std::swap(imag[i], imag[j]);
    }
  }

  for (std::size_t len = 2; len <= _size; len <<= 1) {
    const std::size_t half = len >> 1;
    const std::size_t stride = _size / len;
    for (std::size_t base = 0; base < _size; base += len) {
      for (std::size_t k = 0; k < half; k++) {
        const float wr = _cos[k * stride];
        const float wi = _sin[k * stride];
        const std::size_t a = base + k;
        const std::size_t b = a + half;
        const float tr = real[b] * wr - imag[b] * wi;
        const float ti = real[b] * wi + imag[b] * wr;
        real[b] = real[a] - tr;
        imag[b] = imag[a] - ti;
        real[a] += tr;
        imag[a] += ti;
      }
    }
  }
}

void Fft::hann(float* out, std::size_t size) noexcept {
  if (size == 0) {
    return;
  }
  for (std::size_t i = 0; i < size; i++) {
    out[i] = static_cast<float>(0.5 - 0.5 * std::cos(kTwoPi * static_cast<double>(i) /
                                                     static_cast<double>(size)));
  }
}

} // namespace rnmedia
