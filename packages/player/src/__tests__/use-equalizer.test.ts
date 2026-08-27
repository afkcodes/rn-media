import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EQUALIZER_PRESETS } from '../equalizer-presets'
import type { EqualizerStorage } from '../equalizer-storage'
import {
  DEFAULT_EQUALIZER_STORAGE_KEY,
  serializeEqualizerSettings,
} from '../equalizer-storage'
import { AudioFilters } from '../filters'
import type { UseEqualizerOptions } from '../hooks/useEqualizer'
import {
  DEFAULT_EQUALIZER_GAIN_RANGE_DB,
  useEqualizer,
} from '../hooks/useEqualizer'
import type { Player } from '../player'
import { Player as PlayerClass } from '../player'
import { MpvProperty } from '../properties'
import { FakeMpvClient } from './fake-mpv-client'

let client: FakeMpvClient
let player: Player

/** What mpv currently has in `af`. */
function af(): string {
  return String(client.written.get(MpvProperty.audioFilters) ?? '')
}

/** Render the hook against the live player, returning the testing handle. */
function mount(options?: UseEqualizerOptions) {
  return renderHook(
    (props: UseEqualizerOptions | undefined) => useEqualizer(player, props),
    { initialProps: options }
  )
}

beforeEach(async () => {
  client = new FakeMpvClient()
  player = await PlayerClass.create({ createClient: () => client })
})

afterEach(() => {
  player.destroy()
  vi.restoreAllMocks()
})

describe('useEqualizer — the curve', () => {
  it('starts flat, and a flat curve costs no filters at all', () => {
    const { result } = mount()

    expect(result.current.enabled).toBe(true)
    expect(result.current.gainsDb).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(result.current.bands).toHaveLength(10)
    expect(result.current.bands[0]).toEqual({ frequency: 31, gainDb: 0 })
    expect(result.current.bands[9]).toEqual({ frequency: 16000, gainDb: 0 })
    expect(af()).toBe('')
  })

  it('is hydrated immediately when no storage is configured', () => {
    expect(mount().result.current.hydrated).toBe(true)
  })

  it('applies a preset as a compiled chain with a headroom pre-amp', () => {
    const { result } = mount()

    act(() => {
      result.current.applyPreset('rock')
    })

    expect(result.current.gainsDb).toEqual(EQUALIZER_PRESETS.rock.gainsDb)
    // The pre-amp comes first, then one biquad per band — *every* band, even
    // the ones at 0 dB, because the hook compiles an editable chain whose
    // shape does not move when a gain does — then the inter-sample limiter.
    // Every entry is labelled, which is how `af-command` addresses it.
    expect(af()).toMatch(/^@rnmedia_eq_preamp:volume=/)
    expect(af()).toContain('@rnmedia_eq_31:equalizer=')
    expect(af()).toContain('@rnmedia_eq_250:equalizer=f=250:t=o:w=1:g=0')
    expect(af()).toContain('@rnmedia_eq_limiter:alimiter')
    expect(af().split(',')).toHaveLength(12)
  })

  it('accepts a preset object as well as an id', () => {
    const { result } = mount()
    act(() => {
      result.current.applyPreset(EQUALIZER_PRESETS.jazz)
    })
    expect(result.current.preset?.id).toBe('jazz')
  })

  it('rejects a preset id it does not know', () => {
    const { result } = mount()
    expect(() => {
      result.current.applyPreset('nope')
    }).toThrow(/not a known preset/u)
  })

  it('honours an initialPreset on mount', () => {
    const { result } = mount({ initialPreset: 'bassBoost' })
    expect(result.current.preset?.id).toBe('bassBoost')
    expect(af()).toContain('equalizer=')
  })

  it('moves one band and leaves the rest alone', () => {
    const { result } = mount()
    act(() => {
      result.current.setBandGain(2, 4.5)
    })
    expect(result.current.gainsDb).toEqual([0, 0, 4.5, 0, 0, 0, 0, 0, 0, 0])
    expect(result.current.bands[2]).toEqual({ frequency: 125, gainDb: 4.5 })
  })

  it('clamps a band gain to the range instead of throwing mid-drag', () => {
    const { result } = mount()
    act(() => {
      result.current.setBandGain(0, 99)
    })
    expect(result.current.gainsDb[0]).toBe(DEFAULT_EQUALIZER_GAIN_RANGE_DB.max)
    act(() => {
      result.current.setBandGain(0, -99)
    })
    expect(result.current.gainsDb[0]).toBe(DEFAULT_EQUALIZER_GAIN_RANGE_DB.min)
  })

  it('honours a custom gain range', () => {
    const { result } = mount({ gainRangeDb: { min: -6, max: 6 } })
    expect(result.current.gainRangeDb).toEqual({ min: -6, max: 6 })
    act(() => {
      result.current.setBandGain(0, 12)
    })
    expect(result.current.gainsDb[0]).toBe(6)
  })

  it('rejects a band index that is not a band, and a non-finite gain', () => {
    const { result } = mount()
    expect(() => {
      result.current.setBandGain(10, 1)
    }).toThrow(/index must be an integer/u)
    expect(() => {
      result.current.setBandGain(1.5, 1)
    }).toThrow(/index must be an integer/u)
    expect(() => {
      result.current.setBandGain(0, Number.NaN)
    }).toThrow(/finite number/u)
  })

  it('replaces the whole curve, and rejects a wrong-length one', () => {
    const { result } = mount()
    act(() => {
      result.current.setBandGains([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    })
    expect(result.current.gainsDb).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(() => {
      result.current.setBandGains([1, 2])
    }).toThrow(/exactly 10 entries/u)
  })

  it('resets to flat, which removes the EQ from the signal path', () => {
    const { result } = mount({ initialPreset: 'rock' })
    expect(af()).not.toBe('')
    act(() => {
      result.current.reset()
    })
    expect(result.current.gainsDb).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(af()).toBe('')
  })
})

describe('useEqualizer — preset identity', () => {
  it('derives the current preset from the gains, both ways', () => {
    const { result } = mount()
    expect(result.current.preset?.id).toBe('flat')

    act(() => {
      result.current.applyPreset('rock')
    })
    expect(result.current.preset?.id).toBe('rock')

    // Edited away from the curve: no preset is a lie a chip could show.
    act(() => {
      result.current.setBandGain(0, 11)
    })
    expect(result.current.preset).toBeUndefined()

    // …and back onto it.
    act(() => {
      result.current.setBandGain(0, EQUALIZER_PRESETS.rock.gainsDb[0] as number)
    })
    expect(result.current.preset?.id).toBe('rock')
  })

  it('lists the built-ins in picker order', () => {
    const { result } = mount()
    expect(result.current.presets[0]?.id).toBe('flat')
    expect(result.current.savedPresets).toEqual([])
  })
})

describe('useEqualizer — saved presets', () => {
  it('saves the current curve, selects it by id, and deletes it', () => {
    const { result } = mount()

    act(() => {
      result.current.setBandGains([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    })
    let saved
    act(() => {
      saved = result.current.savePreset('  Late night  ')
    })
    expect(saved).toMatchObject({ id: 'custom:Late night', name: 'Late night' })
    expect(result.current.savedPresets).toHaveLength(1)
    expect(result.current.presets.at(-1)?.name).toBe('Late night')
    // Derived selection picks up the saved curve immediately.
    expect(result.current.preset?.id).toBe('custom:Late night')

    act(() => {
      result.current.applyPreset('flat')
    })
    act(() => {
      result.current.applyPreset('custom:Late night')
    })
    expect(result.current.gainsDb).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    act(() => {
      result.current.deletePreset('custom:Late night')
    })
    expect(result.current.savedPresets).toEqual([])
    // Deleting the applied curve does not change the sound.
    expect(result.current.gainsDb).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('replaces a saved curve of the same name rather than duplicating it', () => {
    const { result } = mount()
    act(() => {
      result.current.savePreset('Mine')
    })
    act(() => {
      result.current.setBandGain(0, 3)
    })
    act(() => {
      result.current.savePreset('Mine')
    })
    expect(result.current.savedPresets).toHaveLength(1)
    expect(result.current.savedPresets[0]?.gainsDb[0]).toBe(3)
  })

  it('refuses an empty name and refuses to delete a built-in', () => {
    const { result } = mount()
    expect(() => result.current.savePreset('   ')).toThrow(/non-empty/u)
    expect(() => {
      result.current.deletePreset('rock')
    }).toThrow(/built-in preset/u)
    // An unknown saved id is an idempotent no-op, not an error.
    expect(() => {
      result.current.deletePreset('custom:gone')
    }).not.toThrow()
  })
})

describe('useEqualizer — the rest of the chain', () => {
  const crossfeed = AudioFilters.crossfeed({ strength: 0.6 })

  it('keeps the app filters after the EQ bands', () => {
    const { result } = mount({ extraFilters: [crossfeed] })
    expect(af()).toContain('crossfeed')

    act(() => {
      result.current.applyPreset('rock')
    })
    // Equalised first, then the app's own chain.
    expect(af().indexOf('equalizer=')).toBeLessThan(af().indexOf('crossfeed'))
  })

  it('switching off removes only the EQ', () => {
    const { result } = mount({ extraFilters: [crossfeed] })
    act(() => {
      result.current.applyPreset('rock')
    })
    act(() => {
      result.current.setEnabled(false)
    })
    expect(result.current.enabled).toBe(false)
    expect(af()).not.toContain('equalizer=')
    expect(af()).toContain('crossfeed')
    // The curve survives the toggle.
    expect(result.current.gainsDb).toEqual(EQUALIZER_PRESETS.rock.gainsDb)

    act(() => {
      result.current.setEnabled(true)
    })
    expect(af()).toContain('equalizer=')
  })

  it('leaves the managed loudness-normalization entry alone', () => {
    const { result } = mount()
    player.setLoudnessNormalization(true)
    expect(af()).toContain('rnmedia_loudnorm')

    act(() => {
      result.current.applyPreset('rock')
    })
    expect(af()).toContain('equalizer=')
    expect(af()).toContain('rnmedia_loudnorm')
  })

  it('honours chain options', () => {
    const { result } = mount({ chain: { limiter: false } })
    act(() => {
      result.current.applyPreset('rock')
    })
    expect(af()).not.toContain('alimiter')
  })
})

describe('useEqualizer — writes', () => {
  it('writes nothing to mpv when a re-render produces the same chain', () => {
    const { result, rerender } = mount({ extraFilters: [] })
    act(() => {
      result.current.applyPreset('rock')
    })
    const writes = vi.spyOn(client, 'setPropertyString')

    // Fresh literals every time — exactly what a parent re-render produces.
    rerender({ extraFilters: [] })
    rerender({ extraFilters: [], chain: {} })

    expect(writes).not.toHaveBeenCalled()
  })

  it('reports a rejected chain instead of throwing, and keeps the UI state', () => {
    const { result } = mount()
    client.setPropertyRejection =
      '[mpv:-11] mpv_set_property("af"): property could not be set'

    act(() => {
      result.current.applyPreset('rock')
    })

    expect(result.current.error?.code).toBe('mpv')
    // What the user asked for, not what mpv accepted — `getAudioFilters()` is
    // the read-back for that.
    expect(result.current.gainsDb).toEqual(EQUALIZER_PRESETS.rock.gainsDb)

    client.setPropertyRejection = undefined
    act(() => {
      result.current.applyPreset('jazz')
    })
    expect(result.current.error).toBeUndefined()
  })

  it('holds its state before a player exists and applies once one appears', async () => {
    const { result, rerender } = renderHook(
      ({ target }: { target: Player | undefined }) => useEqualizer(target),
      { initialProps: { target: undefined as Player | undefined } }
    )

    act(() => {
      result.current.applyPreset('rock')
    })
    expect(result.current.gainsDb).toEqual(EQUALIZER_PRESETS.rock.gainsDb)
    expect(af()).toBe('')

    rerender({ target: player })
    await waitFor(() => {
      expect(af()).toContain('equalizer=')
    })
  })
})

describe('useEqualizer — persistence', () => {
  /** A synchronous storage engine, the MMKV shape. */
  function memoryStorage(seed?: string): EqualizerStorage & {
    readonly items: Map<string, string>
  } {
    const items = new Map<string, string>()
    if (seed !== undefined) items.set(DEFAULT_EQUALIZER_STORAGE_KEY, seed)
    return {
      items,
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => {
        items.set(key, value)
      },
    }
  }

  it('restores the saved curve, the enabled flag and the preset bank', async () => {
    const storage = memoryStorage(
      serializeEqualizerSettings({
        enabled: true,
        gainsDb: EQUALIZER_PRESETS.jazz.gainsDb,
        presets: [
          {
            id: 'custom:Mine',
            name: 'Mine',
            gainsDb: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          },
        ],
      })
    )
    const { result } = mount({ storage })

    await waitFor(() => {
      expect(result.current.hydrated).toBe(true)
    })
    expect(result.current.preset?.id).toBe('jazz')
    expect(result.current.savedPresets).toHaveLength(1)
    expect(af()).toContain('equalizer=')
  })

  it('reads a synchronous engine synchronously, so nothing flat is ever applied', () => {
    const storage = memoryStorage(
      serializeEqualizerSettings({
        enabled: true,
        gainsDb: EQUALIZER_PRESETS.jazz.gainsDb,
        presets: [],
      })
    )
    // No `await`: MMKV and a plain Map answer inside the mount effect, so the
    // very first `af` write is already the restored curve.
    const { result } = mount({ storage })
    expect(result.current.hydrated).toBe(true)
    expect(result.current.preset?.id).toBe('jazz')
    expect(af()).toContain('equalizer=')
  })

  it('writes nothing to mpv before an async record has been read back', () => {
    const record = serializeEqualizerSettings({
      enabled: true,
      gainsDb: EQUALIZER_PRESETS.jazz.gainsDb,
      presets: [],
    })
    const asyncStorage: EqualizerStorage = {
      getItem: () => Promise.resolve(record),
      setItem: () => Promise.resolve(),
    }
    const { result } = mount({ storage: asyncStorage })
    // One microtask still pending: nothing has been applied, so the saved curve
    // lands once rather than after a frame of flat.
    expect(result.current.hydrated).toBe(false)
    expect(af()).toBe('')
  })

  it('does not write back the record it just restored', async () => {
    const storage = memoryStorage(
      serializeEqualizerSettings({
        enabled: true,
        gainsDb: EQUALIZER_PRESETS.jazz.gainsDb,
        presets: [],
      })
    )
    const writes = vi.spyOn(storage, 'setItem')
    const { result } = mount({ storage })

    await waitFor(() => {
      expect(result.current.hydrated).toBe(true)
    })
    expect(writes).not.toHaveBeenCalled()
  })

  it('persists a change, and does not rewrite an unchanged record', async () => {
    const storage = memoryStorage()
    const writes = vi.spyOn(storage, 'setItem')
    const { result, rerender } = mount({ storage })

    await waitFor(() => {
      expect(result.current.hydrated).toBe(true)
    })
    const afterHydration = writes.mock.calls.length

    act(() => {
      result.current.applyPreset('rock')
    })
    expect(writes.mock.calls.length).toBe(afterHydration + 1)

    rerender({ storage })
    expect(writes.mock.calls.length).toBe(afterHydration + 1)

    expect(storage.items.get(DEFAULT_EQUALIZER_STORAGE_KEY)).toContain('"v":1')
  })

  it('starts from the defaults when the record is corrupt', async () => {
    const { result } = mount({ storage: memoryStorage('{not json') })
    await waitFor(() => {
      expect(result.current.hydrated).toBe(true)
    })
    expect(result.current.preset?.id).toBe('flat')
  })

  it('reports a storage failure rather than swallowing it', async () => {
    const onStorageError = vi.fn()
    const failing: EqualizerStorage = {
      getItem: () => {
        throw new Error('disk on fire')
      },
      setItem: () => undefined,
    }
    const { result } = mount({ storage: failing, onStorageError })

    await waitFor(() => {
      expect(result.current.hydrated).toBe(true)
    })
    expect(onStorageError).toHaveBeenCalledOnce()
    // …and the equaliser is still usable.
    act(() => {
      result.current.applyPreset('rock')
    })
    expect(af()).toContain('equalizer=')
  })

  it('reports an async write rejection through the same channel', async () => {
    const onStorageError = vi.fn()
    const failing: EqualizerStorage = {
      getItem: () => Promise.resolve(null),
      setItem: () => Promise.reject(new Error('quota exceeded')),
    }
    const { result } = mount({ storage: failing, onStorageError })

    await waitFor(() => {
      expect(result.current.hydrated).toBe(true)
    })
    act(() => {
      result.current.applyPreset('rock')
    })
    await waitFor(() => {
      expect(onStorageError).toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// Dragging — the in-place path
// ---------------------------------------------------------------------------

/** Every `af-command` issued so far. */
function commands(): string[][] {
  return client.commands.filter((args) => args[0] === 'af-command')
}

/** How many times the whole chain has been written to the `af` property. */
function writes(): number {
  return client.propertyWrites.filter(
    (name) => name === MpvProperty.audioFilters
  ).length
}

describe('useEqualizer — moving a band', () => {
  it('pushes the new gain into the running filter instead of rewriting `af`', async () => {
    const { result } = mount()
    // Flat → touched is the one shape change: it is a rebuild, once.
    act(() => {
      result.current.setBandGain(0, 3)
    })
    const chain = af()
    const before = writes()

    await act(async () => {
      result.current.setBandGain(0, 6)
    })

    // mpv's property is deliberately untouched — that is what makes it cheap.
    expect(af()).toBe(chain)
    expect(writes()).toBe(before)
    expect(commands()).toEqual([
      // The headroom pre-amp moves with the curve, and `volume` takes its gain
      // at runtime too, so it rides along instead of forcing a rebuild. The
      // fourth argument is mpv's `<target>`: the filter's own name, because
      // mpv's `all` default reports a working command as failed.
      ['af-command', 'rnmedia_eq_preamp', 'volume', '-6dB', 'volume'],
      ['af-command', 'rnmedia_eq_31', 'g', '6', 'equalizer'],
    ])
  })

  it('costs one command per moved band, whatever the drag does', async () => {
    const { result } = mount()
    act(() => {
      result.current.setBandGain(4, 1)
    })
    const before = writes()

    // Eleven frames of a finger, each its own render — which is what broke
    // playback before this. (Several moves inside one render coalesce, because
    // the chain is compiled from state, not from the calls.)
    for (let step = 2; step <= 12; step += 1) {
      await act(async () => {
        result.current.setBandGain(4, step)
      })
    }

    expect(writes()).toBe(before)
    expect(commands()).toHaveLength(2 * 11)
    expect(commands().at(-1)).toEqual([
      'af-command',
      'rnmedia_eq_500',
      'g',
      '12',
      'equalizer',
    ])
  })

  it('rebuilds the chain when the graph itself changes', async () => {
    const { result, rerender } = mount()
    act(() => {
      result.current.applyPreset('rock')
    })

    // Switching the EQ off, and back on, is a different chain — not a value.
    const beforeToggle = writes()
    await act(async () => {
      result.current.setEnabled(false)
    })
    expect(writes()).toBe(beforeToggle + 1)
    expect(af()).toBe('')

    // So is the app's own half of the chain changing.
    await act(async () => {
      result.current.setEnabled(true)
    })
    const beforeExtra = writes()
    await act(async () => {
      rerender({ extraFilters: [AudioFilters.crossfeed({ strength: 0.6 })] })
    })
    expect(writes()).toBe(beforeExtra + 1)
    expect(af()).toContain('crossfeed=strength=')

    // And so is returning to flat, which takes the EQ out of the path.
    const beforeFlat = writes()
    await act(async () => {
      result.current.reset()
    })
    expect(writes()).toBe(beforeFlat + 1)
    expect(af()).toBe('crossfeed=strength=%3%0.6')
  })

  it('commits the chain to `af` once the drag settles', async () => {
    vi.useFakeTimers()
    try {
      const { result } = mount()
      act(() => {
        result.current.setBandGain(0, 3)
      })
      const before = writes()
      await act(async () => {
        result.current.setBandGain(0, 6)
        result.current.setBandGain(0, 9)
      })
      // Still nothing written: the finger is still moving.
      expect(writes()).toBe(before)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })

      // One write, and mpv's property now agrees with what is playing — so a
      // track change, a device switch or a normalization toggle cannot revert
      // the curve to where the drag started.
      expect(writes()).toBe(before + 1)
      expect(af()).toContain('@rnmedia_eq_31:equalizer=f=31:t=o:w=1:g=9')
      expect(af()).toContain('@rnmedia_eq_preamp:volume=volume=-9dB')

      // Nothing more, ever, without another change.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(writes()).toBe(before + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes a pending commit when the screen unmounts mid-drag', async () => {
    vi.useFakeTimers()
    try {
      const { result, unmount } = mount()
      act(() => {
        result.current.setBandGain(0, 3)
      })
      await act(async () => {
        result.current.setBandGain(0, 9)
      })
      const before = writes()

      unmount()

      expect(writes()).toBe(before + 1)
      expect(af()).toContain('g=9')
    } finally {
      vi.useRealTimers()
    }
  })

  it('degrades to commit-only when mpv refuses the command', async () => {
    vi.useFakeTimers()
    try {
      const { result } = mount()
      act(() => {
        result.current.setBandGain(0, 3)
      })
      const before = writes()
      // What an old engine, or a stopped player with no audio chain, answers.
      client.commandRejection = '[mpv:-11] af-command'

      await act(async () => {
        result.current.setBandGain(0, 6)
      })
      // Crucially NOT a write per change: rewriting the chain sixty times a
      // second is the bug this whole path exists to avoid, and an engine that
      // cannot take commands is not a reason to go back to it.
      expect(writes()).toBe(before)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      expect(writes()).toBe(before + 1)
      expect(af()).toContain('g=6')
      // A failure the commit path absorbed is not the user's problem.
      expect(result.current.error).toBeUndefined()

      // And it does not keep trying: the next change goes straight to commit.
      const commandsBefore = commands().length
      await act(async () => {
        result.current.setBandGain(0, 9)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      expect(commands()).toHaveLength(commandsBefore)
      expect(af()).toContain('g=9')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the error when the commit write fails too', async () => {
    vi.useFakeTimers()
    try {
      const { result } = mount()
      act(() => {
        result.current.setBandGain(0, 3)
      })
      client.commandRejection = '[mpv:-11] af-command'
      client.setPropertyRejection = '[mpv:-11] mpv_set_property_string("af")'

      await act(async () => {
        result.current.setBandGain(0, 6)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })

      expect(result.current.error?.code).toBe('mpv')
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * The hook composes with the app's own chain instead of replacing it.
 *
 * Before this, `useEqualizer` called `Player.setAudioFilters` wholesale, which
 * meant mounting an EQ screen erased whatever the app had set — a defect the
 * README documented as a *pitfall* ("the EQ screen's changes get wiped", remedy:
 * "put the rest of your chain in its `extraFilters` option"). It is the API's
 * defect, not the user's; the hook now owns only its own labelled entries.
 */
describe('useEqualizer — composition with the app’s own chain', () => {
  it('leaves a chain set before it in place', () => {
    player.setAudioFilters([AudioFilters.crossfeed()])
    const { result } = mount()

    act(() => {
      result.current.applyPreset('rock')
    })

    expect(af()).toContain('@rnmedia_eq_31:equalizer=')
    expect(af().endsWith('crossfeed')).toBe(true)
  })

  it('leaves a chain set WHILE it is mounted in place, across a drag', async () => {
    const { result } = mount()
    act(() => {
      result.current.applyPreset('rock')
    })
    // The app changes its own half behind the EQ screen. This used to be the
    // change that "got wiped" by the next slider move.
    act(() => {
      player.setAudioFilters([AudioFilters.crossfeed({ strength: 0.3 })])
    })
    expect(af()).toContain('crossfeed')

    await act(async () => {
      result.current.setBandGain(0, 6)
    })

    expect(af()).toContain('crossfeed')
  })

  it('an EQ switched off does not clear the app’s filters', () => {
    player.setAudioFilters([AudioFilters.crossfeed()])
    const { result } = mount()
    act(() => {
      result.current.applyPreset('rock')
    })
    act(() => {
      result.current.setEnabled(false)
    })
    // `setEnabled(false)` writes an empty EQ half. Before the fix that was an
    // empty *user* half, i.e. `af=''`, and the crossfeed was gone.
    expect(af()).toBe('crossfeed')
  })

  it('composes with the managed loudness entry from either direction', () => {
    const { result } = mount()
    player.setLoudnessNormalization(true)
    act(() => {
      result.current.applyPreset('rock')
    })
    expect(af().endsWith('@rnmedia_loudnorm:loudnorm=I=-16')).toBe(true)
    expect(af().startsWith('@rnmedia_eq_preamp:')).toBe(true)
  })

  it('still honours the deprecated `extraFilters`, in the same position', () => {
    const withOption = mount({
      extraFilters: [AudioFilters.crossfeed()],
    })
    act(() => {
      withOption.result.current.applyPreset('rock')
    })
    const viaOption = af()
    withOption.unmount()

    // The direct call is the replacement, and it compiles to the same chain —
    // which is what makes the deprecation a rename rather than a migration.
    player.setEqualizerFilters(null)
    player.setAudioFilters([AudioFilters.crossfeed()])
    const direct = mount()
    act(() => {
      direct.result.current.applyPreset('rock')
    })
    expect(af()).toBe(viaOption)
    direct.unmount()
  })

  it('mounting over an existing chain costs one write and changes nothing', () => {
    player.setAudioFilters([AudioFilters.crossfeed()])
    const before = client.propertyWrites.filter(
      (name) => name === MpvProperty.audioFilters
    ).length
    mount()
    // One write, and only one: the hook claims the equaliser half on mount
    // (that is what makes it *the* owner), and a flat curve compiles to no
    // entries — so the string mpv ends up with is byte-identical to the one it
    // already had. Before the fix, this same write was `af=''`.
    expect(
      client.propertyWrites.filter((name) => name === MpvProperty.audioFilters)
        .length
    ).toBe(before + 1)
    expect(af()).toBe('crossfeed')
  })
})
