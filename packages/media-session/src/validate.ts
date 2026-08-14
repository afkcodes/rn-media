import { invalidArgument } from './errors'
import type {
  MediaCapability,
  MediaControl,
  MediaCustomAction,
  MediaPlaybackStatus,
  MediaRepeatMode,
  MediaSessionConfig,
  NativeMediaItem,
  NativePlaybackState,
  NativeRemotePlayback,
  PositionAnchor,
  RemoteVolumeControl,
} from './specs/media-session.nitro'
import type {
  MediaItem,
  MediaServiceConfig,
  PlaybackState,
  RemotePlayback,
} from './types'

/**
 * Android's collapsed media notification has three action slots. media3 will
 * silently drop the overflow; we would rather the app hear about it.
 *
 * https://developer.android.com/media/media3/session/background-playback
 */
export const MAX_COMPACT_CONTROLS = 3

const STATUSES: readonly MediaPlaybackStatus[] = [
  'playing',
  'paused',
  'buffering',
  'stopped',
  'error',
]

const CONTROLS: readonly MediaControl[] = [
  'play',
  'pause',
  'stop',
  'skipToNext',
  'skipToPrevious',
  'fastForward',
  'rewind',
  'repeatMode',
  'shuffle',
]

const CAPABILITIES: readonly MediaCapability[] = [
  'play',
  'pause',
  'stop',
  'seek',
  'skipToNext',
  'skipToPrevious',
  'skipToQueueItem',
  'setRate',
  'setRepeatMode',
  'setShuffle',
]

const REPEAT_MODES: readonly MediaRepeatMode[] = ['off', 'one', 'all']

const VOLUME_CONTROLS: readonly RemoteVolumeControl[] = [
  'absolute',
  'relative',
  'fixed',
]

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function assertFinite(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidArgument(
      `${field} must be a finite number, got ${String(value)}.`
    )
  }
}

function assertMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): asserts value is T {
  if (
    typeof value !== 'string' ||
    !(allowed as readonly string[]).includes(value)
  ) {
    throw invalidArgument(
      `${field} must be one of ${allowed.join(', ')} — got ${JSON.stringify(value)}.`
    )
  }
}

function assertNonEmptyString(
  value: unknown,
  field: string
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidArgument(`${field} must be a non-empty string.`)
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Anchor                                   */
/* -------------------------------------------------------------------------- */

/**
 * The anchor is the one payload whose garbage is *invisible* until a user
 * stares at a lock screen counting backwards, so it is validated hardest.
 */
export function validateAnchor(
  anchor: PositionAnchor,
  field = 'position'
): PositionAnchor {
  if (anchor == null || typeof anchor !== 'object') {
    throw invalidArgument(`${field} must be a { value, at, rate } object.`)
  }

  assertFinite(anchor.value, `${field}.value`)
  assertFinite(anchor.at, `${field}.at`)
  assertFinite(anchor.rate, `${field}.rate`)

  if (anchor.value < 0) {
    throw invalidArgument(`${field}.value must be >= 0, got ${anchor.value}.`)
  }
  if (anchor.at <= 0) {
    throw invalidArgument(
      `${field}.at must be a positive epoch timestamp (Date.now()), got ${anchor.at}.`
    )
  }
  if (anchor.rate < 0) {
    // Negative rates would make both `PositionSupplier.getExtrapolating` and
    // `MPNowPlayingInfoPropertyPlaybackRate` run the clock backwards. No remote
    // surface renders that usefully; scrub instead.
    throw invalidArgument(`${field}.rate must be >= 0, got ${anchor.rate}.`)
  }
  return { value: anchor.value, at: anchor.at, rate: anchor.rate }
}

/* -------------------------------------------------------------------------- */
/*                                 Media item                                 */
/* -------------------------------------------------------------------------- */

/**
 * A 1-based ordinal (track/disc number) or a year.
 *
 * Rejected rather than rounded: `trackNumber: 2.5` is a bug in the caller, and
 * media3's `setTrackNumber(Integer)` / `MPMediaItemPropertyAlbumTrackNumber`
 * would both silently truncate it into a plausible-looking wrong answer.
 */
function assertPositiveInteger(value: unknown, field: string): void {
  assertFinite(value, field)
  if (!Number.isInteger(value) || value <= 0) {
    throw invalidArgument(
      `${field} must be a positive integer, got ${String(value)}.`
    )
  }
}

/**
 * `extras` is a **string→string** map on purpose (see `NativeMediaItem.extras`):
 * it has to survive an Android `Bundle` across a binder *and* a JSON round trip
 * through `withPersistence`. A number or a nested object here would cross the
 * bridge as something the app did not put in, or not at all — so it is rejected
 * at the choke point rather than discovered on a device.
 */
function validateExtras(
  extras: Record<string, string>,
  field: string
): Record<string, string> {
  if (extras == null || typeof extras !== 'object' || Array.isArray(extras)) {
    throw invalidArgument(`${field} must be an object of string values.`)
  }
  for (const [key, value] of Object.entries(extras)) {
    if (typeof value !== 'string') {
      throw invalidArgument(
        `${field}["${key}"] must be a string — extras cross a native Bundle and a ` +
          `JSON round trip, so values are stringified by the app, not by us. ` +
          `Got ${typeof value}.`
      )
    }
  }
  return extras
}

export function validateMediaItem(
  item: MediaItem,
  field = 'mediaItem'
): NativeMediaItem {
  if (item == null || typeof item !== 'object') {
    throw invalidArgument(`${field} must be an object.`)
  }
  assertNonEmptyString(item.id, `${field}.id`)
  assertNonEmptyString(item.title, `${field}.title`)

  if (item.duration !== undefined) {
    assertFinite(item.duration, `${field}.duration`)
    if (item.duration < 0) {
      throw invalidArgument(
        `${field}.duration must be >= 0, got ${item.duration}.`
      )
    }
  }

  if (item.trackNumber !== undefined) {
    assertPositiveInteger(item.trackNumber, `${field}.trackNumber`)
  }
  if (item.discNumber !== undefined) {
    assertPositiveInteger(item.discNumber, `${field}.discNumber`)
  }
  if (item.year !== undefined) {
    assertPositiveInteger(item.year, `${field}.year`)
  }
  if (item.isLive !== undefined && typeof item.isLive !== 'boolean') {
    throw invalidArgument(
      `${field}.isLive must be a boolean, got ${JSON.stringify(item.isLive)}.`
    )
  }
  if (item.extras !== undefined) {
    validateExtras(item.extras, `${field}.extras`)
  }
  return item
}

export function validateQueue(items: MediaItem[]): NativeMediaItem[] {
  if (!Array.isArray(items)) {
    throw invalidArgument('queue must be an array of media items.')
  }
  return items.map((item, index) => validateMediaItem(item, `queue[${index}]`))
}

/* -------------------------------------------------------------------------- */
/*                              Playback state                                */
/* -------------------------------------------------------------------------- */

function validateCustomActions(
  actions: MediaCustomAction[]
): MediaCustomAction[] {
  if (!Array.isArray(actions)) {
    throw invalidArgument('playbackState.customActions must be an array.')
  }
  const seen = new Set<string>()
  for (const [index, action] of actions.entries()) {
    assertNonEmptyString(
      action?.name,
      `playbackState.customActions[${index}].name`
    )
    assertNonEmptyString(
      action.title,
      `playbackState.customActions[${index}].title`
    )
    if (seen.has(action.name)) {
      // Duplicates make `customAction(name)` ambiguous on the way back in.
      throw invalidArgument(
        `playbackState.customActions has a duplicate name "${action.name}".`
      )
    }
    seen.add(action.name)
  }
  return actions
}

function validateCompactIndices(
  indices: number[],
  controlCount: number
): number[] {
  if (!Array.isArray(indices)) {
    throw invalidArgument(
      'playbackState.compactControlIndices must be an array.'
    )
  }
  if (indices.length > MAX_COMPACT_CONTROLS) {
    throw invalidArgument(
      `playbackState.compactControlIndices accepts at most ${MAX_COMPACT_CONTROLS} ` +
        `entries (Android's collapsed notification has that many slots), got ${indices.length}.`
    )
  }
  for (const index of indices) {
    assertFinite(index, 'playbackState.compactControlIndices[]')
    if (!Number.isInteger(index) || index < 0 || index >= controlCount) {
      throw invalidArgument(
        `playbackState.compactControlIndices contains ${index}, which is not a valid ` +
          `index into controls (length ${controlCount}).`
      )
    }
  }
  return indices
}

/**
 * Validate and fill in a {@link PlaybackState}, producing the exact struct the
 * bridge wants. The single choke point: nothing reaches native un-validated.
 */
export function normalizePlaybackState(
  state: PlaybackState
): NativePlaybackState {
  if (state == null || typeof state !== 'object') {
    throw invalidArgument('playbackState must be an object.')
  }
  assertMember(state.status, STATUSES, 'playbackState.status')

  const controls = state.controls ?? []
  if (!Array.isArray(controls)) {
    throw invalidArgument('playbackState.controls must be an array.')
  }
  for (const control of controls) {
    assertMember(control, CONTROLS, 'playbackState.controls[]')
  }

  const capabilities = state.capabilities ?? []
  if (!Array.isArray(capabilities)) {
    throw invalidArgument('playbackState.capabilities must be an array.')
  }
  for (const capability of capabilities) {
    assertMember(capability, CAPABILITIES, 'playbackState.capabilities[]')
  }

  if (state.bufferedPosition !== undefined) {
    assertFinite(state.bufferedPosition, 'playbackState.bufferedPosition')
    if (state.bufferedPosition < 0) {
      throw invalidArgument('playbackState.bufferedPosition must be >= 0.')
    }
  }

  if (state.queueIndex !== undefined) {
    assertFinite(state.queueIndex, 'playbackState.queueIndex')
    if (!Number.isInteger(state.queueIndex) || state.queueIndex < -1) {
      throw invalidArgument(
        `playbackState.queueIndex must be an integer >= -1 (-1 meaning "not queue-backed"), ` +
          `got ${state.queueIndex}.`
      )
    }
  }

  if (state.repeatMode !== undefined) {
    assertMember(state.repeatMode, REPEAT_MODES, 'playbackState.repeatMode')
  }
  if (
    state.shuffleEnabled !== undefined &&
    typeof state.shuffleEnabled !== 'boolean'
  ) {
    throw invalidArgument(
      `playbackState.shuffleEnabled must be a boolean, got ` +
        `${JSON.stringify(state.shuffleEnabled)}.`
    )
  }

  return {
    status: state.status,
    position: validateAnchor(state.position, 'playbackState.position'),
    bufferedPosition: state.bufferedPosition,
    controls,
    capabilities,
    customActions: validateCustomActions(state.customActions ?? []),
    compactControlIndices:
      state.compactControlIndices === undefined
        ? undefined
        : validateCompactIndices(state.compactControlIndices, controls.length),
    queueIndex: state.queueIndex,
    errorMessage: state.errorMessage,
    // Defaulted rather than passed through undefined: unlike
    // `stopForegroundTimeoutMs` there is no platform default to defer to — both
    // sides need a concrete repeat mode and shuffle flag to build their state,
    // and "off"/false is what every surface showed before these fields existed.
    // That makes an app that never sets them behave exactly as it did.
    repeatMode: state.repeatMode ?? DEFAULT_REPEAT_MODE,
    shuffleEnabled: state.shuffleEnabled ?? DEFAULT_SHUFFLE_ENABLED,
  }
}

/** What every surface showed before `repeatMode` existed. */
export const DEFAULT_REPEAT_MODE: MediaRepeatMode = 'off'
/** What every surface showed before `shuffleEnabled` existed. */
export const DEFAULT_SHUFFLE_ENABLED = false

/* -------------------------------------------------------------------------- */
/*                              Remote playback                               */
/* -------------------------------------------------------------------------- */

/**
 * Notches a hardware volume key press moves through when the app says nothing.
 *
 * 20 is not invented here: it is `RemoteCastPlayer.MAX_VOLUME` in media3 1.11.0
 * — the step count media3's own Cast player reports through
 * `DeviceInfo.Builder.setMaxVolume` — so an app that does not choose gets the
 * granularity Android users already feel from every other cast-enabled app.
 *
 * Exported so an app can say "half the usual granularity" without hard-coding
 * the number, and so a test can assert the parity.
 */
export const DEFAULT_REMOTE_VOLUME_STEPS = 20

/**
 * What a remote backend is assumed able to do with its volume.
 *
 * `absolute` because every network audio target worth naming (Cast, UPnP/DLNA,
 * Sonos) takes a level, and because it is the only value that lights up *both*
 * the hardware keys and the system volume dialog's slider. A backend that can
 * only be nudged says `relative`; one that cannot be driven at all says
 * `fixed`, which deliberately leaves the keys dead rather than pretending.
 */
export const DEFAULT_REMOTE_VOLUME_CONTROL: RemoteVolumeControl = 'absolute'

/**
 * Validate and fill in a {@link RemotePlayback}.
 *
 * Volume is `0..1` and out-of-range is **rejected, not clamped**: a `47` here is
 * an app that mixed up its scales (a percentage, or the platform's integer
 * notches), and silently clamping it to "full" would be a wrong answer that
 * looks deliberate on a lock screen. The same reasoning as
 * `validateAnchor` — the payload's garbage is otherwise invisible.
 */
export function normalizeRemotePlayback(
  remote: RemotePlayback
): NativeRemotePlayback {
  if (remote == null || typeof remote !== 'object') {
    throw invalidArgument(
      'remotePlayback must be a { volume, ... } object, or undefined to say ' +
        'playback is local again.'
    )
  }
  assertFinite(remote.volume, 'remotePlayback.volume')
  if (remote.volume < 0 || remote.volume > 1) {
    throw invalidArgument(
      `remotePlayback.volume must be between 0 and 1, got ${remote.volume}. ` +
        `It is a normalised level, not a percentage and not the platform's ` +
        `integer notches — those come from remotePlayback.steps.`
    )
  }
  if (remote.muted !== undefined && typeof remote.muted !== 'boolean') {
    throw invalidArgument(
      `remotePlayback.muted must be a boolean, got ${JSON.stringify(remote.muted)}.`
    )
  }
  if (remote.steps !== undefined) {
    assertFinite(remote.steps, 'remotePlayback.steps')
    if (!Number.isInteger(remote.steps) || remote.steps <= 0) {
      throw invalidArgument(
        `remotePlayback.steps must be a positive integer (how many notches one ` +
          `volume key press moves through), got ${remote.steps}.`
      )
    }
  }
  if (remote.volumeControl !== undefined) {
    assertMember(
      remote.volumeControl,
      VOLUME_CONTROLS,
      'remotePlayback.volumeControl'
    )
  }
  if (remote.routingControllerId !== undefined) {
    assertNonEmptyString(
      remote.routingControllerId,
      'remotePlayback.routingControllerId'
    )
  }

  return {
    volume: remote.volume,
    muted: remote.muted ?? false,
    steps: remote.steps ?? DEFAULT_REMOTE_VOLUME_STEPS,
    volumeControl: remote.volumeControl ?? DEFAULT_REMOTE_VOLUME_CONTROL,
    routingControllerId: remote.routingControllerId,
  }
}

/**
 * The volume one hardware key press lands on, as a normalised `0..1` level.
 *
 * The library's own fallback for an app that implements
 * `MediaHandler.onSetDeviceVolume` but not `onAdjustDeviceVolume` — which is
 * the common case, because an absolute backend has no "nudge" call to wrap. A
 * notch is `1 / steps`, applied to the last published volume and clamped, so
 * the arithmetic lives in one tested place rather than in every app.
 *
 * Pure on purpose: the whole of the fallback's behaviour is this function.
 */
export function stepRemoteVolume(
  volume: number,
  steps: number,
  direction: 1 | -1
): number {
  // Onto the notch grid first, then exactly one notch — which is what the
  // platform itself does with its integer device volume, and what keeps a
  // rocker press feeling identical whether the level came from our own slider
  // or from the speaker's physical knob (which lands anywhere).
  const notches = Math.round(volume * steps)
  const next = Math.min(steps, Math.max(0, notches + direction))
  return next / steps
}

/* -------------------------------------------------------------------------- */
/*                                 Sleep timer                                */
/* -------------------------------------------------------------------------- */

/**
 * Validate a sleep-timer duration.
 *
 * Strictly positive: `0` is rejected rather than treated as "fire now" because
 * the two plausible readings — "pause immediately" and "cancel" — are both
 * already spelled out (`pause()` and `cancelSleepTimer()`), and picking one
 * silently would make the other a bug that only shows up on a device with the
 * screen off. `NaN`/`Infinity` are rejected here rather than downstream, where
 * `NaN * 1000` becomes a `Long` of 0 on Android and a timer that fires
 * instantly.
 */
export function validateSleepTimerSeconds(seconds: number): number {
  assertFinite(seconds, 'seconds')
  if (seconds <= 0) {
    throw invalidArgument(
      `seconds must be > 0, got ${seconds}. Use cancelSleepTimer() to disarm, ` +
        `or pause() to stop now.`
    )
  }
  return seconds
}

/* -------------------------------------------------------------------------- */
/*                                   Config                                   */
/* -------------------------------------------------------------------------- */

/** `stopForegroundOnPause` follows audio_service's default. See PLAN §5.6. */
export const DEFAULT_STOP_FOREGROUND_ON_PAUSE = true

/**
 * media3's `MediaSessionService.DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS`, which
 * is both the default *and* the maximum: the setter runs the argument through
 * `Util.constrainValue(v, 0, DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS)`, so a
 * larger value is clamped down rather than honoured (media3 1.11.0, confirmed
 * by `javap` on the shipped AAR: `ConstantValue: long 600000l`).
 *
 * Exported so an app can say "half of media3's default" without hard-coding
 * ten minutes, and so a test can assert the ceiling.
 */
export const MAX_STOP_FOREGROUND_TIMEOUT_MS = 600_000

/**
 * Playback resumption is **off** unless the app asks for it.
 *
 * It is the one feature here that starts a foreground service in a process the
 * user did not open, from a snapshot written by an earlier process. That is a
 * lot of trust to hand an app by default, so it stays opt-in until it has been
 * exercised on more hardware than the machine this was written on.
 */
export const DEFAULT_PLAYBACK_RESUMPTION = false

/**
 * The one jump interval, in seconds, applied identically on both platforms.
 *
 * **This constant is the fix for a parity defect, not a preference.** Before it,
 * iOS pinned 15 s in both directions (`RemoteCommandBinding.skipInterval`) while
 * Android set neither media3 increment and therefore inherited
 * `C.DEFAULT_SEEK_BACK_INCREMENT_MS = 5_000` and
 * `C.DEFAULT_SEEK_FORWARD_INCREMENT_MS = 15_000` (media3 1.11.0, `javap` on the
 * shipped AAR) — so the same JS call skipped back 5 s on Android and 15 s on
 * iOS.
 *
 * 15 both ways rather than media3's asymmetric pair: it is what RNTP V4
 * (`forwardJumpInterval`/`backwardJumpInterval`) and V5
 * (`forwardInterval`/`backwardInterval`) both default to, it is what this
 * package already did on the platform where the value was deliberate, and a
 * symmetric default cannot surprise an app that sets one and forgets the other.
 *
 * Exported so an app can say "double the default" without hard-coding 15, and so
 * a test can assert the two platforms are handed the same number.
 */
export const DEFAULT_JUMP_SECONDS = 15

/**
 * `MPChangePlaybackRateCommand.supportedPlaybackRates` when the app names none.
 *
 * Unchanged from the constant this replaced (`RemoteCommandBinding.supportedRates`),
 * so making the list configurable changes nothing for an app that does not
 * configure it. Negative rates are absent because MediaPlayer does not support
 * them.
 */
export const DEFAULT_SUPPORTED_PLAYBACK_RATES: readonly number[] = [
  0.5, 0.75, 1, 1.25, 1.5, 2,
]

/**
 * Jump intervals are seconds, strictly positive and finite.
 *
 * `0` is rejected rather than read as "no jump": a zero interval produces a
 * button that seeks to exactly where you are, which is indistinguishable from a
 * broken button. An app that does not want the control omits `fastForward` /
 * `rewind` from `controls`, which is the way to say it.
 */
function validateJumpSeconds(value: unknown, field: string): number {
  assertFinite(value, field)
  if (value <= 0) {
    throw invalidArgument(
      `${field} must be > 0 seconds, got ${value}. To remove the button, leave ` +
        `'fastForward'/'rewind' out of playbackState.controls instead.`
    )
  }
  return value
}

function validateSupportedPlaybackRates(rates: number[]): number[] {
  if (!Array.isArray(rates) || rates.length === 0) {
    throw invalidArgument(
      'config.ios.supportedPlaybackRates must be a non-empty array of rates. ' +
        'Omit it for the default.'
    )
  }
  for (const rate of rates) {
    assertFinite(rate, 'config.ios.supportedPlaybackRates[]')
    if (rate <= 0) {
      // MediaPlayer has no reverse playback, and `0` is "paused", which is the
      // transport's job rather than the rate control's.
      throw invalidArgument(
        `config.ios.supportedPlaybackRates must contain only rates > 0, got ${rate}.`
      )
    }
  }
  return rates
}

/**
 * `Notification.color` is an ARGB **32-bit** value.
 *
 * Both signed (`-16777216`) and unsigned (`0xFF000000` = `4278190080`) spellings
 * are accepted, because both are what a JS caller naturally has: a hex literal
 * is unsigned, an Android colour int round-tripped through a theme is signed.
 * The native side truncates to the low 32 bits, so the two are the same colour.
 */
function validateNotificationColor(value: unknown): number {
  assertFinite(value, 'config.android.notificationColor')
  if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0xffff_ffff) {
    throw invalidArgument(
      `config.android.notificationColor must be a 32-bit ARGB integer such as ` +
        `0xFF1DB954, got ${String(value)}. Remember the alpha byte — 0x1DB954 is ` +
        `transparent black.`
    )
  }
  return value
}

export function normalizeConfig(
  config: MediaServiceConfig = {}
): MediaSessionConfig {
  const android = config.android
  const ios = config.ios

  if (android !== undefined) {
    assertNonEmptyString(
      android.notificationChannelId,
      'config.android.notificationChannelId'
    )
    assertNonEmptyString(
      android.notificationChannelName,
      'config.android.notificationChannelName'
    )
    if (android.notificationIcon !== undefined) {
      assertNonEmptyString(
        android.notificationIcon,
        'config.android.notificationIcon'
      )
    }
    if (
      android.playbackResumption !== undefined &&
      typeof android.playbackResumption !== 'boolean'
    ) {
      throw invalidArgument(
        `config.android.playbackResumption must be a boolean, got ` +
          `${JSON.stringify(android.playbackResumption)}.`
      )
    }
    if (
      android.onRevivalRequested !== undefined &&
      typeof android.onRevivalRequested !== 'function'
    ) {
      throw invalidArgument(
        `config.android.onRevivalRequested must be a function, got ` +
          `${JSON.stringify(android.onRevivalRequested)}.`
      )
    }
    if (android.stopForegroundTimeoutMs !== undefined) {
      assertFinite(
        android.stopForegroundTimeoutMs,
        'config.android.stopForegroundTimeoutMs'
      )
      if (android.stopForegroundTimeoutMs < 0) {
        // media3 would silently clamp a negative to 0, i.e. "demote instantly"
        // — the opposite of what someone writing a negative number is likely
        // to mean. Rejecting is the honest reading.
        throw invalidArgument(
          `config.android.stopForegroundTimeoutMs must be >= 0 (0 demotes the service ` +
            `immediately on pause), got ${android.stopForegroundTimeoutMs}.`
        )
      }
    }
  }

  if (ios?.artworkCacheSize !== undefined) {
    assertFinite(ios.artworkCacheSize, 'config.ios.artworkCacheSize')
    if (!Number.isInteger(ios.artworkCacheSize) || ios.artworkCacheSize < 0) {
      throw invalidArgument(
        `config.ios.artworkCacheSize must be a non-negative integer, got ${ios.artworkCacheSize}.`
      )
    }
  }

  const jumpForwardSeconds =
    config.jumpForwardSeconds === undefined
      ? DEFAULT_JUMP_SECONDS
      : validateJumpSeconds(
          config.jumpForwardSeconds,
          'config.jumpForwardSeconds'
        )
  const jumpBackwardSeconds =
    config.jumpBackwardSeconds === undefined
      ? DEFAULT_JUMP_SECONDS
      : validateJumpSeconds(
          config.jumpBackwardSeconds,
          'config.jumpBackwardSeconds'
        )

  return {
    jumpForwardSeconds,
    jumpBackwardSeconds,
    android:
      android === undefined
        ? undefined
        : {
            notificationChannelId: android.notificationChannelId,
            notificationChannelName: android.notificationChannelName,
            notificationIcon: android.notificationIcon,
            stopForegroundOnPause:
              android.stopForegroundOnPause ?? DEFAULT_STOP_FOREGROUND_ON_PAUSE,
            // Passed through undefined rather than defaulted: "no opinion" has
            // to stay distinguishable from "10 minutes", because media3 is
            // free to change its own default and an app that did not ask
            // should move with it.
            stopForegroundTimeoutMs: android.stopForegroundTimeoutMs,
            playbackResumption:
              android.playbackResumption ?? DEFAULT_PLAYBACK_RESUMPTION,
            notificationColor:
              android.notificationColor === undefined
                ? undefined
                : validateNotificationColor(android.notificationColor),
          },
    ios:
      ios === undefined
        ? undefined
        : {
            artworkCacheSize: ios.artworkCacheSize,
            // Passed through undefined rather than defaulted here: the default
            // list lives on the Swift side next to the command it configures, so
            // "the app did not choose" stays distinguishable from "the app chose
            // exactly the default" all the way down.
            supportedPlaybackRates:
              ios.supportedPlaybackRates === undefined
                ? undefined
                : validateSupportedPlaybackRates(ios.supportedPlaybackRates),
          },
  }
}
