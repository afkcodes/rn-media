/**
 * The app's command surface, and the thing that owns everything else here.
 *
 * The player, the audio session and the media session all live **outside
 * React**, and that is the single most important thing in this app.
 *
 * On Android the JS runtime outlives the Activity — but the React tree does
 * not. Destroying the Activity calls `ReactHost.stopSurface`, which unmounts
 * every component. Anything a hook owns goes with it: `usePlayer` would destroy
 * the mpv core in its cleanup, and a `MediaService.init` effect would tear the
 * session down, so pressing Back would silently end background playback while
 * the notification was still on screen. (Measured: session went
 * `PLAYING → STOPPED` on the Back key when this was hook-owned.)
 *
 * Hooks are right for a screen-scoped player. A media app's player is
 * process-scoped, so it is created once — see `index.ts` — and React only ever
 * reads it.
 *
 * Five collaborators, each in its own file: `engine.ts` builds the player,
 * `transport.ts` owns the sound-making commands (and the audio-focus rule),
 * `queue.ts` mirrors mpv's playlist, `output.ts` holds the engine options a UI
 * can change live, and `session.ts` broadcasts to every remote surface. This
 * class is the seam between them, and the only thing the UI and the media
 * handler talk to — which is why the delegating one-liners below are worth
 * their space: they are the app's whole command vocabulary on one screen.
 */
import {
  toPlayerError,
  type ChapterEntry,
  type Player,
  type PlayerError,
  type PlayerState,
  type ReplayGainMode,
} from '@rn-media/player'
import { AudioSession } from '@rn-media/audio-session'
import type {
  MediaRepeatMode,
  SleepTimerState,
} from '@rn-media/media-session'
import type { Track } from '../data/tracks'
import { repeatToLoop } from './broadcast'
import {
  createEngine,
  type Engine,
  type PrefetchNote,
  type RetryNote,
} from './engine'
import { DemoMediaHandler, type PlaybackCommands } from './handler'
import { OutputOptions } from './output'
import { QueueMirror, type QueueRow } from './queue'
import { Transport } from './transport'
import { restoreSession, type RestoreOutcome } from './persistence'
import { SessionBridge } from './session'

export type { PrefetchNote, RetryNote } from './engine'

export class Playback implements PlaybackCommands {
  #engine: Engine | undefined
  #error: PlayerError | undefined
  #errorAttempts = 0
  #startingPlayer: Promise<void> | undefined
  #restoring: Promise<void> | undefined
  #restored: RestoreOutcome | undefined
  /** Position to seek to once mpv has opened the resumed entry. */
  #pendingResumeMs: number | undefined

  /* --- app-owned state the UI draws ------------------------------------- */

  #station: string | undefined
  #prefetch: PrefetchNote | undefined
  #retrying: RetryNote | undefined
  /**
   * The shuffle toggle — **app** state, because mpv has no shuffle *mode*.
   *
   * What mpv has is a reorder command, so "shuffle on" here is an honest
   * physical shuffle of the playlist (`playlist.shuffle`) and "off" is mpv's
   * one level of undo (`playlist.unshuffle`). This boolean records which was
   * asked for last; the session bridge reads it at broadcast time, which is
   * how the notification's shuffle icon and the in-app toggle stay one fact.
   */
  #shuffleEnabled = false

  readonly #listeners = new Set<() => void>()

  readonly #session = new SessionBridge({
    handler: () => new DemoMediaHandler(() => this),
    snapshot: () => this.#engine?.player.state,
    shuffleEnabled: () => this.#shuffleEnabled,
    onChange: () => this.#notify(),
  })

  readonly #output = new OutputOptions({
    player: () => this.#engine?.player,
    onChange: () => this.#done(),
    onError: (cause) => this.#fail(cause),
  })

  readonly #transport = new Transport({
    player: () => this.#engine?.player,
    ensureSession: () => void this.#session.ensure(),
  })

  readonly #queue = new QueueMirror({
    player: () => this.#engine?.player,
    onChange: (rows) => {
      this.#session.setQueue(rows.map((row) => row.track))
      this.#notify()
    },
    onEdited: () => {
      this.#session.refresh(this.#engine?.player.state)
      this.#done()
    },
    onError: (cause) => this.#fail(cause),
  })

  /* --- reads ------------------------------------------------------------- */

  get player(): Player | undefined {
    return this.#engine?.player
  }
  get error(): PlayerError | undefined {
    return this.#error
  }
  /** How many automatic re-attempts preceded {@link error}. `0` if none. */
  get errorAttempts(): number {
    return this.#errorAttempts
  }
  get queue(): readonly Track[] {
    return this.#queue.tracks
  }
  /**
   * The same queue with mpv's identity attached — what the list draws.
   *
   * `entryId` is stable across inserts, removes, moves and shuffles, which is
   * what a React key needs to be; {@link queue} stays the plain metadata list
   * because that is what the media session and the now-playing lookup want.
   */
  get queueRows(): readonly QueueRow[] {
    return this.#queue.rows
  }
  get restoreNote(): string {
    return this.#restored?.note ?? 'not attempted'
  }
  /** Station identity from the ICY tags — see the `metadataChanged` wiring. */
  get station(): string | undefined {
    return this.#station
  }
  get prefetch(): PrefetchNote | undefined {
    return this.#prefetch
  }
  /** Set while an entry is being re-attempted; cleared when it plays or gives up. */
  get retrying(): RetryNote | undefined {
    return this.#retrying
  }
  get prefetchEnabled(): boolean {
    return this.#output.prefetchEnabled
  }
  get replayGain(): ReplayGainMode {
    return this.#output.replayGain
  }
  /** The app-owned half of the mode pair; repeat lives in `ShellState.loop`. */
  get shuffleEnabled(): boolean {
    return this.#shuffleEnabled
  }

  /** Re-render notification for the UI. Nothing else depends on it. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /* --- startup ----------------------------------------------------------- */

  /** Idempotent: safe to call from every mount, and from a Fast Refresh. */
  async start(): Promise<void> {
    // Before the player, so the queue can open on the entry the last process
    // died on rather than jumping to track 1 and then correcting itself.
    await (this.#restoring ??= this.#restore())
    await (this.#startingPlayer ??= this.#createPlayer())
    // Once, explicitly: the queue was built inside `createEngine`, so its
    // `queueChanged` events fired before `#engine` existed for the mirror to
    // read through. Every later change arrives on the event.
    this.#queue.sync()
    await this.#session.ensure()
  }

  async #restore(): Promise<void> {
    const outcome = await restoreSession()
    this.#restored = outcome
    this.#pendingResumeMs = outcome.pendingResumeMs
    this.#session.setRestored(outcome.session)
  }

  async #createPlayer(): Promise<void> {
    try {
      this.#engine = await createEngine(
        {
          onState: (state) => {
            this.#onStateChange(state)
            this.#notify()
          },
          onStation: (station) => {
            this.#station = station
            this.#notify()
          },
          onPrefetch: (note) => {
            this.#prefetch = note
            this.#notify()
          },
          // The library's own signal that the queue's *contents* moved — an
          // add/remove/clear (observed `playlist-count`) or a reorder (which
          // changes no observable property, so the playlist methods emit it).
          // This is what replaced the app polling `playlist-count` out of every
          // snapshot.
          onQueueChanged: () => {
            this.#queue.sync()
          },
          // A retryable entry failed and the player is re-attempting it rather
          // than letting the queue skip past. No `error` event fires for these,
          // so a UI that only listens to `error` would show nothing at all
          // while a stream reconnects.
          onRetrying: (note) => {
            this.#retrying = note
            this.#notify()
          },
          onFailed: (error, attempts) => {
            this.#error = error
            this.#errorAttempts = attempts
            this.#notify()
          },
        },
        this.#restored?.resumeIndex ?? 0
      )
    } catch (cause) {
      this.#error = toPlayerError(cause)
      console.error('[example] player start failed:', cause)
    }
    this.#notify()
  }

  /* --- state → session ---------------------------------------------------- */

  #onStateChange(state: PlayerState): void {
    this.#consumeResume(state)
    this.#session.publish(state, this.#queue.at(state.playlist.index))
  }

  /**
   * Seek to the restored position, once — and only once mpv has actually opened
   * the entry it belongs to.
   *
   * `autoPlay: false` means nothing is loaded at startup, so there is nothing
   * to seek *into* until the user presses play and the entry reaches `ready`.
   * The index check is what stops a resume point leaking onto a different
   * track if the user skips before pressing play.
   */
  #consumeResume(state: PlayerState): void {
    const ms = this.#pendingResumeMs
    if (ms === undefined) return
    if (
      state.status !== 'ready' ||
      state.playlist.index !== this.#restored?.resumeIndex
    ) {
      return
    }
    this.#pendingResumeMs = undefined
    console.log(`[example] persistence: resuming at ${ms} ms`)
    void this.player?.seekTo(ms / 1000)
  }

  /* --- transport (delegated) ---------------------------------------------- */

  play(): Promise<void> {
    return this.#transport.play()
  }
  pause(): void {
    this.#transport.pause()
  }
  toggle(): void {
    this.#transport.toggle()
  }
  next(): void {
    this.#transport.next()
  }
  previous(): void {
    this.#transport.previous()
  }
  jumpTo(index: number): Promise<void> {
    return this.#transport.jumpTo(index)
  }
  seekTo(seconds: number): void {
    this.#transport.seekTo(seconds)
  }
  seekBy(deltaSeconds: number): void {
    this.#transport.seekBy(deltaSeconds)
  }
  setRate(rate: number): void {
    this.#transport.setRate(rate)
  }
  setPitchSemitones(semitones: number): void {
    this.#transport.setPitchSemitones(semitones)
  }
  nextChapter(): void {
    this.#transport.nextChapter()
  }
  previousChapter(): void {
    this.#transport.previousChapter()
  }
  /**
   * The current entry's chapters — one node read, pulled when something says
   * they changed rather than kept in state. See `NowPlaying`.
   */
  chapters(): readonly ChapterEntry[] {
    return this.player?.getChapters() ?? []
  }
  setVolume(volume: number): void {
    this.#transport.setVolume(volume)
  }
  toggleMuted(): void {
    this.#transport.toggleMuted()
  }

  /* --- queue (delegated to the mirror) ------------------------------------ */

  playNext(track: Track): Promise<void> {
    return this.#queue.playNext(track)
  }
  addLast(track: Track): Promise<void> {
    return this.#queue.addLast(track)
  }
  removeAt(index: number): Promise<void> {
    return this.#queue.remove(index)
  }
  clearQueue(): Promise<void> {
    return this.#queue.clear()
  }

  /* --- repeat & shuffle ---------------------------------------------------- */

  /**
   * Repeat, in media-session vocabulary — the one method both the in-app
   * chips and the notification's repeat button call.
   *
   * The mapping (`one` → mpv's `loop-file`, `all` → `loop-playlist`) lives in
   * `broadcast.ts` next to its inverse. No local state and no `#notify()`:
   * `loop` is an observed player property, so the confirmation flows back
   * through the snapshot — the UI re-renders off `ShellState.loop` and the
   * session bridge re-broadcasts `repeatMode`, which is the acknowledgement
   * every remote surface is waiting on.
   */
  setRepeatMode(mode: MediaRepeatMode): void {
    this.#transport.setLoop(repeatToLoop(mode))
  }

  /**
   * Shuffle, as a toggle — the shape every remote surface speaks.
   *
   * The honest wiring, stated plainly: mpv has no shuffle *mode*, so `true`
   * performs a real `playlist.shuffle` (the playing entry moves too — mpv
   * keeps the entry current, not the index) and `false` is `unshuffle`, which
   * is one level of undo and no more. The flag is recorded first so the
   * queue-edit rebroadcast that follows the reorder already carries it; if mpv
   * rejects the reorder the error surfaces on the banner (`QueueMirror`'s
   * `onError`) while the toggle keeps the user's intent — the same optimistic
   * contract a network toggle has.
   */
  async setShuffleEnabled(enabled: boolean): Promise<void> {
    this.#shuffleEnabled = enabled
    this.#notify()
    if (enabled) await this.#queue.shuffle()
    else await this.#queue.unshuffle()
  }

  /* --- engine options (delegated) ------------------------------------------ */

  setReplayGain(mode: ReplayGainMode): void {
    this.#output.setReplayGain(mode)
  }

  setPrefetchEnabled(enabled: boolean): void {
    this.#output.setPrefetchEnabled(enabled)
    // The banner's last sighting is only meaningful while prefetch is on.
    if (!enabled) this.#prefetch = undefined
  }

  /* --- sleep timer, checkpoints, teardown --------------------------------- */

  setSleepTimer(seconds: number): void {
    this.#session.setSleepTimer(seconds)
  }
  setSleepTimerToTrackEnd(): void {
    this.#session.setSleepTimerToTrackEnd()
  }
  cancelSleepTimer(): void {
    this.#session.cancelSleepTimer()
  }
  /** Mode + remaining seconds, for the badge. See `SessionBridge.sleepTimer`. */
  sleepTimer(): SleepTimerState | undefined {
    return this.#session.sleepTimer()
  }
  saveSession(): void {
    this.#session.save()
  }

  /**
   * The only thing that ends background execution — pause never does.
   *
   * The player stays alive and so does the app; only the session goes.
   */
  async stop(): Promise<void> {
    this.pause()
    try {
      await this.#session.stop()
    } finally {
      await AudioSession.deactivate()
      this.#notify()
    }
  }

  /** Not called by the UI — here so the teardown path is written down. */
  async dispose(): Promise<void> {
    await this.stop()
    this.#engine?.dispose()
    this.#engine = undefined
    this.#startingPlayer = undefined
    this.#notify()
  }

  /* --- plumbing ------------------------------------------------------------ */

  #notify(): void {
    for (const listener of this.#listeners) listener()
  }

  /** A command succeeded: clear any banner an earlier one left behind. */
  #done(): void {
    this.#error = undefined
    this.#errorAttempts = 0
    this.#notify()
  }

  /**
   * Dismiss the error banner.
   *
   * `player.clearError()` clears the player's own `state.error` too, which is
   * the field a *state*-driven UI reads. It clears state only — the `error`
   * event already fired and is already in the log; dismissing a banner is not
   * the same as the failure not having happened.
   */
  dismissError(): void {
    this.#error = undefined
    this.#errorAttempts = 0
    try {
      this.player?.clearError()
    } catch (cause) {
      console.warn('[example] clearError:', cause)
    }
    this.#notify()
  }

  /** Typed, surfaced, never swallowed. The banner reads {@link error}. */
  #fail(cause: unknown): void {
    this.#error = toPlayerError(cause)
    this.#errorAttempts = 0
    console.warn(`[example] ${this.#error.code}: ${this.#error.message}`)
    this.#notify()
  }
}
