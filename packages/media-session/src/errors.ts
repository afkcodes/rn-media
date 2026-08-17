import type { SessionError } from './types'

/**
 * Why a `media-session` call was rejected.
 *
 * A closed union rather than free-form messages so callers can branch (and so
 * tests assert on the code, not on prose). CLAUDE.md principle 6.
 */
export type MediaSessionErrorCode =
  /** A broadcast/init argument failed validation. The message names the field. */
  | 'invalidArgument'
  /** `init()` called twice without an intervening `stopService()`. */
  | 'alreadyInitialized'
  /** A broadcast setter (or `stopService`) called before `init()` resolved. */
  | 'notInitialized'

export class MediaSessionError extends Error {
  readonly code: MediaSessionErrorCode

  constructor(code: MediaSessionErrorCode, message: string) {
    super(`[media-session] ${message}`)
    this.name = 'MediaSessionError'
    this.code = code
  }
}

export function invalidArgument(message: string): MediaSessionError {
  return new MediaSessionError('invalidArgument', message)
}

/**
 * Where a {@link SessionError} goes when the app has nowhere for it.
 *
 * The floor under `MediaHandler.onSessionError`, and the reason that method can
 * be optional without re-creating the swallowed-error bug it exists to fix: a
 * handler that does not implement it, or a `CompositeMediaHandler` wrapping one
 * that does not, still puts the failure somewhere a developer will see it.
 *
 * Deliberately **not** routed through `MediaServiceConfig.onHandlerError`: that
 * channel means "your handler threw", its first parameter is typed
 * `keyof MediaHandler`, and a session error is neither. Same reasoning as
 * `android.onRevivalRequested`'s console fallback in `media-service.ts`.
 *
 * `console.error` for both severities. A `'degraded'` code is still a defect in
 * the app's configuration or the network, and `console.warn` in React Native is
 * a yellow box in dev and indistinguishable from noise in production.
 */
export function logSessionError(error: SessionError): void {
  console.error(
    `[media-session] ${error.severity} · ${error.code}: ${error.message}`
  )
}
