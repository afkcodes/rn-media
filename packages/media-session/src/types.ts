import type {
  MediaCapability,
  MediaControl,
  MediaCustomAction,
  MediaPlaybackStatus,
  MediaRepeatMode,
  NativeMediaItem,
  PositionAnchor,
  RemoteVolumeControl,
  SessionErrorCode,
  SleepTimerMode,
} from './specs/media-session.nitro'

/**
 * Metadata for one playable thing.
 *
 * Structurally identical to the bridge struct — there is nothing to narrow, so
 * aliasing beats maintaining a parallel type.
 */
export type MediaItem = NativeMediaItem

/**
 * The broadcast playback state, as the app writes it.
 *
 * Differs from the bridge's `NativePlaybackState` only in optionality:
 * `controls`, `capabilities` and `customActions` default to empty here, because
 * "no buttons" is a perfectly ordinary state and `[]` is noise at the call
 * site. {@link normalizePlaybackState} fills them in.
 */
export interface PlaybackState {
  status: MediaPlaybackStatus
  /**
   * Position anchor — `{ value, at, rate }`. Broadcast on discontinuities only;
   * every surface projects locally. See {@link PositionAnchor}.
   */
  position: PositionAnchor
  /**
   * Buffered position in ms; omit when unknown.
   *
   * **Android only** — media3 draws it as the secondary bar behind the scrubber.
   * MediaPlayer has no buffered-position key anywhere in `MPNowPlayingInfoCenter`
   * (the nearest, `MPNowPlayingInfoPropertyPlaybackProgress`, is a
   * watched-so-far indicator, not a buffer level), so it renders nothing on iOS.
   * Harmless to send on both.
   */
  bufferedPosition?: number
  /** Buttons to offer, in order. @default [] */
  controls?: MediaControl[]
  /** Commands to accept. @default [] */
  capabilities?: MediaCapability[]
  /**
   * Extra buttons with app-defined meanings. **Android only**:
   * `MPRemoteCommandCenter`'s command set is fixed and closed, so iOS has no
   * surface that can render or invoke one — see {@link MediaCustomAction}.
   * Presses arrive at {@link MediaHandler.customAction}. @default []
   */
  customActions?: MediaCustomAction[]
  /**
   * **Android only**: which of {@link controls} occupy the ≤3 collapsed
   * notification slots. Omit to take the first three. iOS has no button layout —
   * commands are enabled or not and the system draws what it draws — so this is
   * ignored there.
   */
  compactControlIndices?: number[]
  /** Index into the last broadcast queue, or `-1`/omitted when not queue-backed. */
  queueIndex?: number
  /**
   * Only meaningful when `status === 'error'`.
   *
   * **Android only**: it becomes the session's `PlaybackException` message.
   * MediaPlayer has no error surface at all and cannot even distinguish `error`
   * from `paused` (see {@link MediaPlaybackStatus}), so an errored session looks
   * paused on the iOS lock screen. Show the message in your own UI.
   */
  errorMessage?: string
  /**
   * Current repeat mode for the remote surfaces' repeat button.
   *
   * Additive and optional so every existing call site keeps compiling and keeps
   * behaving identically. @default 'off'
   *
   * The button only *appears* if `capabilities` also contains `'setRepeatMode'`;
   * presses arrive at {@link MediaHandler.onSetRepeatMode}.
   */
  repeatMode?: MediaRepeatMode
  /** Current shuffle state. Same rules as {@link repeatMode}. @default false */
  shuffleEnabled?: boolean
}

/**
 * "Playback is coming out of another device right now, and here is that
 * device's volume."
 *
 * Published with {@link MediaServiceApi.setRemotePlayback} while some remote
 * backend owns the audio — a Cast receiver, a UPnP renderer, a multi-room
 * protocol — and cleared when the phone takes it back. Nothing here is
 * cast-specific: this package works with any player and any output.
 */
export interface RemotePlayback {
  /**
   * The remote device's current volume, `0..1`.
   *
   * The same scale an app's own slider uses, and the one every remote backend
   * already speaks. Quantising it into the platform's integer notches is this
   * package's job — see {@link steps}.
   */
  volume: number
  /** Whether the remote device is muted. @default false */
  muted?: boolean
  /**
   * How many notches a hardware volume key press moves through, silent to
   * full. @default 20
   *
   * 20 is media3's own choice for a Cast receiver
   * (`RemoteCastPlayer.MAX_VOLUME`, media3 1.11.0), so an app that says nothing
   * gets the step size Android users already feel from every other cast-enabled
   * app.
   */
  steps?: number
  /**
   * How much of that volume the backend can actually drive. @default 'absolute'
   *
   * `'absolute'` (a level can be set *and* nudged) is what a Cast receiver, a
   * UPnP renderer and essentially every network audio target support, so it is
   * the default. `'fixed'` deliberately leaves the hardware keys dead — the
   * honest state for a device whose volume the sender may not touch.
   */
  volumeControl?: RemoteVolumeControl
  /**
   * Android only: the `MediaRouter2` routing-controller id of the route the
   * audio is on, when the backend exposes one.
   *
   * Lets the system output switcher tie the volume slider it draws to the route
   * that is playing. A refinement — omit it and everything else still works.
   */
  routingControllerId?: string
  /**
   * Android only: hold a **silent local audio output** for as long as this
   * remote playback is published, so the app keeps the platform's
   * "last played locally" slot. @default false
   *
   * ## What it is for
   * With the screen off, `MediaSessionService` discards the session it just
   * chose — and drops the key entirely — when the *caller's* uid was the last
   * to play local audio (b/275185436). The caller with the screen off is
   * `PhoneWindowManager`, uid 1000, so **any system sound (a notification, a
   * ringtone) takes the volume keys away** from a remote session. It is sticky,
   * not momentary: the platform's list never evicts its head entry, and an app
   * whose audio is remote never plays locally to displace it.
   *
   * The one documented escape: when the head uid goes *inactive*, the platform
   * promotes the first still-**active** uid to the head. An app holding a
   * silent local output is that uid, so it reclaims the slot as soon as the
   * interfering sound ends. See the package README, "Two platform conditions".
   *
   * ## What it costs, and why it is off by default
   * A real audio output stays open for the whole remote session, which keeps
   * the audio HAL awake — measurable battery, for a feature the user only
   * notices when they reach for the rocker. It also makes
   * `AudioSystem.isStreamActive(STREAM_MUSIC)` true, which **changes the
   * failure mode** rather than only removing one: if the session is ever
   * discarded for the other reason (playback not PLAYING), the key now moves
   * the *phone's* volume instead of doing nothing.
   *
   * So it is opt-in. Turn it on when lock-screen volume over a remote device
   * matters more than idle power — a cast-heavy music app — and leave it off
   * otherwise. It takes no audio focus and does not touch your player.
   *
   * No-op on iOS, where the hardware buttons cannot be taken over at all.
   */
  holdLocalAudioSlot?: boolean
}

/** Which way a hardware volume key moved. See {@link MediaHandler.onAdjustDeviceVolume}. */
export type RemoteVolumeDirection = 'up' | 'down'

/**
 * What the native sleep timer is doing, as {@link MediaServiceApi.getSleepTimer}
 * reports it.
 *
 * A discriminated union rather than `{ mode, remainingSeconds? }` so the one
 * case that has no number — a `trackEnd` timer whose deadline is not computable
 * yet — cannot be confused with "not armed" by an optional-chaining accident.
 */
export type SleepTimerState =
  /** {@link MediaServiceApi.setSleepTimer}: a countdown, always with a number. */
  | { readonly mode: 'duration'; readonly remainingSeconds: number }
  /**
   * {@link MediaServiceApi.setSleepTimerToTrackEnd}.
   *
   * `remainingSeconds` is present while the current item has a duration and
   * playback is advancing, and absent otherwise — a live stream, a paused
   * player, or a track whose duration the app has not broadcast yet. Absent
   * means "armed, deadline unknown", never "not armed".
   */
  | { readonly mode: 'trackEnd'; readonly remainingSeconds?: number }

/**
 * How much a {@link SessionError} took away.
 *
 * Two members, and the split is operational rather than editorial — an app
 * reacts differently to each, which is the only reason a severity exists at
 * all:
 *
 * - `'fatal'` — **background playback is not going to work.** Either the OS
 *   refused to protect the process (so the audio the user started is running
 *   unprotected, with no notification on Android), or a resumption the user
 *   asked for did not happen. Worth surfacing to the user, or worth stopping
 *   for; it is not going to fix itself.
 * - `'degraded'` — the session is alive and playing; some surface is showing
 *   less than the app asked for (no cover, a fallback icon, a missing scrubber),
 *   or an opt-in is quietly inert. Worth a log and a bug, not an alert.
 *
 * It is a pure function of {@link SessionError.code} and it is still carried on
 * every event, deliberately: an app that branches on severity keeps behaving
 * correctly when this closed union grows a member, where an app that branches on
 * `code` alone would drop the new one into its `default` arm.
 */
export type SessionErrorSeverity = 'fatal' | 'degraded'

/**
 * Something the session could not do, delivered to
 * {@link MediaHandler.onSessionError}.
 *
 * The failures on this channel have **no caller to reject to** — they happen on
 * a media3 service callback, an `MPRemoteCommandCenter` target, or an artwork
 * download that finished long after the broadcast that asked for it. A call the
 * app makes still throws {@link MediaSessionError} synchronously; this is the
 * other half, and before it existed every member of it was a log line and
 * nothing more (CLAUDE.md principle 6).
 *
 * ```ts
 * class Handler extends BaseMediaHandler {
 *   override onSessionError(error: SessionError): void {
 *     if (error.severity === 'fatal') showBanner(error.message)
 *     else console.warn(`[${error.code}] ${error.message}`)
 *   }
 * }
 * ```
 */
export interface SessionError {
  /** Which failure. See {@link SessionErrorCode} for the per-platform rules. */
  readonly code: SessionErrorCode
  /** Derived from {@link code}. See {@link SessionErrorSeverity}. */
  readonly severity: SessionErrorSeverity
  /**
   * A complete sentence, written for the developer who has to fix it — what
   * failed, and where there is one, the fix. Not a bare exception string.
   */
  readonly message: string
}

/**
 * The fan-in interface. Every remote surface — notification, lock screen,
 * Bluetooth, headset, watch, Android Auto, Control Center, and the app's own
 * UI — arrives here.
 *
 * Every method may return a promise; the session dispatches and returns
 * immediately, so a slow handler can never ANR the OS. A rejected promise is
 * reported through `MediaServiceConfig.onHandlerError`, never swallowed.
 */
export interface MediaHandler {
  play(): void | Promise<void>
  pause(): void | Promise<void>
  /** Release resources. Does NOT end background execution — call `stopService()` for that. */
  stop(): void | Promise<void>
  /** @param position milliseconds */
  seekTo(position: number): void | Promise<void>
  skipToNext(): void | Promise<void>
  skipToPrevious(): void | Promise<void>
  /**
   * Play an arbitrary entry of the broadcast queue.
   *
   * Reached from a remote surface on **Android only** — Android Auto, Wear, a
   * car head unit, any controller that renders the queue
   * (`Player.COMMAND_SEEK_TO_MEDIA_ITEM`). `MPRemoteCommandCenter` has no
   * queue-jump command, so no iOS remote surface can invoke this; it is still
   * part of the interface because your own UI calls it on both platforms.
   *
   * @param index index into the last broadcast queue
   */
  skipToQueueItem(index: number): void | Promise<void>
  setRate(rate: number): void | Promise<void>
  /**
   * A remote surface asked for a different repeat mode.
   *
   * **A request, not a fact.** Nothing has changed until the app changes it and
   * broadcasts a `setPlaybackState` carrying the new `repeatMode` — the same
   * acknowledgement contract `play`/`pause` follow, and on Android it is
   * literally what completes media3's pending-operation future.
   *
   * Only reachable when the app advertises the `setRepeatMode` capability.
   *
   * Optional for the reason {@link onSleepTimer} is: this interface is the
   * player-agnostic contract, and a method added after v1 must not break
   * structural implementors. `BaseMediaHandler` supplies a no-op.
   */
  onSetRepeatMode?(mode: MediaRepeatMode): void | Promise<void>
  /**
   * A remote surface asked to turn shuffle on or off. See
   * {@link onSetRepeatMode} — same request/acknowledge contract, gated on the
   * `setShuffle` capability, optional for the same reason.
   */
  onSetShuffle?(enabled: boolean): void | Promise<void>
  /**
   * A remote surface asked for an absolute volume on the **remote device**,
   * `0..1`.
   *
   * Reachable only while {@link MediaServiceApi.setRemotePlayback} has
   * published a device with `volumeControl: 'absolute'` — from the surfaces
   * that express a level (Android's remote volume dialog, the output switcher,
   * a `MediaController`) **and** from the hardware volume keys, whose notch the
   * library converts for you (see {@link onAdjustDeviceVolume}).
   *
   * **A request, not a fact** — the same contract as every other handler
   * method. Move the backend, then republish through `setRemotePlayback`; that
   * republish is what moves the slider on every surface.
   *
   * **Android only.** iOS gives an app no way to take over the hardware volume
   * buttons and `MPRemoteCommandCenter` has no volume command at all, so
   * `setRemotePlayback` is a documented no-op there and this — like
   * {@link onAdjustDeviceVolume} and {@link onSetDeviceMuted} — is never
   * invoked by the session on iOS. Drive a remote device's volume from your own
   * in-app slider there, which is what Google's own iOS cast apps do.
   *
   * Optional for the reason {@link onSleepTimer} is: a method added after v1
   * must not break structural implementors. `BaseMediaHandler` supplies a
   * no-op.
   */
  onSetDeviceVolume?(volume: number): void | Promise<void>
  /**
   * A **hardware volume key** moved one notch on a backend that can only be
   * nudged — `volumeControl: 'relative'`.
   *
   * Most apps never implement this. With the default `'absolute'` the library
   * turns the notch into a level itself (one `1 / steps` step from the last
   * published volume, quantised and clamped) and delivers
   * {@link onSetDeviceVolume} instead — so a Cast or UPnP backend needs one
   * method, not two, and the step arithmetic is written and tested once rather
   * than in every app.
   *
   * Which of the two you get is decided by what you published, never by which
   * methods you defined: `'relative'` → this, `'absolute'` →
   * `onSetDeviceVolume`, `'fixed'` → neither.
   *
   * Either way, the *routing* is the point. With the app backgrounded or the
   * screen locked there is no Activity to receive a key event; the platform
   * hands the press to the media session's volume provider, which exists only
   * because {@link MediaServiceApi.setRemotePlayback} made the session
   * advertise remote playback.
   *
   * **Android only** — see {@link onSetDeviceVolume}.
   */
  onAdjustDeviceVolume?(
    direction: RemoteVolumeDirection
  ): void | Promise<void>
  /**
   * A remote surface asked to mute or unmute the remote device. Same
   * request/acknowledge contract as {@link onSetDeviceVolume}, and **Android
   * only** for the same reason.
   */
  onSetDeviceMuted?(muted: boolean): void | Promise<void>
  /**
   * Android only: the app's task was swiped out of Recents.
   *
   * The native default policy (keep playing if playing, otherwise stop the
   * service) has already been decided by the time this runs — overriding this
   * method is for side effects (persistence, analytics), not for changing that
   * decision. Call `stopService()` here to force a stop.
   */
  onTaskRemoved(): void | Promise<void>
  /**
   * One of {@link PlaybackState.customActions} was pressed.
   *
   * **Android only.** `MPRemoteCommandCenter`'s command set is fixed and carries
   * no app-defined identifier, so no iOS remote surface can invoke a custom
   * action and this is never called there by the session — see
   * {@link MediaCustomAction}. Call it from your own UI if you want one code
   * path on both platforms.
   *
   * @param extras the controller's payload, or `undefined` when there is none.
   * Only Android controllers can send one.
   */
  customAction(
    name: string,
    extras?: Record<string, unknown>
  ): void | Promise<void>
  /**
   * The native sleep timer elapsed.
   *
   * **Playback is already paused when this runs.** The timer fires on a
   * platform timer (`Handler.postDelayed` / `DispatchQueue.main.asyncAfter`),
   * pauses natively on the same path a notification pause takes, and only then
   * calls this — the ordering is deliberate and is the reason the feature is
   * native at all: your `setTimeout` would not have fired (see the README's
   * background-playback limits).
   *
   * So this is where a timer *badge* is cleared, an analytics event is logged,
   * or `stopService()` is called if you would rather end background execution
   * than sit paused. Pausing again here is harmless but redundant.
   *
   * Optional: the pause has already happened natively by the time this fires,
   * so a handler with nothing to add can simply omit it — structural
   * implementors of this interface (the player-agnostic contract) must not
   * break when the library grows an informational callback.
   */
  onSleepTimer?(): void | Promise<void>

  /**
   * Android only: this JS runtime was started **by the media service** to
   * complete a playback resumption after the process had been killed.
   *
   * By the time this runs the notification is already on screen, the session
   * already carries the persisted track and position, and the `play` the user
   * pressed is about to be replayed on this handler. So there is nothing you
   * have to do here — it exists so an app can log it, fire an analytics event,
   * or refresh a token before the replayed `play()` needs one.
   *
   * Optional for the same reason {@link onSleepTimer} is: an informational
   * callback added after v1 must not break structural implementors of this
   * interface.
   *
   * Requires `android.playbackResumption: true`, `withPersistence`, and
   * `MediaService.init` at module scope — see
   * {@link MediaServiceConfig.android}.
   */
  onPlaybackResumption?(): void | Promise<void>

  /**
   * **The session failed at something, and there was no call to reject.**
   *
   * The one method here that is not a user gesture. Everything on this channel
   * used to be a native log line — the OS refusing a foreground service, an
   * artwork download that came back empty, a drawable name that does not
   * resolve, a resumption that never completed — so an app could ship a broken
   * background story and only find out from a bug report. See
   * {@link SessionError} and, for the per-platform emission rules, the codes
   * themselves.
   *
   * **Nothing here is required.** Every code names a degradation the session has
   * already handled as well as it can; implementing this changes no behaviour,
   * it only makes the failure visible. It is `void`/`Promise<void>` and
   * fire-and-forget like the rest: a throw or a rejection is routed to
   * {@link MediaServiceConfig.onHandlerError} (as `'onSessionError'`) and can
   * never take the session down, and it cannot re-enter this channel.
   *
   * **Never silently dropped.** A handler that does not implement it — including
   * a {@link CompositeMediaHandler} whose inner handler does not — gets a
   * `console.error` floor instead, because a swallowed error channel would be a
   * worse bug than the ones it reports.
   *
   * Optional for the reason {@link onSleepTimer} is: this interface is the
   * player-agnostic contract, and a method added after v1 must not break
   * structural implementors. `BaseMediaHandler` supplies the console floor.
   */
  onSessionError?(error: SessionError): void | Promise<void>

  /* ------------------------- Android Auto / CarPlay ------------------------- */

  /**
   * The children of a browsable node — one screen of the car's browse tree.
   *
   * Called with `BROWSE_ROOT` for the **root tabs**, then with whatever `id`
   * the user drilled into. The car hands ids back verbatim; nothing native
   * parses them.
   *
   * Unlike every other method here this one is *awaited*: a browser expects an
   * answer (media3 returns a `ListenableFuture`, CarPlay fills a list after the
   * push), and it is the browser being kept waiting, not a finger on a button.
   * Answer fast anyway — Android Auto shows a spinner until you do.
   *
   * Return `[]` for "this node has nothing under it" — Google's own guidance is
   * to prefer an empty list over an error code. Throw (or reject with) a
   * {@link BrowseError} for "I cannot answer this": a sign-in screen instead of
   * an empty one.
   *
   * The root is capped at four browsable tabs on both platforms
   * (`BROWSE_ROOT`), and anything dropped is reported on the session-error
   * channel as `browseRootRejected` rather than vanishing.
   */
  getChildren(parentId: string): Promise<BrowseItem[]>
  /**
   * One browse node by id — Android's `onGetItem`, CarPlay refreshing a row.
   *
   * `undefined` means "no such item", which the car renders as a missing row
   * rather than an error. Throw a {@link BrowseError} for "it exists and you
   * may not have it".
   */
  getMediaItem(id: string): Promise<BrowseItem | undefined>
  /**
   * A car, a head unit or an assistant asked to **play** a browse item.
   *
   * Build the queue around `id`, broadcast it, start playback — the same
   * acknowledge-by-broadcast contract as {@link play}: nothing on any surface
   * moves until the app's next `setQueue`/`setPlaybackState` says so.
   *
   * Not optional, and deliberately: a browse tree whose leaves do nothing when
   * tapped is the purest silent no-op in this package. `BaseMediaHandler`'s
   * default therefore reports `playFromMediaIdUnhandled` on the session-error
   * channel instead of returning quietly.
   */
  playFromMediaId(id: string): void | Promise<void>
  /**
   * "Play some jazz" — a voice query from Assistant or the head unit's mic.
   *
   * `query` may be `''`, which is Assistant's bare "play music": resume, or
   * pick something. `focus` carries what the assistant managed to classify
   * (artist, album, genre…), and is `{ kind: 'any' }` when it classified
   * nothing.
   *
   * **Optional, and the absence is advertised**: a handler without this method
   * makes the session answer voice playback requests with
   * `ERROR_NOT_SUPPORTED` rather than playing something arbitrary.
   */
  playFromSearch?(query: string, focus: SearchFocus): void | Promise<void>
  /**
   * Browsable results for the car's **search tab**.
   *
   * **Optional, and the absence is advertised**: without it the session drops
   * `COMMAND_CODE_LIBRARY_SEARCH` from what browsers may use, which is the only
   * thing that makes media3's legacy stub publish
   * `android.media.browse.SEARCH_SUPPORTED = false` — and that key alone is
   * what hides Android Auto's search tab.
   *
   * Never called on iOS: CarPlay audio apps have no search template, so there
   * is no surface to type into. A missing surface, not a missing feature.
   */
  search?(query: string): Promise<BrowseItem[]>
}

/* -------------------------------------------------------------------------- */
/*                        Android Auto / CarPlay browse                       */
/* -------------------------------------------------------------------------- */

/**
 * One node of the car browse tree.
 *
 * A node may be **both** browsable and playable — an album that opens *and*
 * plays. media3 and CarPlay both allow it; Android Auto's *root* does not (see
 * {@link BROWSE_ROOT}).
 */
export interface BrowseItem {
  /**
   * Opaque, stable and unique across the whole tree.
   *
   * Android Auto and CarPlay hand it straight back to {@link
   * MediaHandler.getChildren} and {@link MediaHandler.playFromMediaId}, so it
   * is the app's own key — a track id, a `album:1234`, a JSON blob if you must.
   * It must not be empty: media3 rejects a browse item with an empty media id.
   */
  id: string
  title: string
  subtitle?: string
  /**
   * `https://`, `file://`, `content://` or `android.resource://`.
   *
   * Android Auto accepts **only** `content://` and `android.resource://` for
   * browse artwork, so an `https://` URI is rewritten to a `content://` served
   * by this package's own provider — the download, the downscale and the cache
   * are handled for you. Nothing to do differently on iOS, which fetches the
   * URI itself.
   */
  artworkUri?: string
  /**
   * Opens a child list — `getChildren(id)` is called when it is tapped.
   *
   * @default false
   */
  browsable?: boolean
  /**
   * Starts playback — `playFromMediaId(id)` is called when it is tapped.
   *
   * @default false
   */
  playable?: boolean
  /**
   * How **this item's children** are laid out. Android Auto content style;
   * CarPlay draws a list either way and ignores it.
   */
  childStyle?: BrowseStyle
  /**
   * Contiguous items that share a `group` are drawn under one heading.
   *
   * Contiguous is load-bearing: both cars group *runs*, not sets, so
   * `[a, a, b, a]` renders three headings.
   */
  group?: string
  /** Explicit-content badge. @default false */
  explicit?: boolean
  /**
   * Podcast-style progress, `0..1`. `1` renders as "played", anything between
   * `0` and `1` as a partial progress bar, `0` (and omitted) as untouched.
   */
  completion?: number
  /**
   * What this node *is*. Both cars pick icons, placeholder art and — on
   * Automotive OS — whole layouts from it.
   *
   * @default 'mixed'
   */
  mediaType?: BrowseMediaType
}

/**
 * How a browsable item's children render. See {@link BrowseItem.childStyle}.
 */
export type BrowseStyle = 'list' | 'grid' | 'categoryList' | 'categoryGrid'

/** The semantic type of a browse node. See {@link BrowseItem.mediaType}. */
export type BrowseMediaType =
  | 'mixed'
  | 'music'
  | 'podcastEpisode'
  | 'radioStation'
  | 'audiobookChapter'
  | 'folderAlbums'
  | 'folderArtists'
  | 'folderGenres'
  | 'folderPlaylists'
  | 'folderPodcasts'
  | 'folderRadioStations'
  | 'folderMixed'

/**
 * What a voice query was about, when the assistant could classify it.
 *
 * Android delivers this alongside the query on `onPlayFromSearch`
 * (`android.intent.extra.focus` plus the matching `MediaStore.EXTRA_MEDIA_*`
 * extras). Nothing is guaranteed: `{ kind: 'any' }` with no fields is what a
 * plain "play something" produces, and every field is independent of `kind`.
 */
export interface SearchFocus {
  kind: 'any' | 'artist' | 'album' | 'title' | 'genre' | 'playlist'
  artist?: string
  album?: string
  title?: string
  genre?: string
  playlist?: string
}

/** Where playback is being controlled from. See {@link MediaServiceApi.getCarConnection}. */
export type CarConnection =
  | { kind: 'none' }
  | { kind: 'androidAuto' }
  | { kind: 'automotiveOs' }
  | { kind: 'carPlay' }

/** Configuration accepted by `MediaService.init`. */
export interface MediaServiceConfig {
  android?: {
    notificationChannelId: string
    notificationChannelName: string
    /** Drawable resource name in the consumer app, e.g. `'ic_notification'`. */
    notificationIcon?: string
    /**
     * `stopForeground(STOP_FOREGROUND_DETACH)` on pause: notification survives,
     * service is demoted and therefore killable.
     *
     * @default true
     */
    stopForegroundOnPause?: boolean
    /**
     * How long a paused service stays foreground before media3 demotes it, in
     * milliseconds. Omit for media3's default of 10 minutes; `0` demotes
     * immediately.
     *
     * Maps to `MediaSessionService.setForegroundServiceTimeoutMs`. Must be
     * `>= 0`; media3 clamps anything above 600 000 back down to 600 000, so
     * that is the real ceiling. Shorter = the process (and your JS handler)
     * becomes reclaimable sooner after a pause; longer = a resume from the
     * notification is more likely to find everything still alive. Pair a short
     * timeout with `withPersistence`.
     */
    stopForegroundTimeoutMs?: number
    /**
     * Let the media service come back **after the process was killed**, from
     * the System UI resumption card, a Bluetooth reconnect or a headset play
     * button — booting the JS runtime behind it.
     *
     * @default false — opt-in until it is proven on more hardware than ours.
     *
     * Requires all four, and says so in the log when one is missing:
     * 1. `withPersistence(service, storage)` — it writes the native mirror the
     *    service reads with no JS alive.
     * 2. `MediaService.init(...)` reachable at **JS module scope**, in a module
     *    your **entry file imports for its side effects**
     *    (`import './src/playback'` in `index.js`). A revived runtime loads
     *    your bundle but mounts no component, so an `init` inside a `useEffect`
     *    never runs — and Metro's release-mode **inline requires** goes
     *    further: an `import { x } from './m'` whose bindings are only used
     *    inside a component defers `./m`'s module scope to the first *render*,
     *    which a headless runtime never performs. Only a bare side-effect
     *    import in the entry file's own graph is guaranteed to execute at
     *    bundle load.
     * 3. {@link onRevivalRequested} — the same recovery for a runtime that is
     *    still **alive**: after `stopService()` the resumption card can start
     *    the service into a process whose module scope already ran and cannot
     *    run again, so the service asks the app to re-initialize instead.
     * 4. media3's `MediaButtonReceiver` in your `AndroidManifest.xml`:
     *
     *    ```xml
     *    <receiver android:name="androidx.media3.session.MediaButtonReceiver"
     *              android:exported="true">
     *      <intent-filter>
     *        <action android:name="android.intent.action.MEDIA_BUTTON" />
     *      </intent-filter>
     *    </receiver>
     *    ```
     *
     *    That declaration is what makes media3 advertise resumption to the
     *    System UI at all; it is deliberately not merged in from this library,
     *    because it changes how media buttons are routed for every app that
     *    installs the package.
     *
     * ## The platform story, so the asymmetry is not mistaken for a gap
     * - **Both platforms**: `withPersistence` / `restorePersisted` — the same
     *   record, the same behaviour. That is the cross-platform feature.
     * - **Android**: this flag adds an automatic consumer of that record — the
     *   resumption card, Bluetooth, a media button revive the process for you.
     * - **iOS**: the consumer of the same record is the next *manual* launch —
     *   the user opens the app and it is paused where they left it. An automatic
     *   iOS twin cannot exist: a terminated iOS app stays terminated, because
     *   force-quit is read as user intent and nothing may resurrect a process
     *   for playback. Apple's policy, not a missing feature here.
     *
     * If that ever changes the flag has a natural home at
     * `config.ios.playbackResumption`; it is namespaced under `android` on
     * purpose, not by accident.
     */
    playbackResumption?: boolean
    /**
     * Called when the media service needs this app to run its `init` path
     * again, **now** — the missing half of {@link playbackResumption} for a JS
     * runtime that is still alive.
     *
     * ## The scenario, concretely
     * The user presses your stop button; `stopService()` ends the session and
     * clears the handlers, but the System UI keeps offering its media
     * resumption card (stop ends *background execution*, not the user's place
     * in the album — the persisted record deliberately survives). The user
     * taps play on that card. The OS starts the media service into your
     * still-running process; the service rebuilds the session from the
     * persisted mirror and waits for `MediaService.init`. In a **killed**
     * process that init arrives by itself — booting the runtime re-runs your
     * module scope. In an **alive** process the module scope already ran and
     * will never run again, so without this callback the revival times out
     * after 10 s and the card's play button silently does nothing.
     *
     * ## What to do in it
     * Run exactly what your module scope runs — your idempotent "bring the
     * session up" path, ending in `MediaService.init(...)` (plus your
     * `withPersistence` wrapping and catch-up broadcasts). It is invoked only
     * while the service is actually waiting (never while an `init` is already
     * in flight or the session is up), so calling `init` from it is safe:
     *
     * ```ts
     * android: {
     *   playbackResumption: true,
     *   onRevivalRequested: () => void playback.start(),
     * }
     * ```
     *
     * ## Lifetime
     * Registered at `init` and — unlike the handlers — **retained across
     * `stopService()`**, because the window it exists for is precisely
     * "after stop, before the next init". Replaced by the next `init`;
     * dropped with the runtime on a dev reload. Never invoked on iOS, which
     * has no service to revive (see {@link playbackResumption}).
     */
    onRevivalRequested?: () => void
    /**
     * Notification accent colour as an **ARGB integer** — `0xFF1DB954`.
     *
     * Include the alpha byte: `0x1DB954` is transparent black. Applied to
     * `Notification.color` after media3 has built the notification. Android 12+
     * media shades often derive their own palette from the artwork and may
     * ignore it, so it is a hint rather than a guarantee. Ignored on iOS, which
     * has no colour surface — the lock screen's palette comes from the artwork.
     */
    notificationColor?: number
  }
  ios?: {
    /** Decoded-artwork cache capacity. @default 8 */
    artworkCacheSize?: number
    /**
     * Playback rates the lock-screen rate control offers, ascending.
     *
     * `MPChangePlaybackRateCommand.supportedPlaybackRates` is a fixed list and
     * iOS snaps the user's choice to a member of it, so an audiobook app that
     * offers 1.0/1.25/1.5/1.75/2.0/3.0 cannot say so without this.
     *
     * @default [0.5, 0.75, 1, 1.25, 1.5, 2]
     *
     * Namespaced under `ios` because there is genuinely no Android twin: media3
     * takes an arbitrary float through `COMMAND_SET_SPEED_AND_PITCH` and its
     * notification draws no rate control at all, so there is no list to hand it.
     * Setting it on Android is harmless and does nothing.
     */
    supportedPlaybackRates?: number[]
    /**
     * There is deliberately no `playbackResumption` here — see
     * {@link MediaServiceConfig.android}. iOS cannot restart a terminated app to
     * play audio; what it shares with Android is `withPersistence`, restored on
     * the next manual launch.
     */
  }
  /**
   * How far the `fastForward` control jumps, in seconds. @default 15
   *
   * Cross-platform, and top-level rather than per-platform because that is
   * exactly the point of it: before this option existed the two platforms
   * disagreed from the same JS call — iOS pinned 15 s in both directions while
   * Android set no increment and inherited media3's 5 s back / 15 s forward.
   *
   * Android: `SimpleBasePlayer.State.Builder.setSeekForwardIncrementMs`.
   * iOS: `MPSkipIntervalCommand.preferredIntervals`.
   */
  jumpForwardSeconds?: number
  /**
   * How far the `rewind` control jumps, in seconds. @default 15
   *
   * 15 — not media3's 5 — is the deliberate shared default: it matches RNTP V4
   * (`backwardJumpInterval`) and V5 (`backwardInterval`), it is what this
   * package already did on iOS, and a symmetric pair cannot surprise someone who
   * sets one and forgets the other. Podcast and audiobook apps set 30 here
   * explicitly, which is the whole reason the knob exists.
   */
  jumpBackwardSeconds?: number
  /**
   * Called when a handler method throws or rejects. Defaults to `console.error`.
   * There is no other place for the error to go — handler invocations are
   * fire-and-forget by design.
   */
  onHandlerError?: (method: keyof MediaHandler, error: unknown) => void
}

/** The broadcast + lifecycle surface returned by `MediaService.init`. */
export interface MediaServiceApi {
  /** Broadcast channel 1 of 3. */
  setPlaybackState(state: PlaybackState): void
  /**
   * Broadcast channel 2 of 3: **what is playing right now**. Omit `item` to
   * clear the metadata.
   *
   * ## Channel priority
   * When a queue is in play, this channel and {@link setQueue} both describe the
   * current track, and this one is the more specific statement — it is what you
   * send once the track is actually prepared. So for the **current entry only**,
   * and only when `item.id` matches the id at the broadcast `queueIndex`, this
   * item is merged over the queue entry field by field: a field you set here
   * wins, a field you omit falls back to the queue entry. Every other queue
   * entry is untouched.
   *
   * In practice this is how `duration` reaches the lock screen and the
   * notification: apps rarely know durations for queue items up front, so
   * `setQueue` carries none and the real duration arrives here. Without a
   * duration Android cannot draw a scrubber and iOS treats the track as a live
   * stream.
   *
   * If `item.id` does **not** match the current queue entry, the queue entry
   * wins unchanged (and both platforms log a warning once) — that combination
   * means the two broadcasts have got out of step.
   *
   * The merge, the priority order and the mismatch rule are identical on Android
   * (`Snapshot.timeline` / `enrichedWith`) and iOS (`NowPlaying.resolve`). In
   * particular, broadcasting **only** a queue plus a `queueIndex` is a complete
   * statement on both: the queue entry at that index is what the notification
   * and the lock screen show.
   */
  setMediaItem(item?: MediaItem): void
  /**
   * Broadcast channel 3 of 3: the whole queue, for controllers that render one.
   *
   * Pair it with `queueIndex` on {@link setPlaybackState} to say which entry is
   * current. Queue entries may be sparse — id and title are usually enough;
   * see {@link setMediaItem} for how the current entry gets enriched.
   */
  setQueue(items: MediaItem[]): void
  /**
   * Mirror the persisted session into native storage so Android can resume
   * playback after the process is killed. **`withPersistence` calls this for
   * you** — there is no reason for app code to.
   *
   * The argument is the serialized `PersistedSession` record, byte-identical to
   * what went into your storage engine, so the two copies cannot drift. The
   * native side keeps it in its own `SharedPreferences`, which is the only
   * thing the media service can read when it is created into a process with no
   * JavaScript in it. `undefined` forgets it.
   *
   * A no-op on iOS and whenever `android.playbackResumption` is `false`.
   */
  setResumptionSnapshot(snapshot?: string): void
  /**
   * Say that playback is coming out of **another device** right now — and hand
   * over that device's volume. Pass nothing when the phone takes it back.
   *
   * ```ts
   * // while the receiver owns playback
   * service.setRemotePlayback({ volume: receiverVolume, muted: receiverMuted })
   * // …and when the transfer back completes
   * service.setRemotePlayback()
   * ```
   *
   * Not a fourth broadcast channel — it describes the *output*, not what is
   * playing — and it is **sticky**: an ordinary `setPlaybackState` does not
   * clear it, because "the audio is on the speaker" is a mode rather than a
   * per-broadcast fact. Publish it once when the handoff completes, then again
   * whenever the remote device's volume moves (the backend's own volume events
   * — a speaker's physical knob counts).
   *
   * ## What it buys on Android: the volume keys drive the other device
   * The session starts advertising `DeviceInfo.PLAYBACK_TYPE_REMOTE`, media3
   * puts the platform session into remote volume handling
   * (`MediaSession.setPlaybackToRemote`, whose own documentation says it "must
   * be called to receive volume button events, otherwise the system will adjust
   * the appropriate stream volume for this session"), and hardware volume
   * presses arrive at {@link MediaHandler.onAdjustDeviceVolume} — with the app
   * foregrounded, backgrounded, or with the screen off. Clearing it puts the
   * keys back on the phone's own stream; there is no residue.
   *
   * Two platform preconditions apply to the **screen-off** case, both of them
   * the platform's rules rather than this library's, and both documented with
   * source citations in the package README ("Two platform conditions"):
   * the session must be actually PLAYING, and no *system*-uid sound (a
   * notification, a ringtone) may have been the last audio played locally —
   * `MediaSessionService` prefers the local stream over the chosen session in
   * that case (b/275185436), and since a remote backend plays nothing locally,
   * the press is then dropped by both devices. Foregrounded presses are immune,
   * because an `Activity` routes them to its own session by token.
   *
   * Without it the phone's music stream moves while the other device plays on,
   * which is the bug this exists to fix.
   *
   * ## iOS: a documented no-op, not a silent one
   * iOS gives an app no way to take over the hardware volume buttons —
   * `MPVolumeView` is the *system* slider, `AVAudioSession.outputVolume` is
   * read-only, and even Google's Cast SDK documents its
   * `physicalVolumeButtonsWillControlDeviceVolume` as having no effect from iOS
   * 15 on. So this call changes nothing there. Write it once, unconditionally;
   * it is free on iOS and load-bearing on Android.
   *
   * @throws {MediaSessionError} `invalidArgument` for a volume outside `0..1`,
   * a `steps` that is not a positive integer, or an unknown `volumeControl`.
   */
  setRemotePlayback(remote?: RemotePlayback): void
  /**
   * End background execution. The ONLY thing that does — `pause()` never does
   * (PLAN §5.4). After this resolves, `init` may be called again.
   */
  stopService(): Promise<void>

  /**
   * Pause playback in `seconds`, on a **native** timer. Re-arming replaces any
   * timer already set.
   *
   * Do not build this on `setTimeout`: JS timers freeze once the Activity is
   * gone (and on Samsung even before that), which is precisely when a sleep
   * timer has to work. This one is a main-looper `Handler.postDelayed` on
   * Android and a `DispatchQueue.main.asyncAfter` work item on iOS, so it is
   * unaffected by the React lifecycle.
   *
   * When it fires, playback is paused natively — the same path a notification
   * pause takes — and then {@link MediaHandler.onSleepTimer} is called. The
   * timer does not survive process death, and is cancelled by
   * {@link stopService} and by a dev reload.
   *
   * @param seconds strictly positive and finite.
   * @throws {MediaSessionError} `invalidArgument` for `0`, negatives, `NaN`,
   * `Infinity` or a non-number.
   */
  setSleepTimer(seconds: number): void
  /**
   * Pause when the **current item finishes**, on the same native timer.
   * Replaces any timer already armed.
   *
   * A separate method rather than an option object on {@link setSleepTimer}:
   * the two modes take different arguments (one takes seconds, this takes
   * nothing), and a `setSleepTimer(number | {atTrackEnd:true})` union would make
   * every call site read like a discriminated parse of its own argument.
   *
   * ## How this works without owning a player
   * From the broadcasts the app already sends. The deadline is
   * `(duration - projectedPosition) / rate` — both halves are already on the
   * `playbackState` and `mediaItem` channels — computed natively and re-armed on
   * every broadcast, so a seek, a pause, a rate change or a late-arriving
   * duration all move it. Nothing polls and nothing new crosses the bridge.
   *
   * Two cases handled without a duration at all:
   * - **the current item changes** (the track ended and the app advanced, or the
   *   user skipped) → it fires immediately, which is the honest reading of
   *   "stop after this one";
   * - **no duration was ever broadcast** (a live stream, or it has not arrived
   *   yet) → armed with no deadline, waiting for that item change.
   *   {@link getSleepTimer} reports `trackEnd` with no `remainingSeconds`
   *   rather than inventing one.
   *
   * When it fires, everything is identical to {@link setSleepTimer}: playback is
   * paused natively first, then {@link MediaHandler.onSleepTimer}.
   */
  setSleepTimerToTrackEnd(): void
  /** Disarm the sleep timer. A no-op when none is armed. */
  cancelSleepTimer(): void
  /**
   * Seconds until the sleep timer fires, or `undefined` when none is armed.
   *
   * Synchronous and cheap — meant to be polled by a visible UI, which is the
   * one place JS timers do work. Read from the platform's own timer clock, so
   * it cannot disagree with when the pause will actually happen.
   *
   * Cannot describe an end-of-track timer with no computable deadline, and
   * returns `undefined` for one — use {@link getSleepTimer} when the difference
   * between "not armed" and "armed, deadline unknown" matters, which for a UI
   * that renders a timer badge it always does.
   */
  getSleepTimerRemaining(): number | undefined
  /**
   * The armed timer's mode, and its remaining seconds when those are knowable —
   * or `undefined` when nothing is armed.
   *
   * ```ts
   * const timer = service.getSleepTimer()
   * if (timer?.mode === 'trackEnd') badge(timer.remainingSeconds ?? 'end of track')
   * ```
   */
  getSleepTimer(): SleepTimerState | undefined

  /* ------------------------- Android Auto / CarPlay ------------------------- */

  /**
   * The children of `parentId` changed — a download finished, a library synced,
   * the user signed in.
   *
   * Evicts the cached answer and tells every connected browser to ask again:
   * Android calls `MediaLibrarySession.notifyChildrenChanged`, iOS re-fetches
   * and re-sections any visible template showing that parent. Omit `parentId`
   * for "everything changed", which evicts the whole cache and notifies for
   * every parent in it plus the root.
   *
   * Cheap and safe to call when nothing is listening: with no car connected it
   * is a cache eviction and nothing else.
   */
  invalidateBrowse(parentId?: string): void
  /**
   * Is a car connected right now?
   *
   * Synchronous and cheap. The reactive twin is `useCarConnection()` from
   * `@rn-media/media-session/hooks`, which re-renders on every transition.
   */
  getCarConnection(): CarConnection
}

export type {
  MediaCapability,
  MediaControl,
  MediaCustomAction,
  MediaPlaybackStatus,
  MediaRepeatMode,
  PositionAnchor,
  RemoteVolumeControl,
  SessionErrorCode,
  SleepTimerMode,
}
