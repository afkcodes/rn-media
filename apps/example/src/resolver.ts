/**
 * The source-resolver demo: `demo://track/<id>` → a real, public HTTPS URL.
 *
 * This is the shape every catalogue app needs. Your queue is a list of *your*
 * ids; what mpv has to open is a signed, expiring CDN URL that cannot be
 * written down in advance. `Player.setSourceResolver` (or `sourceResolver` on
 * `Player.create`, which is what this app uses so the very first entry is
 * covered too) is the seam between the two, and the whole point is that the
 * queue never has to hold a URL.
 *
 * ## The three things worth copying
 *
 * 1. **Return the input unchanged for anything you do not own.** Five of the
 *    seven queue entries are plain HTTPS and fall straight through; the
 *    identity answer costs one map lookup and nothing else. A resolver is not a
 *    gatekeeper.
 * 2. **Be deterministic while the answer is cached.** mpv opens each entry
 *    twice — once speculatively on the prefetch path, once for real — and
 *    reuses the prefetched stream only if the two URLs match byte for byte. A
 *    resolver that mints a fresh nonce per call silently *defeats* prefetching,
 *    which is worse than never prefetching. Sign once per track, not once per
 *    call. (Full reasoning: `SourceResolver`'s TSDoc in `@timbre/player`.)
 * 3. **You are allowed to be slow — off the critical path.** The player
 *    resolves the current and next entries as the queue moves, typically a
 *    whole track before mpv asks, so the artificial latency below is paid while
 *    something else is playing. Only a *cache miss at play time* holds mpv's
 *    core, and only for `resolverTimeoutMs`.
 */
import type { SourceResolver } from '@timbre/player'
import {
  DEMO_BROKEN_TARGET,
  DEMO_BROKEN_URI,
  DEMO_SCHEME,
  DEMO_SOURCES,
} from './data/tracks'

/**
 * Stand-in for the network round trip a real signing call would cost.
 *
 * Deliberately long enough to be visible in a log timeline: if you see
 * `[example] resolver:` for the *next* entry while the current one is still
 * playing, resolve-ahead is doing its job and the hook will hit a warm cache.
 */
const FAKE_SIGNING_LATENCY_MS = 120

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Build the demo resolver.
 *
 * `request.entryId` is present **only on the prefetch path** — at prefetch time
 * mpv has not started the entry yet, so there is no playlist cursor to read and
 * the fork exposes the entry id instead. Its absence is therefore the signal
 * for "this one is blocking mpv's core", which is exactly the case you want to
 * see in a log when a transition felt slow.
 */
export function createDemoResolver(): SourceResolver {
  return async ({ uri, entryId }) => {
    // Queue entry 7. **This is a feature demo, not a fixture** — every app
    // needs an error path, and this one makes it reproducible: the entry
    // resolves to a connection that is refused instantly (see
    // `DEMO_BROKEN_TARGET`), which is what lets you watch, on a device, the
    // three things this library does about a failure that a description cannot
    // show you — the `retryable` taxonomy driving the banner's Retry button,
    // the `retrying` event firing while NO `error` event does, and the queue
    // finally moving on once the bounded budget is spent.
    //
    // Resolved rather than written into `TRACKS` directly so the queue keeps
    // one honest shape (a list of *logical* ids) and so the failure is a
    // property of this policy — one line to point somewhere real, one line to
    // point at nothing.
    if (uri === DEMO_BROKEN_URI) {
      console.log(`[example] resolver: ${uri} → ${DEMO_BROKEN_TARGET} (demo)`)
      return DEMO_BROKEN_TARGET
    }

    if (!uri.startsWith(DEMO_SCHEME)) return uri // nothing to do — pass through

    const id = uri.slice(DEMO_SCHEME.length)
    const target = DEMO_SOURCES[id]
    if (target === undefined) {
      // Throwing is the honest answer: the player reports it on the typed
      // `error` channel, does not cache it, and lets mpv fail the load on its
      // own terms. Returning a bogus URL would hide the mistake behind an
      // `unsupported-format` three seconds later.
      throw new Error(`no demo source for "${id}"`)
    }

    await delay(FAKE_SIGNING_LATENCY_MS)
    console.log(
      `[example] resolver: ${uri} → ${target} (${
        entryId === undefined ? 'play-time — holding mpv' : `prefetch #${entryId}`
      })`
    )
    return target
  }
}
