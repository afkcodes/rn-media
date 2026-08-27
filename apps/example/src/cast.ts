/**
 * The cast side of the playback layer: `@timbre/cast` wired to this app.
 *
 * Three responsibilities, in the order they matter:
 *
 * 1. **Own the handoff.** `wireCastHandoff` runs the §3 state machine
 *    (LOCAL → CONNECTING → HANDOFF_TO_CAST → CAST_ACTIVE → HANDOFF_TO_LOCAL);
 *    this class provides its two structural sides — the local-player write
 *    surface and the queue snapshot — and routes its outputs onward.
 * 2. **Route receiver state into the broadcasts.** While CAST_ACTIVE the
 *    receiver's state flows through `hooks.onReceiverState` into the
 *    `SessionBridge`, so the notification, the lock screen and the in-app UI
 *    all mirror the receiver through the same three channels they always
 *    read. No new fan-out paths.
 * 3. **Be the receiver transport.** While casting, the controller forwards
 *    play/pause/seek/skip here instead of to mpv — one command vocabulary,
 *    two backends, exactly one of which owns the clock at a time.
 *
 * No React in this file, for the standing reason: casting must survive the
 * Activity being destroyed (that is half the point of receiver-side queues).
 */
import {
  Cast,
  CastError,
  canCastMedia,
  projectReceiverPosition,
  toCastError,
  wireCastHandoff,
  type CanCastVerdict,
  type CastConnectionState,
  type CastDeviceInfo,
  type CastDeviceVolume,
  type CastHandoff,
  type CastHandoffPhase,
  type CastHandoffQueueSnapshot,
  type CastReceiverSnapshot,
  type SkippedCastItem,
} from '@timbre/cast'
import type { Player, PlayerState } from '@timbre/player'
import { DEMO_SCHEME, type Track } from './data/tracks'
import { castMimeOf, castUrlOf } from './cast-broadcast'

export interface CastHooks {
  /** The player, or `undefined` before it exists. */
  readonly player: () => Player | undefined
  /** The app's queue — the source of truth the receiver queue projects. */
  readonly queue: () => readonly Track[]
  /**
   * Resume local playback through the app's focus gate (`Transport.play`) —
   * a transfer-back is a sound-*starting* event, so it requests audio focus
   * like every other one.
   */
  readonly resume: () => Promise<void>
  /**
   * Receiver state for the broadcasts, or `undefined` when casting ended and
   * the local player owns the channels again.
   */
  readonly onReceiverState: (snapshot: CastReceiverSnapshot | undefined) => void
  /**
   * The receiver's device volume while the cast side owns playback, or
   * `undefined` when the phone owns it again.
   *
   * Separate from {@link onReceiverState} because it moves on a different
   * clock — the speaker's own knob and the Google Home app land here too — and
   * because it feeds a different thing: `MediaService.setRemotePlayback`, which
   * is what routes the phone's hardware volume keys to the speaker with the app
   * backgrounded or the screen locked.
   */
  readonly onRemoteVolume: (volume: CastDeviceVolume | undefined) => void
  /** Re-render notification for the UI. */
  readonly onChange: () => void
}

export class CastIntegration {
  readonly #hooks: CastHooks
  #handoff: CastHandoff | undefined
  #starting: Promise<void> | undefined

  #castState: CastConnectionState = 'unavailable'
  #phase: CastHandoffPhase = 'local'
  #devices: readonly CastDeviceInfo[] = []
  #device: CastDeviceInfo | null = null
  #discovering = false
  #error: CastError | undefined
  #skipped: readonly SkippedCastItem[] = []
  #lastReceiver: CastReceiverSnapshot | undefined
  /** One transfer note for the section's status line — the last discontinuity. */
  #transferNote: string | undefined
  /** Signed-URL recipe guard: one automatic re-resolve per track per session. */
  readonly #reResolved = new Set<string>()
  /**
   * Fingerprint of the queue the receiver last got. `QueueMirror` re-reads
   * (and re-announces) the queue on events that change nothing the receiver
   * cares about; a resync restarts the receiver item, so it only runs when
   * the queue *content* actually moved.
   */
  #queuePrint = ''
  /** Last known receiver *device* volume — the layer the in-app slider drives while casting. */
  #deviceVolume: CastDeviceVolume | undefined
  /**
   * Whether the media session currently believes playback is remote.
   *
   * Tracked so the "back to local" publish happens exactly once, at the moment
   * ownership actually moves — republishing `undefined` on every phase tick
   * would be harmless but noisy, and never publishing it would leave the
   * session routing volume keys at a speaker that is no longer playing.
   */
  #remotePublished = false
  /** A `getDeviceVolume()` read in flight — see {@link #primeVolume}. */
  #primingVolume = false
  /**
   * Transport intent arriving DURING the handoff (phase `handoff-to-cast`),
   * kept to replay against the receiver the moment `cast-active` lands.
   *
   * Why this exists (device-found): the local player is already paused for
   * the handoff, so routing a mid-handoff tap to mpv would *start phone
   * audio in parallel with the speaker* — the one thing a handoff must never
   * do. The receiver cannot take transport yet (its queue is still loading),
   * so the intent is buffered, last-wins per kind, and flushed in order:
   * cursor move first, then seek, then play/pause.
   */
  #pending:
    | {
        move?: { kind: 'jump'; index: number } | { kind: 'next' | 'previous' }
        seek?: number
        playing?: boolean
      }
    | undefined
  /** Queue cursor + clock + intent at handoff time — the base `#pending` deltas apply to. */
  #lastSnapshot: { index: number; position: number; playing: boolean } | undefined

  constructor(hooks: CastHooks) {
    this.#hooks = hooks
  }

  /* --- reads (what the Cast section draws) -------------------------------- */

  get state(): CastConnectionState {
    return this.#castState
  }
  get phase(): CastHandoffPhase {
    return this.#phase
  }
  get devices(): readonly CastDeviceInfo[] {
    return this.#devices
  }
  get device(): CastDeviceInfo | null {
    return this.#device
  }
  get discovering(): boolean {
    return this.#discovering
  }
  get error(): CastError | undefined {
    return this.#error
  }
  get skipped(): readonly SkippedCastItem[] {
    return this.#skipped
  }
  get transferNote(): string | undefined {
    return this.#transferNote
  }
  /** Any phase but `local`: the machine is mid-handoff or casting. */
  get engaged(): boolean {
    return this.#phase !== 'local'
  }
  /** The receiver owns playback: transport must be forwarded here. */
  get controlsPlayback(): boolean {
    return this.#phase === 'cast-active'
  }
  /**
   * Transport belongs to the cast side: casting, or handing off to it. The
   * controller routes on THIS, not on {@link controlsPlayback} — during
   * `handoff-to-cast` the local player is already paused for the session, so
   * a command routed to mpv would start phone audio under the speaker's.
   * Mid-handoff commands are buffered and replayed once the receiver is up.
   */
  get owns(): boolean {
    return this.#phase === 'cast-active' || this.#phase === 'handoff-to-cast'
  }
  /** Receiver device volume (0..1) + mute, while a session is up. */
  get deviceVolume(): CastDeviceVolume | undefined {
    return this.#deviceVolume
  }
  /** Reconciled JS index the receiver is on, while cast-active. */
  get receiverIndex(): number | undefined {
    return this.#handoff?.receiverItemIndex
  }
  /** Last receiver anchor, for anything that needs a projected position. */
  get receiver(): CastReceiverSnapshot | undefined {
    return this.#lastReceiver
  }

  /** Castability verdict per track, for the section's per-track greying. */
  castability(track: Track): CanCastVerdict {
    return canCastMedia({ url: castUrlOf(track), mimeType: castMimeOf(track) })
  }

  /* --- startup ------------------------------------------------------------ */

  /** Idempotent, like every `start` in this layer. */
  start(): Promise<void> {
    return (this.#starting ??= this.#create())
  }

  async #create(): Promise<void> {
    try {
      // Resolves 'unavailable' on GMS-less devices — a capability answer the
      // section renders honestly, never a crash.
      this.#castState = await Cast.initialize()
    } catch (cause) {
      // initialize() only rejects on genuine plumbing failures (no context);
      // typed, surfaced, and the section stays in its unavailable state.
      this.#error = toCastError(cause)
      console.warn('[example] cast init failed:', this.#error.message)
      this.#hooks.onChange()
      return
    }

    Cast.addListener('castState', (event) => {
      this.#castState = event.state
      this.#device = event.device
      if (event.state === 'connected') {
        // Prime the volume readout — the event stream only reports *changes*.
        this.#primeVolume()
      } else {
        this.#deviceVolume = undefined
        this.#publishRemote()
      }
      this.#hooks.onChange()
    })
    Cast.addListener('devices', (devices) => {
      this.#devices = devices
      this.#hooks.onChange()
    })
    Cast.addListener('deviceVolume', (volume) => {
      // The speaker's own knob, the Google Home app and our slider all land
      // here — one fact, whoever moved it.
      this.#deviceVolume = volume
      // …and one fact the media session needs too, because the lock screen's
      // volume rocker steps from whatever level was last published.
      this.#publishRemote()
      this.#hooks.onChange()
    })

    this.#handoff = wireCastHandoff(
      {
        play: () => this.#hooks.resume(),
        pause: () => this.#hooks.player()?.pause(),
        seekTo: (seconds) => this.#seekLocalWhenReady(seconds),
        skipToIndex: (index) => this.#jumpLocalTo(index),
        getPosition: () => this.#hooks.player()?.getPosition() ?? 0,
        isPlaying: () => this.#hooks.player()?.state.playing === true,
      },
      {
        snapshot: () => this.#snapshot(),
        onPhaseChange: (phase) => {
          this.#phase = phase
          // Volume ownership moves with playback ownership, so it is decided
          // here rather than duplicated into each arm below.
          this.#publishRemote()
          if (phase === 'cast-active') {
            // A successful handoff supersedes any earlier failure — leaving
            // a stale "session-start-failed" strip on screen while the
            // speaker is audibly playing reads as a live problem (owner-
            // reported). Errors during the session still surface normally.
            this.#error = undefined
            this.#flushPending()
          }
          if (phase === 'local') {
            // Casting is over: hand the broadcast channels back to the local
            // player and forget the session-scoped notes.
            this.#lastReceiver = undefined
            this.#skipped = []
            this.#pending = undefined
            this.#reResolved.clear()
            this.#hooks.onReceiverState(undefined)
          }
          this.#hooks.onChange()
        },
        onReceiverState: (snapshot) => {
          this.#lastReceiver = snapshot
          this.#hooks.onReceiverState(snapshot)
          this.#hooks.onChange()
        },
        onTransfer: ({ direction, position, itemIndex }) => {
          this.#transferNote = `${
            direction === 'toCast' ? 'phone → receiver' : 'receiver → phone'
          } at ${position.toFixed(1)}s (entry ${String(itemIndex + 1)})`
          console.log(`[example] cast transfer: ${this.#transferNote}`)
          this.#hooks.onChange()
        },
        onItemsSkipped: (skipped) => {
          this.#skipped = skipped
          for (const s of skipped) {
            console.log(
              `[example] cast: skipped "${s.item.id}" (${s.reason}) — not castable`
            )
          }
          this.#hooks.onChange()
        },
        onError: (error) => this.#onCastError(error),
      }
    )
    this.#hooks.onChange()
  }

  /* --- discovery & session ------------------------------------------------ */

  async scan(): Promise<void> {
    if (this.#castState === 'unavailable') return
    this.#discovering = true
    this.#hooks.onChange()
    try {
      await Cast.startDiscovery()
      this.#devices = await Cast.getCastDevices()
    } catch (cause) {
      this.#fail(cause)
    }
    this.#hooks.onChange()
  }

  async stopScan(): Promise<void> {
    this.#discovering = false
    this.#hooks.onChange()
    try {
      // Safe even mid-connect: the native side defers the actual teardown
      // while a session start is in flight (the connect-ordering rule).
      await Cast.stopDiscovery()
    } catch (cause) {
      this.#fail(cause)
    }
  }

  /** Connect **before** stopping discovery — the ordering rule, kept visibly. */
  async connect(deviceId: string): Promise<void> {
    const handoff = this.#handoff
    if (handoff === undefined) return
    try {
      await handoff.castTo(deviceId)
      if (this.#discovering) await this.stopScan()
    } catch (cause) {
      this.#fail(cause)
    }
  }

  /** End the session; `transferBack` resumes locally at the receiver position. */
  async disconnect(transferBack: boolean): Promise<void> {
    try {
      await this.#handoff?.stopCasting({ transferBackToLocal: transferBack })
    } catch (cause) {
      this.#fail(cause)
    }
  }

  /** The JS queue changed while casting — reload the receiver projection. */
  onQueueChanged(): void {
    if (!this.controlsPlayback) return
    const print = this.#fingerprint()
    if (print === this.#queuePrint) return
    this.#handoff?.syncQueue() // #snapshot() re-stamps the fingerprint
  }

  dismissError(): void {
    this.#error = undefined
    this.#hooks.onChange()
  }

  /* --- receiver transport (the controller forwards here while casting) ---- */

  /*
   * Every command below has a mid-handoff shape: while `handoff-to-cast` the
   * receiver has no queue to steer yet, so the intent is remembered
   * (last-wins) and `#flushPending` replays it the moment `cast-active`
   * lands. See `#pending`'s doc for why it must not fall through to mpv.
   */

  play(): void {
    if (this.#buffering()) {
      this.#pending = { ...this.#pending, playing: true }
      return
    }
    void Cast.play().catch((cause: unknown) => this.#fail(cause))
  }
  pause(): void {
    if (this.#buffering()) {
      this.#pending = { ...this.#pending, playing: false }
      return
    }
    void Cast.pause().catch((cause: unknown) => this.#fail(cause))
  }
  toggle(): void {
    if (this.#buffering()) {
      const playing =
        this.#pending?.playing ?? this.#lastSnapshot?.playing ?? false
      this.#pending = { ...this.#pending, playing: !playing }
      return
    }
    if (this.#lastReceiver?.playing === true) this.pause()
    else this.play()
  }
  seekTo(seconds: number): void {
    if (this.#buffering()) {
      this.#pending = { ...this.#pending, seek: Math.max(0, seconds) }
      return
    }
    void Cast.seek(seconds).catch((cause: unknown) => this.#fail(cause))
  }
  /**
   * Relative seek against the *projected* receiver clock — same anchor rule
   * as everywhere: the last `mediaStatus` plus elapsed × rate, never a poll.
   * Mid-handoff the base is the handoff snapshot's clock (nothing advanced
   * since — the local player is paused and the receiver has not started).
   */
  seekBy(deltaSeconds: number): void {
    if (this.#buffering()) {
      const base = this.#pending?.seek ?? this.#lastSnapshot?.position ?? 0
      this.#pending = {
        ...this.#pending,
        seek: Math.max(0, base + deltaSeconds),
      }
      return
    }
    const anchor = this.#lastReceiver
    if (anchor === undefined) return
    const position = projectReceiverPosition(anchor, Date.now()) + deltaSeconds
    this.seekTo(Math.max(0, position))
  }
  next(): void {
    if (this.#buffering()) {
      this.#pending = { ...this.#pending, move: { kind: 'next' }, seek: undefined }
      return
    }
    void this.#handoff?.skipToNext().catch((cause: unknown) => this.#fail(cause))
  }
  previous(): void {
    if (this.#buffering()) {
      this.#pending = {
        ...this.#pending,
        move: { kind: 'previous' },
        seek: undefined,
      }
      return
    }
    void this.#handoff
      ?.skipToPrevious()
      .catch((cause: unknown) => this.#fail(cause))
  }
  jumpTo(index: number): void {
    if (this.#buffering()) {
      // A cursor move obsoletes any earlier scrub — it was aimed at the old entry.
      this.#pending = {
        ...this.#pending,
        move: { kind: 'jump', index },
        seek: undefined,
      }
      return
    }
    void this.#handoff
      ?.skipToItem(index)
      .catch((cause: unknown) => this.#fail(cause))
  }

  /**
   * In-app volume while casting drives the SPEAKER (device volume — the
   * primary layer of the two-layer API; stream volume stays available for
   * per-track trims). `0..1`, the same scale the local player uses.
   */
  setVolume(volume: number): void {
    void Cast.setDeviceVolume(Math.max(0, Math.min(1, volume))).catch(
      (cause: unknown) => this.#fail(cause)
    )
  }
  setMuted(muted: boolean): void {
    void Cast.setDeviceMuted(muted).catch((cause: unknown) => this.#fail(cause))
  }
  toggleMuted(): void {
    this.setMuted(this.#deviceVolume?.muted !== true)
  }

  /* --- internals ---------------------------------------------------------- */

  /**
   * Tell the media session whether playback is remote, and at what volume.
   *
   * The predicate is {@link owns} — the same one the controller routes
   * transport on. Volume follows the output, so the two must not disagree:
   * publishing "remote" while mpv still owns the sound would send the volume
   * keys to a speaker that is not playing.
   *
   * `undefined` (back to local) is published exactly once, when ownership
   * actually moves. The volume itself is republished on every receiver volume
   * event, because a hardware key press is a *relative* gesture: the library
   * steps one notch from whatever level was last published, so a stale level
   * would make the first press after somebody touched the speaker's own knob
   * jump to the wrong place.
   */
  #publishRemote(): void {
    // Ownership can move before any volume is known — device-found: the Cast
    // framework RESUMES an existing session at `CastContext` init, so the
    // `castState` transition into `connected` (where the priming read lives)
    // never fires, and the event stream only reports *changes*. Without this
    // the session stayed `volumeType=LOCAL` for the whole cast and the volume
    // keys kept moving the phone's stream — the exact bug being fixed.
    if (this.owns && this.#deviceVolume === undefined) this.#primeVolume()
    const volume = this.owns ? this.#deviceVolume : undefined
    if (volume === undefined) {
      if (!this.#remotePublished) return
      this.#remotePublished = false
      this.#hooks.onRemoteVolume(undefined)
      return
    }
    this.#remotePublished = true
    this.#hooks.onRemoteVolume(volume)
  }

  /**
   * Read the receiver's current volume once, because the event stream only
   * reports *changes* and there may not be one for minutes.
   *
   * Guarded against re-entry: `#publishRemote` runs on every phase tick and
   * every receiver status, and a burst of `getDeviceVolume()` calls would be a
   * burst of round trips to answer one question. A failure is not retried
   * here — the session may be going away, and the next `deviceVolume` event or
   * the next ownership change asks again.
   */
  #primeVolume(): void {
    if (this.#primingVolume) return
    this.#primingVolume = true
    void Cast.getDeviceVolume()
      .then((volume) => {
        this.#primingVolume = false
        // A real event that landed while the read was in flight is fresher.
        if (this.#deviceVolume !== undefined) return
        this.#deviceVolume = volume
        this.#publishRemote()
        this.#hooks.onChange()
      })
      .catch(() => {
        this.#primingVolume = false
      })
  }

  /** `true` while transport intent must be buffered rather than sent. */
  #buffering(): boolean {
    return this.#phase === 'handoff-to-cast'
  }

  /** Replay what the user asked for mid-handoff, now that the receiver is up. */
  #flushPending(): void {
    const pending = this.#pending
    this.#pending = undefined
    if (pending === undefined) return
    const handoff = this.#handoff
    void (async () => {
      try {
        if (pending.move?.kind === 'jump') {
          await handoff?.skipToItem(pending.move.index, pending.seek)
        } else if (pending.move?.kind === 'next') {
          await handoff?.skipToNext()
        } else if (pending.move?.kind === 'previous') {
          await handoff?.skipToPrevious()
        } else if (pending.seek !== undefined) {
          await Cast.seek(pending.seek)
        }
        if (pending.playing === true) await Cast.play()
        else if (pending.playing === false) await Cast.pause()
      } catch (cause) {
        this.#fail(cause)
      }
    })()
  }

  #fingerprint(): string {
    return this.#hooks
      .queue()
      .map((track) => `${track.id}|${track.uri}`)
      .join('\n')
  }

  /** One coherent read of queue + cursor + clock + intent, at handoff time. */
  #snapshot(): CastHandoffQueueSnapshot {
    this.#queuePrint = this.#fingerprint()
    const player = this.#hooks.player()
    const state = player?.state
    this.#lastSnapshot = {
      index: state?.playlist.index ?? 0,
      position: player?.getPosition() ?? 0,
      playing: state?.playing === true,
    }
    return {
      items: this.#hooks.queue().map((track) => ({
        id: track.id,
        // Resolved for the receiver's network — the resolver seam, sync here
        // because DEMO_SOURCES is a constant map (see cast-broadcast.ts).
        url: castUrlOf(track),
        mimeType: castMimeOf(track),
        metadata: {
          title: track.title,
          artist: track.artist,
          albumTitle: track.album,
          // Receivers fetch artwork themselves too — every TRACKS artwork is
          // already HTTPS, so it forwards as-is.
          artworkUrl: track.artworkUri,
        },
        live: track.isLive,
      })),
      index: state?.playlist.index ?? 0,
      position: player?.getPosition() ?? 0,
      playWhenReady: state?.playing === true,
    }
  }

  /**
   * The transfer-back cursor move, made race-free (device-found, the hard
   * way): the naive `playlist.jumpTo` resolves when mpv ACCEPTS the command,
   * not when the entry is open — the restore's seek then fired against a
   * state snapshot that still said `ready` from *before* the jump, mpv
   * rejected it (`error running command`) mid-reload, and the whole restore
   * aborted at 0:00 paused.
   *
   * Two rules fix it structurally:
   * - **Same entry: do not jump at all.** mpv faithfully *reloads* the
   *   current entry, which both restarts a warm stream and opens the very
   *   race above. The common transfer-back (came back to the same track the
   *   handoff left) becomes an instant seek.
   * - **Different entry: wait until the state SHOWS the target open** —
   *   `index === target` plus a settled status. The stale pre-jump snapshot
   *   can never satisfy that predicate, because its index is the old one.
   */
  async #jumpLocalTo(index: number): Promise<void> {
    const player = this.#hooks.player()
    if (player === undefined) return
    const live = this.#hooks.queue()[index]?.isLive === true
    if (!live && player.state.playlist.index === index) return
    // LIVE exception to the never-reload rule (owner-reported, 2026-08-14):
    // the entry sat paused for the whole cast session, so mpv's demuxer
    // cache holds minutes-old audio and its clock the pre-cast elapsed time
    // — unpausing resumes the past while the receiver was at the live edge.
    // A fresh open IS the live-edge resume (and resets the elapsed clock the
    // UI shows). The warm-resume optimisation stays for the finite case and
    // for plain queue taps (Transport.jumpTo), where the pause was seconds,
    // not a session.
    const sameEntry = player.state.playlist.index === index
    await player.playlist.jumpTo(index, { autoPlay: false })
    await this.#untilLocal(
      (state) =>
        state.playlist.index === index &&
        (state.status === 'ready' ||
          state.status === 'error' ||
          state.status === 'ended'),
      // A same-entry reload keeps the target index the whole time, so the
      // stale pre-reload 'ready' snapshot would satisfy the predicate
      // immediately — trust only fresh changes there.
      { fresh: sameEntry }
    )
  }

  /**
   * Seek that tolerates the entry still opening: mpv can only seek once the
   * entry is `ready`. Waits for that (bounded), seeks, and retries once if
   * mpv still rejects (a reload can slip in between the state read and the
   * command) — the same idea as the persistence layer's pending-resume,
   * scoped to one call.
   */
  async #seekLocalWhenReady(seconds: number): Promise<void> {
    const player = this.#hooks.player()
    if (player === undefined) return
    const settled = (state: PlayerState): boolean =>
      state.status === 'ready' ||
      state.status === 'error' ||
      state.status === 'ended'
    for (let attempt = 0; attempt < 2; attempt++) {
      // A failed first attempt means the state read was stale (mpv was mid-
      // reload) — the retry waits for the next CHANGE, never the same snapshot.
      await this.#untilLocal(settled, { fresh: attempt > 0 })
      if (player.state.status !== 'ready') return // nothing to seek into; 0 is the honest result
      try {
        await player.seekTo(seconds)
        return
      } catch (cause) {
        if (attempt > 0) {
          console.warn('[example] cast: resume seek failed:', cause)
        }
      }
    }
  }

  /**
   * Resolve once the player state satisfies `predicate` — checked against
   * the CURRENT state first (unless `fresh`, which trusts only *changes*),
   * then on every change. Bounded: a transfer-back is user-initiated and
   * foreground, so a JS timer is legal here; ten seconds of not-ready means
   * the entry is not coming and holding the restore hostage helps nobody.
   */
  #untilLocal(
    predicate: (state: PlayerState) => boolean,
    options?: { fresh?: boolean; timeoutMs?: number }
  ): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? 10_000
    const player = this.#hooks.player()
    if (
      player === undefined ||
      (options?.fresh !== true && predicate(player.state))
    ) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        unsubscribe()
        clearTimeout(timer)
        resolve()
      }
      const unsubscribe = player.onStateChange((state) => {
        if (predicate(state)) finish()
      })
      const timer = setTimeout(finish, timeoutMs)
    })
  }

  #onCastError(error: CastError): void {
    this.#error = error
    console.warn(`[example] cast ${error.code}: ${error.message}`)
    this.#hooks.onChange()

    // Failure-mode §5.5, the re-resolve-and-reload recipe: a receiver fetch
    // failure on a resolver-backed track re-resolves the source and reloads
    // the projection at the receiver's position. Bounded to one automatic
    // attempt per track — a URL that fails twice needs a human. (In this
    // demo the resolver is deterministic, so the reload proves the *shape*;
    // a real app's `api.sign(id)` returns a genuinely fresh URL.)
    if (error.code !== 'cast-receiver-fetch' || !this.controlsPlayback) return
    const index = this.receiverIndex
    const track = index === undefined ? undefined : this.#hooks.queue()[index]
    if (
      track === undefined ||
      !track.uri.startsWith(DEMO_SCHEME) ||
      this.#reResolved.has(track.id)
    ) {
      return
    }
    this.#reResolved.add(track.id)
    console.log(
      `[example] cast: re-resolving "${track.id}" and reloading the receiver queue`
    )
    this.#handoff?.syncQueue()
  }

  /** Typed, surfaced on the section's strip, never swallowed. */
  #fail(cause: unknown): void {
    this.#error = toCastError(cause)
    console.warn(`[example] cast ${this.#error.code}: ${this.#error.message}`)
    this.#hooks.onChange()
  }
}
