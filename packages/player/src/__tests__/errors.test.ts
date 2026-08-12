import { describe, expect, it } from 'vitest'
import {
  PlayerErrorException,
  classifyEndFile,
  disposedError,
  isNetworkUri,
  isRetryableErrno,
  toPlayerError,
} from '../errors'
import type { MpvEndFileReason } from '../specs/mpv-client.nitro'

const NETWORK_URI = 'https://cdn.example.com/track.flac'
const LOCAL_URI = '/sdcard/Music/track.flac'

describe('isNetworkUri', () => {
  it.each([
    ['https://example.com/a.mp3', true],
    ['http://example.com/a.mp3', true],
    ['rtsp://example.com/live', true],
    ['SMB://server/share/a.mp3', true],
    ['/sdcard/a.mp3', false],
    ['file:///sdcard/a.mp3', false],
    ['content://media/external/audio/1', false],
    [undefined, false],
  ] as const)('classifies %s as network=%s', (uri, expected) => {
    expect(isNetworkUri(uri)).toBe(expected)
  })
})

describe('toPlayerError — native `[mpv:…]` tags', () => {
  it('maps [mpv:disposed]', () => {
    const error = toPlayerError(
      new Error('[mpv:disposed] Cannot call `command` after destroy')
    )
    expect(error).toEqual({
      code: 'disposed',
      message: 'Cannot call `command` after destroy',
      retryable: false,
    })
  })

  it('maps [mpv:invalid-state]', () => {
    expect(
      toPlayerError(new Error('[mpv:invalid-state] already initialized'))
    ).toEqual({
      code: 'invalid-state',
      message: 'already initialized',
      retryable: false,
    })
  })

  it('maps [mpv:unsupported]', () => {
    expect(
      toPlayerError(
        new Error('[mpv:unsupported] `attachVideoOutput` is not implemented.')
      )
    ).toEqual({
      code: 'unsupported',
      message: '`attachVideoOutput` is not implemented.',
      retryable: false,
    })
  })

  it('maps MPV_ERROR_UNKNOWN_FORMAT (-17) to unsupported-format', () => {
    const error = toPlayerError(
      new Error('[mpv:-17] mpv_command_async(): unrecognized file format'),
      LOCAL_URI
    )
    expect(error.code).toBe('unsupported-format')
  })

  it('maps MPV_ERROR_LOADING_FAILED (-13) to load-failed for a local file', () => {
    const error = toPlayerError(
      new Error('[mpv:-13] mpv_command_async(): loading failed'),
      LOCAL_URI
    )
    expect(error).toMatchObject({ code: 'load-failed', uri: LOCAL_URI })
  })

  it('maps MPV_ERROR_LOADING_FAILED (-13) to network for an https source', () => {
    const error = toPlayerError(
      new Error('[mpv:-13] mpv_command_async(): loading failed'),
      NETWORK_URI
    )
    expect(error).toMatchObject({ code: 'network', uri: NETWORK_URI })
  })

  it('maps MPV_ERROR_NOTHING_TO_PLAY (-16) like a load failure', () => {
    expect(
      toPlayerError(new Error('[mpv:-16] no audio or video data played')).code
    ).toBe('load-failed')
  })

  it.each([
    [-18, 'unsupported'],
    [-19, 'unsupported'],
  ] as const)('maps errno %d to %s', (errno, code) => {
    expect(toPlayerError(new Error(`[mpv:${errno}] not supported`)).code).toBe(
      code
    )
  })

  it.each([-1, -2, -3, -4, -5, -6, -7, -8, -9, -10, -11, -12, -14, -15, -20])(
    'falls back to code "mpv" with the errno for %d',
    (errno) => {
      const error = toPlayerError(new Error(`[mpv:${errno}] something: reason`))
      expect(error).toMatchObject({ code: 'mpv', errno })
    }
  )

  it('keeps an untagged message as a raw mpv error', () => {
    expect(toPlayerError('kaboom')).toEqual({
      code: 'mpv',
      message: 'kaboom',
      raw: 'kaboom',
      retryable: false,
    })
  })

  it('handles a non-numeric, non-known tag', () => {
    const error = toPlayerError(new Error('[mpv:weird] hmm'))
    expect(error).toMatchObject({ code: 'mpv', message: 'hmm' })
  })

  it('round-trips a PlayerErrorException without re-parsing', () => {
    const original = disposedError('play')
    const thrown = new PlayerErrorException(original)
    expect(toPlayerError(thrown)).toBe(original)
    expect(thrown.message).toBe(original.message)
  })

  it('stringifies non-Error throwables', () => {
    expect(toPlayerError({ nope: true }).message).toBe('[object Object]')
  })
})

describe('classifyEndFile', () => {
  it('treats endOfFile as a natural end, never an error', () => {
    expect(classifyEndFile('endOfFile', undefined, NETWORK_URI)).toEqual({
      type: 'ended',
    })
  })

  it('treats stop as a deliberate stop', () => {
    expect(classifyEndFile('stop', undefined)).toEqual({
      type: 'stopped',
      quit: false,
    })
  })

  it('treats quit as a stop that ends the core', () => {
    expect(classifyEndFile('quit', undefined)).toEqual({
      type: 'stopped',
      quit: true,
    })
  })

  it('treats redirect as a playlist expansion', () => {
    expect(classifyEndFile('redirect', undefined)).toEqual({ type: 'redirect' })
  })

  it('treats an unknown future reason as a stop', () => {
    expect(classifyEndFile('unknown', undefined)).toEqual({
      type: 'stopped',
      quit: false,
    })
  })

  it('covers every MpvEndFileReason', () => {
    const reasons: readonly MpvEndFileReason[] = [
      'endOfFile',
      'stop',
      'quit',
      'error',
      'redirect',
      'unknown',
    ]
    const types = reasons.map(
      (reason) => classifyEndFile(reason, 'loading failed').type
    )
    expect(types).toEqual([
      'ended',
      'stopped',
      'stopped',
      'failed',
      'redirect',
      'stopped',
    ])
  })

  it('maps "unrecognized file format" to unsupported-format', () => {
    const outcome = classifyEndFile(
      'error',
      'unrecognized file format',
      NETWORK_URI
    )
    expect(outcome).toMatchObject({ type: 'failed' })
    if (outcome.type !== 'failed') throw new Error('unreachable')
    expect(outcome.error).toMatchObject({
      code: 'unsupported-format',
      raw: 'unrecognized file format',
    })
  })

  it('maps "loading failed" on a network source to network', () => {
    const outcome = classifyEndFile('error', 'loading failed', NETWORK_URI)
    if (outcome.type !== 'failed') throw new Error('unreachable')
    expect(outcome.error).toMatchObject({ code: 'network', uri: NETWORK_URI })
  })

  it('maps "loading failed" on a local source to load-failed', () => {
    const outcome = classifyEndFile('error', 'loading failed', LOCAL_URI)
    if (outcome.type !== 'failed') throw new Error('unreachable')
    expect(outcome.error).toMatchObject({ code: 'load-failed', uri: LOCAL_URI })
  })

  it('maps "no audio or video data played" like a load failure', () => {
    const outcome = classifyEndFile(
      'error',
      'no audio or video data played',
      LOCAL_URI
    )
    if (outcome.type !== 'failed') throw new Error('unreachable')
    expect(outcome.error.code).toBe('load-failed')
  })

  it('maps "audio output initialization failed" to a raw mpv error', () => {
    const outcome = classifyEndFile(
      'error',
      'audio output initialization failed'
    )
    if (outcome.type !== 'failed') throw new Error('unreachable')
    expect(outcome.error).toMatchObject({ code: 'mpv', errno: -14 })
  })

  it('treats an unrecognised mpv error string on a network source as network', () => {
    const outcome = classifyEndFile('error', 'something happened', NETWORK_URI)
    if (outcome.type !== 'failed') throw new Error('unreachable')
    expect(outcome.error.code).toBe('network')
  })

  it('treats an unrecognised mpv error string on a local source as raw mpv', () => {
    const outcome = classifyEndFile('error', 'something happened', LOCAL_URI)
    if (outcome.type !== 'failed') throw new Error('unreachable')
    expect(outcome.error).toMatchObject({
      code: 'mpv',
      raw: 'something happened',
    })
  })

  it('survives an error reason with no error text', () => {
    const outcome = classifyEndFile('error', undefined)
    if (outcome.type !== 'failed') throw new Error('unreachable')
    expect(outcome.error.message).toContain('unknown mpv error')
  })
})

describe('disposedError', () => {
  it('names the operation that was attempted', () => {
    expect(disposedError('seekTo')).toEqual({
      code: 'disposed',
      message: 'Cannot call `seekTo` — the player has been destroyed.',
      retryable: false,
    })
  })
})

describe('retryable — the flag PlayerOptions.retry consumes', () => {
  it('marks a network failure retryable', () => {
    const outcome = classifyEndFile(
      'error',
      'loading failed',
      'https://cdn.example.com/a.flac'
    )
    expect(outcome).toMatchObject({
      type: 'failed',
      error: { code: 'network', retryable: true },
    })
  })

  it('marks an unsupported format NOT retryable — the binary will not change', () => {
    expect(
      classifyEndFile(
        'error',
        'unrecognized file format',
        'https://cdn.example.com/a.xyz'
      )
    ).toMatchObject({
      type: 'failed',
      error: { code: 'unsupported-format', retryable: false },
    })
  })

  it('marks load-failed NOT retryable, because it is never a network source', () => {
    // The classifier splits on `isNetworkUri`: every network URI became
    // `network` above, so a `load-failed` from an end-file is by construction a
    // local path (or an unknown one). Asking twice changes nothing.
    expect(
      classifyEndFile('error', 'loading failed', '/sdcard/missing.mp3')
    ).toMatchObject({
      type: 'failed',
      error: { code: 'load-failed', retryable: false },
    })
    expect(classifyEndFile('error', 'loading failed')).toMatchObject({
      type: 'failed',
      error: { code: 'load-failed', retryable: false },
    })
  })

  it('marks an audio-output init failure retryable — the device is shared', () => {
    expect(
      classifyEndFile('error', 'audio output initialization failed')
    ).toMatchObject({
      type: 'failed',
      error: { code: 'mpv', errno: -14, retryable: true },
    })
  })

  it('marks an unrecognised mpv error string on a network source retryable', () => {
    expect(
      classifyEndFile('error', 'something new', 'https://cdn.example.com/a')
    ).toMatchObject({
      type: 'failed',
      error: { code: 'network', retryable: true },
    })
  })

  it('marks an unrecognised mpv error string on a local source NOT retryable', () => {
    expect(
      classifyEndFile('error', 'something new', '/sdcard/a.mp3')
    ).toMatchObject({
      type: 'failed',
      error: { code: 'mpv', retryable: false },
    })
  })

  it('never marks an argument or lifecycle fault retryable', () => {
    expect(disposedError('play').retryable).toBe(false)
    expect(
      toPlayerError(new Error('[mpv:invalid-state] already initialized'))
        .retryable
    ).toBe(false)
    expect(
      toPlayerError(new Error('[mpv:unsupported] no video here')).retryable
    ).toBe(false)
  })

  it('is present on every error the taxonomy can produce', () => {
    const samples = [
      toPlayerError(new Error('[mpv:disposed] gone')),
      toPlayerError(new Error('[mpv:invalid-state] no')),
      toPlayerError(new Error('[mpv:unsupported] no')),
      toPlayerError(new Error('[mpv:-17] bad format')),
      toPlayerError(new Error('[mpv:-13] nope'), 'https://x.example/a'),
      toPlayerError(new Error('[mpv:-13] nope'), '/tmp/a.mp3'),
      toPlayerError(new Error('[mpv:-14] no device')),
      toPlayerError(new Error('[mpv:weird] hmm')),
      toPlayerError('untagged'),
      disposedError('load'),
    ]
    for (const error of samples) {
      expect(typeof error.retryable).toBe('boolean')
    }
  })
})

describe('isRetryableErrno', () => {
  it('is true for MPV_ERROR_AO_INIT_FAILED and nothing else', () => {
    expect(isRetryableErrno(-14)).toBe(true)
    for (const errno of [
      -1, -2, -3, -4, -5, -6, -7, -8, -9, -10, -11, -12, -15, -20,
    ]) {
      expect(isRetryableErrno(errno)).toBe(false)
    }
  })

  it('treats an absent errno as not retryable', () => {
    // An error this layer could not even attribute to mpv is not evidence of a
    // transient condition.
    expect(isRetryableErrno(undefined)).toBe(false)
  })

  it('treats an errno mpv has not invented yet as not retryable', () => {
    expect(isRetryableErrno(-99)).toBe(false)
  })
})
