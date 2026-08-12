/**
 * `usePrefetchStatus` — the `prefetchStarted` event as renderable state.
 *
 * The contract under test is the clearing set: active from the event, idle
 * again on exactly `trackChanged` / `error` / `queueEnded`, and on nothing
 * else (a seek must not clear it — the next entry's open demuxer survives a
 * scrub within the current track).
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePrefetchStatus } from '../hooks/usePrefetchStatus'
import type { Player } from '../player'
import { Player as PlayerClass } from '../player'
import { MpvProperty } from '../properties'
import {
  FakeMpvClient,
  endFileEvent,
  playbackRestartEvent,
  propertyEvent,
  seekEvent,
  startFileEvent,
} from './fake-mpv-client'

let client: FakeMpvClient

async function makePlayer(
  overrides: Parameters<typeof PlayerClass.create>[0] = {}
): Promise<Player> {
  return PlayerClass.create({ createClient: () => client, ...overrides })
}

const PREFETCH = {
  uri: 'https://cdn.example.com/next.flac',
  entryId: 7,
} as const

/** Put entry 0 on air, so track/queue events have something to move from. */
function startPlayback(): void {
  act(() => {
    client.emit([
      propertyEvent(MpvProperty.idleActive, false),
      startFileEvent(),
      propertyEvent(MpvProperty.playlistPos, 0),
      propertyEvent(MpvProperty.playlistCount, 2),
      propertyEvent(MpvProperty.duration, 120),
      playbackRestartEvent(),
    ])
  })
}

beforeEach(() => {
  client = new FakeMpvClient()
  vi.useRealTimers()
})

describe('usePrefetchStatus', () => {
  it('is idle without a player, with a stable identity', () => {
    const { result, rerender } = renderHook(() => usePrefetchStatus(undefined))
    const first = result.current
    expect(first).toEqual({ active: false })
    rerender()
    expect(result.current).toBe(first)
  })

  it('goes active on prefetchStarted, carrying uri, entryId and a timestamp', async () => {
    const player = await makePlayer()
    const { result } = renderHook(() => usePrefetchStatus(player))
    startPlayback()

    const before = Date.now()
    act(() => {
      client.emitPrefetchStarted({ ...PREFETCH })
    })

    expect(result.current).toMatchObject({ active: true, ...PREFETCH })
    if (result.current.active) {
      expect(result.current.at).toBeGreaterThanOrEqual(before)
      expect(result.current.at).toBeLessThanOrEqual(Date.now())
    }
  })

  it('carries an absent entryId honestly (pre-property fork binaries)', async () => {
    const player = await makePlayer()
    const { result } = renderHook(() => usePrefetchStatus(player))
    act(() => {
      client.emitPrefetchStarted({ uri: PREFETCH.uri })
    })
    expect(result.current).toMatchObject({
      active: true,
      uri: PREFETCH.uri,
      entryId: undefined,
    })
  })

  it('clears on the track change that consumes the prefetch', async () => {
    const player = await makePlayer()
    const { result } = renderHook(() => usePrefetchStatus(player))
    startPlayback()
    act(() => {
      client.emitPrefetchStarted({ ...PREFETCH })
    })
    expect(result.current.active).toBe(true)

    // The boundary: entry 1 becomes current.
    act(() => {
      client.emit([
        endFileEvent('endOfFile'),
        startFileEvent(),
        propertyEvent(MpvProperty.playlistPos, 1),
      ])
    })
    expect(result.current).toEqual({ active: false })
  })

  it('clears when the player gives up on the current entry', async () => {
    // `error` means "gave up": with the default budget this failure would be a
    // `retrying` (which deliberately does NOT clear — the prefetched next
    // entry stays warm while the current one is re-attempted). Budget 0 makes
    // the first failure final.
    const player = await makePlayer({ retry: { maxAttempts: 0 } })
    await player.load(PREFETCH.uri)
    const { result } = renderHook(() => usePrefetchStatus(player))
    startPlayback()
    act(() => {
      client.emitPrefetchStarted({ ...PREFETCH })
    })

    act(() => {
      client.emit([endFileEvent('error', 'loading failed')])
    })
    expect(result.current).toEqual({ active: false })
  })

  it('clears when the whole queue ends', async () => {
    const player = await makePlayer()
    const { result } = renderHook(() => usePrefetchStatus(player))
    // A one-entry queue: `hasNext` is false, so a natural end is `queueEnded`
    // (and no trackChanged follows — this is the path only queueEnded covers).
    act(() => {
      client.emit([
        propertyEvent(MpvProperty.idleActive, false),
        startFileEvent(),
        propertyEvent(MpvProperty.playlistPos, 0),
        propertyEvent(MpvProperty.playlistCount, 1),
        playbackRestartEvent(),
      ])
    })
    act(() => {
      client.emitPrefetchStarted({ ...PREFETCH })
    })
    expect(result.current.active).toBe(true)

    act(() => {
      client.emit([endFileEvent('endOfFile')])
    })
    expect(result.current).toEqual({ active: false })
  })

  it('does NOT clear on a seek within the current track', async () => {
    const player = await makePlayer()
    const { result } = renderHook(() => usePrefetchStatus(player))
    startPlayback()
    act(() => {
      client.emitPrefetchStarted({ ...PREFETCH })
    })

    client.readable.set(MpvProperty.timePos, 90)
    act(() => {
      client.emit([seekEvent(), playbackRestartEvent()])
    })
    expect(result.current).toMatchObject({ active: true, ...PREFETCH })
  })

  it('keeps the idle identity across clearing events (no wasted renders)', async () => {
    const player = await makePlayer()
    const { result } = renderHook(() => usePrefetchStatus(player))
    startPlayback()
    const idle = result.current
    act(() => {
      client.emit([propertyEvent(MpvProperty.playlistPos, 1)])
    })
    expect(result.current).toBe(idle)
  })

  it('a newer prefetch replaces the previous one', async () => {
    const player = await makePlayer()
    const { result } = renderHook(() => usePrefetchStatus(player))
    act(() => {
      client.emitPrefetchStarted({ ...PREFETCH })
    })
    act(() => {
      client.emitPrefetchStarted({
        uri: 'https://cdn.example.com/other.flac',
        entryId: 9,
      })
    })
    expect(result.current).toMatchObject({
      active: true,
      uri: 'https://cdn.example.com/other.flac',
      entryId: 9,
    })
  })

  it('resets to idle when the player is swapped', async () => {
    const player = await makePlayer()
    const { result, rerender } = renderHook(
      ({ current }: { current: Player | undefined }) =>
        usePrefetchStatus(current),
      { initialProps: { current: player as Player | undefined } }
    )
    act(() => {
      client.emitPrefetchStarted({ ...PREFETCH })
    })
    expect(result.current.active).toBe(true)

    const nextClient = new FakeMpvClient()
    client = nextClient
    const next = await makePlayer()
    rerender({ current: next })
    expect(result.current).toEqual({ active: false })
  })

  it('unsubscribes on unmount', async () => {
    const player = await makePlayer()
    const { result, unmount } = renderHook(() => usePrefetchStatus(player))
    act(() => {
      client.emitPrefetchStarted({ ...PREFETCH })
    })
    expect(result.current.active).toBe(true)
    unmount()
    // Would warn "update on an unmounted component" (and fail the suite via
    // the strict act environment) if the listener survived.
    client.emitPrefetchStarted({
      uri: 'https://cdn.example.com/late.flac',
    })
  })
})
