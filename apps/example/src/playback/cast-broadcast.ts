/**
 * Cast ↔ media-session projections — the receiver-state half of `broadcast.ts`.
 *
 * Pure functions, no Cast facade and no service: given the handoff's
 * `CastReceiverSnapshot` (a position anchor + reconciled JS index) and the
 * `Track` behind that index, produce what the three broadcast channels carry
 * **while casting**. This is contract §3 of the handoff design: during
 * CAST_ACTIVE the app's broadcasts describe the RECEIVER, through the same
 * channels every surface already reads — the notification, the lock screen and
 * the in-app UI keep working because nothing about the fan-out changed, only
 * the facts flowing through it.
 *
 * Kept pure for the same reason `broadcast.ts` is: it is the part a real app
 * copies, and the part a Node test can pin without a device.
 */
import type { CastReceiverSnapshot } from '@timbre/cast'
import type { MediaItem, PlaybackState } from '@timbre/media-session'
import {
  DEMO_BROKEN_TARGET,
  DEMO_BROKEN_URI,
  DEMO_SCHEME,
  DEMO_SOURCES,
  type Track,
} from '../data/tracks'

/** Receiver player state collapsed onto the media-session vocabulary. */
export function toCastStatus(
  snapshot: CastReceiverSnapshot
): PlaybackState['status'] {
  switch (snapshot.playerState) {
    case 'playing':
      return 'playing'
    case 'paused':
      return 'paused'
    case 'buffering':
    case 'loading':
    // `unknown` is the SDK's "no status yet" — buffering is the honest render.
    case 'unknown':
      return 'buffering'
    case 'idle':
      // Receiver finished the queue → stopped; any other idle (a cancelled
      // load, an interrupted item) renders as paused rather than pretending
      // the session is over — the session is still up.
      return snapshot.queueEnded ? 'stopped' : 'paused'
  }
}

/**
 * The `playbackState` broadcast while casting.
 *
 * The receiver's `{position, at, rate}` anchor maps 1:1 onto the media
 * session's `PositionAnchor` (ms) — a cast status update is a discontinuity
 * broadcast, and every surface projects locally from it, the same rule as
 * local playback. `rate` is already `0` unless the receiver is genuinely
 * playing (the handoff freezes it for paused/buffering), so nothing here
 * re-derives it.
 *
 * Deliberately narrower than the local broadcast's control set: repeat and
 * shuffle are not offered because this app does not wire them to the receiver
 * queue — advertising a button that does nothing would break the
 * acknowledgement contract every surface relies on.
 */
export function toCastPlaybackState(
  snapshot: CastReceiverSnapshot
): PlaybackState {
  return {
    status: toCastStatus(snapshot),
    position: {
      value: Math.round(snapshot.position * 1000),
      at: snapshot.at,
      rate: snapshot.rate,
    },
    controls: ['skipToPrevious', 'stop', 'skipToNext'],
    capabilities: [
      'play',
      'pause',
      'stop',
      'seek',
      'skipToNext',
      'skipToPrevious',
      'skipToQueueItem',
    ],
    compactControlIndices: [0, 1, 2],
    queueIndex: snapshot.itemIndex,
  }
}

/**
 * The `mediaItem` broadcast while casting: the JS queue's metadata (the queue
 * stays the source of truth — the receiver echoes what we loaded, it does not
 * improve on it), with the *receiver's* duration attached, since the receiver
 * owns the clock the seek bar runs on.
 */
export function toCastMediaItem(
  track: Track,
  snapshot: CastReceiverSnapshot
): MediaItem {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    artworkUri: track.artworkUri,
    duration:
      track.isLive === true || snapshot.duration === undefined
        ? undefined
        : Math.round(snapshot.duration * 1000),
    trackNumber: track.trackNumber,
    year: track.year,
    isLive: track.isLive,
  }
}

/**
 * The URL a *receiver* would fetch for a track — this app's stand-in for the
 * signing endpoint a real catalogue app calls.
 *
 * The receiver fetches URLs itself, so logical URIs must be resolved *before*
 * the handoff snapshot — the same seam as the player's `setSourceResolver`,
 * exercised here synchronously because `DEMO_SOURCES` is a constant map. In a
 * real app this is `await api.sign(id)` run over the queue before handing the
 * snapshot to `wireCastHandoff` — and it is the re-resolve hook when a signed
 * URL expires mid-session (`cast-receiver-fetch` → re-sign → `syncQueue()`).
 *
 * `DEMO_BROKEN_URI` resolves to the refused-connection target on purpose: on
 * the receiver, `127.0.0.1:9` is the *receiver's* loopback, so advancing into
 * that entry produces a genuine receiver-side fetch failure — the on-device
 * demo of the `cast-receiver-fetch` error family.
 */
/**
 * Receiver-side URL substitutions — the redirect half of the resolver seam.
 *
 * Device truth (Mi Smart Speaker, Default Media Receiver, 2026-08-14): the
 * receiver NEVER started playback for an HLS playlist URL that answers with a
 * 302. The Vividh Bharati entry's wavespb.com URL redirects every path under
 * `/live/<id>/` to the playlist on CloudFront; casting it left the receiver
 * IDLE forever, and a `queueJumpTo` into it wedged the media channel (the
 * PendingResult settled CANCELED/2002 only when the session ended — the
 * owner's "every queue tap fails"). Handing the receiver the redirect TARGET
 * played immediately. mpv follows the redirect fine, so local playback keeps
 * the original URI — the asymmetry is the receiver's, and the fix is the
 * sender's job: resolve redirects into receiver-playable URLs before the
 * handoff, exactly where a real app resolves its signed URLs.
 */
const CAST_URL_OVERRIDES: Readonly<Record<string, string>> = {
  'https://radio.wavespb.com/live/146ed6ec6dea5a24/146ed6ec6dea5a24.m3u8':
    'https://d1tmej9eu7kw5c.cloudfront.net/146ed6ec6dea5a24/146ed6ec6dea5a24.m3u8',
}

export function castUrlOf(track: Track): string {
  if (track.uri === DEMO_BROKEN_URI) return DEMO_BROKEN_TARGET
  if (track.uri.startsWith(DEMO_SCHEME)) {
    const id = track.uri.slice(DEMO_SCHEME.length)
    // An unresolvable id keeps its logical URI; the receiver will refuse it
    // loudly (cast-receiver-fetch) rather than this projection guessing.
    return DEMO_SOURCES[id] ?? track.uri
  }
  return CAST_URL_OVERRIDES[track.uri] ?? track.uri
}

/**
 * Concrete MIME type for the receiver's `contentType`, from the *resolved*
 * URL. This catalogue is small enough to classify honestly; a real app reads
 * this off its own metadata instead of sniffing.
 *
 * Both live shapes verified against the Default Media Receiver on hardware
 * (2026-08-14): `application/x-mpegurl` plays the HLS entries (TS/AAC
 * segments, no `hlsSegmentFormat` hint needed), and `audio/aacp` plays the
 * Shoutcast stream as-is. The live failures were never MIME — they were the
 * start position (live must join the live edge) and a redirecting playlist
 * URL (see {@link CAST_URL_OVERRIDES}).
 */
export function castMimeOf(track: Track): string {
  const url = castUrlOf(track)
  const path = url.split(/[?#]/, 1)[0] ?? url
  if (path.endsWith('.m3u8')) return 'application/x-mpegurl'
  if (path.endsWith('.mp3')) return 'audio/mpeg'
  if (path.endsWith('.mp4') || path.endsWith('.m4a')) return 'audio/mp4'
  if (path.endsWith('.aac')) return 'audio/aac'
  if (path.endsWith('.ogg')) return 'audio/ogg'
  // The one extensionless entry is the Shoutcast stream, which serves
  // `audio/aacp` (verified against the live host — see TRACKS).
  return 'audio/aacp'
}
