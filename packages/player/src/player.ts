import type { PlayerError } from './errors'
import {
  PlayerErrorException,
  disposedError,
  liveEofError,
  toPlayerError,
} from './errors'
import type { LogEvent, PlayerEvent } from './events'
import { toPlayerEvents } from './events'
import type { CommonMetadata } from './common-metadata'
import { toCommonMetadata } from './common-metadata'
import type { AudioFilter } from './filters'
import {
  AudioFilters,
  compileAudioFilters,
  isAudioFilterName,
} from './filters'
import type { HttpHeaders } from './headers'
import { HTTP_HEADER_FIELDS_OPTION, compileHttpHeaderFields } from './headers'
import { createMpvClient } from './native-client'
import { escapeSubparam } from './subparam'
import { VisualizerController } from './visualizer-controller'
import {
  MPV_VOLUME_SCALE,
  MpvProperty,
  OBSERVED_PROPERTIES,
  isMetadataProperty,
  metadataByKeyProperty,
  playlistFilenameProperty,
} from './properties'
import type { SourceResolver } from './source-resolver'
import {
  DEFAULT_RESOLVER_TIMEOUT_MS,
  DEFAULT_RESOLVER_TTL_MS,
  SourceResolverController,
} from './source-resolver'
import type {
  LoopMode,
  PlayerState,
  ReducerContext,
  TrackChangeReads,
} from './state'
import {
  clearPlayerError,
  createInitialState,
  isPositionDiscontinuity,
  projectPosition,
  reducePlayerState,
  withResyncedAnchor,
} from './state'
import type {
  ChapterEntry,
  MpvClient,
  MpvEvent,
  MpvFormat,
  MpvLogLevel,
  PlaylistEntry,
  PrefetchStartedEvent,
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
 * each carries mpv's `UPDATE_VOL` flag (`options/options.c`, verified in mpv
 * 0.41.0), which makes an option write re-run `audio_update_volume()` — so
 * {@link Player.setReplayGain} takes effect on the *currently playing* track,
 * without a reload.
 *
 * @remarks
 * ReplayGain needs tags in the file (`REPLAYGAIN_TRACK_GAIN` and friends).
 * Files without them get {@link fallback}, and nothing else — mpv's
 * `compute_replaygain()` takes the fallback branch *instead of* the tag branch,
 * which is what the manual means by "If this is applied, no other replaygain
 * options are applied."
 *
 * The fallback branch is broader than "untagged file": it is the `else` of
 * `if (opts->rgain_mode && rg)` (`player/audio.c`, mpv 0.41.0), so a non-zero
 * {@link fallback} also applies when {@link mode} is `'no'` — the manual's
 * "always applied if the replaygain logic is somehow inactive". Turning
 * ReplayGain off for real means `{ mode: 'no', fallback: 0 }`.
 *
 * **Pick this *or* {@link Player.setLoudnessNormalization}, not both.** They
 * level loudness by different means — ReplayGain is a per-track volume-domain
 * gain read from tags (zero DSP, dynamics untouched); loudness normalization
 * is a live `loudnorm` filter (dynamic gain ride, 192 kHz resample, 3 s
 * lookahead). Run together their gains *stack*: a track ReplayGain already
 * leveled gets re-leveled — and re-compressed — by loudnorm. When files carry
 * tags, ReplayGain is the better tool; loudness normalization exists for the
 * files that don't. (See that method's TSDoc for the full cost sheet.)
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
   * Gain in dB applied whenever the tag branch is inactive (mpv
   * `replaygain-fallback`, default `0`) — the file carries no ReplayGain tags,
   * **or** {@link mode} is `'no'`. mpv 0.41.0 `options.rst`: "This option is
   * always applied if the replaygain logic is somehow inactive."
   *
   * Because of that second case, `mode: 'no'` does *not* silence a fallback
   * written earlier: a non-zero value keeps attenuating (or boosting) every
   * track until you write `fallback: 0` yourself.
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

/**
 * How hard mpv should try to keep the audio device open across a playlist
 * entry change — mpv's `--gapless-audio=<no|yes|weak>`.
 *
 * This is the *output* side of gapless playback (the demuxer side is
 * {@link PlayerOptions.prefetchPlaylist}). Quoting mpv 0.41.0 `options.rst`:
 *
 * - `'no'` — "Disable gapless audio." The AO is torn down and reopened between
 *   entries, so every transition costs whatever the platform charges for a new
 *   audio device.
 * - `'yes'` — "The audio device is opened using parameters chosen for the first
 *   file played and is then kept open for gapless playback. This means that if
 *   the first file for example has a low sample rate, then the following files
 *   may get resampled to the same low sample rate, resulting in reduced sound
 *   quality."
 * - `'weak'` — mpv's default, and this library's. "Normally, the audio device is
 *   kept open (using the format it was first initialized with). If the audio
 *   format the decoder output changes, the audio device is closed and reopened.
 *   This means that you will normally get gapless audio with files that were
 *   encoded using the same settings, but might not be gapless in other cases.
 *   The exact conditions under which the audio device is kept open is an
 *   implementation detail, and can change from version to version."
 *
 * @remarks
 * **Why this library does not force `'yes'`.** `'yes'` buys gapless across a
 * format change by resampling every later entry into the *first* entry's output
 * format — so one 22.05 kHz interlude at the head of a queue silently degrades
 * the whole rest of it, with no error and nothing in the state to see it by. An
 * album (one encoder, one format) is gapless under `'weak'` anyway; a mixed
 * queue is the case where `'yes'` trades audible quality for an inaudible gap.
 * If you want `'yes'`, pin the shared output format too — mpv's own advice:
 * "consider using options such as `--audio-samplerate` and `--audio-format` to
 * explicitly select what the shared output format will be" (pass them through
 * {@link PlayerOptions.mpvOptions}).
 *
 * Note also mpv's caveat, which is why {@link PlayerOptions.prefetchPlaylist}
 * exists alongside this: gapless "relies on audio output device buffering to
 * continue playback while moving from one file to another. If playback of the
 * new file starts slowly, for example because it is played from a remote
 * network location […] then the buffered audio may run out before playback of
 * the new file can start."
 */
export type GaplessAudioMode = 'no' | 'yes' | 'weak'

/**
 * Which channel layout the output is forced to — the typed subset of mpv's
 * `--audio-channels` this library exposes.
 *
 * - `'auto-safe'` — mpv's default: "Use the system's preferred channel layout.
 *   If there is none […] force stereo."
 * - `'auto'` — "Send the audio device whatever it accepts, preferring the
 *   audio's original channel layout."
 * - `'stereo'` / `'mono'` — "Force a downmix to stereo or mono."
 *
 * The option also accepts arbitrary layout lists (`5.1`, `fl-fr-lfe`); those
 * stay reachable through `mpvOptions` / `setPropertyString` rather than being
 * typed here, because a phone's audio output is stereo and a typed union of
 * surround layouts would be an API for a case this library does not have.
 */
export type AudioChannelMode = 'auto-safe' | 'auto' | 'stereo' | 'mono'

/**
 * FFmpeg's own HTTP reconnection, wired through mpv's `stream-lavf-o`.
 *
 * @remarks
 * **This is the primary recovery layer, and it is entirely native.** It runs
 * inside libavformat's read loop, on mpv's demuxer thread, with no JavaScript
 * and no timers anywhere near it — which is the only kind of retry that works
 * with the screen off (ARCHITECTURE, "Platform truths": JS timers freeze in the
 * background). {@link PlayerOptions.retry} is the *second* layer and covers the
 * failures this one cannot see, namely an entry that never opened at all.
 *
 * ### What is set, and why each one
 * Verified against the shipped binary (`strings` on
 * `libmpv.so`, `v1.1.9-rnmedia.7`, FFmpeg `n8.1.2` / `Lavf62.12.102`) and
 * against that exact FFmpeg tree's `libavformat/http.c`:
 *
 * | AVOption | value | what it buys |
 * | -------- | ----- | ------------ |
 * | `reconnect` | `1` | reconnects a **premature** end of a sized response — `http.c:1871`, guarded by `is_premature = filesize > 0 && off < filesize`. This is the truncated-download case |
 * | `reconnect_on_network_error` | `1` | retries the **connect** on any non-HTTP-status failure — DNS, refused TCP, TLS — `http.c:437` via `http_should_reconnect()`'s `default:` arm. This is the "the radio came back" case |
 * | `reconnect_streamed` | `1` | lifts `http.c:1868`'s hard `break` for non-seekable streams, which is what makes any mid-read retry legal on a live stream at all |
 * | `reconnect_delay_max` | {@link maxDelaySeconds} | the give-up bound. FFmpeg's backoff is `delay = 1 + 2 * delay` from `0`, so `5` means attempts at 0 s, 1 s and 3 s and then a stop (the next delay, 7, exceeds it) — about four seconds of trying |
 *
 * FFmpeg's own defaults for all four are off / `120 s`
 * (`http.c:195-201`), which is why this is opt-*out* rather than opt-in.
 *
 * ### What it does **not** cover, stated plainly
 * - **`reconnect_at_eof` is deliberately NOT set.** It is the option that would
 *   make a live stream reconnect when the server simply closes the connection
 *   — and it is unsafe as a global default, because `http.c:1871` does not
 *   guard it on `is_streamed`. On an ordinary sized file, reaching the natural
 *   end of the response *is* `AVERROR_EOF`, so enabling it turns every clean
 *   track end into a reconnect storm that runs for {@link maxDelaySeconds} and
 *   then returns `AVERROR(EIO)` — i.e. it would convert "the song finished"
 *   into "the song failed", destroying the very `trackEnded`-vs-`error`
 *   distinction this library is built around. An app whose queue is *only* live
 *   streams can still opt in, by passing the whole list raw (see below).
 * - **HTTP status codes.** A `404` or a `503` is not retried; FFmpeg gates that
 *   on `reconnect_on_http_error`, which takes a status list and is a policy
 *   decision an app must make for itself. Pass it raw if you want it.
 * - **A source that never opened.** If the very first connect exhausts its
 *   attempts, mpv fails the load and the entry ends with a typed `error`. That
 *   is {@link PlayerOptions.retry}'s job, not this one's.
 * - **Non-HTTP protocols.** These are `libavformat/http.c` options. `file://`,
 *   `rtsp://`, `srt://` and friends ignore them (mpv's manual: "Unknown or
 *   misspelled options are silently ignored").
 *
 * ### Cost
 * A hard connect failure now takes up to ~`maxDelaySeconds` before mpv reports
 * it, instead of failing at once. That is the trade: bounded, and paid only on
 * a failure path.
 *
 * ### Overriding
 * A raw `mpvOptions['stream-lavf-o']` **replaces this whole list** — mpv's
 * key/value list options are set, not merged. So opting into one extra key
 * means writing all of them:
 *
 * ```ts
 * await Player.create({
 *   mpvOptions: {
 *     'stream-lavf-o':
 *       'reconnect=1,reconnect_on_network_error=1,reconnect_streamed=1,' +
 *       'reconnect_delay_max=5,reconnect_at_eof=1', // live-only app
 *   },
 * })
 * ```
 */
export interface NetworkReconnectOptions {
  /**
   * Turn the whole thing off, leaving FFmpeg's own defaults (every reconnect
   * option disabled).
   *
   * @defaultValue `true`
   */
  readonly enabled?: boolean
  /**
   * FFmpeg's `reconnect_delay_max`, in seconds: retrying stops once the *next*
   * backoff step would exceed it.
   *
   * Must be an integer in `0 … 4294` — FFmpeg's own domain
   * (`AV_OPT_TYPE_INT`, `M_RANGE(0, UINT_MAX/1000/1000)`, `http.c:200`).
   * Anything else throws an `invalid-state` {@link PlayerError} rather than
   * being clamped.
   *
   * @defaultValue {@link DEFAULT_RECONNECT_DELAY_MAX_SECONDS}
   */
  readonly maxDelaySeconds?: number
}

/**
 * Give a failed entry another go before the queue moves past it.
 *
 * @remarks
 * mpv's own behaviour on a hard failure is to advance: the entry ends with
 * `MPV_END_FILE_REASON_ERROR` and the next one starts. That is right for a file
 * that will never play and wrong for a stream that was unlucky, and nothing in
 * mpv distinguishes the two. This option is where that distinction is made, and
 * it is made from {@link PlayerError.retryable} — the same flag a UI reads to
 * decide whether to draw a Retry button.
 *
 * ### Exactly what happens
 * 1. An entry ends with an `error` whose typed classification is `retryable`.
 * 2. If that entry has attempts left, the player jumps **back** to it
 *    (`playlist-play-index`), preserving whether it was playing, and emits
 *    {@link PlayerEventMap.retrying}. **No `error` event is emitted for that
 *    attempt** — nothing has failed for good yet.
 * 3. On success the counter resets. On another failure step 1 runs again.
 * 4. When the attempts run out, the advance mpv already performed is left
 *    alone and the `error` event fires with the attempt count in its second
 *    argument.
 *
 * ### There is deliberately no delay between attempts
 * Not "we did not get to it" — a delay is the one thing this layer must not
 * have. The only way to wait in JavaScript is a timer, and JS timers freeze
 * with the screen off (ARCHITECTURE, "Platform truths"), so a backoff written
 * here would silently become "retry when the user next unlocks the phone" —
 * a bug that is invisible in every test that runs with the display on. Spaced,
 * backed-off retrying is owned by the layer that can actually do it natively:
 * {@link PlayerOptions.networkReconnect}. This layer only answers the question
 * that layer cannot see, "should the queue move on?", and it answers it
 * immediately.
 *
 * The consequence to know: a re-attempt is issued a moment *after* mpv has
 * already started the next entry, so a failure at a queue boundary can produce
 * a brief blip of the following track before the failed one restarts.
 *
 * ### When the counter resets
 * Attempts are tracked per **entry generation**, not per player. The count
 * resets when:
 * - the entry plays successfully (any `playbackRestart` reaching `ready`),
 * - the failure is on a *different* playlist index than the one being retried,
 * - the app moves the cursor itself — {@link PlaylistApi.jumpTo},
 *   {@link PlaylistApi.next}, {@link PlaylistApi.previous}, {@link Player.load},
 *   {@link Player.loadPlaylist},
 * - the app edits the queue — {@link PlaylistApi.add}, `remove`, `move`,
 *   `clear`, `shuffle`, `unshuffle`.
 *
 * The cursor moves are also the cancellation rule: a user who skips during a
 * retry has said what they want, and the player stops arguing.
 */
export interface RetryOptions {
  /**
   * How many extra attempts one entry gets before the queue is allowed to move
   * past it. `0` disables retrying entirely (mpv's own behaviour).
   *
   * Must be a non-negative integer; anything else throws an `invalid-state`
   * {@link PlayerError}.
   *
   * @defaultValue {@link DEFAULT_RETRY_MAX_ATTEMPTS}
   */
  readonly maxAttempts?: number
  /**
   * Treat a **clean end of a live entry** as a retryable failure.
   *
   * @defaultValue `false`
   *
   * @remarks
   * The failure this covers is the one neither other layer can see: a radio
   * server that closes the connection *politely*. FFmpeg's reconnection
   * (`{@link PlayerOptions.networkReconnect}`) does not act on it, deliberately
   * — `reconnect_at_eof` is the option that would, and it is unsafe as a global
   * default because `http.c:1871` does not guard it on `is_streamed`, so it
   * would turn every finite track's natural end into a reconnect storm (see
   * {@link NetworkReconnectOptions}). mpv then reports
   * `MPV_END_FILE_REASON_EOF` — a *clean* end — and the queue moves on. For a
   * file that is right. For a station it is the one thing the listener did not
   * ask for.
   *
   * With this on, an entry that ends with `eof` **while
   * {@link PlayerState.isLive} was true** takes the same path a retryable
   * error takes: it re-attempts under the same per-entry budget
   * ({@link maxAttempts}), emits {@link PlayerEventMap.retrying} with a
   * synthesised `network` error, and emits **no**
   * {@link PlayerEventMap.trackEnded} for that attempt. A finite entry is never
   * affected, whatever this is set to — `isLive` is mpv's `seekable = no`, and
   * a seekable file ends for good.
   *
   * There is no delay here either, and for the same reason as the rest of this
   * option: a JS timer would freeze with the screen off. This layer re-attempts
   * immediately; spaced retrying belongs to
   * {@link PlayerOptions.networkReconnect}, which owns the *transient* drop.
   * This one owns the clean close.
   *
   * ### When the budget resets — sustained playback, not the restart
   * The ordinary retry budget resets on the first `playbackRestart`. That rule
   * cannot be used here: a station that reconnects, plays for a second and
   * drops again would clear its budget on every reconnect and re-attempt
   * forever. So a live-`eof` generation resets only after
   * {@link LIVE_EOF_BUDGET_RESET_SECONDS} of playback since the restart — long
   * enough that a station which drops once an hour keeps recovering all day,
   * short enough that a server serving two seconds and hanging up exhausts its
   * budget and stops.
   *
   * ### The trade, stated plainly
   * **A broadcast that has genuinely ended will be re-attempted
   * {@link maxAttempts} times before the queue moves on.** That is bounded by
   * design and it is the honest cost: nothing in the protocol distinguishes
   * "this station is off the air" from "this station's server just closed a
   * socket". The price of recovering the second is a few extra connects on the
   * first.
   */
  readonly retryLiveEof?: boolean
}

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
   * Whether the audio device is kept open across a playlist entry change, which
   * is what makes a transition *gapless* (mpv's `gapless-audio`).
   *
   * Left unset, mpv's own default `'weak'` applies: gapless whenever
   * consecutive entries decode to the same output format, and a device
   * reopen — a short gap — when they do not. See {@link GaplessAudioMode} for
   * each value's cost, and why this library deliberately does not force
   * `'yes'`.
   *
   * Orthogonal to {@link prefetchPlaylist}: this one keeps the *output* alive,
   * that one opens the next *input* early. On a network queue you generally
   * want both, because a device that never closed still runs dry if the next
   * entry's first packets have not arrived.
   *
   * A raw `mpvOptions['gapless-audio']` still wins over this.
   */
  readonly gaplessAudio?: GaplessAudioMode
  /**
   * Loudness normalisation from the file's ReplayGain tags. See
   * {@link ReplayGainOptions}; change it later with
   * {@link Player.setReplayGain}.
   *
   * Raw `mpvOptions['replaygain*']` entries still win over this.
   */
  readonly replayGain?: ReplayGainOptions
  /**
   * FFmpeg's native HTTP reconnection, on by default. See
   * {@link NetworkReconnectOptions} — including exactly what it covers, what it
   * deliberately does not, and why one FFmpeg option is left off.
   *
   * A raw `mpvOptions['stream-lavf-o']` replaces it wholesale.
   */
  readonly networkReconnect?: NetworkReconnectOptions
  /**
   * Re-attempt a failed entry before letting the queue advance past it. See
   * {@link RetryOptions}.
   */
  readonly retry?: RetryOptions
  /** Initial volume in `0..1`. */
  readonly volume?: number
  /** Initial mute state. */
  readonly muted?: boolean
  /** Initial playback rate. */
  readonly rate?: number
  /** Initial repeat behaviour. */
  readonly loop?: LoopMode
  /**
   * Turn the logical URIs in your queue into the URLs mpv actually opens —
   * signed CDN links, transcode sessions, anything that cannot be written down
   * ahead of time.
   *
   * Setting it here rather than calling {@link Player.setSourceResolver} after
   * `create()` means it is installed before anything can be loaded, so the very
   * first entry is resolved ahead of time like every other one. See
   * {@link SourceResolver} for the determinism requirement.
   */
  readonly sourceResolver?: SourceResolver
  /**
   * How long a play-time resolution may hold mpv's core while the resolver
   * answers, in milliseconds. Defaults to
   * {@link DEFAULT_RESOLVER_TIMEOUT_MS} (10 s); `0` means never hold, i.e. only
   * pre-resolved URIs are ever rewritten.
   *
   * Must be a finite number `>= 0`.
   *
   * @remarks
   * This budget is spent between entries, with the new entry not yet open and
   * the previous one already ended — there is no audio of the new track to
   * starve. It is *not* spent on the prefetch path, which never waits at any
   * value: that hook fires mid-track over live audio with only the device
   * buffer behind it, so a cache miss there is answered by letting mpv continue
   * immediately and warming the cache for the play-time pass.
   *
   * On timeout the logical URI is used unchanged, mpv fails the load on its own
   * terms, and the failure arrives as an ordinary typed `error` event.
   *
   * **What the hold actually parks.** The wait happens on the native event
   * thread — the same thread that drains mpv's event queue — so for its
   * duration *nothing* crosses into JavaScript: no property changes, and no
   * command replies. A `play()`/`seekTo()`/`command()` Promise issued while an
   * unresolved play-time load is in flight therefore does not settle until the
   * resolution completes or this budget expires. The player is not wedged (the
   * hold is bounded and mpv resumes normally afterwards), but a UI that awaits
   * one of those Promises will look stalled for up to this long.
   *
   * The mitigation is the design's main path, not a workaround: resolve-ahead
   * answers the current and next entries as the queue moves, typically a whole
   * track before mpv asks, so a hit costs a native map lookup and this path
   * stays cold. Keep your resolver deterministic (see {@link SourceResolver}) so
   * the answers stay cacheable, and lower this value if your app would rather
   * fail a load fast than have its transport Promises wait.
   *
   * Waiting *off* the event thread — parking a dedicated waiter and letting
   * `mpv_wait_event` keep draining — was considered and deliberately deferred:
   * it means a second synchronisation object, a hook continuation issued from a
   * thread that did not receive the hook, and a new class of ordering bug, all
   * to improve a path that resolve-ahead is designed to make rare. It is
   * recorded in the as-built spec as the known cost of the simpler design
   * rather than pretended away.
   */
  readonly resolverTimeoutMs?: number
  /**
   * How long one resolved URL stays usable, in milliseconds. Defaults to
   * {@link DEFAULT_RESOLVER_TTL_MS} (10 min).
   *
   * Must be a finite number `>= 0`. A `0` disables caching entirely, which also
   * disables prefetching for resolved sources — see {@link SourceResolver}.
   */
  readonly resolverTtlMs?: number
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

/**
 * Per-source options shared by {@link Player.load}, {@link Player.loadPlaylist}
 * and {@link PlaylistApi.add} — everything that becomes a `loadfile` per-file
 * option.
 *
 * @remarks
 * These are **per entry**, not per player: mpv applies them when the entry
 * starts and "restore[s] to the previous value at end of playback" (mpv 0.41.0
 * `input.rst`, `loadfile`). So a token attached to one track does not leak onto
 * the next one.
 */
export interface SourceOptions {
  /**
   * Start position in seconds (mpv's per-file `start` option).
   *
   * On {@link Player.loadPlaylist} this applies to **one** entry — the one at
   * `startIndex` — and not to the rest of the queue. See
   * {@link LoadPlaylistOptions.startPosition}.
   */
  readonly startPosition?: number
  /**
   * HTTP request headers for **this source only** — the typed form of mpv's
   * `http-header-fields`.
   *
   * @example
   * ```ts
   * await player.load(`${server}/Audio/${id}/stream`, {
   *   headers: { Authorization: `MediaBrowser Token="${token}"` },
   * })
   * ```
   *
   * @throws {@link PlayerErrorException} with code `invalid-state` when a
   * header name is empty, padded with whitespace, or contains `:`, CR, LF or
   * NUL, or when a value contains CR, LF or NUL. mpv writes these lines into
   * the request verbatim (`stream/stream_lavf.c:218` joins each with `\r\n`),
   * so those characters are request splitting, not a formatting preference.
   *
   * @remarks
   * **Why this exists rather than "just use `mpvOptions`".** The raw route was
   * unsafe in exactly the case people reach for it: `http-header-fields` is
   * itself a `,`-separated list, and the file-option string it travels in is
   * *also* `,`-separated, so any header containing a comma (`Accept:
   * text/html, application/xml`, a multi-valued `Cache-Control`, a cookie
   * pair) used to corrupt the whole option list. This path escapes both layers — the list separator with
   * mpv's backslash form, the option value with mpv's fixed-length `%n%` form —
   * so a header value can contain anything except the characters above.
   *
   * **Interaction with {@link PlayerOptions.userAgent}.** They are different
   * mpv options (`user-agent` vs `http-header-fields`) and both are sent, so a
   * per-source `User-Agent` header does *not* silently disappear — but it does
   * take precedence, because FFmpeg only appends its own `user_agent` line
   * `if (!has_header(s->headers, "\r\nUser-Agent: "))` (`libavformat/http.c`,
   * FFmpeg 8.1.2, the tree these binaries are built from). Set one or the
   * other, not both.
   *
   * **Interaction with {@link SourceResolver}.** Headers belong to the *entry*,
   * not to the URL, and survive a rewrite: mpv applies per-file options in
   * `load_per_file_options()` (`player/loadfile.c:1707`) and only *then* runs
   * the `on_load` hook that rewrites `stream-open-filename`
   * (`loadfile.c:1725`). So a resolver that swaps a logical URI for a signed
   * CDN URL still sends the headers the queue entry carried. If your signed URL
   * makes the header redundant, drop the header — nothing removes it for you.
   *
   * **What it does not do.** These are HTTP(S) options. `file://`, and any
   * protocol not served by libavformat's HTTP client, ignore them (mpv:
   * "Unknown or misspelled options are silently ignored").
   */
  readonly headers?: HttpHeaders
  /**
   * Extra per-file mpv options, e.g. `{ 'audio-channels': 'stereo' }`.
   *
   * Values are escaped with mpv's own fixed-length quoting before they are
   * joined into `loadfile`'s option list, so a value may contain commas,
   * colons, quotes and spaces. A key given here **wins** over the typed options
   * above it: pass `'http-header-fields'` yourself and {@link headers} is not
   * emitted at all (and you own both layers of escaping); pass `'demuxer'` and
   * the `.m3u8` guard steps aside.
   */
  readonly mpvOptions?: Readonly<Record<string, string>>
}

/** Options for {@link Player.load}. */
export interface LoadOptions extends SourceOptions {
  /** Start playing immediately. Defaults to `true`. */
  readonly autoPlay?: boolean
}

/** Options for {@link Player.loadPlaylist}. */
export interface LoadPlaylistOptions extends LoadOptions {
  /**
   * Start position in seconds, applied to **the entry at {@link startIndex}
   * only** — every other entry starts at its own beginning.
   *
   * @remarks
   * This is what makes the session-restore call mean what it reads like:
   *
   * ```ts
   * await player.loadPlaylist(tracks, { startIndex: 5, startPosition: 120 })
   * // entry 5 resumes at 2:00; entries 0-4 and 6+ start at 0:00.
   * ```
   *
   * Until 0.1.0 this option was attached to every appended entry, so restoring
   * a session made the *whole queue* start two minutes in — silently, because
   * `start` is a per-file option and nothing reports it back. If you genuinely
   * want an offset on every entry (a queue of identically-structured files with
   * a fixed intro, say), pass it yourself through
   * {@link SourceOptions.mpvOptions} as `{ start: '120' }`, which is applied to
   * each entry exactly as before.
   *
   * **Cannot be combined with {@link shuffle}**, for the same reason
   * {@link startIndex} cannot: after mpv permutes the queue, no index — and
   * therefore no entry — is identifiable as the one the offset was meant for.
   * The combination throws an `invalid-state` {@link PlayerError}.
   */
  readonly startPosition?: number
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

/** Payload of the `chapterChanged` event. */
export interface ChapterChangedEvent {
  /**
   * The chapter now current, 0-based; `-1` when the position is before the
   * first chapter, and `undefined` when the entry has no chapters (which is how
   * this event reports a move *off* a chaptered entry).
   */
  readonly index: number | undefined
  /** The chapter that was current before, with the same conventions. */
  readonly previousIndex: number | undefined
}

/**
 * Why the playback position jumped — the two causes this library can tell apart
 * from mpv's own events, and no more.
 *
 * - `'seek'` — mpv raised `MPV_EVENT_SEEK`, i.e. something asked for a new
 *   position in the *current* entry: {@link Player.seekTo},
 *   {@link Player.seekBy}, a chapter jump, a lock-screen scrub, or a `seek`
 *   through the raw {@link Player.command} hatch.
 * - `'auto-advance'` — the current entry changed (`playlist-pos` moved), so the
 *   position restarted somewhere else entirely. It covers a natural queue
 *   advance, a `playlist.next()`/`jumpTo()`, a repeat wrap and a retry.
 *
 * There is deliberately no third value for "a new file was loaded" or "the user
 * did it": mpv does not report intent, and inventing a distinction that the
 * event stream cannot support is how a typed API starts lying.
 */
export type PositionDiscontinuityReason = 'seek' | 'auto-advance'

/** Payload of the `seekStarted` event. */
export interface SeekStartedEvent {
  /** What caused it. See {@link PositionDiscontinuityReason}. */
  readonly reason: PositionDiscontinuityReason
  /**
   * The projected position, in seconds, at the instant the jump began — i.e.
   * where playback was *leaving from*.
   *
   * This is the projection, not a fresh read: the truth is not knowable until
   * mpv restarts, and paying a synchronous `time-pos` round-trip here would put
   * one on the event path for an analytics signal.
   */
  readonly from: number
}

/** Payload of the `seekCompleted` event. */
export interface SeekCompletedEvent {
  /**
   * What caused it — the same value the matching {@link SeekStartedEvent}
   * carried.
   */
  readonly reason: PositionDiscontinuityReason
  /**
   * Where playback resumed, in seconds. This one *is* authoritative: mpv's
   * `playbackRestart` is the point at which the position becomes meaningful
   * again, and the player already re-anchors on a real `time-pos` read there
   * (see the batch read budget), so this costs nothing extra.
   */
  readonly position: number
}

/** Payload of the `retrying` event. */
export interface RetryingEvent {
  /** Playlist index of the entry being re-attempted. */
  readonly index: number
  /** Which attempt this is, `1`-based. */
  readonly attempt: number
  /** The budget it is counting against ({@link RetryOptions.maxAttempts}). */
  readonly maxAttempts: number
  /** The typed failure that triggered the re-attempt. */
  readonly error: PlayerError
}

/** What this library knows about a {@link QueueChangedEvent}. */
export type QueueChangeReason =
  /** `playlist-count` moved: an add, a remove, a clear, a fresh `loadPlaylist`. */
  | 'resized'
  /** The order changed with the length intact: a `move`, `shuffle`, `unshuffle`. */
  | 'reordered'

/** Payload of the `queueChanged` event. */
export interface QueueChangedEvent {
  /** Number of entries after the change. */
  readonly count: number
  /** Which of the two things this library can honestly report happened. */
  readonly reason: QueueChangeReason
}

/** Extra facts about an `error` event, beyond the typed error itself. */
export interface PlayerErrorInfo {
  /**
   * How many automatic re-attempts were spent on this entry before giving up
   * (see {@link PlayerOptions.retry}).
   *
   * `0` when nothing was retried — because retrying is off, because the error
   * was not {@link PlayerError.retryable}, or because the failure did not come
   * from a playlist entry at all.
   */
  readonly attempts: number
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
  /**
   * Playback failed, **finally**. Also reflected in `state.error` with
   * `status: 'error'`.
   *
   * @param error - The typed failure.
   * @param info - How many automatic re-attempts preceded it. A listener
   * written as `(error) => …` stays valid; the second argument is additive.
   *
   * @remarks
   * With {@link PlayerOptions.retry} enabled this fires only once the attempt
   * budget is spent — an entry that failed and then played on the second try
   * produces {@link PlayerEventMap.retrying} and no `error` at all. That is the
   * point of the feature, and it is also the one thing to know before treating
   * this event as "count of failures": it counts *give-ups*, not failures.
   */
  error: (error: PlayerError, info: PlayerErrorInfo) => void
  /**
   * A failed entry is being re-attempted rather than skipped.
   *
   * Fires once per attempt, immediately (there is no delay to wait out — see
   * {@link RetryOptions} for why a JS-timer backoff would be a bug). Use it to
   * show "reconnecting…" instead of an error banner.
   */
  retrying: (event: RetryingEvent) => void
  /**
   * The queue's contents changed. Read the new contents with
   * {@link PlaylistApi.entries}.
   *
   * @remarks
   * **What actually triggers it, honestly.** There is no native observation of
   * mpv's `playlist` array (see {@link PlaylistApi.entries} for why), so this
   * event is derived from the two things this library genuinely knows:
   *
   * - `reason: 'resized'` — `playlist-count`, which *is* observed, changed. It
   *   arrives on the ordinary event batch, so it is as late as any other state
   *   update and covers every add/remove/clear whatever issued it. Building a
   *   queue with {@link Player.loadPlaylist} may produce more than one, since
   *   the count climbs as entries are appended (the native batcher coalesces
   *   property changes, so it is usually far fewer than one per entry).
   * - `reason: 'reordered'` — this library issued a `move`, `shuffle` or
   *   `unshuffle` and mpv accepted it. Emitted by those methods, because a
   *   reorder changes no observable property at all: `playlist-count` is
   *   identical and `playlist-pos` may or may not move. Nothing else can
   *   report it, and pretending otherwise would mean observing the whole
   *   playlist node.
   *
   * The gap that leaves: a reorder issued through the raw
   * {@link Player.command} escape hatch is invisible here. That is the price of
   * not streaming the queue across the bridge, and it is written down rather
   * than papered over.
   */
  queueChanged: (event: QueueChangedEvent) => void
  /**
   * The **whole queue** finished: the last entry ended naturally and nothing
   * follows it.
   *
   * Fires immediately after the `trackEnded` for that entry, and only when the
   * queue is genuinely over — with `loop: 'playlist'` (or `'track'`) it never
   * fires, because mpv is about to start something. It is the hook for
   * autoplay, radio mode, "up next" recommendations and "playback finished"
   * analytics, all of which `trackEnded` alone cannot express.
   *
   * @remarks
   * Derived from the same snapshot pair every other event here is derived from:
   * the entry ended (`end-file` reason `eof`) and the pre-end snapshot said
   * {@link PlayerState.hasNext} was `false`. Nothing polls, and there is no new
   * native signal — mpv has none to give.
   *
   * A queue that stops because an entry *failed* does not produce this: that is
   * the `error` event, and conflating "finished" with "gave up" is exactly the
   * distinction this library is built around.
   */
  queueEnded: () => void
  /** The current playlist entry changed. */
  trackChanged: (event: TrackChangedEvent) => void
  /**
   * The current chapter changed — including moving off, or onto, an entry that
   * has chapters at all.
   *
   * @remarks
   * Driven by mpv's observed `chapter` property, so it fires when the position
   * crosses a chapter boundary during ordinary playback just as it does for
   * {@link Player.setChapter}. Read the chapter's title with
   * {@link Player.getChapters}; this event carries only the cursor, exactly as
   * {@link trackChanged} does for the queue.
   */
  chapterChanged: (event: ChapterChangedEvent) => void
  /**
   * The playback position is about to jump — a seek started, or the current
   * entry changed.
   *
   * @remarks
   * **This is the "position discontinuity" pair, and it is what makes accurate
   * listening analytics possible without polling.** Because position is
   * projected locally and never streamed (ARCHITECTURE §7), an app that wants
   * to know "how much of this track was actually heard" has to know when the
   * clock jumped and from where. `seekStarted.from` is where it left,
   * {@link seekCompleted}`.position` is where it landed, and everything between
   * two of these was played in real time.
   *
   * Every `seekStarted` is followed by exactly one `seekCompleted` unless mpv
   * never restarts (the entry failed, or the player was destroyed mid-seek) —
   * the pending reason is dropped on `end-file`, so a failed seek does not
   * glue itself onto the next successful one. Deliberately *not* on
   * `start-file`: an auto-advance announces itself when the cursor moves, and
   * mpv's ordering of `start-file` against that cursor change is not
   * guaranteed — clearing there could wipe a pending `'auto-advance'` before
   * the new entry's restart completes it.
   */
  seekStarted: (event: SeekStartedEvent) => void
  /**
   * The position finished jumping and playback resumed — mpv's
   * `playbackRestart`.
   *
   * Carries the authoritative new position and the reason its
   * {@link seekStarted} carried. See there for the pairing rules.
   */
  seekCompleted: (event: SeekCompletedEvent) => void
  /**
   * The current entry's metadata changed — a new track's tags, or a live
   * stream's now-playing update (ICY `StreamTitle`, which mpv surfaces as the
   * `icy-title` tag and folds into `media-title`).
   *
   * Fires at most once per native event batch, and **only while at least one
   * listener is registered**: building the map costs one property read, so a
   * player nobody is asking pays nothing.
   *
   * @remarks
   * **This is the tag-store route; {@link PlayerState.title} is the
   * now-playing route.** The split is deliberate and it is not redundancy:
   *
   * - `state.title` is mpv's `media-title` — one coalesced string, carried in
   *   every snapshot, so it reaches the media session, the lock screen and the
   *   app's own UI through the ordinary state fan-out with no extra work and no
   *   extra read. On a radio stream it *is* the currently-playing song, and it
   *   updates on its own as `StreamTitle` changes.
   * - This event plus {@link Player.getMetadataValue} is the full tag map, for
   *   apps that need a *specific* key — `icy-name` for the station, `icy-br`
   *   for the bitrate, `album`/`date`/`musicbrainz_*` for a library.
   *
   * The map could not simply be a field of {@link PlayerState}, because
   * building it is a synchronous read into mpv's core and most apps never look
   * at it; and the title could not simply be an event, because a media session
   * re-broadcasts state rather than events, so a now-playing line delivered
   * only as an event would never reach the notification. Hence two routes, each
   * paying only for what it is used for.
   *
   * mpv invalidates `metadata` and `media-title` together on one
   * `MP_EVENT_METADATA_UPDATE` (`player/command.c`), so the two are always
   * describing the same instant — they are two views of one update, never two
   * different truths.
   *
   * @example
   * ```ts
   * // The station, once per update; the song comes from state.title.
   * player.on('metadataChanged', (tags) => setStation(tags['icy-name']))
   * ```
   */
  metadataChanged: (metadata: Metadata) => void
  /**
   * mpv started opening the **next** queue entry ahead of time.
   *
   * Fires once per prefetched entry, at the instant mpv releases its opener
   * thread on it — which is seconds *into* the current track (mpv arms the
   * prefetch on the first cache poll after the current file is fully read), not
   * near the boundary. Use it to know that a transition is going to be gapless,
   * to warm your own caches, or to log where a slow CDN is spending its time.
   *
   * @remarks
   * **Two conditions, both of them honest.**
   *
   * 1. **mpv must actually be prefetching**, i.e.
   *    {@link PlayerOptions.prefetchPlaylist} is on (it is off by default — see
   *    there for why). Without it the event simply never occurs, because there
   *    is nothing to report.
   * 2. **The linked libmpv must carry the prefetch hook.** Stock libmpv runs no
   *    hooks on its prefetch path and upstream documents that as permanent
   *    (`options.rst` on `--prefetch-playlist`: URLs resolved by a hook "won't"
   *    work). The rn-media forks add `on_prefetch_load`: **Android
   *    `v1.1.9-rnmedia.5`+ and iOS `v0.7.2-rnmedia.4`+**, both mpv 0.41.0
   *    (ARCHITECTURE §11). On any other build the hook is never raised — mpv
   *    accepts the registration and never fires it (`client.h`: "if the name is
   *    unknown, the hook event will simply be never raised") — so, again, the
   *    event never occurs. There is deliberately no error and no capability
   *    flag: an event that does not happen is not a failure, and `prefetch` is
   *    an optimisation whose absence is inaudible except in the handover gap.
   *
   * `entryId` is mpv's playlist *entry id* and is present only on binaries that
   * also expose `prefetch-playlist-entry-id` (the same fork releases). It is not
   * a playlist index: ids survive `playlist-move` and `playlist-remove`.
   */
  prefetchStarted: (event: PrefetchStartedEvent) => void
  /** An mpv log line, at or below the configured `logLevel`. */
  log: (event: LogEvent) => void
}

/** Name of a discrete event. */
export type PlayerEventName = keyof PlayerEventMap

/** Unsubscribes a listener. Safe to call more than once. */
export type Unsubscribe = () => void

/**
 * Options for {@link PlaylistApi.add}.
 *
 * @remarks
 * **Before you use any of this: an insert renumbers the queue.** That sentence
 * is obvious and its consequence is not, so it is written down here rather than
 * left to be discovered.
 *
 * Apps almost always keep a side table mapping playlist index → their own track
 * metadata (artwork, ids, analytics keys), because {@link PlayerState} carries
 * a playlist *cursor* and not its contents. Every such map is invalidated the
 * moment an entry is inserted anywhere but the end: `position: 'next'` and
 * `position: <n>` push every later entry down by one, and after that index `k`
 * describes the track that used to be at `k - 1`. Nothing throws, nothing warns
 * — the queue is correct, the app's labels are one row off, and the symptom
 * shows up later as the wrong artwork on the wrong song.
 *
 * `PlaylistApi.remove` and `PlaylistApi.move` have the identical property, and
 * `PlaylistApi.shuffle` has it maximally.
 *
 * **The fix is to key on identity, not position.** Read
 * {@link PlaylistApi.entries} and use `entryId` — mpv's own entry id, "unique
 * for the entire life time of the current mpv core instance" (mpv 0.41.0
 * `input.rst`), which survives inserts, removes, moves and shuffles — or the
 * entry's `uri` if your sources are unique. Re-read after every
 * {@link PlayerEventMap.queueChanged}; that is what the event is for.
 *
 * ```ts
 * // Fragile: `myTracks[index]` after any insert.
 * // Stable:
 * const byId = new Map(myTracks.map((t) => [t.uri, t]))
 * const rows = player.playlist.entries().map((e) => ({
 *   ...e,
 *   track: byId.get(e.uri),
 * }))
 * ```
 */
export interface PlaylistAddOptions extends SourceOptions {
  /**
   * Where the entry goes. Omitted, it is appended to the end.
   *
   * - `'next'` — directly after the entry that is currently playing (mpv's
   *   `insert-next`). This is the "play this after the current track" button,
   *   and it is index-free on purpose: it stays correct even if the queue moves
   *   between your reading it and mpv acting on it.
   * - a `number` — an exact 0-based index, where `0` is the head and
   *   `playlist.count` is the end (mpv's `insert-at`, which takes the index as
   *   `loadfile`'s third argument).
   *
   * @remarks
   * **A number is validated, not clamped.** mpv itself would silently append —
   * "the new item will be inserted at the index position in the playlist, or
   * appended to the end if index is less than 0 or greater than the size of the
   * playlist" (mpv 0.41.0 `input.rst`) — which turns a caller's off-by-one into
   * a track at the wrong end of the queue with nothing to notice it by. So a
   * non-integer, a negative, or an index past the current
   * `playlist.count` throws an `invalid-state` {@link PlayerError}, exactly like
   * every other out-of-domain option in this API. The count is read from mpv at
   * call time (`playlist-count`), not from the last broadcast snapshot.
   *
   * **Honest caveat: an inserted entry is not itself prefetched if a prefetch
   * is already running.** With `prefetchPlaylist` on, mpv opens the next entry
   * as soon as the current one is fully read — and `prefetch_next()` begins
   * `if (!mpctx->opts->prefetch_open || mpctx->open_active) return;`
   * (mpv 0.41.0 `player/loadfile.c:1278`). So once that opener is running, an
   * entry inserted in front of it gets no prefetch of its own, and at the
   * boundary `open_demux_reentrant()` compares the running opener's URL against
   * the one it now needs (`strcmp(mpctx->open_url, url)`, `loadfile.c:1223`),
   * logs `Dropping finished prefetch of wrong URL.` (or `Aborting ongoing
   * prefetch…`), calls `cancel_open()` — which joins that thread on the core
   * thread — and opens cold. The insert is still correct; it just costs the
   * prefetch that was in flight, which is the same trade mpv's own manual warns
   * about for any queue edit near a boundary
   * ({@link PlayerOptions.prefetchPlaylist}). Inserting well before the current
   * track ends is free.
   */
  readonly position?: 'next' | number
  /**
   * Start playback **if nothing is currently playing** — mpv's `*-play` action
   * variants.
   *
   * @remarks
   * This is mpv's wording, not a softening of ours: "Append the file, and if
   * nothing is currently playing, start playback. (Always starts with the added
   * file, even if the playlist was not empty before running this command.)"
   * (mpv 0.41.0 `input.rst`). On a player that is already playing it does
   * nothing at all — it is not "play this now". For that, add the entry and
   * then {@link PlaylistApi.jumpTo} it.
   */
  readonly play?: boolean
}

/**
 * Queue manipulation, backed by mpv's own playlist (which is what makes
 * gapless transitions gapless — the next entry is demuxed before the current
 * one ends).
 */
export interface PlaylistApi {
  /**
   * The queue's actual contents — every entry's logical URI, mpv's own entry
   * id, and which one is current.
   *
   * @returns The entries in playlist order. `[]` when nothing is queued.
   *
   * @remarks
   * **One bounded synchronous native read, on demand.** It is a single
   * `mpv_get_property("playlist", MPV_FORMAT_NODE)` — constant, whatever the
   * queue length — and it is a *pull*, not a subscription, deliberately.
   *
   * The temptation is to observe the playlist and publish it in
   * {@link PlayerState}. That would put a variable-size array on the bridge
   * every time the queue is touched, and it would make the snapshot a second
   * copy of state mpv already owns — the exact shape of the mistake this
   * library avoids everywhere else (position is anchored and projected rather
   * than streamed; `metadata` is pulled rather than pushed). Cheap reads on
   * demand beat an expensive feed nobody asked for, and the read is cheap
   * precisely because it is one node rather than an `N + 1` sub-property walk.
   *
   * It is also **coherent**, which the walk was not: mpv builds the node under
   * its own lock, so the result is one generation of the queue. A walk of
   * `playlist/0/filename … playlist/N/filename` can interleave with a
   * `playlist-move` and return two halves of two different orders.
   *
   * Call it when something tells you the queue moved —
   * {@link PlayerEventMap.queueChanged}, or the value returned to you by
   * {@link shuffle}/{@link unshuffle} — not on a timer, and not per render.
   *
   * **Prefer `entryId` over the array index for identity.** Ids are "unique for
   * the entire life time of the current mpv core instance" (mpv 0.41.0
   * `input.rst`) and survive `move`/`remove`/`shuffle`; positions do not. See
   * {@link PlaylistAddOptions.position} for what that costs an app that keys on
   * index instead.
   *
   * @throws {@link PlayerErrorException} if the player has been destroyed.
   *
   * @example
   * ```ts
   * player.on('queueChanged', () => {
   *   for (const entry of player.playlist.entries()) {
   *     console.log(entry.current ? '▶' : ' ', entry.entryId, entry.uri)
   *   }
   * })
   * ```
   */
  entries(): readonly PlaylistEntry[]
  /**
   * Add a source to the playlist — at the end, next, or at an exact index.
   *
   * @param source - URI or file path.
   * @param options - See {@link PlaylistAddOptions}. Omit it entirely for a
   * plain append.
   *
   * @throws {@link PlayerErrorException} with code `invalid-state` when
   * `position` is a number that is not an integer in `0 … playlist.count` —
   * see {@link PlaylistAddOptions.position}.
   *
   * @remarks
   * **One mpv command, whatever the cell.** The six combinations of `position`
   * and `play` each map to exactly one `loadfile` action:
   *
   * | `position`  | `play: false` (default) | `play: true`       |
   * | ----------- | ----------------------- | ------------------ |
   * | *(omitted)* | `append`                | `append-play`      |
   * | `'next'`    | `insert-next`           | `insert-next-play` |
   * | `number`    | `insert-at` + index     | `insert-at-play` + index |
   *
   * The `insert-*` actions arrived in mpv 0.38, together with `loadfile`'s
   * third `index` argument (see {@link LOADFILE_NO_INDEX}). This library never
   * emulates them with an `append` + `playlist-move` pair: that is two commands
   * with a window in between where the queue is briefly wrong — observable
   * through `playlist-count`, and readable by mpv's own prefetch, which consults
   * the queue on its own schedule.
   *
   * Carries the same `.m3u8`/`.m3u` `demuxer=lavf` guard as {@link Player.load}
   * — it is the identical `loadfile` command and the identical hazard.
   *
   * @example
   * ```ts
   * await player.playlist.add(uri)                        // to the end
   * await player.playlist.add(uri, { position: 'next' })  // play after this one
   * await player.playlist.add(uri, { position: 0 })       // to the head
   * await player.playlist.add(uri, { play: true })        // …and start if idle
   * ```
   */
  add(source: string, options?: PlaylistAddOptions): Promise<void>
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
  /**
   * The ⏮ button: restart the current entry, or go to the previous one.
   *
   * @param options - `restartThreshold` in seconds; defaults to
   * {@link DEFAULT_RESTART_THRESHOLD_SECONDS} (3). Pass `0` to always move.
   *
   * @remarks
   * **The universal music-app convention, implemented once here rather than in
   * every app.** More than `restartThreshold` seconds into an entry, this seeks
   * back to `0`; before that, it moves to the previous entry (mpv's
   * `playlist-prev weak`). The same shape mpv itself uses for chapters — see
   * `--chapter-seek-threshold` and {@link Player.previousChapter}.
   *
   * Two cases where it always *moves* instead of restarting, both forced rather
   * than chosen:
   *
   * - **A live stream** ({@link PlayerState.isLive}): there is no position `0`
   *   to return to, and mpv would reject the seek.
   * - **`restartThreshold: 0`**: the opt-out, for an app that draws separate
   *   "restart" and "previous" controls.
   *
   * At the head of the queue with nothing to go back to, restarting is still
   * what happens if you are past the threshold — and if you are not, mpv's
   * `playlist-prev` does nothing, which is the same thing every player does.
   *
   * The position it compares against is the locally projected one
   * ({@link Player.getPosition}), so this costs no native round-trip.
   */
  previous(options?: { readonly restartThreshold?: number }): Promise<void>
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
   *
   * @returns The queue **after** the shuffle, exactly as {@link entries} would
   * report it — because a permutation nobody can see is not a feature. mpv's
   * `playlist-shuffle` reports nothing about what it did, so before this
   * returned anything an app's only options were to re-read the playlist itself
   * or to guess; the read is one node round-trip and it happens here, once,
   * where it is unmissable.
   *
   * Also emits {@link PlayerEventMap.queueChanged} with `reason: 'reordered'`,
   * for listeners that are not the caller.
   */
  shuffle(): Promise<readonly PlaylistEntry[]>
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
   *
   * Carries the same {@link shuffle} caveat about `trackChanged`: mpv keeps the
   * *entry* current, so the music does not stop, but `playlist-pos` almost
   * certainly moves and surfaces as a `trackChanged` for a track that did not
   * change.
   *
   * @returns The queue after the restore, exactly as {@link entries} would
   * report it — including when the undo did nothing, which is how a caller can
   * tell. Also emits {@link PlayerEventMap.queueChanged} with
   * `reason: 'reordered'`.
   */
  unshuffle(): Promise<readonly PlaylistEntry[]>
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
 * Default {@link NetworkReconnectOptions.maxDelaySeconds}.
 *
 * FFmpeg's own default is `120`, i.e. it would keep retrying for over two
 * minutes (`http.c:200`, `{ .i64 = 120 }`). That is a sensible default for a
 * download tool and a terrible one for a media session: the player would sit in
 * a silent, uncancellable-looking limbo while the notification still said
 * "playing".
 *
 * `5` is chosen against FFmpeg's actual backoff, which is `delay = 1 + 2 *
 * delay` starting at `0` and stops once the *next* delay exceeds this bound —
 * so it means attempts at 0 s, 1 s and 3 s, ~4 s of trying, three chances at a
 * network blip. Long enough to ride out a cell handover, short enough that a
 * genuinely dead source is reported while the user is still looking at the
 * screen — and short enough that {@link PlayerOptions.retry}, which runs
 * *after* this gives up, still gets to act promptly.
 */
export const DEFAULT_RECONNECT_DELAY_MAX_SECONDS = 5

/**
 * FFmpeg's own domain for `reconnect_delay_max` — `AV_OPT_TYPE_INT` with
 * `max = UINT_MAX / 1000 / 1000` (`libavformat/http.c:200`, FFmpeg 8.1.2).
 */
const RECONNECT_DELAY_MAX_CEILING = 4294

/**
 * Default {@link RetryOptions.maxAttempts}.
 *
 * Two, because the failure this exists for — a stream that dropped, a CDN edge
 * that blinked — is overwhelmingly fixed by the first re-attempt, and a second
 * covers the case where the first landed on the same bad edge. Beyond that the
 * evidence says the source is down, and since there is no delay between
 * attempts (see {@link RetryOptions}) a larger budget would not wait for
 * anything to recover — it would just burn through connects and make the queue
 * appear stuck.
 */
export const DEFAULT_RETRY_MAX_ATTEMPTS = 2

/**
 * How long a live entry must play, after a {@link RetryOptions.retryLiveEof}
 * re-attempt, before its attempt budget starts over.
 *
 * @remarks
 * `30`, and the number is chosen against two bounds rather than picked:
 *
 * - **It must be longer than a reconnect loop can plausibly take**, or a server
 *   that accepts a connection and immediately hangs up would reset the budget
 *   on every cycle and retry forever — the exact bug this constant exists to
 *   prevent. Such a cycle completes in well under a second; even layer 1 gives
 *   up after ~4 s at the default `reconnect_delay_max` of
 *   {@link DEFAULT_RECONNECT_DELAY_MAX_SECONDS}. 30 s clears that by an order
 *   of magnitude.
 * - **It must be shorter than any real listening session**, so a station that
 *   drops once an hour recovers every time instead of exhausting a budget it
 *   spent months ago. Half a minute of continuous audio is the smallest
 *   interval nobody would call "it never really played".
 *
 * It is deliberately the same number as {@link DEFAULT_CACHE_SECS}, which makes
 * it say something concrete rather than arbitrary: the entry played for longer
 * than the audio the player is willing to hold, so what the listener heard came
 * from the network over time and not from one cache fill.
 *
 * Measured as **wall-clock since the restart**, not decoded seconds: a live
 * stream that is playing advances both at the same rate, and reading `time-pos`
 * instead would put a synchronous mpv round-trip on a failure path (see
 * `#handleBatch`'s read budget) to learn something this already knows.
 */
export const LIVE_EOF_BUDGET_RESET_SECONDS = 30

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

/** Every accepted {@link GaplessAudioMode}, for runtime validation. */
const GAPLESS_AUDIO_MODES: readonly GaplessAudioMode[] = ['no', 'yes', 'weak']

/** mpv's own domain for `--pitch` (`options/options.c`: `M_RANGE(0.01, 100.0)`). */
const PITCH_MIN = 0.01
const PITCH_MAX = 100

/** Every accepted {@link AudioChannelMode}, for runtime validation. */
const AUDIO_CHANNEL_MODES: readonly AudioChannelMode[] = [
  'auto-safe',
  'auto',
  'stereo',
  'mono',
]

/**
 * The default number of seconds into an entry after which
 * {@link PlaylistApi.previous} restarts it instead of going back.
 *
 * @remarks
 * Three seconds is the convention every music player converged on — long
 * enough that a mis-tap during an intro still goes back, short enough that
 * "restart this song" is reachable without hunting for a scrubber. It is a
 * default rather than a rule: pass your own `restartThreshold`, or `0` to opt
 * out and always move.
 */
export const DEFAULT_RESTART_THRESHOLD_SECONDS = 3

/**
 * Options for {@link Player.setLoudnessNormalization}.
 *
 * Every field is optional; an omitted field falls back to the default named on
 * it. The names and units are ffmpeg `loudnorm`'s own (verified against the
 * FFmpeg 8.1.2 tree our binaries are built from — `libavfilter/af_loudnorm.c`
 * and `doc/filters.texi`), so a value copied from any loudnorm reference means
 * the same thing here.
 */
export interface LoudnessNormalizationOptions {
  /**
   * Integrated loudness target in LUFS (`loudnorm`'s `I`), `-70 … -5`.
   *
   * Defaults to {@link DEFAULT_LOUDNESS_TARGET_LUFS} (−16 LUFS) — **not**
   * ffmpeg's own −24, which is a broadcast-derived number. −16 LUFS is AES
   * TD1008.1.21-9's recommendation for track-normalized music on streaming
   * services ("Recommendations for Loudness of Internet Audio Streaming and
   * On-Demand Distribution", Table 1: track-normalized music −16 LUFS; Table 2:
   * pop-music streams −16 LUFS, news/talk −18). On phone hardware −24 leaves
   * music so quiet that users max the volume and blame the app.
   */
  readonly targetLufs?: number
  /**
   * Loudness range target in LU (`LRA`), `1 … 50`. Defaults to ffmpeg's `7`
   * (`af_loudnorm.c:109`).
   *
   * In the one-pass dynamic mode this API runs in, this is a *shaping hint*
   * for how hard the gain ride may compress loudness variation, not a
   * guarantee of the output's measured LRA.
   */
  readonly loudnessRange?: number
  /**
   * Maximum true peak in dBTP (`TP`), `-9 … 0`. Defaults to ffmpeg's `-2`
   * (`af_loudnorm.c:111`) — 1 dB more conservative than the −1 dBTP ceiling
   * AES TD1008 asks of streams at the codec input, which buys headroom against
   * lossy-decoder overshoot for free (the ceiling only matters when the
   * limiter is already engaging).
   */
  readonly truePeakDb?: number
  /**
   * Treat a mono file as dual-mono (`dual_mono`). Defaults to ffmpeg's
   * `false`. Set it when mono content is played on stereo outputs and sounds
   * ~3 dB too loud after normalization — that offset is exactly what this
   * compensates (ffmpeg `doc/filters.texi`, loudnorm `dual_mono`).
   */
  readonly dualMono?: boolean
}

/**
 * Default integrated-loudness target of {@link Player.setLoudnessNormalization},
 * in LUFS. See {@link LoudnessNormalizationOptions.targetLufs} for why −16 and
 * not ffmpeg's −24.
 */
export const DEFAULT_LOUDNESS_TARGET_LUFS = -16

/**
 * The mpv filter label of the managed loudness-normalization entry.
 *
 * {@link Player.setLoudnessNormalization} owns exactly one `af` entry, and this
 * label is how it is recognisable — in {@link Player.getAudioFilters}
 * read-backs (`@rnmedia_loudnorm:loudnorm=…`) and in mpv's own logs. The label
 * is reserved: {@link Player.setAudioFilters} rejects user entries carrying it,
 * because two owners of one label would silently overwrite each other.
 */
export const LOUDNESS_NORMALIZATION_LABEL = 'rnmedia_loudnorm'

/**
 * Resolve {@link LoudnessNormalizationOptions} into the managed, labelled
 * `loudnorm` entry plus the frozen options {@link Player.getLoudnessNormalization}
 * reports. Range validation is delegated to `AudioFilters.loudnorm`, the one
 * place that owns ffmpeg's documented bounds.
 */
function buildLoudnessNormalization(options: LoudnessNormalizationOptions): {
  readonly filter: AudioFilter
  readonly options: Readonly<LoudnessNormalizationOptions>
} {
  const resolved: LoudnessNormalizationOptions = Object.freeze({
    targetLufs: options.targetLufs ?? DEFAULT_LOUDNESS_TARGET_LUFS,
    ...(options.loudnessRange !== undefined && {
      loudnessRange: options.loudnessRange,
    }),
    ...(options.truePeakDb !== undefined && { truePeakDb: options.truePeakDb }),
    ...(options.dualMono !== undefined && { dualMono: options.dualMono }),
  })
  const filter = AudioFilters.loudnorm({
    integrated: resolved.targetLufs,
    ...(resolved.loudnessRange !== undefined && {
      loudnessRange: resolved.loudnessRange,
    }),
    ...(resolved.truePeakDb !== undefined && {
      truePeak: resolved.truePeakDb,
    }),
    ...(resolved.dualMono !== undefined && { dualMono: resolved.dualMono }),
  })
  return {
    filter: { ...filter, label: LOUDNESS_NORMALIZATION_LABEL },
    options: resolved,
  }
}

/**
 * An argument this library rejects before it can reach mpv.
 *
 * `invalid-state` is the taxonomy's slot for "this call cannot be honoured as
 * made"; using it keeps every failure a typed {@link PlayerError} instead of a
 * bare `TypeError`.
 */
function invalidArgument(message: string): PlayerErrorException {
  return new PlayerErrorException({
    code: 'invalid-state',
    message,
    retryable: false,
  })
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
 * Validate {@link NetworkReconnectOptions} against FFmpeg's own value domain.
 *
 * Done here rather than left to FFmpeg because mpv's `stream-lavf-o` swallows
 * bad AVOptions in silence — "Unknown or misspelled options are silently
 * ignored" (mpv 0.41.0 `options.rst`) — so an out-of-range value would not
 * fail, it would simply not apply, and the reconnection an app thought it had
 * configured would not exist.
 */
function assertNetworkReconnect(options: NetworkReconnectOptions): void {
  const max = options.maxDelaySeconds
  if (max === undefined) return
  if (!Number.isInteger(max) || max < 0 || max > RECONNECT_DELAY_MAX_CEILING) {
    throw invalidArgument(
      `\`networkReconnect.maxDelaySeconds\` must be an integer between 0 and ${RECONNECT_DELAY_MAX_CEILING} ` +
        `(FFmpeg's own range for \`reconnect_delay_max\`); got ${max}.`
    )
  }
}

/**
 * The `stream-lavf-o` value implementing {@link NetworkReconnectOptions}.
 *
 * Emits nothing when disabled, which leaves FFmpeg's defaults (every reconnect
 * option off) rather than writing them out — an absent key is also what lets a
 * raw `mpvOptions['stream-lavf-o']` be the only writer.
 *
 * Booleans are spelled `1`/`0`: FFmpeg's `set_string_bool` accepts
 * `true/y/yes/enable/enabled/on` and the negatives too (`libavutil/opt.c:568`),
 * but the numeric form is the one that cannot be misread by any AVOption
 * consumer. See {@link NetworkReconnectOptions} for what each key does and for
 * the one option deliberately left out.
 */
function networkReconnectOptions(
  options: NetworkReconnectOptions | undefined
): Record<string, string> {
  if (options?.enabled === false) return {}
  const maxDelay =
    options?.maxDelaySeconds ?? DEFAULT_RECONNECT_DELAY_MAX_SECONDS
  return {
    [MpvProperty.streamLavfO]: [
      'reconnect=1',
      'reconnect_on_network_error=1',
      'reconnect_streamed=1',
      `reconnect_delay_max=${maxDelay}`,
    ].join(','),
  }
}

/** {@link RetryOptions}, validated and defaulted. */
interface ResolvedRetryOptions {
  readonly maxAttempts: number
  readonly retryLiveEof: boolean
}

/** Validate {@link RetryOptions} and resolve it to plain values. */
function resolveRetryOptions(
  options: RetryOptions | undefined
): ResolvedRetryOptions {
  const attempts = options?.maxAttempts
  if (attempts !== undefined && (!Number.isInteger(attempts) || attempts < 0)) {
    throw invalidArgument(
      `\`retry.maxAttempts\` must be a non-negative integer; got ${attempts}.`
    )
  }
  const live = options?.retryLiveEof
  // A boolean union is only a compile-time guarantee; a JavaScript caller (or a
  // value read from JSON) can still get here, and a truthy string quietly
  // turning on a policy that re-attempts finished broadcasts is exactly the
  // kind of silent yes this library rejects everywhere else.
  if (live !== undefined && typeof live !== 'boolean') {
    throw invalidArgument(
      `\`retry.retryLiveEof\` must be a boolean; got ${String(live)}.`
    )
  }
  return {
    maxAttempts: attempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
    retryLiveEof: live ?? false,
  }
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
  // A string union is only a compile-time guarantee; a JavaScript caller (or a
  // value read from JSON) can still get here. Caught before `mpv_create()` for
  // the same reason as everything else in this function.
  if (
    options.gaplessAudio !== undefined &&
    !GAPLESS_AUDIO_MODES.includes(options.gaplessAudio)
  ) {
    throw invalidArgument(
      `\`gaplessAudio\` must be one of ${GAPLESS_AUDIO_MODES.map((mode) => `'${mode}'`).join(', ')} (mpv's own domain for \`gapless-audio\`); got '${String(options.gaplessAudio)}'.`
    )
  }
  // Both are our own budgets, not mpv's, so the only invalid values are the
  // ones that cannot mean anything: negative, NaN, Infinity.
  assertNonNegative(options.resolverTimeoutMs, 'resolverTimeoutMs')
  assertNonNegative(options.resolverTtlMs, 'resolverTtlMs')
  if (options.replayGain !== undefined) assertReplayGain(options.replayGain)
  if (options.networkReconnect !== undefined) {
    assertNetworkReconnect(options.networkReconnect)
  }
  // Throws on a bad budget; the resolved value is recomputed in `create()`.
  resolveRetryOptions(options.retry)
}

function assertNonNegative(value: number | undefined, option: string): void {
  if (value === undefined) return
  if (!Number.isFinite(value) || value < 0) {
    throw invalidArgument(
      `\`${option}\` must be a finite number >= 0; got ${value}.`
    )
  }
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
 * The `index` argument of `loadfile`, meaning "not an insertion".
 *
 * @remarks
 * mpv 0.38 inserted a new third parameter into `loadfile`, shifting the option
 * list from third place to fourth:
 *
 * ```text
 * 0.35:  loadfile <url> [<flags> [<options>]]
 * 0.41:  loadfile <url> [<flags> [<index> [<options>]]]
 * ```
 *
 * `index` is an `OPT_INT` used only by the `insert-at` actions, and mpv's own
 * manual is blunt about the consequence: "This breaks all existing uses of this
 * command which make use of the argument to include the list of options […] the
 * third argument now needs to be set to -1 if the fourth argument needs to be
 * used" (mpv 0.41 `input.rst`, `loadfile`).
 *
 * So every call that carries file options must pass this placeholder first.
 * Getting it wrong is not a compile error and not even a loud runtime one — the
 * option string would simply be parsed as an integer and the command would fail,
 * which on this library's hottest path (every `.m3u8`, which always carries
 * `demuxer=lavf`) means HLS silently stops loading.
 */
const LOADFILE_NO_INDEX = '-1'

/**
 * Every `loadfile` action this library emits — mpv 0.41.0 `input.rst`'s second
 * argument, verbatim.
 *
 * The four `insert-*` members are what {@link PlaylistApi.add} compiles a
 * `position` into; see {@link loadfileFlagFor} for the mapping.
 */
type LoadfileFlag =
  | 'replace'
  | 'append'
  | 'append-play'
  | 'insert-next'
  | 'insert-next-play'
  | 'insert-at'
  | 'insert-at-play'

/**
 * Assemble a `loadfile` argument vector for the pinned engine.
 *
 * Kept as one function so the `index` placeholder above is written down once
 * rather than at each of the call sites.
 *
 * @param index - The insertion index for `insert-at`/`insert-at-play`. mpv
 * ignores this argument for every other action ("This argument will be ignored
 * for all other actions", mpv 0.41.0 `input.rst`), so it is only ever passed
 * with those two flags — and the {@link LOADFILE_NO_INDEX} placeholder covers
 * everything else that needs to reach the fourth argument.
 */
function buildLoadfileArgs(
  source: string,
  flags: LoadfileFlag,
  fileOptions: string | undefined,
  index?: number
): string[] {
  const args = ['loadfile', source, flags]
  if (index !== undefined) {
    args.push(String(index))
  } else if (fileOptions !== undefined) {
    // Only append the placeholder when there is a fourth argument to reach —
    // a bare `loadfile <url> <flags>` is identical in every mpv version.
    args.push(LOADFILE_NO_INDEX)
  }
  if (fileOptions !== undefined) args.push(fileOptions)
  return args
}

/**
 * The whole `position` × `play` table of {@link PlaylistAddOptions}, in one
 * place, mapped onto mpv 0.41.0's `loadfile` actions.
 *
 * | `position`  | `play: false` (default) | `play: true`       |
 * | ----------- | ----------------------- | ------------------ |
 * | *(omitted)* | `append`                | `append-play`      |
 * | `'next'`    | `insert-next`           | `insert-next-play` |
 * | `number`    | `insert-at`             | `insert-at-play`   |
 *
 * Each cell is **one** mpv command. The `insert-*` actions are the reason this
 * table exists: before mpv 0.38 an "insert" had to be spelled as an `append`
 * followed by a `playlist-move`, which is two commands, two playlist mutations
 * and a window in between where the queue is wrong — visible to any observer of
 * `playlist-count`, and to mpv's own prefetch, which reads the queue whenever it
 * likes.
 */
function loadfileFlagFor(
  position: 'next' | number | undefined,
  play: boolean
): LoadfileFlag {
  if (position === undefined) return play ? 'append-play' : 'append'
  if (position === 'next') return play ? 'insert-next-play' : 'insert-next'
  return play ? 'insert-at-play' : 'insert-at'
}

/**
 * Build the per-file option list `loadfile` takes as its LAST argument —
 * `opt1=value1,opt2=value2,…` (mpv 0.41 `input.rst`, `loadfile`). See
 * {@link LOADFILE_NO_INDEX} for why it is no longer the third.
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
 *
 * ## Escaping
 * mpv parses this string with `parse_keyvalue_list()`, which reads each key and
 * each value through `read_subparam()` — the same function the `af` chain goes
 * through (`filters.ts`). So the same rule applies here, and it is applied to
 * *everything*, including this library's own `start` and `demuxer` values:
 * anything outside mpv's `NAMECH` alphabet is written in mpv's fixed-length
 * `%<bytes>%<value>` form. See `subparam.ts` for why that form and not quotes.
 */
function formatFileOptions(
  options: SourceOptions,
  source: string
): string | undefined {
  const raw = options.mpvOptions
  const parts: string[] = []
  // Every key and every value goes through mpv's own quoting. `read_subparam`
  // (`options/m_option.c:1984`) is what parses both halves of every pair here,
  // and its fixed-length form is the only one with no forbidden characters —
  // see `subparam.ts`. Without it a value containing a comma silently truncates
  // the option list and shifts everything after it, which is precisely how
  // `http-header-fields` (a comma-separated list *inside* a comma-separated
  // list) used to corrupt a load.
  const push = (key: string, value: string): void => {
    parts.push(`${escapeSubparam(key)}=${escapeSubparam(value)}`)
  }
  if (options.startPosition !== undefined) {
    push('start', String(options.startPosition))
  }
  if (raw?.[DEMUXER_OPTION] === undefined && needsHlsDemuxer(source)) {
    push(DEMUXER_OPTION, HLS_DEMUXER)
  }
  if (
    options.headers !== undefined &&
    raw?.[HTTP_HEADER_FIELDS_OPTION] === undefined
  ) {
    // Throws on an unusable header name/value before anything reaches mpv.
    const fields = compileHttpHeaderFields(options.headers)
    if (fields !== undefined) push(HTTP_HEADER_FIELDS_OPTION, fields)
  }
  for (const [key, value] of Object.entries(raw ?? {})) {
    push(key, value)
  }
  return parts.length > 0 ? parts.join(',') : undefined
}

/**
 * Whether an event moves the playlist cursor, i.e. changes the current entry.
 *
 * The mirror of `isPositionDiscontinuity`: it marks the batches that must pay
 * for the one-shot `duration`/`seekable`/`media-title` reads, because mpv will
 * not republish those for the new entry. See `ReducerContext.trackChange`.
 */
function isTrackChange(event: PlayerEvent): boolean {
  return event.kind === 'property' && event.name === MpvProperty.playlistPos
}

/**
 * The playlist index a batch leaves the cursor on, or `undefined` when the
 * batch did not move it.
 *
 * The *last* `playlist-pos` in the batch wins, because that is the value mpv
 * left behind — a batch that accumulated across two boundaries carries both,
 * and the one-shot reads must describe where the cursor ended up rather than
 * where it passed through. (Native coalescing usually collapses these to one
 * already; this does not depend on that.)
 */
function trackChangeIndexOf(
  events: readonly PlayerEvent[]
): number | undefined {
  let index: number | undefined
  for (const event of events) {
    if (!isTrackChange(event)) continue
    const value = event.kind === 'property' ? event.value : undefined
    index = typeof value === 'number' ? Math.trunc(value) : -1
  }
  return index
}

/**
 * Whether an event means "what mpv will open next may have changed".
 *
 * The cursor moving is the obvious case; the queue growing or shrinking is the
 * other one, because `playlist.add()` and `playlist.remove()` change which entry
 * follows the current one without moving the cursor at all. Both are property
 * changes this player already observes, which is why resolve-ahead needs no
 * native event of its own.
 */
function isQueueMovement(event: PlayerEvent): boolean {
  return (
    event.kind === 'property' &&
    (event.name === MpvProperty.playlistPos ||
      event.name === MpvProperty.playlistCount)
  )
}

/**
 * What one track-change read moment produced.
 *
 * `reads` is the reducer's half ({@link TrackChangeReads}); `uri` is the
 * Player's — the logical URI of the entry that just became current, used for
 * error classification and never published in {@link PlayerState}. They are
 * separated so the reducer's input stays exactly what the reducer consumes.
 */
interface TrackChangeSnapshot {
  readonly reads: TrackChangeReads
  readonly uri?: string
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
  #visualizer: VisualizerController | undefined
  #resolution: SourceResolverController | undefined
  /**
   * The reason of the position jump currently in flight, i.e. the one a
   * `seekStarted` announced and the next `playbackRestart` will complete.
   *
   * `undefined` means nothing is pending — which is also what an `end-file`
   * leaves behind, so a seek that never landed cannot glue itself onto the next
   * entry's restart. See {@link PlayerEventMap.seekStarted}.
   */
  #pendingDiscontinuity: PositionDiscontinuityReason | undefined

  /**
   * The attempt budget from {@link RetryOptions.maxAttempts}. `0` disables
   * retrying, which is mpv's own behaviour.
   */
  #maxRetryAttempts = DEFAULT_RETRY_MAX_ATTEMPTS
  /** {@link RetryOptions.retryLiveEof}. */
  #retryLiveEof = false
  /**
   * The entry currently being re-attempted, and how many attempts it has cost.
   *
   * One record, not a map: mpv plays one entry at a time, so there is exactly
   * one generation in flight. It is dropped — the "generation" resetting — by
   * {@link #resetRetry}, which every cursor move and every queue edit calls.
   */
  #retry:
    | {
        readonly index: number
        readonly attempts: number
        /**
         * The generation was armed by {@link RetryOptions.retryLiveEof} rather
         * than by a failure. It resets on *sustained playback* instead of on
         * the first restart — see {@link LIVE_EOF_BUDGET_RESET_SECONDS}.
         */
        readonly live: boolean
        /**
         * When the re-attempt actually started playing, for the sustained-
         * playback reset. `undefined` until a restart is seen; only ever set on
         * a `live` generation.
         */
        readonly restartedAt?: number
      }
    | undefined

  /**
   * The chain the app last set through {@link setAudioFilters} — the "user
   * half" of the `af` property. Kept so the managed loudness-normalization
   * entry can be added or removed without clobbering it (and vice versa).
   * Committed only *after* the property write succeeded, so a chain mpv
   * rejected never poisons the bookkeeping.
   */
  #userAudioFilters: readonly AudioFilter[] = []
  /**
   * The managed loudness-normalization entry, when enabled: the compiled
   * filter (labelled {@link LOUDNESS_NORMALIZATION_LABEL}) plus the resolved
   * options {@link getLoudnessNormalization} reports. Same commit-after-write
   * rule as `#userAudioFilters`.
   */
  #loudnessNormalization:
    | {
        readonly filter: AudioFilter
        readonly options: Readonly<LoudnessNormalizationOptions>
      }
    | undefined

  readonly #stateListeners = new Set<(state: PlayerState) => void>()
  readonly #eventListeners: {
    [K in PlayerEventName]: Set<PlayerEventMap[K]>
  } = {
    trackEnded: new Set(),
    queueEnded: new Set(),
    error: new Set(),
    retrying: new Set(),
    queueChanged: new Set(),
    trackChanged: new Set(),
    chapterChanged: new Set(),
    seekStarted: new Set(),
    seekCompleted: new Set(),
    metadataChanged: new Set(),
    prefetchStarted: new Set(),
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
    const retry = resolveRetryOptions(options.retry)
    player.#maxRetryAttempts = retry.maxAttempts
    player.#retryLiveEof = retry.retryLiveEof
    player.#visualizer = new VisualizerController(client)
    player.#resolution = new SourceResolverController(client, {
      timeoutMs: options.resolverTimeoutMs ?? DEFAULT_RESOLVER_TIMEOUT_MS,
      ttlMs: options.resolverTtlMs ?? DEFAULT_RESOLVER_TTL_MS,
      onError: (error) => {
        // A resolver failure is not an entry that failed to play, so no
        // attempt budget applies to it and the count is honestly zero. mpv is
        // still going to try the logical URI, and if *that* fails it arrives
        // through the `end-file` path where retrying does apply.
        player.#emit('error', error, { attempts: 0 })
      },
      now,
    })

    try {
      client.setEventBatchListener((events) => player.#handleBatch(events))
      // Registered unconditionally, and it costs nothing: `initialize()`
      // registers both mpv hooks always (see the spec's note on why lazy
      // registration was abandoned), but a *disarmed* handler continues every
      // hook immediately and never asks anyone — so a player with no resolver
      // never produces a request for this listener to receive.
      client.setSourceResolutionListener((request) => {
        player.#resolution?.handleRequest(request)
      })
      // Registered unconditionally, and it costs nothing here: the hook that
      // produces these fires only when mpv is actually prefetching, and the
      // emission walks an empty listener set when nobody subscribed.
      client.setPrefetchStartedListener((event) => {
        player.#emit('prefetchStarted', event)
      })
      // Registered unconditionally, and it costs nothing: no sampler thread
      // exists until something subscribes, so an app that never draws a
      // spectrum never pays for one.
      client.setVisualizerListener((capture) => {
        player.#visualizer?.handleCapture(capture)
        return true
      })
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
        ...(options.gaplessAudio === undefined
          ? {}
          : { [MpvProperty.gaplessAudio]: options.gaplessAudio }),
        ...networkReconnectOptions(options.networkReconnect),
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
      if (options.sourceResolver !== undefined) {
        player.setSourceResolver(options.sourceResolver)
      }
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

  /**
   * Whether playback is currently un-paused — {@link PlayerState.playing} as a
   * method.
   *
   * A convenience, but not only that: it is what makes a `Player` satisfy
   * `@rn-media/audio-session`'s `AudioSessionPlayerLike.isPlaying`, which
   * `wireAudioSession` consults to tell its own interruption pause apart from
   * one the user asked for — a user pause must never be auto-resumed when the
   * interruption ends.
   *
   * Reflects the *observed* mpv `pause` property: for a few milliseconds after
   * {@link play}/{@link pause} it still reports the previous value, until the
   * property change round-trips through the native event loop. Subscribe with
   * {@link onStateChange} when the transition itself matters.
   */
  isPlaying(): boolean {
    return this.#state.playing
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
   * Dismiss a settled error from {@link state}, without pretending it did not
   * happen.
   *
   * @returns `true` if there was an error to clear.
   *
   * @remarks
   * **You usually do not need this.** `state.error` clears itself three ways —
   * a new entry starting, playback restarting, or a deliberate stop — all of
   * which are documented on {@link PlayerState.error}. It survives in exactly
   * one situation: the last entry failed and nothing has happened since. This
   * is the button for that, i.e. for a user dismissing a banner.
   *
   * **It clears state, never events.** The `error` event has already fired and
   * is already in your logs; nothing here suppresses a future one, replays a
   * past one, or makes the failure un-happen. If you want fewer error events,
   * the knob is {@link PlayerOptions.retry}, which changes what *is* a final
   * failure — not this, which only changes what the UI is still showing.
   *
   * `status` moves to `'idle'`, because `error` and `status: 'error'` are one
   * fact and a snapshot carrying one without the other would be a lie. Listeners
   * are notified exactly as for any other snapshot change.
   */
  clearError(): boolean {
    this.#assertAlive('clearError')
    const next = clearPlayerError(this.#state)
    if (next === this.#state) return false
    this.#state = next
    for (const listener of [...this.#stateListeners]) listener(next)
    return true
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
    // A caller replacing what is playing has superseded whatever the retry
    // machinery was still arguing about. See `RetryOptions`.
    this.#resetRetry()
    this.#currentUri = source
    // Before the command, not after: `loadfile` makes mpv open the source, and
    // resolving first is what lets the load hook hit a warm cache instead of
    // holding mpv's core open while JavaScript answers.
    this.#resolution?.resolveAhead([source])
    if (options.autoPlay === false) {
      this.#setBool(MpvProperty.pause, true)
    } else if (options.autoPlay === true) {
      this.#setBool(MpvProperty.pause, false)
    }
    const fileOptions = formatFileOptions(options, source)
    await this.command(buildLoadfileArgs(source, 'replace', fileOptions))
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
    if (options.shuffle === true && options.startPosition !== undefined) {
      throw invalidArgument(
        '`shuffle` and `startPosition` cannot be combined: the offset applies ' +
          'to the entry at `startIndex`, and after mpv shuffles the whole ' +
          'playlist no index identifies the source you passed at that ' +
          'position. Load in order and call `playlist.shuffle()` afterwards, ' +
          'or seek once playback has started.'
      )
    }
    if (options.shuffle === true && options.startIndex !== undefined) {
      throw invalidArgument(
        '`shuffle` and `startIndex` cannot be combined: mpv shuffles the whole ' +
          'playlist, so an index no longer identifies the source you passed at ' +
          'that position. Shuffle the sources yourself, or load in order and ' +
          'call `playlist.shuffle()` afterwards.'
      )
    }
    this.#resetRetry()
    const startIndex = options.startIndex ?? 0
    this.#currentUri = sources[startIndex] ?? sources[0]

    // The entry that is about to play, and the one after it. Everything further
    // out is resolved as the queue reaches it, so a 500-track queue does not
    // sign 500 URLs up front. With `shuffle` the guess may be wrong, and the
    // cost of being wrong is one wasted resolution.
    this.#resolution?.resolveAhead(
      [sources[startIndex], sources[startIndex + 1]].filter(
        (source): source is string => source !== undefined
      )
    )

    if (options.autoPlay === false) {
      this.#setBool(MpvProperty.pause, true)
    } else if (options.autoPlay === true) {
      this.#setBool(MpvProperty.pause, false)
    }

    // `stop` clears the playlist outright, so the queue is built from a clean
    // slate; `loadfile … replace` would start entry 0 before we could jump.
    await this.command(['stop'])
    if (sources.length === 0) return

    // Everything except the start offset, which belongs to one entry.
    const { startPosition: _startPosition, ...sharedOptions } = options

    for (const [index, source] of sources.entries()) {
      // Per entry, not once for the whole queue: the HLS guard is decided by
      // each source's own extension, so a `.m3u8` next to a `.mp3` gets the
      // forced demuxer and the `.mp3` does not.
      //
      // And `startPosition` is attached to the entry at `startIndex` ONLY.
      // Attaching it to every entry — which is what this did until 0.1.0 —
      // makes the natural session-restore call, `{ startIndex: 5,
      // startPosition: 120 }`, start every track in the queue two minutes in,
      // silently: `start` is a per-file option, so nothing observable reports
      // it back. See `LoadPlaylistOptions.startPosition`.
      const fileOptions = formatFileOptions(
        index === startIndex ? options : sharedOptions,
        source
      )
      await this.command(buildLoadfileArgs(source, 'append', fileOptions))
    }
    // Shuffle before the jump, never after: the jump is what starts playback,
    // and shuffling a playing queue would renumber the entry mpv just started.
    // Nothing has played yet at this point, so "shuffle the whole list" and
    // "shuffle what's left to play" are the same thing here.
    if (options.shuffle === true) await this.command(['playlist-shuffle'])
    await this.command(['playlist-play-index', String(startIndex)])
  }

  // -------------------------------------------------------------------------
  // Source resolution
  // -------------------------------------------------------------------------

  /**
   * Install (or remove) the function that turns a queue's logical URIs into the
   * URLs mpv actually opens.
   *
   * @param resolver - See {@link SourceResolver} — read its remarks before
   * writing one, in particular the determinism requirement. Pass `null` to
   * remove the current resolver; every URI then passes through untouched again.
   * @throws {@link PlayerErrorException} if the player has been destroyed, or
   * if mpv rejects the hook registration.
   *
   * @example
   * ```ts
   * player.setSourceResolver(async ({ uri }) =>
   *   uri.startsWith('library://') ? await sign(uri) : uri
   * )
   * await player.loadPlaylist(['library://a', 'library://b'])
   * ```
   *
   * @remarks
   * **What this buys you over resolving in your own code before `loadPlaylist`.**
   * A URL signed at queue-build time has to stay valid for the whole queue; a
   * URL resolved through this hook is minted per entry, moments before mpv opens
   * it, so signature lifetimes can be short. It also survives everything that
   * changes the queue behind your back — `playlist.next()`, repeat, shuffle,
   * a resumed session — because mpv asks for whatever entry it is actually
   * about to play rather than whatever you predicted.
   *
   * **Cost when installed but idle.** The current and next entries are resolved
   * as the queue moves — two calls per track change, de-duplicated and cached —
   * and each answer is pushed into a native cache that the hook reads
   * synchronously. Nothing polls, nothing is streamed, and a URI that is already
   * resolved costs a map lookup.
   *
   * **Cost when not installed.** One immediate `mpv_hook_continue` per load
   * boundary, and nothing else — no property read, no rewrite, no JavaScript.
   * The two load hooks are registered when the core starts rather than when a
   * resolver arrives, because the fork's "behaves exactly like stock mpv"
   * guarantee holds only while the hook name has *no* client at all: registering
   * late would not preserve stock behaviour, it would only move the moment
   * behaviour changes into the middle of a session, where nothing can measure
   * it. That also makes {@link PlayerEventMap.prefetchStarted} available to
   * players that never resolve anything.
   *
   * **One caveat worth knowing.** mpv normalises the URI it hands back inside
   * the hook: URLs pass through verbatim, but a *relative* local path is made
   * absolute against the process's working directory (`mp_normalize_path`,
   * mpv 0.41.0 `player/command.c:564`). Key your queue off URLs or absolute
   * paths and this never comes up.
   */
  setSourceResolver(resolver: SourceResolver | null): void {
    this.#assertAlive('setSourceResolver')
    this.#guard(() => {
      this.#resolution?.set(resolver)
    })
    // Warm the cache for what is already queued, so installing a resolver
    // mid-playback does not make the next transition pay for a cold resolve.
    if (resolver !== null) this.#resolveAhead()
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
   * Seek by a delta relative to the current position.
   *
   * @param deltaSeconds - Seconds to move; negative seeks backwards.
   *
   * @remarks
   * **Not `seekTo(getPosition() + delta)`.** That is what an app has to write
   * without this method, and it races the projection: the position it reads is
   * extrapolated from an anchor that may be a few hundred milliseconds old, so
   * a rapid tap on a ±15 s button accumulates the projection error into the
   * target. mpv's `relative` seek is applied to *mpv's* clock, at the instant
   * the command runs, and cannot drift.
   *
   * Uses `relative+exact` — precise rather than nearest-keyframe — matching
   * {@link seekTo}. mpv's own default for a relative seek is `keyframes`
   * (fast), but for audio the difference is a decode of at most a frame or two,
   * and a jump-back button that lands somewhere other than where the label said
   * is a worse trade than that.
   *
   * mpv clamps the target to the file: seeking past the end ends the entry, and
   * seeking before `0` lands at `0`. On a live stream (`state.isLive`) a
   * backward seek fails inside mpv and playback continues unchanged.
   */
  async seekBy(deltaSeconds: number): Promise<void> {
    this.#assertAlive('seekBy')
    if (!Number.isFinite(deltaSeconds)) {
      throw invalidArgument(
        `\`seekBy\` takes a finite number of seconds; got ${deltaSeconds}.`
      )
    }
    await this.command(['seek', String(deltaSeconds), 'relative+exact'])
  }

  /**
   * Stop playback and unload the current entry, keeping the player — and, by
   * default, the queue — alive.
   *
   * @param options - `clearPlaylist: true` clears the queue too.
   *
   * @remarks
   * This is the transport-button meaning of stop: "stop playing, keep my
   * queue". It sends mpv's `stop keep-playlist` ("Do not clear the playlist").
   * mpv's own default is the opposite — mpv 0.41.0 `input.rst`: "Stop playback
   * and clear playlist. With default settings, this is essentially like
   * `quit`. Useful for the client API: playback can be stopped without
   * terminating the player." That default is deliberately inverted here,
   * because this API is judged against the React Native ecosystem, not against
   * mpv's CLI: react-native-track-player's `stop()` keeps the queue (its
   * queue-clearing call is the separate `reset()` — "Resets the player
   * stopping the current track and clearing the queue"), so a migrator's
   * `stop()` silently destroying a queue would be data loss, while the reverse
   * surprise — the queue still being there — is benign. Destructive behaviour
   * is opt-in, consistent with the rest of the API: pass
   * `{ clearPlaylist: true }` for mpv's full clear.
   *
   * Afterwards the state settles to `status: 'idle'` (mpv ends the entry with
   * reason `stop`, which also clears any `error`). The queue is intact but
   * **nothing is loaded**: mpv leaves no playlist entry "current", and
   * `playlist-pos` reads `-1` whenever "no entry is 'current'" (`input.rst`,
   * property docs) — so `state.playlist` becomes `{ index: -1, count: n }` and
   * {@link PlayerState.hasNext} / {@link PlayerState.hasPrevious} are both
   * `false`. That means {@link play} alone does **not** resume — it only flips
   * `pause` with nothing playing. The way back into the kept queue is
   * {@link PlaylistApi.jumpTo} (or a fresh {@link load}); after
   * `{ clearPlaylist: true }` a new load is the only way, since the queue is
   * gone.
   *
   * @example
   * ```ts
   * await player.stop()                         // queue intact, nothing playing
   * await player.playlist.jumpTo(0)             // …and this is the way back in
   * await player.stop({ clearPlaylist: true })  // mpv's full clear; queue gone
   * ```
   */
  async stop(
    options: { readonly clearPlaylist?: boolean } = {}
  ): Promise<void> {
    this.#assertAlive('stop')
    // Nothing that was being re-attempted survives a deliberate stop.
    this.#resetRetry()
    await this.command(
      options.clearPlaylist === true ? ['stop'] : ['stop', 'keep-playlist']
    )
  }

  /**
   * Set the playback rate.
   *
   * @param rate - Multiplier. Clamped to mpv's documented `0.01 … 100`.
   *
   * @remarks
   * Pitch is preserved: mpv inserts `scaletempo2` automatically whenever the
   * speed is not `1` (`--audio-pitch-correction`, on by default). Use
   * {@link setPitch} for the other axis — it moves pitch *without* moving
   * speed.
   *
   * One practical bound worth knowing: `scaletempo2` mutes its output outside
   * `min-speed`/`max-speed` (`0.25`/`8.0`), so a rate below 0.25× or above 8×
   * is silent rather than fast.
   */
  setRate(rate: number): void {
    this.#assertAlive('setRate')
    this.#setNumber(MpvProperty.speed, clamp(rate, 0.01, 100))
  }

  /**
   * Shift the pitch **without changing the speed**.
   *
   * @param ratio - Frequency multiplier. `1` is the file's own pitch, `2` is an
   * octave up, `0.5` an octave down.
   * @throws {@link PlayerErrorException} with code `invalid-state` when `ratio`
   * is outside mpv's documented `0.01 … 100`.
   *
   * @remarks
   * **A ratio, not semitones, and deliberately so.** mpv's `--pitch` is a
   * frequency factor (mpv 0.41.0 `options.rst`: "Raise or lower the audio's
   * pitch by the factor given as parameter. Does not affect playback speed"),
   * and exposing semitones would mean this library picking a tuning convention
   * and hiding the actual knob. The conversion is one line, and it is the
   * manual's own: "octaves are separated by a factor of 2 whereas semitones are
   * represented by a factor of 2^(1/12)".
   *
   * ```ts
   * const semitones = (n: number) => 2 ** (n / 12)
   * player.setPitch(semitones(-2))   // down a whole tone
   * player.setPitch(semitones(7))    // up a perfect fifth ≈ 1.4983
   * player.setPitch(1)               // back to the recording's own pitch
   * ```
   *
   * **Independent of {@link setRate}.** Both drive mpv's own `scaletempo2` —
   * the same filter already in the chain for speed (ARCHITECTURE §18) — so this
   * needs no ffmpeg filter, no engine flag and no GPL-licensed library
   * (`rubberband` is GPL and is not, and will not be, compiled in). Speed and
   * pitch compose: 1.5× speed with `setPitch(1)` is a faster audiobook at the
   * right pitch; 1× speed with `setPitch(1.06)` is a semitone-up transposition
   * for a singer.
   *
   * **The honest range.** mpv accepts `0.01 … 100` and this method enforces
   * exactly that, but the *useful* range is narrower and mpv says why: "the
   * range of pitch change is effectively limited by the `min-speed` and
   * `max-speed` parameters of `scaletempo2`: for example, a `min-speed` of 0.25
   * limits the highest pitch factor to 4 (1/0.25)". With the defaults (0.25 /
   * 8.0) that is roughly `0.125 … 4` before the output goes silent rather than
   * extreme. Values are validated, never clamped, because a pitch of `0` is a
   * bug in the caller and silently turning it into `0.01` hides it.
   *
   * The current value is in {@link PlayerState.pitch}, and it is *global*: mpv's
   * `--reset-on-next-file` resets nothing by default, so it survives track
   * changes like `speed` and `volume` do.
   */
  setPitch(ratio: number): void {
    this.#assertAlive('setPitch')
    assertInRange(ratio, PITCH_MIN, PITCH_MAX, 'pitch')
    this.#setNumber(MpvProperty.pitch, ratio)
  }

  /**
   * Force a channel layout on the output — including the mono downmix.
   *
   * @param mode - See {@link AudioChannelMode}.
   * @throws {@link PlayerErrorException} with code `invalid-state` for a value
   * outside that union.
   *
   * @remarks
   * `'mono'` is the accessibility case this exists for: single-sided hearing
   * loss, or one earbud in. Both mobile platforms offer it as a system
   * accessibility toggle, and an app that wants its own switch has had no way
   * to ask for one.
   *
   * mpv 0.41.0 `options.rst` on `--audio-channels`: "`--audio-channels=<stereo|
   * mono>` — Force a downmix to stereo or mono." **No filter and no engine flag
   * is involved** — this is mpv's own channel-layout negotiation, not the
   * `pan` filter (which is not compiled into these binaries).
   *
   * Applies to the entry that is already playing: the option carries
   * `UPDATE_AUDIO` (`options/options.c`), so mpv rebuilds the audio chain in
   * place. The rebuild reopens the audio device, so expect a very short gap —
   * this is a settings-screen control, not something to toggle per frame.
   *
   * One documented consequence, mpv's own: a single-layout list "triggers
   * decoder-downmix, which might be different from the normal mpv downmix",
   * because the decision is made before the device is opened.
   */
  setAudioChannels(mode: AudioChannelMode): void {
    this.#assertAlive('setAudioChannels')
    if (!AUDIO_CHANNEL_MODES.includes(mode)) {
      throw invalidArgument(
        `\`setAudioChannels\` takes one of ${AUDIO_CHANNEL_MODES.map((value) => `'${value}'`).join(', ')}; got '${String(mode)}'.`
      )
    }
    this.#setString(MpvProperty.audioChannels, mode)
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
    entries: () => this.#readPlaylistEntries('playlist.entries'),
    add: async (source, options) => {
      this.#assertAlive('playlist.add')
      this.#resetRetry()
      const position = options?.position
      // Validated before the command, like every other typed option here: an
      // out-of-range index must not reach mpv, which would quietly append.
      if (typeof position === 'number') {
        this.#assertInsertIndex(position)
      } else if (position !== undefined && position !== 'next') {
        throw invalidArgument(
          `\`position\` must be 'next' or a playlist index; got '${String(position)}'.`
        )
      }
      // The same per-entry options `load()` accepts. A queued track that needs
      // an `Authorization` header, a start offset or a demuxer hint can carry
      // them itself — before 0.1.0 this call passed nothing at all, so it
      // could not, and no caller would have predicted the asymmetry.
      const fileOptions = formatFileOptions(options ?? {}, source)
      await this.command(
        buildLoadfileArgs(
          source,
          loadfileFlagFor(position, options?.play === true),
          fileOptions,
          typeof position === 'number' ? position : undefined
        )
      )
    },
    remove: async (index) => {
      this.#assertAlive('playlist.remove')
      this.#resetRetry()
      await this.command(['playlist-remove', String(index)])
    },
    move: async (from, to) => {
      this.#assertAlive('playlist.move')
      this.#resetRetry()
      // mpv: "Move the playlist entry at index1, so that it takes the place of
      // the entry index2." For a downward move the target must therefore be
      // shifted by one to land where an array `splice` would put it.
      const target = to > from ? to + 1 : to
      await this.command(['playlist-move', String(from), String(target)])
      // A reorder leaves `playlist-count` identical, so nothing observed
      // changes and no batch will report this. Emitting it here is the only
      // honest route — see `PlayerEventMap.queueChanged`.
      this.#emitReordered()
    },
    jumpTo: async (index, options) => {
      this.#assertAlive('playlist.jumpTo')
      // The user picked an entry. That answers the question a pending retry was
      // asking, so the retry stops arguing. See `RetryOptions`.
      this.#resetRetry()
      await this.#jumpTo(index, options?.autoPlay !== false)
    },
    next: async () => {
      this.#assertAlive('playlist.next')
      this.#resetRetry()
      await this.command(['playlist-next', 'weak'])
    },
    previous: async (options) => {
      this.#assertAlive('playlist.previous')
      const threshold =
        options?.restartThreshold ?? DEFAULT_RESTART_THRESHOLD_SECONDS
      if (!Number.isFinite(threshold) || threshold < 0) {
        throw invalidArgument(
          `\`restartThreshold\` must be a finite number >= 0 seconds; got ${threshold}.`
        )
      }
      this.#resetRetry()
      // Restart only when there is a `0` to go back to: a live stream has no
      // seekable origin and mpv would refuse the seek, leaving the button doing
      // nothing at all — which is worse than moving.
      if (
        threshold > 0 &&
        !this.#state.isLive &&
        this.getPosition() > threshold
      ) {
        await this.seekTo(0)
        return
      }
      await this.command(['playlist-prev', 'weak'])
    },
    clear: async () => {
      this.#assertAlive('playlist.clear')
      this.#resetRetry()
      await this.command(['playlist-clear'])
    },
    shuffle: async () => {
      this.#assertAlive('playlist.shuffle')
      this.#resetRetry()
      await this.command(['playlist-shuffle'])
      this.#emitReordered()
      // Read *after* the command resolved, so this is the permutation mpv
      // actually produced rather than a prediction of one.
      return this.#readPlaylistEntries('playlist.shuffle')
    },
    unshuffle: async () => {
      this.#assertAlive('playlist.unshuffle')
      this.#resetRetry()
      await this.command(['playlist-unshuffle'])
      this.#emitReordered()
      return this.#readPlaylistEntries('playlist.unshuffle')
    },
  }

  /**
   * Turn mpv's `prefetch-playlist` on or off on a running player.
   *
   * @param enabled - Whether mpv may open the *next* queue entry while the
   * current one is finishing.
   * @throws {@link PlayerErrorException} with code `invalid-state` when
   * `enabled` is not a boolean, or if the player has been destroyed.
   *
   * @remarks
   * The runtime twin of {@link PlayerOptions.prefetchPlaylist} — read that
   * first, because **every caveat it documents applies here and one more does
   * on top**. mpv's manual disclaims correctness when the playlist is edited or
   * stepped backwards while an entry is ending, and turning the option on
   * mid-session does not change that; it only changes when you start paying for
   * it. Specifically: an entry inserted after an opener has already started
   * gets no prefetch of its own, and at the boundary mpv logs
   * `Dropping finished prefetch of wrong URL.` and opens cold
   * (`player/loadfile.c:1223`, mpv 0.41.0). See
   * {@link PlaylistAddOptions.position}.
   *
   * Flipping it takes effect from the *next* prefetch decision. Turning it off
   * does not abort an opener already running — mpv checks the option when it
   * decides to prefetch (`prefetch_next()`), not while it is doing so — so one
   * more boundary may still be gapless after you disable it. That is not a race
   * this library could close without cancelling an in-flight open, which would
   * be a worse trade than one extra early connection.
   *
   * There is nothing to undo and no state kept here: this writes mpv's property
   * and mpv is the record. Read it back with
   * `getPropertyBool(MpvProperty.prefetchPlaylist)` if you need to.
   */
  setPrefetchPlaylist(enabled: boolean): void {
    this.#assertAlive('setPrefetchPlaylist')
    if (typeof enabled !== 'boolean') {
      throw invalidArgument(
        `\`setPrefetchPlaylist\` takes a boolean; got '${String(enabled)}'.`
      )
    }
    this.#setBool(MpvProperty.prefetchPlaylist, enabled)
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
   * were. Pass `mode: 'no'` to stop honouring tags — but note that a non-zero
   * `fallback` written earlier is mode-independent and keeps applying (see
   * {@link ReplayGainOptions.fallback}); to return to unity gain, pass
   * `{ mode: 'no', fallback: 0 }`.
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
  // Audio filters (EQ / DSP)
  // -------------------------------------------------------------------------

  /**
   * Replace the audio filter chain (mpv's `af`).
   *
   * Build entries with the `AudioFilters` factories; they compile to mpv's own
   * `af` grammar and are validated against each filter's documented ffmpeg
   * ranges before anything is written. The whole chain is replaced atomically:
   * mpv parses the string first and leaves the previous chain in place if any
   * entry is bad, so a rejected call never leaves playback half-filtered.
   *
   * @param filters - The new chain, in signal-flow order (first entry runs
   * first). Pass `[]` — or call {@link Player.clearAudioFilters} — to remove
   * every filter.
   *
   * @throws {@link PlayerErrorException} with code `invalid-state` when the
   * chain is malformed or a value is out of the filter's range (checked here,
   * before mpv sees it), and with code `mpv` (`errno: -11`,
   * `MPV_ERROR_PROPERTY_ERROR`) when mpv itself rejects it.
   *
   * @remarks
   * **Availability is a property of the binary, not of this API.** mpv resolves
   * any name it does not implement itself through
   * `avfilter_get_by_name()`, so a filter exists only if it was compiled into
   * that platform's libmpv. **Both platforms ship the same EQ/DSP set** from
   * the pinned binaries — Android `v1.1.9-rnmedia.2` and later, iOS
   * `v0.7.2-rnmedia.2` and later — so no per-platform branching is needed.
   *
   * On binaries **older than those pins** (an app that overrode the pin, or a
   * stock media-kit build, whose audio flavour compiles in only `overlay` and
   * `equalizer`) a call here fails with `code: 'mpv', errno: -11` and mpv logs
   * `Option af: <name> doesn't exist.` at error level (visible through
   * `PlayerOptions.onLog`). That is the honest signal, and it is also the
   * supported way to probe support: try the chain, catch, fall back.
   *
   * **This is a chain rebuild, not a parameter poke — do not call it from a
   * slider.** Applying filters mid-playback does not reload the file, reset the
   * position or drop the audio device, but mpv does rebuild the graph: entries
   * whose arguments are byte-identical are kept and every entry that differs is
   * destroyed and recreated, losing whatever it had buffered
   * (mpv 0.41.0 `filters/f_output_chain.c:535-593`), and if that shortens the
   * chain's measured delay by 0.2 s or more mpv issues an exact refresh seek to
   * resynchronise (`player/audio.c:107-125`). One write is a settings change
   * and inaudible; sixty writes a second is a stutter. To move a number on a
   * *running* filter — an EQ band under a finger — use
   * {@link setAudioFilterParam}. The write is also synchronous: it blocks the
   * calling thread until mpv's core has applied it.
   *
   * The chain survives track changes — `af` is a global option, not a
   * per-entry one.
   *
   * **Coexists with {@link setLoudnessNormalization}, by construction.** This
   * method owns the *user half* of the chain; the loudness-normalization
   * toggle owns exactly one managed, labelled entry appended after it. Setting
   * filters here never turns normalization off, and toggling normalization
   * never touches the chain set here. (The raw
   * `setPropertyString('af', …)` escape hatch bypasses both halves' bookkeeping
   * — after using it, the next call to either method rewrites the property
   * from that bookkeeping, exactly as documented on
   * {@link setLoudnessNormalization}.)
   *
   * @example
   * ```ts
   * import { AudioFilters } from '@rn-media/player'
   *
   * player.setAudioFilters([
   *   AudioFilters.volume({ gainDb: -6 }),      // headroom for the boost below
   *   AudioFilters.bass({ frequency: 110, gain: 12 }),
   *   AudioFilters.limiter(),                   // and nothing clips
   * ])
   * ```
   */
  setAudioFilters(filters: readonly AudioFilter[]): void {
    this.#assertAlive('setAudioFilters')
    for (const filter of filters) {
      if (filter.label === LOUDNESS_NORMALIZATION_LABEL) {
        throw invalidArgument(
          `The filter label '${LOUDNESS_NORMALIZATION_LABEL}' is reserved for \`setLoudnessNormalization\`; ` +
            'a user entry carrying it would fight the managed one for the same mpv label. ' +
            'Pick any other label, or use `setLoudnessNormalization` itself.'
        )
      }
    }
    this.#setString(
      MpvProperty.audioFilters,
      compileAudioFilters(
        this.#composeAudioFilters(filters, this.#loudnessNormalization?.filter)
      )
    )
    // After the write: a chain mpv rejected must not become the remembered
    // "user half" that the next normalization toggle re-applies.
    this.#userAudioFilters = [...filters]
  }

  /**
   * Remove every filter set through {@link setAudioFilters}.
   *
   * Equivalent to `setAudioFilters([])`; spelled out because "set the empty
   * array" is not an obvious way to say it. The managed
   * loudness-normalization entry is **not** a filter you set, so it survives —
   * turn it off with `setLoudnessNormalization(false)`.
   */
  clearAudioFilters(): void {
    this.setAudioFilters([])
  }

  /**
   * Change one sub-option of a **running** filter, without rebuilding the
   * chain (mpv's `af-command`).
   *
   * This is the call a slider makes. {@link setAudioFilters} replaces the `af`
   * property, and mpv answers that by destroying and recreating every entry
   * whose arguments changed — correct for a settings change, ruinous sixty
   * times a second. `af-command` instead reaches into the live filter and
   * updates it: for an EQ band that means new biquad coefficients with the
   * filter's own state left intact, so a gain sweeps rather than clicks.
   *
   * @param filter - The entry to command. Both halves of its address are
   * needed, which is why this takes the filter rather than a label: the
   * {@link AudioFilter.label} finds the *mpv* entry, and
   * {@link AudioFilter.name} finds the libavfilter filter inside it (see the
   * remarks — passing mpv's `all` default instead reports failure on a command
   * that worked). Build a chain that carries labels with
   * `equalizerPresetChain(preset, { editable: true })`, or set
   * {@link AudioFilter.label} yourself.
   * @param param - The sub-option to change, spelled as the filter's
   * `AVOption` table spells it (`g` or `gain` on `equalizer`).
   * @param value - The new value. A number is stringified; strings are passed
   * through, which is how `volume` takes `'-6dB'`.
   * @throws {@link PlayerErrorException} with code `invalid-state` for an entry
   * with no label, a label or parameter mpv could not parse, or the reserved
   * {@link LOUDNESS_NORMALIZATION_LABEL}; with code `mpv` when the command
   * itself fails.
   *
   * @remarks
   * **Why the filter name is sent as mpv's `<target>`.** `af-command` takes
   * `<label> <command> <argument> [<target>]`, and `<target>` — which selects
   * filters *inside* the entry's libavfilter graph — defaults to `all`
   * (mpv 0.41.0 `player/command.c:7523-7531`). `all` is the wrong default here
   * and, worse, a silently wrong one: mpv wraps every `af` entry in its own
   * graph with an `abuffer` source and an `abuffersink` sink around the real
   * filter, and `avfilter_graph_send_command` overwrites its result on *every*
   * matching filter and returns the last one
   * (FFmpeg n8.1.2 `libavfilter/avfiltergraph.c:1470-1481`). The sink answers
   * `ENOSYS` (`libavfilter/avfilter.c:610-629`), so the gain lands on the
   * running filter and mpv still reports the command as failed. Naming the
   * filter narrows the loop to the one that implements the command, so success
   * means success.
   *
   * **When it really fails.** mpv's `af-command` returns failure — a rejected
   * Promise with `code: 'mpv'` — when there is no audio chain to command
   * (nothing loaded, or playback stopped: `player/command.c:6716-6730`), when
   * no entry carries that label (`filters/f_output_chain.c:445-465`), or when
   * libavfilter refuses the parameter. That last one is the honest signal that
   * a filter does not support runtime changes: `ff_filter_process_command`
   * looks the option up with `AV_OPT_FLAG_RUNTIME_PARAM` and returns `ENOSYS`
   * without it (FFmpeg n8.1.2 `libavfilter/avfilter.c:905-916`). See
   * {@link AUDIO_FILTER_RUNTIME_PARAMS} for the ones this library ships
   * bindings for and the citations behind them.
   *
   * **Treat a failure as "fall back to a chain write", not as fatal** — that
   * is what `useEqualizer` does. Every failure mode above is one a full
   * {@link setAudioFilters} handles correctly, only less smoothly.
   *
   * **The `af` property is deliberately not rewritten.** That is the whole
   * point — rewriting it is the rebuild being avoided — but it has two
   * consequences worth knowing. {@link getAudioFilters}, which reads mpv's
   * property, keeps showing the value the entry was *created* with. And if
   * anything later rebuilds the chain from that property (a new file, an audio
   * device change, the next `setAudioFilters`), the running value is lost. This
   * library's own bookkeeping does not have that problem: a successful call
   * updates the user half it remembers, so a later
   * {@link setLoudnessNormalization} or {@link setAudioFilters} composes from
   * the new value rather than reverting it. For everything else, write the
   * chain once the gesture is over — the pattern `useEqualizer` implements.
   *
   * The command is asynchronous (`mpv_command_async`), so unlike
   * {@link setAudioFilters} it never blocks the JS thread.
   *
   * @example
   * ```ts
   * // While the finger is down: 6 dB on the 1 kHz band of an editable chain.
   * const chain = equalizerPresetChain(curve, { editable: true })
   * await player.setAudioFilterParam(chain[6], 'g', 6)
   * ```
   */
  async setAudioFilterParam(
    filter: AudioFilter,
    param: string,
    value: string | number
  ): Promise<void> {
    this.#assertAlive('setAudioFilterParam')
    const label = filter.label
    if (label === undefined || label === '') {
      throw invalidArgument(
        `setAudioFilterParam: the '${filter.name}' entry has no label, and mpv's af-command addresses entries by label. ` +
          'Give it an `AudioFilter.label`, or compile the chain with `equalizerPresetChain(preset, { editable: true })`.'
      )
    }
    if (label === LOUDNESS_NORMALIZATION_LABEL) {
      throw invalidArgument(
        `The filter label '${LOUDNESS_NORMALIZATION_LABEL}' is reserved for \`setLoudnessNormalization\`; ` +
          'change the managed loudness-normalization entry through that method, which keeps its bookkeeping honest.'
      )
    }
    if (!isAudioFilterName(label)) {
      throw invalidArgument(
        `setAudioFilterParam: label must be one of mpv's filter-label characters ([a-zA-Z0-9_-]), got ${JSON.stringify(label)}.`
      )
    }
    if (!isAudioFilterName(param)) {
      throw invalidArgument(
        `setAudioFilterParam: param must be one of libavfilter's option-name characters ([a-zA-Z0-9_-]), got ${JSON.stringify(param)}.`
      )
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw invalidArgument(
        `setAudioFilterParam: value must be finite, got ${String(value)}.`
      )
    }
    if (!isAudioFilterName(filter.name)) {
      throw invalidArgument(
        `setAudioFilterParam: name must be one of mpv's filter-name characters ([a-zA-Z0-9_-]), got ${JSON.stringify(filter.name)}.`
      )
    }
    const text = typeof value === 'number' ? String(value) : value
    // `af-command <label> <command> <argument> [<target>]` — mpv 0.41.0
    // DOCS/man/input.rst ("Same as vf-command, but for audio filters"). The
    // fourth argument is not optional in practice; see the remarks above for
    // why mpv's `all` default turns a successful command into a failed one.
    await this.command(['af-command', label, param, text, filter.name])
    // Only after mpv accepted it: the remembered user half must never claim a
    // value the running chain does not have.
    this.#userAudioFilters = this.#userAudioFilters.map((filter) =>
      filter.label === label
        ? {
            ...filter,
            options: filter.options.map(([key, existing]) =>
              key === param ? ([key, text] as const) : ([key, existing] as const)
            ),
          }
        : filter
    )
  }

  /**
   * Turn EBU R128 loudness normalization on or off — ffmpeg's `loudnorm`,
   * managed as one labelled entry of the `af` chain.
   *
   * This is the "make everything the same loudness" switch for content that
   * carries no ReplayGain tags: podcasts mixed at wildly different levels, a
   * queue mixing loud modern masters with quiet archival ones. One call, no
   * chain bookkeeping — it composes with whatever {@link setAudioFilters} has
   * set (the managed entry sits at the tail, so it normalizes the signal your
   * EQ actually produced, and its built-in true-peak limiter guards the whole
   * chain's output).
   *
   * @param enabled - `true` inserts or replaces the managed entry; `false`
   * removes it and only it.
   * @param options - See {@link LoudnessNormalizationOptions}. Meaningful only
   * with `enabled: true`; ignored (deliberately, not silently — this sentence
   * is the notice) when disabling.
   * @throws {@link PlayerErrorException} with code `invalid-state` when an
   * option is outside ffmpeg's documented range, and with code `mpv`
   * (`errno: -11`) when the linked libmpv lacks the filter — the same
   * availability probe as {@link setAudioFilters}, and the same parity note:
   * both platforms' pinned binaries compile `loudnorm` in.
   *
   * @remarks
   * **What one-pass loudnorm honestly is.** `loudnorm` has a linear mode (one
   * fixed gain for the whole file) and a dynamic mode (a gain that rides the
   * signal). The linear mode is *unreachable live*: ffmpeg enters it only when
   * all four `measured_*` values from a prior analysis pass are supplied
   * (FFmpeg 8.1.2 `af_loudnorm.c:820-825` — the gate requires `measured_tp`,
   * `measured_thresh`, `measured_lra` and `measured_i` all non-default), and a
   * live player cannot measure a file it has not finished playing. So this API
   * is always ffmpeg's **dynamic** mode, and that has real costs:
   *
   * - **It is a dynamics processor.** The gain is recomputed per 100 ms
   *   block from short-term loudness and smoothed with a 21-tap Gaussian
   *   (≈2 s window, `af_loudnorm.c:139-159,505`), with a built-in true-peak
   *   limiter (10 ms attack / 100 ms release, `af_loudnorm.c:799-800`)
   *   catching what the ride pushes at the ceiling. Macro-dynamics — the
   *   difference between a verse and a chorus, a whisper and a shout — are
   *   genuinely compressed. On well-mastered music that is a loss; this
   *   switch is for material whose levels are wrong, not a mastering upgrade.
   * - **It resamples the whole chain to 192 kHz.** In dynamic mode the filter
   *   advertises exactly one input rate (`af_loudnorm.c:740,752`;
   *   `doc/filters.texi`: "the audio stream will be upsampled to 192 kHz"),
   *   so libavfilter converts up and back down around it. Measurable CPU and
   *   battery cost — the most expensive single entry this library ships.
   * - **It buffers 3 s of audio.** The dynamic mode's lookahead window
   *   (`af_loudnorm.c:697,775`: the first frame it consumes is 3000 ms).
   *   Position and A/V pts stay correct, but enabling it mid-track rebuilds
   *   the chain and refills that window, so expect a short hiccup on toggle —
   *   this is a settings switch, not a per-track one.
   *
   * If your files **do** carry ReplayGain tags, prefer
   * {@link setReplayGain}: it levels loudness in mpv's volume domain from the
   * tags — zero DSP, zero latency, zero resampling — and preserves dynamics
   * completely. **Do not run both**: they solve the same problem and their
   * gain changes stack, so a track leveled by ReplayGain gets re-leveled (and
   * re-compressed) by loudnorm. Tagged library → ReplayGain; untagged /
   * mixed-provenance streams → this. (The same advice is written on
   * {@link ReplayGainOptions}, from the other side.)
   *
   * For loudness *smoothing* at native sample rate,
   * `AudioFilters.dynamicNormalizer` (ffmpeg `dynaudnorm`) is the cheaper,
   * less faithful cousin — it chases a peak/RMS window rather than an EBU
   * R128 target. Reach for it through {@link setAudioFilters} when the 192 kHz
   * cost is unacceptable; it is a different trade, not a hidden mode of this
   * API.
   *
   * The managed entry is visible in {@link getAudioFilters} read-backs as
   * `@rnmedia_loudnorm:loudnorm=…` ({@link LOUDNESS_NORMALIZATION_LABEL}), and
   * `af` is a global option, so it survives track changes exactly like the
   * user chain does.
   *
   * @example
   * ```ts
   * player.setLoudnessNormalization(true)                      // −16 LUFS
   * player.setLoudnessNormalization(true, { targetLufs: -18 }) // spoken word
   * player.setLoudnessNormalization(false)                     // off
   * ```
   */
  setLoudnessNormalization(
    enabled: boolean,
    options: LoudnessNormalizationOptions = {}
  ): void {
    this.#assertAlive('setLoudnessNormalization')
    const next = enabled ? buildLoudnessNormalization(options) : undefined
    this.#setString(
      MpvProperty.audioFilters,
      compileAudioFilters(
        this.#composeAudioFilters(this.#userAudioFilters, next?.filter)
      )
    )
    // After the write, for the same reason as `setAudioFilters`.
    this.#loudnessNormalization = next
  }

  /**
   * The loudness normalization currently applied by
   * {@link setLoudnessNormalization} — the resolved options (defaults filled
   * in), or `undefined` when it is off.
   *
   * This is the toggle's own bookkeeping, not an mpv read — a raw `af` write
   * through the escape hatch is invisible to it, exactly as documented there.
   */
  getLoudnessNormalization():
    Readonly<LoudnessNormalizationOptions> | undefined {
    this.#assertAlive('getLoudnessNormalization')
    return this.#loudnessNormalization?.options
  }

  /**
   * The full `af` chain: the user half first (signal-flow order is chain
   * order), then the managed loudness-normalization entry, which must hear the
   * user chain's output to normalize what is actually audible.
   *
   * `managed` is an explicit parameter, never defaulted from the field: both
   * callers write the property *before* committing their half, so the value to
   * compose with is "the half that is not changing" — which for
   * `setLoudnessNormalization(false)` is honestly `undefined`, not the entry
   * still sitting in the field. (A default parameter here was the first bug
   * this method had.)
   */
  #composeAudioFilters(
    userFilters: readonly AudioFilter[],
    managed: AudioFilter | undefined
  ): readonly AudioFilter[] {
    return managed === undefined ? userFilters : [...userFilters, managed]
  }

  /**
   * The chain mpv currently has, as mpv prints it.
   *
   * This is a read-back of the raw `af` property, not a reconstruction: mpv
   * serialises with the same rules `compileAudioFilters` uses, so for a chain
   * set through {@link Player.setAudioFilters} this returns exactly the string
   * that was written. Useful as an assertion in tests and on-device checks, and
   * as the way to see a chain that was set through the raw escape hatch.
   *
   * With {@link setLoudnessNormalization} on, the string ends with the managed
   * `@rnmedia_loudnorm:loudnorm=…` entry — it is a real chain member, and this
   * read-back is honest about the whole property.
   *
   * @returns The `af` value; `''` when no filters are active.
   */
  getAudioFilters(): string {
    this.#assertAlive('getAudioFilters')
    return this.#guard(
      () => this.#client.getPropertyString(MpvProperty.audioFilters) ?? ''
    )
  }

  // -------------------------------------------------------------------------
  // Chapters
  // -------------------------------------------------------------------------

  /**
   * The current entry's chapters — title and start time, in file order.
   *
   * @returns `[]` when the entry has no chapters (an ordinary music track), or
   * when nothing is loaded. The two are the same answer to a caller.
   *
   * @remarks
   * **One bounded native read, on demand** — one
   * `mpv_get_property("chapter-list", MPV_FORMAT_NODE)`, whatever the chapter
   * count, and a *pull* rather than a subscription for exactly the reasons
   * {@link PlaylistApi.entries} is (see there): it is a variable-size array that
   * mpv already owns, it changes only when the entry changes, and a snapshot of
   * it in {@link PlayerState} would be a second copy on the bridge.
   *
   * The cursor — which chapter is playing *now* — is
   * {@link PlayerState.chapter}, updated from mpv's observed `chapter`
   * property, and {@link PlayerEventMap.chapterChanged} is when to re-read this
   * (you rarely need to: chapters do not change within an entry).
   *
   * Chapters come from the container: m4b audiobooks, Matroska/`.mka`, Ogg
   * chapter tags, and podcast MP3s with an ID3 `CHAP` frame. mpv can also load
   * them from a side file (`--chapters-file`), reachable through
   * `mpvOptions: { 'chapters-file': … }` on the load — which is how an app
   * feeds chapters from a podcast feed's own JSON.
   *
   * @throws {@link PlayerErrorException} if the player has been destroyed.
   *
   * @example
   * ```ts
   * const chapters = player.getChapters()
   * const current = player.state.chapter
   * const label =
   *   current !== undefined && current >= 0
   *     ? (chapters[current]?.title ?? `Chapter ${current + 1}`)
   *     : undefined
   * ```
   */
  getChapters(): readonly ChapterEntry[] {
    this.#assertAlive('getChapters')
    // Frozen for the same reason `playlist.entries()` is: this is a photograph
    // of mpv's state, and a mutable copy invites an app to edit it and believe
    // something changed.
    return Object.freeze(this.#guard(() => this.#client.getChapters()))
  }

  /**
   * Jump to the start of a chapter.
   *
   * @param index - 0-based chapter index.
   * @throws {@link PlayerErrorException} with code `invalid-state` when `index`
   * is not a non-negative integer.
   *
   * @remarks
   * mpv 0.41.0 `input.rst` on the `chapter` property: "Setting this property
   * results in an absolute seek to the start of the chapter." An index past the
   * last chapter is clamped by mpv itself (it seeks to the end of the file);
   * this method rejects only what cannot mean anything at all.
   *
   * Writing the property is a *property write*, not a command, so — like
   * {@link setRate} — it returns immediately and the resulting seek arrives
   * through {@link PlayerEventMap.seekStarted} / `seekCompleted` like any other.
   * {@link nextChapter} and {@link previousChapter} are commands and are
   * therefore awaitable; the asymmetry is mpv's, and hiding it would mean
   * inventing a promise that resolves on nothing.
   */
  setChapter(index: number): void {
    this.#assertAlive('setChapter')
    if (!Number.isInteger(index) || index < 0) {
      throw invalidArgument(
        `\`setChapter\` takes a non-negative integer chapter index; got ${index}.`
      )
    }
    this.#setNumber(MpvProperty.chapter, index)
  }

  /**
   * Skip to the next chapter (mpv's `add chapter 1`).
   *
   * At the last chapter mpv advances to the next playlist entry, which is the
   * behaviour a chapter-skip button is expected to have in an audiobook app.
   */
  async nextChapter(): Promise<void> {
    this.#assertAlive('nextChapter')
    await this.command(['add', MpvProperty.chapter, '1'])
  }

  /**
   * Skip to the previous chapter (mpv's `add chapter -1`).
   *
   * @remarks
   * **This is restart-or-previous, and mpv already implements it** — the same
   * convention {@link PlaylistApi.previous} applies to the queue. mpv 0.41.0
   * `options.rst`, `--chapter-seek-threshold` (default `5.0`): "Distance in
   * seconds from the beginning of a chapter within which a backward chapter
   * seek will go to the previous chapter. Past this threshold, a backward
   * chapter seek will go to the beginning of the current chapter instead."
   *
   * So `add chapter -1` is *not* `chapter = chapter - 1`, and this method
   * deliberately does not smooth that over. Change the threshold with
   * `setPropertyNumber('chapter-seek-threshold', n)`; a negative value means
   * always go back a chapter.
   */
  async previousChapter(): Promise<void> {
    this.#assertAlive('previousChapter')
    await this.command(['add', MpvProperty.chapter, '-1'])
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
   * **One** synchronous read: `metadata` is fetched as an `MPV_FORMAT_NODE`
   * map and converted natively (`MpvClient.getPropertyMap`). No string parsing
   * is involved anywhere — the manual's "Trying to retrieve this property as a
   * raw string doesn't work" is about the *string* format, and a node read is
   * the documented way to get the map, which is also why it is atomic: mpv
   * builds the whole node under its own lock, so the result cannot mix two tag
   * generations.
   *
   * It used to walk `metadata/list/count` + `metadata/list/N/key` +
   * `metadata/list/N/value`, at a cost of `2N + 1` blocking round-trips into
   * mpv's core — 41 of them for a 20-tag FLAC, issued from inside the event
   * batch at a track boundary. That is why this is still a *pull* rather than a
   * field of {@link PlayerState}, but the pull is now cheap and constant.
   */
  getMetadata(): Metadata {
    this.#assertAlive('getMetadata')
    const map = this.#readOptional(() =>
      this.#client.getPropertyMap(MpvProperty.metadata)
    )
    // `undefined` covers both "no tags" and "nothing loaded" (mpv reports the
    // whole property unavailable while there is no demuxer). The map is
    // returned as-is rather than copied: Nitro builds a fresh JS object per
    // call, so there is nothing shared to defend against.
    return map ?? {}
  }

  /**
   * The current entry's tags, normalised to the fields a now-playing screen
   * actually renders.
   *
   * @returns The normalised view; `{}` when nothing is loaded or the entry is
   * untagged. Fields with no usable tag are absent rather than empty.
   *
   * @remarks
   * **Same single node read as {@link getMetadata}**, with the most-copied
   * snippet in the ecosystem applied to it: `title ?? TITLE ?? icy-title`,
   * `album_artist ?? albumartist ?? TPE2`, `"4/12"` split into number and
   * total, `2006-05-01` reduced to a year. FLAC/Vorbis, ID3, MP4 and ICY each
   * spell these differently and mpv passes the demuxer's spelling through
   * unchanged, so every app has been writing this function.
   *
   * The full mapping table is on {@link toCommonMetadata}, which is exported so
   * it can be applied to a tag map from anywhere (a `metadataChanged` payload,
   * a persisted snapshot) without a player.
   *
   * This is a convenience *over* the raw map, never a replacement for it:
   * everything else the file carries — MusicBrainz ids, ReplayGain tags,
   * `icy-url`, custom fields — is still in {@link getMetadata}.
   */
  getCommonMetadata(): CommonMetadata {
    this.#assertAlive('getCommonMetadata')
    return toCommonMetadata(this.getMetadata())
  }

  /**
   * One tag of the current entry, by name (mpv's `metadata/by-key/<key>`).
   *
   * @param key - Tag name. mpv matches these case-insensitively
   * (`mp_tags_get_bstr`), so `'Title'` and `'title'` find the same tag.
   * @returns The tag's value, or `undefined` when the entry has no such tag
   * (or nothing is loaded).
   *
   * @remarks
   * The pull half of the tag-store route — pair it with
   * {@link PlayerEventMap.metadataChanged}, which tells you *when* to pull.
   * Reading one key is one property read; reading several is cheaper through
   * {@link Player.getMetadata}, which is one node read for the whole map.
   *
   * **For the now-playing line, prefer {@link PlayerState.title}.** It is the
   * same underlying update (mpv folds `icy-title` into `media-title` and
   * invalidates both together), but it arrives in the snapshot, so it reaches
   * the media session and every broadcast channel for free. This function is
   * for the keys `media-title` does *not* carry — the station name, the
   * bitrate, the album. See `state.title` for the full comparison.
   *
   * @example
   * ```ts
   * // The song is `player.state.title`. This is everything around it:
   * player.getMetadataValue('icy-name')  // station
   * player.getMetadataValue('icy-genre')
   * player.getMetadataValue('icy-title') // the song again, pulled rather than
   *                                      // pushed — useful inside a handler
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
  // Visualizer
  // -------------------------------------------------------------------------

  /**
   * Real-time spectrum and waveform of **this player's** output.
   *
   * Entirely lazy: reading this property, and reading
   * `player.visualizer.capabilities`, allocate nothing. mpv's tap stays
   * disarmed and no sampler thread exists until the first `subscribe()`; the
   * last unsubscribe releases all of it.
   *
   * @example
   * ```ts
   * if (player.visualizer.capabilities.fft) {
   *   const stop = player.visualizer.subscribe((frame) => {
   *     paintBars(frame.bands) // 32 values in [0, 1], already smoothed
   *   })
   *   // …later
   *   stop()
   * }
   * ```
   *
   * @remarks
   * **Identical on Android and iOS, and it needs no permission.** The samples
   * come from mpv itself, through two properties added by this project's libmpv
   * patch (`pcm-tap`, `pcm-tap-frame`) — the same source patch in both binary
   * forks, tapped at the point where mpv hands audio to the device, so what you
   * see is what is audible. `capabilities.fft` is `false` only when the linked
   * libmpv predates the patch, and `subscribe()` then throws a typed
   * `unsupported` error rather than silently doing nothing. See
   * ARCHITECTURE §21.
   */
  get visualizer(): VisualizerController {
    // Never undefined after `create()`; the fallback keeps the getter total for
    // an instance built by some future path that skipped the assignment.
    this.#visualizer ??= new VisualizerController(undefined)
    return this.#visualizer
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
    // Nothing may re-attempt anything after this. `#tryRetry` also re-checks
    // the flag, because it runs from a fan-out closure a listener could have
    // destroyed the player from.
    this.#resetRetry()
    // Before the core goes: the sampler thread reads mpv properties, so it has
    // to be stopped while the handle is still valid.
    this.#visualizer?.destroy()
    // Native `destroy()` releases any hook parked on the resolver; this drops
    // the JavaScript half, so an in-flight resolution that settles afterwards
    // finds nothing to write to.
    this.#resolution?.destroy()
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
   * ### Synchronous mpv reads issued from this turn — the budget
   * Every `getProperty*` is a blocking round-trip into mpv's core, and
   * `mpv/client.h` is explicit that it "[has] to wait until the playback core
   * is ready, which currently can take an unbounded time (e.g. if network is
   * slow or unresponsive)". A track boundary is the worst moment to issue one
   * (mpv is joining an opener thread), and it is also when the most events
   * arrive at once — so the count here is a budget, not an accident:
   *
   * | read | when | count |
   * | ---- | ---- | ----- |
   * | `#readTimePos` | batch carried a position discontinuity | 1 |
   * | `#readTrackChange` | batch moved the playlist cursor | 4 |
   * | {@link getMetadata} | batch touched `metadata`/`media-title` **and** something is listening for `metadataChanged` | 1 |
   *
   * **Worst case: 6 synchronous reads per batch**, whatever the tag count and
   * whatever the queue length. It was `6 + 2N` (47 for a 20-tag FLAC) until
   * `metadata` became a single node read and resolve-ahead's two playlist reads
   * moved off this turn — see `#resolveAhead`.
   *
   * @returns `true` to keep receiving batches, `false` once destroyed.
   */
  #handleBatch(events: MpvEvent[]): boolean {
    if (this.#destroyed) return false

    const mapped = toPlayerEvents(events)
    if (mapped.length === 0) return true

    const cursor = trackChangeIndexOf(mapped)
    const trackChange =
      cursor === undefined ? undefined : this.#readTrackChange(cursor)

    const context: ReducerContext = {
      now: this.#now(),
      ...(mapped.some(isPositionDiscontinuity)
        ? { timePos: this.#readTimePos() }
        : {}),
      ...(trackChange !== undefined ? { trackChange: trackChange.reads } : {}),
      // The URI of the entry these events are *about*, i.e. still the previous
      // one when this batch is a track change: the `end-file` being classified
      // belongs to the entry that ended. `#currentUri` is advanced after the
      // fan-out, below.
      ...(this.#currentUri !== undefined ? { uri: this.#currentUri } : {}),
    }

    const previous = this.#state
    let next = previous
    const emissions: Array<() => void> = []

    for (const event of mapped) {
      const after = reducePlayerState(next, event, context)
      this.#collectEmissions(next, after, event, context.now, emissions)
      next = after
    }

    this.#collectMetadataEmission(mapped, emissions)

    const retryBefore = this.#retry

    if (next !== previous) {
      this.#state = next
      for (const listener of [...this.#stateListeners]) listener(next)
    }
    for (const emit of emissions) emit()

    // Only *after* the fan-out, so every listener above classified the entry
    // that these events were about — and only when the read produced something,
    // so a momentary read failure (or a cursor moving to `-1`) leaves the last
    // known URI in place rather than dropping error classification to
    // "unknown". See `#readTrackChange`.
    if (trackChange?.uri !== undefined && trackChange.uri !== '') {
      this.#currentUri = trackChange.uri
    }

    // A `playbackRestart` is mpv's "position is meaningful again" signal, i.e.
    // the entry opened and audio is flowing. Whatever it cost to get there is
    // paid off, so the next failure starts a fresh budget. (A seek produces one
    // too, which is harmless: an entry you can seek in is an entry that
    // played.) Deliberately not keyed on `status === 'ready'` — that is derived
    // from `core-idle` as well, so a restart into a buffering stream would not
    // count and a live entry could retry forever.
    //
    // Checked *after* the fan-out and guarded on record identity, because a
    // batch that accumulated across a queue boundary can carry both an entry's
    // failure and the next entry's restart. Resetting blindly there would clear
    // the attempt this very batch just armed, and the budget would never
    // deplete.
    if (
      mapped.some(isPositionDiscontinuity) &&
      this.#retry !== undefined &&
      this.#retry === retryBefore
    ) {
      if (this.#retry.live) {
        // A live-`eof` generation must NOT reset here: a station that
        // reconnects, plays for a second and drops again would clear its budget
        // on every reconnect and re-attempt forever. The restart is only the
        // *start* of the clock — see `LIVE_EOF_BUDGET_RESET_SECONDS`, which
        // `#takeRetryAttempt` reads. Stamped once per generation, so a second
        // restart (a stall recovering, say) cannot keep pushing the deadline
        // out.
        if (this.#retry.restartedAt === undefined) {
          this.#retry = { ...this.#retry, restartedAt: context.now }
        }
      } else {
        this.#resetRetry()
      }
    }

    // Deliberately reuses the existing discontinuity signals rather than adding
    // a native event: the queue moving is already visible here, and the whole
    // point of resolving ahead is to be early, not to be exact.
    //
    // Deferred to a microtask so its two playlist reads (see `#resolveAhead`)
    // are not stacked onto the same turn as the reducer and the fan-out. It
    // still runs before anything else can happen — a microtask drains at the
    // end of *this* task, ahead of any timer or native callback — so "resolved
    // as soon as the queue moves", the only ordering the `SourceResolver` docs
    // promise, is unchanged. What changes is that the batch handler returns to
    // native first, which is what re-opens the flush cycle.
    if (
      this.#resolution?.installed === true &&
      mapped.some(isQueueMovement) &&
      next !== previous
    ) {
      // `Promise.resolve().then`, not `queueMicrotask`: identical scheduling,
      // but it needs no ambient global (this package compiles against
      // `lib: ["esnext"]`, which does not declare one).
      void Promise.resolve().then(() => {
        this.#resolveAhead()
      })
    }

    return !this.#destroyed
  }

  /**
   * Resolve the entries mpv is most likely to open next.
   *
   * The URIs come from mpv's own playlist (`playlist/N/filename`), not from
   * whatever this player was last asked to load, because those are the strings
   * the load hook will ask about — and because the queue can move for reasons
   * this object never saw (`playlist.next()`, repeat, a shuffle, a resumed
   * session).
   *
   * Two entries, not the whole queue: mpv only ever prefetches one ahead, and
   * resolving further would mint credentials for tracks that may never play.
   *
   * **Called from a microtask, never inline from `#handleBatch`.** Its two
   * `playlist/N/filename` reads are synchronous mpv round-trips, and stacking
   * them onto the batch turn put them at the one moment the core is least able
   * to answer. Everything it touches — the playlist snapshot, the resolver, the
   * destroyed flag — is re-read here rather than captured, so a `destroy()` (or
   * a resolver removal) in a listener between the two is seen.
   */
  #resolveAhead(): void {
    if (this.#destroyed) return
    const resolution = this.#resolution
    if (resolution === undefined || !resolution.installed) return
    const { index, count } = this.#state.playlist
    if (index < 0 || count <= 0) return

    const wanted: number[] = [index]
    if (index + 1 < count) {
      wanted.push(index + 1)
    } else if (this.#state.loop === 'playlist' && count > 1) {
      // mpv's own `mp_next_file` consults `--loop-playlist`, so entry 0 really
      // is what comes after the last one here.
      wanted.push(0)
    }

    const uris: string[] = []
    for (const entry of wanted) {
      const uri = this.#readInBatch(() =>
        this.#client.getPropertyString(playlistFilenameProperty(entry))
      )
      if (uri !== undefined && uri !== '') uris.push(uri)
    }
    resolution.resolveAhead(uris)
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
    now: number,
    out: Array<() => void>
  ): void {
    switch (event.kind) {
      case 'endFile': {
        // Whatever jump was in flight is not going to land: the entry it
        // belonged to is over. Cleared here rather than on `startFile`, because
        // mpv's ordering of `start-file` against the `playlist-pos` change that
        // arms an auto-advance is not something this layer should depend on.
        out.push(() => {
          this.#pendingDiscontinuity = undefined
        })
        if (after.status === 'ended') {
          const index = before.playlist.index
          // Read from the snapshot taken *before* the end, for the same reason
          // the index is: liveness is a fact about the entry that just ended,
          // and mpv starts the next one immediately afterwards.
          const wasLive = before.isLive
          const wasPlaying = before.playing
          // Same reading: whether anything follows is a fact about the queue as
          // it was when this entry finished, and it already accounts for the
          // loop mode (see `PlayerState.hasNext`).
          const wasLast = !before.hasNext
          out.push(() => {
            // A clean end of a *live* entry is a server hanging up, not a
            // broadcast finishing — but only if the app said so. See
            // `RetryOptions.retryLiveEof`.
            if (this.#tryRetryLiveEof(index, wasLive, wasPlaying)) return
            this.#emit('trackEnded', { index })
            // After `trackEnded`, never instead of it: the last entry both
            // ended and ended the queue, and a listener that counts plays needs
            // the first event as much as one that offers "up next" needs this.
            if (wasLast) this.#emit('queueEnded')
          })
        } else if (after.status === 'error' && after.error !== undefined) {
          const error = after.error
          // The cursor mpv had when the entry failed — it advances to the next
          // entry immediately afterwards, so `after` is already too late. This
          // is the same reading `trackEnded` above uses.
          const index = before.playlist.index
          const wasPlaying = before.playing
          out.push(() => {
            // Retry first: if an attempt is taken, nothing has finally failed
            // and there is no `error` event to emit yet.
            if (this.#tryRetry(index, error, wasPlaying)) return
            this.#emit('error', error, {
              attempts: this.#retryAttemptsSpent(index),
            })
          })
        }
        return
      }
      case 'property': {
        if (event.name === MpvProperty.playlistCount) {
          const count = after.playlist.count
          if (count === before.playlist.count) return
          out.push(() => {
            this.#emit('queueChanged', { count, reason: 'resized' })
          })
          return
        }
        if (event.name === MpvProperty.chapter) {
          const chapter = after.chapter
          const previousChapter = before.chapter
          if (chapter === previousChapter) return
          out.push(() => {
            this.#emit('chapterChanged', {
              index: chapter,
              previousIndex: previousChapter,
            })
          })
          return
        }
        if (event.name !== MpvProperty.playlistPos) return
        const index = after.playlist.index
        const previousIndex = before.playlist.index
        if (index === previousIndex) return
        // Where the old entry's clock stood when the cursor left it. Projected,
        // not read: the truth for the *new* entry arrives with the restart, and
        // a synchronous `time-pos` here would buy nothing but a round-trip at
        // the worst moment (see the batch read budget).
        const from = projectPosition(before, now)
        out.push(() => {
          this.#emit('trackChanged', { index, previousIndex })
          // The cursor moving is a position discontinuity in its own right —
          // the clock did not seek, it restarted somewhere else entirely.
          this.#pendingDiscontinuity = 'auto-advance'
          this.#emit('seekStarted', { reason: 'auto-advance', from })
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
      case 'seek': {
        const from = projectPosition(before, now)
        out.push(() => {
          this.#pendingDiscontinuity = 'seek'
          this.#emit('seekStarted', { reason: 'seek', from })
        })
        return
      }
      case 'playbackRestart': {
        // The reducer has already re-anchored on the one-shot `time-pos` read,
        // so this is mpv's own number rather than a projection.
        const position = after.positionAnchor.position
        out.push(() => {
          const reason = this.#pendingDiscontinuity
          // Nothing announced a jump — an ordinary restart with no
          // discontinuity to complete. Silence is the honest answer; inventing
          // a reason here is how `seekCompleted` would stop meaning anything.
          if (reason === undefined) return
          this.#pendingDiscontinuity = undefined
          this.#emit('seekCompleted', { reason, position })
        })
        return
      }
      case 'startFile':
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
    ...args: Parameters<PlayerEventMap[K]>
  ): void {
    for (const listener of [...this.#eventListeners[name]]) {
      // Each listener is typed by its own key; the cast is confined here.
      ;(listener as (...values: typeof args) => void)(...args)
    }
  }

  /**
   * One `mpv_get_property("playlist", NODE)`, mapped to the public tuple.
   *
   * The array is frozen because it is a *snapshot of mpv's state at this
   * instant*, and handing out something mutable would invite an app to edit its
   * copy and believe the queue changed. mpv is the record; this is a photograph
   * of it.
   */
  #readPlaylistEntries(operation: string): readonly PlaylistEntry[] {
    this.#assertAlive(operation)
    return Object.freeze(this.#guard(() => this.#client.getPlaylistEntries()))
  }

  /**
   * Announce a reorder this library just performed.
   *
   * Deliberately reads the count from the last snapshot rather than from mpv: a
   * `move`/`shuffle`/`unshuffle` cannot change the length, so the snapshot is
   * exact here and a property read would buy nothing but a round-trip.
   */
  #emitReordered(): void {
    this.#emit('queueChanged', {
      count: this.#state.playlist.count,
      reason: 'reordered',
    })
  }

  /**
   * End the current retry generation.
   *
   * Called by every public path that moves the cursor or edits the queue. A
   * dropped record means the next failure of any entry starts its count from
   * zero — which is exactly what "the user took over" should mean.
   */
  #resetRetry(): void {
    this.#retry = undefined
  }

  /**
   * Decide whether a failed entry gets another attempt, and if so, take it.
   *
   * @param index - The playlist index that failed, taken from the snapshot
   * *before* the `endFile` was reduced (mpv moves the cursor afterwards).
   * @param error - The typed failure.
   * @param wasPlaying - Playback intent at the moment of the failure, so the
   * re-attempt restores it rather than silently starting a paused player.
   * @returns `true` when an attempt was taken (and therefore no `error` event
   * should be emitted for this failure), `false` when the caller should report
   * the failure — with {@link #retryAttemptsSpent} as the count.
   *
   * @remarks
   * Runs inside the batch fan-out, after listeners have seen the new snapshot.
   * The typed error's {@link PlayerError.retryable} flag is the whole policy
   * here — everything after it (budget, arming, the jump) is
   * {@link #takeRetryAttempt}, shared with the live-`eof` path.
   */
  #tryRetry(index: number, error: PlayerError, wasPlaying: boolean): boolean {
    if (!error.retryable) return false
    return this.#takeRetryAttempt(index, error, wasPlaying, false)
  }

  /**
   * Decide whether a live entry that ended *cleanly* gets another attempt.
   *
   * @param index - The playlist index that ended, from the snapshot before the
   * `endFile` was reduced.
   * @param wasLive - {@link PlayerState.isLive} at that same moment. The whole
   * gate: a seekable entry that reaches its end has ended.
   * @param wasPlaying - Playback intent, so the re-attempt restores it.
   * @returns `true` when an attempt was taken — and therefore no `trackEnded`
   * should be emitted for this end.
   *
   * @remarks
   * Off unless {@link RetryOptions.retryLiveEof} says otherwise, because the
   * default has to be mpv's honest reading: `MPV_END_FILE_REASON_EOF` means the
   * source said it was done. Turning that into a failure for everybody would
   * break the `trackEnded`-vs-`error` distinction this library is built around;
   * turning it into one *for a live entry, on request* is the narrowest form of
   * the feature that still catches a station's server closing the connection.
   */
  #tryRetryLiveEof(
    index: number,
    wasLive: boolean,
    wasPlaying: boolean
  ): boolean {
    if (!this.#retryLiveEof) return false
    if (!wasLive) return false
    return this.#takeRetryAttempt(
      index,
      liveEofError(this.#currentUri),
      wasPlaying,
      true
    )
  }

  /**
   * The shared body of both retry paths: budget, arm, announce, jump.
   *
   * @param live - `true` when this generation was armed by
   * {@link RetryOptions.retryLiveEof}, which changes only *when the budget
   * resets* (see {@link LIVE_EOF_BUDGET_RESET_SECONDS}), never how much of it
   * there is. One budget per entry generation, whichever path spent it — an
   * entry that alternates clean closes and hard failures is one unhealthy
   * entry, not two independent problems.
   *
   * @remarks
   * Runs inside the batch fan-out, after listeners have seen the new snapshot.
   * The jump itself is issued fire-and-forget: it is a command, this is not an
   * async context, and there is nobody to hand a rejection to — a jump that mpv
   * refuses simply leaves the queue where mpv already put it, which is the same
   * place a non-retried failure leaves it.
   */
  #takeRetryAttempt(
    index: number,
    error: PlayerError,
    wasPlaying: boolean,
    live: boolean
  ): boolean {
    if (this.#destroyed) return false
    if (this.#maxRetryAttempts <= 0) return false
    // `-1` is "no current entry" — there is nothing to jump back to, and
    // `playlist-play-index -1` would be a different operation entirely.
    if (index < 0) return false

    // A failure on a different entry starts a new generation. Without this a
    // queue of three dead streams would share one budget and only the first
    // would ever be retried.
    const record = this.#retry?.index === index ? this.#retry : undefined
    // …and a generation whose re-attempt then played for a good while has
    // proven itself, so it starts over. Only live generations carry a
    // `restartedAt`; the ordinary path is already reset by the restart itself.
    const sustained =
      record?.restartedAt !== undefined &&
      this.#now() - record.restartedAt >= LIVE_EOF_BUDGET_RESET_SECONDS * 1000
    const spent = record === undefined || sustained ? 0 : record.attempts
    if (spent >= this.#maxRetryAttempts) return false

    // A *new* record object every time, never a mutation: `#handleBatch` uses
    // record identity to tell "this batch armed an attempt" from "this batch
    // was a success", and those can arrive together when a batch accumulates
    // across a queue boundary. It also drops any `restartedAt` the previous
    // attempt left behind, which is what starts the sustained-playback clock
    // over rather than letting a stale stamp count twice.
    const attempt = spent + 1
    this.#retry = { index, attempts: attempt, live }
    this.#emit('retrying', {
      index,
      attempt,
      maxAttempts: this.#maxRetryAttempts,
      error,
    })
    // No await, no timer. See `RetryOptions` for why the absence of a delay is
    // the design and not an omission.
    void this.#jumpTo(index, wasPlaying).catch(() => {
      // The jump failed (the core is tearing down, or the index went away with
      // the queue). Nothing to report that the original failure has not already
      // said, and throwing out of a fan-out closure would abort the rest of it.
    })
    return true
  }

  /** How many attempts the current generation has spent, for `PlayerErrorInfo`. */
  #retryAttemptsSpent(index: number): number {
    return this.#retry?.index === index ? this.#retry.attempts : 0
  }

  /**
   * `playlist-play-index`, with the pause flag cleared first when the caller
   * wants playback.
   *
   * Shared by {@link PlaylistApi.jumpTo} and the retry path so the ordering
   * rule lives in one place: `pause` is written *before* the jump so mpv's own
   * playback restart already runs with the right intent and cannot publish a
   * paused-then-playing flicker to observers. (mpv's `playlist-play-index`
   * restarts the entry but never touches the global `pause` flag — see
   * ARCHITECTURE §12.)
   */
  async #jumpTo(index: number, autoPlay: boolean): Promise<void> {
    if (autoPlay) this.#setBool(MpvProperty.pause, false)
    await this.command(['playlist-play-index', String(index)])
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
    // The core may already be tearing down; an absent anchor just means the
    // reducer keeps extrapolating from the previous one.
    return this.#readInBatch(() =>
      this.#client.getPropertyNumber(MpvProperty.timePos)
    )
  }

  /**
   * The new entry's `duration`, `seekable` and `media-title`, read once when a
   * batch moves the playlist cursor.
   *
   * mpv does not republish these after the cursor moves — it re-emits an
   * observed property only on an unequal value, and it walks observers in
   * registration order, so on a gapless transition the new entry's `duration`
   * has already been delivered *before* the cursor change (the two facts are
   * documented in full on `ReducerContext.trackChange`). Dropping the fields
   * and waiting therefore loses them for the rest of the entry.
   *
   * Like {@link #readTimePos} this is not polling: at most one read of each per
   * batch, and only when the cursor actually moved. A property mpv reports as
   * unavailable yields no key at all, which the reducer reads as "unknown"
   * rather than "unchanged".
   */
  #readTrackChange(index: number): TrackChangeSnapshot {
    const duration = this.#readInBatch(() =>
      this.#client.getPropertyNumber(MpvProperty.duration)
    )
    const seekable = this.#readInBatch(() =>
      this.#client.getPropertyBool(MpvProperty.seekable)
    )
    const title = this.#readInBatch(() =>
      this.#client.getPropertyString(MpvProperty.mediaTitle)
    )
    // The fourth read, and the cheapest correct answer to "which source is
    // playing *now*". `#currentUri` used to be whatever `load()`/`loadPlaylist()`
    // was last told, so after one `playlist.next()` — or a repeat wrap, or a
    // resumed session — every error was classified against the URI of a track
    // that finished minutes ago, turning a network failure on entry 7 into a
    // `load-failed` because entry 0 happened to be a local file.
    //
    // It is a *logical* URI (`playlist/N/filename` is the string that was
    // passed to `loadfile`; a source resolver rewrites `stream-open-filename`
    // and never touches the playlist), which is exactly the right thing to
    // classify on and to show a user.
    //
    // Read here rather than anywhere else because this batch has already paid
    // for the boundary: mpv is joining an opener thread either way, and the
    // three reads above are already in flight. `-1` (no current entry) is not
    // read at all — there is no such property.
    const uri =
      index >= 0
        ? this.#readInBatch(() =>
            this.#client.getPropertyString(playlistFilenameProperty(index))
          )
        : undefined
    return {
      reads: {
        ...(duration !== undefined ? { duration } : {}),
        ...(seekable !== undefined ? { seekable } : {}),
        ...(title !== undefined ? { title } : {}),
      },
      ...(uri !== undefined ? { uri } : {}),
    }
  }

  /**
   * A property read performed from inside the batch handler (or from another
   * best-effort path with no caller to answer to, such as resolve-ahead).
   *
   * Unlike {@link #readOptional} this swallows *every* failure: there is no
   * caller to hand an error to on the event path, and letting one escape would
   * abort the whole batch — including the state notification the surviving
   * events earned. A failed read is reported as "unavailable", which every
   * consumer of these reads already handles.
   */
  #readInBatch<T>(read: () => T | undefined): T | undefined {
    try {
      return read()
    } catch {
      return undefined
    }
  }

  /**
   * Reject an insertion index mpv would silently turn into an append.
   *
   * The bound is read from mpv (`playlist-count`) rather than taken from
   * `state.playlist.count`, because the snapshot is only as fresh as the last
   * event batch and an `add` issued from a command handler can easily run
   * ahead of one. A core that reports the property unavailable (idle, or
   * tearing down) falls back to the snapshot — which is `0` on an idle core, so
   * the only index still accepted there is `0`, i.e. "the head of an empty
   * queue", which is what an append would do anyway.
   */
  #assertInsertIndex(position: number): void {
    if (!Number.isInteger(position) || position < 0) {
      throw invalidArgument(
        `\`position\` must be a non-negative integer playlist index; got ${position}.`
      )
    }
    const count =
      this.#readInBatch(() =>
        this.#client.getPropertyNumber(MpvProperty.playlistCount)
      ) ?? this.#state.playlist.count
    if (position > count) {
      throw invalidArgument(
        `\`position\` ${position} is past the end of a ${count}-entry playlist. ` +
          'mpv would silently append instead of inserting; pass an index in ' +
          `0 … ${count}, or omit \`position\` to append on purpose.`
      )
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
