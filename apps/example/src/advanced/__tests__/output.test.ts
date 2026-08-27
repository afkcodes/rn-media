/**
 * Regression tests for the ReplayGain UI→engine mapping (task #43).
 *
 * The owner-reported bug: enable "Track gain", switch back to "Off", and the
 * loudness never returns to the pre-ReplayGain level. Root cause was this
 * module writing `fallback: -6` for every mode — and mpv applies
 * `replaygain-fallback` whenever the tag branch is inactive, *including*
 * `replaygain=no` (mpv 0.41.0 `player/audio.c`, `compute_replaygain()`: the
 * fallback branch is the `else` of `if (opts->rgain_mode && rg)`). So "Off"
 * left −6 dB applied to every track. The fix writes `fallback: 0` with
 * `mode: 'no'`; these tests pin the exact property payloads.
 */
import { describe, expect, it } from 'vitest'
import type { Player, ReplayGainOptions } from '@afkcodes/timbre-player'
import { OutputOptions, replayGainOptionsFor } from '../output'

/** A `Player` stub that records `setReplayGain` payloads, in order. */
function stubPlayer(written: ReplayGainOptions[], fail = false): Player {
  const stub = {
    setReplayGain(options: ReplayGainOptions): void {
      if (fail) throw new Error('mpv rejected the write')
      written.push(options)
    },
  }
  return stub as unknown as Player
}

describe('replayGainOptionsFor', () => {
  it('gives track and album modes the −6 dB untagged fallback', () => {
    expect(replayGainOptionsFor('track')).toEqual({
      mode: 'track',
      preamp: 0,
      fallback: -6,
    })
    expect(replayGainOptionsFor('album')).toEqual({
      mode: 'album',
      preamp: 0,
      fallback: -6,
    })
  })

  it("zeroes the fallback when the mode is 'no' — task #43", () => {
    // mpv applies `replaygain-fallback` even with `replaygain=no`, so a
    // non-zero fallback here would keep −6 dB on every track after "Off".
    expect(replayGainOptionsFor('no')).toEqual({
      mode: 'no',
      preamp: 0,
      fallback: 0,
    })
  })
})

describe('OutputOptions.setReplayGain', () => {
  it('returns to unity gain when toggled on and back off', () => {
    const written: ReplayGainOptions[] = []
    let changes = 0
    const output = new OutputOptions({
      player: () => stubPlayer(written),
      onChange: () => {
        changes += 1
      },
      onError: () => {
        throw new Error('unexpected onError')
      },
    })

    output.setReplayGain('track')
    output.setReplayGain('no')

    expect(written).toEqual([
      { mode: 'track', preamp: 0, fallback: -6 },
      { mode: 'no', preamp: 0, fallback: 0 },
    ])
    expect(output.replayGain).toBe('no')
    expect(changes).toBe(2)
  })

  it('does not record a mode the engine rejected', () => {
    const written: ReplayGainOptions[] = []
    const errors: unknown[] = []
    const output = new OutputOptions({
      player: () => stubPlayer(written, true),
      onChange: () => {
        throw new Error('unexpected onChange')
      },
      onError: (cause) => {
        errors.push(cause)
      },
    })

    output.setReplayGain('track')

    expect(output.replayGain).toBe('no')
    expect(written).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it('is a no-op before the player exists', () => {
    const output = new OutputOptions({
      player: () => undefined,
      onChange: () => {
        throw new Error('unexpected onChange')
      },
      onError: () => {
        throw new Error('unexpected onError')
      },
    })
    output.setReplayGain('album')
    expect(output.replayGain).toBe('no')
  })
})
