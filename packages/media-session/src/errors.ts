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
