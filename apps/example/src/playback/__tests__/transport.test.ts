/**
 * `Transport` — the stop/resume round trip, pinned without a device.
 *
 * What this suite exists for is one bug: a remote **stop** used to reach the
 * app's teardown (`stopService()`), which on iOS is a one-way door. The system
 * replaces pause with a *stop* button for anything marked live — Apple's own
 * behaviour, because a live stream cannot be paused — so on a radio entry the
 * destructive stop was the only transport control the lock screen offered, and
 * pressing it removed the now-playing card with no path back.
 *
 * The fix has two halves and both are pinned here, because either alone still
 * leaves a dead button:
 *
 * 1. stop must unload without ending the session (`player.stop()`), and
 * 2. play must be able to re-enter afterwards — `player.stop()` leaves *no
 *    entry current* (`playlist.index === -1`), and the library is explicit
 *    that `play()` alone "does not resume" from there; `jumpTo` is the way in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  activate: vi.fn(async () => true),
}))

vi.mock('@rn-media/audio-session', () => ({
  // Only the singleton is reached at runtime by `transport.ts`; everything
  // else it names is imported as a type.
  AudioSession: { activate: h.activate },
}))

const { Transport } = await import('../transport')

/**
 * A player just real enough for the transport: a playlist cursor that a stop
 * clears to `-1` and a `jumpTo` restores, exactly as mpv reports it.
 */
function fakePlayer(index = 3) {
  const calls: string[] = []
  const player = {
    state: { playlist: { index, count: 5 }, playing: false },
    play: vi.fn(() => {
      calls.push('play')
      player.state.playing = true
    }),
    pause: vi.fn(() => calls.push('pause')),
    stop: vi.fn(async () => {
      calls.push('stop')
      // mpv leaves no playlist entry current after `stop keep-playlist`.
      player.state.playlist.index = -1
      player.state.playing = false
    }),
    playlist: {
      jumpTo: vi.fn(async (to: number) => {
        calls.push(`jumpTo(${String(to)})`)
        player.state.playlist.index = to
        player.state.playing = true
      }),
    },
  }
  return { player, calls }
}

function transportFor(player: unknown) {
  return new Transport({
    player: () => player as never,
    ensureSession: vi.fn(),
  })
}

beforeEach(() => {
  h.activate.mockResolvedValue(true)
})

describe('Transport.stopPlayback', () => {
  it('unloads via player.stop() and never ends the session', async () => {
    const { player, calls } = fakePlayer()
    await transportFor(player).stopPlayback()

    expect(calls).toEqual(['stop'])
    // `clearPlaylist` is never passed: the queue has to survive a stop, or
    // there is nothing to resume into.
    expect(player.stop).toHaveBeenCalledWith()
  })

  it('is a no-op without a player rather than throwing', async () => {
    await expect(transportFor(undefined).stopPlayback()).resolves.toBeUndefined()
  })
})

describe('Transport.play after a stop', () => {
  it('re-enters the queue at the entry that was stopped', async () => {
    const { player, calls } = fakePlayer(3)
    const transport = transportFor(player)

    await transport.stopPlayback()
    await transport.play()

    // The regression: `play` alone would have flipped `pause` with nothing
    // loaded and the lock screen's play button would have done nothing.
    expect(calls).toEqual(['stop', 'jumpTo(3)'])
    expect(player.play).not.toHaveBeenCalled()
    expect(player.state.playing).toBe(true)
  })

  it('still just plays when an entry is loaded', async () => {
    const { player, calls } = fakePlayer(2)
    await transportFor(player).play()

    expect(calls).toEqual(['play'])
    expect(player.playlist.jumpTo).not.toHaveBeenCalled()
  })

  it('does not start anything when the audio session is refused', async () => {
    h.activate.mockResolvedValue(false)
    const { player, calls } = fakePlayer(3)
    const transport = transportFor(player)

    await transport.stopPlayback()
    await transport.play()

    // Focus is checked before the re-entry branch, not after it.
    expect(calls).toEqual(['stop'])
    expect(player.playlist.jumpTo).not.toHaveBeenCalled()
  })
})
