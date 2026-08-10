import { MediaSessionError } from './errors'
import {
  normalizePlaybackState,
  validateMediaItem,
  validateQueue,
} from './validate'
import type { MediaItem, MediaServiceApi, PlaybackState } from './types'

/* -------------------------------------------------------------------------- */
/*                                  Storage                                   */
/* -------------------------------------------------------------------------- */

/**
 * Where a persisted session is written. **Injected, structurally typed, and
 * never depended on** — exactly the shape `AsyncStorage`, `react-native-mmkv`,
 * `expo-sqlite/kv-store` and a five-line in-memory map all already satisfy.
 *
 * This package gains **zero dependencies** from persistence, for the same
 * reason `wireAudioSession` takes a structural player rather than importing
 * `@rn-media/player` (ARCHITECTURE §3): the moment a session library picks a
 * storage engine, half its users have to ship two.
 *
 * Both methods may be synchronous or return a promise; {@link withPersistence}
 * handles either, and a synchronous implementation is written through
 * *synchronously* (see its "Write scheduling" note).
 *
 * @example
 * ```ts
 * import AsyncStorage from '@react-native-async-storage/async-storage'
 * withPersistence(service, AsyncStorage)          // async
 *
 * const mmkv = new MMKV()
 * withPersistence(service, {                       // sync
 *   getItem: (k) => mmkv.getString(k) ?? null,
 *   setItem: (k, v) => mmkv.set(k, v),
 * })
 * ```
 */
export interface MediaSessionStorage {
  /** `null` (not `undefined`) for "nothing stored" — AsyncStorage's contract. */
  getItem(key: string): Promise<string | null> | string | null
  setItem(key: string, value: string): Promise<void> | void
}

/* -------------------------------------------------------------------------- */
/*                                   Schema                                   */
/* -------------------------------------------------------------------------- */

/**
 * Version stamped into every record and required on the way back in.
 *
 * Bumped whenever the persisted shape changes in a way an older reader would
 * mis-read. A reader that finds a version it does not know returns
 * {@link RestoreResult} `unsupportedVersion` rather than guessing — the whole
 * point of the field.
 */
export const PERSISTENCE_SCHEMA_VERSION = 1

/** Default storage key. Namespaced so it cannot collide with the app's own. */
export const DEFAULT_PERSISTENCE_KEY = 'rn-media.media-session.session'

/**
 * The three broadcast channels as they were last seen, plus when.
 *
 * This is exactly what {@link MediaServiceApi} takes back in — deliberately, so
 * restoring is a re-broadcast and not a second code path (see
 * {@link applyPersisted}).
 */
export interface PersistedSession {
  /** `Date.now()` of the write this was read from. How stale it is, in one number. */
  readonly savedAt: number
  /**
   * Channel 1, **always paused** — see {@link withPersistence} for why a
   * running anchor is never persisted.
   */
  readonly playbackState?: PlaybackState
  /** Channel 2. */
  readonly mediaItem?: MediaItem
  /** Channel 3. */
  readonly queue?: MediaItem[]
}

/**
 * What {@link restorePersisted} found. A typed result, never a throw: a corrupt
 * record is an ordinary runtime condition (a half-written file, an app
 * downgrade, a user clearing storage), and an app that has to `try/catch` its
 * cold start will eventually not.
 *
 * A *storage* failure is different and does reject — that is a broken
 * dependency, not bad data (CLAUDE.md principle 6).
 */
export type RestoreResult =
  | {
      readonly status: 'restored'
      readonly session: PersistedSession
    }
  /** Nothing has been saved yet, or {@link clearPersisted} was called. */
  | { readonly status: 'empty' }
  /** Written by a different schema version. `found` is `undefined` if it was not a number. */
  | {
      readonly status: 'unsupportedVersion'
      readonly found: number | undefined
      readonly expected: number
    }
  /** Unparseable, or parsed but failed the same validation a live broadcast gets. */
  | { readonly status: 'corrupt'; readonly reason: string }

/** The on-disk record. Internal — the version field is the compatibility contract. */
interface PersistedRecord {
  v: number
  savedAt: number
  playbackState?: PlaybackState
  mediaItem?: MediaItem
  queue?: MediaItem[]
}

/* -------------------------------------------------------------------------- */
/*                                  Options                                   */
/* -------------------------------------------------------------------------- */

export interface PersistenceOptions {
  /** @default {@link DEFAULT_PERSISTENCE_KEY} */
  key?: string
  /**
   * Called when a *write* fails (the storage engine threw or rejected).
   *
   * There is nowhere else for it to go: broadcast setters are synchronous and
   * return `void`, so a rejected write has no caller left to reject to.
   * Defaults to `console.error`; it is never swallowed.
   */
  onError?: (error: unknown) => void
  /** Injected clock. Exists so tests are deterministic. @default `Date.now` */
  now?: () => number
}

function defaultOnError(error: unknown): void {
  // eslint-disable-next-line no-console
  console.error('[media-session] persisting the session failed:', error)
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  )
}

/* -------------------------------------------------------------------------- */
/*                                   Freeze                                   */
/* -------------------------------------------------------------------------- */

/**
 * Collapse a live playback state into the only thing worth restoring: **a
 * paused anchor**.
 *
 * Two changes, both load-bearing:
 *
 * 1. **`rate` becomes `0`, `value` is projected to the write instant.** A
 *    persisted `{value, at, rate: 1}` is a lie the moment the process dies:
 *    every surface would project `value + (now - at)`, so a session restored a
 *    day later would claim a position a day into the track. Freezing at write
 *    time is the only honest form. (`at` is re-stamped again on restore, so the
 *    frozen value survives an arbitrary gap unchanged.)
 * 2. **`playing`/`buffering` become `paused`.** Nothing is playing after
 *    process death. Restoring `playing` would not merely be wrong on screen:
 *    on Android a `playing` broadcast is what *starts the foreground service*
 *    (`MediaSessionController.startService`), so it would raise a silent
 *    notification for audio that does not exist.
 *
 * `stopped` and `error` are preserved as-is — they are already honest.
 *
 * ## Live streams persist position `0`
 * A missing `duration` is this package's live/unknown-length discriminator
 * everywhere else — Android builds the timeline entry with `isDynamic = true`
 * and no scrubber, iOS sets `MPNowPlayingInfoPropertyIsLiveStream`. Persistence
 * uses the same one: when the current item has no duration, the saved position
 * is `0`.
 *
 * Not a shortcut — a restored offset into a live stream is meaningless in every
 * direction. There is nothing to seek back to (the bytes are gone), the number
 * measures "how long you listened last time" rather than a place in the
 * content, and showing `1:47:32` on a radio station tuned in yesterday is a lie
 * of exactly the family this whole function exists to prevent. Leaving it to
 * every implementor to notice would make it a bug in most apps rather than a
 * decision in one place (ARCHITECTURE §13, honest state for live streams).
 */
function freeze(state: PlaybackState, now: number, durationMs?: number): PlaybackState {
  const { value, at, rate } = state.position
  const elapsed = Math.max(0, now - at)
  let projected = rate > 0 ? value + elapsed * rate : value
  if (durationMs !== undefined && Number.isFinite(durationMs)) {
    // A long-lived `playing` state whose next broadcast never came would
    // otherwise project past the end of the track.
    projected = Math.min(projected, durationMs)
  } else {
    projected = 0
  }

  return {
    ...state,
    status:
      state.status === 'playing' || state.status === 'buffering'
        ? 'paused'
        : state.status,
    position: { value: Math.max(0, Math.round(projected)), at: now, rate: 0 },
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Write                                    */
/* -------------------------------------------------------------------------- */

/** {@link MediaServiceApi} plus the two hooks persistence needs. */
export interface PersistedMediaService extends MediaServiceApi {
  /**
   * Write a snapshot **now**, without a broadcast.
   *
   * ## Why this exists
   * The tee saves on every broadcast, and broadcasts are discontinuity-only by
   * design — so during a long uninterrupted track *nothing is written*, and the
   * position on disk stays frozen at the last play/seek/track change. The
   * library will not fix that with a timer: a periodic save is exactly the
   * per-tick write this package exists to avoid, and on Android the JS timer
   * driving it would freeze in the background anyway.
   *
   * So the *moment* is the app's call, and this is how it takes it. Each
   * `save()` re-projects the live anchor to right now, so the record is as
   * fresh as the call. Good moments:
   *
   * ```ts
   * AppState.addEventListener('change', (s) => {
   *   if (s !== 'active') service.save()      // leaving the foreground
   * })
   * ```
   *
   * …and `onTaskRemoved` (the app was swiped away), and just before a
   * deliberate `stopService()`.
   *
   * Honest limit: nothing can checkpoint a process that is killed with no
   * warning while playing in the background. The position then restores to the
   * last checkpoint — usually the start of the current track, which is a
   * defensible answer and never a wrong one.
   */
  save(): void
  /**
   * Forget the persisted session — **both copies**.
   *
   * {@link clearPersisted} only knows about the storage engine it is handed.
   * This also clears the native resumption mirror, which is what would
   * otherwise keep offering the user a System UI resumption card for a session
   * they asked you to forget (a sign-out, a "clear history").
   *
   * Rejects if the storage engine does; the mirror is cleared only after the
   * storage write lands, so the two never disagree in the direction that
   * matters.
   */
  clear(): Promise<void>
  /**
   * Resolves once every write issued so far has settled.
   *
   * Different from {@link save}: `save()` decides *what* to write, `flush()`
   * waits for writes already issued to land. Only meaningful for an
   * asynchronous storage; a synchronous one has always already finished.
   * Never required for correctness — writes are ordered either way.
   */
  flush(): Promise<void>
}

/**
 * Tee the three broadcast channels into `storage`, so a session survives
 * process death.
 *
 * A decorator over {@link MediaServiceApi} rather than a `MediaHandler`
 * decorator: the handler is the *fan-in* side (commands coming back), and what
 * needs saving is the *fan-out* state. Wrapping the service means an app writes
 * one line at init and every existing broadcast call site persists itself.
 *
 * ```ts
 * const service = withPersistence(await MediaService.init(...), AsyncStorage)
 * service.setQueue(items)          // saved
 * service.setPlaybackState(state)  // saved
 * ```
 *
 * ## Writes happen on discontinuities, never on a tick
 * There is no timer here and no polling — the only thing that triggers a write
 * is one of the three broadcast setters, and those are already
 * discontinuity-only by the package's central design rule (ARCHITECTURE §7).
 * A per-tick write would need a per-tick broadcast, which would be a bug one
 * layer up.
 *
 * ## Write scheduling
 * The latest snapshot always wins and writes never overlap:
 * - a **synchronous** storage engine is written through synchronously, inside
 *   the broadcast call, so the record is durable before `setPlaybackState`
 *   returns;
 * - an **asynchronous** one gets at most one write in flight; snapshots
 *   produced while it is pending collapse into a single follow-up write. Three
 *   channel broadcasts in one tick therefore cost one round trip, not three,
 *   and an out-of-order `setItem` completion can never resurrect stale state.
 *
 * ## Two copies, one string (Android playback resumption)
 * Every record is also handed to the native side through
 * `MediaServiceApi.setResumptionSnapshot`, which keeps it in this package's own
 * `SharedPreferences`. That copy exists for exactly one caller: the Android
 * media service when the OS creates it into a process with **no JavaScript in
 * it**, which is the whole premise of playback resumption — it has ~5 s to call
 * `startForeground` and must already know what to show. The app's storage
 * engine stays the source of truth; the mirror is a cache, written from the
 * same serialized string so the two cannot drift. Inert unless
 * `android.playbackResumption` is on, and absent on iOS.
 *
 * ## What is not persisted
 * Handlers (they are code), and the `stopService` lifecycle. `stopService()`
 * deliberately leaves the record intact: "stop" ends *background execution*,
 * not the user's place in the album. Call {@link clearPersisted} for that.
 */
export function withPersistence(
  service: MediaServiceApi,
  storage: MediaSessionStorage,
  options: PersistenceOptions = {}
): PersistedMediaService {
  const key = options.key ?? DEFAULT_PERSISTENCE_KEY
  const onError = options.onError ?? defaultOnError
  const now = options.now ?? Date.now

  let playbackState: PlaybackState | undefined
  let mediaItem: MediaItem | undefined
  let queue: MediaItem[] | undefined

  /** Serialized payload waiting for a free write slot, if any. */
  let queued: string | undefined
  let inFlight = false
  const idleWaiters: (() => void)[] = []

  function serialize(): string {
    const at = now()
    const record: PersistedRecord = {
      v: PERSISTENCE_SCHEMA_VERSION,
      savedAt: at,
      playbackState:
        playbackState === undefined
          ? undefined
          : freeze(playbackState, at, durationOfCurrentItem()),
      mediaItem,
      queue,
    }
    return JSON.stringify(record)
  }

  /**
   * Duration of whatever is playing, from either channel that can carry it.
   * `setMediaItem` is the more specific statement (the same channel-priority
   * rule the native side applies), so it is consulted first.
   */
  function durationOfCurrentItem(): number | undefined {
    if (mediaItem?.duration !== undefined) return mediaItem.duration
    const index = playbackState?.queueIndex
    if (index === undefined || index < 0) return undefined
    return queue?.[index]?.duration
  }

  function settleIdle(): void {
    if (inFlight || queued !== undefined) return
    const waiters = idleWaiters.splice(0, idleWaiters.length)
    for (const resolve of waiters) resolve()
  }

  function drain(): void {
    while (queued !== undefined && !inFlight) {
      const payload = queued
      queued = undefined
      let result: Promise<void> | void
      try {
        result = storage.setItem(key, payload)
      } catch (error) {
        onError(error)
        continue
      }
      if (isThenable(result)) {
        inFlight = true
        result.then(
          () => {
            inFlight = false
            drain()
          },
          (error: unknown) => {
            inFlight = false
            onError(error)
            drain()
          }
        )
        return
      }
    }
    settleIdle()
  }

  /**
   * Serialize the current channels, get the write moving, and hand the *same*
   * bytes to the native resumption mirror.
   *
   * One serialization, two destinations, deliberately: the app's storage engine
   * is the source of truth the app reads on its next launch, and the native
   * mirror is what the Android media service reads when it is created into a
   * process with no JavaScript at all (playback resumption). Feeding both from
   * one string is what makes "they cannot disagree" a property of the code
   * rather than a promise.
   *
   * The mirror write is fire-and-forget and never blocks the broadcast: the
   * native side takes the string, hands it to its own writer thread and
   * returns. It is a no-op on iOS and when `android.playbackResumption` is off.
   */
  function writeSnapshot(): void {
    const payload = serialize()
    queued = payload
    mirror(payload)
    drain()
  }

  function mirror(payload: string | undefined): void {
    try {
      service.setResumptionSnapshot(payload)
    } catch (error) {
      // A service built before this method existed (or a hand-rolled fake) must
      // not be able to break persistence, which is the feature that actually
      // matters. Reported, never swallowed.
      onError(error)
    }
  }

  return {
    setPlaybackState(state: PlaybackState): void {
      // Delegate FIRST: the inner service validates, and a rejected broadcast
      // must not be the thing that gets persisted.
      service.setPlaybackState(state)
      playbackState = state
      writeSnapshot()
    },

    setMediaItem(item?: MediaItem): void {
      service.setMediaItem(item)
      mediaItem = item
      writeSnapshot()
    },

    setQueue(items: MediaItem[]): void {
      service.setQueue(items)
      queue = items
      writeSnapshot()
    },

    save(): void {
      // Nothing broadcast yet: writing an empty record would only turn a
      // "first launch" into a "restored nothing".
      if (
        playbackState === undefined &&
        mediaItem === undefined &&
        queue === undefined
      ) {
        return
      }
      writeSnapshot()
    },

    async clear(): Promise<void> {
      // Storage first: if it rejects, the caller hears about it and the mirror
      // is still consistent with what is on disk.
      await clearPersisted(storage, { key, now })
      playbackState = undefined
      mediaItem = undefined
      queue = undefined
      mirror(undefined)
    },

    setResumptionSnapshot(snapshot?: string): void {
      service.setResumptionSnapshot(snapshot)
    },

    stopService(): Promise<void> {
      return service.stopService()
    },

    // Pass-through: the sleep timer is native state with a native lifetime and
    // is deliberately NOT persisted. Restoring "37 minutes left" into a process
    // that has just been born would be a fiction — the timer's whole premise is
    // an OS timer that has been counting the entire time.
    setSleepTimer(seconds: number): void {
      service.setSleepTimer(seconds)
    },
    cancelSleepTimer(): void {
      service.cancelSleepTimer()
    },
    getSleepTimerRemaining(): number | undefined {
      return service.getSleepTimerRemaining()
    },

    flush(): Promise<void> {
      if (!inFlight && queued === undefined) return Promise.resolve()
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve)
      })
    },
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Restore                                   */
/* -------------------------------------------------------------------------- */

/**
 * Read back whatever {@link withPersistence} last wrote.
 *
 * Returns a *typed result*, so every outcome is on the app's happy path:
 * `empty` on a first launch, `unsupportedVersion` after a schema change,
 * `corrupt` for anything that does not parse or does not validate. Only a
 * failing storage engine rejects.
 *
 * The restored anchor is re-stamped `{ ..., at: now(), rate: 0 }` — the record
 * was already frozen paused at write time (see {@link withPersistence}), and
 * re-stamping `at` is what keeps it honest across an arbitrary gap. Broadcast
 * it as-is; do not resume playback off the back of it without a user gesture.
 *
 * ```ts
 * const restored = await restorePersisted(AsyncStorage)
 * if (restored.status === 'restored') applyPersisted(service, restored.session)
 * ```
 */
export async function restorePersisted(
  storage: MediaSessionStorage,
  options: PersistenceOptions = {}
): Promise<RestoreResult> {
  const key = options.key ?? DEFAULT_PERSISTENCE_KEY
  const now = options.now ?? Date.now

  // Deliberately unguarded: a storage engine that throws is a broken
  // dependency, and swallowing that would leave the app silently stateless
  // forever with nothing in the logs.
  const raw = await storage.getItem(key)
  if (raw == null || raw === '') return { status: 'empty' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      status: 'corrupt',
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'corrupt', reason: 'the stored record is not an object.' }
  }

  const record = parsed as Partial<PersistedRecord>
  if (record.v !== PERSISTENCE_SCHEMA_VERSION) {
    return {
      status: 'unsupportedVersion',
      found: typeof record.v === 'number' ? record.v : undefined,
      expected: PERSISTENCE_SCHEMA_VERSION,
    }
  }

  const hasChannel =
    record.playbackState !== undefined ||
    record.mediaItem !== undefined ||
    record.queue !== undefined
  // The tombstone `clearPersisted` writes: a valid, current-version record
  // carrying no channels at all.
  if (!hasChannel) return { status: 'empty' }

  try {
    // Validated with the very same functions a live broadcast goes through, so
    // nothing that could not have been broadcast can be restored. They throw
    // `MediaSessionError('invalidArgument')`, which is caught into `corrupt`.
    const playbackState =
      record.playbackState === undefined
        ? undefined
        : restoreAnchor(normalizePlaybackState(record.playbackState), now())
    const mediaItem =
      record.mediaItem === undefined
        ? undefined
        : validateMediaItem(record.mediaItem)
    const queue = record.queue === undefined ? undefined : validateQueue(record.queue)

    return {
      status: 'restored',
      session: {
        savedAt: typeof record.savedAt === 'number' ? record.savedAt : 0,
        playbackState,
        mediaItem,
        queue,
      },
    }
  } catch (error) {
    return {
      status: 'corrupt',
      reason:
        error instanceof MediaSessionError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error),
    }
  }
}

/**
 * Re-stamp a restored anchor onto the current clock, paused.
 *
 * `rate: 0` is asserted rather than assumed: a record hand-edited (or written
 * by a future bug) to carry a live rate would otherwise start projecting from
 * an ancient `at` the instant it was broadcast.
 */
function restoreAnchor(state: PlaybackState, at: number): PlaybackState {
  return {
    ...state,
    status:
      state.status === 'playing' || state.status === 'buffering'
        ? 'paused'
        : state.status,
    position: { value: state.position.value, at, rate: 0 },
  }
}

/**
 * Broadcast a restored session, **in the order the channels expect**.
 *
 * Queue first, then the item, then the state: the state carries `queueIndex`,
 * and the current entry is enriched by merging `setMediaItem` over
 * `queue[queueIndex]` (ARCHITECTURE §10). Sending the state first would make
 * the native side briefly resolve an index into an empty queue.
 *
 * A one-liner an app could write itself — which is exactly why it lives here:
 * getting the order wrong produces a notification with no scrubber and no
 * error, the single hardest class of bug this package has.
 */
export function applyPersisted(
  service: MediaServiceApi,
  session: PersistedSession
): void {
  if (session.queue !== undefined) service.setQueue(session.queue)
  if (session.mediaItem !== undefined) service.setMediaItem(session.mediaItem)
  if (session.playbackState !== undefined) {
    service.setPlaybackState(session.playbackState)
  }
}

/**
 * Forget the persisted session.
 *
 * Writes a channel-less record of the current schema version rather than
 * deleting the key: {@link MediaSessionStorage} is two methods on purpose, and
 * requiring `removeItem` would exclude storage engines that do not have one.
 * {@link restorePersisted} reads the result as `empty`.
 *
 * Storage failures reject — the caller asked for this one and can handle it.
 *
 * **Clears the app-facing record only.** It is handed a storage engine, not a
 * service, so it cannot reach the native resumption mirror; call
 * {@link PersistedMediaService.clear} instead when a forgotten session should
 * also stop being offered as a System UI resumption card.
 */
export async function clearPersisted(
  storage: MediaSessionStorage,
  options: PersistenceOptions = {}
): Promise<void> {
  const key = options.key ?? DEFAULT_PERSISTENCE_KEY
  const now = options.now ?? Date.now
  const record: PersistedRecord = {
    v: PERSISTENCE_SCHEMA_VERSION,
    savedAt: now(),
  }
  await storage.setItem(key, JSON.stringify(record))
}
