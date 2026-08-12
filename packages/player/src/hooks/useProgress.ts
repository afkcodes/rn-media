import { useEffect, useState } from 'react'
import type { Player } from '../player'
import type { PlayerState } from '../state'
import { usePlayerState } from './usePlayerState'

/** What {@link useProgress} returns. */
export interface Progress {
  /** Projected playback position in seconds. */
  readonly position: number
  /**
   * Duration of the current entry in seconds, when known. Always `undefined`
   * while {@link isLive} — see {@link PlayerState.duration}.
   */
  readonly duration: number | undefined
  /**
   * Absolute timestamp (seconds) the demuxer has buffered up to — directly
   * comparable to {@link position}. `undefined` when mpv has no estimate.
   */
  readonly buffered: number | undefined
  /**
   * Whether the current entry is an endless live stream
   * ({@link PlayerState.isLive}).
   *
   * Render elapsed time and a "live" badge rather than a scrubber when this is
   * `true`: `duration` is `undefined` there not because it is late, but because
   * there is no such number.
   */
  readonly isLive: boolean
}

/** The state fields the ticker depends on. */
interface ProgressSource {
  readonly advancing: boolean
  readonly duration: number | undefined
  readonly buffered: number | undefined
  readonly isLive: boolean
}

function sameSource(a: ProgressSource, b: ProgressSource): boolean {
  return (
    a.advancing === b.advancing &&
    a.duration === b.duration &&
    a.buffered === b.buffered &&
    a.isLive === b.isLive
  )
}

function selectProgressSource(state: PlayerState): ProgressSource {
  return {
    advancing: state.playing && state.status === 'ready' && !state.seeking,
    duration: state.duration,
    buffered: state.bufferedPosition,
    isLive: state.isLive,
  }
}

/**
 * Default re-render period of {@link useProgress}, in milliseconds.
 *
 * Four renders a second is smooth enough for a seek bar and a `m:ss` readout,
 * and each one costs a local projection — no native call, no bridge traffic.
 */
export const DEFAULT_PROGRESS_INTERVAL_MS = 250

/**
 * A ticking view of the playback position.
 *
 * The position is *projected* locally from the player's anchor — nothing is
 * polled across the bridge, and no native call happens per tick. The interval
 * exists purely to re-render this component, and is **pause-aware**: it runs
 * only while playback is actually advancing, and is torn down on pause, on
 * buffering, while seeking, and on unmount.
 *
 * On subscribe (and whenever the player changes) a single precise resync runs
 * — one synchronous `time-pos` read — so a component that mounts mid-playback
 * starts from the truth rather than from a stale anchor.
 *
 * @param player - The player, or `undefined` before it has been created.
 * @param intervalMs - Re-render period in milliseconds. Defaults to `250`.
 * Pass `0` to disable the ticker and update only on state changes.
 */
export function useProgress(
  player: Player | undefined,
  intervalMs = DEFAULT_PROGRESS_INTERVAL_MS
): Progress {
  const source = usePlayerState(player, selectProgressSource, sameSource)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (player === undefined || player.destroyed) return undefined
    player.resyncPosition()
    // The resync moves only the anchor, which no selector watches — force one
    // render so the corrected position is what the component actually shows.
    setTick((value) => value + 1)
    return undefined
  }, [player])

  useEffect(() => {
    if (player === undefined || !source.advancing || intervalMs <= 0) {
      return undefined
    }
    const id = setInterval(() => {
      setTick((value) => value + 1)
    }, intervalMs)
    return () => {
      clearInterval(id)
    }
  }, [player, source.advancing, intervalMs])

  return {
    position: player === undefined ? 0 : player.getPosition(),
    duration: source.duration,
    buffered: source.buffered,
    isLive: source.isLive,
  }
}
