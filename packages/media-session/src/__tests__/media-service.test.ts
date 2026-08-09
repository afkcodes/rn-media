import { describe, expect, it, vi } from 'vitest'

import { MediaSessionError } from '../errors'
import { createMediaService } from '../media-service'
import type { MediaServiceApi } from '../types'
import {
  FakeNativeMediaSession,
  RecordingHandler,
  item,
  playbackState,
} from './fakes'

async function ready(
  config: Parameters<
    ReturnType<typeof createMediaService>['init']
  >[1] = undefined
): Promise<{
  native: FakeNativeMediaSession
  handler: RecordingHandler
  service: MediaServiceApi
}> {
  const native = new FakeNativeMediaSession()
  const handler = new RecordingHandler()
  const service = await createMediaService(native).init(() => handler, config)
  return { native, handler, service }
}

describe('handler dispatch', () => {
  it('routes every native callback to the matching handler method', async () => {
    const { native, handler } = await ready()
    const handlers = native.emit()

    handlers.play()
    handlers.pause()
    handlers.stop()
    handlers.seekTo(4200)
    handlers.skipToNext()
    handlers.skipToPrevious()
    handlers.skipToQueueItem(3)
    handlers.setRate(1.5)
    handlers.onTaskRemoved()
    handlers.customAction('like', '{}')

    expect(handler.calls).toEqual([
      'play',
      'pause',
      'stop',
      'seekTo(4200)',
      'skipToNext',
      'skipToPrevious',
      'skipToQueueItem(3)',
      'setRate(1.5)',
      'onTaskRemoved',
      'customAction(like,undefined)',
    ])
  })

  it('parses customAction extras from the JSON string the bridge carries', async () => {
    const { native, handler } = await ready()
    native.emit().customAction('rate', '{"stars":5,"note":"good"}')
    expect(handler.calls).toEqual([
      'customAction(rate,{"stars":5,"note":"good"})',
    ])
  })

  it('reports malformed extras instead of crashing the command', async () => {
    const onHandlerError = vi.fn()
    const { native, handler } = await ready({ onHandlerError })

    native.emit().customAction('rate', 'not json')

    expect(onHandlerError).toHaveBeenCalledTimes(1)
    expect(onHandlerError.mock.calls[0]?.[0]).toBe('customAction')
    // The command still reaches the handler — extras are optional.
    expect(handler.calls).toEqual(['customAction(rate,undefined)'])
  })

  it('reports a JSON array as malformed extras (objects only)', async () => {
    const onHandlerError = vi.fn()
    const { native } = await ready({ onHandlerError })
    native.emit().customAction('rate', '[1,2]')
    expect(onHandlerError).toHaveBeenCalledTimes(1)
  })

  it('returns immediately and reports a rejected handler', async () => {
    const onHandlerError = vi.fn()
    const { native, handler } = await ready({ onHandlerError })
    handler.rejectWith = new Error('player exploded')

    // The whole point: dispatching never throws and never awaits.
    expect(() => native.emit().play()).not.toThrow()
    expect(onHandlerError).not.toHaveBeenCalled()

    await Promise.resolve()
    expect(onHandlerError).toHaveBeenCalledWith('play', handler.rejectWith)
  })

  it('reports a synchronously throwing handler', async () => {
    const onHandlerError = vi.fn()
    const { native, handler } = await ready({ onHandlerError })
    handler.throwWith = new Error('boom')

    expect(() => native.emit().pause()).not.toThrow()
    expect(onHandlerError).toHaveBeenCalledWith('pause', handler.throwWith)
  })
})

describe('init lifecycle', () => {
  it('passes the normalized config to native and defaults stopForegroundOnPause', async () => {
    const native = new FakeNativeMediaSession()
    await createMediaService(native).init(() => new RecordingHandler(), {
      android: {
        notificationChannelId: 'playback',
        notificationChannelName: 'Playback',
      },
    })
    expect(native.configs).toEqual([
      {
        android: {
          notificationChannelId: 'playback',
          notificationChannelName: 'Playback',
          notificationIcon: undefined,
          stopForegroundOnPause: true,
        },
        ios: undefined,
      },
    ])
  })

  it('rejects a second init', async () => {
    const native = new FakeNativeMediaSession()
    const service = createMediaService(native)
    await service.init(() => new RecordingHandler())

    await expect(service.init(() => new RecordingHandler())).rejects.toThrow(
      MediaSessionError
    )
    await expect(
      service.init(() => new RecordingHandler())
    ).rejects.toMatchObject({ code: 'alreadyInitialized' })
    expect(native.configs).toHaveLength(1)
  })

  it('rejects two concurrent inits without awaiting either', async () => {
    const native = new FakeNativeMediaSession()
    const service = createMediaService(native)

    const first = service.init(() => new RecordingHandler())
    const second = service.init(() => new RecordingHandler())

    await expect(first).resolves.toBeDefined()
    await expect(second).rejects.toMatchObject({ code: 'alreadyInitialized' })
  })

  it('stays re-initializable when native init fails', async () => {
    const native = new FakeNativeMediaSession()
    native.initializeError = new Error('no notification permission')
    const service = createMediaService(native)

    await expect(service.init(() => new RecordingHandler())).rejects.toThrow(
      'no notification permission'
    )

    native.initializeError = undefined
    await expect(service.init(() => new RecordingHandler())).resolves.toBeDefined()
  })

  it('allows init again after stopService', async () => {
    const native = new FakeNativeMediaSession()
    const service = createMediaService(native)
    await service.init(() => new RecordingHandler())
    await service.stopService()
    await expect(service.init(() => new RecordingHandler())).resolves.toBeDefined()
    expect(native.stopServiceCalls).toBe(1)
  })

  it('keeps the session up when native stopService fails', async () => {
    const native = new FakeNativeMediaSession()
    native.stopServiceError = new Error('binder died')
    const service = createMediaService(native)
    await service.init(() => new RecordingHandler())

    await expect(service.stopService()).rejects.toThrow('binder died')
    // Still initialized: pretending otherwise would let init() stack a second
    // session on top of a live one.
    await expect(service.init(() => new RecordingHandler())).rejects.toMatchObject(
      { code: 'alreadyInitialized' }
    )
  })

  it('refuses every broadcast before init', () => {
    const service = createMediaService(new FakeNativeMediaSession())
    expect(() => service.setPlaybackState(playbackState())).toThrow(
      MediaSessionError
    )
    expect(() => service.setMediaItem(item('a'))).toThrowError(
      /notInitialized|before init/
    )
    expect(() => service.setQueue([])).toThrow(MediaSessionError)
    return expect(service.stopService()).rejects.toMatchObject({
      code: 'notInitialized',
    })
  })

  it('refuses broadcasts again after stopService', async () => {
    const { service } = await ready()
    await service.stopService()
    expect(() => service.setQueue([])).toThrowError(/notInitialized|before init/)
  })
})

describe('broadcast round-trip', () => {
  it('carries the position anchor to native byte for byte', async () => {
    const { native, service } = await ready()
    const anchor = { value: 61_234, at: 1_700_000_000_123, rate: 1.25 }

    service.setPlaybackState(playbackState({ position: anchor }))

    // The anchor is the payload the whole package exists to move: any silent
    // rounding or unit change here is invisible until a lock screen drifts.
    expect(native.last.playbackState?.position).toEqual(anchor)
    expect(native.last.playbackState?.position).not.toBe(anchor)
  })

  it('fills the optional broadcast arrays so native never sees undefined', async () => {
    const { native, service } = await ready()
    service.setPlaybackState(playbackState())
    expect(native.last.playbackState).toMatchObject({
      status: 'playing',
      controls: [],
      capabilities: [],
      customActions: [],
    })
  })

  it('passes controls, compact indices and queue index through', async () => {
    const { native, service } = await ready()
    service.setPlaybackState(
      playbackState({
        controls: ['skipToPrevious', 'pause', 'skipToNext', 'stop'],
        capabilities: ['seek', 'setRate', 'skipToQueueItem'],
        compactControlIndices: [0, 1, 2],
        queueIndex: 4,
        bufferedPosition: 90_000,
        customActions: [{ name: 'like', title: 'Like' }],
      })
    )
    expect(native.last.playbackState).toMatchObject({
      controls: ['skipToPrevious', 'pause', 'skipToNext', 'stop'],
      capabilities: ['seek', 'setRate', 'skipToQueueItem'],
      compactControlIndices: [0, 1, 2],
      queueIndex: 4,
      bufferedPosition: 90_000,
      customActions: [{ name: 'like', title: 'Like' }],
    })
  })

  it('clears the media item when called with nothing', async () => {
    const { native, service } = await ready()
    service.setMediaItem(item('a'))
    service.setMediaItem()
    expect(native.mediaItems).toEqual([
      { id: 'a', title: 'Title a' },
      undefined,
    ])
  })

  it('broadcasts the queue', async () => {
    const { native, service } = await ready()
    service.setQueue([item('a'), item('b')])
    expect(native.last.queue).toHaveLength(2)
  })
})
