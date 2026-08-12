import { beforeEach, describe, expect, it } from 'vitest'
import { PlayerErrorException } from '../errors'
import type { AudioFilter } from '../filters'
import {
  AudioFilters,
  GRAPHIC_EQUALIZER_BANDS,
  assertValidAudioFilters,
  compileAudioFilters,
  escapeAfParam,
} from '../filters'
import { Player } from '../player'
import { MpvProperty } from '../properties'
import { FakeMpvClient } from './fake-mpv-client'

/** Assert a thrown value is a typed player error with the expected code. */
function expectPlayerError(run: () => unknown, code: string): void {
  try {
    run()
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(PlayerErrorException)
    expect((thrown as PlayerErrorException).playerError.code).toBe(code)
    return
  }
  throw new Error(`expected a ${code} PlayerErrorException, nothing was thrown`)
}

// ---------------------------------------------------------------------------
// Escaping — mirrors mpv's own append_param/read_subparam rules
// ---------------------------------------------------------------------------

describe('escapeAfParam', () => {
  it('leaves NAMECH-only params verbatim', () => {
    expect(escapeAfParam('equalizer')).toBe('equalizer')
    expect(escapeAfParam('level_in')).toBe('level_in')
    expect(escapeAfParam('12b')).toBe('12b')
    expect(escapeAfParam('-6')).toBe('-6')
  })

  it('escapes anything outside NAMECH with %BYTECOUNT%, including "." ', () => {
    // mpv's NAMECH deliberately excludes '.', so every decimal is escaped.
    expect(escapeAfParam('0.4')).toBe('%3%0.4')
    expect(escapeAfParam('-6dB')).toBe('-6dB') // '-' and letters are NAMECH
    expect(escapeAfParam('entry(100,-3)')).toBe('%13%entry(100,-3)')
  })

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // mpv's prefix is strlen(), so a 1-char emoji is 4 bytes and 'é' is 2.
    expect(escapeAfParam('é')).toBe('%2%é')
    expect(escapeAfParam('🎧')).toBe('%4%🎧')
  })
})

// ---------------------------------------------------------------------------
// Chain compilation
// ---------------------------------------------------------------------------

describe('compileAudioFilters', () => {
  it('compiles an empty chain to the empty string', () => {
    expect(compileAudioFilters([])).toBe('')
  })

  it('compiles a bare filter with no options', () => {
    expect(compileAudioFilters([AudioFilters.crossfeed()])).toBe('crossfeed')
  })

  it('joins entries with "," and options with ":" in declaration order', () => {
    const af = compileAudioFilters([
      AudioFilters.equalizer({ frequency: 5000, width: 2, gain: -12 }),
      AudioFilters.crossfeed({ strength: 0.4 }),
    ])
    expect(af).toBe('equalizer=f=5000:t=q:w=2:g=-12,crossfeed=strength=%3%0.4')
  })

  it('emits mpv label and disable markers', () => {
    const filter: AudioFilter = {
      name: 'crossfeed',
      options: [],
      label: 'cf',
      enabled: false,
    }
    expect(compileAudioFilters([filter])).toBe('@cf:!crossfeed')
  })

  it('is deterministic — the same chain always compiles identically', () => {
    const build = (): string =>
      compileAudioFilters([
        AudioFilters.volume({ gainDb: -6 }),
        AudioFilters.bass({ frequency: 110, gain: 12 }),
        AudioFilters.limiter(),
      ])
    expect(build()).toBe(build())
    expect(build()).toBe('volume=volume=-6dB,bass=f=110:t=q:g=12,alimiter')
  })
})

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

describe('AudioFilters factories', () => {
  it('omits every option the caller did not pass, so ffmpeg defaults apply', () => {
    expect(compileAudioFilters([AudioFilters.compressor()])).toBe('acompressor')
    expect(compileAudioFilters([AudioFilters.loudnorm()])).toBe('loudnorm')
    expect(compileAudioFilters([AudioFilters.dynamicNormalizer()])).toBe(
      'dynaudnorm'
    )
  })

  it('maps enum-valued options to ffmpeg constant names', () => {
    expect(
      compileAudioFilters([
        AudioFilters.compressor({
          mode: 'upward',
          link: 'maximum',
          detection: 'peak',
        }),
      ])
    ).toBe('acompressor=mode=upward:link=maximum:detection=peak')
  })

  it('writes volume gain in dB, which is what af_volume parses', () => {
    expect(compileAudioFilters([AudioFilters.volume({ gainDb: -6 })])).toBe(
      'volume=volume=-6dB'
    )
  })

  it('writes booleans as ffmpeg 0/1', () => {
    expect(
      compileAudioFilters([
        AudioFilters.loudnorm({ linear: false, dualMono: true }),
      ])
    ).toBe('loudnorm=linear=0:dual_mono=1')
  })

  describe('graphicEqualizer', () => {
    const flat = new Array<number>(18).fill(0)

    it('has one band gain per documented centre frequency', () => {
      expect(GRAPHIC_EQUALIZER_BANDS).toHaveLength(18)
      expect(GRAPHIC_EQUALIZER_BANDS[0]).toBe(65)
      expect(GRAPHIC_EQUALIZER_BANDS[17]).toBe(20000)
    })

    it('converts dB to the linear gain superequalizer actually takes', () => {
      // 0 dB is unity, which is ffmpeg's default of 1.
      const af = compileAudioFilters([
        AudioFilters.graphicEqualizer({ gainsDb: flat }),
      ])
      expect(af).toBe(
        `superequalizer=${GRAPHIC_EQUALIZER_BANDS.map(
          (_band, index) => `${String(index + 1)}b=1`
        ).join(':')}`
      )
    })

    it('converts +6 dB to ~2x and -6 dB to ~0.5x linear', () => {
      const gains = [...flat]
      gains[0] = 6
      gains[17] = -6
      const filter = AudioFilters.graphicEqualizer({ gainsDb: gains })
      expect(filter.options[0]).toEqual(['1b', '1.995262'])
      expect(filter.options[17]).toEqual(['18b', '0.501187'])
    })

    it('rejects a band count other than 18', () => {
      expectPlayerError(
        () => AudioFilters.graphicEqualizer({ gainsDb: [0, 0, 0] }),
        'invalid-state'
      )
    })

    it("rejects gains above ffmpeg's 20x linear cap (+26.02 dB)", () => {
      const gains = [...flat]
      gains[3] = 27
      expectPlayerError(
        () => AudioFilters.graphicEqualizer({ gainsDb: gains }),
        'invalid-state'
      )
    })
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validation', () => {
  it('rejects out-of-range values before mpv ever sees them', () => {
    expectPlayerError(
      () => AudioFilters.compressor({ ratio: 40 }),
      'invalid-state'
    )
    expectPlayerError(
      () => AudioFilters.crossfeed({ strength: 1.5 }),
      'invalid-state'
    )
    expectPlayerError(
      () => AudioFilters.loudnorm({ integrated: -100 }),
      'invalid-state'
    )
    expectPlayerError(() => AudioFilters.limiter({ limit: 2 }), 'invalid-state')
  })

  it('rejects non-finite numbers', () => {
    expectPlayerError(
      () => AudioFilters.equalizer({ frequency: Number.NaN, gain: 0 }),
      'invalid-state'
    )
    expectPlayerError(
      () => AudioFilters.volume({ gainDb: Number.POSITIVE_INFINITY }),
      'invalid-state'
    )
  })

  it("rejects dynaudnorm's even Gaussian window (ffmpeg requires odd)", () => {
    expectPlayerError(
      () => AudioFilters.dynamicNormalizer({ gaussSize: 30 }),
      'invalid-state'
    )
    expect(() =>
      AudioFilters.dynamicNormalizer({ gaussSize: 31 })
    ).not.toThrow()
  })

  it('rejects an unknown biquad width type', () => {
    expectPlayerError(
      () =>
        AudioFilters.equalizer({
          frequency: 1000,
          gain: 3,

          widthType: 'z' as any,
        }),
      'invalid-state'
    )
  })

  it("rejects filter names outside mpv's NAMECH alphabet", () => {
    expectPlayerError(
      () => assertValidAudioFilters([{ name: 'equalizer=x', options: [] }]),
      'invalid-state'
    )
    expectPlayerError(
      () => assertValidAudioFilters([{ name: '', options: [] }]),
      'invalid-state'
    )
    expectPlayerError(() => AudioFilters.custom('a,b'), 'invalid-state')
  })

  it('rejects a malformed option pair', () => {
    expectPlayerError(
      () =>
        assertValidAudioFilters([
          { name: 'crossfeed', options: [['strength'] as any] },
        ]),
      'invalid-state'
    )
  })
})

// ---------------------------------------------------------------------------
// custom() escape hatch
// ---------------------------------------------------------------------------

describe('AudioFilters.custom', () => {
  it('reaches filters this module has no typed wrapper for', () => {
    const af = compileAudioFilters([
      AudioFilters.custom('firequalizer', {
        gain_entry: 'entry(100,-3);entry(1000,0)',
      }),
    ])
    expect(af).toBe('firequalizer=gain_entry=%27%entry(100,-3);entry(1000,0)')
  })

  it('stringifies numbers and booleans the way ffmpeg parses them', () => {
    expect(
      compileAudioFilters([
        AudioFilters.custom('anequalizer', { curves: true, params: 2 }),
      ])
    ).toBe('anequalizer=curves=1:params=2')
  })

  it('round-trips through mpv-style escaping for values with separators', () => {
    // ':' and ',' are mpv sub-option separators; %n% is the only way through.
    const filter = AudioFilters.custom('aformat', {
      sample_fmts: 'fltp,dblp',
    })
    expect(compileAudioFilters([filter])).toBe(
      'aformat=sample_fmts=%9%fltp,dblp'
    )
  })
})

// ---------------------------------------------------------------------------
// Player integration
// ---------------------------------------------------------------------------

describe('Player audio filters', () => {
  let client: FakeMpvClient

  const createPlayer = async (): Promise<Player> =>
    Player.create({ createClient: () => client })

  beforeEach(() => {
    client = new FakeMpvClient()
  })

  it('writes the compiled chain to mpv’s `af` property', async () => {
    const player = await createPlayer()
    player.setAudioFilters([
      AudioFilters.bass({ frequency: 110, gain: 12 }),
      AudioFilters.limiter(),
    ])
    expect(client.written.get(MpvProperty.audioFilters)).toBe(
      'bass=f=110:t=q:g=12,alimiter'
    )
  })

  it('clears with the empty string', async () => {
    const player = await createPlayer()
    player.setAudioFilters([AudioFilters.crossfeed()])
    player.clearAudioFilters()
    expect(client.written.get(MpvProperty.audioFilters)).toBe('')
  })

  it('reads the chain back from mpv, not from a local cache', async () => {
    const player = await createPlayer()
    // What mpv reports is the source of truth, including a chain set through
    // the raw escape hatch.
    client.readable.set(MpvProperty.audioFilters, 'anull')
    expect(player.getAudioFilters()).toBe('anull')
  })

  it('reports no filters as the empty string, not undefined', async () => {
    const player = await createPlayer()
    expect(player.getAudioFilters()).toBe('')
  })

  it('lets a raw `af` write win — the escape hatch is not shadowed', async () => {
    const player = await createPlayer()
    player.setAudioFilters([AudioFilters.crossfeed()])
    player.setPropertyString(MpvProperty.audioFilters, 'anull,crossfeed')
    expect(client.written.get(MpvProperty.audioFilters)).toBe('anull,crossfeed')
  })

  it('surfaces an mpv rejection as a typed error, which is how an unavailable filter shows up', async () => {
    const player = await createPlayer()
    // mpv answers a bad `af` with MPV_ERROR_PROPERTY_ERROR (-11); an unknown
    // filter name (i.e. one not compiled into this platform's libmpv) takes
    // exactly this path — "Option af: superequalizer doesn't exist."
    client.setPropertyRejection = '[mpv:-11] mpv_set_property_string("af")'
    try {
      player.setAudioFilters([
        AudioFilters.graphicEqualizer({
          gainsDb: new Array<number>(18).fill(0),
        }),
      ])
      throw new Error('expected setAudioFilters to throw')
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(PlayerErrorException)
      const error = (thrown as PlayerErrorException).playerError
      expect(error.code).toBe('mpv')
      expect(error).toMatchObject({ errno: -11 })
    }
  })

  it('validates before writing, so a bad chain never touches mpv', async () => {
    const player = await createPlayer()
    expectPlayerError(
      () => player.setAudioFilters([AudioFilters.compressor({ ratio: 99 })]),
      'invalid-state'
    )
    expect(client.written.has(MpvProperty.audioFilters)).toBe(false)
  })

  it('refuses to touch filters after destroy()', async () => {
    const player = await createPlayer()
    player.destroy()
    expectPlayerError(() => player.setAudioFilters([]), 'disposed')
    expectPlayerError(() => player.clearAudioFilters(), 'disposed')
    expectPlayerError(() => player.getAudioFilters(), 'disposed')
  })
})
