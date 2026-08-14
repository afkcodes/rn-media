# @rn-media/cast

First-party Google Cast **sender** binding for React Native, audio-scoped —
built directly on the official SDKs
([play-services-cast-framework](https://developers.google.com/cast/docs/android_sender)
on Android, [google-cast-sdk](https://developers.google.com/cast/docs/ios_sender)
on iOS) as a Nitro Kotlin/Swift module. Chromecast on **both** platforms — no
platform-split feature.

Casting is a **URL handoff**, not an output route: the sender hands the
receiver a URL and the receiver fetches, decodes and plays it itself. Your
local player goes silent for the session and resumes at the receiver's
position when you transfer back. This package ships both layers: the binding
(Phase 2 of `docs/design/cast.md`) and the automatic local↔remote **handoff
state machine** (`wireCastHandoff`, Phase 3). The handoff deliberately lives
here — not in `@rn-media/media-session`, which stays cast-free — and talks to
your player and queue through structural interfaces, so it works with ANY
player.

> **⚠️ iOS 16 requirement.** The `google-cast-sdk` pod requires **iOS 16.0**
> (React Native's default target is lower). Installing this package raises
> your app's deployment floor — the Expo plugin bumps `ios.deploymentTarget`
> for you (with a warning); bare projects set `platform :ios, '16.0'` in the
> Podfile themselves. Devices on iOS 15 and older will not be able to install
> your app. This is the pod's own floor, not ours.

## Install

```sh
npm install @rn-media/cast react-native-nitro-modules
```

### Expo (prebuild)

```jsonc
// app.json
{
  "expo": {
    "plugins": [
      ["@rn-media/cast", {
        // Omit for the Default Media Receiver (zero-config).
        "receiverAppId": "ABCD1234",
        // Optional custom text for the iOS local-network prompt.
        "localNetworkUsageDescription": "…"
      }]
    ]
  }
}
```

The plugin applies everything below automatically, including the
app-ID-specific Bonjour string everyone gets wrong by hand.

### Bare React Native — paste by hand

**Android — `AndroidManifest.xml`**, inside `<application>`:

```xml
<!-- The Cast framework instantiates this provider reflectively. -->
<meta-data
  android:name="com.google.android.gms.cast.framework.OPTIONS_PROVIDER_CLASS_NAME"
  android:value="com.rnmediacast.RnMediaCastOptionsProvider" />
<!-- Optional: your receiver app id (omit for the Default Media Receiver). -->
<meta-data
  android:name="com.rnmediacast.RECEIVER_APPLICATION_ID"
  android:value="ABCD1234" />
<!-- Enables output-switcher stream transfer (Android 13+ system picker). -->
<receiver
  android:name="androidx.mediarouter.media.MediaTransferReceiver"
  android:exported="true" />
```

**iOS — `Info.plist`** (replace `CC1AD845` with your receiver app id if you
have one):

```xml
<key>NSBonjourServices</key>
<array>
  <string>_googlecast._tcp</string>
  <string>_CC1AD845._googlecast._tcp</string>
</array>
<key>NSLocalNetworkUsageDescription</key>
<string>$(PRODUCT_NAME) uses the local network to discover Cast-enabled
devices on your Wi-Fi network.</string>
```

**iOS — `Podfile`**: `platform :ios, '16.0'`.

## Use

```ts
import { Cast, canCastMedia } from '@rn-media/cast'

// Once, early (idempotent). Resolves 'unavailable' on GMS-less Android
// devices instead of crashing — render no cast UI in that case.
const state = await Cast.initialize()

// Discovery is battery-expensive: scope it to "picker open".
await Cast.startDiscovery()
const devices = await Cast.getCastDevices()
await Cast.requestSession(devices[0].id) // resolves when connected
await Cast.stopDiscovery()               // AFTER connecting — see below

// Hand the receiver a queue it advances by itself (phone may sleep).
await Cast.queueLoad(
  tracks.map((t) => ({
    source: {
      url: t.streamUrl,
      mimeType: 'audio/mp3',
      metadata: { title: t.title, artist: t.artist, artworkUrl: t.artUrl },
    },
    preloadTime: 10,
  })),
  { startIndex: 2, startPosition: 30 }
)

Cast.addListener('mediaStatus', (status) => {
  // A discontinuity broadcast — project position locally from
  // status.position; never poll.
})
Cast.addListener('error', (error) => {
  // error.code === 'cast-receiver-fetch': the RECEIVER could not fetch the
  // URL. Its network is not the phone's network.
})

await Cast.endSession({ transferBackToLocal: true })
```

**Ordering rule** (encoded natively as a safety net, but do it right anyway):
connect **after** the picker closes and **before** `stopDiscovery()` —
stopping discovery mid-handshake makes the route vanish under the session.

## The handoff — `wireCastHandoff`

The state machine from `docs/design/cast.md` §3, ready-made:

```
LOCAL → CONNECTING → HANDOFF_TO_CAST → CAST_ACTIVE → HANDOFF_TO_LOCAL → LOCAL
                     (pause local · snapshot queue · load receiver queue)
any → error → typed error + fall back to LOCAL at the last known position
```

```ts
import { wireCastHandoff } from '@rn-media/cast'

const handoff = wireCastHandoff(
  {
    // Structural — adapt YOUR player; nothing here imports @rn-media/player.
    play: () => player.play(),
    pause: () => player.pause(),
    seekTo: (s) => player.seekTo(s),
    skipToIndex: (i) => player.playlist.jumpTo(i, { autoPlay: false }),
    getPosition: () => player.getPosition(),
    isPlaying: () => player.state.playing,
  },
  {
    // One coherent read of YOUR queue at handoff time. Resolve signed /
    // logical URLs here — the receiver fetches them itself.
    snapshot: () => ({
      items: queue.map((t) => ({
        id: t.id,
        url: resolve(t),
        mimeType: t.mimeType,
        metadata: { title: t.title, artist: t.artist, artworkUrl: t.artUrl },
      })),
      index: currentIndex,
      position: player.getPosition(),
      playWhenReady: player.state.playing,
    }),
    // While cast-active this is the ONLY truthful source for your
    // playbackState/mediaItem broadcasts. `{position, at, rate}` is a
    // position anchor: project locally, never poll.
    onReceiverState: (s) => broadcastReceiverState(s),
    // One per direction per handoff — a position discontinuity.
    onTransfer: ({ direction, position, itemIndex }) => log(direction),
    // canCastMedia-filtered items, typed reasons. Never silent.
    onItemsSkipped: (skipped) => showSkipNotice(skipped),
    onError: (error) => {
      if (error.code === 'cast-receiver-fetch') {
        // The re-resolve-and-reload recipe for expired signed URLs: get a
        // fresh URL into your snapshot's `url`, then reload the projection.
        refreshSignedUrls().then(() => handoff.syncQueue())
      }
    },
  }
)

await handoff.castTo(devices[0].id)   // or let <CastButton/>/the system
                                      // output switcher start the session —
                                      // the same machine handles both.
await handoff.stopCasting()           // transfer back; { transferBackToLocal:
                                      // false } leaves the receiver playing.
handoff.syncQueue()                   // JS queue edited while casting
handoff.skipToNext()                  // receiver transport over the queue
                                      // mapping (skips non-castable items)
```

Contracts worth knowing:

- **The JS queue stays the source of truth.** The receiver queue is a
  castable *projection* of it; every receiver status is reconciled back to a
  JS index (`onReceiverState.itemIndex`, `receiverItemIndex`). Receiver-side
  advancement is on (`autoplay` per item) so the queue survives the phone
  sleeping; the receiver queue dying with the session is fine — it is rebuilt
  from the JS queue next time.
- **Position ownership is exclusive.** Local owns the clock until the
  `toCast` transfer; the receiver owns it until `toLocal`. Both transfers are
  discontinuities carrying `{position, itemIndex}`.
- A session that exists *before* wiring (framework resumption) is left
  alone — auto-casting over a receiver at app launch would be destructive;
  the next `castTo` reuses it.
- The pure reducer (`reduceCastHandoff`) and projection (`projectCastQueue`)
  are exported for tests and custom orchestration.

### Live streams (device-verified truths, 2026-08-14)

Mark live entries with `live: true` in the snapshot (and `CastMediaSource`) —
it sets `STREAM_TYPE_LIVE` on the receiver *and* changes what the handoff
does, because live position semantics are different in kind:

- **A live handoff joins the live edge.** The projection sends live start
  items with **no start position**. Measured on hardware: `queueLoad` with a
  nonzero `playPosition` against an unseekable live stream (Icecast) wedged
  the Default Media Receiver in BUFFERING at that offset *forever* — the
  "casting a live station loads forever" failure. There is nothing lost:
  mpv's clock on a live stream is a stream-timeline offset (an HLS master
  reported ~95 000 s), never a resumable position.
- **A live transfer-back never seeks the local player.** The receiver's live
  clock is that same timeline offset; the `restoreLocal` contract carries
  `live` and the wire skips the seek (mpv would reject it: `Cannot seek in
  this stream`). Reopening at the live edge IS the resume for live audio.
- **Resolve playlist redirects before the handoff.** The Default Media
  Receiver never started playback for an HLS playlist URL answering with a
  302 (the redirect *target* played immediately; mpv follows redirects fine —
  the asymmetry is the receiver's). Resolve the final URL at the same seam
  where you resolve signed URLs, sender-side.
- **What live casting does *not* need** (the usual suspects, ruled out on the
  receiver directly): `audio/aacp` plays a Shoutcast stream as-is, and
  `application/x-mpegurl` plays audio-only HLS with TS/AAC segments without
  any `hlsSegmentFormat` hint.

### Which tracks can cast — `canCastMedia`

Receivers decode far less than mpv does. Grey the cast route out per track
instead of failing at load:

```ts
const verdict = canCastMedia({ url, mimeType, headers })
// { castable: false, reason: 'codec' | 'local-file' | 'headers' }
```

### Cast button

This phase ships the headless API; a native `<CastButton/>` view component
follows with device verification (Phase 4). The recipe:

```tsx
// Opens the GCK dialog on iOS, the route chooser on Android. On Android 13+
// the SYSTEM output switcher is additionally reachable from the media
// notification (and from any CastButtonFactory-wired cast icon — the
// library's CastOptions already opt in).
<Pressable onPress={() => Cast.requestSession()}>
  <CastIcon />
</Pressable>
```

Hide the button entirely while `Cast.getCastState() === 'unavailable'`.

## Honest ceilings (read before shipping)

- **Receiver codec ceiling** — receivers decode HE-/LC-AAC, MP3, FLAC (≤
  96 kHz/24-bit), Opus, Vorbis, WAV, WebM audio
  ([developers.google.com/cast/docs/media](https://developers.google.com/cast/docs/media)).
  **Not castable**: ALAC, hi-res FLAC > 96 kHz, WMA, APE, WavPack, TTA, DSD,
  AIFF, `.mka`, AC-3/DTS-as-audio, tracker formats. mpv plays them; Cast
  receivers do not. `canCastMedia()` exists for exactly this.
- **The receiver fetches the URL itself.** `file://`/`content://` sources
  cannot cast (no local HTTP server in v1 — a deliberate, documented
  decision). Per-source **auth headers do not travel**: the Default Media
  Receiver cannot attach them. Signed-query URLs work; header-auth needs your
  own custom Web Receiver plus the `credentials` passthrough on
  `load`/`queueLoad`.
- **iOS**: deployment floor 16.0; the local-network permission prompt appears
  on the *first cast-button use*, never before (OS rule); the lock screen
  stays dormant during a cast session (the phone plays no audio — an OS
  ceiling shared by every cast app; Google's own checklist marks lock-screen
  controls "Android only"); hardware volume buttons cannot drive receiver
  volume on iOS 15+ — use `setDeviceVolume()`.
- **iOS init timing**: Google recommends initializing the Cast context in
  `didFinishLaunching` so a session survives process death.
  `Cast.initialize()` from JS is later than that; automatic *post-process-
  death* session resumption may be missed until the first initialize of a
  launch.
- **Android**: no Google Play services → `initialize()` resolves
  `'unavailable'` (typed capability answer, never a crash). Full
  output-switcher behaviour needs Android 13+.
- **Gapless does not survive the handoff**: receiver queues pre-buffer
  (`preloadTime`), they do not promise sample-accurate gapless.
- **Receiver app id**: zero-config default is Google's Default Media Receiver.
  A styled/custom receiver requires a [Cast Developer
  Console](https://cast.google.com/publish) registration (one-time $5) — and
  is the only path to receiver-side header auth.
- **Volume has two layers**: *device* volume (primary — what users mean) and
  *stream* volume (secondary, app-level). Prefer `setDeviceVolume()`.
- The [Cast Design Checklist](https://developers.google.com/cast/docs/design_checklist)
  binds your app (cast icon placement, user-initiated casting only).

## Version pins

| SDK | Version | Verified against |
| --- | --- | --- |
| `com.google.android.gms:play-services-cast-framework` | 22.3.1 | Google Maven group index, 2026-08-13 |
| `google-cast-sdk` (CocoaPods) | 4.8.6 | CocoaPods trunk, 2026-08-13 |

Pinned exactly on purpose (Google's iOS 4.8.0/4.8.1 broke discovery);
`scripts/check-upstream.mjs` watches both rows so a lag is loud, not silent.
