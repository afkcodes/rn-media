/**
 * What the app shell draws, projected out of `PlayerState`.
 *
 * ## Why a selector and not the whole snapshot
 * `usePlayerState(player)` with no selector re-renders its component on *every*
 * state change. That is not once per track — `demuxer-cache-time` moves the
 * buffered position while a track is streaming, and the component reading it is
 * the root of the screen, so an unfiltered subscription re-renders the entire
 * tree (queue rows, EQ chips, the visualizer's parent) on a clock rather than on
 * a discontinuity. The library quantises that clock to whole seconds, which
 * makes it survivable — it does not make it *news*.
 *
 * A selector fixes it at the source: `usePlayerState` compares what the
 * selector returned (here field by field, because the projection is a fresh
 * object every call) and bails out of the render entirely when nothing this
 * screen draws has changed. The rule worth copying: **subscribe to the fields
 * you draw, not to the state.** Position is the same idea taken further —
 * `useProgress` owns its own ticker so only the clock line re-renders, and
 * `SeekBar` reads it directly.
 *
 * ## Why there is no `track` in here
 * The queue is *app* state (it can be edited — see `Playback.playNext`), and a
 * selector only re-runs when the **player** state changes. Putting the current
 * `Track` in here would have made a shuffle that happened to keep the index
 * produce a stale title. So the shell carries the index, and the composition
 * root looks the track up in `playback.queue` — the one place both
 * subscriptions have already been read.
 */
import type { PlayerState } from '@rn-media/player'
import type { TrackFacts } from './broadcast'

export interface ShellState extends TrackFacts {
  readonly status: PlayerState['status']
  readonly playing: boolean
  readonly index: number
  readonly count: number
  readonly rate: number
  readonly volume: number
  readonly muted: boolean
  /** mpv's raw duration in seconds; see {@link durationMs} before drawing it. */
  readonly duration: number | undefined
  readonly isLive: boolean
  /** mpv's `media-title`, which is where an ICY now-playing line arrives. */
  readonly title: string | undefined
  readonly error: PlayerState['error']
}

export function selectShell(state: PlayerState): ShellState {
  return {
    status: state.status,
    playing: state.playing,
    index: state.playlist.index,
    count: state.playlist.count,
    rate: state.rate,
    volume: state.volume,
    muted: state.muted,
    duration: state.duration,
    isLive: state.isLive,
    title: state.title,
    error: state.error,
  }
}

/**
 * Field-by-field comparison for {@link selectShell}.
 *
 * Needed because the selector returns a new object every time it runs; without
 * it `usePlayerState` would see a new identity on every change and the selector
 * would buy nothing. `error` is compared by identity on purpose — the reducer
 * only ever replaces it, never edits it.
 */
export function sameShell(a: ShellState, b: ShellState): boolean {
  return (Object.keys(a) as Array<keyof ShellState>).every((key) =>
    Object.is(a[key], b[key])
  )
}
