import { describe, expect, it, vi } from 'vitest'

import { BaseMediaHandler, CompositeMediaHandler } from '../handler'
import { createMediaService } from '../media-service'
import type { MediaServiceApi } from '../types'
import { FakeNativeMediaSession, RecordingHandler } from './fakes'

async function ready(): Promise<{
  native: FakeNativeMediaSession
  handler: RecordingHandler
  service: MediaServiceApi
}> {
  const native = new FakeNativeMediaSession()
  const handler = new RecordingHandler()
  const service = await createMediaService(native).init(() => handler)
  return { native, handler, service }
}

describe('setSleepTimer', () => {
  it('passes a validated duration to native', async () => {
    const { native, service } = await ready()
    service.setSleepTimer(45)
    expect(native.sleepTimers).toEqual([45])
  })

  it('re-arming replaces rather than stacks (native contract, asserted here)', async () => {
    const { native, service } = await ready()
    service.setSleepTimer(60)
    service.setSleepTimer(30)
    expect(native.sleepTimers).toEqual([60, 30])
    expect(service.getSleepTimerRemaining()).toBe(30)
  })

  it('rejects nonsense before it reaches native', async () => {
    const { native, service } = await ready()
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => service.setSleepTimer(value)).toThrowError(/seconds/)
    }
    expect(native.sleepTimers).toEqual([])
  })

  it('refuses to arm before init() resolved', () => {
    const service = createMediaService(new FakeNativeMediaSession())
    expect(() => service.setSleepTimer(30)).toThrowError(/setSleepTimer\(\)/)
    expect(() => service.cancelSleepTimer()).toThrowError(
      /cancelSleepTimer\(\)/
    )
    expect(() => service.getSleepTimerRemaining()).toThrowError(
      /getSleepTimerRemaining\(\)/
    )
  })
})

describe('cancelSleepTimer', () => {
  it('forwards to native and clears the remaining time', async () => {
    const { native, service } = await ready()
    service.setSleepTimer(120)
    expect(service.getSleepTimerRemaining()).toBe(120)

    service.cancelSleepTimer()
    expect(native.cancelSleepTimerCalls).toBe(1)
    expect(service.getSleepTimerRemaining()).toBeUndefined()
  })
})

describe('getSleepTimerRemaining', () => {
  it('is undefined when no timer is armed', async () => {
    const { service } = await ready()
    expect(service.getSleepTimerRemaining()).toBeUndefined()
  })
})

describe('onSleepTimer', () => {
  it('reaches the handler when the platform timer fires', async () => {
    const { native, handler, service } = await ready()
    service.setSleepTimer(45)

    native.fireSleepTimer()

    expect(handler.calls).toEqual(['onSleepTimer'])
    // Native fired it, so the arm is spent.
    expect(service.getSleepTimerRemaining()).toBeUndefined()
  })

  it('does NOT pause from JS — the native side already did', async () => {
    const { native, handler, service } = await ready()
    service.setSleepTimer(45)
    native.fireSleepTimer()
    // The whole ordering contract in one assertion: if this package ever
    // started pausing from JS, the pause would arrive twice and late.
    expect(handler.calls).not.toContain('pause')
  })

  it('reports a throwing handler instead of letting it escape', async () => {
    const onHandlerError = vi.fn()
    const native = new FakeNativeMediaSession()
    const handler = new RecordingHandler()
    handler.throwWith = new Error('boom')
    await createMediaService(native).init(() => handler, { onHandlerError })

    native.fireSleepTimer()

    expect(onHandlerError).toHaveBeenCalledWith('onSleepTimer', handler.throwWith)
  })

  it('is a no-op on BaseMediaHandler, and delegates through a decorator', () => {
    expect(new BaseMediaHandler().onSleepTimer()).toBeUndefined()

    const inner = new RecordingHandler()
    class Decorated extends CompositeMediaHandler {}
    new Decorated(inner).onSleepTimer()
    expect(inner.calls).toEqual(['onSleepTimer'])
  })
})
