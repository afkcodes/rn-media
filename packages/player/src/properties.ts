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
  /**
   * `pitch` — double, `M_RANGE(0.01, 100.0)` (`options/options.c`, mpv 0.41.0).
   *
   * mpv 0.41.0 `options.rst`: "Raise or lower the audio's pitch by the factor
   * given as parameter. Does not affect playback speed. Playing with an altered
   * pitch automatically inserts the `scaletempo2` audio filter." Added upstream
   * in mpv 0.40, i.e. it exists on every binary this library pins.
   *
   * An option, therefore also a property ("Most options can be set at runtime
   * via properties as well. Just remove the leading `--`", `input.rst`), which
   * is what makes it observable.
   */
  pitch: 'pitch',
  /**
   * `audio-channels` — the output channel layout, `UPDATE_AUDIO`
   * (`options/options.c`, mpv 0.41.0) so it applies without a reload.
   *
   * mpv 0.41.0 `options.rst`: "`--audio-channels=<stereo|mono>` — Force a
   * downmix to stereo or mono."
   */
  audioChannels: 'audio-channels',
  /**
   * `cache-buffering-state` — int, "The percentage (0-100) of the cache fill
   * status until the player will unpause (related to `paused-for-cache`)"
   * (mpv 0.41.0 `input.rst`).
   *
   * Read that sentence literally: it is **not** a general buffer gauge, it is
   * how close mpv is to resuming from a stall. See
   * `PlayerState.bufferingPercent`, which publishes it only while the player is
   * actually stalled.
   */
  cacheBufferingState: 'cache-buffering-state',
  /**
   * `chapter` — int64, RW. mpv 0.41.0 `input.rst`: "Current chapter number. The
   * number of the first chapter is 0. A value of -1 indicates that the current
   * playback position is before the start of the first chapter."
   *
   * "Setting this property results in an absolute seek to the start of the
   * chapter." Unavailable while nothing is loaded.
   */
  chapter: 'chapter',
  /** `chapters` — int64, "Number of chapters" (`input.rst`). */
  chapters: 'chapters',
  /**
   * `chapter-list` — node, read as one `MPV_FORMAT_NODE` array of maps
   * (`MpvClient.getChapters`). mpv 0.41.0 `input.rst` documents the node shape
   * verbatim: `"title" MPV_FORMAT_STRING`, `"time" MPV_FORMAT_DOUBLE`.
   */
  chapterList: 'chapter-list',
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
   * so the delivered string is never interpreted. The typed map comes from one
   * `MPV_FORMAT_NODE` read of this same property (`MpvClient.getPropertyMap`),
   * which is the format the manual says to use.
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
   * tags. This option is always applied if the replaygain logic is somehow
   * inactive" (mpv 0.41.0 `options.rst`) — *"somehow inactive" includes
   * `replaygain=no`: the fallback branch is the `else` of the mode check in
   * `compute_replaygain()` (`player/audio.c`), so a non-zero fallback keeps
   * applying after the mode is switched off. mpv clamps it to
   * `M_RANGE(-200, 60)` (`options/options.c`). Runtime-settable (`UPDATE_VOL`).
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
  /**
   * `gapless-audio` — choice `no` | `yes` | `weak`, "Try to play consecutive
   * audio files with no silence or disruption at the point of file change.
   * Default: `weak`" (mpv 0.41.0 `options.rst`).
   *
   * This is an audio-*output* policy, not a demuxer one: it decides whether the
   * AO is kept open across a file change. See `GaplessAudioMode` in `player.ts`
   * for what each value costs.
   */
  gaplessAudio: 'gapless-audio',
  /**
   * `af` — the audio filter chain (mpv `options.rst` "Audio Filters").
   *
   * Runtime-settable: mpv lists `af` explicitly among the options it allows to
   * change during playback (`options/options.c`, the runtime-updatable name
   * table), and setting it rebuilds the filter chain in place rather than
   * reloading the file. The value is an ordered list; see
   * `compileAudioFilters` in `filters.ts` for the exact grammar, which is
   * mpv's own (`options/m_option.c: print_obj_settings_list`).
   *
   * Setting it is *atomic and validating*: mpv parses the whole string first
   * (`parse_obj_settings`, which rejects an unknown filter name outright with
   * "Option af: <name> doesn't exist.") and leaves the existing chain untouched
   * if any entry fails.
   */
  audioFilters: 'af',
  /**
   * `playlist` — the whole queue as one node.
   *
   * Read on demand through `MpvClient.getPlaylistEntries()` (one
   * `MPV_FORMAT_NODE` round-trip), never observed: the array would be a second
   * copy of mpv's own state crossing the bridge on every edit, and the cursor
   * (`playlist-pos`/`playlist-count`) is what state actually needs. See
   * `PlaylistApi.entries`.
   */
  playlist: 'playlist',
  /**
   * `stream-lavf-o` — "Set AVOptions on streams opened with libavformat"
   * (mpv 0.41.0 `options.rst`), a key/value list.
   *
   * Applied by `mp_setup_av_network_options()` **last**, after every option mpv
   * derives from its own settings (`stream/stream_lavf.c:242`,
   * `mp_set_avdict(dict, opts->avopts)`), so an entry here wins over mpv's
   * defaults. The same function is called from both `stream_lavf.c:407` (the
   * top-level connection) and `demux_lavf.c:1024` (an `AVFMT_NOFILE` demuxer
   * opening its own connections, which is how HLS fetches segments) — so one
   * value covers both layers.
   *
   * This library uses it for exactly one thing: FFmpeg's HTTP reconnect
   * options. See `PlayerOptions.networkReconnect`.
   */
  streamLavfO: 'stream-lavf-o',
  /**
   * `pcm-tap` — int, read/write. Samples per channel mpv retains for the
   * visualizer; `0` (the default) disarms the tap.
   *
   * Added by this project's libmpv patch (ARCHITECTURE §11, §21), so reading it
   * is also the availability probe: a libmpv without the patch answers
   * "property not found" and `player.visualizer.capabilities.fft` is `false`.
   * Identical on both platforms — it is the same source patch in both forks.
   *
   * Setting it directly is legal and does nothing useful on its own: the
   * sampler thread that reads {@link pcmTapFrame} lives in native code and is
   * driven by `player.visualizer.subscribe()`.
   */
  pcmTap: 'pcm-tap',
  /**
   * `pcm-tap-frame` — node, read-only. The newest retained window, as a map of
   * `sample_rate` / `channels` / `frames` / `pts_us` / `seq` plus `samples`, a
   * byte array of interleaved float32.
   *
   * Listed for completeness; nothing in TypeScript reads it. It is consumed by
   * the native sampler, which never lets the PCM cross into JavaScript.
   */
  pcmTapFrame: 'pcm-tap-frame',
} as const

/**
 * The property that yields the key of the `index`-th metadata entry.
 *
 * mpv 0.35.1 `input.rst`: "``metadata/list/N/key`` — Key name of the Nth
 * metadata entry. (The first entry is ``0``)." It is a plain string
 * sub-property (`player/command.c`, `get_tag_entry` → `SUB_PROP_STR`), which
 * makes the tag map reachable one scalar at a time.
 *
 * {@link Player.getMetadata} no longer walks these — it does one node read of
 * `metadata` instead, because `2N + 1` blocking reads at a track boundary is a
 * JS-thread stall. They stay public because a caller who wants exactly one
 * entry by position still has no other way to ask.
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
 * The property that yields the *logical* URI of the `index`-th playlist entry.
 *
 * mpv `input.rst`: "``playlist/N/filename`` — Filename of the Nth entry." It is
 * the string that was passed to `loadfile`, unchanged: a load hook rewrites
 * `stream-open-filename` on the way to the stream layer and never touches the
 * playlist, so this stays the key a resolver's answer is cached under no matter
 * how many times the entry has been resolved.
 *
 * Read on demand — two reads when the queue moves — rather than observed:
 * playlist entries do not change under us, and observing `playlist` as a whole
 * would deliver a node this library has no use for.
 *
 * @param index - 0-based playlist index, `< playlist-count`.
 */
export function playlistFilenameProperty(index: number): string {
  return `playlist/${index}/filename`
}

/**
 * The property that yields mpv's stable *entry id* of the `index`-th playlist
 * entry.
 *
 * mpv `input.rst`: "``playlist/N/id`` — Unique ID for this entry. This is an
 * automatically assigned integer ID that is unique for the entire life time of
 * the current mpv core instance." Unlike the array index it survives
 * `playlist-move`/`playlist-remove` and is distinct even for duplicate URIs, so
 * it is the right key for an app to match a `trackChanged` against its own list.
 *
 * Reading it back per index relies on the fork binaries' `prefetch-playlist-
 * entry-id` support (see {@link PrefetchStartedEvent.entryId}); timbre's own
 * libmpv forks provide it (ARCHITECTURE section 11). On a build without it the
 * read returns unavailable and the field is simply absent.
 *
 * @param index - 0-based playlist index, `< playlist-count`.
 */
export function playlistEntryIdProperty(index: number): string {
  return `playlist/${index}/id`
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
 *
 * Three of these are observed for state fields that only ever move when
 * something asks them to, so each costs one event at startup and nothing
 * afterwards: `pitch` and `chapter` change on an app call or a chapter
 * boundary, and `chapter` is simply unavailable on a file with no chapters.
 * `cache-buffering-state` is the exception — mpv republishes it while a stall
 * is filling — which is why the reducer quantises it and publishes it only
 * while the player is actually stalled (`PlayerState.bufferingPercent`), the
 * same treatment `demuxer-cache-time` gets and for the same reason.
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
  { name: MpvProperty.cacheBufferingState, format: 'number' },
  { name: MpvProperty.speed, format: 'number' },
  { name: MpvProperty.pitch, format: 'number' },
  { name: MpvProperty.chapter, format: 'number' },
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
