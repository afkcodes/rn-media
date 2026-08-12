/**
 * The sound-making commands, gathered in one place because they share one rule.
 *
 * **Anything that can start audio requests focus first, and makes sure the
 * media session is up first.** That is the app's job by design: `wireAudioSession`
 * handles what happens *after* focus is lost or a headphone is unplugged, but
 * only the app knows when it is about to make sound. Getting this wrong is
 * invisible in a quiet room and obvious the moment a phone call arrives.
 *
 * Everything here is also reachable from a notification button or a car head
 * unit — the media handler calls exactly these methods — so there is one
 * implementation of "play" in the app, not one per surface.
 */
import type { Player } from '@rn-media/player'
import { AudioSession } from '@rn-media/audio-session'

export interface TransportHooks {
  readonly player: () => Player | undefined
  /** Bring the media session up if a previous `stop()` tore it down. */
  readonly ensureSession: () => void
}

export class Transport {
  readonly #hooks: TransportHooks

  constructor(hooks: TransportHooks) {
    this.#hooks = hooks
  }

  async play(): Promise<void> {
    const player = this.#hooks.player()
    if (player === undefined) return
    this.#hooks.ensureSession()
    if (await AudioSession.activate()) player.play()
    else console.warn('[example] audio focus denied — not starting')
  }

  pause(): void {
    this.#hooks.player()?.pause()
  }

  toggle(): void {
    if (this.#hooks.player()?.state.playing === true) this.pause()
    else void this.play()
  }

  next(): void {
    const player = this.#hooks.player()
    if (player === undefined) return
    this.#hooks.ensureSession()
    void player.playlist.next()
  }

  /**
   * ⏮ is restart-or-previous, and the library owns the rule.
   *
   * `playlist.previous()` seeks to `0` when more than three seconds into the
   * entry and moves back otherwise — the convention every music app
   * implements, and one this app deliberately does *not* reimplement with
   * `getPosition() > 3`. Pass `{ restartThreshold }` to change it, or `0` for
   * an always-move button.
   */
  previous(): void {
    const player = this.#hooks.player()
    if (player === undefined) return
    this.#hooks.ensureSession()
    void player.playlist.previous()
  }

  /**
   * Tapping a queue row means "play this one".
   *
   * Two things this deliberately does that a naive `playlist.jumpTo` would not:
   *
   * 1. **Focus first.** `playlist.jumpTo` starts playback (its `autoPlay`
   *    default), so it is a sound-making call and goes through the same audio
   *    focus gate as {@link play}.
   * 2. **Never restart the entry that is already current.** mpv's
   *    `playlist-play-index` faithfully *restarts* it — which for a live
   *    stream means throwing away a warm, fully-buffered connection and paying
   *    TCP + TLS + probe again to hear exactly what was already in the cache.
   *    Measured on this device over LTE: 1.5–2.3 s to first audio for the
   *    re-open (1.1–1.5 s of it TCP+TLS alone), against 10–24 ms for the
   *    resume. A row that is *not* playable any more (errored, or ended)
   *    still gets the real jump, so this is a shortcut, never a dead end.
   */
  async jumpTo(index: number): Promise<void> {
    const player = this.#hooks.player()
    if (player === undefined) return
    this.#hooks.ensureSession()
    if (!(await AudioSession.activate())) {
      console.warn('[example] audio focus denied — not starting')
      return
    }
    const state = player.state
    const alreadyOpen =
      index === state.playlist.index &&
      (state.status === 'ready' || state.status === 'buffering')
    if (alreadyOpen) player.play()
    else await player.playlist.jumpTo(index)
  }

  /** Not a sound-*starting* call, so no focus request: it moves the playhead. */
  seekTo(seconds: number): void {
    void this.#hooks.player()?.seekTo(seconds)
  }

  /**
   * The ±15 s buttons, and the reason they are not `seekTo(position + delta)`.
   *
   * The position this app can read is *projected* from an anchor that may be a
   * few hundred milliseconds old (nothing ticks across the bridge — that is the
   * whole design), so computing an absolute target from it accumulates the
   * projection error on every rapid tap. `seekBy` is mpv's own `relative` seek,
   * applied to mpv's clock at the instant it runs.
   */
  seekBy(deltaSeconds: number): void {
    void this.#hooks.player()?.seekBy(deltaSeconds)
  }

  setRate(rate: number): void {
    this.#hooks.player()?.setRate(rate)
  }

  /**
   * Pitch, independent of speed — mpv's own `--pitch`, a frequency **ratio**.
   *
   * `1` is the recording's own pitch; a semitone is `2 ** (1 / 12)`. It drives
   * the same `scaletempo2` that already handles speed, so no filter chain and
   * no engine flag is involved, and `setRate` is unaffected.
   */
  setPitchSemitones(semitones: number): void {
    this.#hooks.player()?.setPitch(2 ** (semitones / 12))
  }

  /**
   * Chapter navigation, when the entry has chapters (audiobooks, podcasts).
   *
   * `previousChapter()` is restart-or-previous inside mpv itself: a backward
   * chapter seek restarts the current chapter unless you are within
   * `--chapter-seek-threshold` (5 s) of its start.
   */
  nextChapter(): void {
    void this.#hooks.player()?.nextChapter()
  }

  previousChapter(): void {
    void this.#hooks.player()?.previousChapter()
  }

  setVolume(volume: number): void {
    this.#hooks.player()?.setVolume(volume)
  }

  /**
   * Mute is its own mpv property, not `volume = 0`.
   *
   * Unmuting restores the level the user picked — and `wireAudioSession`'s
   * ducking does read-modify-restore on volume, so a zero written there would
   * be the value it restores to.
   */
  toggleMuted(): void {
    const player = this.#hooks.player()
    if (player === undefined) return
    player.setMuted(!player.state.muted)
  }
}
