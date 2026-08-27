import type { CastIdleReason } from './specs/cast.nitro'

/**
 * Why a `@afkcodes/timbre-cast` call or session failed.
 *
 * A closed union rather than free-form messages so callers can branch (and so
 * tests assert on the code, not on prose) — CLAUDE.md principle 6. The codes
 * are *families*: everything receiver-side lands in `cast-receiver-fetch`
 * because the phone's connectivity is not the receiver's, and conflating the
 * two is the classic cast-app bug this taxonomy exists to prevent.
 */
export type CastErrorCode =
  /**
   * The Cast framework cannot run here (Android: no Google Play services /
   * the cast dynamite module failed to load; iOS: initialization failed).
   * A capability answer, not a crash.
   */
  | 'unavailable'
  /** A media/queue/volume call arrived with no connected session. */
  | 'no-session'
  /** The platform reported a session start failure (status code attached). */
  | 'session-start-failed'
  /**
   * The receiver rejected a load request (bad request, unsupported by the
   * receiver app, receiver busy). Sender-side classification.
   */
  | 'load-failed'
  /**
   * The *receiver* failed to fetch or play the media it was handed. The
   * receiver fetches URLs itself, so this is its own family — distinct from
   * any local network error the player produces. Sources: receiver
   * `idleReason: 'error'` and the SDK's out-of-band media-error callback.
   */
  | 'cast-receiver-fetch'
  /**
   * A handoff found nothing the receiver could play: every queue item was
   * filtered out by `canCastMedia` (codec / local-file / headers). TS-side
   * only — never crosses the bridge; raised by the handoff state machine
   * before any receiver call is made.
   */
  | 'no-castable-media'
  /** An argument failed validation before reaching the SDK. */
  | 'invalid-argument'
  /**
   * The call is not legal right now (e.g. no foreground Activity to show the
   * picker from).
   */
  | 'invalid-state'
  /** An SDK error that fits no family above. `raw` carries the platform text. */
  | 'native'

export class CastError extends Error {
  readonly code: CastErrorCode
  /** Platform status/error code, when one accompanied the failure. */
  readonly statusCode?: number
  /** Verbatim platform message, for logs — never for branching. */
  readonly raw?: string

  constructor(
    code: CastErrorCode,
    message: string,
    options?: { statusCode?: number; raw?: string }
  ) {
    super(`[cast] ${message}`)
    this.name = 'CastError'
    this.code = code
    this.statusCode = options?.statusCode
    this.raw = options?.raw
  }
}

/**
 * The codes native rejections may carry. Kept as a runtime list (not just a
 * type) because {@link toCastError} has to recognise them in prefixes coming
 * off the bridge.
 */
const NATIVE_CODES: readonly CastErrorCode[] = [
  'unavailable',
  'no-session',
  'session-start-failed',
  'load-failed',
  'cast-receiver-fetch',
  'invalid-argument',
  'invalid-state',
  'native',
]

/**
 * Native rejections cross the bridge as plain `Error`s whose message carries
 * a `[<code>]` marker from the closed set above (the spec's error contract).
 * This is the single place that turns one into a typed {@link CastError};
 * anything unmarked becomes `code: 'native'` with the original text in
 * `raw` — never swallowed, never guessed at.
 *
 * The marker is matched anywhere in the message, not just at the start:
 * device truth is that a Kotlin `Promise.reject(Throwable)` arrives in JS as
 * `"java.lang.IllegalStateException: [no-session] …"` — the exception class
 * name is prepended by the bridge, and an anchored match silently
 * reclassified every typed rejection as `native` (found because a
 * receiver-death test surfaced a `no-session` that a filter should have
 * dropped).
 */
export function toCastError(error: unknown): CastError {
  if (error instanceof CastError) return error
  const raw =
    error instanceof Error ? error.message : String(error ?? 'unknown error')
  const match = /\[([a-z-]+)\]\s*((?:.|\n)*)$/.exec(raw)
  if (match !== null) {
    const code = NATIVE_CODES.find((c) => c === match[1])
    if (code !== undefined) {
      const remainder = match[2] ?? raw
      const statusMatch = /\bstatus[ =:]+(-?\d+)/.exec(remainder)
      return new CastError(code, firstLine(remainder), {
        raw,
        statusCode:
          statusMatch?.[1] !== undefined ? Number(statusMatch[1]) : undefined,
      })
    }
  }
  return new CastError('native', firstLine(raw), { raw })
}

/**
 * `message` is for humans; `raw` is for logs. Kotlin `Promise.reject`
 * messages arrive with the full JVM stack trace appended after the first
 * newline (device-observed: an error banner rendering `message` spewed
 * twenty lines of `at com.google.android.gms...`), so the human message is
 * the first line only — everything survives verbatim in `raw`.
 */
function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? text
  return line.trim() === '' ? text : line.trimEnd()
}

/**
 * The one sentence every `cast-receiver-fetch` error carries, whichever native
 * channel produced it. Deliberately identical across platforms: a receiver
 * failure looks the same to app code on Android and iOS, and only the optional
 * `reason`/`statusCode` detail (Android-only — see
 * {@link receiverFetchError}) differs.
 */
const RECEIVER_FETCH_MESSAGE =
  'The receiver failed to fetch or play the media. The receiver fetches ' +
  'URLs itself — check that the URL is reachable from the receiver’s ' +
  'network (not localhost, not behind per-request auth headers).'

/**
 * Build the one `cast-receiver-fetch` error, optionally enriched with the
 * receiver's own detail.
 *
 * **The detail is Android-only, by platform ceiling.** Android's
 * `RemoteMediaClient.Callback.onMediaError(MediaError)` hands over
 * `getDetailedErrorCode()` / `getReason()`
 * (play-services-cast 22.3.1, verified with `javap`). iOS has no equivalent:
 * `GCKRemoteMediaClientListener` (GoogleCast 4.8.6,
 * `GCKRemoteMediaClient.h`) declares ten optional callbacks and none of them
 * is a media-error callback, and `GCKMediaStatus` (`GCKMediaStatus.h`) carries
 * no error code or reason field. On iOS the failure is synthesized natively
 * from `playerState == .idle && idleReason == .error`, so `code`/`message` are
 * identical to Android's and `statusCode`/`reason` are simply absent.
 *
 * Never branch on `statusCode` being present — branch on `code`.
 */
export function receiverFetchError(detail?: {
  /** Receiver-supplied reason string (Android only). */
  reason?: string
  /** Receiver-supplied detailed error code (Android only). */
  statusCode?: number
}): CastError {
  const reason = detail?.reason
  const message =
    reason !== undefined && reason !== ''
      ? `${RECEIVER_FETCH_MESSAGE} (receiver reason: ${reason})`
      : RECEIVER_FETCH_MESSAGE
  return new CastError('cast-receiver-fetch', message, {
    statusCode: detail?.statusCode,
  })
}

/**
 * Classify a receiver idle reason into what it means for playback.
 *
 * - `finished` → natural end of media — not an error.
 * - `cancelled` → a sender asked for it (stop/new load) — not an error.
 * - `interrupted` → another load interrupted playback — not an error.
 * - `error` → the receiver failed to fetch/decode; {@link CastError} with
 *   code `cast-receiver-fetch`.
 */
export function errorFromIdleReason(
  idleReason: CastIdleReason
): CastError | null {
  return idleReason === 'error' ? receiverFetchError() : null
}
