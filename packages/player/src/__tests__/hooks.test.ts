import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePlayer } from '../hooks/usePlayer'
import { usePlayerState } from '../hooks/usePlayerState'
import { useProgress } from '../hooks/useProgress'
import type { Player } from '../player'
import { Player as PlayerClass } from '../player'
import { MpvProperty } from '../properties'
import type { PlayerState } from '../state'
import {
  FakeMpvClient,
  playbackRestartEvent,
  propertyEvent,
  startFileEvent,
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
