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
  /**
   * Endless stream with no meaningful total length.
   *
   * This is the app's own, *static* knowledge. The player now works this out on
   * its own — `PlayerState.isLive` is `true` once mpv reports `seekable = no`,
   * and `duration` is suppressed there — so this flag is only a head start for
   * the window before mpv has published seekability.
   *
   * Why either matters: on an Icecast stream mpv reports a `duration` equal to
   * how much it has *cached*, so it grows several times a second forever.
   * Broadcasting that would turn the media session into a ticker — the exact
   * thing the position anchor exists to avoid — and would draw a seek bar whose
   * end keeps running away from the listener.
   */
  readonly live?: boolean
}

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
    live: true,
  },
  {
    id: 'fip-hls',
    title: 'FIP',
    artist: 'Radio France',
    album: 'HLS master · AAC · live',
    uri: 'https://stream.radiofrance.fr/fip/fip.m3u8',
    live: true,
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
    live: true,
  },
  {
    id: 'mp3-test',
    title: 'MP3 Test File',
    artist: 'Internet Archive',
    album: 'Finite · 12 s',
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
