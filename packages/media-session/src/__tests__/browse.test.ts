import { describe, expect, it, vi } from 'vitest'

import {
  BROWSE_ROOT,
  BrowseError,
  capRootTabs,
  errorToNativeBrowseResult,
  isBrowseError,
  MAX_ROOT_TABS,
  toCarConnection,
  toNativeBrowseItem,
  toSearchFocus,
} from '../browse'
import { BaseMediaHandler, CompositeMediaHandler } from '../handler'
import { createMediaService } from '../media-service'
import type { MediaServiceApi } from '../types'
import {
  browseItem,
  FakeNativeMediaSession,
  RecordingHandler,
  SearchingHandler,
} from './fakes'

async function ready(handler: RecordingHandler = new RecordingHandler()) {
  const native = new FakeNativeMediaSession()
  const service: MediaServiceApi = await createMediaService(native).init(
    () => handler
  )
  return { native, handler, service }
}

describe('capRootTabs', () => {
  const tab = (id: string) => browseItem(id, { browsable: true })

  it('keeps up to four browsable tabs, untouched', () => {
    const items = [tab('a'), tab('b'), tab('c'), tab('d')]
    expect(capRootTabs(items)).toEqual({ tabs: items, rejected: [] })
  })

  it('drops the fifth tab and says which one, in order', () => {
    const { tabs, rejected } = capRootTabs([
      tab('a'),
      tab('b'),
      tab('c'),
      tab('d'),
      tab('e'),
    ])

    expect(tabs.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toContain('(e)')
    expect(rejected[0]).toContain(`${MAX_ROOT_TABS}-tab root limit`)
  })

  it('drops a playable-only root entry — Auto supports FLAG_BROWSABLE alone', () => {
    const { tabs, rejected } = capRootTabs([
      browseItem('track', { playable: true }),
      tab('albums'),
    ])

    expect(tabs.map((item) => item.id)).toEqual(['albums'])
    expect(rejected[0]).toContain('not browsable')
  })

  it('does not spend the budget on the entries it drops', () => {
    // The playable entry is rejected for *being playable*, not for being over
    // the limit, so four browsable tabs still survive behind it.
    const { tabs } = capRootTabs([
      browseItem('track', { playable: true }),
      tab('a'),
      tab('b'),
      tab('c'),
      tab('d'),
    ])

    expect(tabs.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('honours a smaller limit than four (a browser can ask for one)', () => {
    const { tabs, rejected } = capRootTabs([tab('a'), tab('b')], 1)

    expect(tabs.map((item) => item.id)).toEqual(['a'])
    expect(rejected[0]).toContain('1-tab root limit')
  })
})

describe('toNativeBrowseItem', () => {
  it('resolves the three documented defaults', () => {
    expect(toNativeBrowseItem({ id: 'a', title: 'A' })).toEqual({
      id: 'a',
      title: 'A',
      subtitle: undefined,
      artworkUri: undefined,
      browsable: false,
      playable: false,
      childStyle: undefined,
      group: undefined,
      isExplicit: false,
      completion: undefined,
      mediaType: 'mixed',
    })
  })

  it('carries everything an app set', () => {
    expect(
      toNativeBrowseItem({
        id: 'album:1',
        title: 'Album',
        subtitle: 'Artist',
        artworkUri: 'https://example.test/a.jpg',
        browsable: true,
        playable: true,
        childStyle: 'grid',
        group: 'Recent',
        explicit: true,
        completion: 0.5,
        mediaType: 'folderAlbums',
      })
    ).toEqual({
      id: 'album:1',
      title: 'Album',
      subtitle: 'Artist',
      artworkUri: 'https://example.test/a.jpg',
      browsable: true,
      playable: true,
      childStyle: 'grid',
      group: 'Recent',
      isExplicit: true,
      completion: 0.5,
      mediaType: 'folderAlbums',
    })
  })

  it('rejects an empty id — media3 throws on one, on its own thread', () => {
    expect(() => toNativeBrowseItem({ id: '', title: 'A' })).toThrowError(/id/)
  })

  it('rejects an empty title and an out-of-range completion', () => {
    expect(() => toNativeBrowseItem({ id: 'a', title: '' })).toThrowError(
      /title/
    )
    expect(() =>
      toNativeBrowseItem({ id: 'a', title: 'A', completion: 1.5 })
    ).toThrowError(/completion/)
  })

  it('rejects a style or media type that is not in the union', () => {
    expect(() =>
      toNativeBrowseItem({
        id: 'a',
        title: 'A',
        childStyle: 'carousel' as never,
      })
    ).toThrowError(/childStyle/)
    expect(() =>
      toNativeBrowseItem({ id: 'a', title: 'A', mediaType: 'video' as never })
    ).toThrowError(/mediaType/)
  })
})

describe('BrowseError', () => {
  it('is recognised structurally, not by instanceof', () => {
    const error = new BrowseError('premiumAccountRequired', 'Upgrade first.')

    expect(isBrowseError(error)).toBe(true)
    expect(isBrowseError(new Error('nope'))).toBe(false)
    // The shape a second copy of this package in a monorepo would produce.
    const foreign = Object.assign(new Error('x'), {
      name: 'BrowseError',
      code: 'notSupported',
    })
    expect(isBrowseError(foreign)).toBe(true)
  })

  it('becomes the error half of a result, with the resolution button', () => {
    const error = new BrowseError(
      'authenticationExpired',
      'Sign in to continue.',
      { label: 'Sign in', url: 'rnmedia://signin' }
    )

    expect(errorToNativeBrowseResult(error)).toEqual({
      items: [],
      error: {
        code: 'authenticationExpired',
        message: 'Sign in to continue.',
        resolutionLabel: 'Sign in',
        resolutionUrl: 'rnmedia://signin',
      },
    })
  })

  it('leaves any other throw alone — that is a bug, not a screen', () => {
    expect(errorToNativeBrowseResult(new TypeError('oops'))).toBeUndefined()
  })
})

describe('inbound widening', () => {
  it('keeps a focus kind it knows and falls back to any for one it does not', () => {
    expect(toSearchFocus({ kind: 'artist', artist: 'Nina' })).toEqual({
      kind: 'artist',
      artist: 'Nina',
      album: undefined,
      title: undefined,
      genre: undefined,
      playlist: undefined,
    })
    expect(toSearchFocus({ kind: 'audiobook' }).kind).toBe('any')
  })

  it('widens a car kind, and refuses to invent one', () => {
    expect(toCarConnection('androidAuto')).toEqual({ kind: 'androidAuto' })
    expect(toCarConnection('automotiveOs')).toEqual({ kind: 'automotiveOs' })
    expect(toCarConnection('carPlay')).toEqual({ kind: 'carPlay' })
    expect(toCarConnection('teleporter')).toEqual({ kind: 'none' })
  })
})

describe('browse fan-in', () => {
  it('pulls children through the handler and flattens them for the bridge', async () => {
    const { native, handler } = await ready()
    handler.children.set('albums', [
      browseItem('album:1', { browsable: true, playable: true }),
    ])

    const result = await native.emit().getChildren('albums')

    expect(handler.calls).toContain('getChildren(albums)')
    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'album:1',
        browsable: true,
        playable: true,
        mediaType: 'mixed',
      }),
    ])
  })

  it('caps the root and reports what it dropped on the session-error channel', async () => {
    const { native, handler } = await ready()
    handler.children.set(BROWSE_ROOT, [
      browseItem('a', { browsable: true }),
      browseItem('b', { browsable: true }),
      browseItem('c', { browsable: true }),
      browseItem('d', { browsable: true }),
      browseItem('e', { browsable: true }),
      browseItem('f', { playable: true }),
    ])

    const result = await native.emit().getChildren(BROWSE_ROOT)

    expect(result.items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd'])
    const reported = handler.sessionErrors[0]
    expect(reported?.code).toBe('browseRootRejected')
    expect(reported?.severity).toBe('degraded')
    expect(reported?.message).toContain('(e)')
    expect(reported?.message).toContain('(f)')
  })

  it('turns a thrown BrowseError into the error half, not a rejection', async () => {
    const { native, handler } = await ready()
    handler.browseRejectWith = new BrowseError(
      'authenticationExpired',
      'Sign in.',
      { label: 'Sign in', url: 'rnmedia://signin' }
    )

    const result = await native.emit().getChildren('albums')

    expect(result.items).toEqual([])
    expect(result.error?.code).toBe('authenticationExpired')
    expect(result.error?.resolutionUrl).toBe('rnmedia://signin')
  })

  it('turns any other throw into an empty list plus an onHandlerError report', async () => {
    const native = new FakeNativeMediaSession()
    const handler = new RecordingHandler()
    const failures: [string, unknown][] = []
    await createMediaService(native).init(() => handler, {
      onHandlerError: (method, error) => failures.push([method, error]),
    })
    const boom = new TypeError('boom')
    handler.browseRejectWith = boom

    const result = await native.emit().getChildren('albums')

    expect(result).toEqual({ items: [] })
    expect(failures).toEqual([['getChildren', boom]])
  })

  it('answers getMediaItem with zero or one item', async () => {
    const { native, handler } = await ready()
    handler.children.set('albums', [browseItem('album:1')])

    await expect(native.emit().getMediaItem('album:1')).resolves.toEqual({
      items: [expect.objectContaining({ id: 'album:1' })],
    })
    await expect(native.emit().getMediaItem('nope')).resolves.toEqual({
      items: [],
    })
  })

  it('dispatches a car tap and a voice query to the handler, fire-and-forget', async () => {
    const handler = new SearchingHandler()
    const { native } = await ready(handler)

    native.emit().playFromMediaId('album:1')
    native.emit().playFromSearch('jazz', { kind: 'genre', genre: 'jazz' })

    expect(handler.calls).toEqual([
      'playFromMediaId(album:1)',
      'playFromSearch(jazz,genre)',
    ])
  })

  it('declares what the handler can answer, before the session exists', async () => {
    const bare = await ready()
    expect(bare.native.browseCapabilities).toEqual([
      { search: false, playFromSearch: false },
    ])

    const searching = await ready(new SearchingHandler())
    expect(searching.native.browseCapabilities).toEqual([
      { search: true, playFromSearch: true },
    ])
  })

  it('declares capabilities before initialize, not after', async () => {
    const native = new FakeNativeMediaSession()
    const order: string[] = []
    const spy = vi
      .spyOn(native, 'setBrowseCapabilities')
      .mockImplementation(() => order.push('capabilities'))
    const initialize = native.initialize.bind(native)
    vi.spyOn(native, 'initialize').mockImplementation((config, handlers) => {
      order.push('initialize')
      return initialize(config, handlers)
    })

    await createMediaService(native).init(() => new RecordingHandler())

    expect(order).toEqual(['capabilities', 'initialize'])
    spy.mockRestore()
  })

  it('keeps a decorator honest: it advertises what the inner handler has', async () => {
    class Decorated extends CompositeMediaHandler {}

    const plain = new Decorated(new BaseMediaHandler())
    expect(plain.search).toBeUndefined()
    expect(plain.playFromSearch).toBeUndefined()

    const searching = new Decorated(new SearchingHandler())
    expect(searching.search).toBeInstanceOf(Function)
    expect(searching.playFromSearch).toBeInstanceOf(Function)
    await searching.search?.('jazz')
    expect((searching as unknown as { inner: SearchingHandler }).inner.calls
    ).toContain('search(jazz)')
  })
})

describe('BaseMediaHandler.playFromMediaId', () => {
  it('reports the silent no-op instead of being one', () => {
    const reported: unknown[] = []
    class Listening extends BaseMediaHandler {
      override onSessionError(error: { code: string; message: string }) {
        reported.push(error)
      }
    }

    new Listening().playFromMediaId('album:1')

    expect(reported).toEqual([
      expect.objectContaining({
        code: 'playFromMediaIdUnhandled',
        severity: 'fatal',
        message: expect.stringContaining('album:1'),
      }),
    ])
  })
})

describe('car connection', () => {
  it('starts at none, follows native, and keeps one object per value', async () => {
    const { native, service } = await ready()

    expect(service.getCarConnection()).toEqual({ kind: 'none' })
    const before = service.getCarConnection()
    // Two reads with no transition must be the same object: `useCarConnection`
    // is a useSyncExternalStore, whose snapshot has to be referentially stable.
    expect(service.getCarConnection()).toBe(before)

    native.emitCarConnection('androidAuto')
    expect(service.getCarConnection()).toEqual({ kind: 'androidAuto' })
  })

  it('notifies subscribers on a transition, and only on a transition', async () => {
    const native = new FakeNativeMediaSession()
    const controller = createMediaService(native)
    let notifications = 0
    const unsubscribe = controller.subscribeCarConnection(() => {
      notifications += 1
    })
    await controller.init(() => new RecordingHandler())

    native.emitCarConnection('androidAuto')
    native.emitCarConnection('androidAuto')
    expect(notifications).toBe(1)

    native.emitCarConnection('none')
    expect(notifications).toBe(2)

    unsubscribe()
    native.emitCarConnection('carPlay')
    expect(notifications).toBe(2)
  })

  it('reads the already-connected car at init', async () => {
    const native = new FakeNativeMediaSession()
    native.carConnection = 'automotiveOs'

    const service = await createMediaService(native).init(
      () => new RecordingHandler()
    )

    expect(service.getCarConnection()).toEqual({ kind: 'automotiveOs' })
  })

  it('goes back to none when the session is stopped', async () => {
    const { native, service } = await ready()
    native.emitCarConnection('androidAuto')

    await service.stopService()

    expect(service.getCarConnection()).toEqual({ kind: 'none' })
  })
})

describe('invalidateBrowse', () => {
  it('passes the parent through, and means everything when omitted', async () => {
    const { native, service } = await ready()

    service.invalidateBrowse('albums')
    service.invalidateBrowse()

    expect(native.invalidations).toEqual(['albums', undefined])
  })

  it('is rejected before init, like every other command', () => {
    const service = createMediaService(new FakeNativeMediaSession())
    expect(() => service.invalidateBrowse()).toThrowError(/init\(\)/)
  })
})
