/**
 * Pure `PlayerState` projections — the part of the app with no player, no
 * service and no React, so it is the part a Node test can pin without a device.
 *
 * Two directions live here, and keeping them pure is what stops them drifting:
 *
 * - **Player → media session** (`toPlaybackState`, `toMediaItem`, `durationMs`,
 *   `nowPlaying`, the loop↔repeat pair): what `broadcast()` in `playback.ts`
 *   ships on the three channels. The *same* `durationMs` feeds the notification,
 *   the lock screen and this app's own seek bar, so they cannot disagree.
 * - **Player → this screen** (`selectShell`): the small slice `App.tsx`
 *   subscribes to, so a buffered-position tick does not re-render the tree.
 */
import type { LoopMode, PlayerState } from '@afkcodes/timbre-player'
import type {
  MediaItem,
  MediaRepeatMode,
  PlaybackState,
} from '@afkcodes/timbre-media-session'
import type { Track } from './data/tracks'

/* -------------------------------------------------------------------------- */
/*                       loop (mpv) ↔ repeat (session)                        */
/* -------------------------------------------------------------------------- */

/**
 * The player's loop vocabulary → the media session's repeat vocabulary — same
 * three states, different names. A remote repeat press round-trips through both:
 * the notification sends `'one'`, {@link repeatToLoop} makes it `setLoop('track')`,
 * the observed property comes back in the snapshot, and {@link loopToRepeat}
 * puts `'one'` on the next broadcast — which is what flips the icon.
 */
export function loopToRepeat(loop: LoopMode): MediaRepeatMode {
  switch (loop) {
    case 'off':
      return 'off'
    case 'track':
      return 'one'
    case 'playlist':
      return 'all'
  }
}

/** The inverse of {@link loopToRepeat}. */
export function repeatToLoop(mode: MediaRepeatMode): LoopMode {
  switch (mode) {
    case 'off':
      return 'off'
    case 'one':
      return 'track'
    case 'all':
      return 'playlist'
  }
}

/** `PlayerStatus` (+ playing intent) collapsed onto the session vocabulary. */
export function toMediaStatus(state: PlayerState): PlaybackState['status'] {
  switch (state.status) {
    case 'idle':
    case 'ended':
      return 'stopped'
    case 'loading':
    case 'buffering':
      return 'buffering'
    case 'ready':
      return state.playing ? 'playing' : 'paused'
    case 'error':
      return 'error'
  }
}

/* -------------------------------------------------------------------------- */
/*                       track facts shared by both sides                     */
/* -------------------------------------------------------------------------- */

/**
 * The three `PlayerState` fields {@link durationMs} and {@link nowPlaying} read.
 *
 * Declared structurally so the *same* functions serve both callers: `broadcast()`
 * passes a whole `PlayerState`, the UI passes its smaller {@link ShellState}.
 */
export interface TrackFacts {
  readonly isLive: boolean
  readonly duration?: number
  /** mpv's `media-title`. See {@link nowPlaying}. */
  readonly title?: string
}

/**
 * Duration to publish for `track`, in ms — `undefined` for anything live.
 *
 * Rounded to whole seconds so a jittering estimate cannot, by itself, produce a
 * stream of broadcasts. A live entry has no honest duration (mpv reports the
 * cache length, which grows forever), so it gets none.
 */
export function durationMs(
  track: Track,
  facts: TrackFacts
): number | undefined {
  if (track.isLive === true || facts.isLive || facts.duration === undefined) {
    return undefined
  }
  return Math.round(facts.duration) * 1000
}

/**
 * The ICY "now playing" line for a live entry, when the station sends one.
 *
 * `PlayerState.title` observes mpv's `media-title`, which on a Shoutcast/Icecast
 * station resolves to the ICY `StreamTitle` — the song currently on air. Read
 * only for live entries, because the same chain bottoms out at the *filename*
 * for a plain file, and `SoundHelix-Song-1.mp3` is not an upgrade on a curated
 * title.
 */
export function nowPlaying(
  track: Track,
  facts: TrackFacts
): string | undefined {
  if (track.isLive !== true) return undefined
  const title = facts.title
  return title !== undefined && title !== track.title ? title : undefined
}

/** Channel 2: the current entry, enriched with the ICY song when live. */
export function toMediaItem(track: Track, state: PlayerState): MediaItem {
  const song = nowPlaying(track, state)
  return {
    id: track.id,
    // On air, the song is the headline and the station becomes the subtitle.
    title: song ?? track.title,
    artist: song === undefined ? track.artist : track.title,
    album: track.album,
    // A projection must name everything it forwards: the first field-pick here
    // once dropped `artworkUri` and the notification lost its artwork.
    artworkUri: track.artworkUri,
    // Omitting duration is what tells the lock screen to draw a live indicator
    // rather than a seek bar to nowhere.
    duration: durationMs(track, state),
    trackNumber: track.trackNumber,
    year: track.year,
    // `isLive` as a broadcast fact: Android drops seekability, iOS sets its live
    // flag. Omitted (not `false`) for finite entries.
    isLive: track.isLive,
  }
}

/**
 * Channel 1: a `PlayerState` snapshot as a broadcast.
 *
 * `position` is `state.positionAnchorMs` verbatim — the player derives the
 * anchor in the session's own milliseconds `{value, at, rate}`, `rate` already
 * forced to `0` unless audio is genuinely advancing, so the native projection
 * freezes instead of drifting while paused or buffering. Converting
 * `state.positionAnchor` (seconds) by hand is how a scrubber ends up off by
 * 1000×.
 *
 * `shuffleEnabled` is a parameter, not a state read, because it is **app**
 * state: mpv has no shuffle *mode*, only a reorder command. Repeat is the
 * opposite — mpv owns `loop`, so it is read off the snapshot.
 */
export function toPlaybackState(
  state: PlayerState,
  shuffleEnabled: boolean
): PlaybackState {
  return {
    status: toMediaStatus(state),
    position: state.positionAnchorMs,
    bufferedPosition:
      state.bufferedPosition === undefined
        ? undefined
        : Math.round(state.bufferedPosition * 1000),
    // The collapsed notification slots (SLOT_BACK, SLOT_CENTRAL, SLOT_FORWARD).
    // The central one is deliberately `stop` — which ends the foreground service
    // — rather than a play/pause duplicate of the button Android already draws
    // from the capabilities below. `repeatMode`/`shuffle` add the wave-2 buttons
    // to the *expanded* layout; the capabilities light them up on Auto/Wear/iOS.
    controls: ['repeatMode', 'skipToPrevious', 'stop', 'skipToNext', 'shuffle'],
    capabilities: [
      'play',
      'pause',
      'stop',
      'seek',
      'skipToNext',
      'skipToPrevious',
      'skipToQueueItem',
      'setRepeatMode',
      'setShuffle',
    ],
    // The transport three keep the ≤3 collapsed slots; repeat/shuffle appear
    // only when the notification is expanded.
    compactControlIndices: [1, 2, 3],
    queueIndex: state.playlist.index,
    errorMessage: state.error?.message,
    // A press changes nothing until the app acts and re-broadcasts the new
    // value — the acknowledgement contract. The icon draws from these fields.
    repeatMode: loopToRepeat(state.loop),
    shuffleEnabled,
  }
}

/* -------------------------------------------------------------------------- */
/*                         player → what this screen draws                    */
/* -------------------------------------------------------------------------- */

/**
 * The slice of `PlayerState` the shell draws — a *selector*, not the whole
 * snapshot, so `usePlayerState` re-renders on a discontinuity rather than on the
 * buffered-position tick that moves several times a second. The rule worth
 * copying: **subscribe to the fields you draw, not to the state.**
 */
export interface ShellState extends TrackFacts {
  readonly status: PlayerState['status']
  readonly playing: boolean
  readonly index: number
  readonly count: number
  readonly rate: number
  /** mpv's `pitch`, a frequency ratio where `1` is the recording's own pitch. */
  readonly pitch: number
  readonly volume: number
  readonly muted: boolean
  /** Repeat, read from the player (the same observed `loop` the broadcast projects). */
  readonly loop: LoopMode
  /** Whether ⏭ / ⏮ would move — the library computes the pair atomically. */
  readonly hasNext: boolean
  readonly hasPrevious: boolean
  /** Cache fill on the way back to playing, `0…100` — present only while buffering. */
  readonly bufferingPercent: number | undefined
  /** 0-based chapter cursor; `undefined` when the entry has no chapters. */
  readonly chapter: number | undefined
  readonly duration: number | undefined
  readonly isLive: boolean
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
    pitch: state.pitch,
    volume: state.volume,
    muted: state.muted,
    loop: state.loop,
    hasNext: state.hasNext,
    hasPrevious: state.hasPrevious,
    bufferingPercent: state.bufferingPercent,
    chapter: state.chapter,
    duration: state.duration,
    isLive: state.isLive,
    title: state.title,
    error: state.error,
  }
}

/**
 * Field-by-field comparison for {@link selectShell} — needed because the
 * selector returns a fresh object every call, so without it `usePlayerState`
 * would see a new identity on every change and the selector would buy nothing.
 */
export function sameShell(a: ShellState, b: ShellState): boolean {
  return (Object.keys(a) as Array<keyof ShellState>).every((key) =>
    Object.is(a[key], b[key])
  )
}
