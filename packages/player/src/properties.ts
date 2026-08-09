import type { MpvFormat } from './specs/mpv-client.nitro'

/**
 * One entry of the observation table: an mpv property name plus the
 * {@link MpvFormat} it is observed in.
 */
export interface ObservedProperty {
  /** The mpv property name, exactly as documented in mpv's `input.rst`. */
  readonly name: string
  /** The format the value is delivered in. */
  readonly format: MpvFormat
}

/**
 * mpv property names this library observes, as string constants so that the
 * reducer's `switch` and the observation table can never drift apart.
 */
export const MpvProperty = {
  /** `pause` — flag. Playback intent; `true` means paused. */
  pause: 'pause',
  /** `duration` — double, seconds. Unavailable until the file is loaded. */
  duration: 'duration',
  /** `seeking` — flag. `true` while mpv is repositioning. */
  seeking: 'seeking',
  /**
   * `seekable` — flag. mpv: "Whether it's generally possible to seek in the
   * current file" (`input.rst`, mpv 0.35.1). `false` is how an unseekable live
   * stream announces itself; see {@link PlayerState.isLive}.
   */
  seekable: 'seekable',
  /** `core-idle` — flag. `true` when no audio is being produced. */
  coreIdle: 'core-idle',
  /** `idle-active` — flag. `true` when nothing at all is loaded. */
  idleActive: 'idle-active',
  /** `eof-reached` — flag. `true` once the end of the file was reached. */
  eofReached: 'eof-reached',
  /** `playlist-pos` — int64, `-1` when no entry is current. */
  playlistPos: 'playlist-pos',
  /** `playlist-count` — int64, number of playlist entries. */
  playlistCount: 'playlist-count',
  /** `demuxer-cache-time` — double, absolute demuxer cache end timestamp. */
  demuxerCacheTime: 'demuxer-cache-time',
  /** `speed` — double, playback rate multiplier. */
  speed: 'speed',
  /** `volume` — double, mpv's 0–100 scale (see {@link MPV_VOLUME_SCALE}). */
  volume: 'volume',
  /** `mute` — flag. */
  mute: 'mute',
  /** `loop-file` — `"no"`, `"inf"` or a repeat count, read as a string. */
  loopFile: 'loop-file',
  /** `loop-playlist` — `"no"`, `"inf"` or a repeat count, read as a string. */
  loopPlaylist: 'loop-playlist',
  /** `media-title` — string, the best available title for the current entry. */
  mediaTitle: 'media-title',
  /** `time-pos` — double. NEVER observed; read one-shot on discontinuities. */
  timePos: 'time-pos',
} as const

/**
 * mpv's `volume` property is a percentage: `100` is unattenuated output.
 *
 * The public {@link PlayerState.volume} is normalised to `0..1`, so every
 * conversion goes through this constant.
 */
export const MPV_VOLUME_SCALE = 100

/**
 * Every property the {@link Player} observes, with the format it observes it
 * in. This is the complete set — `time-pos` is deliberately absent (see the
 * position-projection contract in `docs/specs/player-core.md` §3).
 *
 * @remarks
 * `playlist-pos` and `playlist-count` are `int64` properties observed as
 * `number`: `mpv/client.h` guarantees that "MPV_FORMAT_INT64 is always
 * converted to MPV_FORMAT_DOUBLE", so this is lossless for any playlist that
 * fits in a `double`'s integer range.
 *
 * `loop-file`/`loop-playlist` are observed as `string` because their value
 * domain is `"no" | "inf" | <count>` — no numeric format can represent it.
 *
 * `seekable` is a yes/no property (`partially-seekable`'s entry in mpv's
 * `input.rst` states "If this property returns `yes`/true, so will
 * `seekable`"), so it is observed as `bool`. It is what tells a live stream
 * apart from a finite one — see {@link PlayerState.isLive}.
 */
export const OBSERVED_PROPERTIES: readonly ObservedProperty[] = [
  { name: MpvProperty.pause, format: 'bool' },
  { name: MpvProperty.duration, format: 'number' },
  { name: MpvProperty.seeking, format: 'bool' },
  { name: MpvProperty.seekable, format: 'bool' },
  { name: MpvProperty.coreIdle, format: 'bool' },
  { name: MpvProperty.idleActive, format: 'bool' },
  { name: MpvProperty.eofReached, format: 'bool' },
  { name: MpvProperty.playlistPos, format: 'number' },
  { name: MpvProperty.playlistCount, format: 'number' },
  { name: MpvProperty.demuxerCacheTime, format: 'number' },
  { name: MpvProperty.speed, format: 'number' },
  { name: MpvProperty.volume, format: 'number' },
  { name: MpvProperty.mute, format: 'bool' },
  { name: MpvProperty.loopFile, format: 'string' },
  { name: MpvProperty.loopPlaylist, format: 'string' },
  { name: MpvProperty.mediaTitle, format: 'string' },
]
