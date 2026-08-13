/**
 * The handoff state machine, transition by transition — cast.md §3 is the
 * spec, and this suite is its row-by-row proof: every phase × every meaningful
 * event, every error fallback, the reconciliation mapping, and the
 * non-castable skip rules.
 */
import { describe, expect, it } from 'vitest'
import { CastError } from '../errors'
import {
  initialCastHandoffState,
  projectCastQueue,
  projectReceiverPosition,
  reduceCastHandoff,
  type CastHandoffEvent,
  type CastHandoffQueueItem,
  type CastHandoffQueueSnapshot,
  type CastHandoffState,
  type CastHandoffTransition,
} from '../handoff-machine'
import { playingStatus } from './fakes'

/* ---------------------------------------------------------------------- */
/*                               fixtures                                 */
/* ---------------------------------------------------------------------- */

function item(
  id: string,
  overrides: Partial<CastHandoffQueueItem> = {}
): CastHandoffQueueItem {
  return {
    id,
    url: `https://cdn.example.com/${id}.mp3`,
    mimeType: 'audio/mpeg',
    metadata: { title: id },
    ...overrides,
  }
}

/** 4 items: [0] castable, [1] local file, [2] castable, [3] castable. */
function mixedSnapshot(
  overrides: Partial<CastHandoffQueueSnapshot> = {}
): CastHandoffQueueSnapshot {
  return {
    items: [
      item('a'),
      item('b-local', { url: 'file:///sdcard/b.mp3' }),
      item('c'),
      item('d'),
    ],
    index: 0,
    position: 42.5,
    playWhenReady: true,
    ...overrides,
  }
}

function allCastableSnapshot(
  overrides: Partial<CastHandoffQueueSnapshot> = {}
): CastHandoffQueueSnapshot {
  return {
    items: [item('a'), item('b'), item('c')],
    index: 1,
    position: 10,
    playWhenReady: true,
    ...overrides,
  }
}

/** Drive the machine through a sequence, returning the final transition. */
function drive(
  events: readonly CastHandoffEvent[],
  from: CastHandoffState = initialCastHandoffState
): CastHandoffTransition {
  let state = from
  let last: CastHandoffTransition = { state, effects: [] }
  for (const event of events) {
    last = reduceCastHandoff(state, event)
    state = last.state
  }
  return last
}

const started = (
  snapshot: CastHandoffQueueSnapshot,
  at = 1_000
): CastHandoffEvent => ({ type: 'sessionStarted', snapshot, at })

const loaded = (itemIds: readonly number[], at = 1_100): CastHandoffEvent => ({
  type: 'castQueueLoaded',
  itemIds,
  at,
})

const status = (
  overrides: Parameters<typeof playingStatus>[0] = {},
  at = 1_200
): CastHandoffEvent => ({
  type: 'mediaStatus',
  status: playingStatus(overrides),
  at,
})

/** LOCAL → CAST_ACTIVE with the mixed queue: ids [11, 12, 13] ↔ js [0, 2, 3]. */
function activeState(): CastHandoffState {
  return drive([
    started(mixedSnapshot()),
    loaded([11, 12, 13]),
    status({ currentItemId: 11, position: 42.5 }),
  ]).state
}

function effectsOf(t: CastHandoffTransition): string[] {
  return t.effects.map((e) => e.type)
}

function findEffect<T extends string>(
  t: CastHandoffTransition,
  type: T
): Extract<CastHandoffTransition['effects'][number], { type: T }> {
  const effect = t.effects.find((e) => e.type === type)
  if (effect === undefined) throw new Error(`no ${type} effect emitted`)
  return effect as Extract<
    CastHandoffTransition['effects'][number],
    { type: T }
  >
}

/* ---------------------------------------------------------------------- */
/*                          projectCastQueue                              */
/* ---------------------------------------------------------------------- */

describe('projectCastQueue', () => {
  it('maps an all-castable queue 1:1 and keeps the cursor and position', () => {
    const p = projectCastQueue(allCastableSnapshot())
    expect(p.items).toHaveLength(3)
    expect(p.jsIndices).toEqual([0, 1, 2])
    expect(p.skipped).toEqual([])
    expect(p.startIndex).toBe(1)
    expect(p.startPosition).toBe(10)
    expect(p.startShifted).toBe(false)
  })

  it('skips local files with the typed reason', () => {
    const p = projectCastQueue(mixedSnapshot())
    expect(p.jsIndices).toEqual([0, 2, 3])
    expect(p.skipped).toEqual([
      expect.objectContaining({ index: 1, reason: 'local-file' }),
    ])
  })

  it('skips header-auth sources with reason "headers"', () => {
    const p = projectCastQueue({
      ...allCastableSnapshot(),
      items: [item('a'), item('b', { headers: { Authorization: 'Bearer x' } })],
      index: 0,
    })
    expect(p.jsIndices).toEqual([0])
    expect(p.skipped[0]?.reason).toBe('headers')
  })

  it('skips receiver-undecodable codecs with reason "codec"', () => {
    const p = projectCastQueue({
      ...allCastableSnapshot(),
      items: [item('a'), item('b-wma', { mimeType: 'audio/x-ms-wma' })],
      index: 0,
    })
    expect(p.jsIndices).toEqual([0])
    expect(p.skipped[0]?.reason).toBe('codec')
  })

  it('shifts the start to the next castable item — and resets the position', () => {
    const p = projectCastQueue(mixedSnapshot({ index: 1, position: 30 }))
    // js index 1 is the local file; next castable is js 2 = projection 1.
    expect(p.startIndex).toBe(1)
    expect(p.jsIndices[p.startIndex]).toBe(2)
    expect(p.startPosition).toBe(0)
    expect(p.startShifted).toBe(true)
  })

  it('wraps to the first castable item when nothing follows the cursor', () => {
    const p = projectCastQueue({
      items: [item('a'), item('b'), item('z-local', { url: '/local/z.flac' })],
      index: 2,
      position: 5,
      playWhenReady: true,
    })
    expect(p.startIndex).toBe(0)
    expect(p.jsIndices[p.startIndex]).toBe(0)
    expect(p.startShifted).toBe(true)
    expect(p.startPosition).toBe(0)
  })

  it('projects an empty queue when nothing is castable', () => {
    const p = projectCastQueue({
      items: [
        item('a', { url: 'file:///a.mp3' }),
        item('b', { url: 'content://b' }),
      ],
      index: 0,
      position: 0,
      playWhenReady: true,
    })
    expect(p.items).toHaveLength(0)
    expect(p.skipped).toHaveLength(2)
  })

  it('honours playWhenReady on the start item only (receiver-side autoplay elsewhere)', () => {
    const p = projectCastQueue(allCastableSnapshot({ playWhenReady: false }))
    expect(p.items.map((i) => i.autoplay)).toEqual([true, false, true])
  })

  it('forwards metadata, duration and live per source — the projection names its fields', () => {
    const p = projectCastQueue({
      items: [
        item('live', {
          url: 'https://radio.example.com/stream',
          mimeType: 'audio/aac',
          live: true,
          metadata: {
            title: 'Live',
            artist: 'Station',
            artworkUrl: 'https://x/a.png',
          },
        }),
        item('finite', { duration: 180 }),
      ],
      index: 0,
      position: 0,
      playWhenReady: true,
    })
    expect(p.items[0]?.source).toMatchObject({
      live: true,
      metadata: { title: 'Live', artist: 'Station' },
    })
    expect(p.items[1]?.source.duration).toBe(180)
  })
})

describe('projectReceiverPosition', () => {
  it('advances the anchor by elapsed × rate', () => {
    expect(
      projectReceiverPosition({ position: 10, at: 1_000, rate: 1 }, 6_000)
    ).toBe(15)
  })
  it('is frozen at rate 0', () => {
    expect(
      projectReceiverPosition({ position: 10, at: 1_000, rate: 0 }, 99_000)
    ).toBe(10)
  })
  it('never projects backwards from a clock that reads earlier than the anchor', () => {
    expect(
      projectReceiverPosition({ position: 10, at: 5_000, rate: 1 }, 1_000)
    ).toBe(10)
  })
})

/* ---------------------------------------------------------------------- */
/*                                 LOCAL                                  */
/* ---------------------------------------------------------------------- */

describe('LOCAL', () => {
  it('start → CONNECTING with a connect effect', () => {
    const t = reduceCastHandoff(initialCastHandoffState, {
      type: 'start',
      deviceId: 'dev-1',
    })
    expect(t.state.phase).toBe('connecting')
    expect(t.effects).toEqual([{ type: 'connect', deviceId: 'dev-1' }])
  })

  it('sessionStarted (switcher-pick path) → HANDOFF_TO_CAST: pause, then load the projection', () => {
    const t = reduceCastHandoff(
      initialCastHandoffState,
      started(allCastableSnapshot())
    )
    expect(t.state.phase).toBe('handoff-to-cast')
    expect(effectsOf(t)).toEqual(['pauseLocal', 'loadCastQueue'])
    const load = findEffect(t, 'loadCastQueue')
    expect(load.startIndex).toBe(1)
    expect(load.startPosition).toBe(10)
  })

  it('sessionStarted with skips also notifies them — typed, never silent', () => {
    const t = reduceCastHandoff(
      initialCastHandoffState,
      started(mixedSnapshot())
    )
    expect(effectsOf(t)).toEqual([
      'pauseLocal',
      'notifySkipped',
      'loadCastQueue',
    ])
    expect(findEffect(t, 'notifySkipped').skipped[0]?.reason).toBe('local-file')
  })

  it('sessionStarted with nothing castable stays LOCAL, touches nothing, emits no-castable-media', () => {
    const t = reduceCastHandoff(
      initialCastHandoffState,
      started({
        items: [item('a', { url: 'file:///a.mp3' })],
        index: 0,
        position: 3,
        playWhenReady: true,
      })
    )
    expect(t.state.phase).toBe('local')
    expect(effectsOf(t)).toEqual(['emitError'])
    const error = findEffect(t, 'emitError').error
    expect(error).toBeInstanceOf(CastError)
    expect(error.code).toBe('no-castable-media')
  })

  it('castError is forwarded, not swallowed — already local, nothing to fall back from', () => {
    const error = new CastError('cast-receiver-fetch', 'x')
    const t = reduceCastHandoff(initialCastHandoffState, {
      type: 'castError',
      error,
    })
    expect(t.state.phase).toBe('local')
    expect(t.effects).toEqual([{ type: 'emitError', error }])
  })

  it('ignores mediaStatus, sessionEnded, end, resync and restore completions', () => {
    for (const event of [
      status(),
      { type: 'sessionEnded', at: 1 },
      { type: 'end', transferBack: true, at: 1 },
      { type: 'resync', snapshot: allCastableSnapshot(), at: 1 },
      { type: 'localRestored' },
      { type: 'localRestoreFailed', error: new CastError('native', 'x') },
      { type: 'sessionSuspended', at: 1 },
      { type: 'castQueueLoaded', itemIds: [1], at: 1 },
      { type: 'castQueueLoadFailed', error: new CastError('load-failed', 'x') },
      {
        type: 'sessionStartFailed',
        error: new CastError('session-start-failed', 'x'),
      },
    ] as const satisfies readonly CastHandoffEvent[]) {
      const t = reduceCastHandoff(initialCastHandoffState, event)
      expect(t.state.phase).toBe('local')
      expect(t.effects).toEqual([])
    }
  })
})

/* ---------------------------------------------------------------------- */
/*                               CONNECTING                               */
/* ---------------------------------------------------------------------- */

describe('CONNECTING', () => {
  const connecting = reduceCastHandoff(initialCastHandoffState, {
    type: 'start',
    deviceId: 'dev-1',
  }).state

  it('sessionStarted → HANDOFF_TO_CAST (same handoff as the switcher path)', () => {
    const t = reduceCastHandoff(connecting, started(allCastableSnapshot()))
    expect(t.state.phase).toBe('handoff-to-cast')
    expect(effectsOf(t)).toEqual(['pauseLocal', 'loadCastQueue'])
  })

  it('sessionStartFailed → LOCAL with the typed error', () => {
    const error = new CastError('session-start-failed', 'x', {
      statusCode: 2451,
    })
    const t = reduceCastHandoff(connecting, {
      type: 'sessionStartFailed',
      error,
    })
    expect(t.state.phase).toBe('local')
    expect(t.effects).toEqual([{ type: 'emitError', error }])
  })

  it('sessionEnded (picker cancelled) → LOCAL silently — a cancel is not an error', () => {
    const t = reduceCastHandoff(connecting, { type: 'sessionEnded', at: 1 })
    expect(t.state.phase).toBe('local')
    expect(t.effects).toEqual([])
  })

  it('castError → LOCAL (any → error falls back) with the error surfaced', () => {
    const error = new CastError('native', 'boom')
    const t = reduceCastHandoff(connecting, { type: 'castError', error })
    expect(t.state.phase).toBe('local')
    expect(t.effects).toEqual([{ type: 'emitError', error }])
  })

  it('a second start is ignored — one session request at a time', () => {
    const t = reduceCastHandoff(connecting, {
      type: 'start',
      deviceId: 'dev-2',
    })
    expect(t.state.phase).toBe('connecting')
    expect(t.effects).toEqual([])
  })
})

/* ---------------------------------------------------------------------- */
/*                            HANDOFF_TO_CAST                             */
/* ---------------------------------------------------------------------- */

describe('HANDOFF_TO_CAST', () => {
  const handingOff = reduceCastHandoff(
    initialCastHandoffState,
    started(mixedSnapshot())
  ).state

  it('castQueueLoaded records the receiver item ids and awaits the first status', () => {
    const t = reduceCastHandoff(handingOff, loaded([11, 12, 13]))
    expect(t.state.phase).toBe('handoff-to-cast')
    expect(t.effects).toEqual([])
  })

  it('mediaStatus before the queueLoad ack is ignored (no mapping yet)', () => {
    const t = reduceCastHandoff(handingOff, status({ currentItemId: 11 }))
    expect(t.state.phase).toBe('handoff-to-cast')
    expect(t.effects).toEqual([])
  })

  it('receiver playing completes the handoff: CAST_ACTIVE + one toCast transfer + a receiver snapshot', () => {
    const t = drive(
      [loaded([11, 12, 13]), status({ currentItemId: 11, position: 42.6 })],
      handingOff
    )
    expect(t.state.phase).toBe('cast-active')
    expect(effectsOf(t)).toEqual(['emitTransfer', 'emitReceiverState'])
    expect(findEffect(t, 'emitTransfer').transfer).toEqual({
      direction: 'toCast',
      position: 42.6,
      itemIndex: 0,
    })
    const snapshot = findEffect(t, 'emitReceiverState').snapshot
    expect(snapshot.playing).toBe(true)
    expect(snapshot.rate).toBe(1)
    expect(snapshot.itemIndex).toBe(0)
  })

  it('a paused handoff completes on the receiver reporting paused', () => {
    const t = drive([
      started(mixedSnapshot({ playWhenReady: false })),
      loaded([11, 12, 13]),
      status({ currentItemId: 11, playerState: 'paused' }),
    ])
    expect(t.state.phase).toBe('cast-active')
    const snapshot = findEffect(t, 'emitReceiverState').snapshot
    expect(snapshot.playing).toBe(false)
    expect(snapshot.rate).toBe(0)
  })

  it('an idle status does not complete the handoff', () => {
    const t = drive(
      [
        loaded([11, 12, 13]),
        status({ playerState: 'idle', idleReason: 'none' }),
      ],
      handingOff
    )
    expect(t.state.phase).toBe('handoff-to-cast')
    expect(t.effects).toEqual([])
  })

  it('reconciles the entry index through the skip mapping (receiver id → JS index)', () => {
    // Receiver position 1 (id 12) is JS index 2 — the local file was skipped.
    const t = drive(
      [loaded([11, 12, 13]), status({ currentItemId: 12 })],
      handingOff
    )
    expect(findEffect(t, 'emitTransfer').transfer.itemIndex).toBe(2)
  })

  it('castQueueLoadFailed falls back to LOCAL at the pre-handoff snapshot, error first', () => {
    const error = new CastError('load-failed', 'receiver refused')
    const t = reduceCastHandoff(handingOff, {
      type: 'castQueueLoadFailed',
      error,
    })
    expect(t.state.phase).toBe('handoff-to-local')
    expect(effectsOf(t)).toEqual(['emitError', 'restoreLocal'])
    expect(findEffect(t, 'restoreLocal')).toMatchObject({
      itemIndex: 0,
      position: 42.5,
      playWhenReady: true,
    })
  })

  it('a receiver fetch error mid-handoff falls back the same way', () => {
    const error = new CastError('cast-receiver-fetch', 'unreachable')
    const t = reduceCastHandoff(handingOff, { type: 'castError', error })
    expect(t.state.phase).toBe('handoff-to-local')
    expect(effectsOf(t)).toEqual(['emitError', 'restoreLocal'])
  })

  it('the session dying mid-handoff restores local playback without inventing an error', () => {
    const t = reduceCastHandoff(handingOff, { type: 'sessionEnded', at: 2_000 })
    expect(t.state.phase).toBe('handoff-to-local')
    expect(effectsOf(t)).toEqual(['restoreLocal'])
  })

  it('the fallback completes through HANDOFF_TO_LOCAL → LOCAL on localRestored', () => {
    const t = drive(
      [{ type: 'sessionEnded', at: 2_000 }, { type: 'localRestored' }],
      handingOff
    )
    expect(t.state.phase).toBe('local')
  })

  it('sessionSuspended mid-handoff is ignored — the framework retries by itself', () => {
    const t = reduceCastHandoff(handingOff, { type: 'sessionSuspended', at: 2 })
    expect(t.state.phase).toBe('handoff-to-cast')
    expect(t.effects).toEqual([])
  })
})

/* ---------------------------------------------------------------------- */
/*                              CAST_ACTIVE                               */
/* ---------------------------------------------------------------------- */

describe('CAST_ACTIVE', () => {
  it('a status update re-anchors the position and emits exactly one receiver snapshot', () => {
    const t = reduceCastHandoff(
      activeState(),
      status({ position: 60, currentItemId: 11 }, 5_000)
    )
    expect(t.state.phase).toBe('cast-active')
    expect(effectsOf(t)).toEqual(['emitReceiverState'])
    const snapshot = findEffect(t, 'emitReceiverState').snapshot
    expect(snapshot).toMatchObject({
      position: 60,
      at: 5_000,
      rate: 1,
      itemIndex: 0,
    })
  })

  it('a paused status freezes the projection (rate 0)', () => {
    const t = reduceCastHandoff(
      activeState(),
      status({ playerState: 'paused', position: 61 }, 6_000)
    )
    expect(findEffect(t, 'emitReceiverState').snapshot.rate).toBe(0)
  })

  it('receiver-side advancement reconciles to the JS index across skipped items', () => {
    // The receiver advanced from id 11 (js 0) to id 12 — JS index 2, because
    // JS index 1 was never on the receiver.
    const t = reduceCastHandoff(
      activeState(),
      status({ currentItemId: 12, position: 0 }, 7_000)
    )
    expect(findEffect(t, 'emitReceiverState').snapshot.itemIndex).toBe(2)
    const after = t.state
    expect(after.phase === 'cast-active' && after.itemIndex).toBe(2)
  })

  it('an unknown currentItemId keeps the last reconciled index', () => {
    const t = reduceCastHandoff(
      activeState(),
      status({ currentItemId: 999 }, 7_000)
    )
    expect(findEffect(t, 'emitReceiverState').snapshot.itemIndex).toBe(0)
  })

  it('idle + finished marks the queue ended, not an error', () => {
    const t = reduceCastHandoff(
      activeState(),
      status(
        {
          playerState: 'idle',
          idleReason: 'finished',
          currentItemId: undefined,
        },
        8_000
      )
    )
    const snapshot = findEffect(t, 'emitReceiverState').snapshot
    expect(snapshot.queueEnded).toBe(true)
    expect(snapshot.playing).toBe(false)
    expect(t.state.phase).toBe('cast-active')
  })

  it('a receiver fetch error is surfaced and the session survives (re-resolve seam)', () => {
    const error = new CastError('cast-receiver-fetch', 'signed URL expired')
    const t = reduceCastHandoff(activeState(), { type: 'castError', error })
    expect(t.state.phase).toBe('cast-active')
    expect(t.effects).toEqual([{ type: 'emitError', error }])
  })

  it('end (transfer back) projects the receiver clock forward and stops the receiver', () => {
    // Anchor: position 42.5 at t=1200, rate 1. Ending at t=10200 → 51.5 s.
    const t = reduceCastHandoff(activeState(), {
      type: 'end',
      transferBack: true,
      at: 10_200,
    })
    expect(t.state).toMatchObject({
      phase: 'handoff-to-local',
      awaiting: 'session-end',
      transferBack: true,
      position: 51.5,
      itemIndex: 0,
      playWhenReady: true,
    })
    expect(t.effects).toEqual([{ type: 'endCastSession', stopReceiver: true }])
  })

  it('end after a pause projects a frozen clock — the pause froze the anchor', () => {
    const paused = reduceCastHandoff(
      activeState(),
      status({ playerState: 'paused', position: 50 }, 9_000)
    ).state
    const t = reduceCastHandoff(paused, {
      type: 'end',
      transferBack: true,
      at: 99_000,
    })
    expect(t.state).toMatchObject({ position: 50, playWhenReady: false })
  })

  it('end without transfer-back leaves the receiver playing', () => {
    const t = reduceCastHandoff(activeState(), {
      type: 'end',
      transferBack: false,
      at: 10_200,
    })
    expect(t.effects).toEqual([{ type: 'endCastSession', stopReceiver: false }])
    expect(t.state).toMatchObject({
      phase: 'handoff-to-local',
      transferBack: false,
    })
  })

  it('an unsolicited sessionEnded (receiver died / switcher "this phone") transfers back immediately', () => {
    const t = reduceCastHandoff(activeState(), {
      type: 'sessionEnded',
      at: 10_200,
    })
    expect(t.state).toMatchObject({
      phase: 'handoff-to-local',
      awaiting: 'local-restore',
    })
    expect(effectsOf(t)).toEqual(['emitTransfer', 'restoreLocal'])
    expect(findEffect(t, 'emitTransfer').transfer).toEqual({
      direction: 'toLocal',
      position: 51.5,
      itemIndex: 0,
    })
    expect(findEffect(t, 'restoreLocal')).toMatchObject({
      itemIndex: 0,
      position: 51.5,
      playWhenReady: true,
    })
  })

  it('sessionSuspended freezes the anchor and says so (rate 0) without leaving the phase', () => {
    const t = reduceCastHandoff(activeState(), {
      type: 'sessionSuspended',
      at: 4_200,
    })
    expect(t.state.phase).toBe('cast-active')
    const snapshot = findEffect(t, 'emitReceiverState').snapshot
    expect(snapshot.rate).toBe(0)
    // 42.5 anchored at 1200, suspended at 4200 → projected 45.5, then frozen.
    expect(snapshot.position).toBe(45.5)
    const ended = reduceCastHandoff(t.state, {
      type: 'end',
      transferBack: true,
      at: 99_999,
    })
    expect(ended.state).toMatchObject({ position: 45.5 })
  })

  it('resync re-projects the queue anchored at the receiver’s current item and clock', () => {
    const t = reduceCastHandoff(activeState(), {
      type: 'resync',
      snapshot: mixedSnapshot({ items: [...mixedSnapshot().items, item('e')] }),
      at: 3_200, // anchor 42.5 @ 1200, rate 1 → 44.5
    })
    expect(t.state.phase).toBe('cast-active')
    const load = findEffect(t, 'loadCastQueue')
    expect(load.items).toHaveLength(4) // a, c, d, e — local file still skipped
    expect(load.startIndex).toBe(0) // current item (js 0) is projection 0
    expect(load.startPosition).toBe(44.5)
    expect(effectsOf(t)).toEqual(['notifySkipped', 'loadCastQueue'])
  })

  it('resync adopts the new mapping only when its queueLoad acks', () => {
    const resynced = reduceCastHandoff(activeState(), {
      type: 'resync',
      snapshot: mixedSnapshot({ items: [...mixedSnapshot().items, item('e')] }),
      at: 3_200,
    }).state
    const t = reduceCastHandoff(resynced, loaded([21, 22, 23, 24], 3_300))
    expect(t.state.phase).toBe('cast-active')
    // Advancing to the new queue's id 24 must land on JS index 4 ('e').
    const advanced = reduceCastHandoff(
      t.state,
      status({ currentItemId: 24 }, 3_400)
    )
    expect(findEffect(advanced, 'emitReceiverState').snapshot.itemIndex).toBe(4)
  })

  it('resync when the current item left the queue falls back to the at-or-after rule', () => {
    const t = reduceCastHandoff(activeState(), {
      type: 'resync',
      // 'a' (the current item, js 0) is gone; c and d remain castable.
      snapshot: {
        items: [
          item('b-local', { url: 'file:///b.mp3' }),
          item('c'),
          item('d'),
        ],
        index: 0,
        position: 0,
        playWhenReady: true,
      },
      at: 3_200,
    })
    const load = findEffect(t, 'loadCastQueue')
    expect(load.startIndex).toBe(0) // first castable at-or-after
    expect(load.startPosition).toBe(0) // a position in a removed track is meaningless
  })

  it('resync with nothing castable is a surfaced error; the receiver keeps its queue', () => {
    const t = reduceCastHandoff(activeState(), {
      type: 'resync',
      snapshot: {
        items: [item('a', { url: 'file:///a.mp3' })],
        index: 0,
        position: 0,
        playWhenReady: true,
      },
      at: 3_200,
    })
    expect(t.state.phase).toBe('cast-active')
    expect(findEffect(t, 'emitError').error.code).toBe('no-castable-media')
  })

  it('a resync queueLoad failure keeps the session and surfaces the error', () => {
    const resynced = reduceCastHandoff(activeState(), {
      type: 'resync',
      snapshot: mixedSnapshot(),
      at: 3_200,
    }).state
    const error = new CastError('load-failed', 'x')
    const t = reduceCastHandoff(resynced, {
      type: 'castQueueLoadFailed',
      error,
    })
    expect(t.state.phase).toBe('cast-active')
    expect(t.effects).toEqual([{ type: 'emitError', error }])
    // A later ack without a pending projection must not corrupt the mapping.
    const stray = reduceCastHandoff(t.state, loaded([31, 32], 4_000))
    expect(stray.effects).toEqual([])
    const after = stray.state
    expect(after.phase === 'cast-active' && after.itemIds).toEqual([11, 12, 13])
  })

  it('ignores start, sessionStarted and restore completions', () => {
    for (const event of [
      { type: 'start', deviceId: 'dev-2' },
      started(allCastableSnapshot(), 5_000),
      { type: 'localRestored' },
      { type: 'localRestoreFailed', error: new CastError('native', 'x') },
      {
        type: 'sessionStartFailed',
        error: new CastError('session-start-failed', 'x'),
      },
    ] as const satisfies readonly CastHandoffEvent[]) {
      const t = reduceCastHandoff(activeState(), event)
      expect(t.state.phase).toBe('cast-active')
      expect(t.effects).toEqual([])
    }
  })
})

/* ---------------------------------------------------------------------- */
/*                            HANDOFF_TO_LOCAL                            */
/* ---------------------------------------------------------------------- */

describe('HANDOFF_TO_LOCAL', () => {
  const awaitingEnd = reduceCastHandoff(activeState(), {
    type: 'end',
    transferBack: true,
    at: 10_200,
  }).state

  it('sessionEnded completes a transfer-back: one toLocal transfer, then the restore', () => {
    const t = reduceCastHandoff(awaitingEnd, {
      type: 'sessionEnded',
      at: 10_300,
    })
    expect(t.state).toMatchObject({
      phase: 'handoff-to-local',
      awaiting: 'local-restore',
    })
    expect(effectsOf(t)).toEqual(['emitTransfer', 'restoreLocal'])
    expect(findEffect(t, 'emitTransfer').transfer).toEqual({
      direction: 'toLocal',
      position: 51.5,
      itemIndex: 0,
    })
  })

  it('sessionEnded without transfer-back goes straight to LOCAL — no restore, no transfer event', () => {
    const leaving = reduceCastHandoff(activeState(), {
      type: 'end',
      transferBack: false,
      at: 10_200,
    }).state
    const t = reduceCastHandoff(leaving, { type: 'sessionEnded', at: 10_300 })
    expect(t.state.phase).toBe('local')
    expect(t.effects).toEqual([])
  })

  it('localRestored → LOCAL', () => {
    const restoring = reduceCastHandoff(awaitingEnd, {
      type: 'sessionEnded',
      at: 10_300,
    }).state
    const t = reduceCastHandoff(restoring, { type: 'localRestored' })
    expect(t.state.phase).toBe('local')
    expect(t.effects).toEqual([])
  })

  it('localRestoreFailed → LOCAL with the error surfaced — never swallowed', () => {
    const restoring = reduceCastHandoff(awaitingEnd, {
      type: 'sessionEnded',
      at: 10_300,
    }).state
    const error = new CastError('native', 'seek failed')
    const t = reduceCastHandoff(restoring, {
      type: 'localRestoreFailed',
      error,
    })
    expect(t.state.phase).toBe('local')
    expect(t.effects).toEqual([{ type: 'emitError', error }])
  })

  it('late receiver statuses and stray session events are ignored during the transfer', () => {
    const restoring = reduceCastHandoff(awaitingEnd, {
      type: 'sessionEnded',
      at: 10_300,
    }).state
    for (const event of [
      status({}, 10_400),
      { type: 'sessionEnded', at: 10_500 },
      started(allCastableSnapshot(), 10_600),
      { type: 'end', transferBack: true, at: 10_700 },
    ] as const satisfies readonly CastHandoffEvent[]) {
      const t = reduceCastHandoff(restoring, event)
      expect(t.state).toBe(restoring)
      expect(t.effects).toEqual([])
    }
  })

  it('while awaiting the session end, statuses are ignored and errors still surface', () => {
    const ignored = reduceCastHandoff(awaitingEnd, status({}, 10_250))
    expect(ignored.state).toBe(awaitingEnd)
    const error = new CastError('native', 'x')
    const surfaced = reduceCastHandoff(awaitingEnd, {
      type: 'castError',
      error,
    })
    expect(surfaced.state).toBe(awaitingEnd)
    expect(surfaced.effects).toEqual([{ type: 'emitError', error }])
  })
})

/* ---------------------------------------------------------------------- */
/*                          Full-journey invariants                       */
/* ---------------------------------------------------------------------- */

describe('journeys', () => {
  it('the full §3 loop: LOCAL → CONNECTING → HANDOFF_TO_CAST → CAST_ACTIVE → HANDOFF_TO_LOCAL → LOCAL', () => {
    const phases: string[] = []
    let state = initialCastHandoffState
    for (const event of [
      { type: 'start', deviceId: 'dev-1' },
      started(mixedSnapshot()),
      loaded([11, 12, 13]),
      status({ currentItemId: 11 }),
      { type: 'end', transferBack: true, at: 2_000 },
      { type: 'sessionEnded', at: 2_100 },
      { type: 'localRestored' },
    ] as const satisfies readonly CastHandoffEvent[]) {
      state = reduceCastHandoff(state, event).state
      phases.push(state.phase)
    }
    expect(phases).toEqual([
      'connecting',
      'handoff-to-cast',
      'handoff-to-cast', // queueLoad acked; awaiting the receiver's first status
      'cast-active',
      'handoff-to-local',
      'handoff-to-local',
      'local',
    ])
  })

  it('emits exactly one transfer per direction across a complete round trip', () => {
    let state = initialCastHandoffState
    const transfers: string[] = []
    for (const event of [
      { type: 'start', deviceId: 'dev-1' },
      started(mixedSnapshot()),
      loaded([11, 12, 13]),
      status({ currentItemId: 11 }),
      status({ currentItemId: 12 }, 2_000),
      { type: 'end', transferBack: true, at: 3_000 },
      { type: 'sessionEnded', at: 3_100 },
      { type: 'localRestored' },
    ] as const satisfies readonly CastHandoffEvent[]) {
      const t = reduceCastHandoff(state, event)
      state = t.state
      for (const effect of t.effects) {
        if (effect.type === 'emitTransfer')
          transfers.push(effect.transfer.direction)
      }
    }
    expect(transfers).toEqual(['toCast', 'toLocal'])
  })

  it('a transfer-back resumes at the JS index the receiver advanced to', () => {
    let state = activeState()
    // Receiver advanced to id 13 → JS index 3, position 5 at t=2000.
    state = reduceCastHandoff(
      state,
      status({ currentItemId: 13, position: 5 }, 2_000)
    ).state
    const t = reduceCastHandoff(state, {
      type: 'end',
      transferBack: true,
      at: 7_000,
    })
    expect(t.state).toMatchObject({ itemIndex: 3, position: 10 })
  })
})
