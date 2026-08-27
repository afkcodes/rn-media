/**
 * Player → media-session projections.
 *
 * Pure functions, no player and no service: given a `PlayerState` snapshot and
 * the `Track` the cursor is on, produce the three things the media session
 * broadcasts. Keeping them pure is what makes them the easy part to unit-test
 * in a real app — and it is why the same `durationMs` is used by the
 * notification, the lock screen and this app's own seek bar, so they cannot
 * disagree.
 */
import type { LoopMode, PlayerState } from '@timbre/player'
import type {
  MediaItem,
  MediaRepeatMode,
  PlaybackState,
} from '@timbre/media-session'
import type { Track } from '../data/tracks'

/**
 * The player's loop vocabulary ↔ the media session's repeat vocabulary.
 *
 * Same three states, different names (`track`/`one`, `playlist`/`all`), and
 * the translation lives here — with the other projections — so the handler
 * (session → player) and the broadcast (player → session) cannot each invent
 * half of it. A remote repeat press round-trips through both: the notification
 * sends `'one'`, {@link repeatToLoop} turns it into `setLoop('track')`, the
 * observed property comes back through the snapshot, and {@link loopToRepeat}
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

/** `PlayerStatus` (+ intent) collapsed onto the media-session vocabulary. */
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

/**
 * Turn a `PlayerState` snapshot into a broadcast.
 *
 * The position anchor is taken straight off the snapshot as
 * `positionAnchorMs`: the player derives it in the media session's own
 * milliseconds `{value, at, rate}`, with `rate` already forced to `0` unless
 * audio is genuinely advancing, so the native projection freezes instead of
 * drifting while buffering or paused. (`state.positionAnchor` is the same fact
 * in seconds, for projecting locally — converting it here by hand is how a
 * lock-screen scrubber ends up off by 1000×.)
 *
 * `shuffleEnabled` is a parameter rather than a `PlayerState` read because it
 * is **app** state: mpv has no shuffle *mode*, only a reorder command, so the
 * toggle lives in the controller and rides into the broadcast here. Repeat is
 * the opposite — mpv owns it (`loop`), so it is read straight off the snapshot.
 */
export function toPlaybackState(
  state: PlayerState,
  shuffleEnabled: boolean
): PlaybackState {
  const status = toMediaStatus(state)

  return {
    status,
    position: state.positionAnchorMs,
    bufferedPosition:
      state.bufferedPosition === undefined
        ? undefined
        : Math.round(state.bufferedPosition * 1000),
    // The three collapsed slots, in `MediaButtons` terms: SLOT_BACK,
    // SLOT_CENTRAL, SLOT_FORWARD.
    //
    // The central one is a real choice, and this app deliberately does not
    // spend it on play/pause: Android's own media control already draws a
    // play/pause of its own from the `play`/`pause` *capabilities* below
    // (that is the big button top-right of the media card), so listing one
    // here too just buys a duplicate. `stop` — which ends the foreground
    // service, the one thing pause never does — is the useful thing to put
    // there instead.
    //
    // Any `MediaControl` works: `state.playing ? 'pause' : 'play'` for the
    // classic three-button transport, or `fastForward`/`rewind` (those take
    // the FORWARD/BACK slots, so they pair with dropping next/previous).
    //
    // `repeatMode`/`shuffle` are the wave-2 additions: listing them here is
    // what puts the buttons on the Android notification's *expanded* layout
    // (media3's default provider draws only the transport three otherwise);
    // the capabilities below are what light them up on Android Auto, Wear and
    // iOS's command center. The icon each draws comes from the current
    // `repeatMode`/`shuffleEnabled` fields — a press changes nothing until the
    // app acts and re-broadcasts, which is the acknowledgement contract.
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
    // The transport three keep the ≤3 collapsed slots; repeat and shuffle
    // appear only when the notification is expanded.
    compactControlIndices: [1, 2, 3],
    queueIndex: state.playlist.index,
    errorMessage: state.error?.message,
    repeatMode: loopToRepeat(state.loop),
    shuffleEnabled,
  }
}

/**
 * The three `PlayerState` fields the two projections below actually read.
 *
 * Declared structurally so the *same* functions serve both callers: the session
 * bridge passes a whole `PlayerState`, and the UI passes its much smaller
 * selector result (`ShellState`). That is the point — the notification and the
 * in-app seek bar cannot disagree about what is live or how long it is, because
 * there is one implementation and no second copy to drift.
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
 * Rounded to whole seconds so that a jittering estimate cannot, by itself,
 * produce a stream of broadcasts. See {@link Track.live}.
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
 * `PlayerState.title` observes mpv's `media-title`, which resolves
 * `service_name` → `title` → `icy-title` → filename (mpv 0.35.1
 * `player/command.c`, `mp_property_media_title`). On a Shoutcast/Icecast
 * station that lands on the ICY `StreamTitle` — the song currently on air.
 * Verified on Diverse FM: `icy-title: Lata Mangeshkar & Udit Narayan - Dil To
 * Pagal Hai`, arriving ~1.7 s after the stream opened and again on every song
 * change.
 *
 * Read only for live entries, because the same chain bottoms out at the
 * *filename* for a plain file, and `SoundHelix-Song-1.mp3` is not an upgrade
 * on a curated title.
 *
 * The other route to the same fact — `player.on('metadataChanged')` plus
 * `player.getMetadataValue('icy-title')` — is wired up in the controller and
 * feeds the station line under the title. Two routes, one for state and one
 * for events, because a media session wants the *state* (it re-broadcasts) and
 * a UI ticker wants the *event* (it appends).
 */
export function nowPlaying(
  track: Track,
  facts: TrackFacts
): string | undefined {
  if (track.isLive !== true) return undefined
  const title = facts.title
  return title !== undefined && title !== track.title ? title : undefined
}

export function toMediaItem(track: Track, state: PlayerState): MediaItem {
  const song = nowPlaying(track, state)
  return {
    id: track.id,
    // On air, the song is the headline and the station becomes the subtitle —
    // what a listener expects to read on the lock screen.
    title: song ?? track.title,
    artist: song === undefined ? track.artist : track.title,
    album: track.album,
    // Regression note (2026-08-13): the monolith spread the whole track, so
    // artwork rode along invisibly; this projection picks fields, and the
    // first field-pick dropped `artworkUri` — no artwork in the notification.
    // A projection must name everything it forwards.
    artworkUri: track.artworkUri,
    // Omitting duration is what tells the lock screen to render a live
    // indicator rather than a seek bar to nowhere.
    duration: durationMs(track, state),
    // The wave-2 extended tags — named one by one, per the regression note
    // above. `albumArtist` and the rest of the set are absent because no entry
    // in TRACKS carries them truthfully, not because they were forgotten.
    trackNumber: track.trackNumber,
    year: track.year,
    // `isLive` as a broadcast *fact*, replacing "no duration, so presumably
    // live": Android drops seekability via `isDynamic`, iOS sets
    // `MPNowPlayingInfoPropertyIsLiveStream`. Omitted (not `false`) for finite
    // entries, which keeps the old inference for anything unannotated.
    isLive: track.isLive,
  }
}
