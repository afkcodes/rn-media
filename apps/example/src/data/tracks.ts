/**
 * The demo queue.
 *
 * Data only — no player, no React. It is imported by the playback layer (which
 * loads it) and by the UI (which draws it), and it knows about neither.
 */
import type { MediaItem } from '@rn-media/media-session'

export interface Track extends MediaItem {
  /** What the player loads. Kept out of `MediaItem`, which is metadata only. */
  readonly uri: string
  /*
   * There used to be an app-side `live?: boolean` here. It is gone because
   * `MediaItem.isLive` now says the same thing *to the media session as well*:
   * the radio entries below set it, the broadcast projection forwards it, and
   * every surface (this screen, the notification, the lock screen) reads one
   * flag instead of inferring live-ness from a missing duration.
   *
   * The flag is still the app's own, *static* knowledge — a head start for the
   * window before mpv has published seekability (`PlayerState.isLive` flips
   * once mpv reports `seekable = no`). Why it matters at all: on an Icecast
   * stream mpv reports a `duration` equal to how much it has *cached*, so it
   * grows several times a second forever. Broadcasting that would turn the
   * media session into a ticker — the exact thing the position anchor exists
   * to avoid — and would draw a seek bar whose end keeps running away from the
   * listener.
   */
}

/**
 * The logical URI of the deliberately-broken entry (queue entry 7).
 *
 * Its own scheme, not `demo://track/<id>`, because it is not a catalogue
 * lookup: the resolver answers it from a rule rather than from
 * {@link DEMO_SOURCES}, and keeping the two apart is what stops "the demo
 * catalogue" and "the demo failure" from being one map with a poisoned row in
 * it.
 */
export const DEMO_BROKEN_URI = 'demo://broken'

/**
 * What {@link DEMO_BROKEN_URI} resolves to: a connection that is refused
 * instantly, on every device, with no network.
 *
 * Port 9 is `discard` (RFC 863) and nothing on a phone listens on it, so the
 * loopback connect is refused by the kernel — no DNS, no route, no timeout, the
 * same failure in aeroplane mode as on Wi-Fi. `https://` is load-bearing:
 * `classifyEndFile` splits a failed open on `isNetworkUri`, so a network URI
 * becomes a **retryable `network`** error and anything else becomes a
 * non-retryable `load-failed`. This entry demonstrates the retry path, and only
 * a real network scheme takes it.
 */
export const DEMO_BROKEN_TARGET = 'https://127.0.0.1:9/unreachable.aac'

/**
 * Public HTTPS endpoints, so this runs on a clean device with no fixtures.
 *
 * Deliberately different shapes, because each exercises a different part of
 * the stack:
 *
 * 1. **Icecast MP3, live** — plain chunked HTTPS, no container index.
 * 2. **HLS/AAC, live, master playlist** — three variants, AAC in MPEG-TS
 *    segments. Exercises the one thing entries 1/4/5 do not: a
 *    playlist-of-segments container, where ffmpeg (not our stream layer)
 *    fetches every segment itself, plus variant selection.
 * 3. **HLS/AAC, live, media playlist** — the *other* HLS shape: no master, the
 *    URL is the segment list directly, so there is no variant to pick. Kept
 *    alongside 2 because a build can get one right and the other wrong.
 *
 *    Both HLS entries work on Android since the libmpv pin moved to
 *    `v1.1.9-rnmedia.2` (packages/player/android/libmpv.gradle): media-kit's
 *    stock audio binaries configure ffmpeg with `--disable-demuxers` plus an
 *    allow-list that carried neither `hls` nor `mpegts`, so they used to fail
 *    with `unsupported-format` no matter what — `--enable-protocol=hls` was
 *    present, but that is the deprecated `hls://` protocol, not the demuxer.
 *    Our fork adds `--enable-demuxer=hls --enable-demuxer=mpegts` and nothing
 *    else. iOS ships the matching fork (`v0.7.2-rnmedia.2`), so both entries
 *    should work there too — CI-verified only; never run on an iOS device.
 *
 * 4. **Finite MP3, 12 s** — short enough to reach `trackEnded` while you are
 *    still looking at it, so it is what proves duration reporting and the
 *    end-of-queue path.
 * 5. **Finite AAC-in-MP4, full length** — a real commercial-CDN asset, so it
 *    covers the `mov` demuxer + `aac` decoder path that a plain `.mp3` does
 *    not, and it is long enough that the seek bar (in-app and on the lock
 *    screen) is actually usable: a 12-second track is under one thumb-width
 *    per 15 seconds of travel. Also the track the EQ presets are judged on.
 *
 * One measurement caveat (2026-08-12): the only finite natural boundary in
 * this queue (4 → 5) is a FORMAT CHANGE — 44100Hz mono → 44100Hz stereo — so
 * `gapless-audio=weak` reopens the audio device there (~330 ms + an expected
 * underrun), exactly as documented. ARCHITECTURE §12's 25 ms gapless handover
 * was measured across two identically-encoded entries; this queue cannot
 * reproduce that number and is not supposed to.
 *
 * 6. **The same asset as 5, behind a `demo://` URI** — added with the modular
 *    restructure, and it earns its place three times over:
 *
 *    - it is the **source-resolver** demo (`src/playback/resolver.ts`): nothing
 *      in this file is a playable URL, so if you hear it, `setSourceResolver`
 *      ran on both the resolve-ahead and the hook path;
 *    - it is the **insert-next** demo target — "Next" on this row is an
 *      `add(uri, { position: 'next' })` of a resolver-backed source, which is
 *      the combination most likely to be wrong;
 *    - and it makes the 5 → 6 boundary an *identically encoded* one.
 *
 *    Addendum to the caveat above (2026-08-12, same day, this restructure):
 *    that paragraph is unchanged and still describes 4 → 5 correctly. What is
 *    new is that 5 → 6 is now the identically-encoded case the caveat says
 *    this queue could not produce — same file, 44100Hz stereo on both sides,
 *    which is exactly where `gapless-audio=weak` keeps the device open. It is
 *    an *untested claim on this device* until someone measures it; do not
 *    quote a number for it until they have.
 *
 * 7. **An entry that cannot possibly play** — and it is a FEATURE DEMO, not a
 *    fixture. Every media app has an error path: a song pulled from the
 *    catalogue, a CDN edge that is down, a phone that lost its connection
 *    between the tap and the fetch. This entry is that path, on purpose and on
 *    demand, so the three things this library does about it can be *seen*
 *    rather than described:
 *
 *    - the **typed taxonomy** — it fails as `network` with `retryable: true`,
 *      which is what makes `ErrorBanner` draw a Retry button without keeping an
 *      app-side table of which codes are worth retrying;
 *    - the **`retrying` event and `RetryBanner`** — while the player is
 *      re-attempting, NO `error` event fires at all, so an app that listened
 *      only to `error` would show nothing while a stream reconnects;
 *    - **bounded retry before skip** — after `retry.maxAttempts` re-attempts
 *      the player stops arguing, the advance mpv already performed stands, and
 *      `error` finally fires carrying the attempt count.
 *
 *    It resolves (through the same demo resolver as entry 6) to
 *    `https://127.0.0.1:9/unreachable.aac`. Port 9 is `discard`, nothing is
 *    listening on the loopback interface of a phone, and a refused TCP connect
 *    is instant and needs no network at all — so the failure is fast,
 *    deterministic and identical on a plane. It is deliberately an `https://`
 *    URL rather than a bogus scheme: the classifier splits a failed open on
 *    {@link isNetworkUri}, so only a real network URI produces the `network`
 *    error the retry layer acts on. A made-up scheme would be `load-failed`,
 *    non-retryable, and would demo nothing.
 */
export const TRACKS: readonly Track[] = [
  {
    id: 'diverse-fm',
    title: 'Diverse FM',
    artist: 'Diverse FM',
    album: 'Shoutcast AAC+ · live',
    // The trailing `/;` is the Shoutcast convention for "give me the stream,
    // not the status page" — verified to return `audio/aacp` with
    // `icy-name: Diverse FM`.
    uri: 'https://carol.epichosts.co.uk:8570/;',
    artworkUri:
      'https://static.mytuner.mobi/media/tvos_radios/621/diverse-fm-bollywood-music-mix.7ea30dfa.png',
    // The extended `MediaItem.isLive` tag: tells every surface "this is live"
    // as a *fact*, instead of leaving them to infer it from the duration that
    // never arrives. Forwarded by `toMediaItem` and by the queue channel.
    isLive: true,
  },
  {
    id: 'fip-hls',
    title: 'FIP',
    artist: 'Radio France',
    album: 'HLS master · AAC · live',
    uri: 'https://stream.radiofrance.fr/fip/fip.m3u8',
    isLive: true,
  },
  {
    id: 'vividh-bharati-hls',
    title: 'Vividh Bharati',
    artist: 'All India Radio',
    // No master playlist: this URL *is* the media playlist (`#EXTINF` +
    // `.ts` segments), so it covers the no-variant HLS path that entry 2
    // does not.
    album: 'HLS media · AAC · live',
    uri: 'https://radio.wavespb.com/live/146ed6ec6dea5a24/146ed6ec6dea5a24.m3u8',
    artworkUri:
      'https://airdco.pc.cdn.bitgravity.com/images/vividh-bharati.jpg',
    isLive: true,
  },
  {
    id: 'mp3-test',
    title: 'MP3 Test File',
    artist: 'Internet Archive',
    album: 'Finite · 12 s',
    // Deliberately no extended tags: the source file carries none, and this
    // queue does not invent metadata. The tagged entries are below.
    uri: 'https://archive.org/download/testmp3testfile/mpthreetest.mp3',
  },
  {
    id: 'aari-aari',
    title: 'Aari Aari (Dhurandhar 2)',
    artist: 'Dhurandhar: The Revenge',
    // AAC in an MP4/M4A container, which is the shape every commercial music
    // CDN serves — so it also covers the `mov` demuxer + `aac` decoder path
    // that a plain `.mp3` does not.
    album: 'Finite · AAC/MP4 · seek + EQ test',
    uri: 'https://aac.saavncdn.com/905/f968ceef36dde517a2aee1b74e119166_160.mp4',
    artworkUri:
      'https://c.saavncdn.com/905/Dhurandhar-The-Revenge-Aari-Aari-From-Dhurandhar-The-Revenge-Hindi-2026-20260312141004-500x500.jpg',
    // Extended tags — only the ones that are *true* of this source. It is a
    // 2026 film single (the CDN's own asset naming says `Hindi-2026`), so the
    // release year and "track 1 of a single" are facts; an album artist or a
    // composer credit would be a guess, so neither is here. On Android these
    // land as `MediaMetadata.releaseYear` / `.trackNumber`; iOS publishes the
    // track number and has no year key at all (see the `MediaItem` TSDoc).
    year: 2026,
    trackNumber: 1,
  },
  {
    // Entry 6: see the `demo://` paragraph in the block comment above. The id
    // is distinct from entry 5's on purpose — same audio, different queue
    // entry — so the two never collide in the media-session queue channel or
    // in the app's own duration cache.
    id: 'aari-aari-resolved',
    title: 'Aari Aari (via demo:// resolver)',
    artist: 'Dhurandhar: The Revenge',
    album: 'Resolver + insert-next demo',
    uri: 'demo://track/aari-aari',
    artworkUri:
      'https://c.saavncdn.com/905/Dhurandhar-The-Revenge-Aari-Aari-From-Dhurandhar-The-Revenge-Hindi-2026-20260312141004-500x500.jpg',
    // Same audio as entry 5, so the same honest tags apply.
    year: 2026,
    trackNumber: 1,
  },
  {
    // Entry 7: the error path, on demand. See the block comment above — this
    // exists so the retryable taxonomy, the `retrying` event and bounded
    // retry-before-skip can be watched happening, on a device, in a build
    // anyone can run.
    id: 'retry-demo',
    title: 'Retry & errors demo',
    artist: 'Tap to watch it fail',
    album: 'Fails fast · retryable · re-attempted twice, then skipped',
    uri: DEMO_BROKEN_URI,
  },
]

/**
 * What the `demo://` scheme resolves to — this app's stand-in for the signing
 * endpoint a real music app would call.
 *
 * Kept next to the queue rather than next to the resolver because it is
 * *data*: the resolver in `src/playback/resolver.ts` is the ten lines of policy
 * that read it, and swapping this map for `await api.sign(id)` is the whole
 * difference between this demo and a production integration.
 *
 * Note it is a plain constant map, which makes the resolver **deterministic**
 * — the same logical URI always produces the same URL. That is a hard
 * requirement, not a style choice: mpv compares the prefetch pass's URL with
 * the play-time pass's byte-for-byte and throws the prefetched stream away if
 * they differ. See `SourceResolver`'s TSDoc.
 */
export const DEMO_SOURCES: Readonly<Record<string, string>> = {
  'aari-aari':
    'https://aac.saavncdn.com/905/f968ceef36dde517a2aee1b74e119166_160.mp4',
  'mp3-test': 'https://archive.org/download/testmp3testfile/mpthreetest.mp3',
}

/** URI scheme the demo resolver claims. Everything else passes through. */
export const DEMO_SCHEME = 'demo://track/'
