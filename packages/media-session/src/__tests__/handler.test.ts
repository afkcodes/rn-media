import { describe, expect, it, vi } from 'vitest'

import { BaseMediaHandler, CompositeMediaHandler } from '../handler'
import type { MediaHandler } from '../types'
import { RecordingHandler } from './fakes'

describe('BaseMediaHandler', () => {
  it('is a no-op for every command', async () => {
    const handler = new BaseMediaHandler()
    expect(handler.play()).toBeUndefined()
    expect(handler.pause()).toBeUndefined()
    expect(handler.stop()).toBeUndefined()
    expect(handler.seekTo(1)).toBeUndefined()
    expect(handler.skipToNext()).toBeUndefined()
    expect(handler.skipToPrevious()).toBeUndefined()
    expect(handler.skipToQueueItem(0)).toBeUndefined()
    expect(handler.setRate(2)).toBeUndefined()
    expect(handler.onTaskRemoved()).toBeUndefined()
    expect(handler.customAction('x')).toBeUndefined()
    await expect(handler.getChildren('root')).resolves.toEqual([])
    await expect(handler.getMediaItem('a')).resolves.toBeUndefined()
  })
})

describe('CompositeMediaHandler', () => {
  it('forwards every method to the wrapped handler with its arguments', async () => {
    const inner = new RecordingHandler()
    const outer = new CompositeMediaHandler(inner)

    outer.play()
    outer.pause()
    outer.stop()
    outer.seekTo(1234)
    outer.skipToNext()
    outer.skipToPrevious()
    outer.skipToQueueItem(7)
    outer.setRate(0.5)
    outer.onTaskRemoved()
    outer.customAction('like', { stars: 5 })
    await outer.getChildren('root')
    await outer.getMediaItem('a')

    expect(inner.calls).toEqual([
      'play',
      'pause',
      'stop',
      'seekTo(1234)',
      'skipToNext',
      'skipToPrevious',
      'skipToQueueItem(7)',
      'setRate(0.5)',
      'onTaskRemoved',
      'customAction(like,{"stars":5})',
      'getChildren(root)',
      'getMediaItem(a)',
    ])
  })

  it('propagates the inner return value so callers can still await', async () => {
    const inner = new RecordingHandler()
    inner.rejectWith = new Error('nope')
    const outer = new CompositeMediaHandler(inner)
    await expect(outer.play()).rejects.toThrow('nope')
  })

  it('lets a decorator intercept one method and delegate the rest', () => {
    const inner = new RecordingHandler()
    const seen: string[] = []

    class Analytics extends CompositeMediaHandler {
      override play(): void | Promise<void> {
        seen.push('analytics:play')
        return super.play()
      }
    }

    const decorated = new Analytics(inner)
    decorated.play()
    decorated.pause()

    expect(seen).toEqual(['analytics:play'])
    expect(inner.calls).toEqual(['play', 'pause'])
  })

  it('nests', () => {
    const inner = new RecordingHandler()
    const doubled = new CompositeMediaHandler(new CompositeMediaHandler(inner))
    doubled.seekTo(9)
    expect(inner.calls).toEqual(['seekTo(9)'])
  })
})

describe('repeat and shuffle on the handler bases (B2)', () => {
  it('BaseMediaHandler supplies no-ops so subclasses need not', () => {
    const base = new BaseMediaHandler()
    expect(() => base.onSetRepeatMode('all')).not.toThrow()
    expect(() => base.onSetShuffle(true)).not.toThrow()
  })

  it('CompositeMediaHandler forwards both to the inner handler', () => {
    const inner = new RecordingHandler()
    const composite = new CompositeMediaHandler(inner)

    composite.onSetRepeatMode('one')
    composite.onSetShuffle(false)

    expect(inner.calls).toEqual(['onSetRepeatMode(one)', 'onSetShuffle(false)'])
  })

  it('CompositeMediaHandler tolerates an inner handler that omits them', () => {
    // The interface marks both optional so that adding them was not a breaking
    // change for structural implementors — the decorator has to honour that.
    const inner = new BaseMediaHandler()
    delete (inner as Partial<MediaHandler>).onSetRepeatMode
    delete (inner as Partial<MediaHandler>).onSetShuffle
    const composite = new CompositeMediaHandler(inner)

    expect(() => composite.onSetRepeatMode('off')).not.toThrow()
    expect(() => composite.onSetShuffle(true)).not.toThrow()
  })
})

describe('session errors', () => {
  const error = {
    code: 'artworkFailed',
    severity: 'degraded',
    message: 'no bytes came back',
  } as const

  it('BaseMediaHandler logs rather than swallowing — the one non-no-op default', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      new BaseMediaHandler().onSessionError(error)

      expect(consoleError).toHaveBeenCalledWith(
        '[media-session] degraded · artworkFailed: no bytes came back'
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('CompositeMediaHandler forwards to an inner handler that implements it', () => {
    const inner = new RecordingHandler()

    new CompositeMediaHandler(inner).onSessionError(error)

    expect(inner.sessionErrors).toEqual([error])
  })

  it('CompositeMediaHandler logs instead of dropping it on an inner that does not', () => {
    // The trap this closes: the decorator *has* the method, so the service's own
    // console floor steps back — and a plain `?.()` would then swallow the error
    // on the way to an inner handler that never implemented the channel.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const inner = new BaseMediaHandler()
      delete (inner as Partial<MediaHandler>).onSessionError

      expect(() =>
        new CompositeMediaHandler(inner).onSessionError(error)
      ).not.toThrow()
      expect(consoleError).toHaveBeenCalledWith(
        '[media-session] degraded · artworkFailed: no bytes came back'
      )
    } finally {
      consoleError.mockRestore()
    }
  })
})
