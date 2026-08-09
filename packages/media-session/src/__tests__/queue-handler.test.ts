import { beforeEach, describe, expect, it } from 'vitest'

import { BaseMediaHandler } from '../handler'
import { withQueueHandling } from '../queue-handler'
import type { QueueBroadcaster } from '../queue-handler'
import type { MediaItem } from '../types'
import { item } from './fakes'

class FakeBroadcaster implements QueueBroadcaster {
  readonly queues: MediaItem[][] = []
  setQueue(items: MediaItem[]): void {
    this.queues.push(items)
  }
}

let broadcaster: FakeBroadcaster

function makeHandler(wrapAround = false) {
  const Base = withQueueHandling(BaseMediaHandler, { wrapAround, broadcaster })

  class TestHandler extends Base {
    readonly played: string[] = []
    playQueueItem(mediaItem: MediaItem, index: number): void {
      this.played.push(`${index}:${mediaItem.id}`)
    }
  }

  return new TestHandler()
}

beforeEach(() => {
  broadcaster = new FakeBroadcaster()
})

describe('setQueue', () => {
  it('broadcasts on channel 3 and validates the items', () => {
    const handler = makeHandler()
    handler.setQueue([item('a'), item('b')])

    expect(broadcaster.queues).toHaveLength(1)
    expect(handler.queue.map((i) => i.id)).toEqual(['a', 'b'])
    expect(handler.queueIndex).toBe(-1)
    expect(handler.currentItem).toBeUndefined()

    expect(() => handler.setQueue([{ id: '', title: 'x' }])).toThrowError(
      /queue\[0\]\.id/
    )
  })

  it('honours startIndex and clamps a nonsensical one to "nothing selected"', () => {
    const handler = makeHandler()
    handler.setQueue([item('a'), item('b'), item('c')], 1)
    expect(handler.queueIndex).toBe(1)
    expect(handler.currentItem?.id).toBe('b')

    handler.setQueue([item('a')], 9)
    expect(handler.queueIndex).toBe(-1)

    handler.setQueue([], 0)
    expect(handler.queueIndex).toBe(-1)
  })
})

describe('skip with an empty queue', () => {
  it('does nothing at all', () => {
    const handler = makeHandler()
    handler.setQueue([])
    handler.skipToNext()
    handler.skipToPrevious()
    handler.skipToQueueItem(0)
    expect(handler.played).toEqual([])
    expect(handler.queueIndex).toBe(-1)
  })
})

describe('skip with a single-item queue', () => {
  it('reaches the item from "nothing selected" in either direction', () => {
    const forward = makeHandler()
    forward.setQueue([item('a')])
    forward.skipToNext()
    expect(forward.played).toEqual(['0:a'])

    const backward = makeHandler()
    backward.setQueue([item('a')])
    backward.skipToPrevious()
    expect(backward.played).toEqual(['0:a'])
  })

  it('stops at both ends without wraparound', () => {
    const handler = makeHandler()
    handler.setQueue([item('a')], 0)
    handler.skipToNext()
    handler.skipToPrevious()
    expect(handler.played).toEqual([])
    expect(handler.queueIndex).toBe(0)
  })

  it('replays the only item with wraparound', () => {
    const handler = makeHandler(true)
    handler.setQueue([item('a')], 0)
    handler.skipToNext()
    handler.skipToPrevious()
    expect(handler.played).toEqual(['0:a', '0:a'])
  })
})

describe('skip with a multi-item queue', () => {
  it('walks forward and stops at the end', () => {
    const handler = makeHandler()
    handler.setQueue([item('a'), item('b'), item('c')], 0)
    handler.skipToNext()
    handler.skipToNext()
    handler.skipToNext()
    expect(handler.played).toEqual(['1:b', '2:c'])
    expect(handler.queueIndex).toBe(2)
  })

  it('walks backward and stops at the start', () => {
    const handler = makeHandler()
    handler.setQueue([item('a'), item('b'), item('c')], 2)
    handler.skipToPrevious()
    handler.skipToPrevious()
    handler.skipToPrevious()
    expect(handler.played).toEqual(['1:b', '0:a'])
    expect(handler.queueIndex).toBe(0)
  })

  it('wraps in both directions when asked to', () => {
    const handler = makeHandler(true)
    handler.setQueue([item('a'), item('b'), item('c')], 2)
    handler.skipToNext()
    expect(handler.queueIndex).toBe(0)
    handler.skipToPrevious()
    expect(handler.queueIndex).toBe(2)
    expect(handler.played).toEqual(['0:a', '2:c'])
  })

  it('starts at the first item going forward from "nothing selected"', () => {
    const handler = makeHandler()
    handler.setQueue([item('a'), item('b')])
    handler.skipToNext()
    expect(handler.played).toEqual(['0:a'])
  })

  it('starts at the last item going backward from "nothing selected"', () => {
    const handler = makeHandler()
    handler.setQueue([item('a'), item('b')])
    handler.skipToPrevious()
    expect(handler.played).toEqual(['1:b'])
  })

  it('wrapAround is togglable after construction', () => {
    const handler = makeHandler()
    handler.setQueue([item('a'), item('b')], 1)
    handler.skipToNext()
    expect(handler.played).toEqual([])
    handler.wrapAround = true
    handler.skipToNext()
    expect(handler.played).toEqual(['0:a'])
  })
})

describe('skipToQueueItem', () => {
  it('jumps to any valid index', () => {
    const handler = makeHandler()
    handler.setQueue([item('a'), item('b'), item('c')])
    handler.skipToQueueItem(2)
    expect(handler.played).toEqual(['2:c'])
    expect(handler.currentItem?.id).toBe('c')
  })

  it('ignores a stale index from a remote surface without moving', () => {
    const handler = makeHandler()
    handler.setQueue([item('a'), item('b')], 1)
    handler.skipToQueueItem(5)
    handler.skipToQueueItem(-1)
    expect(handler.played).toEqual([])
    expect(handler.queueIndex).toBe(1)
  })
})

describe('mixin composition', () => {
  it('leaves the other handler methods untouched', () => {
    const seen: string[] = []
    class Custom extends BaseMediaHandler {
      override play(): void {
        seen.push('play')
      }
    }
    const Base = withQueueHandling(Custom, { broadcaster })
    class WithQueue extends Base {
      playQueueItem(): void {}
    }
    const handler = new WithQueue()
    handler.play()
    expect(seen).toEqual(['play'])
  })

  it('lets a subclass wrap a skip and still reach the default logic', () => {
    const Base = withQueueHandling(BaseMediaHandler, { broadcaster })

    // The documented escape hatch: "restart the track if we are more than 3s
    // in" is player state, which the mixin has none of.
    class RestartAware extends Base {
      readonly played: string[] = []
      positionMs = 0

      playQueueItem(mediaItem: MediaItem, index: number): void {
        this.played.push(`${index}:${mediaItem.id}`)
      }

      override skipToPrevious(): void | Promise<void> {
        if (this.positionMs > 3000) {
          this.played.push('restart')
          return
        }
        return super.skipToPrevious()
      }
    }

    const handler = new RestartAware()
    handler.setQueue([item('a'), item('b')], 1)

    handler.positionMs = 9000
    handler.skipToPrevious()
    expect(handler.played).toEqual(['restart'])

    handler.positionMs = 500
    handler.skipToPrevious()
    expect(handler.played).toEqual(['restart', '0:a'])
  })
})
