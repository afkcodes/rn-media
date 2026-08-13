import { describe, expect, it } from 'vitest'

import { MediaSessionError } from '../errors'
import {
  DEFAULT_JUMP_SECONDS,
  DEFAULT_PLAYBACK_RESUMPTION,
  DEFAULT_REPEAT_MODE,
  DEFAULT_SHUFFLE_ENABLED,
  DEFAULT_SUPPORTED_PLAYBACK_RATES,
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
    expect(normalizeConfig()).toEqual({
      android: undefined,
      ios: undefined,
      jumpForwardSeconds: 15,
      jumpBackwardSeconds: 15,
    })
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
          android: { ...base, playbackResumption: 'yes' as any },
        })
      ).toThrowError(/playbackResumption must be a boolean/)
    })
  })

  describe('onRevivalRequested', () => {
    const base = {
      notificationChannelId: 'playback',
      notificationChannelName: 'Playback',
    }

    it('rejects a non-function rather than registering garbage', () => {
      expect(() =>
        normalizeConfig({
          android: { ...base, onRevivalRequested: 'later' as any },
        })
      ).toThrowError(/onRevivalRequested must be a function/)
    })

    it('never reaches the native config — it is a JS-side registration', () => {
      const native = normalizeConfig({
        android: { ...base, onRevivalRequested: () => {} },
      })
      expect(native.android).not.toHaveProperty('onRevivalRequested')
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

/* -------------------------------------------------------------------------- */
/*                    Tier B additions (B1, B2, B4, B6, B12)                  */
/* -------------------------------------------------------------------------- */

describe('repeat and shuffle on the playback state (B2)', () => {
  it('defaults to off/false, so a state that predates the fields is unchanged', () => {
    const normalized = normalizePlaybackState(playbackState())

    expect(normalized.repeatMode).toBe(DEFAULT_REPEAT_MODE)
    expect(normalized.shuffleEnabled).toBe(DEFAULT_SHUFFLE_ENABLED)
    expect(normalized.repeatMode).toBe('off')
    expect(normalized.shuffleEnabled).toBe(false)
  })

  it('carries what the app broadcast', () => {
    const normalized = normalizePlaybackState(
      playbackState({ repeatMode: 'one', shuffleEnabled: true })
    )

    expect(normalized.repeatMode).toBe('one')
    expect(normalized.shuffleEnabled).toBe(true)
  })

  it('rejects a repeat mode that is not one of the three', () => {
    expect(() =>
      normalizePlaybackState(bad({ repeatMode: 'sideways' }))
    ).toThrowError(/playbackState\.repeatMode/)
  })

  it('rejects a non-boolean shuffle flag', () => {
    expect(() =>
      normalizePlaybackState(bad({ shuffleEnabled: 'yes' }))
    ).toThrowError(/playbackState\.shuffleEnabled/)
  })

  it('accepts the two new capabilities and the two new controls', () => {
    const normalized = normalizePlaybackState(
      playbackState({
        capabilities: ['setRepeatMode', 'setShuffle'],
        controls: ['repeatMode', 'shuffle'],
      })
    )

    expect(normalized.capabilities).toEqual(['setRepeatMode', 'setShuffle'])
    expect(normalized.controls).toEqual(['repeatMode', 'shuffle'])
  })

  it('the repeat CONTROL is not named `repeat` — that is a Swift keyword', () => {
    // The member becomes a native enumerator verbatim, and the package has been
    // bitten by this once already (`defaultMode` in @rn-media/audio-session).
    expect(() =>
      normalizePlaybackState(bad({ controls: ['repeat'] }))
    ).toThrowError(/playbackState\.controls/)
  })
})

describe('extended media item fields (B4)', () => {
  const base = { id: 'a', title: 'A' }

  it('carries every new field through untouched', () => {
    const item = {
      ...base,
      albumArtist: 'Various Artists',
      trackNumber: 7,
      discNumber: 2,
      year: 1997,
      subtitle: 'Episode 12',
      isLive: false,
      extras: { source: 'library' },
    }

    expect(validateMediaItem(item)).toEqual(item)
  })

  it('is happy with none of them — every one is optional', () => {
    expect(validateMediaItem(base)).toEqual(base)
  })

  it('rejects a fractional or zero ordinal rather than truncating it', () => {
    // media3's setTrackNumber(Integer) and MPMediaItemPropertyAlbumTrackNumber
    // would both turn 2.5 into a plausible-looking wrong answer.
    for (const field of ['trackNumber', 'discNumber', 'year'] as const) {
      expect(() => validateMediaItem({ ...base, [field]: 2.5 })).toThrowError(
        new RegExp(`${field} must be a positive integer`)
      )
      expect(() => validateMediaItem({ ...base, [field]: 0 })).toThrowError(
        new RegExp(`${field} must be a positive integer`)
      )
      expect(() => validateMediaItem({ ...base, [field]: -1 })).toThrowError(
        new RegExp(`${field} must be a positive integer`)
      )
    }
  })

  it('rejects a non-boolean isLive', () => {
    expect(() =>
      validateMediaItem({ ...base, isLive: 'yes' } as never)
    ).toThrowError(/isLive must be a boolean/)
  })

  it('rejects non-string extras values — they cross a Bundle and JSON', () => {
    expect(() =>
      validateMediaItem({ ...base, extras: { n: 1 } } as never)
    ).toThrowError(/extras\["n"\] must be a string/)
    expect(() =>
      validateMediaItem({ ...base, extras: { o: {} } } as never)
    ).toThrowError(/extras\["o"\] must be a string/)
  })

  it('rejects an array where an extras object belongs', () => {
    expect(() =>
      validateMediaItem({ ...base, extras: ['a'] } as never)
    ).toThrowError(/extras must be an object of string values/)
  })

  it('validates queue entries as thoroughly as the current item', () => {
    expect(() =>
      validateQueue([base, { ...base, trackNumber: 1.5 }] as never)
    ).toThrowError(/queue\[1\]\.trackNumber/)
  })
})

describe('jump intervals (B1 — the parity defect)', () => {
  it('defaults BOTH directions to the same 15 seconds', () => {
    // The defect: iOS pinned 15/15 while Android inherited media3's
    // C.DEFAULT_SEEK_BACK_INCREMENT_MS = 5000 / _FORWARD_ = 15000, so the same
    // JS call skipped back 5 s on Android and 15 s on iOS.
    const config = normalizeConfig()

    expect(config.jumpForwardSeconds).toBe(DEFAULT_JUMP_SECONDS)
    expect(config.jumpBackwardSeconds).toBe(DEFAULT_JUMP_SECONDS)
    expect(config.jumpForwardSeconds).toBe(config.jumpBackwardSeconds)
    expect(DEFAULT_JUMP_SECONDS).toBe(15)
  })

  it('passes an asymmetric pair through when the app asks for one', () => {
    const config = normalizeConfig({
      jumpForwardSeconds: 30,
      jumpBackwardSeconds: 10,
    })

    expect(config.jumpForwardSeconds).toBe(30)
    expect(config.jumpBackwardSeconds).toBe(10)
  })

  it('defaults the one that was omitted rather than mirroring the other', () => {
    const config = normalizeConfig({ jumpForwardSeconds: 30 })

    expect(config.jumpForwardSeconds).toBe(30)
    expect(config.jumpBackwardSeconds).toBe(15)
  })

  it('rejects zero, negatives and non-finite intervals', () => {
    for (const value of [0, -15, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => normalizeConfig({ jumpForwardSeconds: value })).toThrowError(
        /jumpForwardSeconds/
      )
      expect(() =>
        normalizeConfig({ jumpBackwardSeconds: value })
      ).toThrowError(/jumpBackwardSeconds/)
    }
  })
})

describe('notification colour (B6)', () => {
  const android = {
    notificationChannelId: 'playback',
    notificationChannelName: 'Playback',
  }

  it('passes an ARGB integer through, signed or unsigned', () => {
    expect(
      normalizeConfig({
        android: { ...android, notificationColor: 0xff1db954 },
      }).android?.notificationColor
    ).toBe(4280138068)
    expect(
      normalizeConfig({ android: { ...android, notificationColor: -16777216 } })
        .android?.notificationColor
    ).toBe(-16777216)
  })

  it('is undefined when the app did not choose one', () => {
    expect(
      normalizeConfig({ android }).android?.notificationColor
    ).toBeUndefined()
  })

  it('rejects a fractional colour or one outside 32 bits', () => {
    for (const value of [1.5, 0x1_0000_0000, -0x8000_0001]) {
      expect(() =>
        normalizeConfig({ android: { ...android, notificationColor: value } })
      ).toThrowError(/notificationColor/)
    }
  })
})

describe('iOS supported playback rates (B12)', () => {
  it('is passed through undefined when the app did not choose', () => {
    // The default list lives next to the command it configures, so "did not
    // choose" stays distinguishable from "chose exactly the default".
    expect(
      normalizeConfig({ ios: {} }).ios?.supportedPlaybackRates
    ).toBeUndefined()
  })

  it('passes an audiobook ladder through in order', () => {
    const rates = [1, 1.25, 1.5, 1.75, 2, 3]

    expect(
      normalizeConfig({ ios: { supportedPlaybackRates: rates } }).ios
        ?.supportedPlaybackRates
    ).toEqual(rates)
  })

  it('rejects an empty list — omit it for the default instead', () => {
    expect(() =>
      normalizeConfig({ ios: { supportedPlaybackRates: [] } })
    ).toThrowError(/supportedPlaybackRates/)
  })

  it('rejects zero and negative rates', () => {
    for (const value of [0, -1]) {
      expect(() =>
        normalizeConfig({ ios: { supportedPlaybackRates: [1, value] } })
      ).toThrowError(/supportedPlaybackRates/)
    }
  })

  it('documents the default list, which is the one that already shipped', () => {
    expect(DEFAULT_SUPPORTED_PLAYBACK_RATES).toEqual([
      0.5, 0.75, 1, 1.25, 1.5, 2,
    ])
  })
})
