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

  setRate(rate: number): void {
    this.#hooks.player()?.setRate(rate)
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
