import { describe, expect, it } from 'vitest'

import { CastError, errorFromIdleReason, toCastError } from '../errors'

describe('toCastError', () => {
  it('parses every native code prefix', () => {
    for (const code of [
      'unavailable',
      'no-session',
      'session-start-failed',
      'load-failed',
      'cast-receiver-fetch',
      'invalid-argument',
      'invalid-state',
      'native',
    ] as const) {
      const error = toCastError(new Error(`[${code}] something happened`))
      expect(error).toBeInstanceOf(CastError)
      expect(error.code).toBe(code)
      expect(error.raw).toBe(`[${code}] something happened`)
    }
  })

  it('extracts the platform status code when present', () => {
    const error = toCastError(
      new Error(
        '[session-start-failed] The platform reported a session start failure, status=2473'
      )
    )
    expect(error.code).toBe('session-start-failed')
    expect(error.statusCode).toBe(2473)
  })

  it('parses the PendingResult bridge format', () => {
    const error = toCastError(
      new Error('[load-failed] load failed, status=2100 (Failed to load media)')
    )
    expect(error.code).toBe('load-failed')
    expect(error.statusCode).toBe(2100)
  })

  it('classifies a bridge-prepended exception class (device-found shape)', () => {
    // A Kotlin `Promise.reject(Throwable)` reaches JS with the exception
    // class name prepended — the code marker is NOT at the start. An
    // anchored match silently reclassified every typed rejection as
    // `native`, which broke the `no-session` filters.
    const error = toCastError(
      new Error(
        'java.lang.IllegalStateException: [no-session] No connected cast session. Call requestSession() first.'
      )
    )
    expect(error.code).toBe('no-session')
  })

  it('an unprefixed error becomes code native with the text preserved', () => {
    const error = toCastError(new Error('kaboom'))
    expect(error.code).toBe('native')
    expect(error.raw).toBe('kaboom')
  })

  it('an unknown prefix is not guessed at', () => {
    const error = toCastError(new Error('[not-a-real-code] whatever'))
    expect(error.code).toBe('native')
  })

  it('non-Error values are stringified, never swallowed', () => {
    expect(toCastError('boom').code).toBe('native')
    expect(toCastError('boom').raw).toBe('boom')
    expect(toCastError(undefined).code).toBe('native')
  })

  it('passes an existing CastError through untouched', () => {
    const original = new CastError('no-session', 'nope')
    expect(toCastError(original)).toBe(original)
  })

  it('keeps the human message to the first line — JVM stack traces stay in raw (device-found)', () => {
    // Kotlin rejections arrive with the full stack trace appended after the
    // first newline; an error banner rendering `message` spewed twenty lines
    // of `at com.google.android.gms...` at the user.
    const error = toCastError(
      new Error(
        'java.lang.IllegalStateException: [native] queueJumpTo failed: CANCELED (status=2002)\n' +
          '\tat com.rnmediacast.CastController$bridge$1.onResult(CastController.kt:879)\n' +
          '\tat android.os.Handler.dispatchMessage(Handler.java:132)'
      )
    )
    expect(error.code).toBe('native')
    expect(error.statusCode).toBe(2002)
    expect(error.message).toBe('[cast] queueJumpTo failed: CANCELED (status=2002)')
    expect(error.raw).toContain('at com.rnmediacast.CastController')
  })

  it('trims an unprefixed multi-line error to its first line too', () => {
    const error = toCastError(new Error('kaboom\n\tat somewhere.deep(Native)'))
    expect(error.message).toBe('[cast] kaboom')
    expect(error.raw).toContain('at somewhere.deep')
  })
})

describe('errorFromIdleReason', () => {
  it('only the error reason is an error', () => {
    expect(errorFromIdleReason('none')).toBeNull()
    expect(errorFromIdleReason('finished')).toBeNull()
    expect(errorFromIdleReason('cancelled')).toBeNull()
    expect(errorFromIdleReason('interrupted')).toBeNull()
  })

  it('the error reason maps to the cast-receiver-fetch family', () => {
    const error = errorFromIdleReason('error')
    expect(error).toBeInstanceOf(CastError)
    expect(error?.code).toBe('cast-receiver-fetch')
  })
})
