import { describe, expect, it } from 'vitest'

import { BaseMediaHandler, CompositeMediaHandler } from '../handler'
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
