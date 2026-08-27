import { AudioSession } from './audio-session'
import type { AudioSessionConfig } from './specs/audio-session.nitro'
import type { AudioSessionApi, Unsubscribe } from './types'

/**
 * The only thing {@link wireAudioSession} needs from a player.
 *
 * Structural on purpose — our `Player`, react-native-track-player, expo-audio
 * and a hand-rolled fake all satisfy it. This package must never import
 * `@timbre/player`.
 */
export interface AudioSessionPlayerLike {
  play(): void
  pause(): void
  /** Volume in the player's own scale; only ever fed values read back from {@link getVolume}, or `duckVolume`. */
  setVolume(volume: number): void
  getVolume(): number
  /**
   * Whether the player is currently playing (not paused), if it can say.
   *
   * **This is what makes a user's pause sacred.** Both platforms report
   * interruptions to a session that holds focus *regardless of whether audio
   * is actually playing* — Android delivers `AUDIOFOCUS_LOSS_TRANSIENT` /
   * `AUDIOFOCUS_GAIN` to the focus holder even while its player sits paused,
   * and AVAudioSession's interruption `.ended` carries `.shouldResume` with
   * exactly the same blindness. Without this method the helper cannot tell
   * "we paused the player for the interruption" apart from "the user had
   * already paused it", and resuming in the second case starts music the user
   * explicitly stopped (the paused-then-Instagram-reel bug, #45).
   *
   * When absent, the helper falls back to claiming every interruption pause —
   * the pre-#45 behaviour — because guessing "not playing" would break
   * resume-after-call for players that simply cannot report.
   */
  isPlaying?(): boolean
  /**
   * Subscribe to state changes, if the player supports it. Only `playing` is
   * read.
   *
   * Why {@link isPlaying} alone is not enough: `play()`/`pause()` on a real
   * player are asynchronous (an mpv property round-trips through the native
   * event loop), so for a few milliseconds after this helper resumes a player,
   * `isPlaying()` still answers `false`. Interruptions genuinely arrive inside
   * that window — Instagram flaps transient focus loss/gain 14 ms apart
   * (measured, #45) — and a stale `false` there would make the helper refuse a
   * pause claim it is entitled to. The subscription is what lets the helper
   * know when its own `play()` has actually landed.
   */
  onStateChange?(
    listener: (state: { readonly playing: boolean }) => void
  ): Unsubscribe
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
 * playing" — that question is asked separately, through
 * {@link AudioSessionPlayerLike.isPlaying}, and only at the moment it matters.
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
 * **Resume is owed only for pauses this helper performed on a playing
 * player.** Both platforms report interruptions to whoever holds focus even
 * while that app's player sits paused (see
 * {@link AudioSessionPlayerLike.isPlaying}), and the resume hint on the way
 * out (`AUDIOFOCUS_GAIN` after a transient loss, AVAudioSession's
 * `.shouldResume`) means "the system permits resuming" — never "you were
 * playing". A player that implements `isPlaying` (and ideally `onStateChange`)
 * gets the full guarantee; one that implements neither keeps the old
 * behaviour of resuming after every transient interruption, user pause or not,
 * because the helper has nothing to consult.
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
  /**
   * The latest `playing` the player reported through `onStateChange`, or
   * `undefined` before the first report (or without the subscription).
   */
  let playingReported: boolean | undefined
  /**
   * `true` between this helper calling `player.play()` and the player
   * *confirming* it plays. In that window `isPlaying()` is honestly stale —
   * our own resume has not round-tripped yet — so the helper trusts its memory
   * of having pressed play over the player's answer. Cleared by the first
   * `playing: true` report (with the subscription this is milliseconds), by
   * taking a pause claim, and by a becoming-noisy pause.
   *
   * Deliberately *not* cleared by a `playing: false` report: pause and play
   * writes issued milliseconds apart round-trip in order, so the pause's echo
   * can arrive after our play() call — treating that echo as the player's last
   * word would hand a flapping interruption a refusal it has not earned.
   */
  let resumePending = false

  /**
   * Is the player playing, as far as anyone can tell *right now*?
   *
   * `undefined` means "no way to know" (a player with neither `isPlaying` nor
   * `onStateChange`), which callers must treat as the pre-#45 behaviour of
   * claiming the pause — refusing on ignorance would break resume-after-call
   * for every player that cannot report.
   */
  function believedPlaying(): boolean | undefined {
    if (resumePending) return true
    return playingReported ?? player.isPlaying?.()
  }

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

  /**
   * An interruption wants the player stopped. Pause it and remember that *we*
   * did — unless the player was not playing in the first place, in which case
   * there is nothing to stop and, critically, no resume to owe. **A user
   * pause is sacred**: claiming it here is what used to turn "pause → watch a
   * reel → reel ends" into music starting by itself (#45).
   */
  function pause(): void {
    if (state === 'paused') return
    // A pause supersedes a duck: put the volume back before stopping, so the
    // player is left in a sane state whether or not we ever resume.
    unduck()
    if (believedPlaying() === false) return
    state = 'paused'
    resumePending = false
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
          if (event.shouldResume && resumeAfterInterruption) {
            // Our own resume: remembered so that another interruption arriving
            // before the player confirms the state change (transient-focus
            // flapping, measured 14 ms apart) is still claimed as ours.
            resumePending = true
            player.play()
          }
          return
        case 'idle':
          // Nothing of ours to undo — the player was already paused when the
          // interruption began (a user pause is sacred), or the user pressed
          // play during it, or this follows a becomingNoisy pause.
          return
      }
    }),

    session.addListener('becomingNoisy', () => {
      // Unlike an interruption pause this does not consult believedPlaying():
      // "the headphones are gone" must stop audio even when our picture of the
      // player is mid-flight, and a redundant pause() is harmless.
      const alreadyPausedByUs = state === 'paused'
      unduck()
      // Unplugging headphones is a user intent, not a temporary interruption:
      // no claim is kept, so a later interruption-end cannot restart audio
      // out of the speaker.
      state = 'idle'
      resumePending = false
      if (!alreadyPausedByUs) player.pause()
    }),
  ]

  const unsubscribeState = player.onStateChange?.((s) => {
    playingReported = s.playing
    // Only a confirmation retires the pending resume — see its declaration.
    if (s.playing) resumePending = false
  })
  if (unsubscribeState !== undefined) unsubscribers.push(unsubscribeState)

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
