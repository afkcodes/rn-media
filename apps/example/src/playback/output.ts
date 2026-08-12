/**
 * Engine options the UI can change while audio is playing.
 *
 * Both of these are *options*, not transport: they change how the engine
 * behaves rather than what it is doing, and both take effect on the track that
 * is already playing. They live together because they share the same failure
 * mode — mpv can reject an option write, and an app that assumed success would
 * then show a state the engine is not in. So every setter here writes first and
 * only records the new value if the write survived.
 */
import type { Player, ReplayGainMode } from '@rn-media/player'

export interface OutputOptionsHooks {
  readonly player: () => Player | undefined
  /** Accepted — clears any stale error banner and re-renders. */
  readonly onChange: () => void
  /** Rejected. Typed, surfaced, never swallowed. */
  readonly onError: (cause: unknown) => void
}

export class OutputOptions {
  readonly #hooks: OutputOptionsHooks
  #replayGain: ReplayGainMode = 'no'
  #prefetchEnabled = true

  constructor(hooks: OutputOptionsHooks) {
    this.#hooks = hooks
  }

  get replayGain(): ReplayGainMode {
    return this.#replayGain
  }

  get prefetchEnabled(): boolean {
    return this.#prefetchEnabled
  }

  /**
   * ReplayGain: loudness normalisation from the tags in the file.
   *
   * All four mpv options behind it carry `UPDATE_VOL`, so this applies to the
   * track already playing — no reload, no gap. `'album'` falls back to the
   * track gain when there is no album tag; files with no tags at all get the
   * `fallback` and nothing else, which is why one is passed here.
   */
  setReplayGain(mode: ReplayGainMode): void {
    const player = this.#hooks.player()
    if (player === undefined) return
    try {
      player.setReplayGain({ mode, preamp: 0, fallback: -6 })
      this.#replayGain = mode
      this.#hooks.onChange()
    } catch (cause) {
      this.#hooks.onError(cause)
    }
  }

  /**
   * Flip mpv's `prefetch-playlist` at runtime.
   *
   * `Player.create({ prefetchPlaylist })` is the create-time knob and is what
   * this app sets (see `engine.ts`); `setPrefetchPlaylist` is its runtime twin
   * — typed and validated, where this used to reach through the raw
   * `setPropertyBool` escape hatch. The toggle exists so the effect can be
   * A/B'd on a device without a rebuild.
   *
   * The caveats are the create option's, plus one of its own: flipping it takes
   * effect from the *next* prefetch decision, so turning it off does not abort
   * an opener that is already running and one more boundary may still be
   * gapless.
   */
  setPrefetchEnabled(enabled: boolean): void {
    const player = this.#hooks.player()
    if (player === undefined) return
    try {
      player.setPrefetchPlaylist(enabled)
      this.#prefetchEnabled = enabled
      this.#hooks.onChange()
    } catch (cause) {
      this.#hooks.onError(cause)
    }
  }
}
