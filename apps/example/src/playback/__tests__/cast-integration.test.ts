/**
 * `CastIntegration` — the app-side cast wiring, against fakes.
 *
 * What this suite pins is exactly what the first device round broke
 * (POCO F4 → Mi Smart Speaker, 2026-08-13):
 *
 * - **The transfer-back restore sequence.** The naive adapter seeked against
 *   a state snapshot that still said `ready` from before the playlist jump;
 *   mpv rejected the seek mid-reload and the restore landed paused at 0:00.
 *   The rules now: never reload the entry you are already on, wait until the
 *   state *shows* the target entry open before seeking, retry a rejected
 *   seek once on a FRESH state change, and propagate `play()`'s promise.
 * - **Mid-handoff transport buffering.** While `handoff-to-cast` the local
 *   player is paused for the session, so a command routed to mpv would start
 *   phone audio under the speaker's; the receiver cannot take it yet either.
 *   Intent is buffered last-wins and flushed on `cast-active`.
 * - **Volume ownership.** While the cast side owns playback, the in-app
 *   volume drives the SPEAKER (device volume), not mpv — and the media
 *   session is told the output is remote, which is what puts the phone's
 *   hardware volume keys on the speaker with the screen locked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Player, PlayerState } from '@timbre/player'
import type {
  CastHandoff,
  CastHandoffLocalPlayer,
  CastHandoffPhase,
  WireCastHandoffOptions,
} from '@timbre/cast'
import type { CastDeviceVolume } from '@timbre/cast'
import type { Track } from '../../data/tracks'

/* ---------------------------------------------------------------------- */
/*                                 fakes                                  */
/* ---------------------------------------------------------------------- */

const h = vi.hoisted(() => {
  const calls: Array<[string, ...unknown[]]> = []
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args])
      return Promise.resolve()
    }
  const emit: Record<string, (payload: never) => void> = {}
  const fakeCast = {
    initialize: () => Promise.resolve('idle'),
    getCastState: () => 'idle',
    addListener: (name: string, listener: (payload: never) => void) => {
      emit[name] = listener
      return () => undefined
    },
    getDeviceVolume: () => Promise.resolve({ volume: 0.5, muted: false }),
    play: record('Cast.play'),
    pause: record('Cast.pause'),
    seek: record('Cast.seek'),
    setDeviceVolume: record('Cast.setDeviceVolume'),
    setDeviceMuted: record('Cast.setDeviceMuted'),
  }
  const handle = {
    phase: 'local',
    receiverItemIndex: undefined as number | undefined,
    castTo: record('handoff.castTo'),
    stopCasting: record('handoff.stopCasting'),
    syncQueue: () => undefined,
    skipToItem: record('handoff.skipToItem'),
    skipToNext: record('handoff.skipToNext'),
    skipToPrevious: record('handoff.skipToPrevious'),
    dispose: () => undefined,
  }
  // Untyped here (vi.hoisted runs before imports); the typed view is
  // `captured` below, applied once the real types are in scope.
  const captured: { local?: unknown; options?: unknown } = {}
  return { calls, emit, fakeCast, handle, captured }
})

vi.mock('@timbre/cast', async () => {
  // Not `importOriginal`: the package entry pulls the Nitro facade, whose
  // module graph needs React Native. The pure halves this module actually
  // uses are re-exported from their sources; the two impure ones (the `Cast`
  // singleton and `wireCastHandoff`) are the fakes under test control.
  const errors = await import('../../../../../packages/cast/src/errors')
  const canCast = await import('../../../../../packages/cast/src/can-cast')
  const machine = await import(
    '../../../../../packages/cast/src/handoff-machine'
  )
  return {
    ...errors,
    ...canCast,
    ...machine,
    Cast: h.fakeCast,
    wireCastHandoff: (
      local: CastHandoffLocalPlayer,
      options: WireCastHandoffOptions
    ): CastHandoff => {
      h.captured.local = local
      h.captured.options = options
      return h.handle as unknown as CastHandoff
    },
  }
})

// After the mock: the module under test.
import { CastIntegration } from '../cast'

/** The hoisted capture box, seen through the real handoff types. */
const captured = h.captured as {
  local?: CastHandoffLocalPlayer
  options?: WireCastHandoffOptions
}

/** A controllable stand-in for the mpv-backed Player. */
function fakePlayer(): {
  player: Player
  set: (next: Partial<PlayerState> & { index?: number }) => void
  jumpTo: ReturnType<typeof vi.fn>
  seekTo: ReturnType<typeof vi.fn>
  play: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
} {
  let state = {
    status: 'ready',
    playing: false,
    muted: false,
    playlist: { index: 1 },
  }
  const listeners = new Set<(state: PlayerState) => void>()
  const jumpTo = vi.fn(() => Promise.resolve())
  const seekTo = vi.fn(() => Promise.resolve())
  const play = vi.fn()
  const pause = vi.fn()
  const player = {
    get state() {
      return state
    },
    onStateChange(listener: (state: PlayerState) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    playlist: { jumpTo },
    seekTo,
    play,
    pause,
    getPosition: () => 33.3,
  } as unknown as Player
  const set = (next: Partial<PlayerState> & { index?: number }): void => {
    const { index, ...rest } = next
    state = {
      ...state,
      ...rest,
      playlist: { index: index ?? state.playlist.index },
    } as typeof state
    for (const listener of listeners) listener(state as unknown as PlayerState)
  }
  return { player, set, jumpTo, seekTo, play, pause }
}

const TRACKS_FIXTURE: Track[] = [0, 1, 2].map((n) => ({
  id: `t${String(n)}`,
  uri: `https://cdn.example.com/t${String(n)}.mp3`,
  title: `Track ${String(n)}`,
  artist: 'Artist',
  album: 'Album',
  artworkUri: 'https://cdn.example.com/art.jpg',
})) as unknown as Track[]

async function harness(): Promise<{
  cast: CastIntegration
  player: ReturnType<typeof fakePlayer>
  resume: ReturnType<typeof vi.fn>
  toPhase: (phase: CastHandoffPhase) => void
  /** Every `onRemoteVolume` publish, in order. `undefined` = back to local. */
  remote: (CastDeviceVolume | undefined)[]
}> {
  const player = fakePlayer()
  const resume = vi.fn(() => Promise.resolve())
  const remote: (CastDeviceVolume | undefined)[] = []
  const cast = new CastIntegration({
    player: () => player.player,
    queue: () => TRACKS_FIXTURE,
    resume,
    onReceiverState: () => undefined,
    onRemoteVolume: (volume) => remote.push(volume),
    onChange: () => undefined,
  })
  await cast.start()
  const toPhase = (phase: CastHandoffPhase): void => {
    captured.options?.onPhaseChange?.(phase)
  }
  return { cast, player, resume, toPhase, remote }
}

beforeEach(() => {
  h.calls.length = 0
  h.captured.local = undefined
  h.captured.options = undefined
})

/* ---------------------------------------------------------------------- */
/*                    the transfer-back restore adapter                   */
/* ---------------------------------------------------------------------- */

describe('local-player adapter (the restore sequence)', () => {
  it('skipToIndex is a no-op when the player is already on the entry — no reload, no race', async () => {
    const { player } = await harness()
    await captured.local?.skipToIndex(1) // fake starts at index 1
    expect(player.jumpTo).not.toHaveBeenCalled()
  })

  it('skipToIndex jumps paused and resolves only once the state SHOWS the target entry open', async () => {
    const { player } = await harness()
    let settled = false
    const pending = Promise.resolve(captured.local?.skipToIndex(2)).then(
      () => {
        settled = true
      }
    )
    await Promise.resolve() // give the jump a microtask
    expect(player.jumpTo).toHaveBeenCalledWith(2, { autoPlay: false })
    expect(settled).toBe(false) // state still shows the old entry
    player.set({ status: 'buffering', index: 2 } as never)
    player.set({ status: 'ready', index: 2 } as never)
    await pending
    expect(settled).toBe(true)
  })

  it('seekTo waits for ready and retries once on a FRESH state after mpv rejects (device-found race)', async () => {
    const { player } = await harness()
    // First attempt rejects — mpv mid-reload ("error running command").
    player.seekTo.mockRejectedValueOnce(new Error('command failed: error running command'))
    const pending = Promise.resolve(captured.local?.seekTo(156.2))
    await vi.waitFor(() => {
      expect(player.seekTo).toHaveBeenCalledTimes(1)
    })
    // The retry must NOT trust the current snapshot — only a change.
    player.set({ status: 'ready' } as never)
    await pending
    expect(player.seekTo).toHaveBeenCalledTimes(2)
    expect(player.seekTo).toHaveBeenLastCalledWith(156.2)
  })

  it('play propagates the app resume promise (focus gate included), not fire-and-forget', async () => {
    const { resume } = await harness()
    await captured.local?.play()
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('skipToIndex RELOADS a live entry even when already current — live-edge resume (owner-found)', async () => {
    // A live entry paused for the whole cast session resumes minutes behind
    // the live edge from mpv's demuxer cache (and keeps its pre-cast elapsed
    // clock). The restore must reopen it; the never-reload rule stays for
    // finite entries only.
    const player = fakePlayer()
    const liveTracks = TRACKS_FIXTURE.map((track, n) =>
      n === 1 ? ({ ...track, isLive: true } as Track) : track
    )
    const cast = new CastIntegration({
      player: () => player.player,
      queue: () => liveTracks,
      resume: vi.fn(() => Promise.resolve()),
      onReceiverState: () => undefined,
      onRemoteVolume: () => undefined,
      onChange: () => undefined,
    })
    await cast.start()
    let settled = false
    const pending = Promise.resolve(captured.local?.skipToIndex(1)).then(
      () => {
        settled = true
      }
    )
    await Promise.resolve()
    // The player IS on index 1 — a finite entry would return without a jump.
    expect(player.jumpTo).toHaveBeenCalledWith(1, { autoPlay: false })
    // The stale pre-reload 'ready' snapshot must not satisfy the wait: only
    // a fresh state change confirms the reopened entry.
    expect(settled).toBe(false)
    player.set({ status: 'ready', index: 1 } as never)
    await pending
    expect(settled).toBe(true)
  })
})

/* ---------------------------------------------------------------------- */
/*                     mid-handoff transport buffering                    */
/* ---------------------------------------------------------------------- */

describe('transport during handoff-to-cast', () => {
  it('owns playback from handoff-to-cast onward, never sends mid-handoff, flushes on cast-active', async () => {
    const { cast, toPhase } = await harness()
    captured.options?.snapshot() // stamp the handoff snapshot
    toPhase('handoff-to-cast')
    expect(cast.owns).toBe(true)
    expect(cast.controlsPlayback).toBe(false)

    cast.seekTo(30)
    cast.play()
    expect(h.calls).toEqual([]) // nothing reaches the receiver yet

    toPhase('cast-active')
    await vi.waitFor(() => {
      expect(h.calls).toEqual([
        ['Cast.seek', 30],
        ['Cast.play'],
      ])
    })
  })

  it('a cursor move mid-handoff obsoletes an earlier scrub and flushes as one jump', async () => {
    const { cast, toPhase } = await harness()
    captured.options?.snapshot()
    toPhase('handoff-to-cast')

    cast.seekTo(30)
    cast.jumpTo(2) // the scrub was aimed at the old entry — dropped
    toPhase('cast-active')
    await vi.waitFor(() => {
      expect(h.calls).toEqual([['handoff.skipToItem', 2, undefined]])
    })
  })

  it('last-wins: pause after play mid-handoff arrives as a single pause', async () => {
    const { cast, toPhase } = await harness()
    captured.options?.snapshot()
    toPhase('handoff-to-cast')

    cast.play()
    cast.pause()
    toPhase('cast-active')
    await vi.waitFor(() => {
      expect(h.calls).toEqual([['Cast.pause']])
    })
  })

  it('pending intent is forgotten when the handoff falls back to local', async () => {
    const { cast, toPhase } = await harness()
    captured.options?.snapshot()
    toPhase('handoff-to-cast')
    cast.play()
    toPhase('local') // load failed → fallback; the intent must not fire later
    toPhase('handoff-to-cast')
    toPhase('cast-active')
    await Promise.resolve()
    expect(h.calls).toEqual([])
  })
})

/* ---------------------------------------------------------------------- */
/*                            volume ownership                            */
/* ---------------------------------------------------------------------- */

describe('volume while casting', () => {
  it('setVolume drives the receiver DEVICE volume, clamped to 0..1', async () => {
    const { cast } = await harness()
    cast.setVolume(0.4)
    cast.setVolume(1.7)
    await Promise.resolve()
    expect(h.calls).toEqual([
      ['Cast.setDeviceVolume', 0.4],
      ['Cast.setDeviceVolume', 1],
    ])
  })

  it('toggleMuted flips the receiver device mute', async () => {
    const { cast } = await harness()
    cast.toggleMuted()
    await Promise.resolve()
    expect(h.calls).toEqual([['Cast.setDeviceMuted', true]])
  })
})

/* ---------------------------------------------------------------------- */
/*              remote volume: what the media session is told             */
/* ---------------------------------------------------------------------- */

describe('remote playback publishing', () => {
  it('says nothing while the phone owns playback', async () => {
    const { remote } = await harness()
    h.emit.deviceVolume?.({ volume: 0.4, muted: false } as never)

    // Knowing the speaker's volume is not the same as the speaker playing.
    // Publishing here would route the phone's volume keys at a device that is
    // not making the sound.
    expect(remote).toEqual([])
  })

  it('publishes the receiver volume once the cast side owns playback', async () => {
    const { toPhase, remote } = await harness()
    h.emit.deviceVolume?.({ volume: 0.4, muted: false } as never)
    toPhase('handoff-to-cast')

    expect(remote).toEqual([{ volume: 0.4, muted: false }])
  })

  it('republishes every receiver volume change — the speaker\'s own knob included', async () => {
    const { toPhase, remote } = await harness()
    h.emit.deviceVolume?.({ volume: 0.4, muted: false } as never)
    toPhase('cast-active')
    remote.length = 0

    h.emit.deviceVolume?.({ volume: 0.45, muted: false } as never)
    h.emit.deviceVolume?.({ volume: 0.45, muted: true } as never)

    // A hardware key press steps ONE notch from the last published level, so a
    // stale one makes the first press after somebody touched the speaker jump
    // to the wrong place.
    expect(remote).toEqual([
      { volume: 0.45, muted: false },
      { volume: 0.45, muted: true },
    ])
  })

  it('hands the keys back to the phone exactly once when casting ends', async () => {
    const { toPhase, remote } = await harness()
    h.emit.deviceVolume?.({ volume: 0.4, muted: false } as never)
    toPhase('cast-active')
    remote.length = 0

    toPhase('handoff-to-local')
    toPhase('local')

    expect(remote).toEqual([undefined])
  })

  it('reads the level from the receiver when ownership moves before any event', async () => {
    // Device-found: the Cast framework RESUMES an existing session at
    // `CastContext` init, so the `castState → connected` transition where the
    // priming read lives never fires — and the event stream only reports
    // *changes*. Without asking, the session stayed `volumeType=LOCAL` for the
    // whole cast and the volume keys kept moving the phone's stream.
    const { toPhase, remote } = await harness()
    toPhase('handoff-to-cast')

    await vi.waitFor(() => {
      expect(remote).toEqual([{ volume: 0.5, muted: false }])
    })
  })

  it('asks the receiver once, however many ticks arrive while it answers', async () => {
    // `#publishRemote` runs on every phase tick and every receiver status; a
    // burst of round trips to answer one question would be a bug of its own.
    const original = h.fakeCast.getDeviceVolume
    const reads: number[] = []
    h.fakeCast.getDeviceVolume = () => {
      reads.push(1)
      return Promise.resolve({ volume: 0.5, muted: false })
    }
    try {
      const { toPhase } = await harness()
      toPhase('handoff-to-cast')
      toPhase('cast-active')

      await vi.waitFor(() => {
        expect(reads).toHaveLength(1)
      })
    } finally {
      h.fakeCast.getDeviceVolume = original
    }
  })
})

/* ---------------------------------------------------------------------- */
/*                        mute, as its own command                        */
/* ---------------------------------------------------------------------- */

describe('setMuted', () => {
  it('drives the receiver directly rather than toggling a local guess', async () => {
    const { cast } = await harness()
    cast.setMuted(true)
    cast.setMuted(false)

    expect(h.calls).toEqual([
      ['Cast.setDeviceMuted', true],
      ['Cast.setDeviceMuted', false],
    ])
  })
})
