import { describe, expect, it } from 'vitest'

import { createCast } from '../cast'
import { CastError } from '../errors'
import type { CastError as CastErrorType } from '../errors'
import type { CastEventMap } from '../types'
import { FakeNativeCast, playingStatus } from './fakes'

function setup() {
  const native = new FakeNativeCast()
  const cast = createCast(native)
  return { native, cast }
}

describe('createCast — commands', () => {
  it('initialize forwards the receiver app id and resolves the typed state', async () => {
    const { native, cast } = setup()
    native.initializeResult = 'unavailable'
    await expect(
      cast.initialize({ receiverApplicationId: 'ABCD1234' })
    ).resolves.toBe('unavailable')
    expect(native.calls).toContainEqual(['initialize', 'ABCD1234'])
  })

  it('requestSession with a device id connects; without, it opens the picker', async () => {
    const { native, cast } = setup()
    await cast.requestSession('device-1')
    await cast.requestSession()
    expect(native.calls).toEqual([
      ['requestSession', 'device-1'],
      ['showCastPicker'],
    ])
  })

  it('endSession stops the receiver by default (transfer-back flow)', async () => {
    const { native, cast } = setup()
    await cast.endSession()
    await cast.endSession({ transferBackToLocal: true })
    await cast.endSession({ transferBackToLocal: false })
    expect(native.calls).toEqual([
      ['endSession', true],
      ['endSession', true],
      ['endSession', false],
    ])
  })

  it('seek defaults to resumeState unchanged', async () => {
    const { native, cast } = setup()
    await cast.seek(42)
    expect(native.calls).toEqual([['seek', 42, 'unchanged']])
  })

  it('volume layers are clamped to 0..1, never forwarded out of range', async () => {
    const { native, cast } = setup()
    await cast.setStreamVolume(1.5)
    await cast.setDeviceVolume(-0.2)
    await cast.setDeviceVolume(Number.NaN)
    expect(native.calls).toEqual([
      ['setStreamVolume', 1],
      ['setDeviceVolume', 0],
      ['setDeviceVolume', 0],
    ])
  })

  it('queueLoad and queueInsert reject empty item lists before the bridge', async () => {
    const { native, cast } = setup()
    await expect(cast.queueLoad([])).rejects.toMatchObject({
      code: 'invalid-argument',
    })
    await expect(cast.queueInsert([])).rejects.toMatchObject({
      code: 'invalid-argument',
    })
    expect(native.calls).toEqual([])
  })

  it('native rejections come back as typed CastErrors', async () => {
    const { native, cast } = setup()
    native.rejectWith = '[no-session] No connected cast session.'
    const error = await cast.play().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CastError)
    expect((error as CastErrorType).code).toBe('no-session')
  })
})

describe('createCast — events', () => {
  it('castState narrows the optional device to null', () => {
    const { native, cast } = setup()
    const seen: CastEventMap['castState'][] = []
    cast.addListener('castState', (e) => seen.push(e))
    native.emitCastState({ state: 'idle' })
    native.emitCastState({
      state: 'connected',
      device: { id: 'd1', name: 'Speaker' },
    })
    expect(seen).toEqual([
      { state: 'idle', device: null },
      { state: 'connected', device: { id: 'd1', name: 'Speaker' } },
    ])
  })

  it('devices events surface the plain array', () => {
    const { native, cast } = setup()
    const seen: CastEventMap['devices'][] = []
    cast.addListener('devices', (e) => seen.push(e))
    native.emitDevices({ devices: [{ id: 'd1', name: 'Speaker' }] })
    expect(seen).toEqual([[{ id: 'd1', name: 'Speaker' }]])
  })

  it('unsubscribe removes exactly the native listener it added, once', () => {
    const { native, cast } = setup()
    const unsubscribe = cast.addListener('mediaStatus', () => {})
    expect(native.listenerCounts().mediaStatus).toBe(1)
    unsubscribe()
    unsubscribe()
    expect(native.listenerCounts().mediaStatus).toBe(0)
  })

  it('an unknown event name fails loudly', () => {
    const { cast } = setup()
    expect(() => cast.addListener('nonsense' as never, () => {})).toThrowError(
      /Unknown event "nonsense"/
    )
  })

  describe('the error event', () => {
    it('idleReason error becomes a cast-receiver-fetch CastError', () => {
      const { native, cast } = setup()
      const seen: CastError[] = []
      cast.addListener('error', (e) => seen.push(e))
      native.emitMediaStatus(
        playingStatus({ playerState: 'idle', idleReason: 'error' })
      )
      expect(seen).toHaveLength(1)
      expect(seen[0]?.code).toBe('cast-receiver-fetch')
    })

    it('finished/cancelled/interrupted idles are not errors', () => {
      const { native, cast } = setup()
      const seen: CastError[] = []
      cast.addListener('error', (e) => seen.push(e))
      for (const idleReason of [
        'finished',
        'cancelled',
        'interrupted',
      ] as const) {
        native.emitMediaStatus(
          playingStatus({ playerState: 'idle', idleReason })
        )
      }
      expect(seen).toEqual([])
    })

    it('one receiver failure arriving on both native channels emits once', () => {
      const { native, cast } = setup()
      const seen: CastError[] = []
      cast.addListener('error', (e) => seen.push(e))
      // The SDK typically fires onMediaError AND a status with
      // idleReason=error for the same failure.
      native.emitMediaError({ detailedErrorCode: 311, reason: 'LOAD_FAILED' })
      native.emitMediaStatus(
        playingStatus({ playerState: 'idle', idleReason: 'error' })
      )
      expect(seen).toHaveLength(1)
      expect(seen[0]?.code).toBe('cast-receiver-fetch')
      expect(seen[0]?.statusCode).toBe(311)
    })

    it('the same failure with the status FIRST still emits once (regression)', () => {
      // The two channels race and the SDK does not promise an order. With the
      // callback first the latch used to hold; with the status first the
      // media-error path emitted unconditionally, so one receiver failure
      // produced two `error` events — and in `handoff-to-cast` that is two
      // fallbacks to local for one failure.
      const { native, cast } = setup()
      const seen: CastError[] = []
      cast.addListener('error', (e) => seen.push(e))
      native.emitMediaStatus(
        playingStatus({ playerState: 'idle', idleReason: 'error' })
      )
      native.emitMediaError({ detailedErrorCode: 311, reason: 'LOAD_FAILED' })
      expect(seen).toHaveLength(1)
      expect(seen[0]?.code).toBe('cast-receiver-fetch')
    })

    describe('the iOS-shaped stream (no SDK media-error callback)', () => {
      // GoogleCast 4.8.6 has no media-error callback, so the iOS half
      // synthesizes one from `playerState == .idle && idleReason == .error`.
      // JS therefore sees a mediaStatus AND a detail-free media error for the
      // same failure — these tests pin what the app observes.

      it('an error that arrives ONLY via the idle status still fires', () => {
        const { native, cast } = setup()
        const seen: CastError[] = []
        cast.addListener('error', (e) => seen.push(e))
        native.emitMediaStatus(
          playingStatus({ playerState: 'idle', idleReason: 'error' })
        )
        expect(seen).toHaveLength(1)
        expect(seen[0]?.code).toBe('cast-receiver-fetch')
        expect(seen[0]?.statusCode).toBeUndefined()
      })

      it('the native synthesis following the status does not double-emit', () => {
        const { native, cast } = setup()
        const seen: CastError[] = []
        cast.addListener('error', (e) => seen.push(e))
        // Exactly the iOS ordering: `didUpdate mediaStatus` emits the status,
        // then `synthesizeMediaError` emits a detail-free media error.
        native.emitMediaStatus(
          playingStatus({ playerState: 'idle', idleReason: 'error' })
        )
        native.emitMediaError({})
        expect(seen).toHaveLength(1)
      })

      it('an iOS error is indistinguishable from an Android one', () => {
        const ios = setup()
        const iosSeen: CastError[] = []
        ios.cast.addListener('error', (e) => iosSeen.push(e))
        ios.native.emitMediaStatus(
          playingStatus({ playerState: 'idle', idleReason: 'error' })
        )
        ios.native.emitMediaError({})

        const android = setup()
        const androidSeen: CastError[] = []
        android.cast.addListener('error', (e) => androidSeen.push(e))
        android.native.emitMediaStatus(
          playingStatus({ playerState: 'idle', idleReason: 'error' })
        )
        android.native.emitMediaError({
          detailedErrorCode: 905,
          reason: 'MEDIA_ERROR_MESSAGE',
        })

        expect(iosSeen).toHaveLength(1)
        expect(androidSeen).toHaveLength(1)
        // Same family and same actionable message on both — only Android's
        // optional detail differs, and nothing may branch on it.
        expect(iosSeen[0]?.code).toBe(androidSeen[0]?.code)
        expect(iosSeen[0]?.message).toBe(androidSeen[0]?.message)
      })

      it('ordinary idles are never turned into errors, callback or not', () => {
        const { native, cast } = setup()
        const seen: CastError[] = []
        cast.addListener('error', (e) => seen.push(e))
        for (const idleReason of [
          'none',
          'finished',
          'cancelled',
          'interrupted',
        ] as const) {
          native.emitMediaStatus(
            playingStatus({ playerState: 'idle', idleReason })
          )
        }
        expect(seen).toEqual([])
      })

      it('the synthesized idle for a dead media session is not an error', () => {
        // Both halves synthesize `idle/interrupted` when the receiver's media
        // session disappears (`mediaStatus` goes null). That is a state, and
        // must never reach the app as a receiver-fetch failure.
        const { native, cast } = setup()
        const seen: CastError[] = []
        const statuses: unknown[] = []
        cast.addListener('error', (e) => seen.push(e))
        cast.addListener('mediaStatus', (s) => statuses.push(s))
        native.emitMediaStatus(playingStatus({ playerState: 'playing' }))
        native.emitMediaStatus(
          playingStatus({
            playerState: 'idle',
            idleReason: 'interrupted',
            position: 0,
          })
        )
        expect(statuses).toHaveLength(2)
        expect(seen).toEqual([])
      })

      it('a retry that fails again is reported again', () => {
        const { native, cast } = setup()
        const seen: CastError[] = []
        cast.addListener('error', (e) => seen.push(e))
        native.emitMediaStatus(
          playingStatus({ playerState: 'idle', idleReason: 'error' })
        )
        native.emitMediaError({})
        // A new load: loading → buffering → and it fails again.
        native.emitMediaStatus(playingStatus({ playerState: 'loading' }))
        native.emitMediaStatus(playingStatus({ playerState: 'buffering' }))
        native.emitMediaStatus(
          playingStatus({ playerState: 'idle', idleReason: 'error' })
        )
        native.emitMediaError({})
        expect(seen).toHaveLength(2)
      })
    })

    it('the de-dupe latch resets once playback leaves idle', () => {
      const { native, cast } = setup()
      const seen: CastError[] = []
      cast.addListener('error', (e) => seen.push(e))
      native.emitMediaStatus(
        playingStatus({ playerState: 'idle', idleReason: 'error' })
      )
      native.emitMediaStatus(playingStatus({ playerState: 'playing' }))
      native.emitMediaStatus(
        playingStatus({ playerState: 'idle', idleReason: 'error' })
      )
      expect(seen).toHaveLength(2)
    })

    it('unsubscribing the error listener removes both native listeners', () => {
      const { native, cast } = setup()
      const unsubscribe = cast.addListener('error', () => {})
      expect(native.listenerCounts().mediaStatus).toBe(1)
      expect(native.listenerCounts().mediaError).toBe(1)
      unsubscribe()
      expect(native.listenerCounts().mediaStatus).toBe(0)
      expect(native.listenerCounts().mediaError).toBe(0)
    })
  })

  it('session and deviceVolume events pass through untouched', () => {
    const { native, cast } = setup()
    const sessions: CastEventMap['session'][] = []
    const volumes: CastEventMap['deviceVolume'][] = []
    cast.addListener('session', (e) => sessions.push(e))
    cast.addListener('deviceVolume', (e) => volumes.push(e))
    native.emitSession({ type: 'startFailed', errorCode: 15 })
    native.emitDeviceVolume({ volume: 0.4, muted: false })
    expect(sessions).toEqual([{ type: 'startFailed', errorCode: 15 }])
    expect(volumes).toEqual([{ volume: 0.4, muted: false }])
  })

  it('queueChanged listeners fire with no payload', () => {
    const { native, cast } = setup()
    let fired = 0
    cast.addListener('queueChanged', () => {
      fired += 1
    })
    native.emitQueueChanged()
    expect(fired).toBe(1)
  })
})
