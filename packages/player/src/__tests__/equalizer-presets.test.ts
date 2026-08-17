import { beforeEach, describe, expect, it } from 'vitest'
import {
  EQUALIZER_BANDS,
  EQUALIZER_BAND_COUNT,
  EQUALIZER_LIMITER_LABEL,
  EQUALIZER_PREAMP_LABEL,
  EQUALIZER_PRESETS,
  EQUALIZER_PRESET_LIST,
  defineEqualizerPreset,
  equalizerBandLabel,
  equalizerPresetChain,
  peakResponseDb,
} from '../equalizer-presets'
import { PlayerErrorException } from '../errors'
import { compileAudioFilters, diffAudioFilterParams } from '../filters'
import { Player } from '../player'
import { MpvProperty } from '../properties'
import { FakeMpvClient } from './fake-mpv-client'

function expectInvalidState(run: () => unknown): void {
  try {
    run()
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(PlayerErrorException)
    expect((thrown as PlayerErrorException).playerError.code).toBe(
      'invalid-state'
    )
    return
  }
  throw new Error('expected an invalid-state PlayerErrorException')
}

// ---------------------------------------------------------------------------
// The band grid
// ---------------------------------------------------------------------------

describe('peakResponseDb', () => {
  it('is zero for a flat curve', () => {
    expect(peakResponseDb(EQUALIZER_PRESETS.flat.gainsDb)).toBeCloseTo(0, 6)
  })

  it('returns a single band’s own gain at its centre', () => {
    const one = [0, 0, 0, 0, 0, 6, 0, 0, 0, 0]
    expect(peakResponseDb(one)).toBeCloseTo(6, 1)
  })

  it('exceeds the largest slider whenever neighbours boost together', () => {
    // Two adjacent bands at +6 dB overlap and sum well past +6.
    const pair = [0, 0, 0, 0, 6, 6, 0, 0, 0, 0]
    expect(peakResponseDb(pair)).toBeGreaterThan(6.5)
  })

  it('narrower bells overlap less, so they sum less', () => {
    const pair = [0, 0, 0, 0, 6, 6, 0, 0, 0, 0]
    expect(peakResponseDb(pair, 0.5)).toBeLessThan(peakResponseDb(pair, 1))
  })

  it('is negative for a cut-only curve', () => {
    expect(
      peakResponseDb(EQUALIZER_PRESETS.bassReducer.gainsDb)
    ).toBeLessThanOrEqual(0)
  })
})

describe('EQUALIZER_BANDS', () => {
  it('is the ten ISO octave centres', () => {
    expect(EQUALIZER_BANDS).toEqual([
      31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
    ])
    expect(EQUALIZER_BAND_COUNT).toBe(10)
  })

  it('doubles each step, so one-octave bells tile the spectrum', () => {
    for (let i = 1; i < EQUALIZER_BANDS.length; i += 1) {
      const ratio =
        (EQUALIZER_BANDS[i] as number) / (EQUALIZER_BANDS[i - 1] as number)
      expect(ratio).toBeGreaterThan(1.9)
      expect(ratio).toBeLessThan(2.1)
    }
  })
})

// ---------------------------------------------------------------------------
// The built-in curves
// ---------------------------------------------------------------------------

describe('built-in presets', () => {
  const presets = Object.values(EQUALIZER_PRESETS)

  it('all have one gain per band', () => {
    for (const preset of presets) {
      expect(preset.gainsDb, preset.id).toHaveLength(EQUALIZER_BAND_COUNT)
    }
  })

  it('all have finite gains inside ±9 dB — no preset can be a clipping trap', () => {
    for (const preset of presets) {
      for (const gain of preset.gainsDb) {
        expect(Number.isFinite(gain), `${preset.id} ${String(gain)}`).toBe(true)
        expect(
          Math.abs(gain),
          `${preset.id} ${String(gain)}`
        ).toBeLessThanOrEqual(9)
      }
    }
  })

  it('all have continuous curves — no neighbouring band jumps over 3 dB', () => {
    for (const preset of presets) {
      for (let i = 1; i < preset.gainsDb.length; i += 1) {
        const jump = Math.abs(
          (preset.gainsDb[i] as number) - (preset.gainsDb[i - 1] as number)
        )
        expect(jump, `${preset.id} band ${String(i)}`).toBeLessThanOrEqual(3)
      }
    }
  })

  it('never boosts 31 Hz harder than 62 Hz', () => {
    // Sub-31 Hz is below almost all musical content and below what phone,
    // laptop and earbud drivers reproduce; gain spent there is excursion and
    // distortion, not bass. Every curve must put its weight at 62 Hz or above.
    for (const preset of presets) {
      const [sub, low] = preset.gainsDb as unknown as [number, number]
      expect(sub, preset.id).toBeLessThanOrEqual(Math.max(low, 0))
    }
  })

  it('keeps the small-speaker curve off the octaves those drivers cannot move', () => {
    const { gainsDb } = EQUALIZER_PRESETS.smallSpeakers
    // Weight is bought at 125-250 Hz, where a tiny driver actually works.
    expect(gainsDb[0]).toBe(0)
    expect(gainsDb[2]).toBeGreaterThan(gainsDb[1] as number)
  })

  it('does not scoop 2-4 kHz on Rock — that is where guitars bite', () => {
    const { gainsDb } = EQUALIZER_PRESETS.rock
    expect(gainsDb[6]).toBeGreaterThan(0)
    expect(gainsDb[7]).toBeGreaterThan(0)
    // …while the 500 Hz mud is cut, which is the actual rock problem.
    expect(gainsDb[4]).toBeLessThan(0)
  })

  it('does not lift 8 kHz on Spoken Word — that is the sibilance band', () => {
    const { gainsDb } = EQUALIZER_PRESETS.spokenWord
    expect(gainsDb[8]).toBeLessThanOrEqual(0)
    // Intelligibility comes from presence instead.
    expect(gainsDb[6]).toBeGreaterThan(2)
  })

  it('carries id and a human name, with ids matching their key', () => {
    for (const [key, preset] of Object.entries(EQUALIZER_PRESETS)) {
      expect(preset.id).toBe(key)
      expect(preset.name.length).toBeGreaterThan(0)
    }
  })

  it('is frozen, so a caller cannot corrupt a shared preset', () => {
    expect(Object.isFrozen(EQUALIZER_PRESETS)).toBe(true)
    expect(Object.isFrozen(EQUALIZER_PRESETS.rock)).toBe(true)
    expect(Object.isFrozen(EQUALIZER_PRESETS.rock.gainsDb)).toBe(true)
  })

  it('lists Flat first, then alphabetically by name', () => {
    expect(EQUALIZER_PRESET_LIST[0]?.id).toBe('flat')
    const names = EQUALIZER_PRESET_LIST.slice(1).map((p) => p.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')))
    expect(EQUALIZER_PRESET_LIST).toHaveLength(
      Object.keys(EQUALIZER_PRESETS).length
    )
  })

  it('keeps the reducers as exact mirrors of their boosters', () => {
    expect(EQUALIZER_PRESETS.bassReducer.gainsDb).toEqual(
      EQUALIZER_PRESETS.bassBoost.gainsDb.map((g) => (g === 0 ? 0 : -g))
    )
    expect(EQUALIZER_PRESETS.trebleReducer.gainsDb).toEqual(
      EQUALIZER_PRESETS.trebleBoost.gainsDb.map((g) => (g === 0 ? 0 : -g))
    )
  })
})

// ---------------------------------------------------------------------------
// Chain construction
// ---------------------------------------------------------------------------

describe('equalizerPresetChain', () => {
  it('compiles a flat preset to nothing at all', () => {
    expect(equalizerPresetChain(EQUALIZER_PRESETS.flat)).toEqual([])
    expect(
      compileAudioFilters(equalizerPresetChain(EQUALIZER_PRESETS.flat))
    ).toBe('')
  })

  it('omits bands sitting at 0 dB instead of emitting no-op filters', () => {
    // Bass Boost touches only the lowest four bands.
    const chain = equalizerPresetChain(EQUALIZER_PRESETS.bassBoost, {
      limiter: false,
    })
    const equalizers = chain.filter((f) => f.name === 'equalizer')
    expect(equalizers).toHaveLength(4)
    expect(equalizers.map((f) => f.options[0]?.[1])).toEqual([
      '31',
      '62',
      '125',
      '250',
    ])
  })

  it('pre-attenuates by the SUMMED peak, not the largest slider', () => {
    // Bass Boost's largest slider is +6 dB, but its neighbours overlap and add,
    // so the response actually peaks at +7.3 dB. Attenuating by 6 would clip.
    const preset = EQUALIZER_PRESETS.bassBoost
    expect(Math.max(...preset.gainsDb)).toBe(6)
    expect(peakResponseDb(preset.gainsDb)).toBeCloseTo(7.3, 1)
    expect(equalizerPresetChain(preset)[0]).toMatchObject({
      name: 'volume',
      options: [['volume', '-7.3dB']],
    })
  })

  it('leaves every preset peaking at 0 dB or below once pre-amped', () => {
    // The guarantee the whole pre-amp exists for: no built-in curve can push
    // the signal above full scale, however hard it boosts.
    for (const preset of EQUALIZER_PRESET_LIST) {
      const chain = equalizerPresetChain(preset)
      const volume = chain.find((f) => f.name === 'volume')
      const preampDb =
        volume === undefined
          ? 0
          : Number.parseFloat(String(volume.options[0]?.[1]).replace('dB', ''))
      const net = peakResponseDb(preset.gainsDb) + preampDb
      expect(net, preset.id).toBeLessThanOrEqual(0.05)
    }
  })

  it('adds no pre-amp to a preset that only cuts', () => {
    const chain = equalizerPresetChain(EQUALIZER_PRESETS.bassReducer)
    expect(chain[0]?.name).toBe('equalizer')
    expect(chain.some((f) => f.name === 'volume')).toBe(false)
  })

  it('ends with a limiter by default, and drops it on request', () => {
    expect(equalizerPresetChain(EQUALIZER_PRESETS.rock).at(-1)?.name).toBe(
      'alimiter'
    )
    expect(
      equalizerPresetChain(EQUALIZER_PRESETS.rock, { limiter: false }).at(-1)
        ?.name
    ).toBe('equalizer')
  })

  it('applies preampDb on top of the automatic headroom', () => {
    const chain = equalizerPresetChain(EQUALIZER_PRESETS.bassBoost, {
      preampDb: -3,
    })
    expect(chain[0]?.options[0]?.[1]).toBe('-10.3dB')
  })

  it('uses one-octave bells, matching the band spacing', () => {
    const chain = equalizerPresetChain(EQUALIZER_PRESETS.trebleBoost)
    const band = chain.find((f) => f.name === 'equalizer')
    expect(band?.options).toEqual([
      ['f', '1000'],
      ['t', 'o'],
      ['w', '1'],
      ['g', '0.5'],
    ])
  })

  it('honours a custom bandwidth', () => {
    const chain = equalizerPresetChain(EQUALIZER_PRESETS.trebleBoost, {
      bandwidthOctaves: 0.5,
    })
    const band = chain.find((f) => f.name === 'equalizer')
    expect(band?.options).toContainEqual(['w', '0.5'])
  })

  it('compiles every built-in preset to a valid af string', () => {
    for (const preset of EQUALIZER_PRESET_LIST) {
      expect(() =>
        compileAudioFilters(equalizerPresetChain(preset))
      ).not.toThrow()
    }
  })

  it('compiles Rock to the exact expected chain', () => {
    expect(
      compileAudioFilters(equalizerPresetChain(EQUALIZER_PRESETS.rock))
    ).toBe(
      'volume=volume=%6%-4.8dB,' +
        'equalizer=f=31:t=o:w=1:g=2,' +
        'equalizer=f=62:t=o:w=1:g=4,' +
        'equalizer=f=125:t=o:w=1:g=%3%2.5,' +
        'equalizer=f=500:t=o:w=1:g=-2,' +
        'equalizer=f=1000:t=o:w=1:g=-1,' +
        'equalizer=f=2000:t=o:w=1:g=1,' +
        'equalizer=f=4000:t=o:w=1:g=%3%2.5,' +
        'equalizer=f=8000:t=o:w=1:g=3,' +
        'equalizer=f=16000:t=o:w=1:g=2,' +
        'alimiter'
    )
  })

  it('rejects a preset with the wrong band count', () => {
    expectInvalidState(() => equalizerPresetChain({ gainsDb: [0, 0, 0] }))
  })
})

// ---------------------------------------------------------------------------
// Custom presets
// ---------------------------------------------------------------------------

describe('defineEqualizerPreset', () => {
  const gains = [1, 2, 3, 4, 5, 4, 3, 2, 1, 0]

  it('builds a usable, frozen preset', () => {
    const preset = defineEqualizerPreset('mine', 'My Curve', gains)
    expect(preset).toMatchObject({ id: 'mine', name: 'My Curve' })
    expect(preset.gainsDb).toEqual(gains)
    expect(Object.isFrozen(preset.gainsDb)).toBe(true)
  })

  it('copies the gains, so later mutation of the caller’s array is inert', () => {
    const mutable = [...gains]
    const preset = defineEqualizerPreset('mine', 'My Curve', mutable)
    mutable[0] = 99
    expect(preset.gainsDb[0]).toBe(1)
  })

  it('feeds straight into equalizerPresetChain', () => {
    const preset = defineEqualizerPreset('mine', 'My Curve', gains)
    expect(compileAudioFilters(equalizerPresetChain(preset))).toContain(
      'volume=volume='
    )
  })

  it('rejects the wrong band count', () => {
    expectInvalidState(() => defineEqualizerPreset('x', 'X', [0, 0, 0]))
  })

  it('rejects a non-finite gain', () => {
    expectInvalidState(() =>
      defineEqualizerPreset('x', 'X', [0, 0, 0, 0, Number.NaN, 0, 0, 0, 0, 0])
    )
  })

  it('rejects an empty id or name', () => {
    expectInvalidState(() => defineEqualizerPreset('', 'X', gains))
    expectInvalidState(() => defineEqualizerPreset('x', '', gains))
  })
})

// ---------------------------------------------------------------------------
// Player integration
// ---------------------------------------------------------------------------

describe('presets through the Player', () => {
  let client: FakeMpvClient

  beforeEach(() => {
    client = new FakeMpvClient()
  })

  it('applies and then clears a preset', async () => {
    const player = await Player.create({ createClient: () => client })
    player.setAudioFilters(equalizerPresetChain(EQUALIZER_PRESETS.jazz))
    expect(client.written.get(MpvProperty.audioFilters)).toContain(
      'equalizer=f=31'
    )

    player.setAudioFilters(equalizerPresetChain(EQUALIZER_PRESETS.flat))
    expect(client.written.get(MpvProperty.audioFilters)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Editable chains — the shape a slider needs
// ---------------------------------------------------------------------------

describe('equalizerPresetChain({ editable: true })', () => {
  const bassBoost = EQUALIZER_PRESETS.bassBoost

  it('labels every entry, which is how af-command addresses one', () => {
    const chain = equalizerPresetChain(bassBoost, { editable: true })
    expect(chain[0]).toMatchObject({
      name: 'volume',
      label: EQUALIZER_PREAMP_LABEL,
    })
    expect(chain.at(-1)).toMatchObject({
      name: 'alimiter',
      label: EQUALIZER_LIMITER_LABEL,
    })
    expect(chain.slice(1, -1).map((filter) => filter.label)).toEqual(
      EQUALIZER_BANDS.map((_, index) => equalizerBandLabel(index))
    )
  })

  it('emits every band, so the shape does not depend on the gains', () => {
    // Bass Boost has four non-zero bands; sparse mode compiles four entries,
    // editable mode compiles ten. That difference is the whole feature: a band
    // crossing 0 dB must not add or remove a filter mid-drag.
    expect(equalizerPresetChain(bassBoost)).toHaveLength(4 + 2)
    expect(equalizerPresetChain(bassBoost, { editable: true })).toHaveLength(
      EQUALIZER_BAND_COUNT + 2
    )
  })

  it('keeps the pre-amp even at 0 dB, for the same reason', () => {
    // A cut-only curve needs no headroom, so sparse mode omits the volume
    // entry entirely — and would have to add one the moment a band goes up.
    const cut = { gainsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, -6] }
    expect(equalizerPresetChain(cut)[0]).toMatchObject({ name: 'equalizer' })
    expect(equalizerPresetChain(cut, { editable: true })[0]).toMatchObject({
      name: 'volume',
      label: EQUALIZER_PREAMP_LABEL,
      options: [['volume', '0dB']],
    })
  })

  it('still compiles a flat curve to nothing at all', () => {
    expect(
      equalizerPresetChain(EQUALIZER_PRESETS.flat, { editable: true })
    ).toEqual([])
  })

  it('respects `limiter: false` and the bell width like any other chain', () => {
    const chain = equalizerPresetChain(bassBoost, {
      editable: true,
      limiter: false,
      bandwidthOctaves: 2,
    })
    expect(chain).toHaveLength(EQUALIZER_BAND_COUNT + 1)
    expect(compileAudioFilters(chain)).toContain('t=o:w=2')
  })

  it('makes any two curves differ by parameters alone', () => {
    // The property the whole design rests on: for a fixed band set, no pair of
    // curves is a different graph, so no drag can ever need a rebuild.
    const from = equalizerPresetChain(bassBoost, { editable: true })
    const to = equalizerPresetChain(EQUALIZER_PRESETS.vocalBoost, {
      editable: true,
    })
    const changes = diffAudioFilterParams(from, to)
    expect(changes).toBeDefined()
    expect(
      changes?.every((change) =>
        (change.filter.label ?? '').startsWith('rnmedia_eq_')
      )
    ).toBe(true)
  })

  it('rejects a band index that is not a band', () => {
    expectInvalidState(() => equalizerBandLabel(EQUALIZER_BAND_COUNT))
    expectInvalidState(() => equalizerBandLabel(-1))
  })
})
