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
position when you transfer back. This package is the binding layer (Phase 2 of
`docs/design/cast.md`); the automatic local↔remote handoff state machine lands
in `@rn-media/media-session` (Phase 3).

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
