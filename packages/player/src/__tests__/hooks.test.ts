import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A controllable stand-in for React Native's `AppState`, used by
 * `useVisualizer`'s foreground gating.
 *
 * It is mocked rather than aliased because `react-native`'s entry point is Flow
 * source that needs a Metro transform, and `useVisualizer` is the only module in
 * this package that reaches it. `vi.hoisted` is what lets the factory below —
 * which vitest hoists above every import — close over this object.
 */
const appState = vi.hoisted(() => {
  const listeners = new Set<(status: string) => void>()
  return {
    currentState: 'active' as string | null,
    listeners,
    /** Drive a lifecycle transition the way the platform would. */
    change(next: string): void {
      appState.currentState = next
      for (const listener of [...listeners]) listener(next)
    },
    reset(): void {
      listeners.clear()
      appState.currentState = 'active'
    },
  }
})

vi.mock('react-native', () => ({
  AppState: {
    get currentState(): string | null {
      return appState.currentState
    },
    addEventListener(
      _type: string,
      listener: (status: string) => void
    ): { remove(): void } {
      appState.listeners.add(listener)
      return {
        remove(): void {
          appState.listeners.delete(listener)
        },
      }
    },
  },
}))

import { usePlayer } from '../hooks/usePlayer'
import { usePlayerState } from '../hooks/usePlayerState'
import { useProgress } from '../hooks/useProgress'
import { useVisualizer } from '../hooks/useVisualizer'
import type { Player } from '../player'
import { Player as PlayerClass } from '../player'
import { MpvProperty } from '../properties'
import type { PlayerState } from '../state'
import {
  FakeMpvClient,
  playbackRestartEvent,
  propertyEvent,
  startFileEvent,
  toneCapture,
} from './fake-mpv-client'

let client: FakeMpvClient
let now = 1_000_000

const clock = (): number => now

/** Bring a player to `status: 'ready'`, playing, 120s long, at position 0. */
function startPlayback(): void {
  client.readable.set(MpvProperty.timePos, 0)
  act(() => {
    client.emit([
      propertyEvent(MpvProperty.idleActive, false),
      startFileEvent(),
      propertyEvent(MpvProperty.playlistPos, 0),
      propertyEvent(MpvProperty.duration, 120),
      playbackRestartEvent(),
      propertyEvent(MpvProperty.pause, false),
      propertyEvent(MpvProperty.coreIdle, false),
    ])
  })
}

async function makePlayer(): Promise<Player> {
  return PlayerClass.create({ createClient: () => client, now: clock })
}

beforeEach(() => {
  client = new FakeMpvClient()
  now = 1_000_000
})

afterEach(() => {
  vi.useRealTimers()
})

describe('usePlayer', () => {
  it('creates a player on mount and destroys it on unmount', async () => {
    const { result, unmount } = renderHook(() =>
      usePlayer({ createClient: () => client, now: clock })
    )

    await waitFor(() => {
      expect(result.current.player).toBeDefined()
    })
    expect(client.initialized).toBe(true)
    expect(result.current.error).toBeUndefined()

    unmount()
    expect(client.destroyCount).toBe(1)
  })

  it('runs setup once the player exists', async () => {
    const setup = vi.fn(async (player: Player) => {
      await player.load('https://example.com/a.mp3')
    })
    renderHook(() =>
      usePlayer({ createClient: () => client, now: clock, setup })
    )
    await waitFor(() => {
      expect(client.commands).toEqual([
        ['loadfile', 'https://example.com/a.mp3', 'replace'],
      ])
    })
    expect(setup).toHaveBeenCalledTimes(1)
  })

  it('reports a typed creation error instead of throwing', async () => {
    client.initRejection =
      '[mpv:-5] mpv_set_option_string("x"): option not found'
    const { result } = renderHook(() =>
      usePlayer({ createClient: () => client, now: clock })
    )
    await waitFor(() => {
      expect(result.current.error).toBeDefined()
    })
    expect(result.current.error).toMatchObject({ code: 'mpv', errno: -5 })
    expect(result.current.player).toBeUndefined()
  })

  it('reports a setup failure', async () => {
    const { result } = renderHook(() =>
      usePlayer({
        createClient: () => client,
        now: clock,
        setup: () => {
          throw new Error('[mpv:-13] loading failed')
        },
      })
    )
    await waitFor(() => {
      expect(result.current.error).toBeDefined()
    })
    expect(result.current.error).toMatchObject({ code: 'load-failed' })
  })
})

describe('usePlayerState', () => {
  it('renders an idle snapshot before the player exists', () => {
    const { result } = renderHook(() => usePlayerState(undefined))
    expect(result.current.status).toBe('idle')
    expect(result.current.playing).toBe(false)
  })

  it('re-renders when the state changes', async () => {
    const player = await makePlayer()
    const { result } = renderHook(() => usePlayerState(player))
    expect(result.current.status).toBe('idle')

    startPlayback()
    expect(result.current.status).toBe('ready')
    expect(result.current.duration).toBe(120)
  })

  it('keeps snapshot identity stable when nothing changed', async () => {
    const player = await makePlayer()
    const { result, rerender } = renderHook(() => usePlayerState(player))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it('limits re-renders with a selector', async () => {
    const player = await makePlayer()
    const renders = vi.fn()
    const { result } = renderHook(() => {
      const status = usePlayerState(
        player,
        (state: PlayerState) => state.status
      )
      renders()
      return status
    })

    const initialRenders = renders.mock.calls.length
    // A change that does not affect the selection.
    act(() => {
      client.emit([propertyEvent(MpvProperty.volume, 55)])
    })
    expect(renders.mock.calls.length).toBe(initialRenders)
    expect(result.current).toBe('idle')

    // A change that does.
    startPlayback()
    expect(result.current).toBe('ready')
    expect(renders.mock.calls.length).toBeGreaterThan(initialRenders)
  })

  it('honours a custom equality function for object selections', async () => {
    const player = await makePlayer()
    const selector = (state: PlayerState): { count: number } => ({
      count: state.playlist.count,
    })
    const isEqual = (a: { count: number }, b: { count: number }): boolean =>
      a.count === b.count
    const { result } = renderHook(() =>
      usePlayerState(player, selector, isEqual)
    )
    const first = result.current

    act(() => {
      client.emit([propertyEvent(MpvProperty.volume, 42)])
    })
    // Same logical value → same object identity → no wasted re-render.
    expect(result.current).toBe(first)

    act(() => {
      client.emit([propertyEvent(MpvProperty.playlistCount, 3)])
    })
    expect(result.current).toEqual({ count: 3 })
  })

  it('unsubscribes on unmount', async () => {
    const player = await makePlayer()
    const { unmount } = renderHook(() => usePlayerState(player))
    unmount()
    // No listener remains, so emitting must not throw or update anything.
    act(() => {
      client.emit([propertyEvent(MpvProperty.volume, 10)])
    })
    expect(player.state.volume).toBe(0.1)
  })
})

describe('useProgress', () => {
  it('runs one precise time-pos resync on subscribe', async () => {
    const player = await makePlayer()
    startPlayback()
    now += 30_000
    client.readable.set(MpvProperty.timePos, 7.5)

    const { result } = renderHook(() => useProgress(player))
    // Without the resync the projection would read 30s.
    expect(result.current.position).toBeCloseTo(7.5, 6)
    expect(result.current.duration).toBe(120)
  })

  it('ticks on an interval while playing and stops when paused', async () => {
    vi.useFakeTimers()
    const player = await makePlayer()
    startPlayback()

    const { result } = renderHook(() => useProgress(player, 250))
    expect(result.current.position).toBeCloseTo(0, 6)

    await act(async () => {
      now += 500
      vi.advanceTimersByTime(500)
    })
    expect(result.current.position).toBeCloseTo(0.5, 6)

    const timersWhilePlaying = vi.getTimerCount()
    expect(timersWhilePlaying).toBeGreaterThan(0)

    // Pause: the ticker must be torn down (no timers left).
    await act(async () => {
      client.emit([propertyEvent(MpvProperty.pause, true)])
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(result.current.position).toBeCloseTo(0.5, 6)

    // Time passes while paused — the reported position must not move.
    await act(async () => {
      now += 10_000
      vi.advanceTimersByTime(10_000)
    })
    expect(result.current.position).toBeCloseTo(0.5, 6)
  })

  it('stops the ticker while buffering', async () => {
    vi.useFakeTimers()
    const player = await makePlayer()
    startPlayback()
    renderHook(() => useProgress(player, 250))
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    await act(async () => {
      client.emit([propertyEvent(MpvProperty.coreIdle, true)])
    })
    expect(player.state.status).toBe('buffering')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the interval on unmount', async () => {
    vi.useFakeTimers()
    const player = await makePlayer()
    startPlayback()
    const { unmount } = renderHook(() => useProgress(player, 250))
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never starts a ticker when intervalMs is 0', async () => {
    vi.useFakeTimers()
    const player = await makePlayer()
    startPlayback()
    renderHook(() => useProgress(player, 0))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports zeroes and no timers without a player', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useProgress(undefined))
    expect(result.current).toEqual({
      position: 0,
      duration: undefined,
      buffered: undefined,
      isLive: false,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports isLive and no duration for an unseekable stream', async () => {
    const player = await makePlayer()
    startPlayback()
    const { result } = renderHook(() => useProgress(player, 0))
    expect(result.current.isLive).toBe(false)
    expect(result.current.duration).toBe(120)

    act(() => {
      client.emit([
        propertyEvent(MpvProperty.seekable, false),
        // mpv's cache length masquerading as a duration.
        propertyEvent(MpvProperty.duration, 1.93),
      ])
    })
    expect(result.current.isLive).toBe(true)
    expect(result.current.duration).toBeUndefined()
  })

  it('exposes the demuxer cache as the buffered position', async () => {
    const player = await makePlayer()
    startPlayback()
    const { result } = renderHook(() => useProgress(player, 0))
    act(() => {
      client.emit([propertyEvent(MpvProperty.demuxerCacheTime, 45.25)])
    })
    expect(result.current.buffered).toBe(45.25)
  })
})

describe('useVisualizer', () => {
  beforeEach(() => {
    appState.reset()
  })

  async function makeVisualizerPlayer(): Promise<Player> {
    return PlayerClass.create({ createClient: () => client, now: clock })
  }

  function running(): boolean {
    return client.visualizerRunning
  }

  function starts(): number {
    return client.visualizerCalls.filter((c) => c.kind === 'start').length
  }

  function stops(): number {
    return client.visualizerCalls.filter((c) => c.kind === 'stop').length
  }

  it('subscribes on mount and disarms the tap on unmount', async () => {
    const player = await makeVisualizerPlayer()
    const { unmount } = renderHook(() => useVisualizer(player, { bands: 8 }))
    expect(running()).toBe(true)

    unmount()
    // Unmounting is what disarms mpv's tap — nothing may be left sampling
    // behind a screen the user has navigated away from.
    expect(running()).toBe(false)
    expect(stops()).toBe(1)
  })

  it('re-renders with the newest frame', async () => {
    const player = await makeVisualizerPlayer()
    const { result } = renderHook(() => useVisualizer(player, { bands: 8 }))
    expect(result.current.frame).toBeUndefined()
    expect(result.current.active).toBe(true)

    act(() => {
      client.emitCapture(toneCapture(4, 0.5, { bins: 33 }))
    })
    expect(result.current.frame?.bands).toHaveLength(8)
    expect(result.current.error).toBeUndefined()
  })

  it('does not resubscribe when an equal options literal is re-created', async () => {
    const player = await makeVisualizerPlayer()
    const { rerender } = renderHook(
      ({ bands }: { bands: number }) => useVisualizer(player, { bands }),
      { initialProps: { bands: 8 } }
    )
    rerender({ bands: 8 })
    rerender({ bands: 8 })
    // Options are compared by value: identity would rebuild the native sampler
    // on every single render.
    expect(starts()).toBe(1)
    expect(stops()).toBe(0)
  })

  it('drops the subscription while disabled and restores it after', async () => {
    const player = await makeVisualizerPlayer()
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useVisualizer(player, undefined, enabled),
      { initialProps: { enabled: true } }
    )
    expect(running()).toBe(true)

    rerender({ enabled: false })
    expect(running()).toBe(false)
    expect(result.current.active).toBe(false)
    expect(result.current.frame).toBeUndefined()

    rerender({ enabled: true })
    expect(running()).toBe(true)
  })

  it('does nothing at all while the player is still being created', () => {
    const { result } = renderHook(() => useVisualizer(undefined))
    expect(result.current.active).toBe(false)
    expect(result.current.frame).toBeUndefined()
    expect(starts()).toBe(0)
  })

  it('surfaces an unpatched libmpv as a typed unsupported error', async () => {
    client.readErrors.set(
      MpvProperty.pcmTap,
      '[mpv:-8] mpv_get_property("pcm-tap", DOUBLE): property not found'
    )
    const player = await makeVisualizerPlayer()
    const { result } = renderHook(() => useVisualizer(player))
    expect(result.current.error?.code).toBe('unsupported')
    expect(result.current.active).toBe(false)
  })

  it('surfaces a native start failure as a typed error', async () => {
    client.visualizerRejection =
      '[visualizer:unavailable] this libmpv has no PCM tap.'
    const player = await makeVisualizerPlayer()
    const { result } = renderHook(() => useVisualizer(player))
    expect(result.current.error?.code).toBe('unsupported')
    expect(result.current.active).toBe(false)
  })

  it('drops the subscription when the app leaves the foreground', async () => {
    const player = await makeVisualizerPlayer()
    const { result } = renderHook(() => useVisualizer(player, { bands: 8 }))
    expect(running()).toBe(true)

    // The frames are native callbacks, so nothing about backgrounding stops
    // them on its own — unsubscribing is the only thing that does.
    act(() => appState.change('background'))
    expect(running()).toBe(false)
    expect(stops()).toBe(1)
    expect(result.current.active).toBe(false)
  })

  it('resubscribes with the same options when the app comes back', async () => {
    const player = await makeVisualizerPlayer()
    const options = { bands: 8, fps: 15, fftSize: 1024, waveform: true }
    const { result } = renderHook(() => useVisualizer(player, options))
    const first = client.visualizerCalls[0]

    act(() => appState.change('background'))
    expect(running()).toBe(false)

    act(() => appState.change('active'))
    expect(running()).toBe(true)
    expect(starts()).toBe(2)
    // Resuming must not quietly fall back to the defaults.
    expect(client.visualizerCalls.filter((c) => c.kind === 'start')[1]).toEqual(
      first
    )

    act(() => {
      client.emitCapture(toneCapture(4, 0.5, { bins: 513 }))
    })
    expect(result.current.frame?.bands).toHaveLength(8)
    expect(result.current.active).toBe(true)
  })

  it("treats iOS's transient 'inactive' as leaving the foreground", async () => {
    const player = await makeVisualizerPlayer()
    renderHook(() => useVisualizer(player))
    act(() => appState.change('inactive'))
    expect(running()).toBe(false)
    act(() => appState.change('active'))
    expect(running()).toBe(true)
  })

  it('does not subscribe at all when it mounts in the background', async () => {
    appState.currentState = 'background'
    const player = await makeVisualizerPlayer()
    const { result } = renderHook(() => useVisualizer(player))
    expect(starts()).toBe(0)
    expect(result.current.active).toBe(false)

    act(() => appState.change('active'))
    expect(starts()).toBe(1)
  })

  it('starts anyway when the platform has no state yet', async () => {
    // Android's AppState.currentState is null until the first lifecycle
    // callback; a mounting hook must not be stranded by that.
    appState.currentState = null
    const player = await makeVisualizerPlayer()
    renderHook(() => useVisualizer(player))
    expect(running()).toBe(true)
  })

  it('keeps running through a background with pauseWhenInactive off', async () => {
    const player = await makeVisualizerPlayer()
    const { result } = renderHook(() =>
      useVisualizer(player, { bands: 8 }, true, false)
    )
    expect(running()).toBe(true)

    act(() => appState.change('background'))
    expect(running()).toBe(true)
    expect(stops()).toBe(0)
    expect(result.current.active).toBe(true)
    // Opting out also means not listening: nothing was registered to leak.
    expect(appState.listeners.size).toBe(0)
  })

  it('honours `enabled: false` regardless of the app state', async () => {
    const player = await makeVisualizerPlayer()
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useVisualizer(player, undefined, enabled),
      { initialProps: { enabled: true } }
    )
    rerender({ enabled: false })
    expect(running()).toBe(false)

    // Coming back to the foreground must not resurrect a disabled visualizer.
    act(() => appState.change('background'))
    act(() => appState.change('active'))
    expect(running()).toBe(false)
    expect(starts()).toBe(1)
  })

  it('leaks neither a tap nor a listener when unmounted in the background', async () => {
    const player = await makeVisualizerPlayer()
    const { unmount } = renderHook(() => useVisualizer(player))
    act(() => appState.change('background'))
    expect(stops()).toBe(1)

    unmount()
    expect(running()).toBe(false)
    // Unmounting an already-paused hook must not stop a tap twice, and must
    // still release the AppState subscription.
    expect(stops()).toBe(1)
    expect(appState.listeners.size).toBe(0)

    // A later transition has nobody left to notify.
    act(() => appState.change('active'))
    expect(starts()).toBe(1)
  })
})
