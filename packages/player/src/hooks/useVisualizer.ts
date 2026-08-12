import { useEffect, useRef, useState } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import type { Player } from '../player'
import type { PlayerError } from '../errors'
import { toVisualizerError } from '../errors'
import { getScreenStateSource } from '../screen-state'
import type { VisualizerFrame, VisualizerOptions } from '../visualizer'

/**
 * Whether an `AppState` value means there is a screen that can actually show a
 * frame.
 *
 * `'unknown'` — and the `null` the Android implementation really holds before
 * its first lifecycle callback, which the type does not admit to — deliberately
 * count as foreground. A hook that is mounting has a UI, and refusing to start
 * on an indeterminate value would strand the visualizer until the next
 * `AppState` change, which on Android is the *next* time the user leaves.
 */
function isForeground(status: AppStateStatus | null | undefined): boolean {
  return status !== 'background' && status !== 'inactive'
}

/** What {@link useVisualizer} returns. */
export interface UseVisualizerResult {
  /**
   * The newest frame, or `undefined` before the first one arrives (and after
   * an error).
   *
   * @remarks
   * The same `VisualizerFrame` object is never mutated in place — each frame is
   * a fresh snapshot — so it is safe to hold, compare by identity, and pass to
   * a memoised child.
   */
  readonly frame: VisualizerFrame | undefined
  /**
   * Why the subscription failed, or `undefined` while it is healthy.
   *
   * `code: 'unsupported'` means the linked libmpv has no PCM tap — it predates
   * the rn-media forks that add it (Android `v1.1.9-rnmedia.3`+, iOS
   * `v0.7.2-rnmedia.3`+). There is no permission failure to handle: tapping mpv
   * needs none, on either platform.
   */
  readonly error: PlayerError | undefined
  /**
   * Whether a subscription is currently live.
   *
   * This is `false` while the app is not in the foreground **or** the device's
   * display is off (unless `pauseWhenInactive` was turned off) — a paused
   * visualizer is genuinely not subscribed, not merely ignored.
   */
  readonly active: boolean
}

/**
 * Subscribe a component to the player's visualizer for as long as it is
 * mounted.
 *
 * @param player - The player to tap, or `undefined`/`null` while one is still
 * being created (the hook then does nothing, which keeps it usable directly
 * with `usePlayer()`'s result).
 * @param options - Per-subscriber tuning; see {@link VisualizerOptions}.
 * @param enabled - Set `false` to drop the subscription without unmounting —
 * e.g. while the visualizer is off screen. Defaults to `true`.
 * @param pauseWhenInactive - Drop the subscription whenever the app leaves the
 * foreground **or the device's display goes off**, and take it back when both
 * are true again. **Defaults to `true`**, and should stay that way; see below.
 * @returns The newest {@link VisualizerFrame}, plus any typed error.
 *
 * @remarks
 * **This re-renders at the frame rate** (up to `options.fps`, itself capped by
 * the device's ~20 Hz). That is the point of the hook, but it means the
 * component using it should be a small leaf that paints bars and nothing else.
 * For anything heavier, subscribe imperatively with
 * `player.visualizer.subscribe()` and drive an animated value instead of React
 * state.
 *
 * Unsubscribing is what releases the platform effect, so unmounting (or
 * flipping `enabled` to `false`) genuinely returns the audio framework to its
 * idle state — there is no hidden capture left running.
 *
 * **Why `pauseWhenInactive` defaults to on.** The frames are native callbacks,
 * so unlike a JS timer they do *not* freeze when the app goes to the
 * background — the sampler thread keeps delivering and this hook keeps calling
 * `setState`, at up to 60 Hz, against a display that cannot present anything.
 * Left alone through a long screen-off that is tens of thousands of pointless
 * renders and a matching amount of CPU and battery spent drawing to nobody, and
 * the app is busy working through them at the moment the user unlocks. Pausing
 * costs nothing while visible and removes the whole class of problem: because
 * the native tap is *derived from* the listener set, dropping the subscription
 * disarms mpv's ring and stops the sampler thread outright.
 *
 * **Why the gate is two signals, not one.** `AppState` alone is not enough on
 * Android, and the failure is not theoretical: a screen-off soak on a Poco F4
 * (MIUI, charging) recorded `AppState` reporting the app foreground again
 * *while the display stayed off* — subscribed 11:25, paused 11:36, **re-subscribed
 * 11:43 with the screen still off**, paused 11:53 — and the visualizer burned
 * 65-80 % of a core in the window it was wrongly awake. So the hook ANDs
 * `AppState` with the platform's own display state
 * (`ScreenStateSource` — `PowerManager.isInteractive()` +
 * `ACTION_SCREEN_ON`/`OFF` on Android): **either** signal saying "inactive"
 * pauses, and **both** must say "active" to resume. On iOS the second signal is
 * a constant `true` and that is correct — locking an iPhone resigns the app's
 * active state and backgrounds it, and there is no iOS state where the app is
 * foreground-active with the display off, so `AppState` is already the display
 * truth there.
 *
 * **Audio is untouched by this.** Only the visual feed pauses; playback,
 * the media session and everything else keep running in the background exactly
 * as before.
 *
 * On resume the same `options` are used, so nothing has to be re-plumbed — but
 * the subscription is a *new* one, which means smoothing, peak caps and
 * auto-gain start from rest and {@link UseVisualizerResult.frame} is
 * `undefined` for a frame or two. Bars come back up from zero rather than
 * continuing mid-bounce.
 *
 * Set it to `false` only for a surface that is genuinely painting while
 * inactive (a Live Activity, a widget, an external display). For a non-UI
 * consumer, the escape hatch is `player.visualizer.subscribe()` directly: the
 * imperative API is never `AppState`-gated, and never has been.
 *
 * @example
 * ```tsx
 * function Bars({ player }: { player: Player }) {
 *   const { frame, error } = useVisualizer(player, { bands: 24 })
 *   if (error) return <Text>{error.message}</Text>
 *   return (
 *     <View style={{ flexDirection: 'row' }}>
 *       {Array.from(frame?.bands ?? []).map((value, i) => (
 *         <View key={i} style={{ height: 4 + value * 60, width: 6 }} />
 *       ))}
 *     </View>
 *   )
 * }
 * ```
 */
export function useVisualizer(
  player: Player | undefined | null,
  options?: VisualizerOptions,
  enabled = true,
  pauseWhenInactive = true
): UseVisualizerResult {
  const [frame, setFrame] = useState<VisualizerFrame | undefined>(undefined)
  const [error, setError] = useState<PlayerError | undefined>(undefined)
  const [active, setActive] = useState(false)
  const [foreground, setForeground] = useState(() =>
    pauseWhenInactive ? isForeground(AppState.currentState) : true
  )
  const [screenOn, setScreenOn] = useState(() =>
    pauseWhenInactive ? getScreenStateSource().interactive : true
  )

  // Options are compared by value, not identity: callers overwhelmingly pass an
  // object literal, and keying the effect on identity would tear the native
  // capture down and rebuild it on **every render**.
  const key = JSON.stringify(options ?? {})
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    if (!pauseWhenInactive) {
      setForeground(true)
      return
    }
    // Re-read instead of trusting the mount-time value: the app can leave the
    // foreground between the first render and this effect, and that transition
    // would otherwise be missed for the lifetime of the subscription.
    setForeground(isForeground(AppState.currentState))
    const subscription = AppState.addEventListener('change', (next) => {
      setForeground(isForeground(next))
    })
    return () => subscription.remove()
  }, [pauseWhenInactive])

  useEffect(() => {
    if (!pauseWhenInactive) {
      setScreenOn(true)
      return
    }
    const source = getScreenStateSource()
    // Same re-read as above, for the same reason: the display can go off
    // between the first render and this effect.
    setScreenOn(source.interactive)
    return source.subscribe(setScreenOn)
  }, [pauseWhenInactive])

  // AND, not OR: either signal claiming "not visible" is enough to pause, and
  // resuming needs both to agree. That asymmetry is the whole fix — the
  // Android signal exists precisely because `AppState` says "active" during a
  // screen-off, and an OR would let the wrong one win.
  const live = enabled && foreground && screenOn

  useEffect(() => {
    if (!player || player.destroyed || !live) {
      setActive(false)
      return
    }
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = player.visualizer.subscribe(
        (next) => setFrame(next),
        optionsRef.current
      )
      setError(undefined)
      setActive(true)
    } catch (thrown) {
      setError(toVisualizerError(thrown))
      setActive(false)
      setFrame(undefined)
      return
    }
    return () => {
      unsubscribe?.()
      setActive(false)
      setFrame(undefined)
    }
    // `key` stands in for `options` by value; `optionsRef` carries the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, live, key])

  return { frame, error, active }
}
