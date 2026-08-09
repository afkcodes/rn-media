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
