import { describe, expect, it, vi } from 'vitest'

import { createMediaService } from '../media-service'
import {
  applyPersisted,
  clearPersisted,
  DEFAULT_PERSISTENCE_KEY,
  PERSISTENCE_SCHEMA_VERSION,
  restorePersisted,
  withPersistence,
} from '../persistence'
import type { MediaSessionStorage } from '../persistence'
import type { MediaServiceApi } from '../types'
import {
  FakeNativeMediaSession,
  RecordingHandler,
  item,
  playbackState,
} from './fakes'

/* -------------------------------------------------------------------------- */
/*                                  Storages                                  */
/* -------------------------------------------------------------------------- */

/** `react-native-mmkv` shape: everything synchronous. */
class SyncStorage implements MediaSessionStorage {
  readonly writes: string[] = []
  private value: string | null = null

  getItem(_key: string): string | null {
    return this.value
  }
  setItem(_key: string, value: string): void {
    this.value = value
    this.writes.push(value)
  }
  /** Simulate a partially-written or externally-mangled record. */
  poke(raw: string | null): void {
    this.value = raw
  }
}

/** `@react-native-async-storage/async-storage` shape: everything a promise. */
class AsyncStorage implements MediaSessionStorage {
  readonly writes: string[] = []
  private value: string | null = null
  /** Resolvers for in-flight writes, so a test can control interleaving. */
  private readonly gate: (() => void)[] = []

  constructor(private readonly manual = false) {}

  getItem(_key: string): Promise<string | null> {
    return Promise.resolve(this.value)
  }

  setItem(_key: string, value: string): Promise<void> {
    if (!this.manual) {
      this.value = value
      this.writes.push(value)
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.gate.push(() => {
        this.value = value
        this.writes.push(value)
        resolve()
      })
    })
  }

  /** Let the oldest pending write complete. */
  release(): void {
    this.gate.shift()?.()
  }
  get pending(): number {
    return this.gate.length
  }
}

class ThrowingStorage implements MediaSessionStorage {
  constructor(readonly error = new Error('disk on fire')) {}
  getItem(): string | null {
    throw this.error
  }
  setItem(): void {
    throw this.error
  }
}

class RejectingStorage implements MediaSessionStorage {
  constructor(readonly error = new Error('quota exceeded')) {}
  getItem(): Promise<string | null> {
    return Promise.reject(this.error)
  }
  setItem(): Promise<void> {
    return Promise.reject(this.error)
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Fixtures                                  */
/* -------------------------------------------------------------------------- */

const NOW = 1_700_000_600_000

async function service(): Promise<{
  native: FakeNativeMediaSession
  api: MediaServiceApi
}> {
  const native = new FakeNativeMediaSession()
  const api = await createMediaService(native).init(
    () => new RecordingHandler()
  )
  return { native, api }
}

const QUEUE = [item('a', { duration: 300_000 }), item('b'), item('c')]

function parse(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>
}

/* -------------------------------------------------------------------------- */
/*                                  Round trip                                */
/* -------------------------------------------------------------------------- */

describe('save → restore round trip', () => {
  it('restores all three channels through a synchronous storage', async () => {
    const storage = new SyncStorage()
    const { api } = await service()
    const persisted = withPersistence(api, storage, { now: () => NOW })

    persisted.setQueue(QUEUE)
    persisted.setMediaItem(item('a', { duration: 300_000, artist: 'Someone' }))
    persisted.setPlaybackState(
      playbackState({
        status: 'playing',
        position: { value: 42_000, at: NOW, rate: 1 },
        queueIndex: 0,
        controls: ['pause'],
        capabilities: ['play', 'pause', 'seek'],
      })
    )

    const restored = await restorePersisted(storage, { now: () => NOW + 5_000 })
    expect(restored.status).toBe('restored')
    if (restored.status !== 'restored') return

    expect(restored.session.savedAt).toBe(NOW)
    expect(restored.session.queue).toEqual(QUEUE)
    expect(restored.session.mediaItem?.artist).toBe('Someone')
    expect(restored.session.playbackState?.queueIndex).toBe(0)
    expect(restored.session.playbackState?.capabilities).toEqual([
      'play',
      'pause',
      'seek',
    ])
  })

  it('works identically through an asynchronous storage', async () => {
    const storage = new AsyncStorage()
    const { api } = await service()
    const persisted = withPersistence(api, storage, { now: () => NOW })

    persisted.setQueue(QUEUE)
    persisted.setMediaItem(item('a'))
    persisted.setPlaybackState(playbackState({ queueIndex: 0 }))
    await persisted.flush()

    const restored = await restorePersisted(storage)
    expect(restored.status).toBe('restored')
    if (restored.status !== 'restored') return
    expect(restored.session.queue).toEqual(QUEUE)
    expect(restored.session.mediaItem?.id).toBe('a')
  })

  it('still delegates every broadcast to the wrapped service', async () => {
    const storage = new SyncStorage()
    const { native, api } = await service()
    const persisted = withPersistence(api, storage)

    persisted.setQueue(QUEUE)
    persisted.setMediaItem(item('a'))
    persisted.setPlaybackState(playbackState())
    await persisted.stopService()

    expect(native.queues).toHaveLength(1)
    expect(native.mediaItems).toHaveLength(1)
    expect(native.playbackStates).toHaveLength(1)
    expect(native.stopServiceCalls).toBe(1)
  })

  it('does not persist a broadcast the service rejected', async () => {
    const storage = new SyncStorage()
    const { api } = await service()
    const persisted = withPersistence(api, storage)

    expect(() =>
      persisted.setMediaItem({ id: '', title: 'no id' })
    ).toThrowError(/id/)
    expect(storage.writes).toHaveLength(0)
  })

  it('applyPersisted re-broadcasts queue → item → state, in that order', async () => {
    const calls: string[] = []
    const spy: MediaServiceApi = {
      setPlaybackState: () => calls.push('state'),
      setMediaItem: () => calls.push('item'),
      setQueue: () => calls.push('queue'),
      setResumptionSnapshot: () => {},
      setRemotePlayback: () => {},
      setSleepTimer: () => {},
      setSleepTimerToTrackEnd: () => {},
      cancelSleepTimer: () => {},
      getSleepTimerRemaining: () => undefined,
      getSleepTimer: () => undefined,
      stopService: () => Promise.resolve(),
    }

    applyPersisted(spy, {
      savedAt: NOW,
      queue: QUEUE,
      mediaItem: item('a'),
      playbackState: playbackState(),
    })

    expect(calls).toEqual(['queue', 'item', 'state'])
  })
})

/* -------------------------------------------------------------------------- */
/*                                The anchor                                  */
/* -------------------------------------------------------------------------- */

describe('the persisted anchor is always paused', () => {
  it('freezes a running anchor at write time and drops the rate', async () => {
    const storage = new SyncStorage()
    const { api } = await service()
    // 10 s after the anchor was sampled, playing at 1×.
    const persisted = withPersistence(api, storage, { now: () => NOW + 10_000 })

    // A duration has to be known: without one the entry is live by this
    // package's own discriminator, and a live position persists as 0.
    persisted.setMediaItem(item('a', { duration: 300_000 }))
    persisted.setPlaybackState(
      playbackState({
        status: 'playing',
        position: { value: 42_000, at: NOW, rate: 1 },
      })
    )

    const record = parse(storage.writes.at(-1) as string)
    const state = record.playbackState as Record<string, unknown>
    expect(state.status).toBe('paused')
    expect(state.position).toEqual({ value: 52_000, at: NOW + 10_000, rate: 0 })
  })

  it('downgrades buffering to paused too — a playing broadcast starts an FGS', async () => {
    const storage = new SyncStorage()
    const { api } = await service()
    withPersistence(api, storage, { now: () => NOW }).setPlaybackState(
      playbackState({ status: 'buffering' })
    )
    expect(
      (parse(storage.writes[0] as string).playbackState as { status: string })
        .status
    ).toBe('paused')
  })

  it('leaves stopped and error alone — they are already honest', async () => {
    for (const status of ['stopped', 'error'] as const) {
      const storage = new SyncStorage()
      const { api } = await service()
      withPersistence(api, storage, { now: () => NOW }).setPlaybackState(
        playbackState({ status, errorMessage: 'nope' })
      )
      expect(
        (parse(storage.writes[0] as string).playbackState as { status: string })
          .status
      ).toBe(status)
    }
  })

  it('persists position 0 for a live entry — a duration-less item', async () => {
    const storage = new SyncStorage()
    const { api } = await service()
    const persisted = withPersistence(api, storage, { now: () => NOW + 60_000 })

    // No `duration`: this package's live/unknown discriminator everywhere.
    persisted.setMediaItem(item('radio'))
    persisted.setPlaybackState(
      playbackState({
        status: 'playing',
        position: { value: 900_000, at: NOW, rate: 1 },
      })
    )

    const state = parse(storage.writes.at(-1) as string).playbackState as {
      position: { value: number; rate: number }
      status: string
    }
    expect(state.position).toEqual({ value: 0, at: NOW + 60_000, rate: 0 })
    expect(state.status).toBe('paused')
  })

  it('falls back to the queue entry’s duration when the item omits one', async () => {
    const storage = new SyncStorage()
    const { api } = await service()
    const persisted = withPersistence(api, storage, { now: () => NOW })

    persisted.setQueue(QUEUE) // QUEUE[0] carries duration 300_000
    persisted.setMediaItem(item('a')) // …the item does not
    persisted.setPlaybackState(
      playbackState({
        status: 'playing',
        position: { value: 12_000, at: NOW, rate: 1 },
        queueIndex: 0,
      })
    )

    const state = parse(storage.writes.at(-1) as string).playbackState as {
      position: { value: number }
    }
    // Not zeroed: the duration is known, just not on the channel you looked at.
    expect(state.position.value).toBe(12_000)
  })

  it('clamps the projection to a known duration', async () => {
    const storage = new SyncStorage()
    const { api } = await service()
    // An hour after a 5-minute track was broadcast as playing.
    const persisted = withPersistence(api, storage, {
      now: () => NOW + 3_600_000,
    })
    persisted.setMediaItem(item('a', { duration: 300_000 }))
    persisted.setPlaybackState(
      playbackState({
        status: 'playing',
        position: { value: 1_000, at: NOW, rate: 1 },
      })
    )

    const state = parse(storage.writes.at(-1) as string).playbackState as {
      position: { value: number }
    }
    expect(state.position.value).toBe(300_000)
  })

  it('re-stamps `at` to the restore instant so the gap cannot be projected', async () => {
    const storage = new SyncStorage()
    const { api } = await service()
    const persisted = withPersistence(api, storage, { now: () => NOW })
    persisted.setMediaItem(item('a', { duration: 300_000 }))
    persisted.setPlaybackState(
      playbackState({
        status: 'playing',
        position: { value: 42_000, at: NOW, rate: 1 },
      })
    )

    const later = NOW + 86_400_000 // a day later, new process
    const restored = await restorePersisted(storage, { now: () => later })
    if (restored.status !== 'restored') throw new Error('expected restored')
    expect(restored.session.playbackState?.position).toEqual({
      value: 42_000,
      at: later,
      rate: 0,
    })
    expect(restored.session.playbackState?.status).toBe('paused')
  })

  it('never restores a live rate, even from a hand-mangled record', async () => {
    const storage = new SyncStorage()
    storage.poke(
      JSON.stringify({
        v: PERSISTENCE_SCHEMA_VERSION,
        savedAt: NOW,
        playbackState: {
          status: 'playing',
          position: { value: 10_000, at: NOW, rate: 2 },
        },
      })
    )

    const restored = await restorePersisted(storage, { now: () => NOW + 1 })
    if (restored.status !== 'restored') throw new Error('expected restored')
    expect(restored.session.playbackState?.position.rate).toBe(0)
    expect(restored.session.playbackState?.status).toBe('paused')
  })
})

/* -------------------------------------------------------------------------- */
/*                              Bad / absent data                             */
/* -------------------------------------------------------------------------- */

describe('restorePersisted tolerates anything on disk', () => {
  it('reports empty when nothing was ever written', async () => {
    expect(await restorePersisted(new SyncStorage())).toEqual({
      status: 'empty',
    })
  })

  it('reports empty for an empty string', async () => {
    const storage = new SyncStorage()
    storage.poke('')
    expect(await restorePersisted(storage)).toEqual({ status: 'empty' })
  })

  it('reports corrupt for unparseable JSON, with the parser’s reason', async () => {
    const storage = new SyncStorage()
    storage.poke('{"v":1,"queue":[')
    const result = await restorePersisted(storage)
    expect(result.status).toBe('corrupt')
    if (result.status !== 'corrupt') return
    expect(result.reason).toBeTruthy()
  })

  it('reports corrupt for valid JSON that is not an object', async () => {
    const storage = new SyncStorage()
    storage.poke('[1,2,3]')
    expect((await restorePersisted(storage)).status).toBe('corrupt')
  })

  it('reports unsupportedVersion for a future schema', async () => {
    const storage = new SyncStorage()
    storage.poke(JSON.stringify({ v: 99, savedAt: NOW, queue: QUEUE }))
    expect(await restorePersisted(storage)).toEqual({
      status: 'unsupportedVersion',
      found: 99,
      expected: PERSISTENCE_SCHEMA_VERSION,
    })
  })

  it('reports unsupportedVersion with found: undefined when v is not a number', async () => {
    const storage = new SyncStorage()
    storage.poke(JSON.stringify({ savedAt: NOW, queue: QUEUE }))
    expect(await restorePersisted(storage)).toEqual({
      status: 'unsupportedVersion',
      found: undefined,
      expected: PERSISTENCE_SCHEMA_VERSION,
    })
  })

  it('reports corrupt when the payload fails the same validation a broadcast gets', async () => {
    const storage = new SyncStorage()
    storage.poke(
      JSON.stringify({
        v: PERSISTENCE_SCHEMA_VERSION,
        savedAt: NOW,
        queue: [{ id: 'a' }], // no title
      })
    )
    const result = await restorePersisted(storage)
    expect(result.status).toBe('corrupt')
    if (result.status !== 'corrupt') return
    expect(result.reason).toMatch(/title/)
  })

  it('surfaces a storage failure rather than reporting corrupt data', async () => {
    const thrower = new ThrowingStorage()
    await expect(restorePersisted(thrower)).rejects.toBe(thrower.error)

    const rejecter = new RejectingStorage()
    await expect(restorePersisted(rejecter)).rejects.toBe(rejecter.error)
  })
})

/* -------------------------------------------------------------------------- */
/*                                  Writing                                   */
/* -------------------------------------------------------------------------- */

describe('write behaviour', () => {
  it('writes once per broadcast and never on a tick', async () => {
    const storage = new SyncStorage()
    const { api } = await service()
    const persisted = withPersistence(api, storage)

    persisted.setQueue(QUEUE)
    persisted.setMediaItem(item('a'))
    persisted.setPlaybackState(playbackState())

    expect(storage.writes).toHaveLength(3)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Nothing schedules itself: no timers, no polling.
    expect(storage.writes).toHaveLength(3)
  })

  it('a synchronous storage is written before the setter returns', async () => {
    const storage = new SyncStorage()
    const { api } = await service()
    withPersistence(api, storage).setQueue(QUEUE)
    // No await: durability is not deferred to a microtask for sync engines.
    expect(storage.writes).toHaveLength(1)
  })

  it('coalesces overlapping async writes and keeps the newest', async () => {
    const storage = new AsyncStorage(true)
    const { api } = await service()
    const persisted = withPersistence(api, storage)

    persisted.setQueue(QUEUE) // starts write #1
    persisted.setMediaItem(item('a')) // queued behind it
    persisted.setPlaybackState(playbackState({ queueIndex: 2 })) // supersedes it
    expect(storage.pending).toBe(1)

    storage.release() // #1 lands, the coalesced follow-up starts
    await Promise.resolve()
    await Promise.resolve()
    storage.release()
    await persisted.flush()

    // Two round trips for three broadcasts, and the last one carries everything.
    expect(storage.writes).toHaveLength(2)
    const last = parse(storage.writes[1] as string)
    expect(last.mediaItem).toBeDefined()
    expect((last.playbackState as { queueIndex: number }).queueIndex).toBe(2)
  })

  it('surfaces a write failure through onError instead of swallowing it', async () => {
    const onError = vi.fn()
    const { api } = await service()

    withPersistence(api, new ThrowingStorage(), { onError }).setQueue(QUEUE)
    expect(onError).toHaveBeenCalledTimes(1)

    const rejecting = new RejectingStorage()
    const persisted = withPersistence(api, rejecting, { onError })
    persisted.setQueue(QUEUE)
    await persisted.flush()
    expect(onError).toHaveBeenCalledWith(rejecting.error)
  })

  it('keeps writing after a failure — one bad write is not a latch', async () => {
    const onError = vi.fn()
    const { api } = await service()
    let fail = true
    const flaky: MediaSessionStorage = {
      getItem: () => null,
      setItem: () => {
        if (fail) throw new Error('once')
      },
    }
    const persisted = withPersistence(api, flaky, { onError })
    persisted.setQueue(QUEUE)
    fail = false
    persisted.setMediaItem(item('a'))
    await persisted.flush()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('uses the documented default key, and honours an override', async () => {
    const keys: string[] = []
    const spy: MediaSessionStorage = {
      getItem: () => null,
      setItem: (key) => {
        keys.push(key)
      },
    }
    const { api } = await service()
    withPersistence(api, spy).setQueue(QUEUE)
    withPersistence(api, spy, { key: 'custom' }).setQueue(QUEUE)
    expect(keys).toEqual([DEFAULT_PERSISTENCE_KEY, 'custom'])
  })

  it('save() re-projects the anchor to *now*, not to the last broadcast', async () => {
    const storage = new SyncStorage()
    const { api } = await service()
    let clock = NOW
    const persisted = withPersistence(api, storage, { now: () => clock })

    persisted.setMediaItem(item('a', { duration: 300_000 }))
    persisted.setPlaybackState(
      playbackState({
        status: 'playing',
        position: { value: 3, at: NOW, rate: 1 },
      })
    )
    expect(
      (
        parse(storage.writes.at(-1) as string).playbackState as {
          position: { value: number }
        }
      ).position.value
    ).toBe(3)

    // 42 seconds of uninterrupted playback: no broadcast, so no write — that is
    // the discontinuity rule, and this is the escape hatch for it.
    clock = NOW + 42_000
    persisted.save()

    expect(storage.writes).toHaveLength(3)
    expect(
      (
        parse(storage.writes.at(-1) as string).playbackState as {
          position: { value: number }
        }
      ).position.value
    ).toBe(42_003)
  })

  it('save() before any broadcast writes nothing', async () => {
    const storage = new SyncStorage()
    const { api } = await service()
    withPersistence(api, storage).save()
    expect(storage.writes).toHaveLength(0)
  })

  it('flush() resolves immediately when nothing is in flight', async () => {
    const { api } = await service()
    await expect(
      withPersistence(api, new SyncStorage()).flush()
    ).resolves.toBeUndefined()
  })

  it('stopService leaves the record intact — stop is not "forget"', async () => {
    const storage = new SyncStorage()
    const { api } = await service()
    const persisted = withPersistence(api, storage)
    persisted.setQueue(QUEUE)
    await persisted.stopService()

    expect((await restorePersisted(storage)).status).toBe('restored')
  })

  it('forwards the sleep-timer surface without persisting it', async () => {
    const storage = new SyncStorage()
    const { native, api } = await service()
    const persisted = withPersistence(api, storage)

    persisted.setSleepTimer(30)
    expect(native.sleepTimers).toEqual([30])
    expect(persisted.getSleepTimerRemaining()).toBe(30)
    persisted.cancelSleepTimer()
    expect(native.cancelSleepTimerCalls).toBe(1)
    // Not a broadcast channel: nothing was written.
    expect(storage.writes).toHaveLength(0)
  })
})

describe('clearPersisted', () => {
  it('makes a later restore report empty', async () => {
    const storage = new SyncStorage()
    const { api } = await service()
    withPersistence(api, storage).setQueue(QUEUE)
    expect((await restorePersisted(storage)).status).toBe('restored')

    await clearPersisted(storage)
    expect(await restorePersisted(storage)).toEqual({ status: 'empty' })
  })

  it('rejects on a storage failure — the caller asked for this one', async () => {
    const rejecting = new RejectingStorage()
    await expect(clearPersisted(rejecting)).rejects.toBe(rejecting.error)
  })
})

/* -------------------------------------------------------------------------- */
/*                        The native resumption mirror                        */
/* -------------------------------------------------------------------------- */

describe('native resumption mirror', () => {
  it('mirrors exactly the bytes that went into storage, on every broadcast', async () => {
    const storage = new SyncStorage()
    const { native, api } = await service()
    const persisted = withPersistence(api, storage)

    persisted.setQueue(QUEUE)
    persisted.setMediaItem(QUEUE[0])
    persisted.setPlaybackState(playbackState({ queueIndex: 0 }))

    // Same count and — the property that matters — same content. The mirror is
    // what a service with no JavaScript reads; if it could drift from the
    // record the app restores, the notification and the app would disagree
    // after every kill.
    expect(native.resumptionSnapshots).toEqual(storage.writes)
  })

  it('mirrors an async storage write-for-write, without waiting for the disk', async () => {
    const storage = new AsyncStorage(/* manual */ true)
    const { native, api } = await service()
    const persisted = withPersistence(api, storage)

    persisted.setQueue(QUEUE)
    persisted.setMediaItem(QUEUE[0])

    // Storage has one write in flight and one coalescing behind it; the mirror
    // is already current, because it is not on the disk's clock.
    expect(storage.writes).toHaveLength(0)
    expect(native.resumptionSnapshots).toHaveLength(2)
    expect(JSON.parse(native.resumptionSnapshots.at(-1)!).mediaItem).toEqual(
      QUEUE[0]
    )

    storage.release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    storage.release()
    await persisted.flush()
    expect(native.resumptionSnapshots).toEqual(storage.writes)
  })

  it('save() refreshes the mirror as well as the record', async () => {
    const storage = new SyncStorage()
    const { native, api } = await service()
    const persisted = withPersistence(api, storage)
    persisted.setPlaybackState(playbackState())

    const before = native.resumptionSnapshots.length
    persisted.save()
    expect(native.resumptionSnapshots).toHaveLength(before + 1)
    expect(native.resumptionSnapshots.at(-1)).toBe(storage.writes.at(-1))
  })

  it('clear() forgets both copies', async () => {
    const storage = new SyncStorage()
    const { native, api } = await service()
    const persisted = withPersistence(api, storage)
    persisted.setQueue(QUEUE)

    await persisted.clear()

    expect(await restorePersisted(storage)).toEqual({ status: 'empty' })
    // `undefined`, not a tombstone record: the native side has a key to remove,
    // not a schema to satisfy.
    expect(native.resumptionSnapshots.at(-1)).toBeUndefined()
  })

  it('clear() leaves the mirror alone when the storage write fails', async () => {
    const { native, api } = await service()
    const rejecting = new RejectingStorage()
    const persisted = withPersistence(api, rejecting, { onError: () => {} })

    await expect(persisted.clear()).rejects.toBe(rejecting.error)
    expect(native.resumptionSnapshots).not.toContain(undefined)
  })

  it('reports a mirror failure instead of losing the storage write', async () => {
    const storage = new SyncStorage()
    const { native, api } = await service()
    const boom = new Error('bridge gone')
    native.setResumptionSnapshot = () => {
      throw boom
    }
    const errors: unknown[] = []
    const persisted = withPersistence(api, storage, {
      onError: (error) => errors.push(error),
    })

    persisted.setQueue(QUEUE)

    // Persistence is the feature that matters; the mirror is a cache.
    expect(storage.writes).toHaveLength(1)
    expect(errors).toEqual([boom])
  })
})

describe('schema version 2 (B2 + B4 additions)', () => {
  it('is version 2, and the Kotlin reader is guarded against drifting from it', () => {
    // `SchemaVersionSyncTest` on the Android side reads this very constant out
    // of `persistence.ts` and fails the module build if
    // `ResumptionStore.SCHEMA_VERSION` disagrees. The reader that matters runs
    // in a process with no JavaScript in it, so it cannot ask.
    expect(PERSISTENCE_SCHEMA_VERSION).toBe(2)
  })

  it('refuses a version-1 record rather than restoring it without repeat/shuffle', () => {
    // The honest answer, and the whole point of the field: a v1 record has no
    // repeatMode/shuffleEnabled and no extended tags, and quietly restoring a
    // session with shuffle off because the record could not say otherwise is
    // exactly the silent wrongness `unsupportedVersion` exists to prevent.
    const storage = new SyncStorage()
    storage.poke(JSON.stringify({ v: 1, savedAt: NOW, queue: QUEUE }))
    return expect(restorePersisted(storage)).resolves.toEqual({
      status: 'unsupportedVersion',
      found: 1,
      expected: 2,
    })
  })

  it('round-trips repeat, shuffle and every extended tag', async () => {
    const storage = new SyncStorage()
    const rich = {
      id: 'a',
      title: 'A',
      duration: 240_000,
      albumArtist: 'Various Artists',
      trackNumber: 7,
      discNumber: 2,
      year: 1997,
      subtitle: 'Episode 12',
      isLive: false,
      extras: { source: 'library' },
    }
    const { api } = await service()
    const persisted = withPersistence(api, storage, { now: () => NOW })

    persisted.setQueue([rich])
    persisted.setMediaItem(rich)
    persisted.setPlaybackState(
      playbackState({ repeatMode: 'one', shuffleEnabled: true, queueIndex: 0 })
    )

    const restored = await restorePersisted(storage)
    expect(restored.status).toBe('restored')
    if (restored.status !== 'restored') return

    expect(restored.session.mediaItem).toEqual(rich)
    expect(restored.session.queue).toEqual([rich])
    expect(restored.session.playbackState).toMatchObject({
      repeatMode: 'one',
      shuffleEnabled: true,
    })
  })

  it('restores a record written before the app used repeat/shuffle as off/false', async () => {
    const storage = new SyncStorage()
    const { api } = await service()
    const persisted = withPersistence(api, storage, { now: () => NOW })
    persisted.setPlaybackState(playbackState({ queueIndex: -1 }))

    const restored = await restorePersisted(storage)
    if (restored.status !== 'restored') throw new Error(restored.status)
    expect(restored.session.playbackState).toMatchObject({
      repeatMode: 'off',
      shuffleEnabled: false,
    })
  })
})
