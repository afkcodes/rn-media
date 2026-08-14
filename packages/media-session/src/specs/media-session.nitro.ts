import type { HybridObject } from 'react-native-nitro-modules'

/* -------------------------------------------------------------------------- */
/*                                   Enums                                    */
/* -------------------------------------------------------------------------- */

/**
 * Coarse playback status, broadcast by the app.
 *
 * These are the five states from the spec doc. Deliberately *not* media3's
 * `Player.STATE_*` nor `AVPlayer.timeControlStatus` — this is the union the app
 * thinks in; each platform maps it to its own vocabulary
 * (see `PlaybackFacadePlayer.kt` / `NowPlaying.swift`).
 *
 * NOTE: every member of a string union becomes a native enumerator whose name
 * is the member, upper-cased with separators stripped (`skipToNext` →
 * `SKIPTONEXT`, Swift `.skiptonext`). Members must therefore stay distinct
 * case-insensitively, and must not collide with a C macro or a Swift keyword —
 * the same constraint that forced `defaultMode` in `@rn-media/audio-session`.
 */
export type MediaPlaybackStatus =
  'playing' | 'paused' | 'buffering' | 'stopped' | 'error'

/**
 * A button the app wants offered on remote surfaces.
 *
 * Android: these become the media3 notification's actions (see
 * `compactControlIndices` for the ≤3 collapsed slots). iOS: `controls` and
 * {@link MediaCapability} are unioned into the set of enabled
 * `MPRemoteCommandCenter` commands — iOS has no notion of "button layout".
 */
export type MediaControl =
  | 'play'
  | 'pause'
  | 'stop'
  | 'skipToNext'
  | 'skipToPrevious'
  /**
   * Relative moves. There is deliberately no `fastForward`/`rewind` *handler*
   * method: both platforms resolve the increment natively and deliver an
   * absolute `seekTo` (media3's `COMMAND_SEEK_FORWARD`/`_BACK` pre-compute the
   * target position; iOS's `MPSkipIntervalCommand` is applied to the projected
   * position). One less thing for every app to reimplement, and one less way
   * for the two platforms to disagree.
   */
  | 'fastForward'
  | 'rewind'
  /**
   * The repeat toggle, drawn with the icon for the **current**
   * {@link NativePlaybackState.repeatMode} — media3's `ICON_REPEAT_OFF` /
   * `ICON_REPEAT_ONE` / `ICON_REPEAT_ALL`.
   *
   * Listing it here is what actually puts the button on the Android
   * notification: `DefaultMediaNotificationProvider` draws previous / play-pause
   * / next and nothing else, so the {@link MediaCapability} alone lights up
   * Android Auto, Wear and third-party controllers (which read
   * `Player.repeatMode` directly) but leaves the phone's shade unchanged.
   *
   * Pressing it does not cycle anything by itself — it delivers
   * `setRepeatMode(next)` to the app, and the app's next broadcast is what moves
   * the state and the icon.
   *
   * Named `repeatMode` rather than the obvious `repeat` because a member becomes
   * a native enumerator verbatim, and `repeat` is a **Swift keyword** — the same
   * collision that forced `defaultMode` in `@rn-media/audio-session`. Swift may
   * well accept `.repeat` after a dot; "may well" is not something to discover
   * on a macOS CI box that this Linux dev machine cannot run.
   */
  | 'repeatMode'
  /**
   * The shuffle toggle (`ICON_SHUFFLE_ON` / `ICON_SHUFFLE_OFF`, chosen from
   * {@link NativePlaybackState.shuffleEnabled}). See {@link repeatMode}.
   */
  | 'shuffle'

/**
 * A capability the app is willing to service, independent of whether it wants a
 * button for it.
 *
 * Android: turns into a `Player.Command` on the facade player's available
 * commands. This is load-bearing — media3 never invokes a `handle*` method for
 * a command that is not in `State.availableCommands`, and controllers grey the
 * control out. iOS: turns into an enabled `MPRemoteCommand`.
 */
export type MediaCapability =
  | 'play'
  | 'pause'
  | 'stop'
  | 'seek'
  | 'skipToNext'
  | 'skipToPrevious'
  | 'skipToQueueItem'
  | 'setRate'
  /**
   * The repeat button every notification-shade music player shows.
   *
   * Android: `Player.COMMAND_SET_REPEAT_MODE` (= 15, media3 1.11.0) on the
   * facade's available commands, which is what makes media3 call
   * `SimpleBasePlayer.handleSetRepeatMode(int)` and draw the button at all.
   * iOS: `MPRemoteCommandCenter.changeRepeatModeCommand`.
   *
   * The *current* mode travels on {@link NativePlaybackState.repeatMode}; this
   * only says the app is willing to be asked to change it.
   */
  | 'setRepeatMode'
  /**
   * The shuffle button. Android: `Player.COMMAND_SET_SHUFFLE_MODE` (= 14) →
   * `handleSetShuffleModeEnabled(boolean)`. iOS:
   * `MPRemoteCommandCenter.changeShuffleModeCommand`.
   *
   * Current state travels on {@link NativePlaybackState.shuffleEnabled}.
   */
  | 'setShuffle'

/**
 * Repeat mode as every remote surface understands it.
 *
 * Deliberately three members and no integer count: this is the *session's*
 * vocabulary, and it is exactly what both platforms can express —
 * media3's `Player.REPEAT_MODE_OFF/_ONE/_ALL` (0/1/2) and MediaPlayer's
 * `MPRepeatType.off/.one/.all`. `@rn-media/player`'s richer `loopRaw` (mpv
 * accepts a repeat *count*) does not fit on a notification button and is not
 * flattened into a lie here — an app playing "repeat this track 3×" broadcasts
 * whichever of these three is the honest summary.
 */
export type MediaRepeatMode = 'off' | 'one' | 'all'

/**
 * How much of the remote device's volume the backend can actually drive.
 *
 * Maps onto the platform's `VolumeProvider` control types, which media3 derives
 * from the player's available commands
 * (`MediaSessionLegacyStub.createVolumeProviderCompat`, media3 1.11.0):
 * - `absolute` — the backend can be told a level *and* nudged a step
 *   (`COMMAND_SET_DEVICE_VOLUME` + `COMMAND_ADJUST_DEVICE_VOLUME` →
 *   `VOLUME_CONTROL_ABSOLUTE`). Cast is this. Hardware keys nudge, the system
 *   volume dialog's slider sets.
 * - `relative` — steps only (`VOLUME_CONTROL_RELATIVE`): hardware keys work,
 *   the slider does not appear.
 * - `fixed` — the level is readable but not writable (`VOLUME_CONTROL_FIXED`):
 *   the remote surfaces show it and the keys do nothing. An honest state for a
 *   receiver whose volume the sender may not touch, and the only one of the
 *   three that deliberately leaves the keys dead.
 */
export type RemoteVolumeControl = 'absolute' | 'relative' | 'fixed'

/**
 * Which shape of sleep timer is armed. See
 * {@link RnMediaMediaSession.getSleepTimer}.
 */
export type SleepTimerMode =
  /** {@link RnMediaMediaSession.setSleepTimer} — a wall-clock countdown. */
  | 'duration'
  /** {@link RnMediaMediaSession.setSleepTimerToTrackEnd}. */
  | 'trackEnd'

/* -------------------------------------------------------------------------- */
/*                                   Config                                   */
/* -------------------------------------------------------------------------- */

/** Android half of {@link MediaSessionConfig}. Ignored on iOS. */
export interface AndroidMediaSessionConfig {
  /** Notification channel id. Created on API 26+ if it does not exist. */
  notificationChannelId: string
  /** User-visible channel name, shown in system notification settings. */
  notificationChannelName: string
  /**
   * Drawable resource *name* (e.g. `'ic_notification'`) resolved out of the
   * consumer app's resources at runtime — a library cannot reference an app's
   * generated `R`.
   *
   * When absent or unresolvable, media3's own `media3_notification_small_icon`
   * is used. A small icon is never simply omitted: `Notification` throws
   * without one, and that throw would take the foreground-service start down
   * with it.
   */
  notificationIcon?: string
  /**
   * `true` (audio_service's default) → `stopForeground(STOP_FOREGROUND_DETACH)`
   * when playback pauses: the notification survives but the service is demoted
   * to background and therefore *killable*. `false` keeps the service in the
   * foreground while paused, which is more robust but consumes an ongoing
   * notification slot.
   */
  stopForegroundOnPause: boolean
  /**
   * How long a paused service stays in the foreground before media3 demotes it,
   * in **milliseconds**.
   *
   * media3 1.11 does not demote on pause; it keeps the service foreground for a
   * "user engaged" grace period —
   * `MediaSessionService.DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS`, **10 minutes** —
   * and only then applies `stopForegroundOnPause`. This maps 1:1 onto
   * `@UnstableApi public final void
   * MediaSessionService.setForegroundServiceTimeoutMs(long)`, called from the
   * service's `onCreate` (media3 1.11.0; verified by `javap` on the shipped AAR
   * and against
   * https://github.com/androidx/media/blob/1.11.0/libraries/session/src/main/java/androidx/media3/session/MediaSessionService.java#L643-L668).
   *
   * Omit to keep media3's default. `0` demotes immediately on pause.
   *
   * **10 minutes is also the ceiling.** media3 runs the value through
   * `Util.constrainValue(v, 0, DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS)`, so a
   * larger number is silently clamped down rather than honoured. Values below
   * zero are rejected here before they can be clamped up to `0` in silence.
   *
   * The trade-off runs both ways and neither end is free:
   * - **Shorter** — the process stops being protected sooner, so the OS may
   *   reclaim it (and with it the JS runtime and the app's handler) minutes
   *   after a pause. Better for battery/memory pressure; pair it with
   *   `withPersistence` so the session can be rebuilt.
   * - **Longer** — a resume from the notification is far more likely to find
   *   the runtime still alive, at the cost of holding a foreground service
   *   (and its process) for that whole window.
   *
   * Ignored on iOS: there is no service to demote.
   */
  stopForegroundTimeoutMs?: number
  /**
   * Opt in to **playback resumption after process death** (Android only).
   *
   * When `true`, the media3 service is allowed to come back from nothing: the
   * System UI resumption card, a Bluetooth reconnect or a headset play button
   * can start the service into a process with no JavaScript at all, and the
   * service will rebuild the session from a *native* mirror of the persisted
   * snapshot and then boot the React runtime behind it. See
   * `RnMediaMediaSessionService.beginRevival` and
   * {@link RnMediaMediaSession.setResumptionSnapshot}.
   *
   * Three things are required and none of them is silently substituted:
   * 1. `withPersistence(...)` — the mirror is written by it, and nothing else
   *    writes it. Without persistence there is nothing to resume.
   * 2. `MediaService.init(...)` must be reachable at **JS module scope**. A
   *    revived runtime loads the bundle but mounts no component, so an `init`
   *    inside a `useEffect` never runs and the revival is abandoned after a
   *    bounded wait (with a log saying exactly this).
   * 3. The consuming app must declare media3's `MediaButtonReceiver` in its
   *    manifest — that declaration is what makes media3 advertise resumption
   *    support to the System UI at all
   *    (`MediaSessionLegacyStub.canResumePlaybackOnStart` is literally
   *    "is there a broadcast receiver for `ACTION_MEDIA_BUTTON`").
   *
   * Default `false`: this path starts a foreground service from a process the
   * user did not open, so it stays opt-in until it has been proven on more
   * hardware than ours.
   *
   * ## Why this lives under `android` and has no iOS twin
   * The **cross-platform** half of surviving process death is `withPersistence`
   * / `restorePersisted`, which behave identically on both platforms. This flag
   * only names what *Android* can additionally do with that data: revive the
   * process by itself. iOS consumes the same record on the next **manual**
   * launch — the user opens the app and it is paused where they left it — and an
   * automatic iOS twin cannot exist, because on iOS a terminated app stays
   * terminated: force-quit is read as user intent and nothing may resurrect a
   * process for playback. That is Apple's policy, not a gap in this package.
   * See {@link IosMediaSessionConfig} for where an iOS twin would go if that
   * ever changes.
   */
  playbackResumption: boolean
  /**
   * Notification accent colour, as an **ARGB integer** (`0xFF1DB954`).
   *
   * Written straight onto `Notification.color` through a thin
   * `MediaNotification.Provider` decorator, because
   * `DefaultMediaNotificationProvider.createNotification` is `final` in media3
   * 1.11.0 (`javap` on the shipped AAR) and its `Builder` exposes channel id,
   * channel name, notification id and small icon — but no colour. Decorating
   * the provider and setting the field on the notification it returns is the
   * only public lever, and it is applied after media3 has finished building, so
   * nothing media3 does can overwrite it.
   *
   * Alpha is part of the value and is not optional: `0x1DB954` (alpha `0x00`)
   * is transparent black on some OEM shades. Write the full `0xFFRRGGBB`.
   *
   * Whether the system *uses* it is the system's decision, and it changed twice:
   * pre-Android-12 shades tint the small icon and action text with it, Android
   * 12+ media notifications derive their own palette from the artwork and may
   * ignore it entirely. It is therefore a hint, never a guarantee — the same
   * status it has in every other library that exposes it.
   *
   * Ignored on iOS: `MPNowPlayingInfoCenter` has no colour surface at all. The
   * lock screen's palette comes from the artwork, which is not ours to tint.
   */
  notificationColor?: number
}

/**
 * iOS half of {@link MediaSessionConfig}. Ignored on Android.
 *
 * ## There is deliberately no `playbackResumption` here
 * Not an oversight and not a TODO. iOS has no mechanism that can restart a
 * terminated app to play audio: force-quit (and an OS termination) is treated as
 * the user's intent that the app stop, and nothing — no media button, no Control
 * Center, no route change — may bring it back. What iOS *does* share with Android
 * is the layer underneath: `withPersistence` saves the session on both platforms
 * identically, and on iOS the next **manual** launch calls `restorePersisted` and
 * comes back paused, on the same track, at the same position.
 *
 * If Apple ever ships a resumption mechanism, this is where the flag belongs —
 * `ios.playbackResumption`, mirroring
 * {@link AndroidMediaSessionConfig.playbackResumption}. Stated here so the
 * asymmetry reads as a platform fact rather than as something to "fix" by
 * hoisting the flag out of its platform namespace.
 */
export interface IosMediaSessionConfig {
  /**
   * Maximum number of decoded artwork images kept in memory, keyed by URI.
   * Artwork decoding is off the main thread; the cache is what keeps a queue of
   * repeated covers from re-decoding on every `setMediaItem`.
   *
   * @default 8
   */
  artworkCacheSize?: number
  /**
   * Playback rates offered to the lock screen's rate control, ascending.
   *
   * `MPChangePlaybackRateCommand.supportedPlaybackRates` is a *fixed list*: iOS
   * shows the control only when there is something to show, and it snaps the
   * user's choice to a member of this array. An audiobook app that offers
   * 1.0/1.25/1.5/1.75/2.0/3.0 has no way to say so without this.
   *
   * @default [0.5, 0.75, 1, 1.25, 1.5, 2]
   *
   * ## Why there is no Android twin (checked, not assumed)
   * Nothing on the Android side takes a list. media3's speed lever is
   * `Player.COMMAND_SET_SPEED_AND_PITCH` → `setPlaybackParameters(...)`, which
   * accepts an arbitrary float; there is no "supported rates" concept anywhere
   * in `Player`, `MediaSession` or `PlaybackStateCompat` (`javap` over the
   * shipped `media3-common`/`media3-session` 1.11.0 AARs finds no such API),
   * and media3's notification draws no rate control at all — a controller that
   * wants one builds its own UI and picks its own numbers. So this is a genuine
   * platform asymmetry rather than a missing mapping, and it is namespaced under
   * `ios` for the same reason `playbackResumption` is namespaced under
   * `android`: the shape of the config should say which platform can honour it.
   *
   * Setting it on Android is harmless and does nothing.
   */
  supportedPlaybackRates?: number[]
}

/**
 * Both platform halves optional — supply only the platform you care about. The
 * cross-platform options sit at the top level.
 */
export interface MediaSessionConfig {
  android?: AndroidMediaSessionConfig
  ios?: IosMediaSessionConfig
  /**
   * How far the `fastForward` control jumps, in seconds.
   *
   * Cross-platform on purpose, and the reason this option exists at all: before
   * it, the two platforms disagreed from the same JS call. iOS pinned 15 s in
   * both directions (`RemoteCommandBinding.skipInterval`) while Android set
   * neither increment and therefore inherited media3's defaults —
   * `C.DEFAULT_SEEK_BACK_INCREMENT_MS = 5000`,
   * `C.DEFAULT_SEEK_FORWARD_INCREMENT_MS = 15000` (verified by `javap` on the
   * shipped media3 1.11.0 AAR) — so the same app skipped back 5 s on Android and
   * 15 s on iOS.
   *
   * Android: `SimpleBasePlayer.State.Builder.setSeekForwardIncrementMs(long)`,
   * which is what `COMMAND_SEEK_FORWARD` resolves against before it reaches us
   * as an absolute seek. iOS: `MPSkipIntervalCommand.preferredIntervals`.
   *
   * @default 15
   */
  jumpForwardSeconds: number
  /**
   * How far the `rewind` control jumps, in seconds. See
   * {@link jumpForwardSeconds}.
   *
   * **The shared default is 15, not media3's 5.** Picked deliberately: 15/15 is
   * what RNTP V4 (`forwardJumpInterval`/`backwardJumpInterval`) and RNTP V5
   * (`forwardInterval`/`backwardInterval`) both default to, it is what this
   * package already did on iOS, and a symmetric pair is the only default that
   * cannot surprise someone who sets one and forgets the other. Podcast and
   * audiobook apps then set 30/15 or 30/30 explicitly, which is the whole point.
   *
   * @default 15
   */
  jumpBackwardSeconds: number
}

/* -------------------------------------------------------------------------- */
/*                              Broadcast payloads                            */
/* -------------------------------------------------------------------------- */

/**
 * The position anchor. **The single most important type in this package.**
 *
 * Position is never streamed: the app broadcasts `{value, at, rate}` only on a
 * discontinuity (seek, pause, resume, rate change, track change) and every
 * surface extrapolates locally. Android feeds it to `SimpleBasePlayer`'s
 * position supplier; iOS feeds it to `MPNowPlayingInfoPropertyElapsedPlaybackTime`
 * + `...PlaybackRate`, which the system extrapolates for the lock screen.
 *
 * ## Clock domains
 * `at` is a **wall-clock** timestamp (`Date.now()`), because that is the only
 * clock JS has. Both native sides convert it into their own monotonic clock
 * *at the instant the broadcast is received*:
 *
 * ```
 * ageMs   = wallClockNow() - at          // milliseconds this anchor is stale
 * anchor  = monotonicNow() - ageMs       // same instant, monotonic domain
 * ```
 *
 * Doing the conversion once, on arrival, bounds the error to the JS→native
 * latency (sub-millisecond) instead of letting an NTP step or a suspend/resume
 * corrupt the projection forever.
 */
export interface PositionAnchor {
  /** Playback position in **milliseconds** at instant {@link at}. */
  value: number
  /** `Date.now()` when {@link value} was sampled. */
  at: number
  /**
   * Rate the position advances at from {@link at} onwards. `0` freezes the
   * projection (paused/buffering), `1` is normal speed.
   */
  rate: number
}

/** A custom action: a button with no built-in meaning. */
export interface MediaCustomAction {
  /** Opaque identifier handed back to the JS handler's `customAction`. */
  name: string
  /** User-visible label. */
  title: string
  /** Android drawable resource name. Ignored on iOS (no such surface). */
  icon?: string
}

/**
 * Everything a surface needs to render "now", except the metadata.
 *
 * Broadcast wholesale (never patched): a partial update would need a merge
 * policy on three platforms, and the app already holds the full state.
 */
export interface NativePlaybackState {
  status: MediaPlaybackStatus
  position: PositionAnchor
  /** Buffered position in ms. Omit when unknown. Android-only surface. */
  bufferedPosition?: number
  /** Buttons to offer, in order. */
  controls: MediaControl[]
  /** Commands to accept. See {@link MediaCapability}. */
  capabilities: MediaCapability[]
  customActions: MediaCustomAction[]
  /**
   * Android only: indices into {@link controls} that get the ≤3 slots of the
   * collapsed notification. Omit to let the platform take the first three.
   *
   * Not in the spec doc's sketch, which folded the two concepts together; they
   * have to be separable because Android 13+ derives the *expanded* layout from
   * the session while the compact layout stays an explicit choice
   * (audio_service calls this `androidCompactActionIndices`).
   */
  compactControlIndices?: number[]
  /**
   * Index into the last {@link RnMediaMediaSession.setQueue} array that
   * `mediaItem` corresponds to. Omit (or `-1`) when playback is not queue-backed;
   * Android then presents a single-item timeline built from the media item.
   */
  queueIndex?: number
  /** Only meaningful when `status === 'error'`. Shown by some surfaces. */
  errorMessage?: string
  /**
   * Current repeat mode, as the remote surfaces should draw it.
   *
   * Additive field: it rides the existing `playbackState` channel rather than
   * introducing a fourth one, because it is state a surface renders next to the
   * transport controls and it changes on exactly the same discontinuities.
   *
   * Only *drawn* when the app also advertises `setRepeatMode` in
   * {@link capabilities} — media3 greys out a control whose command is missing,
   * and iOS never enables a command with no target. Broadcasting a mode without
   * the capability is legal and means "this is my state, but do not offer to
   * change it".
   */
  repeatMode: MediaRepeatMode
  /** Current shuffle state. Same rules as {@link repeatMode}. */
  shuffleEnabled: boolean
}

/**
 * "Playback is coming out of some other device right now, and here is that
 * device's volume." See {@link RnMediaMediaSession.setRemotePlayback}.
 *
 * Deliberately backend-agnostic — no cast vocabulary anywhere. A Cast receiver,
 * a UPnP renderer, a proprietary multi-room protocol and a remote-controlled
 * amplifier are all the same thing to a media session: audio the phone is not
 * producing, whose loudness the phone's stream volume must therefore stop
 * pretending to control.
 */
export interface NativeRemotePlayback {
  /**
   * Current volume of the remote device, `0..1`.
   *
   * Normalised rather than expressed in the platform's integer steps because
   * `0..1` is the vocabulary every remote backend already speaks (Cast's
   * `setVolume`, UPnP's percentage) and the one the app's own slider uses. The
   * quantisation into steps is this package's job, not the app's — see
   * {@link steps}.
   */
  volume: number
  /** Whether the remote device is muted. */
  muted: boolean
  /**
   * How many discrete notches the volume rocker moves through from silent to
   * full — the *granularity* of one key press.
   *
   * Android needs a concrete integer range: `DeviceInfo.Builder.setMaxVolume`
   * plus an int `deviceVolume`, which is what the platform's `VolumeProvider`
   * reports and what one `onAdjustVolume` call moves by exactly 1.
   */
  steps: number
  /** See {@link RemoteVolumeControl}. */
  volumeControl: RemoteVolumeControl
  /**
   * Android only: the `MediaRouter2` routing-controller id of the route the
   * audio is on, when the backend knows it.
   *
   * Passed to `DeviceInfo.Builder.setRoutingControllerId`, which is how the
   * system output switcher ties the volume slider it draws to the route that
   * is actually playing. Omit when unknown — it is a refinement, not a
   * requirement.
   */
  routingControllerId?: string
}

/** Metadata for the item currently playing. */
export interface NativeMediaItem {
  /**
   * Stable id. Doubles as the media3 `MediaItem.mediaId`.
   *
   * @remarks
   * **Use a stable id per *source*, and let duplicates be duplicates.**
   *
   * ### Duplicates are legal
   * The same id may appear more than once in a queue, and it routinely does:
   * "play next" on a track that is already queued produces exactly that, and so
   * does a repeat-one-song-twice playlist. Nothing here rejects it and nothing
   * misbehaves because of it — position is carried by `queueIndex`, and media3's
   * timeline uids are built as `"$index:${item.id}"`
   * (`BroadcastPlayer.kt`), which stays unique even when the ids do not.
   *
   * ### Where the id is load-bearing
   * Two places, both of which want the id to mean "this source", not "this row":
   *
   * 1. **The channel-2 merge.** `setMediaItem` enriches the *current* queue
   *    entry field-by-field, and only when `item.id` equals the id of the entry
   *    at the broadcast `queueIndex` (`Snapshot.kt`'s `timeline`). Matching on
   *    the id at a known index is what makes the merge well-defined in the
   *    presence of duplicates — it never has to ask "which of the two copies did
   *    you mean". When the ids disagree the queue entry wins unchanged and
   *    Android logs the mismatch; that combination means the two broadcasts got
   *    out of step, and it is usually visible as a missing scrubber (the
   *    duration is the field that normally arrives only via `setMediaItem`).
   * 2. **Restoring a persisted session.** A restored record is matched back to
   *    the app's catalogue by id. An id that was minted per *insertion* rather
   *    than per source — `track-7#2`, `${id}-${Date.now()}`, an array index —
   *    does not exist any more by the time the app cold-starts, so the match
   *    fails and the session comes back blank.
   *
   * ### The rule
   * Derive the id from the thing being played (its catalogue id, or its URI) —
   * never from its position in the queue, and never uniquified with a counter
   * or a timestamp to "avoid" duplicates. Suffixing to make ids unique breaks
   * resumption and buys nothing, because nothing here needed them unique.
   */
  id: string
  title: string
  artist?: string
  album?: string
  /** `http(s)://`, `file://` or `content://`. Loaded async, never on the caller. */
  artworkUri?: string
  /**
   * Duration in ms. Omit for live/unknown.
   *
   * Broadcasting it through `setMediaItem` is enough even when the track also
   * sits in a queue: for the current entry the two channels are merged (see
   * `MediaServiceApi.setMediaItem`). Without a duration Android greys out the
   * scrubber and iOS marks the track as a live stream.
   */
  duration?: number
  genre?: string

  /* ----------------------------- Extended tags ---------------------------- */

  /**
   * Album artist — the compilation/various-artists discriminator, and a
   * different field from {@link artist} in every tag format there is.
   *
   * Android: `MediaMetadata.Builder.setAlbumArtist(CharSequence)`.
   *
   * iOS: published as `MPMediaItemPropertyAlbumArtist`, with a caveat worth
   * stating rather than hiding. `MPNowPlayingInfoCenter`'s documentation lists
   * the *subset* of `MPMediaItem` keys it supports (album title, track
   * number/count, artist, artwork, composer, disc number/count, genre, media
   * type, persistent id, duration, title) and album artist is **not** on it. The
   * key itself is real and passing it is harmless — unknown keys are ignored —
   * so it is sent for the surfaces that do read it, and no promise is made that
   * the lock screen will show it.
   */
  albumArtist?: string
  /**
   * 1-based track number within the album.
   *
   * Android: `MediaMetadata.Builder.setTrackNumber(Integer)`.
   * iOS: `MPMediaItemPropertyAlbumTrackNumber`.
   */
  trackNumber?: number
  /**
   * 1-based disc number for multi-disc releases.
   *
   * Android: `MediaMetadata.Builder.setDiscNumber(Integer)`.
   * iOS: `MPMediaItemPropertyDiscNumber`.
   */
  discNumber?: number
  /**
   * Release year, e.g. `1997`.
   *
   * Android maps to `MediaMetadata.Builder.setReleaseYear(Integer)` rather than
   * `setRecordingYear`: media3 carries both, tag formats mostly carry one, and
   * "the year on the cover" is the release year. `setRecordingYear` is left
   * unset instead of being filled with the same number, because inventing a
   * recording date we were never told is exactly the kind of quiet lie this
   * package refuses elsewhere.
   *
   * **iOS has no year key at all**, checked rather than assumed: there is no
   * `MPMediaItemPropertyYear` in any MediaPlayer header, and the one date-shaped
   * key — `MPMediaItemPropertyReleaseDate` — is an `NSDate` (a bare year is not
   * a date) *and* is absent from `MPNowPlayingInfoCenter`'s documented supported
   * subset. So on iOS this field is carried through the session and through
   * persistence and is simply not published. A synthesised `NSDate` of
   * "1 January <year>" would be a fabricated precision, which is worse than the
   * gap.
   */
  year?: number
  /**
   * A secondary line — podcast episode subtitle, audiobook chapter name, radio
   * show name.
   *
   * Android: `MediaMetadata.Builder.setSubtitle(CharSequence)`, which media3's
   * own notification reads through `getNotificationContentText`.
   * **iOS has no third line.** The complete `MPMediaItemProperty*` /
   * `MPNowPlayingInfoProperty*` key set was read for one:
   * `MPMediaItemPropertyComments` is not in the supported subset, and
   * `MPNowPlayingInfoPropertyServiceIdentifier` is documented as an opaque
   * provider-coordination id that is never displayed. The ecosystem's usual
   * workaround is to fold the subtitle into `artist` or `album`; doing that here
   * would corrupt two fields the app also sets, so this is carried through the
   * session and through persistence and not published (same as {@link year}).
   */
  subtitle?: string
  /**
   * `true` for a live stream (radio, a live event) whose position is not a
   * place in a finite thing.
   *
   * Until now the *absence of a duration* was this package's only live/unknown
   * discriminator, which conflated two different facts: "this is live" and "I do
   * not know the duration yet". This makes the first one sayable. When it is
   * `true` the surfaces stop offering a scrubber even if a duration is also
   * present — Android sets `MediaItemData.isDynamic` and drops seekability, iOS
   * sets `MPNowPlayingInfoPropertyIsLiveStream`.
   *
   * Omitted is *not* `false`: omitted keeps the old rule (live iff there is no
   * duration), so nothing that worked before changes.
   */
  isLive?: boolean
  /**
   * Opaque, app-owned key/value payload, round-tripped through the session and
   * through persistence untouched.
   *
   * Every competitor has this and the absence forces an app to keep a side table
   * keyed by {@link id} — which then has to be rebuilt after process death,
   * exactly when the app has least to work with.
   *
   * **String values only**, deliberately. Nitro would happily carry
   * `Record<string, AnyValue>`, but the two destinations cannot: Android puts
   * these in a `MediaMetadata` `Bundle` that crosses a binder to third-party
   * controllers, and the record is serialized to JSON by `withPersistence`.
   * A string map survives both without a type-erasure story; anything richer
   * would need one and would still arrive back as `unknown`. Stringify at the
   * edge and the round trip is total.
   *
   * On iOS this is carried and persisted but not published: MediaPlayer has no
   * arbitrary-payload key (the two opaque string keys it does have —
   * `MPNowPlayingInfoPropertyExternalContentIdentifier` and
   * `MPNowPlayingInfoCollectionIdentifier` — both have defined system meanings
   * and are not extras). That is the *point* of the field either way: it exists
   * so the app gets its own data back, not so the OS renders it.
   */
  extras?: Record<string, string>
}

/**
 * What the sleep timer is doing right now.
 *
 * Returned instead of a bare number so the two modes stay distinguishable: a
 * `trackEnd` timer with an unknown deadline (a live stream, or a track whose
 * duration the app has not broadcast yet) is armed and *will* fire, and there is
 * no number that says that — `undefined` would read as "not armed" and `0` as
 * "about to fire".
 */
export interface NativeSleepTimerState {
  mode: SleepTimerMode
  /**
   * Seconds until it fires, when that is knowable.
   *
   * Always present for `duration`. Present for `trackEnd` only while the current
   * item has a duration and playback is advancing; omitted otherwise, which
   * means "armed, deadline not computable yet".
   */
  remainingSeconds?: number
}

/* -------------------------------------------------------------------------- */
/*                              Handler callbacks                             */
/* -------------------------------------------------------------------------- */

/**
 * The fan-in surface: one callback per remote command, supplied once at
 * {@link RnMediaMediaSession.initialize}.
 *
 * A single struct of callbacks rather than ten `setXHandler` methods: nitrogen
 * turns each function type into a `Func_*` wrapper either way, and one struct
 * makes "the handler set is replaced atomically" true by construction.
 *
 * All of them are **required** — an optional callback would push "did the app
 * implement this?" into native, when the answer is already carried by
 * {@link NativePlaybackState.capabilities}. `BaseMediaHandler` supplies no-ops.
 *
 * ## Contract
 * - Callbacks return `void`, not a promise. Native dispatches and returns
 *   immediately — a remote command must never wait on JS (that is an ANR on
 *   Android and a dropped command on iOS). The *acknowledgement* is the app's
 *   next `setPlaybackState` broadcast, which is also what completes media3's
 *   pending-operation future.
 * - Nitro schedules the JS invocation onto the JS thread itself, so native may
 *   call these from a binder thread, the media3 application looper, or a
 *   `MPRemoteCommandCenter` target
 *   (https://nitro.margelo.com/docs/types/callbacks).
 */
export interface MediaSessionHandlers {
  play: () => void
  pause: () => void
  stop: () => void
  /** @param position milliseconds */
  seekTo: (position: number) => void
  skipToNext: () => void
  skipToPrevious: () => void
  /** @param index index into the last broadcast queue */
  skipToQueueItem: (index: number) => void
  setRate: (rate: number) => void
  /**
   * A remote surface asked for a different repeat mode.
   *
   * A *request*, not a notification: nothing has changed until the app changes
   * it and says so with a `setPlaybackState` carrying the new
   * {@link NativePlaybackState.repeatMode}. Same contract as `play`/`pause` —
   * the app's next broadcast is the acknowledgement, which is also what
   * completes media3's pending-operation future.
   */
  setRepeatMode: (mode: MediaRepeatMode) => void
  /** A remote surface asked to turn shuffle on or off. See {@link setRepeatMode}. */
  setShuffle: (enabled: boolean) => void
  /**
   * A remote surface asked for an absolute volume on the **remote device**,
   * `0..1`.
   *
   * Only reachable while {@link RnMediaMediaSession.setRemotePlayback} has
   * published a `volumeControl: 'absolute'` device — the system volume dialog's
   * slider, the output switcher, a `MediaController`. Same request/acknowledge
   * contract as every other command: the app moves the backend and republishes
   * through `setRemotePlayback`.
   */
  setDeviceVolume: (volume: number) => void
  /**
   * A remote surface asked for **one notch louder** on the remote device.
   *
   * This — not {@link setDeviceVolume} — is what a hardware volume key press
   * becomes: the platform delivers `VolumeProvider.onAdjustVolume(+1)`, media3
   * turns it into `Player.increaseDeviceVolume(flags)`, and the facade lands
   * here. One notch is `1 / steps` of the published range.
   *
   * Two callbacks rather than one direction argument, deliberately: it is the
   * exact shape media3 hands us (`handleIncreaseDeviceVolume` /
   * `handleDecreaseDeviceVolume`) and it needs no new enum on the bridge. The
   * TS layer folds the pair back into one `onAdjustDeviceVolume('up'|'down')`.
   */
  increaseDeviceVolume: () => void
  /** One notch quieter. See {@link increaseDeviceVolume}. */
  decreaseDeviceVolume: () => void
  /** A remote surface asked to mute or unmute the remote device. */
  setDeviceMuted: (muted: boolean) => void
  /**
   * Android only: the app's task was swiped out of Recents.
   *
   * Always invoked *in addition to* the built-in default policy so the JS side
   * can react (persist state, analytics); the default policy itself lives in
   * native so it still runs when JS is wedged. See
   * `RnMediaMediaSessionService.onTaskRemoved`.
   */
  onTaskRemoved: () => void
  /**
   * @param name  {@link MediaCustomAction.name}
   * @param extras JSON object string, `'{}'` when there are none. A JSON string
   * rather than a map because the Android payload is an arbitrary `Bundle` from
   * a third-party `MediaController`; flattening it once, in native, keeps the
   * bridge type trivial and the failure mode visible.
   */
  customAction: (name: string, extras: string) => void
  /**
   * The sleep timer set by {@link RnMediaMediaSession.setSleepTimer} elapsed.
   *
   * **The pause has already happened** by the time this runs — natively, on the
   * same path a notification pause takes (ARCHITECTURE §9). This callback is a
   * *notification*, not a request: it is where an app clears its own timer UI,
   * logs, fades out, or calls `stopService()`. Doing nothing is correct.
   *
   * Fired at most once per armed timer, and never after
   * {@link RnMediaMediaSession.cancelSleepTimer}.
   */
  onSleepTimer: () => void
  /**
   * Android only: this JS runtime was booted **by the media service**, to
   * finish a playback resumption that had already started without it.
   *
   * Fired once, immediately after the handlers are installed and before any
   * command deferred during the revival is replayed. Purely informational —
   * the notification is already up, the session already carries the persisted
   * track, and the `play` the user pressed is replayed on your handler a beat
   * later whether or not you implement this.
   */
  onPlaybackResumption: () => void
  /**
   * Android only: a revival started while this JS runtime was **already
   * alive**, and the service needs `initialize` to be called again before it
   * can hand the session over.
   *
   * The one caller is `RnMediaMediaSessionService.onRuntimeReady`, and the one
   * scenario is stop-then-resume without a process death: `stopService()` tore
   * the session down (handlers cleared, service stopped), the System UI's
   * resumption card or a media button starts the service again, and the
   * runtime it finds is the same one that already ran its module scope — so
   * the module-scope `init` that saves a *cold* revival can never run again.
   * This callback is how native asks the live runtime to re-initialize.
   *
   * Unlike every other member of this struct, native retains it **across
   * `stopService`** (see `MediaSessionController.revivalRequester`): it exists
   * precisely for the window in which the ordinary handlers are gone. It is
   * dropped when the runtime itself is torn down (dev reload), which is the
   * only point it could dangle.
   *
   * The TS layer routes it to `MediaServiceConfig.android.onRevivalRequested`
   * and swallows it while `init` is idle-less (already initializing or ready),
   * so a cold revival — where module-scope `init` is already in flight when
   * the runtime-ready signal fires — never double-initializes.
   */
  onRevivalRequested: () => void
}

/* -------------------------------------------------------------------------- */
/*                               Hybrid Object                                */
/* -------------------------------------------------------------------------- */

/**
 * The process-wide media session.
 *
 * A singleton by nature, not by convenience: `MediaSessionService` and
 * `MPNowPlayingInfoCenter` are both process-singular (CLAUDE.md principle 5's
 * documented exception).
 *
 * Named `initialize` rather than `init` because `init` is a Swift keyword and
 * nitrogen emits the method name verbatim into the generated Swift protocol.
 */
export interface RnMediaMediaSession extends HybridObject<{
  ios: 'swift'
  android: 'kotlin'
}> {
  /**
   * Install the handlers and platform configuration.
   *
   * Android: creates the notification channel and the `MediaLibrarySession`
   * (bound to a facade `SimpleBasePlayer`). It does **not** start the
   * foreground service — that happens on the first `play` while the app is
   * startable, per the Android 12+ background-FGS-start restriction.
   * iOS: installs `MPRemoteCommandCenter` targets.
   *
   * Rejects when called twice without an intervening {@link stopService}.
   */
  initialize(
    config: MediaSessionConfig,
    handlers: MediaSessionHandlers
  ): Promise<void>

  /** Broadcast channel 1 of 3. See {@link NativePlaybackState}. */
  setPlaybackState(state: NativePlaybackState): void

  /** Broadcast channel 2 of 3. Pass nothing to clear the metadata. */
  setMediaItem(item?: NativeMediaItem): void

  /** Broadcast channel 3 of 3. Pass `[]` to clear the queue. */
  setQueue(items: NativeMediaItem[]): void

  /**
   * Mirror the persisted session into **native-owned** storage, for Android
   * playback resumption.
   *
   * Not a fourth broadcast channel and not an app-facing call: `withPersistence`
   * invokes this with the very same JSON record it hands the app's storage
   * engine, so the two copies cannot drift. Pass `undefined` to forget it.
   *
   * ## Why a native mirror exists at all
   * The whole point of playback resumption is that it works **with no
   * JavaScript in the process**. The service is created by the OS, has ~5 s to
   * call `startForeground`, and must already know what track to show. Reading
   * the app's storage engine is not an option: that engine is JavaScript, and
   * JavaScript is precisely what is missing. So the record is also written to
   * `SharedPreferences` owned by this package — survives process death, read
   * back **synchronously** on the service's main thread, no bridge involved
   * (ARCHITECTURE §9, native-first).
   *
   * The JS-side storage stays the app-facing source of truth; this is a cache
   * that only the resumption path reads. Ignored on iOS, which has no service
   * to resurrect.
   *
   * @param snapshot the serialized `PersistedSession` record, or `undefined`.
   */
  setResumptionSnapshot(snapshot?: string): void

  /**
   * Declare that playback is currently coming out of **another device**, and
   * carry that device's volume — or pass nothing to say it is local again.
   *
   * Not a fourth broadcast channel: it says nothing about what is playing. It
   * is a *routing* statement, in the same family as
   * {@link setResumptionSnapshot} — the session needs it, no surface renders
   * the app's playback state from it, and it is sticky (a `setPlaybackState`
   * does not clear it) because "the audio is on the speaker" is a mode, not a
   * per-broadcast fact.
   *
   * ## Android: this is what makes hardware volume keys reach the speaker
   * The facade `Player` starts reporting `DeviceInfo.PLAYBACK_TYPE_REMOTE`
   * with the published range, and advertises `COMMAND_GET_DEVICE_VOLUME` plus
   * the set/adjust commands implied by
   * {@link NativeRemotePlayback.volumeControl}. media3's
   * `MediaSessionLegacyStub` reacts to the `DeviceInfo` change by calling
   * `MediaSessionCompat.setPlaybackToRemote(volumeProvider)` on the platform
   * session — and the platform's own contract for that call is the whole
   * feature:
   *
   * > Configure this session to use remote volume handling. **This must be
   * > called to receive volume button events**, otherwise the system will
   * > adjust the appropriate stream volume for this session.
   * > — `android.media.session.MediaSession.setPlaybackToRemote`
   *
   * Because the routing lives on the *session*, it works with the app
   * backgrounded and the screen locked, which is exactly where an Activity's
   * `dispatchKeyEvent` cannot help. Presses arrive at
   * {@link MediaSessionHandlers.increaseDeviceVolume} /
   * {@link MediaSessionHandlers.decreaseDeviceVolume}.
   *
   * Passing nothing restores local handling: media3 sees the `DeviceInfo` go
   * back to `PLAYBACK_TYPE_LOCAL` and calls `setPlaybackToLocal`, after which
   * the keys move the phone's music stream again. There is no state left
   * behind — the transition is driven by the same value both ways.
   *
   * ## iOS: honestly, nothing
   * A no-op, and not for lack of trying: iOS gives an app no way to take over
   * the hardware volume buttons. `MPVolumeView` renders the *system* volume
   * slider, `AVAudioSession.outputVolume` is read-only, and Google's own
   * `GCKUICastContainerViewController.physicalVolumeButtonsWillControlDeviceVolume`
   * is documented as having no effect since iOS 15. The buttons therefore keep
   * controlling the phone. Calling this on iOS is harmless and free — the same
   * app code runs on both platforms — it simply changes nothing there.
   */
  setRemotePlayback(remote?: NativeRemotePlayback): void

  /**
   * End background execution.
   *
   * Android: releases the session and stops the foreground service. This is the
   * ONLY thing that does — `pause()` never does (PLAN §5.4).
   * iOS: clears the now-playing info and disables every remote command; the
   * process then lives or dies on whether audio is still playing.
   */
  stopService(): Promise<void>

  /* ------------------------------- Sleep timer ------------------------------ */

  /**
   * Pause playback in `seconds`. Replaces any timer already armed.
   *
   * ## Why this is native and not `setTimeout`
   * A JS sleep timer is broken by construction on Android: RN's
   * `JavaTimerManager` gates timers on the Activity lifecycle plus headless
   * tasks, so with no Activity they simply stop firing — and Samsung freezes
   * them even *with* one (RN #56324). A sleep timer is the one feature whose
   * entire job happens after the user has put the phone down, i.e. exactly when
   * JS timers do not run. So it lives on a platform timer: a main-looper
   * `Handler.postDelayed` on Android, a `DispatchQueue.main.asyncAfter` work
   * item on iOS. Neither is tied to an Activity, and neither is a JS timer.
   *
   * ## What happens when it fires
   * 1. **Playback is paused natively**, on the identical path a notification
   *    pause takes — the facade `Player` is paused, so the session, the
   *    notification and the lock screen all go to `paused` immediately, and the
   *    app's `pause` handler is invoked to actually stop the audio.
   * 2. {@link MediaSessionHandlers.onSleepTimer} is invoked fire-and-forget.
   *
   * The timer is armed even with no Activity alive; it does **not** survive
   * process death (nothing does — see the README's background-playback limits)
   * and it is cancelled by {@link stopService} and by a dev reload.
   *
   * iOS note, stated honestly: iOS suspends a backgrounded process shortly
   * after audio *stops*, and a suspended process runs no timers. That is not a
   * problem for this feature — while audio is playing the process is not
   * suspended, so a timer armed during playback fires. What cannot be relied on
   * is a timer armed (or still pending) while nothing is playing.
   *
   * @param seconds strictly positive; the TS layer rejects `0`, negatives and
   * non-finite values before they reach here.
   */
  setSleepTimer(seconds: number): void

  /**
   * Pause when the **current item finishes**. Replaces any timer already armed.
   *
   * The mode most sleep-timer users actually want, and the one a JS timer
   * cannot express even in the foreground: "30 minutes" cuts a track in half,
   * "end of this track" does not.
   *
   * ## How a package with no playback engine knows when a track ends
   * From the three broadcast channels, which is all it ever knows — and that is
   * enough, because they already carry the two numbers involved: the position
   * anchor (`{value, at, rate}`) and the current item's `duration`. The deadline
   * is `(duration - projectedPosition) / rate`, computed natively and **re-armed
   * on every broadcast**, so a seek, a pause, a rate change or a duration that
   * arrives late all move it. No polling, no timer on the JS side, nothing
   * streamed across the bridge — the existing discontinuity-only contract is
   * exactly the update rate this needs.
   *
   * Two cases it handles without a duration at all:
   * - **The current item changes** (the track ended and the app advanced, or the
   *   user skipped) — the timer fires immediately. That is the honest reading of
   *   "stop after this one", and it is what makes the feature work on a live
   *   stream or before a duration is known.
   * - **The app never broadcasts a duration** — armed with no deadline, waiting
   *   for the item change above. {@link getSleepTimer} reports `trackEnd` with
   *   no `remainingSeconds` rather than pretending.
   *
   * When it fires the behaviour is identical to {@link setSleepTimer}: playback
   * is paused natively first, then {@link MediaSessionHandlers.onSleepTimer}.
   */
  setSleepTimerToTrackEnd(): void

  /** Disarm the sleep timer. A no-op when none is armed. */
  cancelSleepTimer(): void

  /**
   * Seconds until the armed timer fires, or `undefined` when none is armed.
   *
   * Read from **the same clock the timer was scheduled against** —
   * `SystemClock.uptimeMillis()` on Android (what `Handler.postDelayed` uses)
   * and `DispatchTime.now()` on iOS — so it can never disagree with when the
   * pause will actually happen, and a wall-clock change cannot move it.
   * Synchronous and cheap: it is meant to be polled by a UI that is on screen,
   * which is the one place a JS timer *does* work.
   */
  getSleepTimerRemaining(): number | undefined

  /**
   * The armed timer's mode and — when knowable — its remaining seconds, or
   * `undefined` when none is armed.
   *
   * The structured form of {@link getSleepTimerRemaining}, which cannot describe
   * a `trackEnd` timer whose deadline is not yet computable. Same clock, same
   * synchronous cheapness.
   */
  getSleepTimer(): NativeSleepTimerState | undefined
}
