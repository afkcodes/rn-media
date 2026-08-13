/**
 * The cast side of the playback layer: `@rn-media/cast` wired to this app.
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
  type CastHandoff,
  type CastHandoffPhase,
  type CastHandoffQueueSnapshot,
  type CastReceiverSnapshot,
  type SkippedCastItem,
} from '@rn-media/cast'
import type { Player } from '@rn-media/player'
import { DEMO_SCHEME, type Track } from '../data/tracks'
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
      this.#hooks.onChange()
    })
    Cast.addListener('devices', (devices) => {
      this.#devices = devices
      this.#hooks.onChange()
    })

    this.#handoff = wireCastHandoff(
      {
        play: () => void this.#hooks.resume(),
        pause: () => this.#hooks.player()?.pause(),
        seekTo: (seconds) => this.#seekLocalWhenReady(seconds),
        skipToIndex: (index) =>
          this.#hooks.player()?.playlist.jumpTo(index, { autoPlay: false }),
        getPosition: () => this.#hooks.player()?.getPosition() ?? 0,
        isPlaying: () => this.#hooks.player()?.state.playing === true,
      },
      {
        snapshot: () => this.#snapshot(),
        onPhaseChange: (phase) => {
          this.#phase = phase
          if (phase === 'local') {
            // Casting is over: hand the broadcast channels back to the local
            // player and forget the session-scoped notes.
            this.#lastReceiver = undefined
            this.#skipped = []
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
    if (this.controlsPlayback) this.#handoff?.syncQueue()
  }

  dismissError(): void {
    this.#error = undefined
    this.#hooks.onChange()
  }

  /* --- receiver transport (the controller forwards here while casting) ---- */

  play(): void {
    void Cast.play().catch((cause: unknown) => this.#fail(cause))
  }
  pause(): void {
    void Cast.pause().catch((cause: unknown) => this.#fail(cause))
  }
  toggle(): void {
    if (this.#lastReceiver?.playing === true) this.pause()
    else this.play()
  }
  seekTo(seconds: number): void {
    void Cast.seek(seconds).catch((cause: unknown) => this.#fail(cause))
  }
  /**
   * Relative seek against the *projected* receiver clock — same anchor rule
   * as everywhere: the last `mediaStatus` plus elapsed × rate, never a poll.
   */
  seekBy(deltaSeconds: number): void {
    const anchor = this.#lastReceiver
    if (anchor === undefined) return
    const position = projectReceiverPosition(anchor, Date.now()) + deltaSeconds
    this.seekTo(Math.max(0, position))
  }
  next(): void {
    void this.#handoff?.skipToNext().catch((cause: unknown) => this.#fail(cause))
  }
  previous(): void {
    void this.#handoff
      ?.skipToPrevious()
      .catch((cause: unknown) => this.#fail(cause))
  }
  jumpTo(index: number): void {
    void this.#handoff
      ?.skipToItem(index)
      .catch((cause: unknown) => this.#fail(cause))
  }

  /* --- internals ---------------------------------------------------------- */

  /** One coherent read of queue + cursor + clock + intent, at handoff time. */
  #snapshot(): CastHandoffQueueSnapshot {
    const player = this.#hooks.player()
    const state = player?.state
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
   * Seek that tolerates the entry still opening: a transfer-back does
   * `jumpTo(index, {autoPlay: false})` and then seeks, but mpv can only seek
   * once the entry is `ready`. Waits for that (bounded), then seeks — the
   * same idea as the persistence layer's pending-resume, scoped to one call.
   */
  async #seekLocalWhenReady(seconds: number): Promise<void> {
    const player = this.#hooks.player()
    if (player === undefined) return
    if (player.state.status === 'ready') {
      await player.seekTo(seconds)
      return
    }
    await new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        unsubscribe()
        clearTimeout(timer)
        resolve()
      }
      const unsubscribe = player.onStateChange((state) => {
        if (state.status === 'ready') {
          player.seekTo(seconds).catch((cause: unknown) => {
            console.warn('[example] cast: resume seek failed:', cause)
          })
          finish()
        } else if (state.status === 'error' || state.status === 'ended') {
          finish() // nothing to seek into; resuming at 0 is the honest result
        }
      })
      // Bounded: a transfer-back is user-initiated and foreground, so a JS
      // timer is legal here; ten seconds of not-ready means the entry is not
      // coming and holding the restore hostage helps nobody.
      const timer = setTimeout(finish, 10_000)
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
