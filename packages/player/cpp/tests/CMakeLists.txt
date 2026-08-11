#
# Host-compiled unit tests for the parts of the player core that do not touch
# libmpv or Nitro: `EventBatch.hpp` (batching + coalescing), `ClientState.hpp`
# (the disposed-state machine), `Fft` (the visualizer transform), `PcmTap`
# (the visualizer engine — its threading, back-pressure and DSP, driven by a
# fake `TapSource` in place of mpv) and `SourceResolution.hpp` (the resolved-URL
# cache and the play-time hook hold, on an injected clock).
#
# Deliberately does NOT link libmpv — those units are pure std by design, which
# is what makes them testable on a dev machine with no device and no NDK.
#
# NOTE ON FILE EXTENSIONS: the test sources are `.cc`/`.h`, not `.cpp`/`.hpp`,
# on purpose. `RnMediaPlayer.podspec` compiles `cpp/**/*.{hpp,cpp}` into the
# iOS pod, so a test file named `.cpp` would be built into the shipped library
# (and would collide on `main`). `.cc`/`.h` fall outside that glob, which keeps
# the tests out of the product without touching the podspec. If the podspec
# ever gains an explicit `exclude_files` entry for `cpp/tests/**/*`, these can
# be renamed back.
#
# Usage:
#   cmake -S packages/player/cpp/tests -B packages/player/cpp/tests/build
#   cmake --build packages/player/cpp/tests/build
#   ctest --test-dir packages/player/cpp/tests/build --output-on-failure
#
cmake_minimum_required(VERSION 3.16)
project(RnMediaPlayerCoreTests CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(Threads REQUIRED)

add_executable(player_core_tests
  main.cc
  EventBatchTests.cc
  ClientStateTests.cc
  FftTests.cc
  PcmTapTests.cc
  SourceResolutionTests.cc
  ../Fft.cpp
  ../PcmTap.cpp
)

target_include_directories(player_core_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/..)
target_link_libraries(player_core_tests PRIVATE Threads::Threads)
target_compile_options(player_core_tests PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()
# One ctest entry per suite; the argument is the substring `main()` filters on.
add_test(NAME EventBatch COMMAND player_core_tests EventBatch)
add_test(NAME ClientState COMMAND player_core_tests ClientState)
add_test(NAME Fft COMMAND player_core_tests Fft)
add_test(NAME PcmTap COMMAND player_core_tests PcmTap)
add_test(NAME SourceResolution COMMAND player_core_tests SourceResolution)
