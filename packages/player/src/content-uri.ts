import { NitroModules } from 'react-native-nitro-modules'
import { PlayerErrorException } from './errors'
import type { RnMediaContentSource } from './specs/content-source.nitro'

/** The scheme Android's storage picker, MediaStore and every SAF provider use. */
export const CONTENT_URI_SCHEME = 'content://'

/**
 * Whether `uri` is an Android `content://` URI.
 *
 * Case-insensitive on the scheme, because `Uri.parse` is: `CONTENT://…` is the
 * same URI to Android and would otherwise slip past the rewrite and fail in
 * mpv, which is the exact bug this whole path exists to remove.
 */
export function isContentUri(uri: string): boolean {
  return uri.slice(0, CONTENT_URI_SCHEME.length).toLowerCase() === CONTENT_URI_SCHEME
}

/**
 * What {@link ContentUriResolver} needs from the platform. One method to open,
 * one to close.
 *
 * An interface rather than the HybridObject itself so the whole rewrite — the
 * caching, the eviction, the stability guarantee — is unit-testable in Node
 * without a device. See `src/__tests__/content-uri.test.ts`.
 */
export interface ContentUriOpener {
  /** Open for reading; returns an owned file descriptor. Throws on failure. */
  open(uri: string): number
  /** Release a descriptor from {@link open}. Must not throw. */
  close(fd: number): void
}

/**
 * How many descriptors one player keeps open at once.
 *
 * mpv holds at most **two** streams open at a time — the entry that is playing
 * and the one being prefetched — so this is not a working-set size: it is the
 * distance a descriptor is kept alive *after* nothing can be reading it any
 * more, expressed in distinct URIs resolved since. Sixty-four is far beyond
 * any reachable reuse (a user would have to load 64 other `content://` sources
 * and then come back) and far below Android's per-process descriptor limit, so
 * neither end of the trade is close.
 */
export const CONTENT_URI_FD_LIMIT = 64

/**
 * Rewrites Android `content://` URIs into `fd://` URLs mpv can open, once per
 * URI, for the life of the player.
 *
 * @remarks
 * **Why one descriptor per URI and not one per open.** A source resolver's
 * answers must be deterministic: mpv opens each playlist entry twice — once
 * speculatively on the prefetch path, once for real — and reuses the prefetched
 * stream only when the two URLs match byte-for-byte (mpv 0.41.0
 * `player/loadfile.c:1223`; see {@link SourceResolver}'s remarks). A fresh
 * descriptor per call would produce a different URL per call, so *every*
 * prefetch would be dropped and every track would open cold — the exact
 * failure the resolver documentation warns about, with a leaked descriptor on
 * top. Minting once and caching is what makes the rewrite invisible to the
 * prefetcher.
 *
 * **Why `fd://` and not `fdclose://`.** `fdclose://` has mpv close the
 * descriptor when the stream ends (`stream/stream_file.c:313`). That is
 * incompatible with a URL that has to stay valid for the entry's whole
 * lifetime: the same `fd://n` is opened again on a replay, on `loop`, on a
 * `jumpTo` back, and on the play-time pass after a prefetch mpv decided to
 * drop. mpv rewinds the descriptor on every open
 * (`stream_file.c:373-374`, `lseek(fd, 0, SEEK_END)` then `SEEK_SET`), so
 * reopening is correct — provided nobody closed it. Ownership therefore stays
 * here, and {@link destroy} is what releases it.
 *
 * **The one edge, stated plainly.** mpv reads the descriptor with `read()`
 * (`stream_file.c:126`), which advances the descriptor's own file offset, so
 * two streams open on one descriptor at the same time would interleave their
 * reads. That needs the *same* `content://` URI at two adjacent queue
 * positions — mpv prefetching entry *n+1* while entry *n* plays — since
 * nothing else has two streams open at once. A duplicated track elsewhere in
 * the queue, a replay, a loop: all sequential, all fine. Deduplicate adjacent
 * identical `content://` entries if your queue can produce them.
 */
export class ContentUriResolver {
  readonly #opener: ContentUriOpener
  /** Logical `content://` URI → the descriptor minted for it. Insertion-ordered. */
  readonly #descriptors = new Map<string, number>()
  #destroyed = false

  /** @param opener - The platform binding; see {@link ContentUriOpener}. */
  constructor(opener: ContentUriOpener) {
    this.#opener = opener
  }

  /**
   * The URL mpv should open for `uri`.
   *
   * @param uri - Any URI. Anything that is not `content://` is returned
   * unchanged and costs one prefix comparison.
   * @returns `fd://<n>`, stable for the life of this resolver.
   * @throws {@link PlayerErrorException} with code `load-failed` when the
   * platform could not open the URI — an expired grant, a deleted row, an
   * uninstalled provider. The caller reports it on the typed error channel and
   * lets mpv fail on the logical URI, so the failure is never silent.
   */
  resolve(uri: string): string {
    if (this.#destroyed || !isContentUri(uri)) return uri
    const existing = this.#descriptors.get(uri)
    if (existing !== undefined) return fdUrl(existing)

    let fd: number
    try {
      fd = this.#opener.open(uri)
    } catch (thrown) {
      const raw = thrown instanceof Error ? thrown.message : String(thrown)
      throw new PlayerErrorException({
        code: 'load-failed',
        message: `Cannot open ${uri}: ${raw}`,
        raw,
        // Not retryable, and the reason is the taxonomy's own: every way this
        // fails is a fact about the grant or the row, not about the network.
        // Asking the same provider for the same missing document again cannot
        // answer differently.
        retryable: false,
        uri,
      })
    }
    this.#remember(uri, fd)
    return fdUrl(fd)
  }

  /** Close every descriptor. Called by `Player.destroy()`; idempotent. */
  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    for (const fd of this.#descriptors.values()) this.#opener.close(fd)
    this.#descriptors.clear()
  }

  /** How many descriptors are open. Tests and diagnostics only. */
  get openCount(): number {
    return this.#descriptors.size
  }

  #remember(uri: string, fd: number): void {
    this.#descriptors.set(uri, fd)
    // Oldest first: `Map` iterates in insertion order, and an entry is only
    // ever inserted (never re-inserted — a hit returns early above), so the
    // first key is the least recently *minted*. See CONTENT_URI_FD_LIMIT for
    // why "least recently minted" is safe to close.
    while (this.#descriptors.size > CONTENT_URI_FD_LIMIT) {
      const [oldest] = this.#descriptors.keys()
      if (oldest === undefined) break
      const evicted = this.#descriptors.get(oldest)
      this.#descriptors.delete(oldest)
      if (evicted !== undefined) this.#opener.close(evicted)
    }
  }
}

/** mpv's own `fd://` protocol — mpv 0.41.0 `DOCS/man/mpv.rst`, "Protocols". */
function fdUrl(fd: number): string {
  return `fd://${String(fd)}`
}

/** The resolved platform opener, or `undefined` once we know there is none. */
let opener: ContentUriOpener | undefined | null = null

/**
 * The platform's `content://` opener, created on first use.
 *
 * @returns The opener on Android, `undefined` everywhere else.
 *
 * @remarks
 * **Capability detection, not `Platform.OS`.** The `RnMediaContentSource`
 * HybridObject is declared for Android only, so `createHybridObject` throws on
 * iOS — and on an Android binary built before this shipped, which is the same
 * answer for the same reason. Asking the module registry rather than the
 * platform keeps this package free of a `react-native` import in the playback
 * path (the visualizer's `AppState` is the only one, and it is a hook), and it
 * is the same shape `getScreenStateSource()` uses.
 *
 * Memoised either way, so a missing native module costs one failed lookup per
 * process rather than one per load.
 */
export function getContentUriOpener(): ContentUriOpener | undefined {
  if (opener !== null) return opener
  try {
    const native = NitroModules.createHybridObject<RnMediaContentSource>(
      'RnMediaContentSource'
    )
    opener = {
      open: (uri) => native.openContentUri(uri),
      close: (fd) => {
        try {
          native.closeContentFd(fd)
        } catch {
          // Teardown races a destroyed host object. There is nothing a caller
          // could do and nothing left to release.
        }
      },
    }
  } catch {
    // iOS (no such HybridObject, and no `content://` scheme either), or an app
    // binary older than this feature.
    opener = undefined
  }
  return opener
}

/**
 * Replace the platform opener.
 *
 * @param next - The opener to use, or `undefined` to go back to the platform's
 * (re-resolved on the next call).
 *
 * @remarks
 * Exists for tests and for an app whose `content://` reads have to go through
 * its own code — a provider that needs a header, a decryption shim. Install it
 * before the first `content://` load; a player that already resolved one keeps
 * the descriptors it minted.
 */
export function setContentUriOpener(next: ContentUriOpener | undefined): void {
  // `null` is the "not resolved yet" sentinel, which is what "go back to the
  // platform's" means; `undefined` is the resolved answer "there is none".
  opener = next ?? null
}
