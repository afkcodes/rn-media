import { AudioSession } from './audio-session'
import type { AudioSessionConfig } from './specs/audio-session.nitro'
import type { AudioSessionApi, Unsubscribe } from './types'

/**
 * The only thing {@link wireAudioSession} needs from a player.
 *
 * Structural on purpose — our `Player`, react-native-track-player, expo-audio
 * and a hand-rolled fake all satisfy it. This package must never import
 * `@rn-media/player`.
 */
export interface AudioSessionPlayerLike {
  play(): void
  pause(): void
  /** Volume in the player's own scale; only ever fed values read back from {@link getVolume}, or `duckVolume`. */
  setVolume(volume: number): void
  getVolume(): number
}

export interface WireAudioSessionOptions {
  /**
   * Config to apply before wiring. Omit to wire listeners onto a session you
   * configured yourself.
   */
  preset?: AudioSessionConfig
  /**
   * Volume to attenuate to on a `duck` interruption. Interpreted as an
   * absolute level in the player's scale; the helper never *raises* the volume,
   * so the effective target is `min(currentVolume, duckVolume)`.
   *
   * @default 0.3
   */
  duckVolume?: number
  /**
   * Resume playback when a pause-type interruption ends with
   * `shouldResume: true`.
   *
   * @default true
   */
  resumeAfterInterruption?: boolean
  /**
   * Session to wire against. Defaults to the process singleton; injectable so
   * the state machine can be tested without a device.
   */
  session?: AudioSessionApi
  /**
   * Called when the initial `configure(preset)` rejects.
   *
   * `wireAudioSession` is synchronous (it returns the unwire function), so the
   * configure promise has nowhere else to go. Defaults to `console.error` —
   * the error is never swallowed.
   */
  onError?: (error: unknown) => void
}

/**
 * What the helper believes it did to the player. It is *not* "is the player
 * playing" — {@link AudioSessionPlayerLike} has no way to ask, and guessing
 * would be worse than remembering.
 *
 * - `idle` — we have not touched the player.
 * - `ducked` — we lowered the volume and owe a restore.
 * - `paused` — we paused the player and may owe a resume.
 */
type WireState = 'idle' | 'ducked' | 'paused'

const DEFAULT_DUCK_VOLUME = 0.3

/**
 * Connect an audio session to a player: duck/pause on interruption, restore or
 * resume when it ends, pause when the headphones are yanked.
 *
 * Activating the session before `play()` stays the app's job — this helper only
 * reacts to what the OS reports. It is entirely event-driven; there are no
 * timers or polling anywhere in it.
 *
 * @returns a function that removes every listener it installed. It does *not*
 * deactivate the session (the app may still be playing) and does not undo a
 * duck in progress — call it while `idle` if that matters.
 */
export function wireAudioSession(
  player: AudioSessionPlayerLike,
  options: WireAudioSessionOptions = {}
): Unsubscribe {
  const {
    preset,
    duckVolume = DEFAULT_DUCK_VOLUME,
    resumeAfterInterruption = true,
    session = AudioSession,
    onError = defaultOnError,
  } = options

  let state: WireState = 'idle'
  /** Volume captured just before we ducked, restored when the duck ends. */
  let volumeBeforeDuck = 0

  function duck(): void {
    if (state !== 'idle') return
    volumeBeforeDuck = player.getVolume()
    state = 'ducked'
    // Never turn the volume *up* in the name of ducking.
    player.setVolume(Math.min(volumeBeforeDuck, duckVolume))
  }

  function unduck(): void {
    if (state !== 'ducked') return
    state = 'idle'
    player.setVolume(volumeBeforeDuck)
  }

  function pause(): void {
    if (state === 'paused') return
    // A pause supersedes a duck: put the volume back before stopping, so the
    // player is left in a sane state whether or not we ever resume.
    unduck()
    state = 'paused'
    player.pause()
  }

  const unsubscribers: Unsubscribe[] = [
    session.addListener('interruption', (event) => {
      if (event.begin) {
        if (event.type === 'duck') {
          duck()
          return
        }
        pause()
        // Focus is gone for good; there is no resume to wait for. Forget that
        // we were the one who paused so a stray `end` cannot restart us.
        if (event.permanent) state = 'idle'
        return
      }

      switch (state) {
        case 'ducked':
          unduck()
          return
        case 'paused':
          state = 'idle'
          if (event.shouldResume && resumeAfterInterruption) player.play()
          return
        case 'idle':
          // Nothing of ours to undo — e.g. the interruption ended after the
          // user manually pressed play, or after a becomingNoisy pause.
          return
      }
    }),

    session.addListener('becomingNoisy', () => {
      pause()
      // Unplugging headphones is a user intent, not a temporary interruption:
      // drop the resume claim so a later interruption-end cannot restart audio
      // out of the speaker.
      state = 'idle'
    }),
  ]

  if (preset != null) {
    session.configure(preset).catch(onError)
  }

  let unwired = false
  return () => {
    if (unwired) return
    unwired = true
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
}

function defaultOnError(error: unknown): void {
  console.error('[audio-session] configure() failed while wiring:', error)
}
