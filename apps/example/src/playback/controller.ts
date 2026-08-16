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
import { CastIntegration } from './cast'
import { createEngine, type Engine, type RetryNote } from './engine'
import { DemoMediaHandler, type PlaybackCommands } from './handler'
import { OutputOptions } from './output'
import { QueueMirror, type QueueRow } from './queue'
import { Transport } from './transport'
import { restoreSession, type RestoreOutcome } from './persistence'
import { SessionBridge } from './session'

export type { RetryNote } from './engine'

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
      // The JS queue is the source of truth for the receiver queue too: while
      // casting, an edit reloads the castable projection at the receiver's
      // current item and projected position.
      this.#cast.onQueueChanged()
      this.#notify()
    },
    onEdited: () => {
      this.#session.refresh(this.#engine?.player.state)
      this.#done()
    },
    onError: (cause) => this.#fail(cause),
  })

  /**
   * The cast side, wired per the handoff contracts: the receiver's state
   * flows into the same `SessionBridge` channels the local player uses (§3 —
   * the notification and every remote surface mirror the receiver), and a
   * transfer-back resumes through the same focus gate every sound-starting
   * command takes.
   */
  readonly #cast = new CastIntegration({
    player: () => this.#engine?.player,
    queue: () => this.#queue.tracks,
    resume: () => this.#transport.play(),
    onReceiverState: (snapshot) => {
      this.#session.publishCast(
        snapshot,
        snapshot?.itemIndex === undefined
          ? undefined
          : this.#queue.at(snapshot.itemIndex)
      )
      // Casting over: repaint the channels from the local player, which has
      // been silent (and un-broadcast) for the whole session.
      if (snapshot === undefined) {
        this.#session.refresh(this.#engine?.player.state)
      }
      this.#notify()
    },
    // Volume follows the output: while the receiver owns playback the session
    // is told so, which is what puts the phone's hardware volume keys on the
    // speaker even with the screen locked (see `SessionBridge`).
    onRemoteVolume: (volume) => this.#session.publishRemotePlayback(volume),
    onChange: () => this.#notify(),
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
  /** The cast surface — state for the Cast section, commands for the sheet. */
  get cast(): CastIntegration {
    return this.#cast
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
    // Cast framework init is deliberately not awaited into the critical path:
    // playback must not wait on Play services. It resolves 'unavailable'
    // where casting cannot work, and the section renders that honestly.
    void this.#cast.start()
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
          // Prefetch sightings are NOT plumbed here anymore: the banner reads
          // them straight off the player with `usePrefetchStatus`, which is
          // the library way (and owns the clearing rules this class used to
          // approximate).
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

  /*
   * Every sound-affecting command branches on WHO owns playback right now.
   * From `handoff-to-cast` onward the cast side does (`cast.owns`): during
   * the handoff the local player is already paused for the session — a
   * command routed to mpv there would start phone audio underneath the
   * speaker's — and while `cast-active` the receiver holds the clock. The
   * media handler calls exactly these methods, so a notification button or a
   * car head unit steers the receiver with no extra wiring. That is the
   * fan-in contract doing its job: one command vocabulary, two backends,
   * exactly one of which owns the clock.
   */

  play(): Promise<void> {
    if (this.#cast.owns) {
      this.#cast.play()
      return Promise.resolve()
    }
    return this.#transport.play()
  }
  pause(): void {
    if (this.#cast.owns) {
      this.#cast.pause()
      return
    }
    this.#transport.pause()
  }
  /**
   * The **remote** stop: stop playing, keep the session.
   *
   * Deliberately not {@link stop}. `MediaHandler.stop` is documented as
   * "Release resources. Does NOT end background execution — call
   * `stopService()` for that", and this app used to route it to the teardown
   * anyway. On iOS that was a one-way door: the system replaces pause with a
   * **stop** button for anything marked live (Apple's own behaviour — a live
   * stream cannot be paused), so on a radio entry the destructive stop was the
   * only transport control the lock screen offered, and pressing it removed
   * the now-playing card with no path back — iOS has no resumption card to
   * come back through.
   *
   * Casting keeps its own semantics: the receiver is paused rather than
   * disconnected, since a stop that dropped the session would take the audio
   * off the speaker entirely.
   */
  async stopPlayback(): Promise<void> {
    if (this.#cast.owns) {
      this.#cast.pause()
      return
    }
    await this.#transport.stopPlayback()
    this.#notify()
  }
  toggle(): void {
    if (this.#cast.owns) {
      this.#cast.toggle()
      return
    }
    this.#transport.toggle()
  }
  next(): void {
    if (this.#cast.owns) {
      this.#cast.next()
      return
    }
    this.#transport.next()
  }
  previous(): void {
    if (this.#cast.owns) {
      this.#cast.previous()
      return
    }
    this.#transport.previous()
  }
  jumpTo(index: number): Promise<void> {
    if (this.#cast.owns) {
      this.#cast.jumpTo(index)
      return Promise.resolve()
    }
    return this.#transport.jumpTo(index)
  }
  seekTo(seconds: number): void {
    if (this.#cast.owns) {
      this.#cast.seekTo(seconds)
      return
    }
    this.#transport.seekTo(seconds)
  }
  seekBy(deltaSeconds: number): void {
    if (this.#cast.owns) {
      this.#cast.seekBy(deltaSeconds)
      return
    }
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
  /**
   * Volume is per-OUTPUT, so it follows playback ownership: while casting it
   * drives the speaker's device volume (what Spotify's in-app slider does on
   * a Cast device); locally it is mpv's software volume. Same 0..1 scale on
   * both sides.
   *
   * Three callers now, all landing here: the in-app slider, the media
   * handler's `onSetDeviceVolume` (the lock screen's remote volume slider) and
   * — via that same handler — a **hardware volume key press while the app is
   * backgrounded**, which the library has already turned into a level.
   */
  setVolume(volume: number): void {
    if (this.#cast.owns) {
      this.#cast.setVolume(volume)
      return
    }
    this.#transport.setVolume(volume)
  }
  setMuted(muted: boolean): void {
    if (this.#cast.owns) {
      this.#cast.setMuted(muted)
      return
    }
    this.#transport.setMuted(muted)
  }
  toggleMuted(): void {
    if (this.#cast.owns) {
      this.#cast.toggleMuted()
      return
    }
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
    // Stop while casting: silence the receiver first (pause, then transfer
    // back — the pause makes the transfer land with `playWhenReady: false`,
    // so the restore does not start local audio the very stop is ending).
    // The trailing local `pause()` below also covers the race where the end
    // arrives before the receiver acknowledged the pause.
    if (this.#cast.engaged) {
      this.#cast.pause()
      await this.#cast.disconnect(true)
    }
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
