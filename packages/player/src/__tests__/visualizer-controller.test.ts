import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlayerErrorException, toVisualizerError } from '../errors'
import { MpvProperty } from '../properties'
import { VisualizerController } from '../visualizer-controller'
import { FakeMpvClient, toneCapture } from './fake-mpv-client'

const NOT_FOUND = '[mpv:-8] mpv_get_property("pcm-tap", DOUBLE): property not found'

function starts(client: FakeMpvClient) {
  return client.visualizerCalls.filter((call) => call.kind === 'start')
}

function stops(client: FakeMpvClient) {
  return client.visualizerCalls.filter((call) => call.kind === 'stop')
}

describe('VisualizerController — laziness', () => {
  let client: FakeMpvClient
  let controller: VisualizerController

  beforeEach(() => {
    client = new FakeMpvClient()
    controller = new VisualizerController(client)
  })

  it('touches nothing before the first subscribe', () => {
    // Reading capabilities is a property read and nothing else — no tap armed,
    // no ring allocated, no sampler thread.
    expect(controller.capabilities.fft).toBe(true)
    expect(controller.active).toBe(false)
    expect(client.visualizerCalls).toHaveLength(0)
  })

  it('starts on the first subscribe and stops on the last unsubscribe', () => {
    const stop = controller.subscribe(() => {})
    expect(controller.active).toBe(true)
    expect(starts(client)).toHaveLength(1)

    stop()
    expect(controller.active).toBe(false)
    expect(stops(client)).toHaveLength(1)
  })

  it('is idempotent per unsubscribe handle', () => {
    const stop = controller.subscribe(() => {})
    stop()
    stop()
    stop()
    expect(stops(client)).toHaveLength(1)
  })

  it('re-arms cleanly after a full teardown', () => {
    controller.subscribe(() => {})()
    controller.subscribe(() => {})()
    expect(starts(client)).toHaveLength(2)
    expect(stops(client)).toHaveLength(2)
    expect(controller.active).toBe(false)
  })

  it('keeps the sampler alive while any subscriber remains', () => {
    const first = controller.subscribe(() => {})
    const second = controller.subscribe(() => {})
    first()
    expect(controller.active).toBe(true)
    expect(stops(client)).toHaveLength(0)
    second()
    expect(controller.active).toBe(false)
    expect(stops(client)).toHaveLength(1)
  })

  it('caches the capability probe', () => {
    const spy = vi.spyOn(client, 'getPropertyNumber')
    controller.capabilities
    controller.capabilities
    controller.capabilities
    expect(spy.mock.calls.filter(([name]) => name === MpvProperty.pcmTap)).toHaveLength(1)
  })
})

describe('VisualizerController — shared native parameters', () => {
  let client: FakeMpvClient
  let controller: VisualizerController

  beforeEach(() => {
    client = new FakeMpvClient()
    controller = new VisualizerController(client)
  })

  it('does not restart for a second subscriber with compatible options', () => {
    controller.subscribe(() => {}, { fftSize: 1024, fps: 30 })
    controller.subscribe(() => {}, { fftSize: 1024, fps: 30, bands: 64 })
    // Band count is pure maths per subscriber; only the native trio restarts.
    expect(starts(client)).toHaveLength(1)
  })

  it('restarts with the union when a subscriber needs more', () => {
    controller.subscribe(() => {}, { fftSize: 512, fps: 20, waveform: false })
    controller.subscribe(() => {}, { fftSize: 2048, fps: 45, waveform: true })
    const calls = starts(client)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ fftSize: 2048, fps: 45, waveform: true })
  })

  it('shrinks back to what the remaining subscriber needs', () => {
    const small = controller.subscribe(() => {}, { fftSize: 512, fps: 20 })
    const big = controller.subscribe(() => {}, { fftSize: 4096, fps: 60 })
    big()
    expect(starts(client).at(-1)).toMatchObject({ fftSize: 512, fps: 20 })
    small()
  })

  it('passes the resolved fps and fftSize straight through', () => {
    controller.subscribe(() => {}, { fftSize: 4096, fps: 60, waveform: true })
    expect(starts(client)[0]).toEqual({
      kind: 'start',
      fftSize: 4096,
      fps: 60,
      waveform: true,
    })
  })
})

describe('VisualizerController — delivery', () => {
  let client: FakeMpvClient
  let controller: VisualizerController

  beforeEach(() => {
    client = new FakeMpvClient()
    controller = new VisualizerController(client)
  })

  it('decodes captures and delivers them to every subscriber', () => {
    const a = vi.fn()
    const b = vi.fn()
    controller.subscribe(a, { bands: 8 })
    controller.subscribe(b, { bands: 16 })
    controller.handleCapture(toneCapture(10, 0.5, { bins: 129 }))
    expect(a.mock.calls[0]![0].bands).toHaveLength(8)
    expect(b.mock.calls[0]![0].bands).toHaveLength(16)
  })

  it('stops delivering after unsubscribe', () => {
    const listener = vi.fn()
    const stop = controller.subscribe(listener)
    controller.handleCapture(toneCapture(10, 0.5, { bins: 129 }))
    stop()
    controller.handleCapture(toneCapture(10, 0.5, { bins: 129 }))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores captures that arrive with nobody listening', () => {
    expect(() =>
      controller.handleCapture(toneCapture(10, 0.5, { bins: 129 }))
    ).not.toThrow()
  })

  it('keeps each subscriber on its own smoothing state', () => {
    const snappy: number[] = []
    const slow: number[] = []
    controller.subscribe((f) => snappy.push(f.bands[0]!), {
      bands: 1,
      attack: 1,
      autoGain: false,
    })
    controller.subscribe((f) => slow.push(f.bands[0]!), {
      bands: 1,
      attack: 0.1,
      autoGain: false,
    })
    controller.handleCapture(toneCapture(10, 1, { bins: 129 }))
    expect(snappy[0]).toBeGreaterThan(slow[0]!)
  })
})

describe('VisualizerController — typed failure', () => {
  it('rejects with `unsupported` when the linked libmpv has no PCM tap', () => {
    const client = new FakeMpvClient()
    client.readErrors.set(MpvProperty.pcmTap, NOT_FOUND)
    const controller = new VisualizerController(client)
    expect(controller.capabilities.fft).toBe(false)
    try {
      controller.subscribe(() => {})
      expect.unreachable('subscribe should have thrown')
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(PlayerErrorException)
      expect((thrown as PlayerErrorException).playerError.code).toBe('unsupported')
    }
  })

  it('rejects with `unsupported` when there is no client at all', () => {
    const controller = new VisualizerController(undefined)
    expect(controller.capabilities.fft).toBe(false)
    expect(() => controller.subscribe(() => {})).toThrow(PlayerErrorException)
  })

  it('maps a tagged native start failure to `unsupported`', () => {
    const client = new FakeMpvClient()
    client.visualizerRejection =
      '[visualizer:unavailable] this libmpv has no PCM tap.'
    const controller = new VisualizerController(client)
    try {
      controller.subscribe(() => {})
      expect.unreachable('subscribe should have thrown')
    } catch (thrown) {
      expect((thrown as PlayerErrorException).playerError.code).toBe('unsupported')
    }
  })

  it('leaves no phantom subscriber behind when subscribe fails', () => {
    const client = new FakeMpvClient()
    client.visualizerRejection = '[visualizer:unavailable] nope'
    const controller = new VisualizerController(client)
    expect(() => controller.subscribe(() => {})).toThrow()

    // A phantom listener would make the next unsubscribe tear down somebody
    // else's capture — and would keep the sampler running with nobody looking.
    client.visualizerRejection = undefined
    const stop = controller.subscribe(() => {})
    expect(starts(client)).toHaveLength(1)
    stop()
    expect(controller.active).toBe(false)
  })
})

describe('VisualizerController — destroy', () => {
  it('stops the sampler and refuses further subscriptions', () => {
    const client = new FakeMpvClient()
    const controller = new VisualizerController(client)
    controller.subscribe(() => {})
    controller.destroy()
    expect(controller.active).toBe(false)
    expect(stops(client)).toHaveLength(1)
    expect(() => controller.subscribe(() => {})).toThrow(/destroyed/)
  })

  it('is idempotent', () => {
    const client = new FakeMpvClient()
    const controller = new VisualizerController(client)
    controller.subscribe(() => {})
    controller.destroy()
    controller.destroy()
    expect(stops(client)).toHaveLength(1)
  })

  it('does not call stop when nothing was ever started', () => {
    const client = new FakeMpvClient()
    new VisualizerController(client).destroy()
    expect(client.visualizerCalls).toHaveLength(0)
  })

  it('swallows a failing native stop so teardown always completes', () => {
    const client = new FakeMpvClient()
    const controller = new VisualizerController(client)
    controller.subscribe(() => {})
    vi.spyOn(client, 'stopVisualizer').mockImplementation(() => {
      throw new Error('mpv is already gone')
    })
    expect(() => controller.destroy()).not.toThrow()
  })
})

describe('toVisualizerError', () => {
  it('classifies a tagged unavailable engine as `unsupported`', () => {
    expect(
      toVisualizerError(new Error('[visualizer:unavailable] no PCM tap here'))
    ).toEqual({
      code: 'unsupported',
      message: 'no PCM tap here',
      retryable: false,
    })
  })

  it('finds the tag even when Nitro has wrapped the message', () => {
    const error = toVisualizerError(
      new Error(
        'MpvClient.startVisualizer(...): [visualizer:unavailable] no PCM tap here'
      )
    )
    expect(error.code).toBe('unsupported')
  })

  it('strips a stack trace out of the human-readable message', () => {
    const error = toVisualizerError(
      new Error('[visualizer:unavailable] no PCM tap here\n    at Foo.bar(X.kt:12)')
    )
    expect(error.message).toBe('no PCM tap here')
  })

  it('never swallows an untagged throw', () => {
    expect(toVisualizerError(new Error('something else entirely'))).toEqual({
      code: 'invalid-state',
      message: 'something else entirely',
      retryable: false,
    })
  })

  it('passes a typed error straight through', () => {
    const original = new PlayerErrorException({
      code: 'disposed',
      message: 'gone',
      retryable: false,
    })
    expect(toVisualizerError(original)).toBe(original.playerError)
  })
})
