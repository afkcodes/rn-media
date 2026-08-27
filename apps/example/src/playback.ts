/**
 * The whole common-path setup, in one file — the thing to copy. A media app
 * wires four things in order — `Player.create → wireAudioSession →
 * MediaService.init(one handler) → broadcast` — plus the honest edges
 * (persistence restore, the ICY station line, retry/error). It drives the PLAYER
 * directly and knows nothing about Chromecast or the other advanced demos; those
 * wire themselves in through the small seams at the bottom.
 *
 * It all lives OUTSIDE React and starts at module scope (see `index.js`), because
 * on Android the JS runtime outlives the Activity but the React tree does not —
 * a player or session owned by a hook would be torn down on the Back key while a
 * notification was still on screen. Hooks suit a screen-scoped player; a media
 * app's player is process-scoped, created once, and React only reads it.
 */
import { useEffect, useReducer } from 'react'
import { AppState } from 'react-native'
import {
  Player,
  toPlayerError,
  type PlayerError,
  type PlayerState,
} from '@timbre/player'
import {
  AudioSession,
  AudioSessionPresets,
  wireAudioSession,
} from '@timbre/audio-session'
import {
  applyPersisted,
  BaseMediaHandler,
  MediaService,
  restorePersisted,
  withPersistence,
  withQueueHandling,
  type BrowseItem,
  type MediaHandler,
  type MediaItem,
  type MediaRepeatMode,
  type PersistedMediaService,
  type PersistedSession,
  type SearchFocus,
  type SessionError,
} from '@timbre/media-session'
import { TRACKS, type Track } from './data/tracks'
import { createDemoResolver } from './resolver'
import { sessionStorage } from './storage'
import { ACCENT_ARGB } from './theme'
import {
  durationMs,
  nowPlaying,
  repeatToLoop,
  toMediaItem,
  toPlaybackState,
} from './projections'
// The car browse TREE is an advanced feature, so it lives in advanced/; the
// handler's three-line getChildren wiring stays here only because the media
// session takes exactly one handler for every surface.
import {
  assertSignedIn,
  childrenOf,
  itemFor,
  noteRecentlyPlayed,
  queueIndexFor,
  searchTracks,
} from './advanced/browse'

/* --- App-owned state: the few facts the UI reads that are not PlayerState. --- */

/** One queue row: mpv's stable entry id joined to this app's metadata. */
export interface QueueRow {
  /** mpv's entry id — the identity that survives every queue edit (a React key). */
  readonly entryId: number
  readonly current: boolean
  readonly track: Track
}

/** What a retryable entry is doing while it re-attempts — the retry banner. */
export interface RetryNote {
  readonly index: number
  readonly attempt: number
  readonly maxAttempts: number
  readonly message: string
}

/** The reactive snapshot `usePlayback` hands the UI. */
export interface PlaybackSnapshot {
  readonly player: Player | undefined
  readonly queueRows: readonly QueueRow[]
  readonly queue: readonly Track[]
  /** ICY station identity, from the metadata tags. */
  readonly station: string | undefined
  readonly retrying: RetryNote | undefined
  readonly error: PlayerError | undefined
  readonly errorAttempts: number
  readonly sessionError: SessionError | undefined
  readonly shuffleEnabled: boolean
  readonly restoreNote: string
}

let player: Player | undefined
let service: PersistedMediaService | undefined
let handler: DemoHandler | undefined

let queueRows: readonly QueueRow[] = TRACKS.map((track, index) => ({
  entryId: -1 - index,
  current: index === 0,
  track,
}))
let station: string | undefined
let retrying: RetryNote | undefined
let error: PlayerError | undefined
let errorAttempts = 0
let sessionError: SessionError | undefined
// mpv has no shuffle *mode* — only a reorder command — so "shuffle on" is app
// state and rides into the broadcast by hand (repeat, which mpv owns as `loop`,
// does not).
let shuffleEnabled = false
let restoreNote = 'not attempted'

const listeners = new Set<() => void>()
function notify(): void {
  for (const listener of listeners) listener()
}

/* --- The media handler: fan-in. Every remote surface (notification, lock screen,
 * Bluetooth, a car, Assistant) funnels into this ONE object, which is also the
 * app's command vocabulary — the UI calls the same functions below.
 * `withQueueHandling` gives it queue index arithmetic + the channel-3 broadcast
 * for free; this class writes only what makes the sound, all against the player. */

class DemoHandler extends withQueueHandling(BaseMediaHandler, {
  // Persist the queue too: the mixin broadcasts channel 3 through this, so the
  // record `withPersistence` writes carries the queue. Late-bound because the
  // service is built *after* the handler (init needs the handler first).
  broadcaster: { setQueue: (items) => service?.setQueue(items) },
}) {
  #log(name: string): void {
    // The on-device proof a remote button reached JS (`adb logcat -s ReactNativeJS`).
    console.log(`[example] remote command: ${name}`)
  }

  override play(): void {
    this.#log('play')
    void localPlay()
  }
  override pause(): void {
    this.#log('pause')
    player?.pause()
  }
  /**
   * The **remote** stop: stop playing, keep the session — the library's `stop`
   * contract. Never the app's "stop & dismiss" (that ends background execution):
   * on iOS the system replaces pause with a *stop* button for a live stream, and
   * routing that to teardown left the lock-screen card unrecoverable.
   */
  override stop(): void {
    this.#log('stop')
    void stopPlayback()
  }
  override seekTo(ms: number): void {
    this.#log('seekTo')
    void player?.seekTo(ms / 1000)
  }
  override setRate(rate: number): void {
    this.#log('setRate')
    player?.setRate(rate)
  }

  // The two skip overrides defer to the PLAYER's own skip — which is loop-aware
  // (it wraps under `loop: playlist` and not otherwise), something the mixin's
  // static index math cannot be. `skipToQueueItem` keeps the mixin's path so a
  // car/notification queue-item tap flows through `playQueueItem`.
  override skipToNext(): void {
    this.#log('skipToNext')
    ensureSession()
    void player?.playlist.next()
  }
  override skipToPrevious(): void {
    this.#log('skipToPrevious')
    ensureSession()
    // Restart-or-previous is the library's own rule inside `playlist.previous`.
    void player?.playlist.previous()
  }
  /** The one sound-making method the mixin asks a subclass to write. */
  override playQueueItem(_item: MediaItem, index: number): Promise<void> {
    return localJumpTo(index)
  }

  override onSetRepeatMode(mode: MediaRepeatMode): void {
    this.#log(`onSetRepeatMode(${mode})`)
    setRepeatMode(mode)
  }
  override onSetShuffle(enabled: boolean): void {
    this.#log(`onSetShuffle(${String(enabled)})`)
    void setShuffleEnabled(enabled)
  }
  /** The remote volume slider, and a hardware key press with the app backgrounded. */
  override onSetDeviceVolume(volume: number): void {
    this.#log(`onSetDeviceVolume(${volume.toFixed(2)})`)
    player?.setVolume(volume)
  }
  override onSetDeviceMuted(muted: boolean): void {
    this.#log(`onSetDeviceMuted(${String(muted)})`)
    player?.setMuted(muted)
  }

  override onTaskRemoved(): void {
    this.#log('onTaskRemoved')
    // Swiped from Recents: checkpoint the position at this last-guaranteed instant.
    service?.save()
  }
  /** Playback is ALREADY paused natively by the time this fires — nothing to do. */
  override onSleepTimer(): void {
    this.#log('onSleepTimer (playback already paused natively)')
  }
  /** This runtime was booted by the media service to finish a resumption. */
  override onPlaybackResumption(): void {
    this.#log('onPlaybackResumption (revived after process death)')
  }
  /**
   * A native failure with no caller to reject to — a refused foreground service,
   * a missing icon, a 404 cover. Recorded and drawn (the strip); never retried,
   * because none of it is recoverable from JS.
   */
  override onSessionError(err: SessionError): void {
    console.warn(`[example] session error · ${err.severity} · ${err.code}: ${err.message}`)
    sessionError = err
    notify()
  }

  /* --- Android Auto / CarPlay: the one handler, its browse three lines ----- */

  override getChildren(parentId: string): Promise<BrowseItem[]> {
    this.#log(`getChildren(${parentId})`)
    assertSignedIn()
    return Promise.resolve(childrenOf(parentId))
  }
  override getMediaItem(id: string): Promise<BrowseItem | undefined> {
    this.#log(`getMediaItem(${id})`)
    assertSignedIn()
    return Promise.resolve(itemFor(id))
  }
  override playFromMediaId(id: string): void {
    this.#log(`playFromMediaId(${id})`)
    const index = queueIndexFor(id)
    if (index === undefined) {
      console.warn(`[example] no queue entry for browse id "${id}"`)
      return
    }
    noteRecentlyPlayed(id)
    void jumpTo(index)
  }
  search(query: string): Promise<BrowseItem[]> {
    this.#log(`search("${query}")`)
    assertSignedIn()
    return Promise.resolve(searchTracks(query))
  }
  playFromSearch(query: string, focus: SearchFocus): void {
    this.#log(`playFromSearch("${query}", ${focus.kind})`)
    const needle = focus.artist ?? focus.album ?? focus.title ?? focus.genre ?? query
    const first = searchTracks(needle)[0]
    if (first === undefined) return
    this.playFromMediaId(first.id)
  }
}

/* --- broadcast(): fan-out. Projects PlayerState onto the three channels on a
 * DISCONTINUITY only — the buffered position moves several times a second, and
 * keying on the whole snapshot would put the session back on a timer. */

let lastSignature = ''
/** Set by an advanced module (cast) while it owns channels 1–2. See the seams. */
let broadcastSuspended = false
const durations = new Map<string, number>()

function broadcast(state: PlayerState, force: boolean): void {
  if (service === undefined || broadcastSuspended) return
  const track = queueRows[state.playlist.index]?.track
  const signature = [
    state.status,
    state.playing,
    state.playlist.index,
    state.playlist.count,
    track === undefined ? undefined : durationMs(track, state),
    track === undefined ? undefined : nowPlaying(track, state),
    state.seeking,
    state.positionAnchor.timestamp,
    state.error?.message,
    state.loop,
    shuffleEnabled,
  ].join('|')
  if (!force && signature === lastSignature) return
  lastSignature = signature

  // A duration we have not published yet makes the media3 timeline entry
  // seekable (a `C.TIME_UNSET` duration reads as "not seekable"). Guarded on the
  // value: once per track, never a timer.
  if (track !== undefined) {
    const ms = durationMs(track, state)
    if (ms !== undefined && durations.get(track.id) !== ms) {
      durations.set(track.id, ms)
      publishQueue()
    }
  }
  service.setMediaItem(track === undefined ? undefined : toMediaItem(track, state))
  service.setPlaybackState(toPlaybackState(state, shuffleEnabled))
}

/** Channel 3, via the handler so the mixin's nav index stays in step. */
function publishQueue(): void {
  handler?.setQueue(
    // `uri` is app-side and dropped here; MediaItem is metadata only. Durations
    // attach as they arrive so the notification's timeline becomes seekable.
    queueRows.map(({ track: { uri: _uri, ...item } }) => ({
      ...item,
      duration: durations.get(item.id),
    })),
    queueRows.findIndex((row) => row.current)
  )
}

/** Re-read mpv's playlist and re-publish. mpv owns the array; the app mirrors it. */
function syncQueue(): void {
  if (player === undefined) return
  try {
    const entries = player.playlist.entries()
    if (entries.length === 0) return // an idle core answers []; don't blank the list
    queueRows = entries.map((entry) => ({
      entryId: entry.entryId,
      current: entry.current,
      track: matchTrack(entry.uri) ?? unknownTrack(entry.uri),
    }))
    publishQueue()
    notify()
  } catch (cause) {
    console.warn('[example] could not read the playlist:', cause)
  }
}

function matchTrack(uri: string): Track | undefined {
  const strip = (u: string): string => (u.startsWith('file://') ? u.slice(7) : u)
  return (
    TRACKS.find((t) => t.uri === uri) ??
    TRACKS.find((t) => strip(t.uri) === strip(uri)) ??
    TRACKS.find((t) => uri.endsWith(t.uri))
  )
}
function unknownTrack(uri: string): Track {
  return { id: `unknown:${uri}`, title: uri || 'Unknown entry', artist: 'Not in TRACKS', uri }
}

/* --- The command vocabulary: one implementation each, called by BOTH the UI and
 * the handler. Anything that can start audio requests focus and ensures the
 * session is up first — the app's job, invisible until a phone call arrives. */

/** Where `play` re-enters after a stop cleared the cursor. Set on the way out. */
let resumeIndex = 0
/** Seek here once mpv has opened the resumed entry (persistence). */
let pendingResumeMs: number | undefined

export function play(): Promise<void> {
  return localPlay()
}
async function localPlay(): Promise<void> {
  if (player === undefined) return
  ensureSession()
  if (!(await AudioSession.activate())) {
    console.warn('[example] audio focus denied — not starting')
    return
  }
  // `play()` cannot resume a *stopped* player (`stop` leaves no entry current,
  // `playlist-pos === -1`); `jumpTo` is the way back in. Without this the lock
  // screen's play button is dead after a remote stop.
  if (player.state.playlist.index < 0) {
    const { count } = player.state.playlist
    if (count === 0) return // nothing to re-enter; jumpTo would name a missing row
    await player.playlist.jumpTo(Math.min(resumeIndex, count - 1))
    return
  }
  player.play()
}

export function pause(): void {
  player?.pause()
}
export function toggle(): void {
  if (player?.state.playing === true) player.pause()
  else void localPlay()
}
export function next(): void {
  void handler?.skipToNext()
}
export function previous(): void {
  void handler?.skipToPrevious()
}

/** Tapping a queue row means "play this one" — through the focus gate. */
export function jumpTo(index: number): Promise<void> {
  return localJumpTo(index)
}
async function localJumpTo(index: number): Promise<void> {
  if (player === undefined) return
  ensureSession()
  if (!(await AudioSession.activate())) {
    console.warn('[example] audio focus denied — not starting')
    return
  }
  const state = player.state
  // Never restart the entry already open: mpv's `playlist-play-index` faithfully
  // *reloads* it, which for a live stream throws away a warm connection (measured
  // 1.5–2.3 s to first audio vs 10–24 ms to resume). A dead/ended row still jumps.
  const alreadyOpen =
    index === state.playlist.index &&
    (state.status === 'ready' || state.status === 'buffering')
  if (alreadyOpen) player.play()
  else await player.playlist.jumpTo(index)
}

/** Not a sound-*starting* call, so no focus request: it moves the playhead. */
export function seekTo(seconds: number): void {
  void player?.seekTo(seconds)
}
/**
 * ±15 s via mpv's own relative seek, not `seekTo(position + delta)`: the position
 * this app can read is projected from an anchor that may be a few hundred ms old
 * (nothing ticks across the bridge), so an absolute target accumulates that error.
 */
export function seekBy(deltaSeconds: number): void {
  void player?.seekBy(deltaSeconds)
}
export function setVolume(volume: number): void {
  player?.setVolume(volume)
}
export function toggleMuted(): void {
  if (player !== undefined) player.setMuted(!player.state.muted)
}

/** Repeat, in session vocabulary — the one method the chips and the notification share. */
export function setRepeatMode(mode: MediaRepeatMode): void {
  // `loop` is an observed property, so the confirmation flows back through the
  // snapshot: the UI re-renders off it and the broadcast re-sends `repeatMode`.
  player?.setLoop(repeatToLoop(mode))
}
/**
 * Shuffle — a real reorder of mpv's playlist (`true` = `playlist.shuffle`, which
 * moves the playing entry too but keeps it current; `false` = one level of undo).
 */
export async function setShuffleEnabled(enabled: boolean): Promise<void> {
  shuffleEnabled = enabled
  notify()
  await runQueueEdit((p) =>
    enabled
      ? p.playlist.shuffle().then(() => undefined)
      : p.playlist.unshuffle().then(() => undefined)
  )
}

/* --- queue edits ---------------------------------------------------------- */

export function playNext(track: Track): Promise<void> {
  return runQueueEdit((p) => p.playlist.add(track.uri, { position: 'next' }))
}
export function addLast(track: Track): Promise<void> {
  return runQueueEdit((p) => p.playlist.add(track.uri))
}
export function removeAt(index: number): Promise<void> {
  return runQueueEdit((p) => p.playlist.remove(index))
}
export function clearQueue(): Promise<void> {
  return runQueueEdit((p) => p.playlist.clear())
}
async function runQueueEdit(action: (p: Player) => Promise<void>): Promise<void> {
  if (player === undefined) return
  try {
    await action(player)
    syncQueue() // `queueChanged` also fires; a second read of an unchanged queue is idempotent
    clearError()
  } catch (cause) {
    fail(cause)
  }
}

/* --- checkpoints, teardown, banners --------------------------------------- */

/** Checkpoint now — the app picks the moment (see the `AppState` wiring below). */
export function saveSession(): void {
  service?.save()
}

/** Remote stop: unload but keep the queue and the session. */
async function stopPlayback(): Promise<void> {
  if (player === undefined) return
  const index = player.state.playlist.index
  if (index >= 0) resumeIndex = index
  await player.stop()
  notify()
}

/**
 * The app's own "stop & dismiss" — the ONLY thing that ends background
 * execution. The player and the app stay alive; only the session goes, and the
 * next play rebuilds it (see `ensureSession`).
 */
export async function stopSession(): Promise<void> {
  pause()
  try {
    // Checkpoint at the stop moment: the pause above round-trips through mpv and
    // comes back as a broadcast *after* teardown detaches the tee.
    service?.save()
    await service?.stopService()
  } finally {
    service = undefined
    starting = undefined
    lastSignature = ''
    await AudioSession.deactivate()
    notify()
  }
}

export function dismissError(): void {
  error = undefined
  errorAttempts = 0
  try {
    player?.clearError() // clears the player's own state.error too
  } catch (cause) {
    console.warn('[example] clearError:', cause)
  }
  notify()
}
export function dismissSessionError(): void {
  sessionError = undefined
  notify()
}

function clearError(): void {
  error = undefined
  errorAttempts = 0
  notify()
}
function fail(cause: unknown): void {
  error = toPlayerError(cause)
  errorAttempts = 0
  console.warn(`[example] ${error.code}: ${error.message}`)
  notify()
}

/* --- Startup: restore → create player → wire audio → subscribe → session. --- */

let startingPlayer: Promise<void> | undefined
let restoring: Promise<void> | undefined
let restored: PersistedSession | undefined

/** Idempotent: safe from every mount and from a Fast Refresh. */
export async function start(): Promise<void> {
  // Restore first, so the queue opens on the entry the last process died on.
  await (restoring ??= restore())
  await (startingPlayer ??= createPlayer())
  syncQueue() // the playlist was built inside createPlayer, before events could mirror it
  ensureSession()
}

async function restore(): Promise<void> {
  try {
    const result = await restorePersisted(sessionStorage)
    if (result.status !== 'restored') {
      restoreNote =
        result.status === 'empty' ? 'nothing saved yet (first launch)' : result.status
      return
    }
    restored = result.session
    const id = restored.mediaItem?.id
    const index = TRACKS.findIndex((t) => t.id === id)
    const positionMs = restored.playbackState?.position.value ?? 0
    resumeIndex = index >= 0 ? index : 0
    // A live entry is persisted at position 0 (it publishes no duration), so `>0`
    // is the whole guard — the authority on "seekable" is what was broadcast.
    pendingResumeMs = index >= 0 && positionMs > 0 ? positionMs : undefined
    restoreNote = `restored "${restored.mediaItem?.title ?? '—'}" @ ${mmss(positionMs / 1000)} · queue ${restored.queue?.length ?? 0}`
    console.log(`[example] persistence: ${restoreNote}`)
  } catch (cause) {
    console.error('[example] persistence: storage failed:', cause)
    restoreNote = 'storage unavailable'
  }
}

async function createPlayer(): Promise<void> {
  try {
    player = await Player.create({
      volume: 0.8,
      // FFmpeg's own reconnect, native and inside the read loop — the only retry
      // that survives the screen off. On by default; widened here.
      networkReconnect: { maxDelaySeconds: 8 },
      // The queue-level layer FFmpeg cannot be: "should the queue move on?". No
      // delay between attempts — a JS-timer backoff freezes with the screen off.
      retry: { maxAttempts: 2 },
      // Open the next entry while the current finishes — every entry here is a
      // network source, the case the option exists for.
      prefetchPlaylist: true,
      // Installed at create, so the very first entry resolves like every other one.
      sourceResolver: createDemoResolver(),
    })

    // mpv's own warnings in the JS console — the first thing to check when a
    // stream misbehaves (bump `logLevel` to 'trace' to dig deeper).
    player.on('log', (e) => console.log(`[mpv:${e.level}] ${e.prefix}: ${e.text.trim()}`))

    wireAudioSession(player, {
      preset: AudioSessionPresets.music,
      duckVolume: 0.3,
      resumeAfterInterruption: true,
    })

    player.onStateChange((state) => {
      consumeResume(state)
      broadcast(state, false)
      notify()
    })
    wirePlayerEvents(player)

    // No demuxer workaround needed: the player forces `demuxer=lavf` for HLS on
    // its own, so mpv's playlist demuxer can't explode the queue into segments.
    await player.loadPlaylist(
      TRACKS.map((t) => t.uri),
      { startIndex: resumeIndex, autoPlay: false }
    )
  } catch (cause) {
    error = toPlayerError(cause)
    console.error('[example] player start failed:', cause)
  }
  notify()
}

/** Seek to the restored position once — and only once mpv has opened its entry. */
function consumeResume(state: PlayerState): void {
  if (pendingResumeMs === undefined) return
  if (state.status !== 'ready' || state.playlist.index !== resumeIndex) return
  const ms = pendingResumeMs
  pendingResumeMs = undefined
  console.log(`[example] persistence: resuming at ${ms} ms`)
  void player?.seekTo(ms / 1000)
}

function wirePlayerEvents(p: Player): void {
  // `error` means "gave up", not "failed": with `retry` on, an entry that failed
  // then played on attempt 2 produces `retrying` and no error at all.
  p.on('error', (e, info) => {
    retrying = undefined
    error = e
    errorAttempts = info.attempts
    console.warn(`[example] ${e.code}: ${e.message} — retryable: ${e.retryable}`)
    notify()
  })
  // The re-attempt banner: no `error` event fires while a retry is in flight.
  p.on('retrying', (e) => {
    retrying = { index: e.index, attempt: e.attempt, maxAttempts: e.maxAttempts, message: e.error.message }
    notify()
  })
  // The library's own signal that the queue *contents* moved.
  p.on('queueChanged', () => syncQueue())
  p.on('trackChanged', () => {
    retrying = undefined // an entry that changed is no longer being re-attempted
    syncQueue() // resync the mixin's current index to mpv's cursor
  })
  // Live-stream identity — the ICY station line under the title.
  p.on('metadataChanged', (metadata) => {
    const parts = [
      metadata['icy-name'],
      metadata['icy-genre'],
      metadata['icy-br'] === undefined ? undefined : `${metadata['icy-br']} kbps`,
    ].filter((part): part is string => part !== undefined && part !== '')
    station = parts.length > 0 ? parts.join(' · ') : undefined
    notify()
  })
}

/* --- Session lifecycle: bring the media session up if a stop tore it down. --- */

let starting: Promise<void> | undefined

/** Callers deliberately do not await: `createSession` force-broadcasts on init. */
function ensureSession(): void {
  starting ??= createSession()
}

async function createSession(): Promise<void> {
  try {
    handler ??= new DemoHandler()
    // `decorateHandler` is identity unless an advanced module (cast) wrapped it —
    // that is how a Chromecast handoff steers the receiver from a notification
    // button without the core knowing casting exists.
    const target = handler
    const api = await MediaService.init(() => decorateHandler(target), {
      android: {
        notificationChannelId: 'playback',
        notificationChannelName: 'Playback',
        notificationIcon: 'ic_notification',
        stopForegroundOnPause: true,
        // Far below media3's 10-minute default so the demotion is observable in
        // `dumpsys activity services`. A shipping app leaves it alone.
        stopForegroundTimeoutMs: 15_000,
        // Coming back from the dead — paired with the bare import in index.js,
        // withPersistence below, the MediaButtonReceiver, and onRevivalRequested.
        playbackResumption: true,
        // A revived service (System UI card / media button) runs only module
        // scope, so it asks the app to re-init — which is exactly this path.
        onRevivalRequested: () => ensureSession(),
        notificationColor: ACCENT_ARGB,
      },
      // Cross-platform parity: match the app's own ±15/±30 jump buttons.
      jumpForwardSeconds: 30,
      jumpBackwardSeconds: 15,
      onHandlerError: (method, cause) =>
        console.error(`[example] handler.${method} failed:`, cause),
    })
    // One line, and every broadcast below persists itself. `sessionStorage` is ours.
    service = withPersistence(api, sessionStorage, {
      onError: (cause) => console.error('[example] persisting the session failed:', cause),
    })
    // Put the recovered (paused) session on every surface before the player has
    // anything to say. Paused by construction, so it starts no foreground service.
    if (restored !== undefined) applyPersisted(service, restored)
    publishQueue()
    if (player !== undefined) broadcast(player.state, true)
  } catch (cause) {
    console.error('[example] MediaService.init failed:', cause)
    starting = undefined // let the next play retry, never latch session-less
  }
  notify()
}

/* --- Seams for advanced modules (cast) — generic, not cast-aware. ---------- */

export function getPlayer(): Player | undefined {
  return player
}
export function getService(): PersistedMediaService | undefined {
  return service
}
export function getQueue(): readonly Track[] {
  return queueRows.map((row) => row.track)
}
/** Subscribe to app-owned changes (the queue moved, an error arrived, …). */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
/** Wrap the media handler before it is registered — the fan-in decoration seam. */
export function setHandlerDecorator(fn: (h: MediaHandler) => MediaHandler): void {
  decorateHandler = fn
}
/** Hand channels 1–2 to an external owner (cast), or take them back. */
export function setBroadcastSuspended(suspended: boolean): void {
  broadcastSuspended = suspended
}
/** Re-paint channels 1–2 from the live player — used when cast hands them back. */
export function forceBroadcast(): void {
  if (player !== undefined) broadcast(player.state, true)
}

let decorateHandler: (h: MediaHandler) => MediaHandler = (h) => h

/* --- Module scope: the reason resumption works. A revived headless runtime runs
 * ONLY module scope (no component mounts), so starting here — not in a useEffect —
 * is what registers the handler after a process kill. */

void start()

// Checkpoint on the way out of the foreground — the last instant JS is
// guaranteed to run. Module scope, so it outlives the React tree.
const scope = globalThis as typeof globalThis & { __rnMediaAppState?: { remove(): void } }
scope.__rnMediaAppState ??= AppState.addEventListener('change', (nextState) => {
  if (nextState !== 'active') {
    saveSession()
    console.log(`[example] persistence: checkpoint on "${nextState}"`)
  }
})

/* --- The one hook the UI uses for app-owned state + the player instance. --- */

export function usePlayback(): PlaybackSnapshot {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    void start()
    return subscribe(bump)
  }, [])
  return {
    player,
    queueRows,
    queue: queueRows.map((row) => row.track),
    station,
    retrying,
    error,
    errorAttempts,
    sessionError,
    shuffleEnabled,
    restoreNote,
  }
}

/** mm:ss for the restore note. */
function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
