# Spec — Android Auto + CarPlay browse (architect contract, 2026-08-26)

Owner-approved roadmap #2 (PLAN.md): "Android Auto (flagship next feature) +
CarPlay-symmetric API design. Browse tree over the existing media3
`MediaLibraryService` … CarPlay half implemented when Apple hardware exists."

Parity is a GATE (CLAUDE.md): one JS handler, one item type, both platforms.
Every claim below is source-verified; the citation is the line that follows it.

---

## 0. The facts this design stands on

| # | Fact | Source |
|---|------|--------|
| F1 | Android Auto is a **legacy `MediaBrowserCompat` client**. Its tap on a playable item arrives as `onPlayFromMediaId` → `handleMediaRequest` → `dispatchSessionTaskWithPlayerCommand(COMMAND_SET_MEDIA_ITEM, …)` → `MediaSession.Callback.onSetMediaItems` with `MediaItem(mediaId)` only. Voice arrives the same way with `requestMetadata.searchQuery` (`onPlayFromSearch`). | media3 1.11.0 `MediaSessionLegacyStub.java` |
| F2 | media3 classifies controllers: `isAutoCompanionController` = `com.google.android.projection.gearhead`; `isAutomotiveController` = `com.android.car.media` / `com.android.car.carlauncher`; `ControllerInfo.isTrusted()` = system apps / permission holders / enabled notification listeners. "Not a security validation." | `MediaSessionImpl.java`, `MediaSession.java` |
| F3 | Legacy browsers get **no paging**: `onGetChildren(page=0, pageSize=Integer.MAX_VALUE)`. Google: "don't rely on the page or pageSize parameters." Results are `truncateListBySize(TRANSACTION_SIZE_LIMIT_IN_BYTES)`. | `MediaLibraryServiceLegacyStub.java`; developer.android.com/training/cars/media/create-media-browser/content-hierarchy |
| F4 | Root: "expect this number to be **four**"; supported flags `FLAG_BROWSABLE` only — playable items cannot be root tabs. | content-hierarchy page |
| F5 | Artwork for browse items: **only** `content://` or `android.resource://`. HTTPS must go through a `ContentProvider`. `setIconBitmap` banned (AAOS-unsupported; 1 MB binder limit). | …/create-media-browser/media-artwork |
| F6 | Legacy stub converts `artworkUri → setIconUri`; decodes `artworkData` via the session `BitmapLoader` only when present. | `MediaLibraryServiceLegacyStub.java`, `LegacyConversions.java` |
| F7 | `LibraryResult` errors are replicated to the platform playback state for legacy browsers — **only** `ERROR_SESSION_AUTHENTICATION_EXPIRED` and `ERROR_SESSION_PARENTAL_CONTROL_RESTRICTED` (`MediaLibrarySessionImpl.isReplicationErrorCode`, 1.11.0 — the architect's first draft said PREMIUM_ACCOUNT_REQUIRED from a summarised javadoc; Lane A corrected it from source); default `LIBRARY_ERROR_REPLICATION_MODE_NON_FATAL` (since 1.9.0); `onGetLibraryRoot` exempt. Resolution button: extras `android.media.extras.ERROR_RESOLUTION_ACTION_LABEL` / `_INTENT` (`PendingIntent`). | `MediaLibraryService.java`; RELEASENOTES 1.9.0; legacy `MediaConstants` values |
| F8 | Root extras reach the browser: `convertToRootHints(params)` copies `params.extras`, then the stub adds `android.media.browse.SEARCH_SUPPORTED` = whether `COMMAND_CODE_LIBRARY_SEARCH` is available to that browser. Content-style keys are `android.media.browse.CONTENT_STYLE_{BROWSABLE,PLAYABLE,SINGLE_ITEM}_HINT` (values 1 list, 2 grid, 3 category-list, 4 category-grid), group `…CONTENT_STYLE_GROUP_TITLE_HINT`. media3 re-exports these as `androidx.media3.session.MediaConstants.EXTRAS_KEY_CONTENT_STYLE_*` (public); `androidx.media3.session.legacy.MediaConstants` is `@RestrictTo(LIBRARY)` — never import it. | `LegacyConversions.java`, `MediaLibraryServiceLegacyStub.java`, both `MediaConstants.java` |
| F9 | Search: `onSearch` must later call `notifySearchResultChanged`; the stub then calls `onGetSearchResult(page 0, MAX_VALUE)`. | `MediaLibraryService.java`, legacy stub |
| F10 | Nitro: an async callback that returns a value arrives natively as `Promise<T>`, callable from any thread. Kotlin `Promise<T>.then/catch/suspend await()`; Swift `await()`. | nitro.margelo.com/docs/types/callbacks; `Promise.kt` / `Promise.swift` in 0.37.0 |
| F11 | CarPlay audio: entitlement `com.apple.developer.carplay-audio` (Apple-approved, managed capability); app must be **UIScene-based** (`UIApplicationSceneManifest` with `CPTemplateApplicationSceneSessionRoleApplication` + a `UIWindowSceneSessionRoleApplication` phone scene); `CPTabBarTemplate` (root only, `maximumTabCount` runtime), `CPListTemplate` (`maximumItemCount`/`maximumSectionCount` runtime, 5 levels deep), `CPNowPlayingTemplate.shared` (push, never present; reads `MPNowPlayingInfoCenter`); `CPListItem.handler(item, completion)` must call completion; `CPListItem.maximumImageSize`. | developer.apple.com doc JSON for each class; requesting-carplay-entitlements |
| F12 | RN scene support: `startReactNativeWithModuleName:inWindow:connectionOptions:` exists on `react/react-native` **main** (→ 0.88) and is **absent in v0.87.1**. | both `RCTReactNativeFactory.h` |
| F13 | DHU 2.0 runs on Linux (glibc ≥ 2.32, libc++) — installed at `$ANDROID_HOME/extras/google/auto`; phone needs Android Auto developer mode + "Start head unit server" + `adb forward tcp:5277 tcp:5277`. POCO F4 has `com.google.android.projection.gearhead`. | …/training/cars/testing/dhu; local |

---

## 1. TS contract (`@timbre/media-session`) — VERBATIM, agents copy this

```ts
/** A node of the car browse tree. One item may be both browsable and playable
 *  (an album that opens AND plays) — media3 and CarPlay both allow it. */
export interface BrowseItem {
  /** Opaque, stable, unique across the whole tree. Auto/CarPlay hand it back
   *  verbatim to `getChildren` / `playFromMediaId`. */
  id: string
  title: string
  subtitle?: string
  /** https://, file://, content://, android.resource://. https is served to
   *  Auto through the package's artwork provider (F5). */
  artworkUri?: string
  /** Opens a child list. @default false */
  browsable?: boolean
  /** Starts playback via `playFromMediaId`. @default false */
  playable?: boolean
  /** How THIS item's children render (Auto content style; CarPlay ignores). */
  childStyle?: BrowseStyle
  /** Contiguous items sharing a `group` render under one heading. */
  group?: string
  /** Explicit-content badge. @default false */
  explicit?: boolean
  /** Podcast-style progress. 0..1; `1` renders "played". */
  completion?: number
  /** Semantic type — Auto/CarPlay pick icons/layouts from it. @default 'mixed' */
  mediaType?: BrowseMediaType
}
export type BrowseStyle = 'list' | 'grid' | 'categoryList' | 'categoryGrid'
export type BrowseMediaType =
  | 'mixed' | 'music' | 'podcastEpisode' | 'radioStation' | 'audiobookChapter'
  | 'folderAlbums' | 'folderArtists' | 'folderGenres' | 'folderPlaylists'
  | 'folderPodcasts' | 'folderRadioStations' | 'folderMixed'

/** What voice asked for, when Auto/Assistant could classify it (F1). */
export interface SearchFocus {
  kind: 'any' | 'artist' | 'album' | 'title' | 'genre' | 'playlist'
  artist?: string; album?: string; title?: string; genre?: string; playlist?: string
}

/** Throw (or reject with) this from any browse method to show the car's
 *  sign-in / upgrade screen instead of an empty list (F7). */
export class BrowseError extends Error {
  constructor(
    readonly code: 'authenticationExpired' | 'premiumAccountRequired'
      | 'notAvailableInRegion' | 'parentalControlRestricted' | 'notSupported',
    message: string,
    /** Optional "Sign in" button: label + a deep link the app handles. */
    readonly resolution?: { label: string; url: string },
  )
}

/** Exported constant. `getChildren(BROWSE_ROOT)` returns the ROOT TABS:
 *  ≤ 4, browsable-only (F4). Extra/playable roots are dropped and reported on
 *  the sessionError channel (`code: 'browseRootRejected'`), never silently. */
export const BROWSE_ROOT = 'rn-media-root'

/** MediaHandler additions (replace the two v1 "reserved" stubs). */
interface MediaHandler {
  /** Children of a browsable item. `BROWSE_ROOT` asks for the tabs. */
  getChildren(parentId: string): Promise<BrowseItem[]>
  /** One item by id (Auto's `onGetItem`, CarPlay refresh). */
  getMediaItem(id: string): Promise<BrowseItem | undefined>
  /** Car/voice/Assistant tapped or asked for a playable item. Build the
   *  queue, broadcast, play — acknowledge-by-broadcast, like `play()`. */
  playFromMediaId(id: string): void | Promise<void>
  /** "Play some jazz" (Auto/Assistant, F1). `query` may be '' — "play
   *  something": resume or pick. Optional: absent ⇒ voice play is not
   *  advertised. */
  playFromSearch?(query: string, focus: SearchFocus): void | Promise<void>
  /** Browsable search results (Auto's search tab, F9). Optional: absent ⇒
   *  `SEARCH_SUPPORTED=false` (F8). CarPlay audio apps have no search
   *  template — iOS never calls it. */
  search?(query: string): Promise<BrowseItem[]>
}

/** MediaServiceApi additions. */
interface MediaServiceApi {
  /** The children of `parentId` changed (download finished, library sync).
   *  Android → `notifyChildrenChanged`; iOS → rebuilds the visible template.
   *  Omit `parentId` for "everything". Also evicts the native cache entry. */
  invalidateBrowse(parentId?: string): void
  /** Is a car currently connected? (Auto companion / Automotive / CarPlay
   *  scene). Reactive twin: `useCarConnection()` in the hooks module. */
  getCarConnection(): CarConnection
}
export type CarConnection = { kind: 'none' } | { kind: 'androidAuto' } |
  { kind: 'automotiveOs' } | { kind: 'carPlay' }
/** New hook: `useCarConnection(): CarConnection` (subscribes to the native
 *  `onCarConnectionChanged` callback). */
```

`BaseMediaHandler` keeps default no-ops: `getChildren → []`, `getMediaItem →
undefined`, `playFromMediaId → no-op + sessionError('playFromMediaIdUnhandled')`
(a car that taps and hears nothing is the silent no-op, ARCHITECTURE §27).

### Nitro spec additions (`media-session.nitro.ts`) — exact shapes

```ts
export interface NativeBrowseItem {            // BrowseItem, flattened for Nitro
  id: string; title: string; subtitle?: string; artworkUri?: string
  browsable: boolean; playable: boolean; childStyle?: BrowseStyle
  group?: string; explicit: boolean; completion?: number; mediaType: BrowseMediaType
}
export interface NativeBrowseError {            // named: nitrogen needs named object types
  code: BrowseErrorCode; message: string; resolutionLabel?: string; resolutionUrl?: string
}
export interface NativeBrowseResult {           // one shape for children + search
  items: NativeBrowseItem[]
  /** Set instead of items to show the car's error screen (F7). */
  error?: NativeBrowseError
}
export interface NativeBrowseCapabilities { search: boolean; playFromSearch: boolean }
export type BrowseErrorCode = 'authenticationExpired' | 'premiumAccountRequired'
  | 'notAvailableInRegion' | 'parentalControlRestricted' | 'notSupported'
export interface NativeSearchFocus { kind: string; artist?: string; album?: string; title?: string; genre?: string; playlist?: string }

// MediaSessionHandlers additions (ALL required — the TS layer always
// supplies them; optional-ness lives in the public handler, per the file's
// existing rule). Returning callbacks = Nitro Promise on the native side (F10).
getChildren: (parentId: string) => Promise<NativeBrowseResult>
getMediaItem: (id: string) => Promise<NativeBrowseResult>   // 0 or 1 item
search: (query: string) => Promise<NativeBrowseResult>
playFromMediaId: (id: string) => void
playFromSearch: (query: string, focus: NativeSearchFocus) => void
onCarConnectionChanged: (kind: string) => void

// HybridObject additions
setBrowseCapabilities(caps: NativeBrowseCapabilities): void
invalidateBrowse(parentId?: string): void
getCarConnection(): string
```

---

## 2. Android contract

**A1 — `COMMAND_SET_MEDIA_ITEM` is granted per controller, never globally.**
In `onConnectAsync`, add `Player.COMMAND_SET_MEDIA_ITEM` to the player commands
iff `session.isAutoCompanionController(c) || session.isAutomotiveController(c)
|| c.isTrusted()`. Everything else keeps today's set (the seeded-timeline
argument in the media-session spec stands for untrusted controllers). Unit-test
the predicate as a pure function `carCommands(isAuto, isAutomotive, isTrusted)`.

**A2 — `onSetMediaItems` is the fan-in for tap and voice (F1).** Implement
`MediaSession.Callback.onSetMediaItems(session, controller, items, startIndex,
startPositionMs)`: if `items[0].requestMetadata.searchQuery != null` →
`handlers.playFromSearch(query, focusFrom(requestMetadata.extras))`, else →
`handlers.playFromMediaId(items[0].mediaId)`. Return a `MediaItemsWithStartPosition`
of the **current** timeline (`snapshot.timeline`, unchanged) — the app's next
`setQueue`/`setPlaybackState` broadcast is the acknowledgement, exactly as
`play()`. `SimpleBasePlayer.handleSetMediaItems` is therefore never reached
with foreign items; assert that in a test. Focus extras: `android.intent.extra.
focus` + `EXTRA_MEDIA_ARTIST/ALBUM/TITLE/GENRE/PLAYLIST` (`MediaStore`).

**A3 — Browse = pull through Nitro, cached natively.** `onGetChildren(parentId)`:
1. If a **live runtime** with handlers exists → call `handlers.getChildren`,
   `Futures` bridge from the Nitro `Promise` (F10), write the answer to
   `BrowseCache` (memory + disk JSON under `cacheDir/rn-media/browse/`, keyed by
   parentId, bounded 64 entries / 2 MB, LRU), return it.
2. If no runtime → return the cached answer immediately (or empty list — never
   an error: "return an empty list for no children rather than error codes"),
   and if the service is not already reviving, `beginRevival(startsPlayback =
   false)` **only if** the browser is a car controller (A1 predicate) — a
   SystemUI bind must not boot the app (ARCHITECTURE §30 sticky-restart rule).
   When the runtime arrives, `notifyChildrenChanged(parentId)` for every parent
   served from cache during revival.
`onGetItem` mirrors it. `onGetLibraryRoot` returns the existing root; its
`LibraryParams.extras` now carry `EXTRAS_KEY_CONTENT_STYLE_BROWSABLE/PLAYABLE`
defaults (list) and `EXTRAS_KEY_ROOT_CHILDREN_LIMIT=4` is READ from the
browser's params (F4) to cap root children. Root tabs violating F4 are dropped
and reported via the sessionError channel (`browseRootRejected`).

**A4 — Errors (F7).** `NativeBrowseResult.error` → `LibraryResult.ofError(
SessionError(code, message, extras))` where extras carry
`ERROR_RESOLUTION_ACTION_LABEL`/`_INTENT` (a `PendingIntent.getActivity` to the
app's launcher intent with `data = resolutionUrl`, `FLAG_IMMUTABLE`). Codes map:
`authenticationExpired → ERROR_SESSION_AUTHENTICATION_EXPIRED`,
`premiumAccountRequired → ERROR_SESSION_PREMIUM_ACCOUNT_REQUIRED`,
`notAvailableInRegion → ERROR_SESSION_NOT_AVAILABLE_IN_REGION`,
`parentalControlRestricted → ERROR_SESSION_PARENTAL_CONTROL_RESTRICTED`,
`notSupported → ERROR_NOT_SUPPORTED`. Keep media3's default replication mode;
document in KDoc that only the first two reach the car's screen (F7).

**A5 — Artwork provider (F5).** New `RnMediaArtworkProvider : ContentProvider`,
declared in the library manifest (`android:authorities="${applicationId}.rnmedia.artwork"`,
`android:exported="true"`, `android:grantUriPermissions="false"` — UAMP precedent;
read-only, `query/insert/update/delete` return null/0). `openFile` serves
`cacheDir/rn-media/artwork/<sha256(url)>` — downloading on miss with a 10 s
timeout, downscaled to the browser's `EXTRAS_KEY_MEDIA_ART_SIZE_PIXELS` hint
(default 256), JPEG. **Only URLs previously registered by the browse path are
served** (`ArtworkRegistry` map url↔hash, persisted) — the provider never
fetches arbitrary paths. `BrowseItem.artworkUri` https → `content://<auth>/<hash>`
at conversion; `file://`/`content://`/`android.resource://` pass through.

**A6 — Search (F8/F9).** `setBrowseCapabilities` decides whether
`COMMAND_CODE_LIBRARY_SEARCH` stays in the session commands for browsers
(remove it when `search=false` so the stub advertises `SEARCH_SUPPORTED=false`).
`onSearch` → call `handlers.search`, cache under `search:<query>`, then
`notifySearchResultChanged(browser, query, count, params)`; `onGetSearchResult`
serves the cache. `playFromSearch=false` ⇒ voice requests with a query answer
`ERROR_NOT_SUPPORTED`.

**A7 — Manifest is zero-config.** Library manifest adds
`<meta-data android:name="com.google.android.gms.car.application" android:resource="@xml/automotive_app_desc"/>`
under `<application>` and ships `res/xml/automotive_app_desc.xml`
(`<automotiveApp><uses name="media"/></automotiveApp>`). Verify the merged
manifest of the example APK contains it (`aapt dump xmltree`).

**A8 — Car connection.** `onConnectAsync`/`onDisconnected` maintain a set of
car controllers (A1 predicate minus `isTrusted`); transitions fire
`handlers.onCarConnectionChanged('androidAuto' | 'automotiveOs' | 'none')`.

**A9 — Invalidate.** `invalidateBrowse(parentId?)` evicts cache entries and
calls `notifyChildrenChanged` (all browsers) for the parent, or for every
cached parent + root when omitted.

**Not in this slice (record as follow-ups in PLAN):** custom browse actions
(`setCommandButtonsForMediaItems` + `MediaMetadata.supportedCommands`),
Automotive OS (AAOS) device pass, `EXTRA_RECENT`/`EXTRA_OFFLINE` root variants
beyond what resumption already serves.

---

## 3. iOS contract (CarPlay)

**I1 — Two scene delegates ship in the pod, bare `@objc` names** (F11, F12):
`RnMediaCarPlaySceneDelegate` (`CPTemplateApplicationSceneDelegate`) and
`RnMediaWindowSceneDelegate` (`UIWindowSceneDelegate`, the RN-0.87 phone shim:
re-parents `UIApplication.shared.delegate?.window??.rootViewController` into a
`UIWindow(windowScene:)`, exactly the react-native-carplay / queue-player
pattern). KDoc states the shim is deleted when the app moves to RN 0.88's
`startReactNativeWithModuleName:inWindow:connectionOptions:`.

**I2 — Templates from the same handler.** On `didConnect`: `getChildren(BROWSE_ROOT)`
→ `CPTabBarTemplate` of `CPListTemplate`s (≤ `maximumTabCount`; extras dropped
+ sessionError `browseRootRejected`, same code as Android). Each tab's list is
filled lazily: push an empty `CPListTemplate(title)`, call `getChildren(id)`,
then `updateSections`. `CPListItem.handler`: browsable → push child list (call
`completion` after the push); playable → `playFromMediaId(id)` then push
`CPNowPlayingTemplate.shared` and `completion()`. Depth ≤ 5 (F11). `group` →
`CPListSection(header:)`; `explicit` → `isExplicitContent`; `completion` →
`playbackProgress`; the current item (broadcast `mediaItem.id`) → `isPlaying`.
Errors → `CPAlertTemplate` with the message and a "Sign in"-style action that
opens `resolution.url` on the phone via `UIApplication.open`.

**I3 — Now Playing.** Nothing new to feed: `MPNowPlayingInfoCenter` +
`MPRemoteCommandCenter` are already ours. Configure
`CPNowPlayingTemplate.shared.updateNowPlayingButtons` from the broadcast
capabilities: `setRepeatMode` → `CPNowPlayingRepeatButton`, `setShuffle` →
`CPNowPlayingShuffleButton`, `setRate` → `CPNowPlayingPlaybackRateButton`;
`isUpNextButtonEnabled = queue.length > 1` with an observer that pushes a
`CPListTemplate` of the broadcast queue whose taps call `skipToQueueItem`.

**I4 — Artwork.** `URLSession` download → `UIImage` scaled to
`CPListItem.maximumImageSize`, memory+disk cache (reuse `ArtworkCache.swift`
if its contract fits; extend, don't fork). Never block the handler.

**I5 — Car connection + invalidate.** `didConnect/didDisconnect` →
`onCarConnectionChanged('carPlay' | 'none')`. `invalidateBrowse(parentId?)`
re-fetches and `updateSections` on any visible template showing that parent.

**I6 — Expo plugin `withCarPlay`** (opt-in prop `carPlay: true`): writes
`UIApplicationSceneManifest` (`UIApplicationSupportsMultipleScenes=true`, the
CarPlay role → `RnMediaCarPlaySceneDelegate`, the window role →
`RnMediaWindowSceneDelegate`) and the entitlement
`com.apple.developer.carplay-audio=true`. Bare RN: the same two snippets in
the README, next to the `MediaButtonReceiver` paste. Simulator: I/O → External
Displays → CarPlay works with the key alone; device needs Apple's approval
(owner action, F11).

**Search on CarPlay:** audio apps have no search template → `search` is never
called on iOS; document it (parity note, not a gap: the car has no surface).
Siri `INPlayMediaIntent` = follow-up.

---

## 4. Example app (`apps/example`)

`src/playback/browse.ts`: a tree from `data/tracks` — tabs **Library** (all
tracks), **Albums** (browsable per album, `childStyle: 'grid'`, album art),
**Artists**, **Recent** (last-played ids from persistence). `playFromMediaId`
builds the queue from the tapped node (track → that album from that track;
album → the album). `playFromSearch` → substring match over title/artist.
A "Simulate sign-in required" toggle in the Session panel makes `getChildren`
throw `BrowseError('authenticationExpired', …, {label:'Sign in', url:'rnmedia://signin'})`.

---

## 5. Acceptance criteria (both lanes) + verification playbook

1. `npm run typecheck && npm run test` green; new pure modules tested in Node:
   root-tab capping, error mapping, artwork URL mapping, focus parsing,
   cache LRU/eviction, car-command predicate, CarPlay section builder (Swift
   logic that can be a pure function gets an XCTest under `ios/Tests`).
2. nitrogen re-run; generated diff committed; `lintDebug` no new warnings.
3. **DHU (Linux)**: root shows the four tabs, drilling into Albums renders a
   grid with artwork (served by `content://…rnmedia.artwork`), tapping a track
   starts playback and the Now Playing screen shows title/art/controls, the
   Search tab returns results, the sign-in toggle shows Auto's error screen
   with the "Sign in" button, and a **cold** browse (`am force-stop`, then open
   the app in DHU) lists from cache and refreshes. Record exact `adb logcat`
   lines and DHU screenshots in ARCHITECTURE §31 "On-device verification".
4. `aapt dump xmltree app-debug.apk AndroidManifest.xml` shows the car
   meta-data and the provider.
5. iOS: compiles on CI (`ios-build.yml`); Simulator CarPlay pass is owner-gated
   (Apple hardware / macOS); mark pending, as cast did.
6. The private-fixture gate (the case-insensitive grep every commit runs) is clean; nothing private in fixtures.

## 6. Lanes (parallel; do not cross)

- **Lane A (Android + TS)**: `packages/media-session/src/**`, `android/**`,
  `plugin/src/withAndroidAuto*` (none needed — manifest merge), `apps/example/**`,
  `docs/specs/car.md` addenda, README sections. Owns the Nitro spec file.
- **Lane B (iOS)**: `packages/media-session/ios/**`, `plugin/src/withCarPlay.ts`
  + plugin tests, `RnMediaMediaSession.podspec` (add `CarPlay` framework, weak),
  `.github/workflows/ios-build.yml` if flags are needed. Consumes the Nitro
  spec Lane A lands first (`nitrogen/generated` is Lane A's to commit).
- Neither lane commits. The architect reviews, commits, and updates
  ARCHITECTURE §31 and `docs/comparison.md` (RNTP row → "controls only").

---

## 7. Lane A addenda (implementation, 2026-08-27)

Written while implementing §1, §2 and §4. Every item is a correction or an
addition to the contract above, verified against the media3 1.11.0 sources
(fetched from the `1.11.0` tag) or the shipped AARs, not against the docs.

**A-1 — F7 is wrong about the second replicated code.** media3 replicates a
`LibraryResult` error into the platform playback state for
`RESULT_ERROR_SESSION_AUTHENTICATION_EXPIRED` and
`RESULT_ERROR_SESSION_PARENTAL_CONTROL_RESTRICTED` — **not**
`PREMIUM_ACCOUNT_REQUIRED`:

```java
private boolean isReplicationErrorCode(@LibraryResult.Code int resultCode) {
  return resultCode == LibraryResult.RESULT_ERROR_SESSION_AUTHENTICATION_EXPIRED
      || resultCode == LibraryResult.RESULT_ERROR_SESSION_PARENTAL_CONTROL_RESTRICTED;
}
```
`MediaLibrarySessionImpl.java`, 1.11.0. The rest of F7 holds: `onGetLibraryRoot`
is exempt (it has no `maybeUpdateLegacyErrorState` call), the mode defaults to
non-fatal, and the resolution extras are read from `SessionError.extras` when
`LibraryParams.extras` does not carry the intent key
(`MediaSessionLegacyStub.setLegacyError`). The TSDoc on `BrowseError` and the
KDoc on `BrowseTree.sessionError` state the corrected pair.

**A-2 — F10 understates the nesting.** nitrogen wraps *every* non-void callback
return in a `PromiseType` (`FunctionType`'s constructor, nitrogen 0.37.0), so a
callback declared `=> Promise<T>` arrives natively as `Promise<Promise<T>>`:
the outer resolves when the JS function returns, the inner when the promise it
returned settles. Both must be unwrapped. Declaring `=> T` instead would give a
single promise but would stop an `async` handler from typechecking, so the
declaration stands and the double unwrap is documented at the one bridge
(`RnMediaMediaSessionService.bridge`).

**A-3 — A1 is necessary but not sufficient.** A per-controller grant of
`COMMAND_SET_MEDIA_ITEM` is inert unless the **player** advertises it too:

```java
public boolean isPlayerCommandAvailable(ControllerInfo c, @Player.Command int code) {
  return info != null && info.playerCommands.contains(code)
      && sessionImpl.getPlayerWrapper().getAvailableCommands().contains(code);
}
```
`ConnectedControllersManager.java`, 1.11.0. So `MediaButtons.addAlways` now adds
it to the facade player, and `onConnectAsync` *removes* it from every controller
that is not a car and not trusted (starting from media3's own
`DEFAULT_PLAYER_COMMANDS` / `DEFAULT_UNTRUSTED_PLAYER_COMMANDS`, which is what
`AcceptedResultBuilder(session, controller)` already applied). Consequence worth
knowing: the *legacy* platform playback state is one broadcast for all legacy
controllers, so `ACTION_PLAY_FROM_MEDIA_ID | _SEARCH | _URI | PREPARE_FROM_*`
are now advertised device-wide (`convertCommandToPlaybackStateActions`). Who may
*use* them is still per controller; a play-from-URI has no handler method and is
answered with a failed future.

**A-4 — a browse tap is followed by a synthesised `play()`.** After
`onSetMediaItems` resolves, `MediaSessionLegacyStub.handleMediaRequest` runs
`setMediaItemsWithStartIndexAndPosition` → `prepareIfCommandAvailable` →
`playIfCommandAvailable` on the player, inline, in the same looper turn. For
this package that `play()` becomes `handlers.play()` — "resume the current
track" — i.e. the track the user just navigated *away* from, audible for as long
as the app takes to load the new one. `MediaRequestLatch` swallows exactly that
one call (armed in `onSetMediaItems`, consumed by the next `handleSetPlayWhenReady`,
disarmed on the next looper turn); the pending-acknowledgement future is still
created, so the optimistic state is unchanged. Unit-tested.

**A-5 — `explicit` cannot be a bridge field name.** `NativeBrowseItem.explicit`
generates `bool explicit;` into `nitrogen/generated/shared/c++/NativeBrowseItem.hpp`
and the NDK build fails with *"'explicit' can only appear on non-static member
functions"*. Kotlin and Swift compile it happily, so it only surfaces at
`:app:assembleDebug`. The bridge field is therefore **`isExplicit`**; the public
`BrowseItem.explicit` is unchanged and the TS layer renames it. The spec file's
existing note about enum members colliding with keywords now covers fields too.
*Lane B: `ios/carplay/CarPlayBridge.swift:226` reads `item.explicit` and needs
`item.isExplicit`.*

**A-6 — the browse revival must not promote (amends A3.2).** `beginRevival` was
written for a service someone `startForegroundService()`'d, and its first act is
to become foreground to keep that promise. A car *binds* the service, which
promises nothing — promoting there would be an app starting a foreground service
from the background (`ForegroundServiceStartNotAllowedException` on API 31+) to
show a playback notification for playback nobody asked for. `beginRevival` gained
`promotes: Boolean = true`; the browse path passes `false` and only boots the
runtime. Related limitation, stated plainly: **cold browse needs
`android.playbackResumption: true`**, because a process with no runtime can only
build a session from the persisted mirror; without it `onCreate` stops the
service before any browser can connect. Follow-up candidate: a browse-only
session for apps that do not want resumption.

**A-7 — root capping happens twice, deliberately.** The four-tab, browsable-only
rule runs in TypeScript (`capRootTabs`) so both platforms behave identically and
the app hears about drops once, on `browseRootRejected`. Android additionally
caps to the browser's own `EXTRAS_KEY_ROOT_CHILDREN_LIMIT` when it is smaller —
that is the browser describing its screen, not an app bug, so it is logged and
not reported.

**A-8 — example app deviation from §4.** `playFromMediaId` **jumps within the
loaded queue** instead of rebuilding it. `apps/example` hands mpv one playlist at
startup and three subsystems are indexed against it (the queue mirror,
persistence's restored index, the cast handoff), so a rebuild per tap would break
three working demos to demonstrate queue management this app does not have. The
rest of §4 is as specified: four tabs, a grid of albums with artwork, artists
with `group` headings, Recent, substring `playFromSearch`, and a
"Simulate sign-in required" toggle wired to `invalidateBrowse()`.

**A-9 — `search` capability gating is per controller, at connect time.**
`SEARCH_SUPPORTED` is computed by the legacy stub from
`isSessionCommandAvailable(controller, COMMAND_CODE_LIBRARY_SEARCH)` while
answering `onGetRoot`, so the capability must be declared **before**
`initialize` (the TS layer calls `setBrowseCapabilities` first, and a test pins
that order). Replacing the handler at runtime with one that has `search` would
need reconnecting browsers to see the change; not a v1 concern, recorded here.

**A-10 — the DHU needs `startupfocus = true`; `scripts/dhu.sh` is the recipe.**
DHU 2.0 (build 2022-03-30) connects to Android Auto 17.3.662854, finishes TLS
and draws nothing — `screenshot` answers `Don't have video focus - nothing to
screenshot`. It never requests video focus unless `~/.android/headunit.ini`
sets `startupfocus = true`, a key present in the binary and in none of the
shipped sample files. With it the head unit renders. Also: a stale
`gearhead:car` session holds the server (force-stop Android Auto and restart
the server before each connect); `-c config/default_720p.ini` breaks the
handshake (800×480 negotiates); its stdin must stay open. The first diagnosis
was "a 2022 receiver against a 2026 Auto" — wrong, and worth remembering.
`scripts/dhu.sh [serial]` does all of it. What the car drew, and the
instrumented `MediaBrowser` test that covers the same callbacks
(`CarBrowseInstrumentedTest`, 10 cases, `./gradlew :app:connectedDebugAndroidTest`),
are in ARCHITECTURE §31.

**A-11 — a `metadataMismatch` false positive, found by driving the DHU.** With
the car connected, tapping a track in the browse tree produced
`metadataMismatch: … item id 'diverse-fm' vs queue[1] id 'fip-hls'` from an app
whose every individual broadcast was self-consistent. Cause: an app describes
one moment with two calls (`setMediaItem`, then `setPlaybackState`) and each
hops to the main thread separately, so for one looper turn the session holds
*half* the statement — the new index with the old item — and `getState()` runs
in that gap. The invariant was being judged on a state the app never published.

Fixed by deferring the report one turn (`MismatchReporter`): both writes of a
broadcast are already queued when the first runs, so a check posted from inside
the first lands after all of them. A mismatch the app is genuinely publishing
still reports, exactly once, and a *different* mismatch still reports again —
all four cases are unit-tested. Verified on the device: three consecutive track
jumps, zero reports (one per jump before).
