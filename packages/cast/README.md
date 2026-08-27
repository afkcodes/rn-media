# @rn-media/cast

First-party Google Cast **sender** binding for React Native, audio-scoped, built
directly on the official SDKs
([play-services-cast-framework](https://developers.google.com/cast/docs/android_sender)
on Android, [google-cast-sdk](https://developers.google.com/cast/docs/ios_sender)
on iOS) as a Nitro Kotlin/Swift module. Chromecast on **both** platforms — no
platform-split feature.

Casting is a **URL handoff**, not an output route: the sender hands the receiver
a URL and the receiver fetches, decodes and plays it. Your local player goes
silent for the session and resumes at the receiver's position when you transfer
back. This package ships both layers — the binding, and the automatic
local↔remote handoff state machine `wireCastHandoff`, which lives here rather
than in `@rn-media/media-session` and talks to your player and queue through
structural interfaces, so it works with any player
([ARCHITECTURE §25](../../ARCHITECTURE.md#25-casting-is-a-url-handoff-behind-the-existing-fan-out--and-the-handoff-lives-in-rn-mediacast-not-media-session)).

## Requirements

| | |
|---|---|
| iOS runtime floor | **16.0** — the `google-cast-sdk` pod's own floor. Installing this package raises your app's deployment target, and devices on iOS 15 and older will not be able to install it. The Expo plugin bumps `ios.deploymentTarget` for you; bare projects set `platform :ios, '16.0'` in the Podfile |
| iOS toolchain | **Xcode 26 or newer**. `google-cast-sdk` 4.8.6 ships a *static* `GoogleCast.xcframework` built against the iOS 26.2 SDK, and one of its objects references `UIGlassEffect`. React Native's `-ObjC` linker flag force-loads every object out of every static archive, so that reference cannot be dead-stripped and Xcode 16.x fails at link time on `_OBJC_CLASS_$_UIGlassEffect`. Your app's runtime floor is unaffected |
| Android | Google Play services. Without it `Cast.initialize()` resolves `'unavailable'` — a typed capability answer, never a crash. Full output-switcher behaviour needs Android 13+ |

## Install

```sh
npm install @rn-media/cast react-native-nitro-modules
```

### Expo (prebuild)

The plugin applies everything below, including the app-ID-specific Bonjour
string.

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

### Bare React Native

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

**iOS — `Info.plist`** (replace `CC1AD845` with your receiver app id if you have
one), plus `platform :ios, '16.0'` in the Podfile:

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

## Use

```ts
import { Cast } from '@rn-media/cast'

// Once, early (idempotent).
const state = await Cast.initialize()

// Discovery is battery-expensive: scope it to "picker open".
await Cast.startDiscovery()
const [device] = await Cast.getCastDevices()
if (device !== undefined) await Cast.requestSession(device.id) // resolves when connected
await Cast.stopDiscovery()               // AFTER connecting

// Hand the receiver a queue it advances by itself (the phone may sleep).
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

Cast.addListener('mediaStatus', () => { /* a discontinuity — project, never poll */ })
Cast.addListener('error', (error) => {
  // 'cast-receiver-fetch': the RECEIVER could not fetch the URL. Its network is
  // not the phone's network.
})

await Cast.endSession({ transferBackToLocal: true })
```

Connect **after** the picker closes and **before** `stopDiscovery()`; stopping
discovery mid-handshake makes the route vanish under the session. The rule is
also enforced natively as a safety net.

## API

| | what it does | notes |
|---|---|---|
| `Cast.initialize(options?): Promise<CastConnectionState>` | Idempotent; call once, early | Resolves `'unavailable'` on a Play-services-less Android device, never a crash. Google recommends initializing in `didFinishLaunching`, so post-process-death session resumption on iOS may be missed until the first `initialize()` of a launch |
| `Cast.getCastState(): CastConnectionState` | `'unavailable' \| 'idle' \| 'connecting' \| 'connected' \| 'transferring'` | Synchronous |
| `Cast.startDiscovery()` / `stopDiscovery()` | Scope them to "picker open" — discovery is battery-expensive | Stop **after** connecting |
| `Cast.getCastDevices(): Promise<readonly CastDeviceInfo[]>` | | |
| `Cast.requestSession(deviceId?)` / `endSession(options?)` | | `endSession({ transferBackToLocal })`. With no id on iOS the call always resolves, because `presentCastDialog` returns `void`; watch the `castState` / `session` events for the outcome |
| `Cast.load(source, options?)` / `queueLoad(items, options?)` | Hand the receiver a URL, or a queue it advances by itself | |
| `Cast.queueInsert` / `queueRemove` / `queueReorder` / `queueJumpTo` / `queueSetRepeatMode` / `getQueueItemIds` / `fetchQueueSlice` | Receiver-side queue editing | |
| `Cast.play()` / `pause()` / `stop()` / `seek(position, resumeState?)` / `getApproximatePosition()` | Receiver transport | |
| `Cast.setDeviceVolume` / `setDeviceMuted` / `getDeviceVolume` / `setStreamVolume` / `setStreamMuted` | *Device* volume is what users mean; stream volume is app-level | Prefer `setDeviceVolume()` |
| `Cast.addListener(event, fn): Unsubscribe` | `castState`, `session`, `devices`, `mediaStatus`, `error`, `queueChanged`, `deviceVolume` | `mediaStatus` is a discontinuity broadcast — project position, never poll |
| `wireCastHandoff(local, options): CastHandoff` | The whole local↔remote state machine | Returns `{ phase, receiverItemIndex, castTo, stopCasting, syncQueue, skipToItem, skipToNext, skipToPrevious, dispose }` |
| `useCastState()` / `useIsCasting()` | Live connection state as React state | Seeded synchronously from `getCastState()`, so the first paint is right; no polling. `useIsCasting` holds the boolean, so `idle → connecting` does not re-render |
| `isCastingState(state): boolean` | The one definition of "casting", for non-React callers | `'connected'` or `'transferring'`. A `'transferring'` session is a receiver-to-receiver stream transfer: the phone is still not the output, so treating it as "not casting" would flicker the UI back to local controls mid-transfer |
| `canCastMedia(item): CanCastVerdict` | `{ castable: false, reason: 'codec' \| 'local-file' \| 'headers' }` | Grey the route out per track instead of failing at load |
| `<CastButton style? tintColor? />` | The platform's own button as a native view | Hides itself while cast is unavailable |
| `CastError` | `code` is the thing to branch on | `statusCode` and the receiver's reason string are Android-only |

`wireCastHandoff`'s `options` are `{ snapshot, cast?, onPhaseChange?, onTransfer?,
onReceiverState?, onItemsSkipped?, onError?, now?, handoffTimeoutMs? }`; the local
player is `{ play, pause, seekTo, skipToIndex, getPosition, isPlaying }`.

## The handoff — `wireCastHandoff`

```
LOCAL → CONNECTING → HANDOFF_TO_CAST → CAST_ACTIVE → HANDOFF_TO_LOCAL → LOCAL
                     (pause local · snapshot queue · load receiver queue)
any → error → typed error + fall back to LOCAL at the last known position
```

A [worked example](../../docs/recipes/cast.md) wires it to a player and the
media-session channels.

| Contract | Detail |
|---|---|
| The JS queue stays the source of truth | The receiver queue is a castable *projection* of it, and every receiver status is reconciled back to a JS index (`onReceiverState.itemIndex`, `receiverItemIndex`). Receiver-side advancement is on, so the queue survives the phone sleeping; the receiver queue dying with the session is fine, because it is rebuilt next time |
| Position ownership is exclusive | Local owns the clock until the `toCast` transfer, the receiver until `toLocal`. Both transfers are discontinuities carrying `{ position, itemIndex }` |
| A session that exists *before* wiring is left alone | Auto-casting over a receiver at app launch would be destructive; the next `castTo` reuses it |
| `stopCasting({ transferBackToLocal: false })` does **not** keep the receiver playing | It disconnects, and the receiver stops anyway — see the ceilings below |
| A live handoff joins the live edge | Mark live entries with `live: true`. The projection sends live start items with **no start position**: a nonzero `playPosition` against an unseekable live stream wedges the Default Media Receiver in BUFFERING at that offset forever. Nothing is lost, because a live clock is a stream-timeline offset, not a resumable position |
| A live transfer-back never seeks the local player | The `restoreLocal` contract carries `live` and the wire skips the seek, which mpv would reject. Reopening at the live edge *is* the resume for live audio |
| Resolve playlist redirects before the handoff | The Default Media Receiver never starts playback for an HLS playlist URL answering with a 302, though the redirect target plays immediately. Resolve the final URL at the same seam where you resolve signed URLs, sender-side |
| Live casting needs no special hints | `audio/aacp` plays a Shoutcast stream as-is, and `application/x-mpegurl` plays audio-only HLS with TS/AAC segments without any `hlsSegmentFormat` |
| `reduceCastHandoff` and `projectCastQueue` are exported | The pure state machine and projection, for tests and custom orchestration |

`onError` with `code === 'cast-receiver-fetch'` is where expired signed URLs are
handled: refresh them into your snapshot's `url`, then call `handoff.syncQueue()`.

## `<CastButton/>`

A real native view — an `androidx.mediarouter.app.MediaRouteButton` handed to
`CastButtonFactory.setUpMediaRouteButton` on Android, a `GCKUICastButton` on iOS
([ARCHITECTURE](../../ARCHITECTURE.md#castbutton-is-a-real-native-view-because-the-switcher-is-unreachable-otherwise)).

| Behaviour | Detail |
|---|---|
| Android 13+ opens the **system output switcher** | The same sheet the volume rocker and the media notification open. That wiring is the only thing that honours `setShowSystemOutputSwitcherOnCastIconClick(true)`, which this package's `CastOptions` sets. Below 13, or without `MediaTransferReceiver`, it falls back to the in-app `MediaRouteChooserDialog` |
| iOS opens the SDK's own device dialog | Discovery starts on the first tap by SDK design, which is what makes the local-network prompt appear when the user asked for devices rather than at launch |
| It hides itself while cast is unavailable | Before `Cast.initialize()` resolves, and forever on a Play-services-less Android device. That is the Cast Design Checklist's own rule — do not re-implement it |
| It has no intrinsic size | A Nitro view's shadow node has no measure function, so the button is exactly as big as `style` says and defaults to 40×40. The icon is drawn centred at the platform's own size and never scaled |
| `tintColor` is honoured on both platforms | iOS sets the button's `tintColor`; Android recolours the drawn icon, because `MediaRouteButton` reads its tint from a theme attribute once at construction. Both keep Google's own icon and its connecting animation |
| A tap starts an ordinary cast session | A wired `wireCastHandoff` picks it up exactly as if you had called `handoff.castTo(id)` |

The headless path is fully supported for apps that want their own picker —
`startDiscovery()` + `getCastDevices()` + `requestSession(id)`, or
`Cast.requestSession()` for the SDK picker without the view. It just does not get
the system output switcher.

## Platform parity

Everything works the same on both platforms **except** the rows below.

| Member | Android | iOS | Why |
|---|---|---|---|
| Hardware volume buttons drive receiver volume | the framework routes the keys for a connected session | **no** | Google's own guide says the behaviour is "currently not supported for iOS 15+", so this package leaves the switch off rather than shipping one that does nothing. Use `setDeviceVolume()` |
| `error.statusCode` and the receiver's reason string on a media error | present | **absent** | GoogleCast 4.8.6 has no media-error callback at all, so the iOS half synthesizes the failure from `playerState == .idle && idleReason == .error`. Branch on `error.code`, never on `statusCode` being present |
| Changing the receiver app id after the first `initialize()` | honoured | logged and ignored | `GCKCastContext` exposes only `+setSharedInstanceWithOptions:`, with no way to swap the live discovery criteria. Pass the id on the first call, or through the Expo plugin |
| `'transferring'` state, the `transferring` / `transferred` / `transferFailed` session events | from the system output switcher | **never fire** | iOS has no such surface. `startFailed` covers a failed session *start* on both; a failed session *resume* only on Android, because 4.8.6 has no resume-failure callback |
| Lock-screen controls during a session | drawn | **none** | The phone plays no audio — an OS ceiling shared by every cast app, and Google's own checklist marks lock-screen controls Android-only |

## Ceilings

- **Receiver codec ceiling.** Receivers decode HE-/LC-AAC, MP3, FLAC (≤ 96 kHz /
  24-bit), Opus, Vorbis, WAV and WebM audio
  ([reference](https://developers.google.com/cast/docs/media)). Not castable:
  ALAC, hi-res FLAC above 96 kHz, WMA, APE, WavPack, TTA, DSD, AIFF, `.mka`,
  AC-3/DTS-as-audio, tracker formats. `canCastMedia()` exists for exactly this.
- **The receiver fetches the URL itself.** `file://` and `content://` sources
  cannot cast — there is no local HTTP server in v1. Per-source auth headers do
  not travel either, because the Default Media Receiver cannot attach them:
  signed-query URLs work, header auth needs your own Web Receiver plus the
  `credentials` passthrough on `load`/`queueLoad`.
- **The iOS local-network prompt appears on the first cast-button use**, never
  before. That is an OS rule.
- **Leaving the receiver playing is not possible from a lone sender.**
  `endSession({ transferBackToLocal: false })` disconnects without resuming
  locally, but the receiver stops anyway — the iOS SDK documents that
  `endSessionAndStopCasting:` "only applies when multiple sender devices are
  connected".
- **Gapless does not survive the handoff.** Receiver queues pre-buffer
  (`preloadTime`); they do not promise sample-accurate gapless.
- **Receiver app id.** The zero-config default is Google's Default Media
  Receiver. A styled or custom receiver needs a [Cast Developer
  Console](https://cast.google.com/publish) registration, and is the only path to
  receiver-side header auth.
- **Volume has two layers**: *device* volume (what users mean) and *stream*
  volume (app-level). Prefer `setDeviceVolume()`.
- The [Cast Design Checklist](https://developers.google.com/cast/docs/design_checklist)
  binds your app: cast icon placement, user-initiated casting only.

## Version pins

| SDK | Version |
| --- | --- |
| `com.google.android.gms:play-services-cast-framework` | 22.3.1 |
| `google-cast-sdk` (CocoaPods) | 4.8.6 |

Pinned exactly on purpose — an earlier iOS 4.8.x release broke discovery — and
`scripts/check-upstream.mjs` watches both rows so a lag is loud, not silent.

## Also exported

| Group | Exports |
|---|---|
| Options | `CastInitOptions` — `{ receiverApplicationId? }`; `CastLoadOptions` — `{ autoplay?, startPosition?, playbackRate? }`; `CastQueueLoadOptions` — `{ startIndex?, startPosition?, repeatMode?, credentials?, credentialsType? }`; `EndSessionOptions`; `CastRepeatMode` |
| Media | `CastMediaMetadata` — `{ title?, artist?, albumTitle?, artworkUrl? }`; `CastQueueItemInput`, `CastQueueItemSnapshot`, `SkippedCastItem`, `CanCastInput` |
| Errors | `CastErrorCode`, `CastIdleReason`, `errorFromIdleReason`, `receiverFetchError`, `toCastError` |
| Events and status | `CastEventMap`, `CastEventName`, `CastStateEvent`, `CastSessionEvent`, `CastSessionEventType`, `CastMediaStatus`, `CastPlayerState`, `CastDeviceVolume`, `CastTransferEvent`, `CastSeekResumeState` |
| Handoff internals | `CastHandoffState`, `CastHandoffPhase`, `CastHandoffEvent`, `CastHandoffEffect`, `CastHandoffTransition`, `CastHandoffQueueSnapshot`, `CastHandoffQueueItem`, `CastHandoffLocalPlayer`, `CastReceiverSnapshot`, `WireCastHandoffOptions`, `initialCastHandoffState`, `projectReceiverPosition`, `CastQueueProjection`, `castabilityTables` — the pure state machine `wireCastHandoff` runs, exported for tests and custom hosts |
| Components | `CastButtonProps`; the native pair `RnMediaCast`, `RnMediaCastButton`, `RnMediaCastButtonProps` |
| Native events | `CastApi` (the typed surface `Cast` implements) and the raw `NativeCastStateEvent`, `NativeCastSessionEvent`, `NativeCastDevicesEvent`, `NativeCastMediaStatusEvent`, `NativeCastMediaErrorEvent`, `NativeDeviceVolumeEvent` the JS layer normalises — not API |
| Factory and source shape | `createCast` (the factory `Cast` wraps), `CastMediaSource` |
