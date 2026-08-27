# Cast design — Chromecast as a first-class, cross-platform surface

**Status: DESIGN — awaiting owner sign-off. Nothing here is implemented.**
Research verified 2026-08-13 against primary sources (Google Maven group index,
CocoaPods trunk, developers.google.com/cast, developer.android.com, Apple docs,
androidx/media sources, npm/GitHub/pub.dev registries). Version pins below are
what was current on that date; re-verify before implementation (currency rule).

## 0. Why the old deferral is dead

PLAN's casting deferral said "media3 CastPlayer abandons our engine and
AirPlay-from-mpv does not exist — fails the parity gate." Both halves are now
insufficient:

- Casting is a **URL handoff**, not an output route. The sender hands the
  receiver a URL; the receiver fetches and decodes it itself; mpv simply goes
  silent for the session. The engine is not abandoned — it is *paused*, and it
  resumes at the receiver's position on transfer-back. (mpv-based players can
  never cast as an *output* — the media_kit maintainer is on record that
  OS-level casting hooks never see mpv's pipeline. That is an argument **for**
  the handoff model, not against casting.)
- The **Google Cast sender SDK is first-party on both platforms** — Android
  `play-services-cast-framework` 22.3.1 (2026-04-07, minSdk 23) and iOS
  `google-cast-sdk` 4.8.6 (2026-07-29, min iOS 16). Chromecast-on-both passes
  the parity gate. AirPlay remains honestly out of scope (no sender SDK exists
  for third-party engines; the paid competitor that "has cast" ships it
  platform-split — Chromecast on Android only, AirPlay on iOS only — which is
  exactly the compromise our gate rejects).

## 1. The four load-bearing research findings

1. **Android's system output switcher can be the picker.** Requirements
   (developers.google.com/cast/docs/android_sender/output_switcher):
   `MediaTransferReceiver` in the manifest, cast-framework ≥ 21.2, a real media
   notification (we have one), `CastOptions.setRemoteToLocalEnabled(true)`.
   None of it requires ExoPlayer. Since Cast 22.3.0 the in-app cast button can
   *open* the system switcher (Android 13+) — Google is converging pickers.
2. **media3 1.11.0 made the local↔remote hybrid first-class**:
   `CastPlayer.Builder().setLocalPlayer(Player)` accepts any `Player` (our
   `BroadcastPlayer` qualifies), with `transferState(source, target)` moving
   queue/position across. Google's own cast demo does the player-swap. This is
   *a* native path — §3 explains why we take its integration points but not its
   wrapper.
3. **iOS has no system cast picker and won't soon**: iOS 16's
   DeviceDiscoveryExtension hook could put Cast devices in the AirPlay picker,
   but Google has never shipped a DDE (checked through SDK 4.8.6). iOS
   best-native = `GCKUICastButton` (or a custom sheet over
   `GCKDiscoveryManager`). While casting, the phone plays no audio, so the iOS
   lock screen shows nothing — Google's own design checklist marks lock-screen
   controls "Android only". That is an OS ceiling shared by every cast app, and
   we document it rather than shipping the silent-audio hack.
4. **The ecosystem seam is real.** react-native-google-cast: v4 is old-bridge
   (broken cases on new arch); the original maintainer is actively rewriting v5
   on **Nitro Modules** (new-arch only, RN 0.78+, session-state-machine core,
   ~7/8 phases done as of 2026-08-09) but **nothing is published**. RNTP's cast
   is paid *and* platform-split. Flutter's flagship audio ecosystem has left
   cast unsolved since 2020. Nobody ships what our architecture is already
   shaped for: local↔remote handoff integrated with a queue, a session layer,
   and position projection.

## 2. Decision: first-party sender binding, audio-scoped

**Recommendation: build `@timbre/cast` first-party** — a Kotlin/Swift Nitro
HybridObject pair (the audio-session package pattern; there is no C API, so
this is not a pure-C++ binding) over the official sender SDKs, scoped to what
an audio library needs. Do **not** wrap RNGC v4 (old bridge). Track RNGC v5
with respect — same binding layer, same architecture instincts — but do not
gate our roadmap on an unpublished single-maintainer rewrite; if it ships and
matures, a compatibility adapter is cheap because both sides are Nitro.

Why first-party clears the "nothing half-baked" bar: the hard 20% of cast is
not the SDK binding (session lifecycle, transport, metadata are "easy" —
research verdict); it is the **handoff state machine, queue reconciliation,
FGS behavior during remote playback, and the honest error taxonomy** — all of
which live in *our* media-session layer no matter whose binding we use. Owning
the thin binding too means one design, one test surface, one currency watcher.

## 3. Architecture: one state machine, both platforms; the switcher as a bonus

Cast is **a second, remote player behind the existing fan-in/fan-out
contract** — not an mpv output, and not a media3-internal detail.

- The JS queue stays the single source of truth (existing rule). During a cast
  session the app's controller broadcasts the **receiver's** state through the
  same three channels (`playbackState`, `mediaItem`, `queue`) that already
  feed every surface. The Android notification, the app UI, and (on Android)
  the lock screen keep working unchanged, now mirroring the receiver. Zero new
  fan-out paths.
- Position: the receiver model already matches ours — no platform streams
  position; both expose status updates + an approximate-position read. A cast
  status update is a discontinuity broadcast; clients project locally.
  Transfers are discontinuities too.
- **Why not media3-cast's `CastPlayer` wrapper as the Android core**: it would
  put the handoff logic inside media3 on Android while iOS (no media3) needs
  our own state machine anyway — two architectures to keep in parity, plus
  `transferState` would have to write *into* `BroadcastPlayer`, which is a
  broadcast facade, not a stateful player (sharp edge flagged in research:
  medium confidence, needs device proof). The output-switcher integration is
  **Cast-SDK-level (SessionManager), not media3-level**, so declining the
  wrapper costs us nothing there: `MediaTransferReceiver` + our
  `SessionManagerListener`/`SessionTransferCallback` in the service still
  light up the switcher and stream transfer. media3-cast stays a watched
  option; `CastParams` is `@UnstableApi` today anyway.

### The handoff state machine (media-session owns it, platform-agnostic)

```
LOCAL --requestSession()/switcher-pick--> CONNECTING
CONNECTING --sessionStarted--> HANDOFF_TO_CAST
    (pause mpv · snapshot {queue, index, position, playWhenReady} ·
     load receiver queue at index/position)
HANDOFF_TO_CAST --receiver playing--> CAST_ACTIVE
CAST_ACTIVE --endSession()/switcher "this phone"/receiver died--> HANDOFF_TO_LOCAL
    (snapshot receiver position · mpv load+seek · resume per playWhenReady)
HANDOFF_TO_LOCAL --> LOCAL
any --error--> typed error + fall back to LOCAL at last known position
```

Hard-won ordering rule baked in: connect **after** the picker closes but
**before** stopping discovery, or MediaRouter drops the route mid-handshake.

### Queue: receiver-side, reconciled

Use the receiver queue (`MediaQueueItem` autoplay + `preloadTime`) so
advancement survives the phone sleeping/dying — the right default for audio.
The JS queue remains authoritative: receiver `mediaStatus` updates are
reconciled against it (item edits are RPCs; the sender-side `MediaQueue`
mirror is sparse/async — reconcile lazily, never chattily). Receiver queue
death-with-session is fine: the JS queue rebuilds it on the next session.

### TS surface (identical both platforms)

```ts
castState: 'unavailable' | 'idle' | 'connecting' | 'connected' | 'transferring'
device: { id, name, model } | null
getCastDevices() / requestSession(deviceId?) / endSession({ transferBackToLocal })
canCastMedia(item): { castable: boolean; reason?: 'codec' | 'local-file' | 'headers' }
events: castStateChanged, castTransfer({ direction, position, itemIndex })
MediaItem.castSource?: { url, mimeType, credentials? }   // handoff contract
<CastButton/>  (GCKUICastButton on iOS; opens system switcher on Android 13+)
```

`'unavailable'` is a first-class state: on GMS-less Android the framework is a
dynamite module loaded from Play services at runtime — absence must be a typed
capability answer, never a crash.

## 4. Honest ceilings (user-facing documentation, not fine print)

- **Receiver codec ceiling** (developers.google.com/cast/docs/media): receivers
  decode HE-/LC-AAC, MP3, FLAC ≤ 96 kHz/24-bit, Opus, Vorbis, WAV, WebM audio.
  mpv plays more. Not castable: ALAC, hi-res FLAC > 96 kHz, WMA, APE, WavPack,
  TTA, DSD, AIFF, .mka, AC-3/DTS-as-audio, tracker formats. `canCastMedia()`
  exists so apps grey the route out per track instead of failing at load.
- **The receiver fetches the URL itself**: `file://` cannot cast (an embedded
  HTTP server is a possible later opt-in — separate decision); per-source auth
  **headers do not travel** (Default Media Receiver cannot attach headers —
  signed-query URLs work; header-auth needs the app to register a custom Web
  Receiver; `credentials` passthrough is exposed for that path).
- **iOS**: pod floor iOS 16 (RN default target is 15.1 — consumer bump,
  documented + config-plugin assisted); local-network permission prompts on
  first cast-button tap, never before (OS rule); lock screen dormant during a
  session; hardware volume buttons cannot drive receiver volume on iOS 15+.
- **Android**: no Play services → no cast (typed `unavailable`); full output-
  switcher behavior on Android 13+.
- **Setup that cannot be hidden**: receiver app ID (zero-config default = the
  Default Media Receiver; styled/custom needs the $5 Cast Console), iOS plist
  entries (`NSBonjourServices` includes an app-ID-specific string — generated
  by our expo plugin from props), the Cast Design Checklist obligations that
  bind the app (cast icon placement, user-initiated casting only).
- **Gapless does not survive the handoff**: receiver queues pre-buffer
  (`preloadTime`), they do not promise sample-accurate gapless.

## 5. Failure-mode checklist (from the ecosystem's issue trackers — acceptance criteria)

1. Discovery-finds-nothing: exact plist strings validated by the plugin; docs
   state emulator/simulator behavior; SDK-version pin discipline (Google's own
   4.8.0/4.8.1 broke discovery — the currency watcher gets cast SDK rows).
2. Backgrounding: the OS may freeze a sender that no longer plays audio — the
   FGS/media-session keep-alive needs an explicit **remote-playback mode**
   (Android: the media notification stays because our session mirrors the
   receiver; iOS: `suspendSessionsWhenBackgrounded=false` + documented limits).
3. Session races/use-after-free: one native session-state machine; every JS
   surface reads snapshots from broadcasts; late subscribers get a fresh
   status snapshot.
4. Receiver-fetch failures are their own error family in the taxonomy
   (`cast-receiver-fetch`, distinct from local network errors), because the
   phone's connectivity is not the receiver's.
5. Signed-URL expiry mid-session: re-resolve → reload at position, wired
   through the existing source-resolver seam.
6. Metadata loss across the handoff: the `MediaItem` → Cast `MediaMetadata`
   projection names every field it forwards (the artwork-regression rule).

## 6. Phasing

1. **Design sign-off** (this document) — owner decision points: first-party vs
   wait-for-RNGC-v5; receiver-queue vs phone-driven advancement (recommended:
   receiver-queue); local-file HTTP server in/out of v1 (recommended: out,
   documented).
2. **`@timbre/cast` package**: Nitro Kotlin/Swift binding — context init
   (main-thread trampolined, Task-based Android init, typed availability),
   discovery, session manager, RemoteMediaClient + queue ops, events; expo
   plugin (clone of media-session's run-once pattern: receiver app ID →
   Android meta-data + iOS plist/Bonjour strings + optional AppDelegate init).
3. **media-session integration**: the handoff state machine, `castTransfer`
   discontinuity events, remote-playback FGS mode, `MediaTransferReceiver` +
   `SessionTransferCallback` (output switcher, both directions), receiver-queue
   reconciliation against the `queue` channel.
4. **Example app + device verification**: real Chromecast hardware required
   (owner: which receiver devices are available?); the checklist in §5 is the
   test plan; parity run on iOS via CI + a macOS device session.
5. **Docs + scoreboard**: README row (`Chromecast (both platforms)` vs RNTP
   V5's split), the ceilings in §4 as a user-facing page, PLAN/ARCHITECTURE
   verdict update in the same commit (decision-change rule).

## 7. Standing maintenance hooks

- check-upstream.mjs gains rows: `play-services-cast-framework` (Google Maven),
  `google-cast-sdk` (CocoaPods trunk), and — watch item — RNGC v5's npm
  dist-tags (if `5.x` publishes and matures, evaluate a compatibility adapter).
- iOS DDE watch: if Google ever ships a DeviceDiscoveryExtension, iOS gains a
  system-picker path overnight; revisit §3's iOS picker section.
