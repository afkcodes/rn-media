import type { HybridObject, UInt64 } from 'react-native-nitro-modules'

/**
 * The mpv format a property is observed/read in.
 *
 * Maps 1:1 to `MPV_FORMAT_STRING` / `MPV_FORMAT_DOUBLE` / `MPV_FORMAT_FLAG`.
 */
export type MpvFormat = 'string' | 'number' | 'bool'

/**
 * Discriminator of {@link MpvEvent}.
 *
 * NOTE: this is a *field* rather than a per-variant string literal (i.e. the
 * event type is one flat struct, not a TS discriminated union of 7 structs).
 * Nitro cannot represent single-member string literal types — nitrogen fails
 * with `String literal "property" cannot be represented in C++ because it is
 * ambiguous between a string and a discriminating union enum.` See the task
 * report for the full deviation note.
 */
export type MpvEventKind =
  | 'property'
  | 'startFile'
  | 'endFile'
  | 'seek'
  | 'playbackRestart'
  | 'log'
  | 'shutdown'

/**
 * `mpv_end_file_reason`. `unknown` covers reason values added by future mpv
 * releases.
 *
 * `endOfFile` is `MPV_END_FILE_REASON_EOF`. It is NOT spelled `eof` because
 * nitrogen upper-cases every union member into a C++ enumerator, and `EOF` is
 * a `<cstdio>` macro — `enum class { EOF = 0 }` would not compile. See the
 * task report.
 */
export type MpvEndFileReason =
  | 'endOfFile'
  | 'stop'
  | 'quit'
  | 'error'
  | 'redirect'
  | 'unknown'

/**
 * `mpv_log_level` minus `no`/`none` (which are never delivered as messages).
 *
 * `debugging` is mpv's `debug` level, renamed for the same reason as
 * {@link MpvEndFileReason.endOfFile}: the generated enumerator `DEBUG` would
 * collide with the `DEBUG=1` macro that Xcode/CocoaPods define in Debug
 * configurations.
 */
export type MpvLogLevel =
  | 'fatal'
  | 'error'
  | 'warn'
  | 'info'
  | 'verbose'
  | 'debugging'
  | 'trace'

/** The value of an observed/read property, in its observed {@link MpvFormat}. */
export type MpvPropertyValue = string | number | boolean

/**
 * One event from the mpv event loop, already translated out of `mpv_event`.
 *
 * Which fields are populated depends entirely on {@link kind}:
 *
 * | kind              | populated fields                |
 * | ----------------- | ------------------------------- |
 * | `property`        | `name`, `value`                 |
 * | `endFile`         | `endFileReason`, `error`        |
 * | `log`             | `logLevel`, `name` (mpv prefix), `text` |
 * | everything else   | *(none)*                        |
 */
export interface MpvEvent {
  /** Which kind of event this is. Decides which other fields are set. */
  kind: MpvEventKind
  /** Property name (`kind === 'property'`) or mpv log prefix (`kind === 'log'`). */
  name?: string
  /**
   * Observed property value. `undefined` when mpv reported the property as
   * currently unavailable (`MPV_FORMAT_NONE`), e.g. `duration` while idle.
   */
  value?: MpvPropertyValue
  /** Why the file ended (`kind === 'endFile'`). */
  endFileReason?: MpvEndFileReason
  /** mpv's error string, set iff `endFileReason === 'error'`. */
  error?: string
  /** Severity of the log message (`kind === 'log'`). */
  logLevel?: MpvLogLevel
  /** Log message text, including mpv's trailing newline (`kind === 'log'`). */
  text?: string
}

/**
 * One analysed window of the audio mpv last handed to the audio device.
 *
 * @remarks
 * The PCM itself never crosses into JavaScript. mpv's `pcm-tap-frame` property
 * (added by the rn-media libmpv patch — see ARCHITECTURE §11 and §21) is read on
 * a native sampler thread, downmixed, windowed and transformed there, and only
 * the spectrum makes the trip. That is a performance decision, not a layering
 * one: a 2048-point FFT is ~135 k float operations, which is nothing in C++ and
 * is real work in Hermes, and it keeps the per-frame payload at ~4 KB of
 * magnitudes instead of ~16 KB of samples.
 *
 * Everything *above* the transform — dB mapping, log-spaced bands, smoothing,
 * peak ballistics — stays in TypeScript, per subscriber, where it is unit-tested
 * without a device (ARCHITECTURE §5).
 */
export interface VisualizerCapture {
  /**
   * `fftSize / 2 + 1` little-endian `Float32` linear magnitudes, normalised so
   * that a full-scale sinusoid reads `1.0`. Read it as a `Float32Array`.
   *
   * Bin `k` is centred on `k * sampleRate / fftSize` Hz.
   */
  readonly magnitudes: ArrayBuffer
  /**
   * `fftSize` little-endian `Float32` mono samples in `[-1, 1]`, **unwindowed**,
   * or `undefined` when the subscriber did not ask for time-domain data.
   */
  readonly waveform?: ArrayBuffer
  /** Transform length in samples. */
  readonly fftSize: number
  /** Sample rate of the tapped audio, in Hz. */
  readonly sampleRate: number
  /** `Date.now()`-comparable timestamp taken natively when the window was analysed. */
  readonly capturedAt: number
  /**
   * mpv's tap sequence number — one increment per chunk the audio device
   * consumed. Two captures with the same `seq` carry the same spectrum by
   * construction, because they analysed the same samples.
   */
  readonly seq: number
  /**
   * Ticks skipped since the previous capture because JavaScript had not
   * finished with the last one. Steadily non-zero means the listener cannot
   * keep up with the requested frame rate.
   */
  readonly dropped: number
}

/**
 * mpv is about to open a source and does not know its concrete URL yet.
 *
 * @remarks
 * Delivered on a channel of its own rather than inside the event batch. A batch
 * is handed to JavaScript one at a time behind a completion promise, and a
 * play-time request is holding mpv's core open while it waits — so making it
 * queue behind unrelated JavaScript would charge that work to a stall.
 */
export interface SourceResolutionRequest {
  /**
   * The logical URL mpv is about to open — the string that is in the playlist,
   * read back from `stream-open-filename`.
   */
  readonly uri: string
  /**
   * mpv's playlist entry id for the entry being prefetched.
   *
   * Present **only on the prefetch path**, because that is the only place it
   * exists: at prefetch time mpv has not sent `MPV_EVENT_START_FILE` for the
   * entry and `playlist-current-pos` still points at the track that is playing,
   * so the fork exposes the id as a property readable while the prefetch hook
   * is open and nowhere else. A play-time request carries no id, and its
   * absence is therefore also the signal for "this one is blocking mpv".
   */
  readonly entryId?: number
}

/**
 * A thin, complete binding over one `mpv_handle` (one `mpv_create()` core).
 *
 * One instance == one player core; create as many as you need via
 * `createMpvClient()`. There is no singleton and no shared state between
 * instances.
 *
 * All methods except {@link destroy} throw if the client has already been
 * destroyed. Thrown messages are prefixed with a machine-readable tag —
 * `[mpv:disposed]` for use-after-destroy, `[mpv:<errno>]` for mpv errors —
 * so the TypeScript layer can map them onto the typed error taxonomy.
 */
export interface MpvClient
  extends HybridObject<{ android: 'c++'; ios: 'c++' }> {
  /**
   * Apply pre-init options and start the core (`mpv_initialize`).
   *
   * Audio-only defaults (`vid=no`, `force-window=no`, `idle=yes`,
   * `audio-display=no`) are applied natively *before* `options`, so callers can
   * override them. Keys are mpv option names, values mpv option strings.
   *
   * The reserved key `log-level` is not passed to mpv as an option; it is the
   * argument to `mpv_request_log_messages` (default `warn`).
   *
   * Throws if already initialized, already destroyed, or if mpv rejects an
   * option / fails to initialize.
   */
  initialize(options: Record<string, string>): void

  /**
   * Stop the event loop and tear the core down. Idempotent.
   *
   * `mpv_terminate_destroy` (which blocks) runs on a detached background
   * thread; this call only joins the event thread. Pending `command()`
   * promises reject with `[mpv:disposed]`. Every other method throws
   * afterwards — it never crashes.
   */
  destroy(): void

  /**
   * Run an mpv command (`mpv_command_async`).
   *
   * Resolves on `MPV_EVENT_COMMAND_REPLY` with no error, rejects with mpv's
   * error string otherwise.
   */
  command(args: string[]): Promise<void>

  /** Read a property as a string. `undefined` if currently unavailable. */
  getPropertyString(name: string): string | undefined
  /** Read a property as a double. `undefined` if currently unavailable. */
  getPropertyNumber(name: string): number | undefined
  /** Read a property as a flag. `undefined` if currently unavailable. */
  getPropertyBool(name: string): boolean | undefined

  /** Set a property from a string. Throws on mpv error. */
  setPropertyString(name: string, value: string): void
  /** Set a property from a double. Throws on mpv error. */
  setPropertyNumber(name: string, value: number): void
  /** Set a property from a flag. Throws on mpv error. */
  setPropertyBool(name: string, value: boolean): void

  /**
   * Observe `name`, delivering `kind: 'property'` events in the given format.
   * Observing an already-observed name replaces the previous observation.
   */
  observeProperty(name: string, format: MpvFormat): void
  /** Stop observing `name`. No-op if it was not observed. */
  unobserveProperty(name: string): void

  /**
   * Register the (single) batched event listener.
   *
   * Delivery is batched and coalesced natively: the first event after an idle
   * period schedules one flush onto the JS thread, and every event queued
   * until that flush completes rides along in it (property changes for the
   * same name collapse to the latest value; discrete events never collapse).
   *
   * The listener MUST return `true` to keep receiving batches; returning
   * `false` detaches it. The return value is not cosmetic — Nitro only hands
   * C++ a completion `Promise` for callbacks that return a value (a `=> void`
   * callback becomes a fire-and-forget `std::function<void(...)>`), and that
   * completion signal is what bounds the number of in-flight JS hops.
   *
   * Calling this again replaces the previous listener.
   */
  setEventBatchListener(
    onEventBatch: (events: MpvEvent[]) => boolean
  ): void

  /**
   * Arm mpv's PCM tap and start delivering analysed windows.
   *
   * Restarts cleanly when already running, which is what lets a second
   * subscriber widen the shared native parameters without a gap.
   *
   * @param fftSize - Transform length; a power of two in `[64, 16384]`.
   * @param fps - Delivery rate in `[1, 60]`. This is the *render* rate: new
   * spectral content arrives no faster than the audio device consumes chunks
   * (~20-45 Hz on Android), and the TypeScript smoothing is what turns one into
   * the other.
   * @param waveform - Also deliver time-domain samples.
   *
   * @throws `[visualizer:unavailable]` when the linked libmpv has no `pcm-tap`
   * property, i.e. it was not built from the rn-media forks. Same error, same
   * code path, on both platforms.
   */
  startVisualizer(fftSize: number, fps: number, waveform: boolean): void

  /**
   * Stop sampling and disarm mpv's tap. Idempotent.
   *
   * After this, mpv frees its ring and the audio thread's tap path is a single
   * atomic load per device chunk — the feature genuinely costs nothing when
   * nobody is looking.
   */
  stopVisualizer(): void

  /**
   * Register the (single) visualizer listener. Pass before
   * {@link startVisualizer}.
   *
   * As with {@link setEventBatchListener}, the listener MUST return `true` to
   * keep receiving captures; returning `false` detaches it. The returned
   * completion promise is the back-pressure clock — exactly one capture is in
   * flight at a time, and ticks that arrive while JavaScript is still busy are
   * dropped rather than queued, because a stale spectrum has no value.
   *
   * Calling this again replaces the previous listener.
   */
  setVisualizerListener(
    onCapture: (capture: VisualizerCapture) => boolean
  ): void

  /**
   * Register the (single) source-resolution listener. Pass before
   * {@link installSourceResolver}.
   *
   * Unlike the other two listeners this one returns nothing: there is no
   * back-pressure to apply, because the answer comes back through
   * {@link completeResolution} rather than through a completion promise.
   *
   * Calling this again replaces the previous listener.
   */
  setSourceResolutionListener(
    onRequest: (request: SourceResolutionRequest) => void
  ): void

  /**
   * Arm mpv's load hooks (`on_load`, and `on_prefetch_load` on rn-media
   * binaries), registering them with mpv on the first call.
   *
   * Registration is **lazy** so that a core which never installs a resolver is
   * byte-for-byte stock, and **permanent** because mpv has no unregister call
   * ("Currently, hooks can't be removed explicitly", `mpv/client.h`) — so
   * {@link uninstallSourceResolver} can only disarm the handler, after which it
   * continues every hook immediately and unrewritten.
   *
   * @param timeoutMs - How long a play-time `on_load` miss may hold mpv's core
   * while JavaScript resolves. `0` disables holding entirely, i.e. only the
   * pre-warmed cache is ever consulted.
   */
  installSourceResolver(timeoutMs: number): void

  /**
   * Disarm the handler and drop every cached resolution. Idempotent, and safe
   * to call while a hook is parked: the hold is released immediately.
   */
  uninstallSourceResolver(): void

  /**
   * Pre-seed the resolution cache, so a load hook never has to ask.
   *
   * This is the whole point of the design: a cache hit inside a hook is a map
   * lookup plus one property write, with no JavaScript anywhere near mpv's
   * core.
   *
   * @param logical - The URL as it appears in mpv's playlist.
   * @param resolved - What mpv should open instead.
   * @param ttlMs - How long the answer stays valid. `<= 0` stores nothing.
   */
  setResolvedSource(logical: string, resolved: string, ttlMs: number): void

  /** Forget every resolution. The next hook asks JavaScript again. */
  clearResolvedSources(): void

  /**
   * Answer a {@link SourceResolutionRequest}.
   *
   * A successful answer is cached (so the play-time `on_load` pass for the same
   * entry replays it verbatim — mpv compares the pre- and post-hook URLs
   * byte-for-byte to decide whether the prefetched stream can be reused) and
   * releases a matching play-time hold. `undefined` means "could not resolve":
   * nothing is cached and the hook continues unrewritten, letting mpv fail the
   * load on its own terms.
   *
   * @param logical - The `uri` of the request being answered.
   * @param resolved - The concrete URL, or `undefined`.
   * @param ttlMs - How long a successful answer stays cached.
   */
  completeResolution(
    logical: string,
    resolved: string | undefined,
    ttlMs: number
  ): void

  /**
   * Reserved for the future video plugin. Always throws `[mpv:unsupported]`
   * in the audio core.
   */
  attachVideoOutput(handle: UInt64): void
  /**
   * Reserved for the future video plugin. Always throws `[mpv:unsupported]`
   * in the audio core.
   */
  detachVideoOutput(): void
  /**
   * The `mpv_handle*` as a `uintptr_t`, for the future video plugin to build
   * an `mpv_render_context` on. Throws if not initialized or destroyed.
   */
  getRawHandle(): UInt64
}
