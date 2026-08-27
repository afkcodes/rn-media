/**
 * The media-session half of the playback layer: fan-out.
 *
 * Everything a remote surface can *see* is written here, and it is written to
 * exactly three channels — `setPlaybackState`, `setMediaItem`, `setQueue`. The
 * notification, the lock screen, Android Auto and this app's own UI all read
 * those three and nothing else, which is what stops the surfaces drifting
 * apart.
 *
 * Split out of the controller on purpose: this file would be almost unchanged
 * in an app that used a different player, because `@timbre/media-session`
 * does not know or care what makes the sound.
 */
import {
  MediaService,
  applyPersisted,
  withPersistence,
  type MediaHandler,
  type PersistedMediaService,
  type PersistedSession,
  type SleepTimerState,
} from '@timbre/media-session'
import type { PlayerState } from '@timbre/player'
import type { CastDeviceVolume, CastReceiverSnapshot } from '@timbre/cast'
import { ACCENT_ARGB } from '../theme'
import type { Track } from '../data/tracks'
import { durationMs, nowPlaying, toMediaItem, toPlaybackState } from './broadcast'
import { toCastMediaItem, toCastPlaybackState } from './cast-broadcast'
import { sessionStorage } from './persistence'

export interface SessionBridgeOptions {
  /** Built once, by `MediaService.init`. See `handler.ts`. */
  readonly handler: () => MediaHandler
  /** The player's current snapshot, for the catch-up broadcast on init. */
  readonly snapshot: () => PlayerState | undefined
  /**
   * The app's shuffle toggle, read at broadcast time.
   *
   * A getter rather than a field because it is **controller** state — mpv has
   * no shuffle mode to observe, so the player snapshot cannot carry it and the
   * bridge asks the owner instead. Repeat needs no twin here: `state.loop`
   * arrives inside every snapshot already.
   */
  readonly shuffleEnabled: () => boolean
  /** Re-render notification for the UI. */
  readonly onChange: () => void
}

export class SessionBridge {
  readonly #options: SessionBridgeOptions
  #service: PersistedMediaService | undefined
  #starting: Promise<void> | undefined
  #restored: PersistedSession | undefined
  #queue: readonly Track[] = []
  /** While `true`, channels 1–2 carry receiver state — see {@link publishCast}. */
  #castActive = false
  /** Last broadcast discontinuity signature — see {@link publish}. */
  #lastSignature = ''
  /** Last cast `mediaItem` signature — see {@link publishCast}. */
  #lastCastItem = ''
  /**
   * Published duration per track id, in ms, as the player learns them.
   *
   * Why the *queue* channel carries durations at all: on Android the media3
   * timeline — and with it the notification's seek bar — is built from the
   * queue. A queue entry with no duration is `C.TIME_UNSET`, which media3 reads
   * as "not seekable", and the scrubber then never appears however seekable the
   * playback state claims to be. Durations only exist once mpv has opened the
   * file, so the queue is re-broadcast the first time each one arrives: once
   * per track, on a discontinuity, never on a timer.
   */
  readonly #durations = new Map<string, number>()

  constructor(options: SessionBridgeOptions) {
    this.#options = options
  }

  /** The session that was recovered on launch, to re-apply on init. */
  setRestored(session: PersistedSession | undefined): void {
    this.#restored = session
  }

  /**
   * Bring the media session up if it is not up already.
   *
   * {@link stop} tears it down — that is what "stop" means here — and the
   * session contract is explicit that `init` may be called again once
   * `stopService()` has resolved. So every path that is about to make sound
   * goes through this first. Without it, playing after a stop would produce
   * audio with no notification and no remote controls forever, because
   * {@link publish} drops every broadcast while `#service` is undefined and
   * nothing else ever calls it again (the mount effect runs once).
   *
   * Callers deliberately do not await it: `#create` force-broadcasts the
   * player's current state when it resolves, so the session catches up by
   * itself rather than holding audio behind a native round trip.
   */
  ensure(): Promise<void> {
    return (this.#starting ??= this.#create())
  }

  async #create(): Promise<void> {
    try {
      const api = await MediaService.init(this.#options.handler, {
        android: {
          notificationChannelId: 'playback',
          notificationChannelName: 'Playback',
          notificationIcon: 'ic_notification',
          stopForegroundOnPause: true,
          // Deliberately far below media3's 10-minute default so the
          // demotion is observable in `dumpsys activity services` while
          // someone is watching. A shipping app would leave this alone (or
          // pick a value it can defend); this one is a test bed.
          stopForegroundTimeoutMs: 15_000,
          // Opt in to coming back from the dead. Paired with the
          // `MediaButtonReceiver` in this app's AndroidManifest.xml, with
          // `withPersistence` below, and with the two revival entry points
          // (the eager `import './src/playback'` in index.js and
          // `onRevivalRequested` here) — all are required, and the library
          // logs which one is missing.
          playbackResumption: true,
          // The alive-process half of resumption. After `stop()` the System
          // UI still offers its resumption card (stop ends background
          // execution, not the user's place in the album), but this process
          // already ran its module scope — the thing that re-inits a KILLED
          // process — and cannot run it again. So when the card (or a media
          // button) starts the service and the runtime is found alive, the
          // service asks the app to bring the session back up, and `ensure()`
          // is precisely this app's idempotent init path. The library only
          // fires this while no init is up or in flight, so `ensure`'s
          // `#starting` latch is never raced.
          onRevivalRequested: () => void this.ensure(),
          // The app accent on the notification — full ARGB, alpha included
          // (`0x1F6FEB` alone would be transparent black). A hint, not a
          // guarantee: Android 12+ media shades often derive their palette
          // from the artwork instead.
          notificationColor: ACCENT_ARGB,
        },
        // The cross-platform parity option: without it iOS pinned 15 s in both
        // directions while Android inherited media3's 5 s back / 15 s forward
        // — two behaviours from one JS call. Set to match this app's own jump
        // buttons (back 15 / forward 30), so the lock screen and the in-app
        // transport move by the same amounts.
        jumpForwardSeconds: 30,
        jumpBackwardSeconds: 15,
        onHandlerError: (method, cause) =>
          console.error(`[example] handler.${method} failed:`, cause),
      })
      // One line, and every broadcast below persists itself. The library gains
      // no dependency from this — `sessionStorage` is ours.
      this.#service = withPersistence(api, sessionStorage, {
        onError: (cause) =>
          console.error('[example] persisting the session failed:', cause),
      })
      // Put the recovered session on every remote surface before the player has
      // anything to say. It is a *paused* state by construction, so this does
      // not start the foreground service — the notification appears on play,
      // exactly as it would without persistence.
      if (this.#restored !== undefined) {
        applyPersisted(this.#service, this.#restored)
      }
      this.#publishQueue()
      const state = this.#options.snapshot()
      if (state !== undefined) this.#broadcast(state, true)
    } catch (cause) {
      console.error('[example] MediaService.init failed:', cause)
      // Let the next play retry: a failed init must not latch the app into a
      // permanently session-less state (`ensure` keys off this field).
      this.#starting = undefined
    }
    this.#options.onChange()
  }

  /* --- the cast override --------------------------------------------------- */

  /**
   * While a cast session is active the RECEIVER's state flows through the
   * same three channels — that is the whole §3 contract: the notification,
   * the lock screen and the app UI keep working because nothing about the
   * fan-out changed, only whose facts ride on it. Set with a snapshot to
   * broadcast receiver state (and silence the local `publish`, whose player
   * is deliberately paused and would otherwise fight the receiver for the
   * channels); set `undefined` when the transfer back completes.
   *
   * The queue channel is untouched: the JS queue stays the source of truth
   * on every surface, casting or not.
   */
  publishCast(
    snapshot: CastReceiverSnapshot | undefined,
    track: Track | undefined
  ): void {
    if (snapshot === undefined) {
      this.#castActive = false
      // Force the next local publish through: the local signature is stale by
      // an entire cast session.
      this.#lastSignature = ''
      this.#lastCastItem = ''
      return
    }
    this.#castActive = true
    const service = this.#service
    if (service === undefined) return
    // The receiver pushes a status every few seconds (device-measured ~3 s);
    // each one is a genuine position discontinuity, so the playback state
    // always goes out — but the ITEM channel (title, artwork, duration) only
    // changes on track boundaries, and re-sending it per status would make
    // every surface re-resolve metadata it already has.
    const itemSignature = `${track?.id ?? ''}|${String(snapshot.duration)}|${String(snapshot.itemIndex)}`
    if (itemSignature !== this.#lastCastItem) {
      this.#lastCastItem = itemSignature
      service.setMediaItem(track && toCastMediaItem(track, snapshot))
    }
    service.setPlaybackState(toCastPlaybackState(snapshot))
  }

  /**
   * Tell the session that the audio is coming out of the speaker — and how loud
   * it is — or that the phone has it back.
   *
   * This is what makes the **hardware volume keys drive the speaker with the
   * app backgrounded or the screen locked**, which no Activity-level key
   * handler can do. The session starts advertising remote playback, Android
   * routes volume presses to it instead of to the phone's music stream, and
   * they arrive at `DemoMediaHandler.onSetDeviceVolume` → `Playback.setVolume`
   * → `Cast.setDeviceVolume`. Clearing it hands the keys back to the phone.
   *
   * Not one of the three channels: it describes the *output*, says nothing
   * about what is playing, and is sticky — the receiver's own status updates
   * flow through `publishCast` and neither carry nor clear it.
   *
   * Nothing here is Cast-specific on the library side; `@timbre/media-session`
   * has no idea a receiver exists (and no dependency on `@timbre/cast`). Any
   * remote backend publishes the same shape.
   */
  publishRemotePlayback(volume: CastDeviceVolume | undefined): void {
    this.#service?.setRemotePlayback(
      volume === undefined
        ? undefined
        : {
            // Clamped rather than forwarded raw: the library rejects anything
            // outside 0..1 (correctly — it is the one payload whose garbage is
            // invisible), and a receiver reporting 1.0000001 is not a reason
            // to throw inside a volume event.
            volume: Math.max(0, Math.min(1, volume.volume)),
            muted: volume.muted,
            // Opt-in, and this app opts in because it exists to demonstrate the
            // library at full capability. With the screen off, Android hands
            // the volume keys to the phone's own stream whenever a *system*
            // sound (a notification, a ringtone) was the last local audio —
            // and a cast plays nothing locally to win the slot back, so the
            // press moves neither device (bug #53). Holding a silent local
            // output keeps this app in that slot.
            //
            // It is off by default in the library because it holds a real
            // audio output open for the whole cast: a real app should turn it
            // on only if lock-screen volume matters more than idle battery.
            holdLocalAudioSlot: true,
          }
    )
  }

  /* --- channels ---------------------------------------------------------- */

  /** Channel 3. Call whenever the app's queue model changes. */
  setQueue(tracks: readonly Track[]): void {
    this.#queue = tracks
    this.#publishQueue()
  }

  #publishQueue(): void {
    this.#service?.setQueue(
      // `uri` is the one app-side field; `MediaItem` is metadata only, so it
      // is destructured away rather than shipped to the session. Everything
      // else — including the wave-2 extended tags (`trackNumber`, `year`,
      // `isLive`) — rides along, so a queue-rendering controller sees the same
      // facts the current-item channel carries.
      //
      // Ids are the track's own, which means "play next" can legitimately put
      // the same id in the queue twice. That is fine here — `setMediaItem`
      // enriches the entry at the broadcast `queueIndex` and both copies carry
      // identical metadata — and it keeps the persisted `mediaItem.id` equal to
      // a `TRACKS` id, which is what the restore path matches on.
      this.#queue.map(({ uri: _uri, ...item }) => ({
        ...item,
        duration: this.#durations.get(item.id),
      }))
    )
  }

  /**
   * Channels 1 and 2, driven off the player rather than off a React effect.
   *
   * Broadcast only when a *discontinuity* signature changes. `PlayerState` also
   * carries `bufferedPosition`, which mpv updates several times a second; keying
   * on the whole snapshot would put the media session back on a timer, which is
   * exactly what the position anchor exists to avoid. (Measured: ~6 broadcasts
   * per second before this, 4 in 22 s after.) The buffered figure still rides
   * along with the next real change.
   */
  publish(state: PlayerState, track: Track | undefined): void {
    const signature = [
      state.status,
      state.playing,
      state.playlist.index,
      state.playlist.count,
      // The *published* duration, not `state.duration`: on a live stream mpv's
      // raw duration is the cache length and grows forever. See `durationMs`.
      track === undefined ? undefined : durationMs(track, state),
      // The ICY now-playing line: changes once per song, so it is a genuine
      // discontinuity and not a ticker. Without it in the signature the
      // notification would keep showing whatever was on air when the station
      // was tuned in.
      track === undefined ? undefined : nowPlaying(track, state),
      state.seeking,
      state.positionAnchor.timestamp,
      state.error?.message,
      // Repeat and shuffle are discontinuities too: each changes at most once
      // per user gesture, and the broadcast that carries the new value is what
      // completes the pending operation on Android and flips the icon.
      state.loop,
      this.#options.shuffleEnabled(),
    ].join('|')

    if (signature === this.#lastSignature) return
    this.#lastSignature = signature
    this.#broadcast(state, false, track)
  }

  #broadcast(state: PlayerState, force: boolean, track?: Track): void {
    const service = this.#service
    if (service === undefined) return
    // The receiver owns channels 1–2 for the whole session; a local snapshot
    // here is the deliberately-paused mpv, not news.
    if (this.#castActive) return
    if (force) this.#lastSignature = ''
    const entry = track ?? this.#queue[state.playlist.index]

    // A duration we have not published yet: refresh the queue so the timeline
    // entry becomes seekable. Guarded on the value, so this is one extra
    // broadcast per track for the whole session.
    if (entry !== undefined) {
      const ms = durationMs(entry, state)
      if (ms !== undefined && this.#durations.get(entry.id) !== ms) {
        this.#durations.set(entry.id, ms)
        this.#publishQueue()
      }
    }

    service.setMediaItem(entry && toMediaItem(entry, state))
    service.setPlaybackState(
      toPlaybackState(state, this.#options.shuffleEnabled())
    )
  }

  /** Re-broadcast unconditionally — used after the queue is edited. */
  refresh(state: PlayerState | undefined): void {
    if (state !== undefined) this.#broadcast(state, true)
  }

  /* --- sleep timer ------------------------------------------------------- */

  /**
   * Arm the **native** sleep timer.
   *
   * Note what is *not* here: a `setTimeout`. With the Activity destroyed, JS
   * timers stop firing, which is exactly the state a sleep timer is used in.
   * The session schedules this on the platform's own timer instead.
   */
  setSleepTimer(seconds: number): void {
    try {
      this.#service?.setSleepTimer(seconds)
      console.log(`[example] sleep timer armed for ${seconds}s`)
    } catch (cause) {
      console.warn('[example] sleep timer rejected:', cause)
    }
    this.#options.onChange()
  }

  /**
   * Arm the other shape of timer: pause when the **current item finishes**.
   *
   * Same native scheduling as {@link setSleepTimer}; the deadline is computed
   * natively from the broadcasts this bridge already sends (`duration` minus
   * the projected position, over the rate) and re-armed on every one of them —
   * so a seek, a pause or a late-arriving duration all move it without
   * anything new crossing the bridge.
   */
  setSleepTimerToTrackEnd(): void {
    try {
      this.#service?.setSleepTimerToTrackEnd()
      console.log('[example] sleep timer armed for end of track')
    } catch (cause) {
      console.warn('[example] sleep timer rejected:', cause)
    }
    this.#options.onChange()
  }

  cancelSleepTimer(): void {
    this.#service?.cancelSleepTimer()
    console.log('[example] sleep timer cancelled')
    this.#options.onChange()
  }

  /**
   * Tell any connected car that a browse node changed.
   *
   * The sign-in toggle is the demo: flipping it changes what `getChildren`
   * answers for every node, so every node is invalidated. A real app calls it
   * with the one parent whose contents moved.
   */
  invalidateBrowse(parentId?: string): void {
    this.#service?.invalidateBrowse(parentId)
    console.log(`[example] invalidateBrowse(${parentId ?? 'everything'})`)
  }

  /**
   * Polled by the UI. Safe from JS *because the UI is on screen.*
   *
   * `getSleepTimer()` rather than `getSleepTimerRemaining()`, because the badge
   * has to tell "armed for end of track, deadline unknowable" (a live stream,
   * or a duration that has not arrived) apart from "not armed" — the bare
   * number is `undefined` for both, the discriminated state is not.
   */
  sleepTimer(): SleepTimerState | undefined {
    return this.#service?.getSleepTimer()
  }

  /* --- checkpoints and teardown ------------------------------------------ */

  /**
   * Write the session out *now*.
   *
   * The tee saves on every broadcast, and this app broadcasts only on
   * discontinuities — so a track played straight through produces no write at
   * all, and the position on disk stays wherever the last play/seek left it.
   * The library will not paper over that with a timer (a periodic save is the
   * per-tick write the whole design avoids, and the JS timer driving it would
   * freeze in the background anyway), so choosing the moment is the app's job.
   *
   * The moment this app picks is *leaving the foreground* — see the `AppState`
   * subscription in `index.ts` — which is the last instant it is guaranteed to
   * run.
   */
  save(): void {
    this.#service?.save()
  }

  /**
   * The only thing that ends background execution — pause never does.
   *
   * Clearing `#starting` is what re-arms {@link ensure}, so the next play
   * builds a fresh session and the notification comes back.
   */
  async stop(): Promise<void> {
    const service = this.#service
    this.#service = undefined
    this.#starting = undefined
    this.#lastSignature = ''
    // Checkpoint at the stop moment — the TSDoc on `save()` names "just before
    // a deliberate stopService()" as one of the moments worth taking, and this
    // is why: the pause that precedes a stop round-trips through mpv and comes
    // back as a broadcast *after* this teardown has already detached the tee,
    // so without this line the last persisted position is whatever the last
    // discontinuity happened to be — possibly minutes stale. `save()` re-projects
    // the live anchor to now, so the resumption card resumes where the user
    // actually pressed stop. (Verified on device: mirror read back 91.5 s where
    // the stop happened at 120 s before this line existed.)
    service?.save()
    await service?.stopService()
  }
}
