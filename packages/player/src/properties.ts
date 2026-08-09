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
  /**
   * `metadata` — the current entry's tag map.
   *
   * Observed purely as a *change edge*: mpv's `input.rst` (0.35.1) says of this
   * property "Trying to retrieve this property as a raw string doesn't work",
   * so the delivered string is never interpreted. The typed map is rebuilt from
   * the documented `metadata/list/…` sub-properties instead — see
   * {@link metadataKeyProperty}.
   */
  metadata: 'metadata',
  /**
   * `metadata/list/count` — int, "Number of metadata entries" (`input.rst`).
   * Read on demand; never observed (a tag *value* change leaves it equal, so it
   * is not a usable change signal).
   */
  metadataCount: 'metadata/list/count',
  /** `time-pos` — double. NEVER observed; read one-shot on discontinuities. */
  timePos: 'time-pos',
  /**
   * `replaygain` — choice `no` | `track` | `album` (mpv 0.35.1 `options.rst`).
   * Settable at runtime: the option carries `UPDATE_VOL`, which re-runs
   * `audio_update_volume()` immediately (mpv `options/options.c`,
   * `player/audio.c`).
   */
  replayGain: 'replaygain',
  /**
   * `replaygain-preamp` — "Pre-amplification gain in dB to apply to the
   * selected replaygain gain (default: 0)" (`options.rst`). mpv clamps it to
   * `M_RANGE(-150, 150)` (`options/options.c`). Runtime-settable (`UPDATE_VOL`).
   */
  replayGainPreamp: 'replaygain-preamp',
  /**
   * `replaygain-clip` — flag. **`yes` means "allow clipping"**, i.e. it
   * *disables* mpv's automatic gain reduction; the default `no` keeps the
   * protection on. See `ReplayGainOptions.clip` in `player.ts` for why the
   * 0.35.1 manual reads the other way round. Runtime-settable (`UPDATE_VOL`).
   */
  replayGainClip: 'replaygain-clip',
  /**
   * `replaygain-fallback` — "Gain in dB to apply if the file has no replay gain
   * tags" (`options.rst`). mpv clamps it to `M_RANGE(-200, 60)`
   * (`options/options.c`). Runtime-settable (`UPDATE_VOL`).
   */
  replayGainFallback: 'replaygain-fallback',
  /**
   * `cache-secs` — double, "How many seconds of audio/video to prefetch if the
   * cache is active" (`options.rst`), range `M_RANGE(0, DBL_MAX)`
   * (`demux/demux.c`).
   */
  cacheSecs: 'cache-secs',
  /**
   * `prefetch-playlist` — flag, "Prefetch next playlist entry while playback of
   * the current entry is ending (default: no)" (`options.rst`).
   */
  prefetchPlaylist: 'prefetch-playlist',
} as const

/**
 * The property that yields the key of the `index`-th metadata entry.
 *
 * mpv 0.35.1 `input.rst`: "``metadata/list/N/key`` — Key name of the Nth
 * metadata entry. (The first entry is ``0``)." It is a plain string
 * sub-property (`player/command.c`, `get_tag_entry` → `SUB_PROP_STR`), which is
 * what makes the whole tag map reachable without `MPV_FORMAT_NODE`.
 *
 * @param index - 0-based entry index, `< metadata/list/count`.
 */
export function metadataKeyProperty(index: number): string {
  return `${MpvProperty.metadata}/list/${index}/key`
}

/**
 * The property that yields the value of the `index`-th metadata entry.
 *
 * mpv 0.35.1 `input.rst`: "``metadata/list/N/value`` — Value of the Nth
 * metadata entry."
 *
 * @param index - 0-based entry index, `< metadata/list/count`.
 */
export function metadataValueProperty(index: number): string {
  return `${MpvProperty.metadata}/list/${index}/value`
}

/**
 * The property that yields one metadata value by tag name.
 *
 * mpv 0.35.1 `input.rst`: "``metadata/by-key/<key>`` — Value of metadata entry
 * ``<key>``." (The manual also documents the older `metadata/<key>` spelling
 * and discourages it, "because the metadata key string could conflict with
 * other sub-properties" — hence the explicit prefix here.)
 *
 * @param key - Tag name, e.g. `'title'`, `'icy-title'`, `'album'`.
 */
export function metadataByKeyProperty(key: string): string {
  return `${MpvProperty.metadata}/by-key/${key}`
}

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
 *
 * `metadata` is observed as `string` **only to learn that the tag map changed**
 * — the value is dropped on the floor, never parsed. mpv's own manual says the
 * property cannot be read as a raw string, so nothing may depend on what that
 * string contains; the typed map is rebuilt from `metadata/list/…` instead.
 * Together with `media-title` (which mpv invalidates on the same
 * `MP_EVENT_METADATA_UPDATE`, `player/command.c`) it is what drives the
 * `metadataChanged` event.
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
  { name: MpvProperty.metadata, format: 'string' },
]

/**
 * Whether a property change means "the current entry's metadata changed".
 *
 * Both names are invalidated by mpv's single `MP_EVENT_METADATA_UPDATE`
 * (`player/command.c`: `E(MP_EVENT_METADATA_UPDATE, "metadata",
 * "filtered-metadata", "media-title")`), and either arriving is enough. Two
 * triggers rather than one because mpv only re-emits an observed property when
 * its *value* compares unequal (`player/client.c`,
 * `send_client_property_changes`): if the `metadata` string read ever fails —
 * which is what the manual says should happen — that observation goes quiet
 * after its initial event, and `media-title` still carries ICY now-playing
 * changes.
 */
export function isMetadataProperty(name: string): boolean {
  return name === MpvProperty.metadata || name === MpvProperty.mediaTitle
}
