import { useEffect, useRef, useState } from 'react'
import type { Player } from '../player'
import type { PlayerError } from '../errors'
import { toVisualizerError } from '../errors'
import type { VisualizerFrame, VisualizerOptions } from '../visualizer'

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
  /** Whether a subscription is currently live. */
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
  enabled = true
): UseVisualizerResult {
  const [frame, setFrame] = useState<VisualizerFrame | undefined>(undefined)
  const [error, setError] = useState<PlayerError | undefined>(undefined)
  const [active, setActive] = useState(false)

  // Options are compared by value, not identity: callers overwhelmingly pass an
  // object literal, and keying the effect on identity would tear the native
  // capture down and rebuild it on **every render**.
  const key = JSON.stringify(options ?? {})
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    if (!player || player.destroyed || !enabled) {
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
  }, [player, enabled, key])

  return { frame, error, active }
}
