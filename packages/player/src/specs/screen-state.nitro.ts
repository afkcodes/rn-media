import type { HybridObject } from 'react-native-nitro-modules'

/**
 * Whether the device's display is currently on ("interactive"), and a
 * notification when that changes.
 *
 * @remarks
 * **Why this exists at all.** React Native's `AppState` answers a different
 * question — "is this app's Activity/Scene in the foreground" — and on Android
 * the two answers are not the same fact. A screen-off soak on a Poco F4 (MIUI,
 * charging) recorded `AppState` reporting `active` again **while the display
 * stayed off**: subscribed at 11:25, paused at 11:36 ("not in the foreground"),
 * *re-subscribed at 11:43 with the screen still off*, paused again at 11:53.
 * OEM lifecycle churn (a resumed Activity behind the keyguard, a doze/charging
 * overlay) flaps `AppState` for reasons that have nothing to do with whether a
 * frame can be seen — and while it says `active`, everything gated on it runs.
 * With the visualizer that measured **65-80 % of a core, drawing to a display
 * that was off**.
 *
 * `PowerManager.isInteractive()` plus `ACTION_SCREEN_ON`/`ACTION_SCREEN_OFF` is
 * the platform's own answer to "is the display on", and it is the one signal
 * MIUI cannot flap: it *is* the display state.
 *
 * **This is a device-global fact, so this object is a singleton** — one display
 * per device, exactly like audio focus is one focus per device (CLAUDE.md §5:
 * singletons only where the OS itself is singular). It lives in
 * `@timbre/player` rather than in `@timbre/audio-session` because its only
 * consumer is the player's visualizer, and a player-only install must not have
 * to pull in a second native module to stop burning battery.
 *
 * **iOS has nothing to implement.** Locking an iPhone (or the display
 * auto-sleeping) resigns the app's active state and moves it to the background,
 * which `AppState` reports as `'inactive'` then `'background'`. There is no iOS
 * state in which the app is foreground-active with the display off, and no
 * public API for the display's power state either — so the platform truth and
 * `AppState` agree by construction and the C++ implementation answers a
 * constant `true`. See the class comment on
 * `cpp/HybridRnMediaScreenState.hpp`.
 */
export interface RnMediaScreenState extends HybridObject<{
  android: 'kotlin'
  ios: 'c++'
}> {
  /**
   * `true` while the display is on.
   *
   * Android: `PowerManager.isInteractive()`. Note this is *display on*, not
   * *unlocked*: a device showing the lock screen is interactive, which is
   * correct — a lock-screen widget or an always-on surface can be presenting.
   *
   * iOS: always `true` (see the interface remarks).
   */
  readonly interactive: boolean

  /**
   * Observe display-state changes.
   *
   * @param onChange - Called with the new value on every transition, never for
   * the current one — read {@link interactive} for that.
   * @returns An id to hand back to {@link removeScreenStateListener}. Ids are
   * used rather than function identity for the reason
   * `@timbre/audio-session` documents: a Nitro callback is an opaque native
   * closure and cannot be compared across the bridge.
   *
   * @remarks
   * The native receiver is *derived from* the listener set — registered on the
   * first listener, unregistered on the last — so a process with nothing
   * observing the display holds no `BroadcastReceiver` at all.
   */
  addScreenStateListener(onChange: (interactive: boolean) => void): number
  /** Remove a listener added by {@link addScreenStateListener}. */
  removeScreenStateListener(listenerId: number): void
}
