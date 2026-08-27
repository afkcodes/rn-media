import type { HybridObject } from 'react-native-nitro-modules'

/**
 * Turns an Android `content://` URI into a file descriptor mpv can read.
 *
 * @remarks
 * **Why this has to be native at all.** A `content://` URI is not a path and
 * not a URL: it names a row in some other app's `ContentProvider`, and the only
 * way to read it is to ask Android's `ContentResolver` to open it *for this
 * process*, under the grant the picker handed us. Neither libmpv nor FFmpeg has
 * — or could have — a handler for the scheme, because the resolution is a
 * Binder call into another process, not a URI parse. So the bytes have to reach
 * mpv the one way a Binder-opened file can travel: as a file descriptor.
 *
 * mpv's own `fd://` protocol is the other half. From mpv 0.41.0
 * `DOCS/man/mpv.rst`: *"``fd://123`` — Read data from the given file
 * descriptor"*, implemented in `stream/stream_file.c:298-313`, which validates
 * the descriptor with `fcntl(fd, F_GETFD)` and then reads it like any other
 * file. So `ContentResolver.openFileDescriptor(uri, "r").detachFd()` →
 * `fd://<n>` is a complete path from the storage picker to the decoder, with no
 * copy and no temporary file.
 *
 * **`fd://`, not `fdclose://`.** `fdclose://` makes mpv `close()` the
 * descriptor when the stream ends (`stream_file.c:313`, `p->close = true`),
 * which sounds like the tidy choice and is not: the URL a source resolver hands
 * back must stay byte-identical for the life of the entry (mpv compares the
 * prefetch and play-time URLs to decide whether it can reuse the prefetched
 * stream), so the *same* `fd://n` is opened again whenever the entry is
 * replayed — `loop`, a `jumpTo` back, a dropped prefetch. mpv re-seeks the
 * descriptor to 0 on every open (`stream_file.c:373-379`), so reopening works
 * — but only if nobody closed it. Ownership therefore stays on this side:
 * {@link closeContentFd} is called when the player is destroyed.
 *
 * **Android-only, by construction.** iOS has no `content://` scheme and no
 * `ContentResolver`; its document picker hands back a `file://` URL that mpv
 * opens directly. There is nothing here for iOS to implement, so this
 * HybridObject is not declared for it and
 * `NitroModules.createHybridObject('RnMediaContentSource')` is never called
 * there — see `src/content-uri.ts`, which is the only consumer.
 */
export interface RnMediaContentSource
  extends HybridObject<{ android: 'kotlin' }> {
  /**
   * Open `uri` for reading and hand back a **detached** file descriptor.
   *
   * @param uri - A `content://` URI this process holds a read grant for.
   * @returns The raw file descriptor number, owned by the caller from here on
   * — `ParcelFileDescriptor.detachFd()`, so the Java object no longer closes
   * it and {@link closeContentFd} is the only thing that will.
   * @throws When the provider is unknown, the grant has lapsed, the row does
   * not exist, or the provider returned no descriptor. The message names which.
   */
  openContentUri(uri: string): number

  /**
   * Close a descriptor handed out by {@link openContentUri}.
   *
   * @param fd - The descriptor. Closing one twice, or closing one mpv is still
   * reading, is the caller's bug to avoid; this only reports failures.
   */
  closeContentFd(fd: number): void
}
