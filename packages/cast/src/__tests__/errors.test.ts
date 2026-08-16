import { describe, expect, it } from 'vitest'

import {
  CastError,
  errorFromIdleReason,
  receiverFetchError,
  toCastError,
} from '../errors'

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

describe('receiverFetchError — one shape for both platforms', () => {
  it('the detail-free error is byte-identical to the idle-derived one', () => {
    // The iOS half has no receiver detail to supply (no media-error callback
    // in GoogleCast 4.8.6), so its synthesized error must be exactly what the
    // idle status produces on either platform — app code must not be able to
    // tell which platform, or which native channel, it came from.
    const fromIdle = errorFromIdleReason('error')
    const synthesized = receiverFetchError()
    expect(synthesized.code).toBe(fromIdle?.code)
    expect(synthesized.message).toBe(fromIdle?.message)
    expect(synthesized.statusCode).toBeUndefined()
  })

  it('Android detail is additive — same family and guidance, plus the reason', () => {
    const detailed = receiverFetchError({
      reason: 'LOAD_FAILED',
      statusCode: 311,
    })
    expect(detailed.code).toBe('cast-receiver-fetch')
    expect(detailed.statusCode).toBe(311)
    expect(detailed.message).toContain('LOAD_FAILED')
    // The guidance sentence survives — it is the actionable half.
    expect(detailed.message).toContain('reachable from the receiver')
  })

  it('an empty reason string does not produce an empty parenthetical', () => {
    expect(receiverFetchError({ reason: '' }).message).toBe(
      receiverFetchError().message
    )
  })
})
