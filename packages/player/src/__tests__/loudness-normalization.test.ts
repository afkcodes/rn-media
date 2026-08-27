/**
 * `Player.setLoudnessNormalization` — the managed `af` entry.
 *
 * The contract under test is *coexistence*: the toggle owns exactly one
 * labelled entry at the tail of the chain, `setAudioFilters` owns everything
 * before it, and neither call may clobber the other's half. The expected
 * strings are asserted verbatim because the compiled `af` value is public
 * contract (mpv's own serialisation — see `compileAudioFilters`).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { PlayerErrorException } from '../errors'
import { AudioFilters } from '../filters'
import {
  DEFAULT_LOUDNESS_TARGET_LUFS,
  LOUDNESS_NORMALIZATION_LABEL,
  Player,
} from '../player'
import { MpvProperty } from '../properties'
import { FakeMpvClient } from './fake-mpv-client'

let client: FakeMpvClient

async function createPlayer(): Promise<Player> {
  return Player.create({ createClient: () => client })
}

/** The last `af` string written to mpv. */
function af(): string | undefined {
  const value = client.written.get(MpvProperty.audioFilters)
  return typeof value === 'string' ? value : undefined
}

/** A small user chain whose compiled form is easy to eyeball. */
const USER_CHAIN = [
  AudioFilters.volume({ gainDb: -6 }),
  AudioFilters.bass({ frequency: 110, gain: 6 }),
] as const

const USER_CHAIN_AF = 'volume=volume=-6dB,bass=f=110:t=q:g=6'

const MANAGED_DEFAULT = `@${LOUDNESS_NORMALIZATION_LABEL}:loudnorm=I=-16`

beforeEach(() => {
  client = new FakeMpvClient()
})

describe('setLoudnessNormalization', () => {
  it('writes one labelled loudnorm entry with the -16 LUFS default', async () => {
    const player = await createPlayer()
    player.setLoudnessNormalization(true)
    expect(af()).toBe(MANAGED_DEFAULT)
    // The default the string encodes is the exported constant, so an app can
    // show "target −16 LUFS" without parsing anything.
    expect(DEFAULT_LOUDNESS_TARGET_LUFS).toBe(-16)
  })

  it('maps every typed option onto loudnorm sub-options, in a stable order', async () => {
    const player = await createPlayer()
    player.setLoudnessNormalization(true, {
      targetLufs: -18,
      loudnessRange: 9,
      truePeakDb: -1,
      dualMono: true,
    })
    expect(af()).toBe(
      `@${LOUDNESS_NORMALIZATION_LABEL}:loudnorm=I=-18:LRA=9:TP=-1:dual_mono=1`
    )
  })

  it('appends the managed entry after an existing user chain', async () => {
    const player = await createPlayer()
    player.setAudioFilters([...USER_CHAIN])
    player.setLoudnessNormalization(true)
    // Tail position is contract: the normaliser must hear the EQ's output.
    expect(af()).toBe(`${USER_CHAIN_AF},${MANAGED_DEFAULT}`)
  })

  it('survives a later setAudioFilters — the calls do not clobber each other', async () => {
    const player = await createPlayer()
    player.setLoudnessNormalization(true)
    player.setAudioFilters([...USER_CHAIN])
    expect(af()).toBe(`${USER_CHAIN_AF},${MANAGED_DEFAULT}`)
  })

  it('replaces, not stacks, the managed entry when re-enabled with new options', async () => {
    const player = await createPlayer()
    player.setLoudnessNormalization(true)
    player.setLoudnessNormalization(true, { targetLufs: -14 })
    expect(af()).toBe(`@${LOUDNESS_NORMALIZATION_LABEL}:loudnorm=I=-14`)
  })

  it('removes only the managed entry when disabled', async () => {
    const player = await createPlayer()
    player.setAudioFilters([...USER_CHAIN])
    player.setLoudnessNormalization(true)
    player.setLoudnessNormalization(false)
    expect(af()).toBe(USER_CHAIN_AF)
  })

  it('keeps the managed entry across clearAudioFilters', async () => {
    const player = await createPlayer()
    player.setAudioFilters([...USER_CHAIN])
    player.setLoudnessNormalization(true)
    player.clearAudioFilters()
    expect(af()).toBe(MANAGED_DEFAULT)
  })

  it('compiles to the empty chain when both halves are empty', async () => {
    const player = await createPlayer()
    player.setAudioFilters([...USER_CHAIN])
    player.setLoudnessNormalization(true)
    player.setLoudnessNormalization(false)
    player.clearAudioFilters()
    expect(af()).toBe('')
  })

  it('rejects user filters carrying the reserved label', async () => {
    const player = await createPlayer()
    expect(() =>
      player.setAudioFilters([
        {
          name: 'loudnorm',
          options: [],
          label: LOUDNESS_NORMALIZATION_LABEL,
        },
      ])
    ).toThrowError(PlayerErrorException)
    // And the rejection wrote nothing: the property is untouched.
    expect(af()).toBeUndefined()
  })

  it('validates options against ffmpeg loudnorm ranges before any write', async () => {
    const player = await createPlayer()
    // I is -70…-5 and TP is -9…0 in ffmpeg 8.1.2 (af_loudnorm.c:107,111).
    expect(() =>
      player.setLoudnessNormalization(true, { targetLufs: -4 })
    ).toThrowError(PlayerErrorException)
    expect(() =>
      player.setLoudnessNormalization(true, { truePeakDb: 1 })
    ).toThrowError(PlayerErrorException)
    expect(af()).toBeUndefined()
    expect(player.getLoudnessNormalization()).toBeUndefined()
  })

  it('does not commit bookkeeping when mpv rejects the write', async () => {
    const player = await createPlayer()
    client.setPropertyRejection = '[mpv:-11] error accessing property'
    expect(() => player.setLoudnessNormalization(true)).toThrowError(
      PlayerErrorException
    )
    client.setPropertyRejection = undefined
    // The failed enable left the toggle off, so an unrelated later write does
    // not resurrect a chain mpv never accepted.
    expect(player.getLoudnessNormalization()).toBeUndefined()
    player.setAudioFilters([...USER_CHAIN])
    expect(af()).toBe(USER_CHAIN_AF)
  })

  it('does not commit a user chain mpv rejected', async () => {
    const player = await createPlayer()
    player.setLoudnessNormalization(true)
    client.setPropertyRejection = '[mpv:-11] error accessing property'
    expect(() => player.setAudioFilters([...USER_CHAIN])).toThrowError(
      PlayerErrorException
    )
    client.setPropertyRejection = undefined
    player.setLoudnessNormalization(true, { targetLufs: -14 })
    // The rejected user chain is absent; the managed entry stands alone.
    expect(af()).toBe(`@${LOUDNESS_NORMALIZATION_LABEL}:loudnorm=I=-14`)
  })

  it('reports the resolved options while on, and undefined while off', async () => {
    const player = await createPlayer()
    expect(player.getLoudnessNormalization()).toBeUndefined()
    player.setLoudnessNormalization(true, { truePeakDb: -1 })
    expect(player.getLoudnessNormalization()).toEqual({
      targetLufs: DEFAULT_LOUDNESS_TARGET_LUFS,
      truePeakDb: -1,
    })
    player.setLoudnessNormalization(false)
    expect(player.getLoudnessNormalization()).toBeUndefined()
  })

  it('ignores options when disabling, as documented', async () => {
    const player = await createPlayer()
    player.setLoudnessNormalization(false, { targetLufs: -14 })
    expect(af()).toBe('')
    expect(player.getLoudnessNormalization()).toBeUndefined()
  })

  it('throws the disposed error after destroy', async () => {
    const player = await createPlayer()
    player.destroy()
    expect(() => player.setLoudnessNormalization(true)).toThrowError(
      PlayerErrorException
    )
    expect(() => player.getLoudnessNormalization()).toThrowError(
      PlayerErrorException
    )
  })
})

/**
 * ReplayGain and loudness normalization level the same thing by different means
 * and their gains *stack*. The README's own "Common pitfalls" carried the
 * symptom — "everything is 3 dB too loud (or quiet)" — with "pick one" as the
 * remedy, which made the defect the user's problem. It is the API's: these two
 * switches are mutually exclusive, and switching one on switches the other off.
 */
describe('ReplayGain ⇄ loudness normalization are mutually exclusive', () => {
  /** The last `replaygain` value written to mpv. */
  function replayGain(): string | undefined {
    const value = client.written.get(MpvProperty.replayGain)
    return typeof value === 'string' ? value : undefined
  }

  /** How many times `replaygain` was written. */
  function replayGainWrites(): number {
    return client.propertyWrites.filter(
      (name) => name === MpvProperty.replayGain
    ).length
  }

  it('turning normalization on switches ReplayGain off, and says so', async () => {
    const player = await createPlayer()
    player.setReplayGain({ mode: 'album' })
    expect(player.getReplayGainMode()).toBe('album')

    player.setLoudnessNormalization(true)

    expect(replayGain()).toBe('no')
    expect(player.getReplayGainMode()).toBe('no')
    expect(player.getLoudnessNormalization()).toBeDefined()
    expect(af()).toBe(MANAGED_DEFAULT)
  })

  it('enabling ReplayGain removes the managed loudnorm entry', async () => {
    const player = await createPlayer()
    player.setAudioFilters([...USER_CHAIN])
    player.setLoudnessNormalization(true)
    expect(af()).toBe(`${USER_CHAIN_AF},${MANAGED_DEFAULT}`)

    player.setReplayGain({ mode: 'track' })

    expect(player.getLoudnessNormalization()).toBeUndefined()
    expect(player.getReplayGainMode()).toBe('track')
    // The user half is untouched — the exclusion removes one managed entry,
    // not the chain.
    expect(af()).toBe(USER_CHAIN_AF)
  })

  it('`mode: no` is not "enabling", so it leaves the normalizer alone', async () => {
    const player = await createPlayer()
    player.setLoudnessNormalization(true)
    player.setReplayGain({ mode: 'no', fallback: 0 })
    expect(player.getLoudnessNormalization()).toBeDefined()
    expect(af()).toBe(MANAGED_DEFAULT)
  })

  it('costs no extra bridge traffic when there is nothing to switch off', async () => {
    const player = await createPlayer()
    const before = replayGainWrites()
    // ReplayGain was never enabled, so the toggle must not write `replaygain`
    // "just in case" — the whole point of tracking both states in TypeScript.
    player.setLoudnessNormalization(true)
    expect(replayGainWrites()).toBe(before)

    const afWrites = client.propertyWrites.filter(
      (name) => name === MpvProperty.audioFilters
    ).length
    // …and symmetrically: normalization is off now? No — it is on, so this one
    // legitimately rewrites `af` exactly once.
    player.setReplayGain({ mode: 'album' })
    expect(
      client.propertyWrites.filter((name) => name === MpvProperty.audioFilters)
        .length
    ).toBe(afWrites + 1)

    // With both off, a further ReplayGain change touches `af` not at all.
    const settled = client.propertyWrites.filter(
      (name) => name === MpvProperty.audioFilters
    ).length
    player.setReplayGain({ mode: 'track' })
    expect(
      client.propertyWrites.filter((name) => name === MpvProperty.audioFilters)
        .length
    ).toBe(settled)
  })

  it('seeds the tracked mode from the create option', async () => {
    const player = await Player.create({
      createClient: () => client,
      replayGain: { mode: 'album', fallback: -6 },
    })
    expect(player.getReplayGainMode()).toBe('album')
    // …and the exclusion sees it, even though nothing ever called
    // `setReplayGain`: the option was written into mpv's init options.
    player.setLoudnessNormalization(true)
    expect(client.written.get(MpvProperty.replayGain)).toBe('no')
    expect(player.getReplayGainMode()).toBe('no')
  })

  it('throws the disposed error after destroy', async () => {
    const player = await createPlayer()
    player.destroy()
    expect(() => player.getReplayGainMode()).toThrowError(PlayerErrorException)
  })
})
