import { describe, expect, it } from 'vitest'

import { MediaSessionError } from '../errors'
import {
  DEFAULT_PLAYBACK_RESUMPTION,
  MAX_COMPACT_CONTROLS,
  MAX_STOP_FOREGROUND_TIMEOUT_MS,
  normalizeConfig,
  normalizePlaybackState,
  validateAnchor,
  validateMediaItem,
  validateQueue,
  validateSleepTimerSeconds,
} from '../validate'
import type { PlaybackState } from '../types'
import { playbackState } from './fakes'

/** `unknown` in, so the tests can pass the garbage a plain-JS caller would. */
function bad(overrides: Record<string, unknown>): PlaybackState {
  return { ...playbackState(), ...overrides } as PlaybackState
}

describe('validateAnchor', () => {
  it('accepts a well-formed anchor and returns a copy', () => {
    const anchor = { value: 0, at: 1, rate: 0 }
    expect(validateAnchor(anchor)).toEqual(anchor)
    expect(validateAnchor(anchor)).not.toBe(anchor)
  })

  it.each([
    ['a missing object', undefined],
    ['a non-object', 42],
  ])('rejects %s', (_label, value) => {
    expect(() => validateAnchor(value as never)).toThrow(MediaSessionError)
  })

  it.each([
    ['value', { value: Number.NaN, at: 1, rate: 1 }],
    ['at', { value: 0, at: Number.POSITIVE_INFINITY, rate: 1 }],
    ['rate', { value: 0, at: 1, rate: Number.NaN }],
  ])('rejects a non-finite %s', (field, anchor) => {
    expect(() => validateAnchor(anchor)).toThrowError(
      new RegExp(`position\\.${field} must be a finite number`)
    )
  })

  it('rejects a negative position', () => {
    expect(() => validateAnchor({ value: -1, at: 1, rate: 1 })).toThrowError(
      /value must be >= 0/
    )
  })

  it('rejects a non-positive timestamp — `at` is Date.now(), not an offset', () => {
    expect(() => validateAnchor({ value: 0, at: 0, rate: 1 })).toThrowError(
      /positive epoch timestamp/
    )
  })

  it('rejects a negative rate', () => {
    expect(() => validateAnchor({ value: 0, at: 1, rate: -1 })).toThrowError(
      /rate must be >= 0/
    )
  })
})

describe('normalizePlaybackState', () => {
  it('defaults the three optional arrays', () => {
    expect(normalizePlaybackState(playbackState())).toMatchObject({
      controls: [],
      capabilities: [],
      customActions: [],
      compactControlIndices: undefined,
    })
  })

  it('rejects an unknown status', () => {
    expect(() => normalizePlaybackState(bad({ status: 'idle' }))).toThrowError(
      /status must be one of/
    )
  })

  it('rejects an unknown control or capability', () => {
    expect(() =>
      normalizePlaybackState(bad({ controls: ['nope'] }))
    ).toThrowError(/controls\[\] must be one of/)
    expect(() =>
      normalizePlaybackState(bad({ capabilities: ['nope'] }))
    ).toThrowError(/capabilities\[\] must be one of/)
  })

  it(`rejects more than ${MAX_COMPACT_CONTROLS} compact controls`, () => {
    expect(() =>
      normalizePlaybackState(
        bad({
          controls: ['play', 'pause', 'stop', 'skipToNext'],
          compactControlIndices: [0, 1, 2, 3],
        })
      )
    ).toThrowError(/at most 3 entries/)
  })

  it('accepts exactly three compact controls', () => {
    expect(
      normalizePlaybackState(
        bad({
          controls: ['skipToPrevious', 'pause', 'skipToNext'],
          compactControlIndices: [0, 1, 2],
        })
      ).compactControlIndices
    ).toEqual([0, 1, 2])
  })

  it('rejects a compact index that is not an index into controls', () => {
    expect(() =>
      normalizePlaybackState(
        bad({ controls: ['play'], compactControlIndices: [1] })
      )
    ).toThrowError(/not a valid index into controls/)
    expect(() =>
      normalizePlaybackState(
        bad({ controls: ['play'], compactControlIndices: [0.5] })
      )
    ).toThrowError(/not a valid index into controls/)
    expect(() =>
      normalizePlaybackState(bad({ compactControlIndices: [0] }))
    ).toThrowError(/not a valid index into controls/)
  })

  it('rejects duplicate custom action names — the round-trip is by name', () => {
    expect(() =>
      normalizePlaybackState(
        bad({
          customActions: [
            { name: 'like', title: 'Like' },
            { name: 'like', title: 'Like again' },
          ],
        })
      )
    ).toThrowError(/duplicate name "like"/)
  })

  it('rejects a custom action without a name or title', () => {
    expect(() =>
      normalizePlaybackState(bad({ customActions: [{ title: 'Like' }] }))
    ).toThrowError(/customActions\[0\]\.name/)
    expect(() =>
      normalizePlaybackState(bad({ customActions: [{ name: 'like' }] }))
    ).toThrowError(/customActions\[0\]\.title/)
  })

  it('rejects a negative buffered position', () => {
    expect(() =>
      normalizePlaybackState(bad({ bufferedPosition: -1 }))
    ).toThrowError(/bufferedPosition must be >= 0/)
  })

  it('accepts -1 as queueIndex but rejects anything below or fractional', () => {
    expect(normalizePlaybackState(bad({ queueIndex: -1 })).queueIndex).toBe(-1)
    expect(() => normalizePlaybackState(bad({ queueIndex: -2 }))).toThrowError(
      /queueIndex must be an integer >= -1/
    )
    expect(() => normalizePlaybackState(bad({ queueIndex: 1.5 }))).toThrowError(
      /queueIndex must be an integer >= -1/
    )
  })
})

describe('validateMediaItem / validateQueue', () => {
  it('requires an id and a title', () => {
    expect(() => validateMediaItem({ id: '', title: 'x' })).toThrowError(
      /mediaItem\.id/
    )
    expect(() => validateMediaItem({ id: 'a', title: '' })).toThrowError(
      /mediaItem\.title/
    )
  })

  it('rejects a negative duration', () => {
    expect(() =>
      validateMediaItem({ id: 'a', title: 't', duration: -1 })
    ).toThrowError(/duration must be >= 0/)
  })

  it('names the offending queue index', () => {
    expect(() =>
      validateQueue([
        { id: 'a', title: 'a' },
        { id: 'b', title: '' },
      ])
    ).toThrowError(/queue\[1\]\.title/)
  })

  it('accepts an empty queue', () => {
    expect(validateQueue([])).toEqual([])
  })
})

describe('normalizeConfig', () => {
  it('defaults stopForegroundOnPause to true (audio_service parity)', () => {
    expect(
      normalizeConfig({
        android: {
          notificationChannelId: 'playback',
          notificationChannelName: 'Playback',
        },
      }).android?.stopForegroundOnPause
    ).toBe(true)
  })

  it('keeps an explicit false', () => {
    expect(
      normalizeConfig({
        android: {
          notificationChannelId: 'playback',
          notificationChannelName: 'Playback',
          stopForegroundOnPause: false,
        },
      }).android?.stopForegroundOnPause
    ).toBe(false)
  })

  it('requires a channel id and name when the android half is present', () => {
    expect(() =>
      normalizeConfig({
        android: { notificationChannelId: '', notificationChannelName: 'x' },
      })
    ).toThrowError(/notificationChannelId/)
    expect(() =>
      normalizeConfig({
        android: { notificationChannelId: 'x', notificationChannelName: '' },
      })
    ).toThrowError(/notificationChannelName/)
  })

  it('rejects a nonsensical artwork cache size', () => {
    expect(() =>
      normalizeConfig({ ios: { artworkCacheSize: -1 } })
    ).toThrowError(/artworkCacheSize/)
    expect(() =>
      normalizeConfig({ ios: { artworkCacheSize: 1.5 } })
    ).toThrowError(/artworkCacheSize/)
  })

  it('is fine with no config at all', () => {
    expect(normalizeConfig()).toEqual({ android: undefined, ios: undefined })
  })

  describe('playbackResumption', () => {
    const base = {
      notificationChannelId: 'playback',
      notificationChannelName: 'Playback',
    }

    it('is false unless the app asks for it', () => {
      expect(
        normalizeConfig({ android: base }).android?.playbackResumption
      ).toBe(false)
      expect(DEFAULT_PLAYBACK_RESUMPTION).toBe(false)
    })

    it('passes an explicit opt-in through', () => {
      expect(
        normalizeConfig({
          android: { ...base, playbackResumption: true },
        }).android?.playbackResumption
      ).toBe(true)
    })

    it('rejects a non-boolean rather than coercing it', () => {
      expect(() =>
        normalizeConfig({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          android: { ...base, playbackResumption: 'yes' as any },
        })
      ).toThrowError(/playbackResumption must be a boolean/)
    })
  })

  describe('stopForegroundTimeoutMs', () => {
    const base = {
      notificationChannelId: 'playback',
      notificationChannelName: 'Playback',
    }

    it('stays undefined when unset, so media3 keeps its own default', () => {
      expect(
        normalizeConfig({ android: base }).android?.stopForegroundTimeoutMs
      ).toBeUndefined()
    })

    it('passes a value through unchanged, including 0', () => {
      expect(
        normalizeConfig({
          android: { ...base, stopForegroundTimeoutMs: 0 },
        }).android?.stopForegroundTimeoutMs
      ).toBe(0)
      expect(
        normalizeConfig({
          android: { ...base, stopForegroundTimeoutMs: 15_000 },
        }).android?.stopForegroundTimeoutMs
      ).toBe(15_000)
    })

    it('rejects a negative timeout rather than letting media3 clamp it to 0', () => {
      expect(() =>
        normalizeConfig({ android: { ...base, stopForegroundTimeoutMs: -1 } })
      ).toThrowError(/stopForegroundTimeoutMs must be >= 0/)
    })

    it('rejects non-finite values', () => {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() =>
          normalizeConfig({
            android: { ...base, stopForegroundTimeoutMs: value },
          })
        ).toThrowError(/stopForegroundTimeoutMs must be a finite number/)
      }
    })

    it('accepts media3 ceiling values; the clamp above it is media3’s, not ours', () => {
      expect(
        normalizeConfig({
          android: {
            ...base,
            stopForegroundTimeoutMs: MAX_STOP_FOREGROUND_TIMEOUT_MS,
          },
        }).android?.stopForegroundTimeoutMs
      ).toBe(MAX_STOP_FOREGROUND_TIMEOUT_MS)
      // Documented behaviour: not rejected here — media3 constrains it down.
      expect(
        normalizeConfig({
          android: {
            ...base,
            stopForegroundTimeoutMs: MAX_STOP_FOREGROUND_TIMEOUT_MS * 2,
          },
        }).android?.stopForegroundTimeoutMs
      ).toBe(MAX_STOP_FOREGROUND_TIMEOUT_MS * 2)
    })
  })
})

describe('validateSleepTimerSeconds', () => {
  it('accepts any strictly positive finite duration', () => {
    expect(validateSleepTimerSeconds(0.5)).toBe(0.5)
    expect(validateSleepTimerSeconds(1800)).toBe(1800)
  })

  it('rejects zero — "cancel" and "pause now" both already have names', () => {
    expect(() => validateSleepTimerSeconds(0)).toThrowError(
      /seconds must be > 0/
    )
  })

  it('rejects negatives', () => {
    expect(() => validateSleepTimerSeconds(-30)).toThrowError(
      /seconds must be > 0/
    )
  })

  it('rejects NaN and Infinity before they become a 0 ms native delay', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateSleepTimerSeconds(value)).toThrowError(
        /seconds must be a finite number/
      )
    }
  })

  it('rejects non-numbers from plain-JS callers', () => {
    expect(() =>
      validateSleepTimerSeconds('30' as unknown as number)
    ).toThrowError(MediaSessionError)
  })
})
