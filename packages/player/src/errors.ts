import type { MpvEndFileReason } from './specs/mpv-client.nitro'

/**
 * mpv error numbers (`MPV_ERROR_*` in `mpv/client.h`) that this layer maps
 * onto the typed taxonomy. Values are the enumerator values, which mpv commits
 * to keeping stable.
 */
const MpvErrno = {
  /** `MPV_ERROR_LOADING_FAILED` */
  loadingFailed: -13,
  /** `MPV_ERROR_AO_INIT_FAILED` */
  audioOutputInitFailed: -14,
  /** `MPV_ERROR_NOTHING_TO_PLAY` */
  nothingToPlay: -16,
  /** `MPV_ERROR_UNKNOWN_FORMAT` */
  unknownFormat: -17,
  /** `MPV_ERROR_UNSUPPORTED` */
  unsupported: -18,
  /** `MPV_ERROR_NOT_IMPLEMENTED` */
  notImplemented: -19,
} as const

/**
 * `mpv_error_string()` output for the error numbers mpv attaches to
 * `MPV_EVENT_END_FILE`.
 *
 * The native layer converts `mpv_event_end_file.error` with
 * `mpv_error_string()` before the event crosses into JS, so this is the only
 * signal available here. Strings are taken verbatim from mpv's `err_table` in
 * `player/client.c` at tag `v0.35.1`.
 */
const END_FILE_ERROR_TEXT = {
  loadingFailed: 'loading failed',
  unknownFormat: 'unrecognized file format',
  nothingToPlay: 'no audio or video data played',
  audioOutputInitFailed: 'audio output initialization failed',
} as const

/** Machine-readable classification of a {@link PlayerError}. */
export type PlayerErrorCode =
  | 'network'
  | 'unsupported-format'
  | 'load-failed'
  | 'disposed'
  | 'invalid-state'
  | 'unsupported'
  | 'mpv'

/**
 * Whether repeating the *identical* operation could plausibly succeed with
 * nothing else changed.
 *
 * @remarks
 * Present on every member of {@link PlayerError} — that is the point: an app
 * that wants "retry on transient failures" should read this field rather than
 * maintain its own table of codes, which is how such tables go stale. It is
 * also what {@link PlayerOptions.retry} consumes to decide whether a failed
 * entry gets another attempt before the queue advances.
 *
 * The classification, and the reasoning behind each row:
 *
 * | code                 | `retryable` | why |
 * | -------------------- | ----------- | --- |
 * | `network`            | `true`      | a dropped connection, a premature EOF, a CDN hiccup — the definition of transient |
 * | `unsupported-format` | `false`     | no demuxer/codec exists in this binary; a second attempt runs the same code |
 * | `load-failed`        | `false`\*   | see below |
 * | `disposed`           | `false`     | an app bug, and the object is gone |
 * | `invalid-state`      | `false`     | the argument was rejected before mpv saw it; the same argument is rejected again |
 * | `unsupported`        | `false`     | the operation does not exist in the audio core |
 * | `mpv`                | per errno   | see {@link isRetryableErrno} |
 *
 * \* **`load-failed` is `false` on the classified path, and that is a fact
 * about the classifier rather than a policy.** `classifyEndFile` splits a
 * failed open on {@link isNetworkUri}: a network URI becomes `network`, and
 * everything else becomes `load-failed`. So a `load-failed` produced from an
 * `end-file` is *by construction* never a network source — it is a local file
 * that is missing or unreadable, or a source whose URI was not known at all.
 * Neither improves by being asked twice in a row.
 *
 * The one `load-failed` that carries a real URI is the source-resolver failure
 * (`SourceResolverController`), which builds the error itself and sets this
 * field from {@link isNetworkUri} of the URI it was asked to resolve — a signing
 * endpoint that timed out genuinely is worth another go.
 *
 * **`retryable` is advice about one repetition, not a promise.** It never means
 * "this will work"; it means "asking again is not obviously pointless".
 */
export type Retryable = boolean

/**
 * Playback of a network source failed part-way: a premature EOF, a dropped
 * connection, or a stream that never delivered decodable data.
 */
export interface NetworkError {
  readonly code: 'network'
  /** Human-readable summary, safe to show in a UI. */
  readonly message: string
  /** The mpv error string this was classified from. */
  readonly raw: string
  /** The source URI that failed, when known. */
  readonly uri?: string
  /** Always `true`. See {@link Retryable}. */
  readonly retryable: Retryable
}

/** mpv could not demux/decode the source: no matching demuxer or codec. */
export interface UnsupportedFormatError {
  readonly code: 'unsupported-format'
  /** Human-readable summary, safe to show in a UI. */
  readonly message: string
  /** The mpv error string this was classified from. */
  readonly raw: string
  /** The source URI that failed, when known. */
  readonly uri?: string
  /** Always `false`. See {@link Retryable}. */
  readonly retryable: Retryable
}

/** The source could not be opened at all (missing file, refused connection). */
export interface LoadFailedError {
  readonly code: 'load-failed'
  /** Human-readable summary, safe to show in a UI. */
  readonly message: string
  /** The mpv error string this was classified from. */
  readonly raw: string
  /** The source URI that failed, when known. */
  readonly uri?: string
  /** See {@link Retryable} — `false` from `end-file`, resolver-dependent otherwise. */
  readonly retryable: Retryable
}

/** The player (or its underlying mpv core) has already been destroyed. */
export interface DisposedError {
  readonly code: 'disposed'
  /** Human-readable summary, safe to show in a UI. */
  readonly message: string
  /** Always `false`. See {@link Retryable}. */
  readonly retryable: Retryable
}

/** A call was made in a state that does not allow it (e.g. double `initialize`). */
export interface InvalidStateError {
  readonly code: 'invalid-state'
  /** Human-readable summary, safe to show in a UI. */
  readonly message: string
  /** Always `false`. See {@link Retryable}. */
  readonly retryable: Retryable
}

/**
 * The operation is not implemented by the audio core — currently only
 * `attachVideoOutput`/`detachVideoOutput`, which the future video plugin owns.
 */
export interface UnsupportedError {
  readonly code: 'unsupported'
  /** Human-readable summary, safe to show in a UI. */
  readonly message: string
  /** Always `false`. See {@link Retryable}. */
  readonly retryable: Retryable
}

/** Anything mpv reported that this layer does not classify further. */
export interface RawMpvError {
  readonly code: 'mpv'
  /** Human-readable summary, safe to show in a UI. */
  readonly message: string
  /** mpv's own error string, verbatim. */
  readonly raw: string
  /** The mpv error number (`MPV_ERROR_*`), when the failure carried one. */
  readonly errno?: number
  /** The source URI that failed, when known. */
  readonly uri?: string
  /** Per {@link isRetryableErrno}. See {@link Retryable}. */
  readonly retryable: Retryable
}

/**
 * The typed error taxonomy of `@afkcodes/timbre-player`.
 *
 * Every error surfaced by the {@link Player} — thrown from a method, delivered
 * to an `on('error')` listener, or stored in `PlayerState.error` — is one of
 * these. There is no untyped escape: unclassifiable mpv failures land in
 * {@link RawMpvError} with mpv's own string attached.
 */
export type PlayerError =
  | NetworkError
  | UnsupportedFormatError
  | LoadFailedError
  | DisposedError
  | InvalidStateError
  | UnsupportedError
  | RawMpvError

/**
 * An `Error` subclass carrying a {@link PlayerError}, so that typed
 * information survives `throw`/`await`.
 */
export class PlayerErrorException extends Error {
  /** The typed error this exception carries. */
  readonly playerError: PlayerError

  /**
   * @param playerError - The typed error to wrap.
   */
  constructor(playerError: PlayerError) {
    super(playerError.message)
    this.name = 'PlayerError'
    this.playerError = playerError
  }
}

/** URI schemes that mpv reaches over the network. */
const NETWORK_SCHEMES = [
  'http',
  'https',
  'rtmp',
  'rtmps',
  'rtsp',
  'mms',
  'mmsh',
  'srt',
  'udp',
  'tcp',
  'hls',
  'dash',
  'ftp',
  'ftps',
  'smb',
]

/**
 * Whether a bare `MPV_ERROR_*` number describes a condition that could clear on
 * its own — the `code: 'mpv'` half of {@link Retryable}.
 *
 * @param errno - The mpv error number, or `undefined` when the failure carried
 * none (an untagged native throw). `undefined` is `false`: an error this layer
 * could not even attribute to mpv is not evidence of a transient condition.
 *
 * @remarks
 * The table is short because almost every `MPV_ERROR_*` is a *statement about
 * the call*, not about the world — a bad option name, a property that does not
 * exist, a malformed command. Repeating those runs the same code with the same
 * arguments and reaches the same line of mpv.
 *
 * | errno | `MPV_ERROR_*` | retryable | reasoning |
 * | ----- | ------------- | --------- | --------- |
 * | -14 | `AO_INIT_FAILED` | **`true`** | the audio device is a shared, exclusive resource. A phone call, another app taking exclusive output, or a route change landing mid-open makes the *same* open fail now and succeed a moment later. This is the one mpv errno whose cause is outside the process. |
 * | -1 … -12 | `EVENT_QUEUE_FULL` … `COMMAND` | `false` | all argument/state faults: the same call fails identically |
 * | -13, -16 | `LOADING_FAILED`, `NOTHING_TO_PLAY` | *n/a* | never reach here — {@link fromErrno} maps them to `network`/`load-failed` first |
 * | -15 | `VO_INIT_FAILED` | `false` | the audio core never opens a video output (`vid=no`), so this cannot be a transient device race the way -14 is |
 * | -17 | `UNKNOWN_FORMAT` | *n/a* | mapped to `unsupported-format` |
 * | -18, -19 | `UNSUPPORTED`, `NOT_IMPLEMENTED` | *n/a* | mapped to `unsupported` |
 * | -20 | `GENERIC` | `false` | mpv's catch-all. "Unclassified" is not "transient", and guessing otherwise would make every unknown failure retry twice |
 *
 * Anything mpv adds in a future release falls to `false` for the same reason as
 * `GENERIC`: an unknown condition is not evidence of a recoverable one.
 */
export function isRetryableErrno(errno: number | undefined): boolean {
  return errno === MpvErrno.audioOutputInitFailed
}

/**
 * Whether a source URI is fetched over the network.
 *
 * Used to distinguish a premature network EOF (`network`) from a local file
 * that simply could not be opened (`load-failed`) — mpv reports both with the
 * same error number.
 *
 * @param uri - The source URI, or `undefined` when unknown.
 */
export function isNetworkUri(uri: string | undefined): boolean {
  if (uri === undefined) return false
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(uri)
  if (match?.[1] === undefined) return false
  return NETWORK_SCHEMES.includes(match[1].toLowerCase())
}

/** Shape of a native error message once its `[mpv:…]` tag has been parsed. */
interface ParsedNativeError {
  /** The tag between `[mpv:` and `]`. */
  readonly tag: string
  /** Everything after the tag, trimmed. */
  readonly detail: string
}

const NATIVE_TAG = /^\[mpv:([^\]]+)\]\s*([\s\S]*)$/

function parseNativeError(message: string): ParsedNativeError | undefined {
  const match = NATIVE_TAG.exec(message)
  if (match?.[1] === undefined) return undefined
  return { tag: match[1], detail: (match[2] ?? '').trim() }
}

/**
 * Matches the `[visualizer:<tag>]` marker **anywhere** in the message, not just
 * at the start.
 *
 * That is not defensive vagueness — it is the observed wire format. A native
 * throw reaches JS wrapped by Nitro, so what arrives is
 * `MpvClient.startVisualizer(...): [visualizer:unavailable] …` and sometimes a
 * trailing stack. An anchored pattern silently downgraded every tagged failure
 * to `invalid-state` (caught on device, 2026-08-11), which in turn hid the
 * app's affordance for it.
 */
const VISUALIZER_TAG = /\[visualizer:([^\]]+)\]\s*([\s\S]*)$/

/**
 * Cut a stack trace off the end of a message.
 *
 * The tag's detail is written for a human to read in a UI; the frames after it
 * belong in a log, and pasting a 20-frame trace into an error banner is how a
 * typed taxonomy stops being useful.
 */
function withoutStackTrace(detail: string): string {
  const frame = detail.search(/\n\s*at\s/)
  return (frame === -1 ? detail : detail.slice(0, frame)).trim()
}

/**
 * Map a throw from the native visualizer engine onto the typed taxonomy.
 *
 * @param thrown - Whatever the native call threw.
 * @returns The typed error. Never `undefined` — an untagged throw becomes an
 * `invalid-state` carrying the original message, so nothing is swallowed.
 *
 * @remarks
 * Deliberately separate from {@link toPlayerError}: an unclassified failure
 * here must not be labelled `mpv` with a fabricated `raw` mpv string. The
 * native side tags the one failure it can predict,
 * `[visualizer:unavailable]` — a libmpv without the PCM tap patch.
 *
 * There is no `permission-denied` member any more, and that absence is the
 * feature: the old Android route went through `android.media.audiofx.Visualizer`,
 * which the platform gates on `RECORD_AUDIO` for every audio session. Tapping
 * mpv needs no permission at all, on either platform, so no consuming app has to
 * put a microphone permission in its manifest.
 */
export function toVisualizerError(thrown: unknown): PlayerError {
  if (thrown instanceof PlayerErrorException) return thrown.playerError
  const message = messageOf(thrown)
  const match = VISUALIZER_TAG.exec(message)
  const tag = match?.[1]
  const detail = withoutStackTrace(match?.[2] ?? message)
  switch (tag) {
    case 'unavailable':
      return { code: 'unsupported', message: detail, retryable: false }
    case 'invalid-state':
      return { code: 'invalid-state', message: detail, retryable: false }
    default:
      return { code: 'invalid-state', message: detail, retryable: false }
  }
}

function messageOf(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message
  if (typeof thrown === 'string') return thrown
  return String(thrown)
}

function fromErrno(
  errno: number,
  detail: string,
  uri: string | undefined
): PlayerError {
  switch (errno) {
    case MpvErrno.unknownFormat:
      return {
        code: 'unsupported-format',
        message: `Unsupported media format: ${detail}`,
        raw: detail,
        retryable: false,
        ...(uri !== undefined ? { uri } : {}),
      }
    case MpvErrno.loadingFailed:
    case MpvErrno.nothingToPlay:
      return isNetworkUri(uri)
        ? {
            code: 'network',
            message: `Network playback failed: ${detail}`,
            raw: detail,
            uri: uri as string,
            retryable: true,
          }
        : {
            code: 'load-failed',
            message: `Failed to load media: ${detail}`,
            raw: detail,
            // Not network-classified by construction — the branch above took
            // every network URI. See `Retryable`.
            retryable: false,
            ...(uri !== undefined ? { uri } : {}),
          }
    case MpvErrno.unsupported:
    case MpvErrno.notImplemented:
      return { code: 'unsupported', message: detail, retryable: false }
    default:
      return {
        code: 'mpv',
        message: detail,
        raw: detail,
        errno,
        retryable: isRetryableErrno(errno),
        ...(uri !== undefined ? { uri } : {}),
      }
  }
}

/**
 * Map anything thrown by the native `MpvClient` (or by this library) onto the
 * typed {@link PlayerError} taxonomy.
 *
 * Native tags every message it throws — `[mpv:disposed]`,
 * `[mpv:invalid-state]`, `[mpv:unsupported]`, `[mpv:<errno>]` (see
 * `docs/specs/player-core.md` §2.5) — and this function is the only place that
 * knows those tags.
 *
 * @param thrown - The value caught from a native call or a rejected promise.
 * @param uri - The source URI in play at the time, if any. Used to tell a
 * network failure apart from a local load failure.
 * @returns A typed error; never throws, never returns `undefined`.
 */
export function toPlayerError(thrown: unknown, uri?: string): PlayerError {
  if (thrown instanceof PlayerErrorException) return thrown.playerError

  const message = messageOf(thrown)
  const parsed = parseNativeError(message)
  if (parsed === undefined) {
    return {
      code: 'mpv',
      message,
      raw: message,
      // No `[mpv:…]` tag, so no errno to judge by. See `isRetryableErrno`.
      retryable: false,
      ...(uri !== undefined ? { uri } : {}),
    }
  }

  const { tag, detail } = parsed
  switch (tag) {
    case 'disposed':
      return {
        code: 'disposed',
        message: detail || 'Player has been destroyed',
        retryable: false,
      }
    case 'invalid-state':
      return { code: 'invalid-state', message: detail, retryable: false }
    case 'unsupported':
      return { code: 'unsupported', message: detail, retryable: false }
    default: {
      const errno = Number.parseInt(tag, 10)
      if (Number.isNaN(errno)) {
        return {
          code: 'mpv',
          message: detail || message,
          raw: detail || message,
          retryable: false,
          ...(uri !== undefined ? { uri } : {}),
        }
      }
      return fromErrno(errno, detail, uri)
    }
  }
}

/**
 * The failure `retry.retryLiveEof` re-attempts on: a live entry whose server
 * closed the connection cleanly.
 *
 * @param uri - The source that ended, when known.
 *
 * @remarks
 * **This error is synthesised, and that is worth knowing before reading it in a
 * log.** mpv reported `MPV_END_FILE_REASON_EOF` — a *clean* end, with no error
 * number and no `mpv_error_string()` — so there is nothing here to classify;
 * `raw` carries mpv's end-file reason instead of an mpv error string, which is
 * the only honest thing to put in that field.
 *
 * It is `network`/`retryable` because that is what it *is*: an HTTP response
 * body that ended while the broadcast behind it did not. The player never
 * emits it on the `error` channel — it exists to give
 * {@link PlayerEventMap.retrying} a typed reason to show ("Reconnecting…"), and
 * when the budget runs out the end is reported as the `trackEnded` it always
 * was. So no app sees this as a failure unless it asked for the behaviour.
 */
export function liveEofError(uri: string | undefined): PlayerError {
  return {
    code: 'network',
    message: 'The live stream ended — the server closed the connection.',
    raw: 'eof',
    retryable: true,
    ...(uri !== undefined ? { uri } : {}),
  }
}

/** The `disposed` error this library raises for use-after-`destroy()`. */
export function disposedError(operation: string): PlayerError {
  return {
    code: 'disposed',
    message: `Cannot call \`${operation}\` — the player has been destroyed.`,
    retryable: false,
  }
}

/**
 * How a playlist entry stopped, as classified from mpv's `end-file` event.
 *
 * `ended` and `failed` are deliberately distinct: a natural end of stream is a
 * `trackEnded` event, a premature/failed one is an `error` event.
 */
export type EndFileOutcome =
  | {
      /** The entry played to its natural end (`MPV_END_FILE_REASON_EOF`). */
      readonly type: 'ended'
    }
  | {
      /** Playback was stopped by us or by the user (`stop`, `quit`). */
      readonly type: 'stopped'
      /** `true` when the whole core is going away (`quit`). */
      readonly quit: boolean
    }
  | {
      /** The entry was a playlist and was expanded in place (`redirect`). */
      readonly type: 'redirect'
    }
  | {
      /** Playback aborted with an error. */
      readonly type: 'failed'
      /** The typed error. */
      readonly error: PlayerError
    }

/**
 * Classify an `end-file` event into a natural end, a deliberate stop, a
 * playlist redirect, or a typed failure.
 *
 * @param reason - `mpv_end_file_reason`, as renamed by the native spec
 * (`endOfFile` rather than `eof`).
 * @param errorText - `mpv_error_string()` of `mpv_event_end_file.error`;
 * populated by native only when `reason === 'error'`.
 * @param uri - The source that was playing, used to separate a network failure
 * from a local one.
 *
 * @remarks
 * mpv documents that "incomplete or broken files" may end with *either*
 * `EOF` or `ERROR` (`mpv/client.h`, `MPV_END_FILE_REASON_ERROR`), so a clean
 * `endOfFile` is always reported as a natural end — guessing otherwise would
 * turn ordinary track completions into spurious errors.
 */
export function classifyEndFile(
  reason: MpvEndFileReason,
  errorText: string | undefined,
  uri?: string
): EndFileOutcome {
  switch (reason) {
    case 'endOfFile':
      return { type: 'ended' }
    case 'stop':
      return { type: 'stopped', quit: false }
    case 'quit':
      return { type: 'stopped', quit: true }
    case 'redirect':
      return { type: 'redirect' }
    case 'error':
      return { type: 'failed', error: endFileError(errorText, uri) }
    case 'unknown':
      // A reason value added by a future mpv release. Treat it as a stop:
      // inventing an error would be dishonest, and inventing a natural end
      // would silently advance a queue.
      return { type: 'stopped', quit: false }
    default: {
      const exhaustive = reason
      exhaustive satisfies never
      return { type: 'stopped', quit: false }
    }
  }
}

function endFileError(
  errorText: string | undefined,
  uri: string | undefined
): PlayerError {
  const raw = errorText ?? 'unknown mpv error'
  const network = isNetworkUri(uri)

  switch (raw) {
    case END_FILE_ERROR_TEXT.unknownFormat:
      return {
        code: 'unsupported-format',
        message: 'The media format is not supported.',
        raw,
        retryable: false,
        ...(uri !== undefined ? { uri } : {}),
      }
    case END_FILE_ERROR_TEXT.loadingFailed:
    case END_FILE_ERROR_TEXT.nothingToPlay:
      return network
        ? {
            code: 'network',
            message: `Network playback failed (${raw}).`,
            raw,
            uri: uri as string,
            retryable: true,
          }
        : {
            code: 'load-failed',
            message: `Failed to load media (${raw}).`,
            raw,
            // `network` above claimed every network URI, so what is left is a
            // local path (or no URI at all). See `Retryable`.
            retryable: false,
            ...(uri !== undefined ? { uri } : {}),
          }
    case END_FILE_ERROR_TEXT.audioOutputInitFailed:
      return {
        code: 'mpv',
        message: 'Audio output initialization failed.',
        raw,
        errno: MpvErrno.audioOutputInitFailed,
        retryable: isRetryableErrno(MpvErrno.audioOutputInitFailed),
        ...(uri !== undefined ? { uri } : {}),
      }
    default:
      return network
        ? {
            code: 'network',
            message: `Network playback failed (${raw}).`,
            raw,
            uri: uri as string,
            retryable: true,
          }
        : {
            code: 'mpv',
            message: raw,
            raw,
            // An unrecognised `mpv_error_string()` with no errno attached.
            retryable: false,
            ...(uri !== undefined ? { uri } : {}),
          }
  }
}
