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
