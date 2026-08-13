import { describe, expect, it, vi } from 'vitest'

import { MediaSessionError } from '../errors'
import { BaseMediaHandler } from '../handler'
import { createMediaService } from '../media-service'
import type { MediaHandler, MediaServiceApi } from '../types'
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
          stopForegroundTimeoutMs: undefined,
          // Opt-in: a service that can restart the app from a snapshot is not
          // something an app gets by omission.
          playbackResumption: false,
          notificationColor: undefined,
        },
        ios: undefined,
        // Both defaulted, and defaulted to the SAME number on purpose: the
        // asymmetry this replaced (iOS 15/15, Android media3's 5/15) was a
        // parity defect, not a platform fact.
        jumpForwardSeconds: 15,
        jumpBackwardSeconds: 15,
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
    await expect(
      service.init(() => new RecordingHandler())
    ).resolves.toBeDefined()
  })

  it('allows init again after stopService', async () => {
    const native = new FakeNativeMediaSession()
    const service = createMediaService(native)
    await service.init(() => new RecordingHandler())
    await service.stopService()
    await expect(
      service.init(() => new RecordingHandler())
    ).resolves.toBeDefined()
    expect(native.stopServiceCalls).toBe(1)
  })

  it('comes back fully working after stopService — broadcasts and commands', async () => {
    // The regression this guards: "stop, then play again" must rebuild a live
    // session. A half-restored one (broadcasts refused, or commands still
    // routed to the discarded handler) is how an app ends up playing audio
    // with no notification and no remote control behind it.
    const native = new FakeNativeMediaSession()
    const service = createMediaService(native)
    const first = new RecordingHandler()
    await service.init(() => first)
    service.setPlaybackState(playbackState())
    await service.stopService()

    const second = new RecordingHandler()
    const restarted = await service.init(() => second)

    restarted.setQueue([item('a')])
    restarted.setMediaItem(item('a'))
    restarted.setPlaybackState(playbackState({ status: 'playing' }))
    expect(native.playbackStates).toHaveLength(2)
    expect(native.last.queue).toHaveLength(1)

    native.emit().pause()
    expect(second.calls).toEqual(['pause'])
    // The handler from the first session is gone, not merely shadowed.
    expect(first.calls).toEqual([])
  })

  it('keeps the session up when native stopService fails', async () => {
    const native = new FakeNativeMediaSession()
    native.stopServiceError = new Error('binder died')
    const service = createMediaService(native)
    await service.init(() => new RecordingHandler())

    await expect(service.stopService()).rejects.toThrow('binder died')
    // Still initialized: pretending otherwise would let init() stack a second
    // session on top of a live one.
    await expect(
      service.init(() => new RecordingHandler())
    ).rejects.toMatchObject({ code: 'alreadyInitialized' })
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
    expect(() => service.setQueue([])).toThrowError(
      /notInitialized|before init/
    )
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

describe('repeat and shuffle fan-in (B2)', () => {
  it('routes a remote repeat request to onSetRepeatMode', async () => {
    const { native, handler } = await ready()
    native.emit().setRepeatMode('all')
    native.emit().setRepeatMode('one')
    native.emit().setRepeatMode('off')

    expect(handler.calls).toEqual([
      'onSetRepeatMode(all)',
      'onSetRepeatMode(one)',
      'onSetRepeatMode(off)',
    ])
  })

  it('routes a remote shuffle request to onSetShuffle', async () => {
    const { native, handler } = await ready()
    native.emit().setShuffle(true)
    native.emit().setShuffle(false)

    expect(handler.calls).toEqual(['onSetShuffle(true)', 'onSetShuffle(false)'])
  })

  it('does not throw for a handler that omits the optional methods', async () => {
    // The methods are optional so that adding them is not a breaking change for
    // structural implementors of the player-agnostic contract.
    const native = new FakeNativeMediaSession()
    const bare = new BaseMediaHandler()
    delete (bare as Partial<MediaHandler>).onSetRepeatMode
    delete (bare as Partial<MediaHandler>).onSetShuffle
    await createMediaService(native).init(() => bare)

    expect(() => native.emit().setRepeatMode('all')).not.toThrow()
    expect(() => native.emit().setShuffle(true)).not.toThrow()
  })

  it('reports a throwing repeat handler under its handler-method name', async () => {
    const native = new FakeNativeMediaSession()
    const handler = new RecordingHandler()
    handler.throwWith = new Error('boom')
    const onHandlerError = vi.fn()
    await createMediaService(native).init(() => handler, { onHandlerError })

    native.emit().setRepeatMode('all')

    expect(onHandlerError).toHaveBeenCalledWith(
      'onSetRepeatMode',
      expect.any(Error)
    )
  })

  it('broadcasts the current mode and flag out on channel 1', async () => {
    const { native, service } = await ready()
    service.setPlaybackState(
      playbackState({
        repeatMode: 'all',
        shuffleEnabled: true,
        capabilities: ['setRepeatMode', 'setShuffle'],
        controls: ['repeatMode', 'shuffle'],
      })
    )

    expect(native.last.playbackState).toMatchObject({
      repeatMode: 'all',
      shuffleEnabled: true,
      capabilities: ['setRepeatMode', 'setShuffle'],
      controls: ['repeatMode', 'shuffle'],
    })
  })
})

/* -------------------------------------------------------------------------- */
/*                  onRevivalRequested (bug #47, stop-then-resume)            */
/* -------------------------------------------------------------------------- */

describe('android.onRevivalRequested', () => {
  const withCallback = (onRevivalRequested: () => void) => ({
    android: {
      notificationChannelId: 'playback',
      notificationChannelName: 'Playback',
      onRevivalRequested,
    },
  })

  it('re-runs the app init path when a revival starts after stopService', async () => {
    const revive = vi.fn()
    const { native, service } = await ready(withCallback(revive))
    await service.stopService()

    // The service found a live runtime whose module scope cannot run again,
    // and asked for an init. This is the owner-reported bug: before the fix
    // this had no path to the app at all and the card's play silently died.
    native.emitRevivalRequested()

    expect(revive).toHaveBeenCalledTimes(1)
  })

  it('a callback that calls init() brings the session fully back', async () => {
    const native = new FakeNativeMediaSession()
    const controller = createMediaService(native)
    const revive = vi.fn(() => {
      void controller.init(() => new RecordingHandler(), withCallback(revive))
    })
    const service = await controller.init(
      () => new RecordingHandler(),
      withCallback(revive)
    )
    await service.stopService()

    native.emitRevivalRequested()
    // The re-init is async (init awaits native.initialize); let it settle.
    await Promise.resolve()
    await Promise.resolve()

    expect(revive).toHaveBeenCalledTimes(1)
    expect(native.configs).toHaveLength(2)
    // The revived session dispatches commands again.
    native.emit().play()
  })

  it('is swallowed while the session is up — never a double init', async () => {
    const revive = vi.fn()
    const { native } = await ready(withCallback(revive))

    // A runtime-ready signal racing an already-ready session (e.g. a cold
    // boot whose module-scope init just finished) must not re-enter the app.
    native.emitRevivalRequested()

    expect(revive).not.toHaveBeenCalled()
  })

  it('is swallowed while an init is already in flight', async () => {
    const revive = vi.fn()
    class GatedNative extends FakeNativeMediaSession {
      override initialize(
        ...args: Parameters<FakeNativeMediaSession['initialize']>
      ): Promise<void> {
        // Capture handlers/requester synchronously — the Kotlin controller
        // registers the requester at the top of initialize — but never
        // resolve, freezing the service in `initializing`.
        void super.initialize(...args)
        return new Promise<void>(() => {})
      }
    }
    const native = new GatedNative()
    void createMediaService(native).init(
      () => new RecordingHandler(),
      withCallback(revive)
    )

    native.emitRevivalRequested()

    expect(revive).not.toHaveBeenCalled()
  })

  it('survives stopService but is replaced by the next init', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const native = new FakeNativeMediaSession()
    const controller = createMediaService(native)

    const one = await controller.init(
      () => new RecordingHandler(),
      withCallback(first)
    )
    await one.stopService()
    const two = await controller.init(
      () => new RecordingHandler(),
      withCallback(second)
    )
    await two.stopService()

    native.emitRevivalRequested()

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('does nothing (and does not throw) when the app registered no callback', async () => {
    const { native, service } = await ready()
    await service.stopService()

    expect(() => native.emitRevivalRequested()).not.toThrow()
  })

  it('reports a throwing callback to the console instead of letting it escape', async () => {
    const error = new Error('revive boom')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { native, service } = await ready(
        withCallback(() => {
          throw error
        })
      )
      await service.stopService()

      expect(() => native.emitRevivalRequested()).not.toThrow()
      expect(consoleError).toHaveBeenCalledWith(
        '[media-session] android.onRevivalRequested threw:',
        error
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('never crosses the bridge: the native config carries no function field', async () => {
    const { native } = await ready(withCallback(() => {}))

    expect(native.configs[0]?.android).not.toHaveProperty('onRevivalRequested')
  })
})
