/**
 * `wireCastHandoff` against the same fake hybrid the facade tests use — this
 * suite proves the impure half: native events reach the machine, effects reach
 * the `CastApi` and the local player, completions loop back, and everything
 * the app needs surfaces through the option callbacks.
 */
import { describe, expect, it, vi } from 'vitest'
import { createCast } from '../cast'
import { CastError } from '../errors'
import { wireCastHandoff, type CastHandoffLocalPlayer } from '../handoff'
import type {
  CastHandoffPhase,
  CastHandoffQueueSnapshot,
  CastReceiverSnapshot,
  CastTransferEvent,
  SkippedCastItem,
} from '../handoff-machine'
import { FakeNativeCast, playingStatus } from './fakes'

/** Structural fake of the app's local player: a call log plus a tiny clock. */
class FakeLocalPlayer implements CastHandoffLocalPlayer {
  readonly calls: Array<[string, ...unknown[]]> = []
  playing = true
  position = 42.5
  failNext: string | undefined

  play(): void {
    this.record('play')
    this.playing = true
  }
  pause(): void {
    this.record('pause')
    this.playing = false
  }
  seekTo(seconds: number): void {
    this.record('seekTo', seconds)
    this.position = seconds
  }
  skipToIndex(index: number): void {
    this.record('skipToIndex', index)
  }
  getPosition(): number {
    return this.position
  }
  isPlaying(): boolean {
    return this.playing
  }

  private record(name: string, ...args: unknown[]): void {
    if (this.failNext === name) {
      this.failNext = undefined
      throw new Error(`${name} failed`)
    }
    this.calls.push([name, ...args])
  }
}

function snapshot(
  overrides: Partial<CastHandoffQueueSnapshot> = {}
): CastHandoffQueueSnapshot {
  return {
    items: [
      { id: 'a', url: 'https://cdn.example.com/a.mp3', mimeType: 'audio/mpeg' },
      { id: 'b', url: 'file:///sdcard/b.mp3', mimeType: 'audio/mpeg' },
      { id: 'c', url: 'https://cdn.example.com/c.mp3', mimeType: 'audio/mpeg' },
    ],
    index: 0,
    position: 42.5,
    playWhenReady: true,
    ...overrides,
  }
}

function harness(snapshotOverrides: Partial<CastHandoffQueueSnapshot> = {}) {
  const native = new FakeNativeCast()
  native.castState = 'idle'
  native.queueItemIds = [11, 12]
  const cast = createCast(native)
  const local = new FakeLocalPlayer()
  const phases: CastHandoffPhase[] = []
  const transfers: CastTransferEvent[] = []
  const receiverStates: CastReceiverSnapshot[] = []
  const skipped: SkippedCastItem[][] = []
  const errors: CastError[] = []
  let clock = 1_000

  const handoff = wireCastHandoff(local, {
    cast,
    snapshot: () => snapshot(snapshotOverrides),
    onPhaseChange: (phase) => phases.push(phase),
    onTransfer: (transfer) => transfers.push(transfer),
    onReceiverState: (state) => receiverStates.push(state),
    onItemsSkipped: (items) => skipped.push([...items]),
    onError: (error) => errors.push(error),
    now: () => clock,
  })

  return {
    native,
    cast,
    local,
    handoff,
    phases,
    transfers,
    receiverStates,
    skipped,
    errors,
    tick: (ms: number) => {
      clock += ms
    },
    /** Drive the fake through session start → queueLoad ack → first status. */
    async toCastActive() {
      const connect = handoff.castTo('dev-1')
      native.emitSession({
        type: 'started',
        device: { id: 'dev-1', name: 'Speaker' },
      })
      await connect
      await flush()
      native.emitMediaStatus(
        playingStatus({ currentItemId: 11, position: 42.5 })
      )
      await flush()
    },
  }
}

/** Let queued microtasks (effect executors) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

describe('wireCastHandoff — the happy path', () => {
  it('castTo drives requestSession, pauses local, loads the projection and reaches cast-active', async () => {
    const h = harness()
    const connect = h.handoff.castTo('dev-1')
    expect(h.native.calls).toContainEqual(['requestSession', 'dev-1'])
    expect(h.phases).toEqual(['connecting'])

    h.native.emitSession({ type: 'started' })
    await connect
    await flush()

    // Local paused before the receiver queue was loaded.
    expect(h.local.calls[0]).toEqual(['pause'])
    const load = h.native.calls.find(([name]) => name === 'queueLoad')
    expect(load).toBeDefined()
    expect(load?.[2]).toMatchObject({ startIndex: 0, startPosition: 42.5 })
    // The non-castable item was skipped and surfaced.
    expect(h.skipped[0]?.[0]).toMatchObject({ index: 1, reason: 'local-file' })
    expect(h.phases).toEqual(['connecting', 'handoff-to-cast'])

    h.native.emitMediaStatus(
      playingStatus({ currentItemId: 11, position: 42.6 })
    )
    await flush()
    expect(h.phases).toEqual(['connecting', 'handoff-to-cast', 'cast-active'])
    expect(h.transfers).toEqual([
      { direction: 'toCast', position: 42.6, itemIndex: 0 },
    ])
    expect(h.receiverStates[0]).toMatchObject({ itemIndex: 0, playing: true })
    expect(h.handoff.receiverItemIndex).toBe(0)
  })

  it('receiver statuses keep flowing as reconciled snapshots', async () => {
    const h = harness()
    await h.toCastActive()
    h.tick(1_000)
    h.native.emitMediaStatus(playingStatus({ currentItemId: 12, position: 3 }))
    await flush()
    const last = h.receiverStates.at(-1)
    // Receiver id 12 is projection position 1 → JS index 2 (js 1 was skipped).
    expect(last).toMatchObject({ itemIndex: 2, position: 3, at: 2_000 })
    expect(h.handoff.receiverItemIndex).toBe(2)
  })

  it('stopCasting stops the receiver, restores local at the projected position, resolves in local', async () => {
    const h = harness()
    await h.toCastActive()
    h.tick(9_000) // anchor 42.5 @1000, rate 1 → 51.5 at end time

    const done = h.handoff.stopCasting()
    expect(h.native.calls).toContainEqual(['endSession', true])
    h.native.emitSession({ type: 'ended' })
    await flush()
    await done

    expect(h.handoff.phase).toBe('local')
    expect(h.transfers.at(-1)).toEqual({
      direction: 'toLocal',
      position: 51.5,
      itemIndex: 0,
    })
    expect(h.local.calls).toContainEqual(['skipToIndex', 0])
    expect(h.local.calls).toContainEqual(['seekTo', 51.5])
    expect(h.local.calls.at(-1)).toEqual(['play'])
  })

  it('stopCasting({transferBackToLocal: false}) disconnects and leaves local untouched', async () => {
    const h = harness()
    await h.toCastActive()
    const pausesBefore = h.local.calls.length

    const done = h.handoff.stopCasting({ transferBackToLocal: false })
    expect(h.native.calls).toContainEqual(['endSession', false])
    h.native.emitSession({ type: 'ended' })
    await flush()
    await done

    expect(h.handoff.phase).toBe('local')
    expect(h.local.calls.length).toBe(pausesBefore)
    expect(h.transfers.filter((t) => t.direction === 'toLocal')).toEqual([])
  })

  it('a live handoff loads the receiver queue at the live edge — no start position (device-found)', async () => {
    const h = harness({
      items: [
        {
          id: 'radio',
          url: 'https://radio.example.com/stream',
          mimeType: 'audio/aacp',
          live: true,
        },
        {
          id: 'song',
          url: 'https://cdn.example.com/c.mp3',
          mimeType: 'audio/mpeg',
        },
      ],
      index: 0,
      position: 4_321.5, // mpv's live clock — a stream-timeline offset
    })
    const connect = h.handoff.castTo('dev-1')
    h.native.emitSession({ type: 'started' })
    await connect
    await flush()
    const load = h.native.calls.find(([name]) => name === 'queueLoad')
    expect(load?.[2]).toMatchObject({ startIndex: 0, startPosition: 0 })
  })

  it('a live transfer-back never seeks mpv — the receiver live clock is not a position', async () => {
    const h = harness({
      items: [
        {
          id: 'radio',
          url: 'https://radio.example.com/stream',
          mimeType: 'audio/aacp',
          live: true,
        },
        {
          id: 'song',
          url: 'https://cdn.example.com/c.mp3',
          mimeType: 'audio/mpeg',
        },
      ],
      index: 0,
      position: 4_321.5,
    })
    await h.toCastActive()
    h.tick(9_000)

    const done = h.handoff.stopCasting()
    h.native.emitSession({ type: 'ended' })
    await flush()
    await done

    expect(h.handoff.phase).toBe('local')
    expect(h.local.calls).toContainEqual(['skipToIndex', 0])
    // The one behavioural difference from a finite restore: no seek. mpv
    // rejects seeks on unseekable live streams ("Cannot seek in this
    // stream"), and reopening at the live edge IS the resume.
    expect(h.local.calls.filter(([name]) => name === 'seekTo')).toEqual([])
    expect(h.local.calls.at(-1)).toEqual(['play'])
  })

  it('a paused handoff restores paused: no play() on transfer back', async () => {
    const h = harness({ playWhenReady: false })
    h.local.playing = false
    const connect = h.handoff.castTo('dev-1')
    h.native.emitSession({ type: 'started' })
    await connect
    await flush()
    h.native.emitMediaStatus(
      playingStatus({ currentItemId: 11, playerState: 'paused' })
    )
    await flush()
    expect(h.handoff.phase).toBe('cast-active')

    const done = h.handoff.stopCasting()
    h.native.emitSession({ type: 'ended' })
    await flush()
    await done
    expect(h.local.calls.filter(([name]) => name === 'play')).toEqual([])
  })
})

describe('wireCastHandoff — platform-initiated paths', () => {
  it('a switcher/picker-initiated session start triggers the same handoff', async () => {
    const h = harness()
    h.native.emitSession({ type: 'started' })
    await flush()
    expect(h.phases).toEqual(['handoff-to-cast'])
    expect(h.local.calls[0]).toEqual(['pause'])
  })

  it('an unsolicited session end mid-cast transfers back at the last projected position', async () => {
    const h = harness()
    await h.toCastActive()
    h.tick(4_000)
    h.native.emitSession({ type: 'ended' })
    await flush()
    expect(h.handoff.phase).toBe('local')
    expect(h.transfers.at(-1)).toEqual({
      direction: 'toLocal',
      position: 46.5,
      itemIndex: 0,
    })
    expect(h.local.calls).toContainEqual(['seekTo', 46.5])
  })

  it('castTo on an already-connected session reuses it — no second requestSession', async () => {
    const h = harness()
    h.native.castState = 'connected'
    await h.handoff.castTo('dev-1')
    await flush()
    expect(
      h.native.calls.filter(([name]) => name === 'requestSession')
    ).toEqual([])
    expect(h.handoff.phase).toBe('handoff-to-cast')
  })

  it('a session existing before wiring is left alone until castTo', () => {
    const native = new FakeNativeCast()
    native.castState = 'connected'
    const cast = createCast(native)
    const local = new FakeLocalPlayer()
    const handoff = wireCastHandoff(local, { cast, snapshot: () => snapshot() })
    expect(handoff.phase).toBe('local')
    expect(local.calls).toEqual([])
    handoff.dispose()
  })
})

describe('wireCastHandoff — error fallbacks', () => {
  it('requestSession rejection falls back to local with the typed error', async () => {
    const h = harness()
    h.native.rejectWith = '[session-start-failed] status=2451'
    await expect(h.handoff.castTo('dev-1')).rejects.toMatchObject({
      code: 'session-start-failed',
    })
    await flush()
    expect(h.handoff.phase).toBe('local')
    expect(h.errors[0]?.code).toBe('session-start-failed')
  })

  it('a startFailed session event carries its status code into the error', async () => {
    const h = harness()
    void h.handoff.castTo('dev-1')
    h.native.emitSession({ type: 'startFailed', errorCode: 15 })
    await flush()
    expect(h.handoff.phase).toBe('local')
    expect(h.errors[0]).toMatchObject({
      code: 'session-start-failed',
      statusCode: 15,
    })
  })

  it('queueLoad failure restores local at the pre-handoff snapshot', async () => {
    const h = harness()
    const connect = h.handoff.castTo('dev-1')
    h.native.rejectWith = '[load-failed] queueLoad failed, status=2100'
    h.native.emitSession({ type: 'started' })
    await connect
    await flush()
    expect(h.handoff.phase).toBe('local')
    expect(h.errors[0]?.code).toBe('load-failed')
    expect(h.local.calls).toContainEqual(['skipToIndex', 0])
    expect(h.local.calls).toContainEqual(['seekTo', 42.5])
    expect(h.local.calls.at(-1)).toEqual(['play'])
  })

  it('a receiver fetch error while cast-active surfaces and the session survives', async () => {
    const h = harness()
    await h.toCastActive()
    h.native.emitMediaError({ detailedErrorCode: 104, reason: 'ERROR_FETCH' })
    await flush()
    expect(h.errors[0]?.code).toBe('cast-receiver-fetch')
    expect(h.handoff.phase).toBe('cast-active')
  })

  it('nothing castable: local playback is never touched and the error is typed', async () => {
    const h = harness({
      items: [{ id: 'x', url: 'file:///x.mp3', mimeType: 'audio/mpeg' }],
    })
    const connect = h.handoff.castTo('dev-1')
    h.native.emitSession({ type: 'started' })
    await connect
    await flush()
    expect(h.handoff.phase).toBe('local')
    expect(h.errors[0]?.code).toBe('no-castable-media')
    expect(h.local.calls).toEqual([])
  })

  it('a failing local restore still lands in local, with the failure surfaced', async () => {
    const h = harness()
    await h.toCastActive()
    h.local.failNext = 'seekTo'
    const done = h.handoff.stopCasting()
    h.native.emitSession({ type: 'ended' })
    await flush()
    await done
    expect(h.handoff.phase).toBe('local')
    expect(h.errors.some((e) => e.raw?.includes('seekTo failed'))).toBe(true)
  })

  it('endSession rejecting with no-session is tolerated (the end already happened)', async () => {
    const h = harness()
    await h.toCastActive()
    h.native.rejectWith = '[no-session] No connected cast session.'
    const done = h.handoff.stopCasting()
    h.native.rejectWith = undefined
    h.native.emitSession({ type: 'ended' })
    await flush()
    await done
    expect(h.handoff.phase).toBe('local')
    expect(h.errors.filter((e) => e.code === 'no-session')).toEqual([])
  })
})

describe('wireCastHandoff — guards and lifecycle', () => {
  it('castTo outside local rejects invalid-state', async () => {
    const h = harness()
    await h.toCastActive()
    await expect(h.handoff.castTo('dev-2')).rejects.toMatchObject({
      code: 'invalid-state',
    })
  })

  it('stopCasting is idempotent in local and rejects mid-handoff', async () => {
    const h = harness()
    await expect(h.handoff.stopCasting()).resolves.toBeUndefined()
    void h.handoff.castTo('dev-1')
    await expect(h.handoff.stopCasting()).rejects.toMatchObject({
      code: 'invalid-state',
    })
  })

  it('dispose detaches every native listener and stops all callbacks', async () => {
    const h = harness()
    await h.toCastActive()
    h.handoff.dispose()
    const counts = h.native.listenerCounts()
    expect(Object.values(counts).every((n) => n === 0)).toBe(true)
    const before = h.receiverStates.length
    h.native.emitMediaStatus(playingStatus())
    await flush()
    expect(h.receiverStates.length).toBe(before)
  })

  it('onError defaults to console.error — errors are never swallowed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const native = new FakeNativeCast()
    const cast = createCast(native)
    const handoff = wireCastHandoff(new FakeLocalPlayer(), {
      cast,
      snapshot: () => snapshot(),
    })
    native.emitMediaError({ reason: 'ERROR_FETCH' })
    await flush()
    expect(spy).toHaveBeenCalled()
    handoff.dispose()
    spy.mockRestore()
  })
})

describe('wireCastHandoff — receiver transport over the mapping', () => {
  it('skipToNext jumps to the next castable receiver item', async () => {
    const h = harness()
    await h.toCastActive()
    await h.handoff.skipToNext()
    expect(h.native.calls).toContainEqual(['queueJumpTo', 12, undefined])
  })

  it('skipToPrevious from the first item rejects — nothing in that direction', async () => {
    const h = harness()
    await h.toCastActive()
    await expect(h.handoff.skipToPrevious()).rejects.toMatchObject({
      code: 'invalid-argument',
    })
  })

  it('skipToItem maps a JS index through the projection', async () => {
    const h = harness()
    await h.toCastActive()
    await h.handoff.skipToItem(2, 30)
    expect(h.native.calls).toContainEqual(['queueJumpTo', 12, 30])
  })

  it('skipToItem on a non-castable JS index rejects with invalid-argument', async () => {
    const h = harness()
    await h.toCastActive()
    await expect(h.handoff.skipToItem(1)).rejects.toMatchObject({
      code: 'invalid-argument',
    })
  })

  it('receiver transport outside cast-active rejects invalid-state', async () => {
    const h = harness()
    await expect(h.handoff.skipToNext()).rejects.toMatchObject({
      code: 'invalid-state',
    })
  })
})

describe('wireCastHandoff — the sender-mirror lag (device-found)', () => {
  it('an empty ids read at the load ack is healed by the queueChanged refresh', async () => {
    const h = harness()
    h.native.queueItemIds = [] // mirror not populated yet — the real timing
    await h.toCastActive()

    // Mapping dead: every receiver jump rejects.
    await expect(h.handoff.skipToItem(2)).rejects.toMatchObject({
      code: 'invalid-argument',
    })

    // The mirror fills in and fires its queueChanged.
    h.native.queueItemIds = [11, 12]
    h.native.emitQueueChanged()
    await flush()

    await h.handoff.skipToItem(2)
    expect(h.native.calls).toContainEqual(['queueJumpTo', 12, undefined])
    // Reconciliation heals too.
    h.native.emitMediaStatus(playingStatus({ currentItemId: 12 }))
    await flush()
    expect(h.handoff.receiverItemIndex).toBe(2)
  })

  it('queueChanged outside a session phase reads nothing', async () => {
    const h = harness()
    h.native.emitQueueChanged()
    await flush()
    expect(h.native.calls.filter(([name]) => name === 'getQueueItemIds')).toEqual(
      []
    )
  })
})

describe('wireCastHandoff — the bounded handoff (device-found hang)', () => {
  it('a queueLoad that never settles falls back to LOCAL with a typed load-failed', async () => {
    // The real shape (POCO F4, rejoined session): the PendingResult of a
    // queueLoad issued right after rejoining a running receiver app never
    // fired — no ack, no error, machine stuck in handoff-to-cast forever.
    const native = new FakeNativeCast()
    native.castState = 'idle'
    native.hangCommand = 'queueLoad'
    const cast = createCast(native)
    const local = new FakeLocalPlayer()
    const phases: CastHandoffPhase[] = []
    const errors: CastError[] = []
    const handoff = wireCastHandoff(local, {
      cast,
      snapshot: () => snapshot(),
      onPhaseChange: (phase) => phases.push(phase),
      onError: (error) => errors.push(error),
      handoffTimeoutMs: 25,
    })

    const connect = handoff.castTo('dev-1')
    native.emitSession({
      type: 'started',
      device: { id: 'dev-1', name: 'Speaker' },
    })
    await connect
    await flush()
    expect(handoff.phase).toBe('handoff-to-cast')

    // Real timer, tiny bound: the fallback must fire on its own.
    await new Promise((resolve) => setTimeout(resolve, 60))
    await flush()

    expect(handoff.phase).toBe('local')
    expect(errors.map((e) => e.code)).toContain('load-failed')
    // Restored at the pre-handoff snapshot: cursor, clock, intent.
    expect(local.calls).toContainEqual(['skipToIndex', 0])
    expect(local.calls).toContainEqual(['seekTo', 42.5])
    expect(local.calls).toContainEqual(['play'])
    handoff.dispose()
  })

  it('a completed handoff never fires the bound — the timer dies with the phase', async () => {
    const h = harness()
    await h.toCastActive()
    await new Promise((resolve) => setTimeout(resolve, 40))
    await flush()
    expect(h.handoff.phase).toBe('cast-active')
    expect(h.errors).toEqual([])
  })
})

describe('wireCastHandoff — queue resync', () => {
  it('syncQueue reloads the projection anchored at the receiver clock and swaps the mapping on ack', async () => {
    const h = harness()
    await h.toCastActive()
    h.tick(2_000)
    h.native.queueItemIds = [21, 22]
    h.handoff.syncQueue()
    await flush()
    const loads = h.native.calls.filter(([name]) => name === 'queueLoad')
    expect(loads).toHaveLength(2)
    expect(loads[1]?.[2]).toMatchObject({ startIndex: 0, startPosition: 44.5 })
    // The new mapping is live: receiver id 22 → JS index 2.
    h.native.emitMediaStatus(playingStatus({ currentItemId: 22 }))
    await flush()
    expect(h.handoff.receiverItemIndex).toBe(2)
  })

  it('syncQueue outside cast-active is a no-op', () => {
    const h = harness()
    h.handoff.syncQueue()
    expect(h.native.calls.filter(([name]) => name === 'queueLoad')).toEqual([])
  })
})
