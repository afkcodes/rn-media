import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlayerError } from '../errors'
import { PlayerErrorException } from '../errors'
import { Player } from '../player'
import { MpvProperty, playlistFilenameProperty } from '../properties'
import {
  DEFAULT_RESOLVER_TIMEOUT_MS,
  DEFAULT_RESOLVER_TTL_MS,
} from '../source-resolver'
import type { SourceResolver } from '../source-resolver'
import { FakeMpvClient, propertyEvent } from './fake-mpv-client'

/** A controllable clock, so TTL assertions never depend on wall time. */
class Clock {
  now = 1_000_000
  readonly read = (): number => this.now
  advance(ms: number): void {
    this.now += ms
  }
}

let client: FakeMpvClient
let clock: Clock

async function createPlayer(
  overrides: Parameters<typeof Player.create>[0] = {}
): Promise<Player> {
  return Player.create({
    createClient: () => client,
    now: clock.read,
    ...overrides,
  })
}

/** Populate mpv's playlist as the fake would report it back. */
function seedPlaylist(sources: readonly string[]): void {
  sources.forEach((source, index) => {
    client.readable.set(playlistFilenameProperty(index), source)
  })
}

/** Move the queue cursor the way a real batch would. */
function moveCursor(index: number, count: number): void {
  client.emit([
    propertyEvent(MpvProperty.playlistCount, count),
    propertyEvent(MpvProperty.playlistPos, index),
  ])
}

/**
 * Let every queued microtask (i.e. every resolver promise) settle.
 *
 * Deliberately generous: resolve-ahead is itself dispatched from a
 * `queueMicrotask` (so its playlist reads never land in the same JS turn as the
 * event batch's reducer), and each resolver adds a couple of promise hops on
 * top of that. Draining a fixed handful of turns keeps the tests honest about
 * ordering without making them count hops.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  client = new FakeMpvClient()
  clock = new Clock()
})

describe('setSourceResolver lifecycle', () => {
  it('registers no mpv hook until a resolver is installed', async () => {
    // The zero-cost claim, as a test: a player nobody gave a resolver to must
    // leave mpv's load path exactly as stock.
    const player = await createPlayer()
    expect(client.resolverCalls).toEqual([])
    expect(client.resolverInstalled).toBe(false)
    // The listener is registered unconditionally — it is what costs nothing.
    expect(client.hasResolutionListener).toBe(true)
    player.destroy()
  })

  it('installs the hooks with the configured timeout on the first resolver', async () => {
    const player = await createPlayer()
    player.setSourceResolver((request) => request.uri)
    expect(client.resolverCalls).toEqual([
      { kind: 'install', timeoutMs: DEFAULT_RESOLVER_TIMEOUT_MS },
    ])
    player.destroy()
  })

  it('honours `resolverTimeoutMs`', async () => {
    const player = await createPlayer({ resolverTimeoutMs: 2_500 })
    player.setSourceResolver((request) => request.uri)
    expect(client.resolverCalls).toEqual([
      { kind: 'install', timeoutMs: 2_500 },
    ])
    player.destroy()
  })

  it('installs a resolver passed to `create` before anything can be loaded', async () => {
    const player = await createPlayer({
      sourceResolver: (request) => `${request.uri}?signed`,
    })
    expect(client.resolverInstalled).toBe(true)
    player.destroy()
  })

  it('drops the native cache when the resolver is replaced', async () => {
    // A different resolver may legitimately answer differently; keeping the old
    // answers would make the replacement silently not take effect.
    const player = await createPlayer()
    player.setSourceResolver((request) => request.uri)
    player.setSourceResolver((request) => `${request.uri}#two`)
    expect(client.resolverCalls).toEqual([
      { kind: 'install', timeoutMs: DEFAULT_RESOLVER_TIMEOUT_MS },
      { kind: 'clear' },
      { kind: 'install', timeoutMs: DEFAULT_RESOLVER_TIMEOUT_MS },
    ])
    player.destroy()
  })

  it('uninstalls on `null`, and does nothing when there was no resolver', async () => {
    const player = await createPlayer()
    player.setSourceResolver(null)
    expect(client.resolverCalls).toEqual([])

    player.setSourceResolver((request) => request.uri)
    player.setSourceResolver(null)
    expect(client.resolverCalls.at(-1)).toEqual({ kind: 'uninstall' })
    player.destroy()
  })

  it('rolls back when mpv rejects the hook registration', async () => {
    const player = await createPlayer()
    client.installResolverRejection = '[mpv:-11] mpv_hook_add("on_load")'

    expect(() => {
      player.setSourceResolver((request) => request.uri)
    }).toThrow(PlayerErrorException)

    // Not half-armed: with the install rejected, nothing may claim a resolver
    // is in force, so a later request is answered with "no answer" at once.
    client.emitResolutionRequest({ uri: 'library://a' })
    expect(client.resolverCalls.at(-1)).toEqual({
      kind: 'complete',
      logical: 'library://a',
      resolved: undefined,
      ttlMs: DEFAULT_RESOLVER_TTL_MS,
    })
    player.destroy()
  })

  it('throws `disposed` after the player is destroyed', async () => {
    const player = await createPlayer()
    player.destroy()
    expect(() => {
      player.setSourceResolver((request) => request.uri)
    }).toThrow(PlayerErrorException)
  })
})

describe('option validation', () => {
  it.each([
    ['resolverTimeoutMs', -1],
    ['resolverTimeoutMs', Number.NaN],
    ['resolverTimeoutMs', Number.POSITIVE_INFINITY],
    ['resolverTtlMs', -1],
    ['resolverTtlMs', Number.NaN],
    ['resolverTtlMs', Number.POSITIVE_INFINITY],
  ])('rejects %s = %s before a core is created', async (option, value) => {
    await expect(createPlayer({ [option]: value })).rejects.toThrow(
      PlayerErrorException
    )
    // Rejected before `mpv_create()`: no core was built, nothing to tear down.
    expect(client.initialized).toBe(false)
  })

  it('accepts zero for both', async () => {
    const player = await createPlayer({
      resolverTimeoutMs: 0,
      resolverTtlMs: 0,
    })
    player.setSourceResolver((request) => request.uri)
    expect(client.resolverCalls).toEqual([{ kind: 'install', timeoutMs: 0 }])
    player.destroy()
  })
})

describe('resolve-ahead', () => {
  it('resolves a single `load` before the loadfile command reaches mpv', async () => {
    const player = await createPlayer()
    player.setSourceResolver((request) => `${request.uri}?sig=a`)

    await player.load('library://one')
    await settle()

    expect(client.resolvedSources.get('library://one')).toBe(
      'library://one?sig=a'
    )
    player.destroy()
  })

  it('resolves the starting entry and the one after it on `loadPlaylist`', async () => {
    const player = await createPlayer()
    const resolver = vi.fn((request: { uri: string }) => `${request.uri}?sig`)
    player.setSourceResolver(resolver)

    await player.loadPlaylist(['library://a', 'library://b', 'library://c'])
    await settle()

    // Two, not three: mpv prefetches one ahead, so resolving further would mint
    // credentials for tracks that may never play.
    expect(resolver).toHaveBeenCalledTimes(2)
    expect([...client.resolvedSources.keys()]).toEqual([
      'library://a',
      'library://b',
    ])
    player.destroy()
  })

  it('resolves current + next again when the queue cursor moves', async () => {
    const player = await createPlayer()
    const resolver = vi.fn((request: { uri: string }) => `${request.uri}?sig`)
    player.setSourceResolver(resolver)
    seedPlaylist(['library://a', 'library://b', 'library://c'])

    moveCursor(1, 3)
    await settle()

    expect(client.resolvedSources.get('library://b')).toBe('library://b?sig')
    expect(client.resolvedSources.get('library://c')).toBe('library://c?sig')
    player.destroy()
  })

  it('wraps to entry 0 on the last entry when the playlist repeats', async () => {
    const player = await createPlayer()
    player.setSourceResolver((request) => `${request.uri}?sig`)
    seedPlaylist(['library://a', 'library://b'])
    client.emit([propertyEvent(MpvProperty.loopPlaylist, 'inf')])

    moveCursor(1, 2)
    await settle()

    // mpv's own `mp_next_file` consults `--loop-playlist`, so entry 0 really is
    // what comes next here.
    expect(client.resolvedSources.get('library://a')).toBe('library://a?sig')
    player.destroy()
  })

  it('reads no playlist entry during the event-batch turn', async () => {
    // Regression: resolve-ahead used to run inline from `#handleBatch`, adding
    // two blocking `playlist/N/filename` reads to the same JS turn as the
    // reducer and the state fan-out — at a track boundary, which is the moment
    // mpv's core is least able to answer one. It is a microtask now.
    const player = await createPlayer()
    player.setSourceResolver((request) => `${request.uri}?sig`)
    seedPlaylist(['library://a', 'library://b'])
    const reads = vi.spyOn(client, 'getPropertyString')

    moveCursor(0, 2)
    // Synchronously after the batch: exactly one filename read, and it is not
    // resolve-ahead's. The player reads the *current* entry's URI inline on a
    // cursor change (error classification is keyed on it, and the boundary is
    // already paid for); resolve-ahead's pair of reads is what must not be
    // here, and would show up as entry 1's filename alongside it.
    expect(
      reads.mock.calls.filter(([name]) => name.startsWith('playlist/'))
    ).toEqual([['playlist/0/filename']])

    await settle()
    // Two more: resolve-ahead asking for the current and the next entry.
    expect(
      reads.mock.calls.filter(([name]) => name.startsWith('playlist/')).length
    ).toBe(3)
    expect(client.resolvedSources.get('library://a')).toBe('library://a?sig')
    player.destroy()
  })

  it('does not wrap when the playlist does not repeat', async () => {
    const player = await createPlayer()
    const resolver = vi.fn((request: { uri: string }) => `${request.uri}?sig`)
    player.setSourceResolver(resolver)
    seedPlaylist(['library://a', 'library://b'])

    moveCursor(1, 2)
    await settle()

    expect(resolver).toHaveBeenCalledTimes(1)
    expect(resolver.mock.calls[0]?.[0].uri).toBe('library://b')
    player.destroy()
  })

  it('reads the URIs from mpv rather than from what was last loaded', async () => {
    // The queue can move for reasons this object never saw. Reading
    // `playlist/N/filename` is what makes the resolver follow mpv, not a guess.
    const player = await createPlayer()
    player.setSourceResolver((request) => `${request.uri}?sig`)
    seedPlaylist(['library://only-mpv-knows'])

    moveCursor(0, 1)
    await settle()

    expect(client.resolvedSources.get('library://only-mpv-knows')).toBe(
      'library://only-mpv-knows?sig'
    )
    player.destroy()
  })

  it('does nothing at all when no resolver is installed', async () => {
    const player = await createPlayer()
    seedPlaylist(['library://a', 'library://b'])

    moveCursor(0, 2)
    await settle()

    expect(client.resolverCalls).toEqual([])
    player.destroy()
  })

  it('pushes the configured TTL through to native', async () => {
    const player = await createPlayer({ resolverTtlMs: 42_000 })
    player.setSourceResolver((request) => `${request.uri}?sig`)

    await player.load('library://one')
    await settle()

    expect(client.resolverCalls).toContainEqual({
      kind: 'set',
      logical: 'library://one',
      resolved: 'library://one?sig',
      ttlMs: 42_000,
    })
    player.destroy()
  })

  it('re-resolves once its TTL has passed, and not before', async () => {
    const player = await createPlayer({ resolverTtlMs: 10_000 })
    const resolver = vi.fn((request: { uri: string }) => `${request.uri}?sig`)
    player.setSourceResolver(resolver)
    seedPlaylist(['library://a'])

    moveCursor(0, 1)
    await settle()
    expect(resolver).toHaveBeenCalledTimes(1)

    // Same entry, still fresh: the answer is replayed, not recomputed. This is
    // the determinism guarantee — two calls could return two different signed
    // URLs, and mpv compares them byte-for-byte.
    clock.advance(9_999)
    client.emit([propertyEvent(MpvProperty.playlistCount, 2)])
    await settle()
    expect(resolver).toHaveBeenCalledTimes(1)

    clock.advance(2)
    client.emit([propertyEvent(MpvProperty.playlistCount, 3)])
    await settle()
    expect(resolver).toHaveBeenCalledTimes(2)
    player.destroy()
  })
})

describe('in-flight de-duplication', () => {
  it('runs the resolver once when a request races a resolve-ahead', async () => {
    // Two concurrent calls to a nonce-minting resolver would produce two
    // different answers for one entry — the exact non-determinism that makes
    // mpv throw the prefetched stream away.
    let calls = 0
    let release: ((value: string) => void) | undefined
    const player = await createPlayer()
    player.setSourceResolver(() => {
      calls += 1
      return new Promise<string>((resolve) => {
        release = resolve
      })
    })

    void player.load('library://one')
    // The request lands while the resolve-ahead is still in flight — the entry
    // is registered synchronously, so this joins it rather than racing it.
    client.emitResolutionRequest({ uri: 'library://one' })
    await Promise.resolve()
    expect(calls).toBe(1)

    release?.('https://cdn/one?sig=a')
    await settle()

    // One answer, delivered to both callers.
    expect(client.resolvedSources.get('library://one')).toBe(
      'https://cdn/one?sig=a'
    )
    expect(client.resolverCalls).toContainEqual({
      kind: 'complete',
      logical: 'library://one',
      resolved: 'https://cdn/one?sig=a',
      ttlMs: DEFAULT_RESOLVER_TTL_MS,
    })
    player.destroy()
  })

  it('resolves different URIs independently', async () => {
    const seen: string[] = []
    const player = await createPlayer()
    player.setSourceResolver((request) => {
      seen.push(request.uri)
      return `${request.uri}?sig`
    })
    seedPlaylist(['library://a', 'library://b'])

    moveCursor(0, 2)
    await settle()

    expect(seen).toEqual(['library://a', 'library://b'])
    player.destroy()
  })
})

describe('resolution requests', () => {
  it('runs the resolver and completes with the resolved URL', async () => {
    const player = await createPlayer()
    player.setSourceResolver(
      async (request) => `https://cdn/${request.uri.slice('library://'.length)}`
    )

    client.emitResolutionRequest({ uri: 'library://a' })
    await settle()

    expect(client.resolverCalls.at(-1)).toEqual({
      kind: 'complete',
      logical: 'library://a',
      resolved: 'https://cdn/a',
      ttlMs: DEFAULT_RESOLVER_TTL_MS,
    })
    player.destroy()
  })

  it('passes the prefetch entry id straight through to the resolver', async () => {
    const player = await createPlayer()
    const resolver = vi.fn(
      (request: { uri: string; entryId?: number }) => `${request.uri}?sig`
    )
    player.setSourceResolver(resolver)

    client.emitResolutionRequest({ uri: 'library://a', entryId: 7 })
    await settle()

    expect(resolver).toHaveBeenCalledWith({ uri: 'library://a', entryId: 7 })
    player.destroy()
  })

  it('answers from the cache without calling the resolver again', async () => {
    // This is the case that must be fast: the play-time hook is holding mpv's
    // core open, so a cache hit is what keeps the hold at zero.
    const player = await createPlayer()
    const resolver = vi.fn((request: { uri: string }) => `${request.uri}?sig`)
    player.setSourceResolver(resolver)

    await player.load('library://one')
    await settle()
    expect(resolver).toHaveBeenCalledTimes(1)

    client.emitResolutionRequest({ uri: 'library://one' })
    await settle()

    expect(resolver).toHaveBeenCalledTimes(1)
    expect(client.resolverCalls.at(-1)).toEqual({
      kind: 'complete',
      logical: 'library://one',
      resolved: 'library://one?sig',
      ttlMs: DEFAULT_RESOLVER_TTL_MS,
    })
    player.destroy()
  })

  it('completes with null immediately when the resolver was removed', async () => {
    // A hook can already be parked when the app clears the resolver. Answering
    // "no answer" at once is what stops mpv waiting out the whole timeout.
    const player = await createPlayer()
    player.setSourceResolver((request) => `${request.uri}?sig`)
    player.setSourceResolver(null)

    client.emitResolutionRequest({ uri: 'library://a' })

    expect(client.resolverCalls.at(-1)).toEqual({
      kind: 'complete',
      logical: 'library://a',
      resolved: undefined,
      ttlMs: DEFAULT_RESOLVER_TTL_MS,
    })
    player.destroy()
  })

  it('completes with null when the player was destroyed', async () => {
    const player = await createPlayer()
    player.setSourceResolver((request) => `${request.uri}?sig`)
    player.destroy()

    client.emitResolutionRequest({ uri: 'library://a' })

    expect(client.resolverCalls.at(-1)).toEqual({
      kind: 'complete',
      logical: 'library://a',
      resolved: undefined,
      ttlMs: DEFAULT_RESOLVER_TTL_MS,
    })
  })

  it('never leaves a request unanswered when the resolver throws', async () => {
    const player = await createPlayer()
    player.setSourceResolver(() => {
      throw new Error('token service is down')
    })

    client.emitResolutionRequest({ uri: 'library://a' })
    await settle()

    expect(client.resolverCalls.at(-1)).toEqual({
      kind: 'complete',
      logical: 'library://a',
      resolved: undefined,
      ttlMs: DEFAULT_RESOLVER_TTL_MS,
    })
    player.destroy()
  })
})

describe('resolver failures', () => {
  it('emits a typed error and caches nothing when the resolver throws', async () => {
    const errors: PlayerError[] = []
    const player = await createPlayer()
    player.on('error', (error) => errors.push(error))
    player.setSourceResolver(() => {
      throw new Error('token service is down')
    })

    await player.load('library://one')
    await settle()

    expect(errors).toHaveLength(1)
    expect(errors[0]).toEqual({
      code: 'load-failed',
      message: 'Could not resolve `library://one`: token service is down',
      raw: 'token service is down',
      uri: 'library://one',
      // `library://` is not a network scheme, so re-signing it is not obviously
      // worth another go. See `Retryable`.
      retryable: false,
    })
    // Nothing cached: mpv is left to open the logical URI and fail on its own
    // terms rather than being handed a URL we do not trust.
    expect(client.resolvedSources.size).toBe(0)
    player.destroy()
  })

  it('reports a rejected promise the same way', async () => {
    const errors: PlayerError[] = []
    const player = await createPlayer()
    player.on('error', (error) => errors.push(error))
    player.setSourceResolver(async () => {
      throw new Error('403')
    })

    await player.load('library://one')
    await settle()

    expect(errors.map((error) => error.code)).toEqual(['load-failed'])
    expect(client.resolvedSources.size).toBe(0)
    player.destroy()
  })

  it('rejects a non-string answer rather than handing it to mpv', async () => {
    const errors: PlayerError[] = []
    const player = await createPlayer()
    player.on('error', (error) => errors.push(error))
    // A JavaScript caller can get here past the type system.
    player.setSourceResolver((() => undefined) as unknown as SourceResolver)

    await player.load('library://one')
    await settle()

    expect(errors.map((error) => error.code)).toEqual(['load-failed'])
    expect(client.resolvedSources.size).toBe(0)
    player.destroy()
  })

  it('retries on the next queue movement after a failure', async () => {
    // A failed resolution is not remembered, so a transient outage costs one
    // track rather than the rest of the queue.
    let attempts = 0
    const player = await createPlayer()
    player.on('error', () => undefined)
    player.setSourceResolver((request) => {
      attempts += 1
      if (attempts === 1) throw new Error('transient')
      return `${request.uri}?sig`
    })
    seedPlaylist(['library://a'])

    moveCursor(0, 1)
    await settle()
    expect(client.resolvedSources.size).toBe(0)

    client.emit([propertyEvent(MpvProperty.playlistCount, 2)])
    await settle()
    expect(client.resolvedSources.get('library://a')).toBe('library://a?sig')
    player.destroy()
  })
})

describe('generation guarding', () => {
  it('drops an answer from a resolver that has since been replaced', async () => {
    let release: ((value: string) => void) | undefined
    const player = await createPlayer()
    player.setSourceResolver(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        })
    )

    void player.load('library://one')
    player.setSourceResolver((request) => `${request.uri}?new`)
    release?.('https://cdn/stale')
    await settle()

    // The stale answer must not reach the cache: a resolution written after the
    // resolver changed is exactly the non-determinism this design exists to
    // prevent.
    expect(
      client.resolverCalls.some(
        (call) => call.kind === 'set' && call.resolved === 'https://cdn/stale'
      )
    ).toBe(false)
    player.destroy()
  })

  it('releases a held hook with nothing when the resolver changed mid-flight', async () => {
    let release: ((value: string) => void) | undefined
    const player = await createPlayer()
    player.setSourceResolver(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        })
    )

    client.emitResolutionRequest({ uri: 'library://one' })
    await Promise.resolve()
    player.setSourceResolver((request) => `${request.uri}?new`)
    release?.('https://cdn/stale')
    await settle()

    // Answered — mpv is holding its core open and must never be left waiting —
    // but answered with nothing, because a discarded resolver's URL is not ours
    // to hand over or to cache.
    expect(client.resolverCalls.at(-1)).toEqual({
      kind: 'complete',
      logical: 'library://one',
      resolved: undefined,
      ttlMs: DEFAULT_RESOLVER_TTL_MS,
    })
    player.destroy()
  })

  it('drops an answer that lands after the player is destroyed', async () => {
    let release: ((value: string) => void) | undefined
    const player = await createPlayer()
    player.setSourceResolver(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        })
    )

    void player.load('library://one')
    player.destroy()
    release?.('https://cdn/late')
    await settle()

    expect(client.resolverCalls.some((call) => call.kind === 'set')).toBe(false)
  })
})
