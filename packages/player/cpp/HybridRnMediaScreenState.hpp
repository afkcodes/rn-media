#pragma once

///
/// HybridRnMediaScreenState.hpp — the iOS half of the display-state signal.
///
/// ### Why iOS needs no implementation
/// The signal exists because Android's `AppState` and "is the display on" are
/// two different facts (see `src/specs/screen-state.nitro.ts` for the measured
/// MIUI flap that made this necessary). On iOS they are the *same* fact, by
/// construction:
///
///  - Locking the device (or the display auto-sleeping) resigns the app's
///    active state and moves it to the background — `UIApplication` posts
///    `willResignActive` then `didEnterBackground`, which is exactly what React
///    Native's `AppState` reports as `'inactive'` then `'background'`.
///  - There is no iOS state in which the app is foreground-*active* while the
///    display is off, and no OEM lifecycle policy in between that could flap the
///    answer, because there are no OEMs. (An audio app does keep *running* in
///    the background — that is the whole point of the audio background mode —
///    which is exactly why the hook has to gate on something; on iOS
///    `AppState` is a sufficient something.)
///  - There is no public API for the display's power state anyway. `UIScreen`
///    exposes brightness, not on/off, and neither
///    `UIApplication.protectedDataAvailable` nor
///    `UIScreen.captured`/`isIdleTimerDisabled` means "screen on".
///
/// So the honest implementation is a constant `true` plus a listener registry
/// that never fires: the caller ANDs this with `AppState`, and on iOS
/// `AppState` alone is already the truth. Answering `false` would be a lie, and
/// pretending to observe would be a lie with a timer attached.
///
/// It is C++ rather than Swift deliberately — `@timbre/player` ships no Swift
/// today, and a constant does not justify introducing a Swift compilation unit
/// (and its bridging header) into the pod.
///

#include <cstdint>
#include <functional>

#include "HybridRnMediaScreenStateSpec.hpp"

namespace margelo::nitro::rnmediaplayer {

class HybridRnMediaScreenState final : public HybridRnMediaScreenStateSpec {
public:
  HybridRnMediaScreenState() : HybridObject(TAG) {}

  /// Always `true`: an iOS app whose display has gone dark is not running JS at
  /// all. See the file comment.
  bool getInteractive() override {
    return true;
  }

  /// Accepted and never called. The ids are still distinct so that a caller
  /// which round-trips one through `removeScreenStateListener` behaves
  /// identically on both platforms.
  double addScreenStateListener(const std::function<void(bool /* interactive */)>& /* onChange */) override {
    return static_cast<double>(_nextListenerId++);
  }

  void removeScreenStateListener(double /* listenerId */) override {}

private:
  /// JS-thread confined (Nitro sync methods run on the caller's thread, which
  /// for this object is always JS), so a plain counter needs no atomic.
  std::uint64_t _nextListenerId = 1;
};

} // namespace margelo::nitro::rnmediaplayer
