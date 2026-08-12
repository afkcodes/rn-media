import type { PlayerError } from './errors'
import { toPlayerError } from './errors'
import type {
  MpvClient,
  SourceResolutionRequest,
} from './specs/mpv-client.nitro'

/**
 * Turns the logical URI in a playlist into the concrete URL mpv should open.
 *
 * @param request - The URI mpv is about to open. `request.entryId` is mpv's
 * playlist entry id and is present only when the request came from the *prefetch*
 * path — see {@link SourceResolutionRequest}.
 * @returns The URL to open, synchronously or as a promise.
 *
 * @remarks
 * **Determinism is a requirement, not a nicety.** While a queue is active the
 * same input must produce the same output. mpv opens each entry twice — once
 * speculatively on the prefetch path, once for real — and decides whether the
 * prefetched stream can be reused by comparing the two resulting URLs
 * byte-for-byte (`open_demux_reentrant`, mpv 0.41.0 `player/loadfile.c:1223`).
 * A resolver that mints a fresh nonce or a fresh signature per call therefore
 * silently *defeats* prefetching: mpv logs "Dropping finished prefetch of wrong
 * URL", joins the doomed opener thread on its core thread at the track
 * boundary, and opens cold — which is worse than never prefetching at all.
 *
 * This library removes most of that hazard for you by caching the first answer
 * per URI (see `resolverTtlMs`) and replaying it for the second pass, so a
 * resolver only has to be deterministic *for as long as its answer is cached*.
 * Mint your signed URL once per track, not once per call, and you are fine.
 *
 * **The resolver runs on the JavaScript thread and it is allowed to be slow —
 * within a budget.** Resolution happens ahead of time wherever possible: the
 * current and next entries are resolved as soon as the queue moves, which is
 * typically a whole track's worth of wall time before mpv needs the answer.
 * When mpv asks for a URI that is not cached yet, and it asks at *play* time,
 * mpv's core is held open until you answer or `resolverTimeoutMs` elapses. On
 * timeout the logical URI is used unchanged and mpv fails the load on its own
 * terms, which arrives as an ordinary typed `error` event.
 *
 * **URIs pass through untouched when no resolver is installed.** The hooks are
 * registered for the life of the core (see `Player.setSourceResolver` for why),
 * but a disarmed handler reads nothing and rewrites nothing — it continues the
 * hook immediately, so what mpv opens is byte-for-byte the logical URI. That
 * includes local files and live streams, which usually need no resolution: a
 * resolver that has nothing to do for a URI should return it unchanged, and the
 * identity answer costs one map lookup.
 *
 * @example
 * ```ts
 * player.setSourceResolver(async ({ uri }) => {
 *   if (!uri.startsWith('library://')) return uri // nothing to do
 *   const { url } = await api.signPlaybackUrl(uri.slice('library://'.length))
 *   return url
 * })
 * ```
 */
export type SourceResolver = (
  request: SourceResolutionRequest
) => string | Promise<string>

/**
 * Default `resolverTimeoutMs`: how long a play-time miss may hold mpv's core.
 *
 * The hold is safe at play time — the entry has not opened yet, so there is no
 * audio of its own to starve, and the previous entry has already ended — but it
 * is still a stall with nothing on screen moving, so it is bounded. Ten seconds
 * is a network round-trip plus a retry, and it is far short of the point where a
 * user concludes the app has hung.
 *
 * Note this budget applies to the play-time path *only*. The prefetch path never
 * waits, at any timeout: it fires mid-track over live audio backed by ~0.2–0.8 s
 * of device buffer (ARCHITECTURE §12), so a miss there is answered by continuing
 * mpv immediately and warming the cache for the play-time pass.
 *
 * **The hold parks the event thread, and that is the honest cost.** The wait is
 * taken by the thread that drains mpv's event queue, so while it runs no
 * property change and — this is the part that surprises people — **no command
 * reply** reaches JavaScript. A `seekTo()` or `play()` Promise issued during an
 * unresolved play-time load can therefore stay pending for up to this long.
 * Nothing is lost (the replies arrive as soon as the hold ends) and nothing can
 * hang forever (the budget is the bound), but the latency is real. Resolve-ahead
 * exists to keep this path cold: with the current and next entries answered as
 * the queue moves, a play-time miss should be the exception, and an app that
 * cannot tolerate the stall at all can set the budget to `0` and rely on the
 * pre-warmed cache alone.
 */
export const DEFAULT_RESOLVER_TIMEOUT_MS = 10_000

/**
 * Default `resolverTtlMs`: how long one resolution stays usable.
 *
 * Biased deliberately short. Too *short* costs a prefetch — the play-time pass
 * re-resolves, produces a different URL than the prefetch pass used, and mpv
 * discards the prefetched stream. Too *long* hands mpv a signed URL that has
 * already expired, which is an outright load failure. One is a lost
 * optimisation, the other is a broken track, so the default covers a typical
 * track comfortably and stops well short of a typical signature lifetime.
 *
 * Resolutions are refreshed whenever the queue moves, so this bounds staleness
 * rather than reachability.
 */
export const DEFAULT_RESOLVER_TTL_MS = 600_000

/** What {@link SourceResolverController} needs from its owner. */
export interface SourceResolverOptions {
  /** Play-time hold budget in milliseconds. */
  readonly timeoutMs: number
  /** How long one resolution stays cached, in milliseconds. */
  readonly ttlMs: number
  /** Called with a typed error when a resolver throws. */
  readonly onError: (error: PlayerError) => void
  /** Clock used for TTL bookkeeping. Injected by tests. */
  readonly now: () => number
}

interface CacheEntry {
  readonly resolved: string
  readonly expiresAt: number
}

function messageOf(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message
  if (typeof thrown === 'string') return thrown
  return String(thrown)
}

/**
 * Owns one player's source resolver: the function itself, the in-flight
 * de-duplication, the ahead-of-time resolution, and the answers to mpv.
 *
 * ### Why there is a TypeScript-side cache as well as a native one
 * The native cache is what mpv's hook reads; this one is what stops the
 * resolver being *called* again. Resolve-ahead runs on every queue movement, so
 * without it a five-entry queue would re-sign the same two URLs on every track
 * change. The two share a TTL and are cleared together, so they cannot disagree
 * about which answers are live.
 *
 * ### Why answers are generation-stamped
 * Replacing or removing a resolver must not let an in-flight call from the old
 * one land afterwards: a stale answer written into the cache is exactly the
 * non-determinism the whole design exists to avoid. Every resolution captures
 * the generation it started in, and a settled promise whose generation has moved
 * on is dropped.
 */
export class SourceResolverController {
  readonly #client: MpvClient
  readonly #options: SourceResolverOptions
  readonly #cache = new Map<string, CacheEntry>()
  readonly #inFlight = new Map<string, Promise<string | undefined>>()

  #resolver: SourceResolver | undefined
  #generation = 0
  #destroyed = false

  /**
   * @param client - The player's mpv binding.
   * @param options - See {@link SourceResolverOptions}.
   */
  constructor(client: MpvClient, options: SourceResolverOptions) {
    this.#client = client
    this.#options = options
  }

  /** Whether a resolver is currently installed. */
  get installed(): boolean {
    return this.#resolver !== undefined
  }

  /**
   * Install, replace or remove the resolver.
   *
   * Every cached answer is dropped: a different resolver may legitimately answer
   * differently, and keeping the old answers would mean the change silently did
   * not take effect for the entries already in flight.
   *
   * @param resolver - The resolver, or `null` to remove it.
   *
   * @remarks
   * Native failures propagate: this is a direct call from the app, so it is the
   * one place in this class with a caller to throw to.
   */
  set(resolver: SourceResolver | null): void {
    if (this.#destroyed) return
    this.#generation += 1
    this.#cache.clear()
    this.#inFlight.clear()

    if (resolver === null) {
      if (this.#resolver === undefined) return
      this.#resolver = undefined
      // Disarms the native handler and clears its cache. mpv keeps the hook
      // registrations (it has no unregister call), but a disarmed handler
      // continues every hook immediately and unrewritten — i.e. stock mpv.
      this.#client.uninstallSourceResolver()
      return
    }

    const previous = this.#resolver
    this.#resolver = resolver
    try {
      if (previous !== undefined) this.#client.clearResolvedSources()
      // Idempotent, and it registers nothing: the hooks went in at
      // `initialize()` and cannot be removed (mpv has no unregister call). This
      // only stores the hold budget and flips the handler from pass-through to
      // resolving — see the doc block at the top of this file.
      this.#client.installSourceResolver(this.#options.timeoutMs)
    } catch (thrown) {
      // Roll back, so a rejected install leaves no half-armed resolver behind
      // — otherwise `installed` would claim a resolver mpv will never consult.
      this.#resolver = previous
      throw thrown
    }
  }

  /**
   * Resolve `uris` ahead of mpv asking, and push the answers into the native
   * cache.
   *
   * This is the path that keeps mpv's core out of the JavaScript thread's way:
   * an answer that is already cached when a hook fires costs a map lookup and a
   * property write, and nothing else. URIs that are already resolved (and still
   * fresh) or already being resolved are skipped.
   *
   * @param uris - Logical URIs, in priority order. Anything falsy is ignored.
   */
  resolveAhead(uris: readonly string[]): void {
    if (this.#destroyed || this.#resolver === undefined) return
    for (const uri of uris) {
      if (uri === '') continue
      if (this.#fresh(uri) !== undefined) continue
      const generation = this.#generation
      void this.#resolve(uri, undefined).then((resolved) => {
        if (resolved === undefined) return
        this.#remember(uri, resolved, generation)
      })
    }
  }

  /**
   * Answer one native {@link SourceResolutionRequest}.
   *
   * Always answers, on every path — a play-time request is holding mpv's core
   * open, and the only thing worse than a slow answer is none at all.
   *
   * @param request - The request as the native binding delivered it.
   */
  handleRequest(request: SourceResolutionRequest): void {
    const { uri } = request
    if (this.#destroyed || this.#resolver === undefined) {
      // No resolver (it was removed between the hook firing and this callback
      // landing). Release the hold at once rather than making mpv wait out the
      // full timeout for an answer nobody is going to give.
      this.#complete(uri, undefined)
      return
    }

    const cached = this.#fresh(uri)
    if (cached !== undefined) {
      this.#complete(uri, cached)
      return
    }

    const generation = this.#generation
    void this.#resolve(uri, request.entryId).then((resolved) => {
      if (this.#destroyed || generation !== this.#generation) {
        // The resolver was replaced or removed while this call was in flight.
        // The answer is no longer ours to give — using it would hand mpv a URL
        // from a resolver the app has discarded, and caching it would keep that
        // URL alive for a whole TTL. Release the hold with nothing instead and
        // let mpv fail on its own terms.
        this.#complete(uri, undefined)
        return
      }
      if (resolved !== undefined) this.#remember(uri, resolved, generation)
      this.#complete(uri, resolved)
    })
  }

  /** Drop everything. Called by `Player.destroy()`; idempotent. */
  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#generation += 1
    this.#resolver = undefined
    this.#cache.clear()
    this.#inFlight.clear()
  }

  /**
   * Run the resolver for `uri`, at most once at a time.
   *
   * De-duplication is by logical URI rather than per call site, so a
   * resolve-ahead already in flight when mpv asks for the same URI is *joined*
   * rather than raced — which matters beyond efficiency, because two concurrent
   * calls to a nonce-minting resolver would produce two different answers for
   * one entry.
   */
  #resolve(
    uri: string,
    entryId: number | undefined
  ): Promise<string | undefined> {
    const existing = this.#inFlight.get(uri)
    if (existing !== undefined) return existing

    const resolver = this.#resolver
    if (resolver === undefined) return Promise.resolve(undefined)

    const request: SourceResolutionRequest =
      entryId === undefined ? { uri } : { uri, entryId }

    // The body is deferred by one microtask deliberately. A resolver that
    // throws *synchronously* runs the `finally` below before the promise it
    // belongs to has been recorded in `#inFlight` — the entry would then be
    // added after its own removal and stay there forever, so that URI could
    // never be resolved again for the life of the player. (Regression test:
    // "retries on the next queue movement after a failure".)
    const pending = Promise.resolve().then(async (): Promise<
      string | undefined
    > => {
      try {
        const resolved = await resolver(request)
        if (typeof resolved !== 'string' || resolved === '') {
          throw new Error(
            `the resolver returned ${resolved === '' ? 'an empty string' : String(resolved)} instead of a URL`
          )
        }
        return resolved
      } catch (thrown) {
        // Not swallowed and not cached: the caller hears about it on the typed
        // `error` channel, and mpv is left to open the logical URI and fail on
        // its own terms rather than being handed a URL we do not trust.
        const raw = messageOf(thrown)
        this.#options.onError({
          code: 'load-failed',
          message: `Could not resolve \`${uri}\`: ${raw}`,
          raw,
          uri,
        })
        return undefined
      } finally {
        this.#inFlight.delete(uri)
      }
    })

    this.#inFlight.set(uri, pending)
    return pending
  }

  /** The still-valid cached answer for `uri`, if any. */
  #fresh(uri: string): string | undefined {
    const entry = this.#cache.get(uri)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= this.#options.now()) {
      this.#cache.delete(uri)
      return undefined
    }
    return entry.resolved
  }

  /** Record an answer on both sides, unless the resolver moved on meanwhile. */
  #remember(uri: string, resolved: string, generation: number): void {
    if (this.#destroyed || generation !== this.#generation) return
    this.#cache.set(uri, {
      resolved,
      expiresAt: this.#options.now() + this.#options.ttlMs,
    })
    this.#guard(() => {
      this.#client.setResolvedSource(uri, resolved, this.#options.ttlMs)
    })
  }

  /** Hand an answer (or a non-answer) back to native. */
  #complete(uri: string, resolved: string | undefined): void {
    this.#guard(() => {
      this.#client.completeResolution(uri, resolved, this.#options.ttlMs)
    })
  }

  /**
   * Run a native call, reporting a failure instead of throwing.
   *
   * These run from promise continuations and from the native request callback,
   * where there is no caller to throw to — an escaping rejection would become an
   * unhandled one. A player that is being torn down is the expected cause and is
   * not worth reporting.
   */
  #guard(call: () => void): void {
    try {
      call()
    } catch (thrown) {
      const error = toPlayerError(thrown)
      if (error.code === 'disposed') return
      this.#options.onError(error)
    }
  }
}
