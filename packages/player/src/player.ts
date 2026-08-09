import type { PlayerError } from './errors'
import { PlayerErrorException, disposedError, toPlayerError } from './errors'
import type { LogEvent, PlayerEvent } from './events'
import { toPlayerEvents } from './events'
import { createMpvClient } from './native-client'
import {
  MPV_VOLUME_SCALE,
  MpvProperty,
  OBSERVED_PROPERTIES,
  isMetadataProperty,
  metadataByKeyProperty,
  metadataKeyProperty,
  metadataValueProperty,
} from './properties'
import type { LoopMode, PlayerState, ReducerContext } from './state'
import {
  createInitialState,
  isPositionDiscontinuity,
  projectPosition,
  reducePlayerState,
  withResyncedAnchor,
} from './state'
import type {
  MpvClient,
  MpvEvent,
  MpvFormat,
  MpvLogLevel,
} from './specs/mpv-client.nitro'

/**
 * A factory that produces a fresh, uninitialised {@link MpvClient}.
 *
 * Injecting this is what keeps the whole TypeScript layer testable without a
 * device: the test suite passes a fake and never loads
 * `react-native-nitro-modules`.
 */
export type MpvClientFactory = () => MpvClient

/** mpv log levels the core can be asked for, plus `'no'` to silence logging. */
export type PlayerLogLevel = MpvLogLevel | 'no'

/**
 * Which ReplayGain tag set to honour, mapped 1:1 onto mpv's `replaygain`
 * option (`--replaygain=<no|track|album>`).
 *
 * mpv 0.35.1 `options.rst`: "With `--replaygain=no` (the default), perform no
 * adjustment. With `--replaygain=track`, apply track gain. With
 * `--replaygain=album`, apply album gain if present and fall back to track gain
 * otherwise."
 */
export type ReplayGainMode = 'no' | 'track' | 'album'

/**
 * Loudness normalisation from the ReplayGain tags embedded in a file.
 *
 * Maps onto mpv's four `replaygain*` options. All four are runtime-settable:
 * each carries mpv's `UPDATE_VOL` flag (`options/options.c`, mpv 0.35.1), which
 * makes an option write re-run `audio_update_volume()` — so
 * {@link Player.setReplayGain} takes effect on the *currently playing* track,
 * without a reload.
 *
 * @remarks
 * ReplayGain needs tags in the file (`REPLAYGAIN_TRACK_GAIN` and friends).
 * Files without them get {@link fallback}, and nothing else — mpv's
 * `compute_replaygain()` takes the fallback branch *instead of* the tag branch,
 * which is what the manual means by "If this is applied, no other replaygain
 * options are applied."
 */
export interface ReplayGainOptions {
  /** Which tag set to use. `'no'` disables tag-based adjustment entirely. */
  readonly mode: ReplayGainMode
  /**
   * Extra gain in dB applied on top of the tag value (mpv
   * `replaygain-preamp`, default `0`).
   *
   * Must be within mpv's own range, `-150 … 150` (`options/options.c`,
   * `M_RANGE(-150, 150)`); anything else throws an `invalid-state`
   * {@link PlayerError} rather than being silently clamped.
   */
  readonly preamp?: number
  /**
   * Whether the gain is **allowed to clip** (mpv `replaygain-clip`, default
   * `false`).
   *
   * @remarks
   * The polarity is the opposite of what mpv 0.35.1's `options.rst` says.
   * That manual reads "Prevent clipping caused by replaygain by automatically
   * lowering the gain (default). Use `--replaygain-clip=no` to disable this",
   * but the code does `if (!opts->rgain_clip) { rgain = MPMIN(rgain, 1.0 /
   * peak); }` (`player/audio.c`, `compute_replaygain`) and the option's default
   * is `0` — i.e. clipping *prevention* is what you get by default, and setting
   * the option to `yes` turns the prevention off. mpv fixed the wording in
   * 0.38.0: "Allow the volume gain to clip (default: no). If this option is not
   * enabled, mpv automatically will prevent clipping by lowering the gain."
   * This field follows the behaviour, not the stale prose: leave it alone (or
   * pass `false`) to keep peak-limiting on.
   */
  readonly clip?: boolean
  /**
   * Gain in dB applied when the file carries no ReplayGain tags at all (mpv
   * `replaygain-fallback`, default `0`).
   *
   * Must be within mpv's own range, `-200 … 60` (`options/options.c`,
   * `M_RANGE(-200, 60)`).
   */
  readonly fallback?: number
}

/**
 * A read-only view of the current entry's tag map — mpv's `metadata` property.
 *
 * Keys are mpv's tag names as the demuxer reported them (`title`, `artist`,
 * `album`, `icy-title`, …); values are always strings.
 */
export type Metadata = Readonly<Record<string, string>>

/** Options for {@link Player.create}. */
export interface PlayerOptions {
  /**
   * Raw mpv options applied before `mpv_initialize()`.
   *
   * Audio-only defaults (`vid=no`, `force-window=no`, `idle=yes`,
   * `audio-display=no`) are applied natively first, and this library's own
   * option defaults (`user-agent`, see {@link DEFAULT_USER_AGENT}, and
   * `cache-secs`, see {@link DEFAULT_CACHE_SECS}) are merged underneath this
   * map — so anything here wins over all of them.
   *
   * @remarks
   * Option *order* is not preserved (the native layer takes a map), so
   * `profile` and `include` — whose effect depends on where they appear — are
   * not supported here. Set them with `setProperty*` after creation instead.
   */
  readonly mpvOptions?: Readonly<Record<string, string>>
  /** mpv log verbosity. Defaults to mpv's `warn`. */
  readonly logLevel?: PlayerLogLevel
  /**
   * HTTP `User-Agent` for network playback. Defaults to
   * {@link DEFAULT_USER_AGENT} rather than mpv's own `libmpv`, because real
   * streaming hosts blocklist the literal string `libmpv` (observed on-device:
   * a Shoutcast DNAS v2 server returning `401 Unauthorized` for exactly
   * `User-Agent: libmpv` while accepting any other value, including
   * `rn-media/0.1 (libmpv)`). A raw `mpvOptions['user-agent']` still wins over
   * this option.
   */
  readonly userAgent?: string
  /**
   * How far ahead the demuxer may read on a network stream, in seconds (mpv's
   * `cache-secs`).
   *
   * Defaults to {@link DEFAULT_CACHE_SECS} (30 s) — a deliberate override of
   * mpv's own 1000-hour default; read that constant's docs for the reasoning
   * and the trade-off. Must be a finite number `>= 0`, which is mpv's own
   * range for the option (`M_RANGE(0, DBL_MAX)`, `demux/demux.c`, mpv 0.35.1).
   *
   * A raw `mpvOptions['cache-secs']` still wins over this.
   */
  readonly cacheSecs?: number
  /**
   * Open the *next* playlist entry while the current one is finishing, so a
   * gapless transition does not have to pay for a fresh network connection
   * (mpv's `prefetch-playlist`, default `no`).
   *
   * @remarks
   * Quoting mpv 0.35.1 `options.rst` verbatim, because this option trades
   * correctness for latency and callers should opt in with their eyes open:
   *
   * > This merely opens the URL of the next playlist entry as soon the current
   * > URL is fully read. […] This can give subtly wrong results if per-file
   * > options are used, or if options are changed in the time window between
   * > prefetching start and next file played. This can occasionally make wrong
   * > prefetching decisions. For example, it can't predict whether you go
   * > backwards in the playlist, and assumes you won't edit the playlist.
   *
   * So: if your app mutates the queue (`playlist.move`, `playlist.remove`,
   * `playlist.shuffle`) or seeks backwards through it while a track is ending,
   * mpv may have already opened — and paid for — the wrong entry. It also does
   * not prefill the cache; only the current entry's data is cached.
   *
   * A raw `mpvOptions['prefetch-playlist']` still wins over this.
   */
  readonly prefetchPlaylist?: boolean
  /**
   * Loudness normalisation from the file's ReplayGain tags. See
   * {@link ReplayGainOptions}; change it later with
   * {@link Player.setReplayGain}.
   *
   * Raw `mpvOptions['replaygain*']` entries still win over this.
   */
  readonly replayGain?: ReplayGainOptions
  /** Initial volume in `0..1`. */
  readonly volume?: number
  /** Initial mute state. */
  readonly muted?: boolean
  /** Initial playback rate. */
  readonly rate?: number
  /** Initial repeat behaviour. */
  readonly loop?: LoopMode
  /**
   * Override how the underlying `MpvClient` is created.
   *
   * Production code never sets this; it exists so tests (and, later, the video
   * plugin) can supply their own client. When omitted, the real Nitro
   * HybridObject is loaded lazily — which is why nothing outside this default
   * path imports `react-native-nitro-modules`.
   */
  readonly createClient?: MpvClientFactory
  /**
   * Clock used for position projection and event timestamps.
   * Defaults to `Date.now`. Injected by tests.
   */
  readonly now?: () => number
}

/** Options for {@link Player.load}. */
export interface LoadOptions {
  /** Start playing immediately. Defaults to `true`. */
  readonly autoPlay?: boolean
  /** Start position in seconds (mpv's per-file `start` option). */
  readonly startPosition?: number
  /** Extra per-file mpv options, e.g. `{ 'audio-channels': 'stereo' }`. */
  readonly mpvOptions?: Readonly<Record<string, string>>
}

/** Options for {@link Player.loadPlaylist}. */
export interface LoadPlaylistOptions extends LoadOptions {
  /**
   * Which entry to start on. Defaults to `0`.
   *
   * Mutually exclusive with {@link shuffle} — see there.
   */
  readonly startIndex?: number
  /**
   * Shuffle the queue once it is built, before playback starts.
   *
   * The whole list is shuffled (mpv's `playlist-shuffle`, issued after every
   * entry has been appended and before the jump), and playback begins at the
   * first entry of the *shuffled* order.
   *
   * @remarks
   * **Combining this with {@link startIndex} throws** an `invalid-state`
   * {@link PlayerError}, because the two cannot both be honoured. mpv's
   * `playlist_shuffle()` permutes every entry — it does not pin the current one
   * or shuffle only an unplayed tail (`common/playlist.c`, mpv 0.35.1) — so
   * after the shuffle an index no longer identifies the source the caller
   * passed at that position. Silently reinterpreting `startIndex` as "position
   * 3 of a random permutation" would be a coin flip dressed up as an API.
   *
   * To get "shuffle, but start with *this* track", put that track first
   * yourself and shuffle the rest, or load in order and call
   * {@link PlaylistApi.shuffle} afterwards (which keeps the playing entry
   * playing).
   */
  readonly shuffle?: boolean
}

/** Payload of the `trackEnded` event. */
export interface TrackEndedEvent {
  /** Playlist index of the entry that finished, or `-1` if unknown. */
  readonly index: number
}

/** Payload of the `trackChanged` event. */
export interface TrackChangedEvent {
  /** Playlist index now current; `-1` when the playlist has no current entry. */
  readonly index: number
  /** The index that was current before. */
  readonly previousIndex: number
}

/**
 * Discrete events, as opposed to the whole-state subscription.
 *
 * `trackEnded` and `error` are deliberately distinct: a natural end of stream
 * and a premature/failed one are different facts, and mapping mpv's `end-file`
 * onto them lives in `errors.ts`.
 */
export interface PlayerEventMap {
  /** A playlist entry reached its natural end (mpv `end-file` reason `eof`). */
  trackEnded: (event: TrackEndedEvent) => void
  /** Playback failed. Also reflected in `state.error` with `status: 'error'`. */
  error: (error: PlayerError) => void
  /** The current playlist entry changed. */
  trackChanged: (event: TrackChangedEvent) => void
  /**
   * The current entry's metadata changed — a new track's tags, or a live
   * stream's now-playing update (ICY `StreamTitle`, which mpv surfaces as the
   * `icy-title` tag and folds into `media-title`).
   *
   * Fires at most once per native event batch, and **only while at least one
   * listener is registered**: building the map costs one property read per tag,
   * so a player nobody is asking pays nothing.
   */
  metadataChanged: (metadata: Metadata) => void
  /** An mpv log line, at or below the configured `logLevel`. */
  log: (event: LogEvent) => void
}

/** Name of a discrete event. */
export type PlayerEventName = keyof PlayerEventMap

/** Unsubscribes a listener. Safe to call more than once. */
export type Unsubscribe = () => void

/**
 * Queue manipulation, backed by mpv's own playlist (which is what makes
 * gapless transitions gapless — the next entry is demuxed before the current
 * one ends).
 */
export interface PlaylistApi {
  /**
   * Append a source to the end of the playlist.
   *
   * @param source - URI or file path.
   * @param options - `playNow: true` starts playback if nothing is playing
   * (mpv's `append-play`).
   *
   * @remarks
   * Carries the same `.m3u8`/`.m3u` `demuxer=lavf` guard as {@link Player.load}
   * — it is the identical `loadfile` command and the identical hazard.
   */
  add(source: string, options?: { readonly playNow?: boolean }): Promise<void>
  /**
   * Remove the entry at `index`.
   *
   * Removing the current entry stops it and starts the next one.
   */
  remove(index: number): Promise<void>
  /**
   * Move the entry at `from` so that it ends up at `to`.
   *
   * @remarks
   * mpv's `playlist-move` takes "the entry that `index1` should take the place
   * of", which is off by one for downward moves; this method takes ordinary
   * array semantics and does the adjustment.
   */
  move(from: number, to: number): Promise<void>
  /**
   * Jump to `index` and (re)start playback of it.
   *
   * @param index - Playlist index to make current.
   * @param options - `autoPlay: false` keeps the current pause state instead
   * of starting playback.
   *
   * @remarks
   * mpv's `playlist-play-index` restarts the *entry*, but `pause` is a global
   * player property it does not touch — so on a player that was loaded with
   * `autoPlay: false`, a bare jump used to select the entry, open the network
   * stream, fill the demuxer cache and then sit there silently. (Measured
   * on-device against a Shoutcast station: mpv logged `playback restart
   * complete @ 0.000000, audio=playing, video=eof (paused)` and the cache grew
   * past 45 s with nothing audible.) Jumping to an entry means playing it, so
   * this clears `pause` by default, exactly like {@link Player.load}.
   */
  jumpTo(
    index: number,
    options?: { readonly autoPlay?: boolean }
  ): Promise<void>
  /** Go to the next entry. */
  next(): Promise<void>
  /** Go to the previous entry. */
  previous(): Promise<void>
  /** Remove every entry except the one currently playing. */
  clear(): Promise<void>
  /**
   * Shuffle the queue in place (mpv's `playlist-shuffle`).
   *
   * @remarks
   * mpv 0.35.1 `input.rst`: "Shuffle the playlist. This is similar to what is
   * done on start if the `--shuffle` option is used."
   *
   * Two consequences worth knowing, both read off `playlist_shuffle()` in
   * mpv's `common/playlist.c`:
   *
   * - **Every entry is shuffled, including the one playing.** It is the *entry*
   *   mpv keeps current, not the index, so the current track keeps playing
   *   uninterrupted — but its `playlist-pos` almost certainly changes, which
   *   surfaces here as a {@link PlayerEventMap.trackChanged} event for a track
   *   that did not actually change. Treat that event as "the cursor moved", and
   *   re-read `state.playlist.index`.
   * - **Each shuffle overwrites the entries' recorded original order**, which is
   *   exactly why {@link unshuffle} can only undo the most recent one.
   */
  shuffle(): Promise<void>
  /**
   * Undo the most recent {@link shuffle} (mpv's `playlist-unshuffle`).
   *
   * @remarks
   * mpv 0.35.1 `input.rst` documents the limitation precisely: "Attempt to
   * revert the previous `playlist-shuffle` command. This works only once
   * (multiple successive `playlist-unshuffle` commands do nothing). May not
   * work correctly if new recursive playlists have been opened since a
   * `playlist-shuffle` command."
   *
   * Concretely: mpv restores the order by sorting on an `original_index`
   * stamped at shuffle time, so this is a one-level undo, not a history. If you
   * need to return to a user-visible order after several shuffles, keep that
   * order in your app and rebuild the queue with {@link Player.loadPlaylist}.
   *
   * Calling it when nothing was shuffled is harmless (mpv sorts an already
   * sorted list); it is not an error.
   */
  unshuffle(): Promise<void>
}

const DEFAULT_LOG_LEVEL: PlayerLogLevel = 'warn'

/**
 * Default HTTP User-Agent.
 *
 * mpv's own default is the bare string `libmpv`, which streaming hosts
 * blocklist (see {@link PlayerOptions.userAgent} for the observed 401). This
 * stays honest — it names the engine — without matching those exact-string
 * bans. Overridable per player via `userAgent`, or raw via
 * `mpvOptions['user-agent']`.
 */
export const DEFAULT_USER_AGENT = 'rn-media (libmpv)'

/**
 * Default `--cache-secs`, i.e. how far ahead the demuxer is allowed to read on
 * a network stream.
 *
 * mpv's own default is `1000 * 60 * 60` seconds (`demux/demux.c`,
 * `demux_conf.defaults.min_secs_cache`, mpv 0.35.1), and `demux.c` takes
 * `min_secs = MPMAX(demuxer-readahead-secs, cache-secs)` whenever the cache is
 * active — which `--cache=auto` makes true for anything that looks like a
 * network stream. The only brake left is `--demuxer-max-bytes`, whose default
 * is 150 MiB: on a 128 kbit/s radio stream that is ~2.7 hours of audio which
 * mpv will happily download, over mobile data, while *paused*. (Measured
 * on-device: a paused Shoutcast entry's `buffered` readout climbed past 45 s
 * and kept going.)
 *
 * 30 s is the balance point. It does not delay startup — how far ahead the
 * demuxer reads is independent of when playback starts, which is gated by the
 * AO queue (`--audio-buffer`, 0.2 s) and *not* by the cache, since
 * `--cache-pause-initial` defaults to `no` (mpv 0.35.1 `options.rst`). It
 * leaves 30 s of slack to ride out a mobile-network stall, and mpv only needs
 * `--cache-pause-wait` (1 s) buffered to resume after one. The cost is that a
 * stall longer than 30 s rebuffers where mpv's default would not have; that is
 * the deliberate trade for bounded memory and bounded data use.
 *
 * Override per player with `mpvOptions: { 'cache-secs': '…' }`.
 */
export const DEFAULT_CACHE_SECS = 30

/**
 * Our TS level names → mpv's `mpv_request_log_messages` strings.
 *
 * The TS union deliberately renames two levels (`verbose`, `debugging`) because
 * their natural spellings collide with C/Xcode macros when nitrogen upper-cases
 * enum members (see the spec). mpv itself only accepts `v` and `debug`, so the
 * rename must be undone here — passing the TS name through raw makes
 * `mpv_request_log_messages` fail and `Player.create` throw.
 */
const MPV_LOG_LEVEL_NAMES: Readonly<Record<PlayerLogLevel, string>> = {
  no: 'no',
  fatal: 'fatal',
  error: 'error',
  warn: 'warn',
  info: 'info',
  verbose: 'v',
  debugging: 'debug',
  trace: 'trace',
}

/**
 * `MPV_ERROR_PROPERTY_NOT_FOUND` (`mpv/client.h`).
 *
 * The native binding turns `MPV_ERROR_PROPERTY_UNAVAILABLE` into `undefined`
 * but throws on every other negative status — and mpv answers a missing
 * *sub*-property (`metadata/by-key/nope`) with `M_PROPERTY_UNKNOWN`, which
 * `translate_property_error()` maps to this. "That tag isn't present" is not an
 * error condition for a metadata reader, so this one errno is folded back into
 * `undefined`.
 */
const MPV_ERRNO_PROPERTY_NOT_FOUND = -8

/** mpv's own clamp on `replaygain-preamp` (`options/options.c`, mpv 0.35.1). */
const REPLAY_GAIN_PREAMP_MIN = -150
const REPLAY_GAIN_PREAMP_MAX = 150

/** mpv's own clamp on `replaygain-fallback` (`options/options.c`, mpv 0.35.1). */
const REPLAY_GAIN_FALLBACK_MIN = -200
const REPLAY_GAIN_FALLBACK_MAX = 60

/** Every accepted {@link ReplayGainMode}, for runtime validation. */
const REPLAY_GAIN_MODES: readonly ReplayGainMode[] = ['no', 'track', 'album']

/**
 * An argument this library rejects before it can reach mpv.
 *
 * `invalid-state` is the taxonomy's slot for "this call cannot be honoured as
 * made"; using it keeps every failure a typed {@link PlayerError} instead of a
 * bare `TypeError`.
 */
function invalidArgument(message: string): PlayerErrorException {
  return new PlayerErrorException({ code: 'invalid-state', message })
}

/** mpv spells booleans `yes`/`no` in option strings. */
function yesNo(value: boolean): string {
  return value ? 'yes' : 'no'
}

function assertInRange(
  value: number,
  min: number,
  max: number,
  option: string
): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw invalidArgument(
      `\`${option}\` must be a finite number between ${min} and ${max} (mpv's own range); got ${value}.`
    )
  }
}

/**
 * Validate a {@link ReplayGainOptions} against mpv's documented value domains.
 *
 * Done here rather than left to mpv so that a bad value is a typed, testable
 * error at the call site instead of a `[mpv:-4]` string from deep inside
 * `mpv_set_option_string`.
 */
function assertReplayGain(options: ReplayGainOptions): void {
  if (!REPLAY_GAIN_MODES.includes(options.mode)) {
    throw invalidArgument(
      `\`replayGain.mode\` must be one of ${REPLAY_GAIN_MODES.map((mode) => `'${mode}'`).join(', ')}; got '${String(options.mode)}'.`
    )
  }
  if (options.preamp !== undefined) {
    assertInRange(
      options.preamp,
      REPLAY_GAIN_PREAMP_MIN,
      REPLAY_GAIN_PREAMP_MAX,
      'replayGain.preamp'
    )
  }
  if (options.fallback !== undefined) {
    assertInRange(
      options.fallback,
      REPLAY_GAIN_FALLBACK_MIN,
      REPLAY_GAIN_FALLBACK_MAX,
      'replayGain.fallback'
    )
  }
}

/**
 * The pre-init mpv option entries for a {@link ReplayGainOptions}.
 *
 * Only the fields the caller actually set are emitted, so an unset `preamp`
 * leaves mpv's default in place rather than pinning it to `0`.
 */
function replayGainOptions(
  options: ReplayGainOptions | undefined
): Record<string, string> {
  if (options === undefined) return {}
  const mapped: Record<string, string> = {
    [MpvProperty.replayGain]: options.mode,
  }
  if (options.preamp !== undefined) {
    mapped[MpvProperty.replayGainPreamp] = String(options.preamp)
  }
  if (options.clip !== undefined) {
    mapped[MpvProperty.replayGainClip] = yesNo(options.clip)
  }
  if (options.fallback !== undefined) {
    mapped[MpvProperty.replayGainFallback] = String(options.fallback)
  }
  return mapped
}

/**
 * Reject impossible {@link PlayerOptions} before an mpv core is even created.
 *
 * Validating up front means a typo costs no `mpv_create()`/`mpv_terminate`
 * cycle, and the thrown error is the typed one rather than mpv's option parser
 * complaining after the fact.
 */
function assertPlayerOptions(options: PlayerOptions): void {
  const cacheSecs = options.cacheSecs
  // mpv's own domain is `M_RANGE(0, DBL_MAX)` (`demux/demux.c`), so the only
  // rejects here are negatives and non-finite values.
  if (
    cacheSecs !== undefined &&
    (!Number.isFinite(cacheSecs) || cacheSecs < 0)
  ) {
    throw invalidArgument(
      `\`cacheSecs\` must be a finite number >= 0 (mpv's own range for \`cache-secs\`); got ${cacheSecs}.`
    )
  }
  if (options.replayGain !== undefined) assertReplayGain(options.replayGain)
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/** The mpv option name callers override to opt out of {@link HLS_DEMUXER}. */
const DEMUXER_OPTION = 'demuxer'

/**
 * The demuxer forced on `.m3u8` / `.m3u` sources. See {@link needsHlsDemuxer}.
 */
const HLS_DEMUXER = 'lavf'

/**
 * Whether `source`'s *path* ends in a playlist extension mpv would hand to its
 * own playlist demuxer.
 *
 * Query strings and fragments are ignored, because CDNs sign HLS URLs
 * (`…/master.m3u8?token=…`) and the extension is still the last thing in the
 * path.
 */
function needsHlsDemuxer(source: string): boolean {
  const end = source.search(/[?#]/u)
  const path = (end === -1 ? source : source.slice(0, end)).toLowerCase()
  return path.endsWith('.m3u8') || path.endsWith('.m3u')
}

/**
 * Build the third `loadfile` argument — mpv's per-file option list, which is
 * `opt1=value1,opt2=value2,…` (mpv 0.35.1 `input.rst`, `loadfile`).
 *
 * @remarks
 * This is also where the HLS guard lives. mpv's *playlist* demuxer claims
 * `.m3u8`/`.m3u` by extension and expands the URL into playlist entries, so a
 * single `loadfile` of an HLS master playlist detonates the queue: measured
 * on-device, `playlist-count` went 3 → 23 as every variant and segment line
 * became its own entry. Pinning `demuxer=lavf` for those sources keeps mpv on
 * libavformat, which either plays the stream (once the libmpv build ships the
 * `hls` demuxer) or fails cleanly with a typed `unsupported-format` error —
 * both of which are honest, unlike a silently exploded playlist.
 *
 * A caller who passes their own `demuxer` in `mpvOptions` wins: this is a
 * default, not a policy.
 */
function formatFileOptions(
  options: Readonly<Record<string, string>> | undefined,
  startPosition: number | undefined,
  source: string
): string | undefined {
  const parts: string[] = []
  if (startPosition !== undefined) parts.push(`start=${startPosition}`)
  if (options?.[DEMUXER_OPTION] === undefined && needsHlsDemuxer(source)) {
    parts.push(`${DEMUXER_OPTION}=${HLS_DEMUXER}`)
  }
  for (const [key, value] of Object.entries(options ?? {})) {
    parts.push(`${key}=${value}`)
  }
  return parts.length > 0 ? parts.join(',') : undefined
}

/**
 * The typed audio player.
 *
 * One `Player` owns one mpv core. There is no singleton: create as many as you
 * need, and `destroy()` each when you are done.
 *
 * @example
 * ```ts
 * const player = await Player.create({ volume: 0.8 })
 * const stop = player.onStateChange((state) => console.log(state.status))
 * await player.load('https://example.com/track.flac')
 * player.play()
 * // …
 * stop()
 * player.destroy()
 * ```
 */
export class Player {
  readonly #client: MpvClient
  readonly #now: () => number
  #state: PlayerState
  #currentUri: string | undefined
  #destroyed = false

  readonly #stateListeners = new Set<(state: PlayerState) => void>()
  readonly #eventListeners: {
    [K in PlayerEventName]: Set<PlayerEventMap[K]>
  } = {
    trackEnded: new Set(),
    error: new Set(),
    trackChanged: new Set(),
    metadataChanged: new Set(),
    log: new Set(),
  }

  private constructor(client: MpvClient, now: () => number) {
    this.#client = client
    this.#now = now
    this.#state = createInitialState(now())
  }

  /**
   * Create and start a player.
   *
   * Applies the pre-init mpv options, starts the core, registers the batched
   * event listener, installs every property observation, and applies the
   * initial volume/rate/mute/loop settings.
   *
   * @param options - See {@link PlayerOptions}.
   * @throws {@link PlayerErrorException} with code `invalid-state` if a typed
   * option is out of mpv's documented range (checked before any core is
   * created), or with a mapped mpv error if mpv rejects an option or fails to
   * initialise — in which case the half-built core is torn down first.
   */
  static async create(options: PlayerOptions = {}): Promise<Player> {
    // Before `factory()`: an out-of-range option should not cost an
    // `mpv_create()` / `mpv_terminate_destroy()` round trip.
    assertPlayerOptions(options)

    // Statically imported, deliberately. A dynamic `import()` here used to keep
    // `react-native-nitro-modules` out of the unit-test process, but Metro
    // compiles `import()` into a *split bundle fetched over HTTP in dev*, which
    // puts a live Metro connection on the critical path of every
    // `Player.create()` — and breaks outright when the package resolves to a
    // path above the app's Metro project root (the URL escapes the server root:
    // `/../../packages/player/src/native-client.bundle`). Tests keep native out
    // of the process with a vitest alias instead, exactly like the other two
    // packages do.
    const factory = options.createClient ?? createMpvClient
    const now = options.now ?? Date.now
    const client = factory()
    const player = new Player(client, now)

    try {
      client.setEventBatchListener((events) => player.#handleBatch(events))
      client.initialize({
        // Precedence, weakest first: this library's defaults, then the typed
        // options above them, then the caller's raw `mpvOptions`, which win
        // over everything. (`log-level` is last because it is not an mpv
        // option at all — the native layer consumes that reserved key.)
        'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
        [MpvProperty.cacheSecs]: String(
          options.cacheSecs ?? DEFAULT_CACHE_SECS
        ),
        ...(options.prefetchPlaylist === undefined
          ? {}
          : {
              [MpvProperty.prefetchPlaylist]: yesNo(options.prefetchPlaylist),
            }),
        ...replayGainOptions(options.replayGain),
        ...(options.mpvOptions ?? {}),
        'log-level': MPV_LOG_LEVEL_NAMES[options.logLevel ?? DEFAULT_LOG_LEVEL],
      })
      for (const property of OBSERVED_PROPERTIES) {
        client.observeProperty(property.name, property.format)
      }
      if (options.volume !== undefined) player.setVolume(options.volume)
      if (options.muted !== undefined) player.setMuted(options.muted)
      if (options.rate !== undefined) player.setRate(options.rate)
      if (options.loop !== undefined) player.setLoop(options.loop)
    } catch (thrown) {
      player.destroy()
      throw new PlayerErrorException(toPlayerError(thrown))
    }

    return player
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** The current immutable snapshot. */
  get state(): PlayerState {
    return this.#state
  }

  /** Whether {@link destroy} has been called. */
  get destroyed(): boolean {
    return this.#destroyed
  }

  /**
   * Subscribe to whole-state changes.
   *
   * Fires at most once per native event batch, and only when the reducer
   * actually produced a new snapshot.
   *
   * @param listener - Called with the new snapshot.
   * @returns A function that removes the listener.
   */
  onStateChange(listener: (state: PlayerState) => void): Unsubscribe {
    this.#stateListeners.add(listener)
    return () => {
      this.#stateListeners.delete(listener)
    }
  }

  /**
   * Subscribe to a discrete event.
   *
   * @param event - One of {@link PlayerEventName}.
   * @param listener - Called with that event's payload.
   * @returns A function that removes the listener.
   */
  on<K extends PlayerEventName>(
    event: K,
    listener: PlayerEventMap[K]
  ): Unsubscribe {
    const set: Set<PlayerEventMap[K]> = this.#eventListeners[event]
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  /**
   * The playback position in seconds, projected locally from the last anchor.
   *
   * `time-pos` is never observed and never polled natively: mpv publishes the
   * truth on discontinuities and this extrapolates between them. See
   * `docs/specs/player-core.md` §3.
   */
  getPosition(): number {
    return projectPosition(this.#state, this.#now())
  }

  /**
   * Re-anchor the projected position on an exact `time-pos` read.
   *
   * One synchronous property read, no polling. `useProgress` calls it once
   * when it subscribes so that a component mounting mid-playback starts from
   * the truth rather than from an anchor that may be seconds old.
   *
   * @returns The position in seconds after the resync.
   */
  resyncPosition(): number {
    this.#assertAlive('resyncPosition')
    const now = this.#now()
    const exact = this.#readTimePos()
    if (exact === undefined) return projectPosition(this.#state, now)

    const next = withResyncedAnchor(this.#state, exact, now)
    if (next !== this.#state) {
      this.#state = next
      for (const listener of [...this.#stateListeners]) listener(next)
    }
    return projectPosition(next, now)
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * Replace whatever is playing with a single source.
   *
   * @param source - URI (`https://…`) or absolute file path.
   * @param options - See {@link LoadOptions}.
   *
   * @remarks
   * A source whose path ends in `.m3u8`/`.m3u` is loaded with `demuxer=lavf`
   * forced, unless `options.mpvOptions` already names a `demuxer` — see
   * {@link formatFileOptions} for why.
   */
  async load(source: string, options: LoadOptions = {}): Promise<void> {
    this.#assertAlive('load')
    this.#currentUri = source
    if (options.autoPlay === false) {
      this.#setBool(MpvProperty.pause, true)
    } else if (options.autoPlay === true) {
      this.#setBool(MpvProperty.pause, false)
    }
    const fileOptions = formatFileOptions(
      options.mpvOptions,
      options.startPosition,
      source
    )
    const args = ['loadfile', source, 'replace']
    if (fileOptions !== undefined) args.push(fileOptions)
    await this.command(args)
  }

  /**
   * Replace the playlist with `sources` and start at `startIndex`.
   *
   * Uses mpv's own playlist, so transitions between entries are gapless.
   *
   * @param sources - URIs or file paths, in order.
   * @param options - See {@link LoadPlaylistOptions}.
   *
   * @throws {@link PlayerErrorException} with code `invalid-state` when both
   * `shuffle: true` and an explicit `startIndex` are given — see
   * {@link LoadPlaylistOptions.shuffle}.
   *
   * @remarks
   * The `.m3u8`/`.m3u` `demuxer=lavf` guard described on {@link load} is
   * applied to each entry independently.
   *
   * With `shuffle: true` the URI this player remembers for error classification
   * is `sources[0]`, which after the shuffle is probably not what starts
   * playing. That is a hint, not a contract — the same staleness already
   * applies after any `playlist.next()` — and it only affects whether a failure
   * is reported as `network` or `load-failed`.
   */
  async loadPlaylist(
    sources: readonly string[],
    options: LoadPlaylistOptions = {}
  ): Promise<void> {
    this.#assertAlive('loadPlaylist')
    if (options.shuffle === true && options.startIndex !== undefined) {
      throw invalidArgument(
        '`shuffle` and `startIndex` cannot be combined: mpv shuffles the whole ' +
          'playlist, so an index no longer identifies the source you passed at ' +
          'that position. Shuffle the sources yourself, or load in order and ' +
          'call `playlist.shuffle()` afterwards.'
      )
    }
    const startIndex = options.startIndex ?? 0
    this.#currentUri = sources[startIndex] ?? sources[0]

    if (options.autoPlay === false) {
      this.#setBool(MpvProperty.pause, true)
    } else if (options.autoPlay === true) {
      this.#setBool(MpvProperty.pause, false)
    }

    // `stop` clears the playlist outright, so the queue is built from a clean
    // slate; `loadfile … replace` would start entry 0 before we could jump.
    await this.command(['stop'])
    if (sources.length === 0) return

    for (const source of sources) {
      // Per entry, not once for the whole queue: the HLS guard is decided by
      // each source's own extension, so a `.m3u8` next to a `.mp3` gets the
      // forced demuxer and the `.mp3` does not.
      const fileOptions = formatFileOptions(
        options.mpvOptions,
        options.startPosition,
        source
      )
      const args = ['loadfile', source, 'append']
      if (fileOptions !== undefined) args.push(fileOptions)
      await this.command(args)
    }
    // Shuffle before the jump, never after: the jump is what starts playback,
    // and shuffling a playing queue would renumber the entry mpv just started.
    // Nothing has played yet at this point, so "shuffle the whole list" and
    // "shuffle what's left to play" are the same thing here.
    if (options.shuffle === true) await this.command(['playlist-shuffle'])
    await this.command(['playlist-play-index', String(startIndex)])
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /** Resume playback (`pause = no`). */
  play(): void {
    this.#assertAlive('play')
    this.#setBool(MpvProperty.pause, false)
  }

  /** Pause playback (`pause = yes`). */
  pause(): void {
    this.#assertAlive('pause')
    this.#setBool(MpvProperty.pause, true)
  }

  /** Flip between playing and paused, based on the current snapshot. */
  toggle(): void {
    this.#assertAlive('toggle')
    this.#setBool(MpvProperty.pause, this.#state.playing)
  }

  /**
   * Seek to an absolute position.
   *
   * Uses mpv's `seek <seconds> absolute+exact`, i.e. a precise seek rather
   * than the nearest keyframe.
   *
   * @param seconds - Target position; negative values are clamped to `0`.
   */
  async seekTo(seconds: number): Promise<void> {
    this.#assertAlive('seekTo')
    const target = seconds > 0 ? seconds : 0
    await this.command(['seek', String(target), 'absolute+exact'])
  }

  /**
   * Set the playback rate.
   *
   * @param rate - Multiplier. Clamped to mpv's documented `0.01 … 100`.
   */
  setRate(rate: number): void {
    this.#assertAlive('setRate')
    this.#setNumber(MpvProperty.speed, clamp(rate, 0.01, 100))
  }

  /**
   * Read the output volume, in the same `0..1` scale {@link setVolume} takes.
   *
   * Reads mpv directly rather than returning `state.volume`: the observed
   * `volume` property arrives asynchronously in the next event batch, so a read
   * immediately after a write would still see the old value. Anything doing
   * read-modify-restore (`wireAudioSession`'s ducking, for one) needs the
   * truth, not the last broadcast. Falls back to the snapshot if mpv reports
   * the property unavailable.
   *
   * @returns Volume in `0..1`.
   */
  getVolume(): number {
    this.#assertAlive('getVolume')
    const raw = this.#guard(() =>
      this.#client.getPropertyNumber(MpvProperty.volume)
    )
    return raw === undefined ? this.#state.volume : raw / MPV_VOLUME_SCALE
  }

  /**
   * Set the output volume.
   *
   * @param volume - `0..1`, where `1` is mpv's `volume=100` (no attenuation
   * and no amplification). Values outside the range are clamped; use
   * `setPropertyNumber('volume', …)` if you really want mpv's amplification
   * range above 100.
   *
   * @remarks
   * mpv's volume curve is `gain = (volume / 100) ** 3`, so `0.5` is much
   * quieter than half as loud.
   */
  setVolume(volume: number): void {
    this.#assertAlive('setVolume')
    this.#setNumber(MpvProperty.volume, clamp(volume, 0, 1) * MPV_VOLUME_SCALE)
  }

  /** Mute or unmute output. */
  setMuted(muted: boolean): void {
    this.#assertAlive('setMuted')
    this.#setBool(MpvProperty.mute, muted)
  }

  /**
   * Set repeat behaviour.
   *
   * @param mode - `'track'` repeats the current entry forever, `'playlist'`
   * repeats the whole queue forever, `'off'` disables both.
   */
  setLoop(mode: LoopMode): void {
    this.#assertAlive('setLoop')
    // mpv counts *seeks back to start*, not playthroughs, so a finite count
    // would be surprising. Only "forever" and "off" are exposed.
    this.#setString(MpvProperty.loopFile, mode === 'track' ? 'inf' : 'no')
    this.#setString(
      MpvProperty.loopPlaylist,
      mode === 'playlist' ? 'inf' : 'no'
    )
  }

  // -------------------------------------------------------------------------
  // Playlist
  // -------------------------------------------------------------------------

  /** Queue manipulation. See {@link PlaylistApi}. */
  readonly playlist: PlaylistApi = {
    add: async (source, options) => {
      this.#assertAlive('playlist.add')
      const args = [
        'loadfile',
        source,
        options?.playNow === true ? 'append-play' : 'append',
      ]
      const fileOptions = formatFileOptions(undefined, undefined, source)
      if (fileOptions !== undefined) args.push(fileOptions)
      await this.command(args)
    },
    remove: async (index) => {
      this.#assertAlive('playlist.remove')
      await this.command(['playlist-remove', String(index)])
    },
    move: async (from, to) => {
      this.#assertAlive('playlist.move')
      // mpv: "Move the playlist entry at index1, so that it takes the place of
      // the entry index2." For a downward move the target must therefore be
      // shifted by one to land where an array `splice` would put it.
      const target = to > from ? to + 1 : to
      await this.command(['playlist-move', String(from), String(target)])
    },
    jumpTo: async (index, options) => {
      this.#assertAlive('playlist.jumpTo')
      // Order matters: clear `pause` before the jump so mpv's own playback
      // restart already runs with the right intent and cannot publish a
      // paused-then-playing flicker to observers.
      if (options?.autoPlay !== false) this.#setBool(MpvProperty.pause, false)
      // `playlist-play-index` rather than writing `playlist-pos`: mpv
      // guarantees playback restarts even when jumping to the current entry.
      await this.command(['playlist-play-index', String(index)])
    },
    next: async () => {
      this.#assertAlive('playlist.next')
      await this.command(['playlist-next', 'weak'])
    },
    previous: async () => {
      this.#assertAlive('playlist.previous')
      await this.command(['playlist-prev', 'weak'])
    },
    clear: async () => {
      this.#assertAlive('playlist.clear')
      await this.command(['playlist-clear'])
    },
    shuffle: async () => {
      this.#assertAlive('playlist.shuffle')
      await this.command(['playlist-shuffle'])
    },
    unshuffle: async () => {
      this.#assertAlive('playlist.unshuffle')
      await this.command(['playlist-unshuffle'])
    },
  }

  // -------------------------------------------------------------------------
  // Loudness
  // -------------------------------------------------------------------------

  /**
   * Change ReplayGain normalisation on the fly.
   *
   * All four mpv options behind this carry `UPDATE_VOL`, so the new gain is
   * applied to the track that is already playing — no reload, no gap.
   *
   * Only the fields you pass are written: `setReplayGain({ mode: 'album' })`
   * switches tag set and leaves preamp, clipping and fallback exactly as they
   * were. Pass `mode: 'no'` to stop honouring tags at all.
   *
   * @param options - See {@link ReplayGainOptions}.
   * @throws {@link PlayerErrorException} with code `invalid-state` if `mode` is
   * not a {@link ReplayGainMode} or a gain is outside mpv's range.
   */
  setReplayGain(options: ReplayGainOptions): void {
    this.#assertAlive('setReplayGain')
    assertReplayGain(options)
    this.#setString(MpvProperty.replayGain, options.mode)
    if (options.preamp !== undefined) {
      this.#setNumber(MpvProperty.replayGainPreamp, options.preamp)
    }
    if (options.clip !== undefined) {
      this.#setBool(MpvProperty.replayGainClip, options.clip)
    }
    if (options.fallback !== undefined) {
      this.#setNumber(MpvProperty.replayGainFallback, options.fallback)
    }
  }

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  /**
   * The current entry's tag map (mpv's `metadata`).
   *
   * @returns Every tag mpv currently reports, or `{}` when nothing is loaded
   * (mpv answers `metadata` with "property unavailable" while there is no
   * demuxer).
   *
   * @remarks
   * Built by walking mpv's documented scalar sub-properties —
   * `metadata/list/count`, then `metadata/list/N/key` and
   * `metadata/list/N/value` for each `N` (mpv 0.35.1 `input.rst`). No string
   * parsing is involved anywhere: the map property itself is deliberately never
   * read, because the manual states "Trying to retrieve this property as a raw
   * string doesn't work", and a typed API must not rest on behaviour its own
   * documentation disclaims.
   *
   * The cost is `2N + 1` synchronous property reads, which is why this is a
   * pull, not a field of `PlayerState`. It is also **not atomic**: if mpv
   * republished the tags mid-walk (which only happens on a metadata update) the
   * result could mix two generations. Call it again from
   * {@link PlayerEventMap.metadataChanged} and the fresh map wins.
   *
   * For a single tag, {@link getMetadataValue} is one read instead of `2N + 1`.
   */
  getMetadata(): Metadata {
    this.#assertAlive('getMetadata')
    const count = this.#readMetadataCount()
    const metadata: Record<string, string> = {}
    for (let index = 0; index < count; index += 1) {
      const key = this.#readOptionalString(metadataKeyProperty(index))
      if (key === undefined || key === '') continue
      metadata[key] =
        this.#readOptionalString(metadataValueProperty(index)) ?? ''
    }
    return metadata
  }

  /**
   * One tag of the current entry, by name (mpv's `metadata/by-key/<key>`).
   *
   * @param key - Tag name. mpv matches these case-insensitively
   * (`mp_tags_get_bstr`), so `'Title'` and `'title'` find the same tag.
   * @returns The tag's value, or `undefined` when the entry has no such tag
   * (or nothing is loaded).
   *
   * @example
   * ```ts
   * // Radio now-playing, straight from the ICY stream.
   * player.getMetadataValue('icy-title')
   * ```
   */
  getMetadataValue(key: string): string | undefined {
    this.#assertAlive('getMetadataValue')
    return this.#readOptionalString(metadataByKeyProperty(key))
  }

  // -------------------------------------------------------------------------
  // Raw escape hatches
  // -------------------------------------------------------------------------

  /**
   * Run an arbitrary mpv command.
   *
   * @param args - Command name followed by its arguments, all as strings.
   * @throws {@link PlayerErrorException} with a typed {@link PlayerError}.
   */
  async command(args: readonly string[]): Promise<void> {
    this.#assertAlive('command')
    try {
      await this.#client.command([...args])
    } catch (thrown) {
      throw new PlayerErrorException(toPlayerError(thrown, this.#currentUri))
    }
  }

  /** Read any mpv property as a string. `undefined` when unavailable. */
  getPropertyString(name: string): string | undefined {
    this.#assertAlive('getPropertyString')
    return this.#guard(() => this.#client.getPropertyString(name))
  }

  /** Read any mpv property as a number. `undefined` when unavailable. */
  getPropertyNumber(name: string): number | undefined {
    this.#assertAlive('getPropertyNumber')
    return this.#guard(() => this.#client.getPropertyNumber(name))
  }

  /** Read any mpv property as a boolean. `undefined` when unavailable. */
  getPropertyBool(name: string): boolean | undefined {
    this.#assertAlive('getPropertyBool')
    return this.#guard(() => this.#client.getPropertyBool(name))
  }

  /** Write any mpv property from a string. */
  setPropertyString(name: string, value: string): void {
    this.#assertAlive('setPropertyString')
    this.#setString(name, value)
  }

  /** Write any mpv property from a number. */
  setPropertyNumber(name: string, value: number): void {
    this.#assertAlive('setPropertyNumber')
    this.#setNumber(name, value)
  }

  /** Write any mpv property from a boolean. */
  setPropertyBool(name: string, value: boolean): void {
    this.#assertAlive('setPropertyBool')
    this.#setBool(name, value)
  }

  /**
   * Observe an extra mpv property.
   *
   * Its changes arrive as `kind: 'property'` events. The built-in reducer
   * ignores names it does not know, so use `onStateChange` plus your own
   * bookkeeping, or read the property when you need it.
   *
   * @param name - mpv property name.
   * @param format - The format to receive it in.
   */
  observeProperty(name: string, format: MpvFormat): void {
    this.#assertAlive('observeProperty')
    this.#guard(() => {
      this.#client.observeProperty(name, format)
    })
  }

  /** Stop observing a property added with {@link observeProperty}. */
  unobserveProperty(name: string): void {
    this.#assertAlive('unobserveProperty')
    this.#guard(() => {
      this.#client.unobserveProperty(name)
    })
  }

  /**
   * The underlying `mpv_handle*` as an integer, for the future video plugin.
   *
   * @returns The handle as a `bigint` (Nitro's `UInt64`).
   */
  getRawHandle(): bigint {
    this.#assertAlive('getRawHandle')
    return this.#guard(() => this.#client.getRawHandle())
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /**
   * Destroy the player and its mpv core. Idempotent.
   *
   * After this, every method throws a `disposed` {@link PlayerError}, all
   * listeners are dropped, and the native batch listener detaches itself by
   * returning `false` on its next invocation (the back-pressure contract in
   * `docs/specs/player-core.md` §2.5).
   */
  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#stateListeners.clear()
    for (const listeners of Object.values(this.#eventListeners)) {
      listeners.clear()
    }
    try {
      this.#client.destroy()
    } catch {
      // `destroy()` is documented never to throw; if a client does anyway,
      // swallowing it here is the only way to keep destroy idempotent and
      // total. Nothing downstream can act on it.
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The batched event listener.
   *
   * @returns `true` to keep receiving batches, `false` once destroyed.
   */
  #handleBatch(events: MpvEvent[]): boolean {
    if (this.#destroyed) return false

    const mapped = toPlayerEvents(events)
    if (mapped.length === 0) return true

    const context: ReducerContext = {
      now: this.#now(),
      ...(mapped.some(isPositionDiscontinuity)
        ? { timePos: this.#readTimePos() }
        : {}),
      ...(this.#currentUri !== undefined ? { uri: this.#currentUri } : {}),
    }

    const previous = this.#state
    let next = previous
    const emissions: Array<() => void> = []

    for (const event of mapped) {
      const after = reducePlayerState(next, event, context)
      this.#collectEmissions(next, after, event, emissions)
      next = after
    }

    this.#collectMetadataEmission(mapped, emissions)

    if (next !== previous) {
      this.#state = next
      for (const listener of [...this.#stateListeners]) listener(next)
    }
    for (const emit of emissions) emit()

    return !this.#destroyed
  }

  /**
   * Derive the discrete events for one reducer step.
   *
   * Uses both the pre- and post-reduction snapshot so that `trackEnded` and
   * `trackChanged` can report the index that was current when the event
   * happened, without re-running the reducer.
   */
  #collectEmissions(
    before: PlayerState,
    after: PlayerState,
    event: PlayerEvent,
    out: Array<() => void>
  ): void {
    switch (event.kind) {
      case 'endFile': {
        if (after.status === 'ended') {
          const index = before.playlist.index
          out.push(() => {
            this.#emit('trackEnded', { index })
          })
        } else if (after.status === 'error' && after.error !== undefined) {
          const error = after.error
          out.push(() => {
            this.#emit('error', error)
          })
        }
        return
      }
      case 'property': {
        if (event.name !== MpvProperty.playlistPos) return
        const index = after.playlist.index
        const previousIndex = before.playlist.index
        if (index === previousIndex) return
        out.push(() => {
          this.#emit('trackChanged', { index, previousIndex })
        })
        return
      }
      case 'log': {
        const logEvent = event
        out.push(() => {
          this.#emit('log', logEvent)
        })
        return
      }
      case 'startFile':
      case 'seek':
      case 'playbackRestart':
      case 'shutdown':
        return
      default: {
        const exhaustive = event
        exhaustive satisfies never
      }
    }
  }

  /**
   * Queue at most one `metadataChanged` emission for the batch.
   *
   * Per batch, not per event, because mpv invalidates `metadata` and
   * `media-title` together — a single tag update would otherwise fire twice.
   * The map is built only when someone is listening: `getMetadata()` costs one
   * property read per tag, and there is no point paying it for nobody.
   */
  #collectMetadataEmission(
    events: readonly PlayerEvent[],
    out: Array<() => void>
  ): void {
    if (this.#eventListeners.metadataChanged.size === 0) return
    const changed = events.some(
      (event) => event.kind === 'property' && isMetadataProperty(event.name)
    )
    if (!changed) return

    let metadata: Metadata
    try {
      metadata = this.getMetadata()
    } catch {
      // Reading tags failed mid-batch (the core may be tearing down). There is
      // no caller to hand this to — a `metadataChanged` listener asked about
      // metadata, not about mpv's property errors — and the next update will
      // try again, so the emission is simply skipped.
      return
    }
    out.push(() => {
      this.#emit('metadataChanged', metadata)
    })
  }

  #emit<K extends PlayerEventName>(
    name: K,
    payload: Parameters<PlayerEventMap[K]>[0]
  ): void {
    for (const listener of [...this.#eventListeners[name]]) {
      // Each listener is typed by its own key; the cast is confined here.
      ;(listener as (value: typeof payload) => void)(payload)
    }
  }

  /**
   * `metadata/list/count`, normalised to a non-negative integer.
   *
   * `0` covers both "no tags" and "nothing loaded" (mpv reports the whole
   * `metadata` property unavailable while there is no demuxer, which the native
   * binding turns into `undefined`).
   */
  #readMetadataCount(): number {
    const raw = this.#readOptionalNumber(MpvProperty.metadataCount)
    if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return 0
    return Math.trunc(raw)
  }

  /**
   * Read a string property, treating "no such property" as `undefined`.
   *
   * See {@link MPV_ERRNO_PROPERTY_NOT_FOUND}: an absent metadata key is a
   * normal answer, not a failure. Anything else still throws typed.
   */
  #readOptionalString(name: string): string | undefined {
    return this.#readOptional(() => this.#client.getPropertyString(name))
  }

  /** {@link #readOptionalString}, for numeric properties. */
  #readOptionalNumber(name: string): number | undefined {
    return this.#readOptional(() => this.#client.getPropertyNumber(name))
  }

  #readOptional<T>(read: () => T | undefined): T | undefined {
    try {
      return read()
    } catch (thrown) {
      const error = toPlayerError(thrown, this.#currentUri)
      if (
        error.code === 'mpv' &&
        error.errno === MPV_ERRNO_PROPERTY_NOT_FOUND
      ) {
        return undefined
      }
      throw new PlayerErrorException(error)
    }
  }

  /**
   * One synchronous `time-pos` read, used only on a position discontinuity.
   *
   * This is not polling: it happens at most once per batch, and only when the
   * batch contained a `playbackRestart`.
   */
  #readTimePos(): number | undefined {
    try {
      return this.#client.getPropertyNumber(MpvProperty.timePos)
    } catch {
      // The core may already be tearing down; an absent anchor just means the
      // reducer keeps extrapolating from the previous one.
      return undefined
    }
  }

  #assertAlive(operation: string): void {
    if (this.#destroyed) {
      throw new PlayerErrorException(disposedError(operation))
    }
  }

  #guard<T>(call: () => T): T {
    try {
      return call()
    } catch (thrown) {
      throw new PlayerErrorException(toPlayerError(thrown, this.#currentUri))
    }
  }

  #setBool(name: string, value: boolean): void {
    this.#guard(() => {
      this.#client.setPropertyBool(name, value)
    })
  }

  #setNumber(name: string, value: number): void {
    this.#guard(() => {
      this.#client.setPropertyNumber(name, value)
    })
  }

  #setString(name: string, value: string): void {
    this.#guard(() => {
      this.#client.setPropertyString(name, value)
    })
  }
}
