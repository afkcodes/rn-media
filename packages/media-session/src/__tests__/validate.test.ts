import { describe, expect, it } from 'vitest'

import { MediaSessionError } from '../errors'
import {
  MAX_COMPACT_CONTROLS,
  normalizeConfig,
  normalizePlaybackState,
  validateAnchor,
  validateMediaItem,
  validateQueue,
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
})
