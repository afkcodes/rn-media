import type { PlayerError } from './errors'
import { PlayerErrorException, disposedError, toPlayerError } from './errors'
import type { LogEvent, PlayerEvent } from './events'
import { toPlayerEvents } from './events'
import { createMpvClient } from './native-client'
import {
  MPV_VOLUME_SCALE,
  MpvProperty,
  OBSERVED_PROPERTIES,
} from './properties'
import type { LoopMode, PlayerState, ReducerContext } from './state'
import {
  createInitialState,
  isPositionDiscontinuity,
  projectPosition,
  reducePlayerState,
  withResyncedAnchor,
} from './state'
import type {
  MpvClient,
  MpvEvent,
  MpvFormat,
  MpvLogLevel,
} from './specs/mpv-client.nitro'

/**
 * A factory that produces a fresh, uninitialised {@link MpvClient}.
 *
 * Injecting this is what keeps the whole TypeScript layer testable without a
 * device: the test suite passes a fake and never loads
 * `react-native-nitro-modules`.
 */
export type MpvClientFactory = () => MpvClient

/** mpv log levels the core can be asked for, plus `'no'` to silence logging. */
export type PlayerLogLevel = MpvLogLevel | 'no'

/** Options for {@link Player.create}. */
export interface PlayerOptions {
  /**
   * Raw mpv options applied before `mpv_initialize()`.
   *
   * Audio-only defaults (`vid=no`, `force-window=no`, `idle=yes`,
   * `audio-display=no`) are applied natively first, so anything here wins.
   *
   * @remarks
   * Option *order* is not preserved (the native layer takes a map), so
   * `profile` and `include` — whose effect depends on where they appear — are
   * not supported here. Set them with `setProperty*` after creation instead.
   */
  readonly mpvOptions?: Readonly<Record<string, string>>
  /** mpv log verbosity. Defaults to mpv's `warn`. */
  readonly logLevel?: PlayerLogLevel
  /**
   * HTTP `User-Agent` for network playback. Defaults to
   * {@link DEFAULT_USER_AGENT} rather than mpv's own `libmpv`, because real
   * streaming hosts blocklist the literal string `libmpv` (observed on-device:
   * a Shoutcast DNAS v2 server returning `401 Unauthorized` for exactly
   * `User-Agent: libmpv` while accepting any other value, including
   * `rn-media/0.1 (libmpv)`). A raw `mpvOptions['user-agent']` still wins over
   * this option.
   */
  readonly userAgent?: string
  /** Initial volume in `0..1`. */
  readonly volume?: number
  /** Initial mute state. */
  readonly muted?: boolean
  /** Initial playback rate. */
  readonly rate?: number
  /** Initial repeat behaviour. */
  readonly loop?: LoopMode
  /**
   * Override how the underlying `MpvClient` is created.
   *
   * Production code never sets this; it exists so tests (and, later, the video
   * plugin) can supply their own client. When omitted, the real Nitro
   * HybridObject is loaded lazily — which is why nothing outside this default
   * path imports `react-native-nitro-modules`.
   */
  readonly createClient?: MpvClientFactory
  /**
   * Clock used for position projection and event timestamps.
   * Defaults to `Date.now`. Injected by tests.
   */
  readonly now?: () => number
}

/** Options for {@link Player.load}. */
export interface LoadOptions {
  /** Start playing immediately. Defaults to `true`. */
  readonly autoPlay?: boolean
  /** Start position in seconds (mpv's per-file `start` option). */
  readonly startPosition?: number
  /** Extra per-file mpv options, e.g. `{ 'audio-channels': 'stereo' }`. */
  readonly mpvOptions?: Readonly<Record<string, string>>
}

/** Options for {@link Player.loadPlaylist}. */
export interface LoadPlaylistOptions extends LoadOptions {
  /** Which entry to start on. Defaults to `0`. */
  readonly startIndex?: number
}

/** Payload of the `trackEnded` event. */
export interface TrackEndedEvent {
  /** Playlist index of the entry that finished, or `-1` if unknown. */
  readonly index: number
}

/** Payload of the `trackChanged` event. */
export interface TrackChangedEvent {
  /** Playlist index now current; `-1` when the playlist has no current entry. */
  readonly index: number
  /** The index that was current before. */
  readonly previousIndex: number
}

/**
 * Discrete events, as opposed to the whole-state subscription.
 *
 * `trackEnded` and `error` are deliberately distinct: a natural end of stream
 * and a premature/failed one are different facts, and mapping mpv's `end-file`
 * onto them lives in `errors.ts`.
 */
export interface PlayerEventMap {
  /** A playlist entry reached its natural end (mpv `end-file` reason `eof`). */
  trackEnded: (event: TrackEndedEvent) => void
  /** Playback failed. Also reflected in `state.error` with `status: 'error'`. */
  error: (error: PlayerError) => void
  /** The current playlist entry changed. */
  trackChanged: (event: TrackChangedEvent) => void
  /** An mpv log line, at or below the configured `logLevel`. */
  log: (event: LogEvent) => void
}

/** Name of a discrete event. */
export type PlayerEventName = keyof PlayerEventMap

/** Unsubscribes a listener. Safe to call more than once. */
export type Unsubscribe = () => void

/**
 * Queue manipulation, backed by mpv's own playlist (which is what makes
 * gapless transitions gapless — the next entry is demuxed before the current
 * one ends).
 */
export interface PlaylistApi {
  /**
   * Append a source to the end of the playlist.
   *
   * @param source - URI or file path.
   * @param options - `playNow: true` starts playback if nothing is playing
   * (mpv's `append-play`).
   *
   * @remarks
   * Carries the same `.m3u8`/`.m3u` `demuxer=lavf` guard as {@link Player.load}
   * — it is the identical `loadfile` command and the identical hazard.
   */
  add(source: string, options?: { readonly playNow?: boolean }): Promise<void>
  /**
   * Remove the entry at `index`.
   *
   * Removing the current entry stops it and starts the next one.
   */
  remove(index: number): Promise<void>
  /**
   * Move the entry at `from` so that it ends up at `to`.
   *
   * @remarks
   * mpv's `playlist-move` takes "the entry that `index1` should take the place
   * of", which is off by one for downward moves; this method takes ordinary
   * array semantics and does the adjustment.
   */
  move(from: number, to: number): Promise<void>
  /** Jump to `index` and (re)start playback of it. */
  jumpTo(index: number): Promise<void>
  /** Go to the next entry. */
  next(): Promise<void>
  /** Go to the previous entry. */
  previous(): Promise<void>
  /** Remove every entry except the one currently playing. */
  clear(): Promise<void>
}

const DEFAULT_LOG_LEVEL: PlayerLogLevel = 'warn'

/**
 * Default HTTP User-Agent.
 *
 * mpv's own default is the bare string `libmpv`, which streaming hosts
 * blocklist (see {@link PlayerOptions.userAgent} for the observed 401). This
 * stays honest — it names the engine — without matching those exact-string
 * bans. Overridable per player via `userAgent`, or raw via
 * `mpvOptions['user-agent']`.
 */
export const DEFAULT_USER_AGENT = 'rn-media (libmpv)'

/**
 * Our TS level names → mpv's `mpv_request_log_messages` strings.
 *
 * The TS union deliberately renames two levels (`verbose`, `debugging`) because
 * their natural spellings collide with C/Xcode macros when nitrogen upper-cases
 * enum members (see the spec). mpv itself only accepts `v` and `debug`, so the
 * rename must be undone here — passing the TS name through raw makes
 * `mpv_request_log_messages` fail and `Player.create` throw.
 */
const MPV_LOG_LEVEL_NAMES: Readonly<Record<PlayerLogLevel, string>> = {
  no: 'no',
  fatal: 'fatal',
  error: 'error',
  warn: 'warn',
  info: 'info',
  verbose: 'v',
  debugging: 'debug',
  trace: 'trace',
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/** The mpv option name callers override to opt out of {@link HLS_DEMUXER}. */
const DEMUXER_OPTION = 'demuxer'

/**
 * The demuxer forced on `.m3u8` / `.m3u` sources. See {@link needsHlsDemuxer}.
 */
const HLS_DEMUXER = 'lavf'

/**
 * Whether `source`'s *path* ends in a playlist extension mpv would hand to its
 * own playlist demuxer.
 *
 * Query strings and fragments are ignored, because CDNs sign HLS URLs
 * (`…/master.m3u8?token=…`) and the extension is still the last thing in the
 * path.
 */
function needsHlsDemuxer(source: string): boolean {
  const end = source.search(/[?#]/u)
  const path = (end === -1 ? source : source.slice(0, end)).toLowerCase()
  return path.endsWith('.m3u8') || path.endsWith('.m3u')
}

/**
 * Build the third `loadfile` argument — mpv's per-file option list, which is
 * `opt1=value1,opt2=value2,…` (mpv 0.35.1 `input.rst`, `loadfile`).
 *
 * @remarks
 * This is also where the HLS guard lives. mpv's *playlist* demuxer claims
 * `.m3u8`/`.m3u` by extension and expands the URL into playlist entries, so a
 * single `loadfile` of an HLS master playlist detonates the queue: measured
 * on-device, `playlist-count` went 3 → 23 as every variant and segment line
 * became its own entry. Pinning `demuxer=lavf` for those sources keeps mpv on
 * libavformat, which either plays the stream (once the libmpv build ships the
 * `hls` demuxer) or fails cleanly with a typed `unsupported-format` error —
 * both of which are honest, unlike a silently exploded playlist.
 *
 * A caller who passes their own `demuxer` in `mpvOptions` wins: this is a
 * default, not a policy.
 */
function formatFileOptions(
  options: Readonly<Record<string, string>> | undefined,
  startPosition: number | undefined,
  source: string
): string | undefined {
  const parts: string[] = []
  if (startPosition !== undefined) parts.push(`start=${startPosition}`)
  if (options?.[DEMUXER_OPTION] === undefined && needsHlsDemuxer(source)) {
    parts.push(`${DEMUXER_OPTION}=${HLS_DEMUXER}`)
  }
  for (const [key, value] of Object.entries(options ?? {})) {
    parts.push(`${key}=${value}`)
  }
  return parts.length > 0 ? parts.join(',') : undefined
}

/**
 * The typed audio player.
 *
 * One `Player` owns one mpv core. There is no singleton: create as many as you
 * need, and `destroy()` each when you are done.
 *
 * @example
 * ```ts
 * const player = await Player.create({ volume: 0.8 })
 * const stop = player.onStateChange((state) => console.log(state.status))
 * await player.load('https://example.com/track.flac')
 * player.play()
 * // …
 * stop()
 * player.destroy()
 * ```
 */
export class Player {
  readonly #client: MpvClient
  readonly #now: () => number
  #state: PlayerState
  #currentUri: string | undefined
  #destroyed = false

  readonly #stateListeners = new Set<(state: PlayerState) => void>()
  readonly #eventListeners: {
    [K in PlayerEventName]: Set<PlayerEventMap[K]>
  } = {
    trackEnded: new Set(),
    error: new Set(),
    trackChanged: new Set(),
    log: new Set(),
  }

  private constructor(client: MpvClient, now: () => number) {
    this.#client = client
    this.#now = now
    this.#state = createInitialState(now())
  }

  /**
   * Create and start a player.
   *
   * Applies the pre-init mpv options, starts the core, registers the batched
   * event listener, installs every property observation, and applies the
   * initial volume/rate/mute/loop settings.
   *
   * @param options - See {@link PlayerOptions}.
   * @throws {@link PlayerErrorException} if mpv rejects an option or fails to
   * initialise. The half-built core is torn down first.
   */
  static async create(options: PlayerOptions = {}): Promise<Player> {
    // Statically imported, deliberately. A dynamic `import()` here used to keep
    // `react-native-nitro-modules` out of the unit-test process, but Metro
    // compiles `import()` into a *split bundle fetched over HTTP in dev*, which
    // puts a live Metro connection on the critical path of every
    // `Player.create()` — and breaks outright when the package resolves to a
    // path above the app's Metro project root (the URL escapes the server root:
    // `/../../packages/player/src/native-client.bundle`). Tests keep native out
    // of the process with a vitest alias instead, exactly like the other two
    // packages do.
    const factory = options.createClient ?? createMpvClient
    const now = options.now ?? Date.now
    const client = factory()
    const player = new Player(client, now)

    try {
      client.setEventBatchListener((events) => player.#handleBatch(events))
      client.initialize({
        'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
        ...(options.mpvOptions ?? {}),
        'log-level': MPV_LOG_LEVEL_NAMES[options.logLevel ?? DEFAULT_LOG_LEVEL],
      })
      for (const property of OBSERVED_PROPERTIES) {
        client.observeProperty(property.name, property.format)
      }
      if (options.volume !== undefined) player.setVolume(options.volume)
      if (options.muted !== undefined) player.setMuted(options.muted)
      if (options.rate !== undefined) player.setRate(options.rate)
      if (options.loop !== undefined) player.setLoop(options.loop)
    } catch (thrown) {
      player.destroy()
      throw new PlayerErrorException(toPlayerError(thrown))
    }

    return player
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** The current immutable snapshot. */
  get state(): PlayerState {
    return this.#state
  }

  /** Whether {@link destroy} has been called. */
  get destroyed(): boolean {
    return this.#destroyed
  }

  /**
   * Subscribe to whole-state changes.
   *
   * Fires at most once per native event batch, and only when the reducer
   * actually produced a new snapshot.
   *
   * @param listener - Called with the new snapshot.
   * @returns A function that removes the listener.
   */
  onStateChange(listener: (state: PlayerState) => void): Unsubscribe {
    this.#stateListeners.add(listener)
    return () => {
      this.#stateListeners.delete(listener)
    }
  }

  /**
   * Subscribe to a discrete event.
   *
   * @param event - One of {@link PlayerEventName}.
   * @param listener - Called with that event's payload.
   * @returns A function that removes the listener.
   */
  on<K extends PlayerEventName>(
    event: K,
    listener: PlayerEventMap[K]
  ): Unsubscribe {
    const set: Set<PlayerEventMap[K]> = this.#eventListeners[event]
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  /**
   * The playback position in seconds, projected locally from the last anchor.
   *
   * `time-pos` is never observed and never polled natively: mpv publishes the
   * truth on discontinuities and this extrapolates between them. See
   * `docs/specs/player-core.md` §3.
   */
  getPosition(): number {
    return projectPosition(this.#state, this.#now())
  }

  /**
   * Re-anchor the projected position on an exact `time-pos` read.
   *
   * One synchronous property read, no polling. `useProgress` calls it once
   * when it subscribes so that a component mounting mid-playback starts from
   * the truth rather than from an anchor that may be seconds old.
   *
   * @returns The position in seconds after the resync.
   */
  resyncPosition(): number {
    this.#assertAlive('resyncPosition')
    const now = this.#now()
    const exact = this.#readTimePos()
    if (exact === undefined) return projectPosition(this.#state, now)

    const next = withResyncedAnchor(this.#state, exact, now)
    if (next !== this.#state) {
      this.#state = next
      for (const listener of [...this.#stateListeners]) listener(next)
    }
    return projectPosition(next, now)
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * Replace whatever is playing with a single source.
   *
   * @param source - URI (`https://…`) or absolute file path.
   * @param options - See {@link LoadOptions}.
   *
   * @remarks
   * A source whose path ends in `.m3u8`/`.m3u` is loaded with `demuxer=lavf`
   * forced, unless `options.mpvOptions` already names a `demuxer` — see
   * {@link formatFileOptions} for why.
   */
  async load(source: string, options: LoadOptions = {}): Promise<void> {
    this.#assertAlive('load')
    this.#currentUri = source
    if (options.autoPlay === false) {
      this.#setBool(MpvProperty.pause, true)
    } else if (options.autoPlay === true) {
      this.#setBool(MpvProperty.pause, false)
    }
    const fileOptions = formatFileOptions(
      options.mpvOptions,
      options.startPosition,
      source
    )
    const args = ['loadfile', source, 'replace']
    if (fileOptions !== undefined) args.push(fileOptions)
    await this.command(args)
  }

  /**
   * Replace the playlist with `sources` and start at `startIndex`.
   *
   * Uses mpv's own playlist, so transitions between entries are gapless.
   *
   * @param sources - URIs or file paths, in order.
   * @param options - See {@link LoadPlaylistOptions}.
   *
   * @remarks
   * The `.m3u8`/`.m3u` `demuxer=lavf` guard described on {@link load} is
   * applied to each entry independently.
   */
  async loadPlaylist(
    sources: readonly string[],
    options: LoadPlaylistOptions = {}
  ): Promise<void> {
    this.#assertAlive('loadPlaylist')
    const startIndex = options.startIndex ?? 0
    this.#currentUri = sources[startIndex] ?? sources[0]

    if (options.autoPlay === false) {
      this.#setBool(MpvProperty.pause, true)
    } else if (options.autoPlay === true) {
      this.#setBool(MpvProperty.pause, false)
    }

    // `stop` clears the playlist outright, so the queue is built from a clean
    // slate; `loadfile … replace` would start entry 0 before we could jump.
    await this.command(['stop'])
    if (sources.length === 0) return

    for (const source of sources) {
      // Per entry, not once for the whole queue: the HLS guard is decided by
      // each source's own extension, so a `.m3u8` next to a `.mp3` gets the
      // forced demuxer and the `.mp3` does not.
      const fileOptions = formatFileOptions(
        options.mpvOptions,
        options.startPosition,
        source
      )
      const args = ['loadfile', source, 'append']
      if (fileOptions !== undefined) args.push(fileOptions)
      await this.command(args)
    }
    await this.command(['playlist-play-index', String(startIndex)])
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /** Resume playback (`pause = no`). */
  play(): void {
    this.#assertAlive('play')
    this.#setBool(MpvProperty.pause, false)
  }

  /** Pause playback (`pause = yes`). */
  pause(): void {
    this.#assertAlive('pause')
    this.#setBool(MpvProperty.pause, true)
  }

  /** Flip between playing and paused, based on the current snapshot. */
  toggle(): void {
    this.#assertAlive('toggle')
    this.#setBool(MpvProperty.pause, this.#state.playing)
  }

  /**
   * Seek to an absolute position.
   *
   * Uses mpv's `seek <seconds> absolute+exact`, i.e. a precise seek rather
   * than the nearest keyframe.
   *
   * @param seconds - Target position; negative values are clamped to `0`.
   */
  async seekTo(seconds: number): Promise<void> {
    this.#assertAlive('seekTo')
    const target = seconds > 0 ? seconds : 0
    await this.command(['seek', String(target), 'absolute+exact'])
  }

  /**
   * Set the playback rate.
   *
   * @param rate - Multiplier. Clamped to mpv's documented `0.01 … 100`.
   */
  setRate(rate: number): void {
    this.#assertAlive('setRate')
    this.#setNumber(MpvProperty.speed, clamp(rate, 0.01, 100))
  }

  /**
   * Read the output volume, in the same `0..1` scale {@link setVolume} takes.
   *
   * Reads mpv directly rather than returning `state.volume`: the observed
   * `volume` property arrives asynchronously in the next event batch, so a read
   * immediately after a write would still see the old value. Anything doing
   * read-modify-restore (`wireAudioSession`'s ducking, for one) needs the
   * truth, not the last broadcast. Falls back to the snapshot if mpv reports
   * the property unavailable.
   *
   * @returns Volume in `0..1`.
   */
  getVolume(): number {
    this.#assertAlive('getVolume')
    const raw = this.#guard(() =>
      this.#client.getPropertyNumber(MpvProperty.volume)
    )
    return raw === undefined ? this.#state.volume : raw / MPV_VOLUME_SCALE
  }

  /**
   * Set the output volume.
   *
   * @param volume - `0..1`, where `1` is mpv's `volume=100` (no attenuation
   * and no amplification). Values outside the range are clamped; use
   * `setPropertyNumber('volume', …)` if you really want mpv's amplification
   * range above 100.
   *
   * @remarks
   * mpv's volume curve is `gain = (volume / 100) ** 3`, so `0.5` is much
   * quieter than half as loud.
   */
  setVolume(volume: number): void {
    this.#assertAlive('setVolume')
    this.#setNumber(MpvProperty.volume, clamp(volume, 0, 1) * MPV_VOLUME_SCALE)
  }

  /** Mute or unmute output. */
  setMuted(muted: boolean): void {
    this.#assertAlive('setMuted')
    this.#setBool(MpvProperty.mute, muted)
  }

  /**
   * Set repeat behaviour.
   *
   * @param mode - `'track'` repeats the current entry forever, `'playlist'`
   * repeats the whole queue forever, `'off'` disables both.
   */
  setLoop(mode: LoopMode): void {
    this.#assertAlive('setLoop')
    // mpv counts *seeks back to start*, not playthroughs, so a finite count
    // would be surprising. Only "forever" and "off" are exposed.
    this.#setString(MpvProperty.loopFile, mode === 'track' ? 'inf' : 'no')
    this.#setString(
      MpvProperty.loopPlaylist,
      mode === 'playlist' ? 'inf' : 'no'
    )
  }

  // -------------------------------------------------------------------------
  // Playlist
  // -------------------------------------------------------------------------

  /** Queue manipulation. See {@link PlaylistApi}. */
  readonly playlist: PlaylistApi = {
    add: async (source, options) => {
      this.#assertAlive('playlist.add')
      const args = [
        'loadfile',
        source,
        options?.playNow === true ? 'append-play' : 'append',
      ]
      const fileOptions = formatFileOptions(undefined, undefined, source)
      if (fileOptions !== undefined) args.push(fileOptions)
      await this.command(args)
    },
    remove: async (index) => {
      this.#assertAlive('playlist.remove')
      await this.command(['playlist-remove', String(index)])
    },
    move: async (from, to) => {
      this.#assertAlive('playlist.move')
      // mpv: "Move the playlist entry at index1, so that it takes the place of
      // the entry index2." For a downward move the target must therefore be
      // shifted by one to land where an array `splice` would put it.
      const target = to > from ? to + 1 : to
      await this.command(['playlist-move', String(from), String(target)])
    },
    jumpTo: async (index) => {
      this.#assertAlive('playlist.jumpTo')
      // `playlist-play-index` rather than writing `playlist-pos`: mpv
      // guarantees playback restarts even when jumping to the current entry.
      await this.command(['playlist-play-index', String(index)])
    },
    next: async () => {
      this.#assertAlive('playlist.next')
      await this.command(['playlist-next', 'weak'])
    },
    previous: async () => {
      this.#assertAlive('playlist.previous')
      await this.command(['playlist-prev', 'weak'])
    },
    clear: async () => {
      this.#assertAlive('playlist.clear')
      await this.command(['playlist-clear'])
    },
  }

  // -------------------------------------------------------------------------
  // Raw escape hatches
  // -------------------------------------------------------------------------

  /**
   * Run an arbitrary mpv command.
   *
   * @param args - Command name followed by its arguments, all as strings.
   * @throws {@link PlayerErrorException} with a typed {@link PlayerError}.
   */
  async command(args: readonly string[]): Promise<void> {
    this.#assertAlive('command')
    try {
      await this.#client.command([...args])
    } catch (thrown) {
      throw new PlayerErrorException(toPlayerError(thrown, this.#currentUri))
    }
  }

  /** Read any mpv property as a string. `undefined` when unavailable. */
  getPropertyString(name: string): string | undefined {
    this.#assertAlive('getPropertyString')
    return this.#guard(() => this.#client.getPropertyString(name))
  }

  /** Read any mpv property as a number. `undefined` when unavailable. */
  getPropertyNumber(name: string): number | undefined {
    this.#assertAlive('getPropertyNumber')
    return this.#guard(() => this.#client.getPropertyNumber(name))
  }

  /** Read any mpv property as a boolean. `undefined` when unavailable. */
  getPropertyBool(name: string): boolean | undefined {
    this.#assertAlive('getPropertyBool')
    return this.#guard(() => this.#client.getPropertyBool(name))
  }

  /** Write any mpv property from a string. */
  setPropertyString(name: string, value: string): void {
    this.#assertAlive('setPropertyString')
    this.#setString(name, value)
  }

  /** Write any mpv property from a number. */
  setPropertyNumber(name: string, value: number): void {
    this.#assertAlive('setPropertyNumber')
    this.#setNumber(name, value)
  }

  /** Write any mpv property from a boolean. */
  setPropertyBool(name: string, value: boolean): void {
    this.#assertAlive('setPropertyBool')
    this.#setBool(name, value)
  }

  /**
   * Observe an extra mpv property.
   *
   * Its changes arrive as `kind: 'property'` events. The built-in reducer
   * ignores names it does not know, so use `onStateChange` plus your own
   * bookkeeping, or read the property when you need it.
   *
   * @param name - mpv property name.
   * @param format - The format to receive it in.
   */
  observeProperty(name: string, format: MpvFormat): void {
    this.#assertAlive('observeProperty')
    this.#guard(() => {
      this.#client.observeProperty(name, format)
    })
  }

  /** Stop observing a property added with {@link observeProperty}. */
  unobserveProperty(name: string): void {
    this.#assertAlive('unobserveProperty')
    this.#guard(() => {
      this.#client.unobserveProperty(name)
    })
  }

  /**
   * The underlying `mpv_handle*` as an integer, for the future video plugin.
   *
   * @returns The handle as a `bigint` (Nitro's `UInt64`).
   */
  getRawHandle(): bigint {
    this.#assertAlive('getRawHandle')
    return this.#guard(() => this.#client.getRawHandle())
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /**
   * Destroy the player and its mpv core. Idempotent.
   *
   * After this, every method throws a `disposed` {@link PlayerError}, all
   * listeners are dropped, and the native batch listener detaches itself by
   * returning `false` on its next invocation (the back-pressure contract in
   * `docs/specs/player-core.md` §2.5).
   */
  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#stateListeners.clear()
    for (const listeners of Object.values(this.#eventListeners)) {
      listeners.clear()
    }
    try {
      this.#client.destroy()
    } catch {
      // `destroy()` is documented never to throw; if a client does anyway,
      // swallowing it here is the only way to keep destroy idempotent and
      // total. Nothing downstream can act on it.
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The batched event listener.
   *
   * @returns `true` to keep receiving batches, `false` once destroyed.
   */
  #handleBatch(events: MpvEvent[]): boolean {
    if (this.#destroyed) return false

    const mapped = toPlayerEvents(events)
    if (mapped.length === 0) return true

    const context: ReducerContext = {
      now: this.#now(),
      ...(mapped.some(isPositionDiscontinuity)
        ? { timePos: this.#readTimePos() }
        : {}),
      ...(this.#currentUri !== undefined ? { uri: this.#currentUri } : {}),
    }

    const previous = this.#state
    let next = previous
    const emissions: Array<() => void> = []

    for (const event of mapped) {
      const after = reducePlayerState(next, event, context)
      this.#collectEmissions(next, after, event, emissions)
      next = after
    }

    if (next !== previous) {
      this.#state = next
      for (const listener of [...this.#stateListeners]) listener(next)
    }
    for (const emit of emissions) emit()

    return !this.#destroyed
  }

  /**
   * Derive the discrete events for one reducer step.
   *
   * Uses both the pre- and post-reduction snapshot so that `trackEnded` and
   * `trackChanged` can report the index that was current when the event
   * happened, without re-running the reducer.
   */
  #collectEmissions(
    before: PlayerState,
    after: PlayerState,
    event: PlayerEvent,
    out: Array<() => void>
  ): void {
    switch (event.kind) {
      case 'endFile': {
        if (after.status === 'ended') {
          const index = before.playlist.index
          out.push(() => {
            this.#emit('trackEnded', { index })
          })
        } else if (after.status === 'error' && after.error !== undefined) {
          const error = after.error
          out.push(() => {
            this.#emit('error', error)
          })
        }
        return
      }
      case 'property': {
        if (event.name !== MpvProperty.playlistPos) return
        const index = after.playlist.index
        const previousIndex = before.playlist.index
        if (index === previousIndex) return
        out.push(() => {
          this.#emit('trackChanged', { index, previousIndex })
        })
        return
      }
      case 'log': {
        const logEvent = event
        out.push(() => {
          this.#emit('log', logEvent)
        })
        return
      }
      case 'startFile':
      case 'seek':
      case 'playbackRestart':
      case 'shutdown':
        return
      default: {
        const exhaustive = event
        exhaustive satisfies never
      }
    }
  }

  #emit<K extends PlayerEventName>(
    name: K,
    payload: Parameters<PlayerEventMap[K]>[0]
  ): void {
    for (const listener of [...this.#eventListeners[name]]) {
      // Each listener is typed by its own key; the cast is confined here.
      ;(listener as (value: typeof payload) => void)(payload)
    }
  }

  /**
   * One synchronous `time-pos` read, used only on a position discontinuity.
   *
   * This is not polling: it happens at most once per batch, and only when the
   * batch contained a `playbackRestart`.
   */
  #readTimePos(): number | undefined {
    try {
      return this.#client.getPropertyNumber(MpvProperty.timePos)
    } catch {
      // The core may already be tearing down; an absent anchor just means the
      // reducer keeps extrapolating from the previous one.
      return undefined
    }
  }

  #assertAlive(operation: string): void {
    if (this.#destroyed) {
      throw new PlayerErrorException(disposedError(operation))
    }
  }

  #guard<T>(call: () => T): T {
    try {
      return call()
    } catch (thrown) {
      throw new PlayerErrorException(toPlayerError(thrown, this.#currentUri))
    }
  }

  #setBool(name: string, value: boolean): void {
    this.#guard(() => {
      this.#client.setPropertyBool(name, value)
    })
  }

  #setNumber(name: string, value: number): void {
    this.#guard(() => {
      this.#client.setPropertyNumber(name, value)
    })
  }

  #setString(name: string, value: string): void {
    this.#guard(() => {
      this.#client.setPropertyString(name, value)
    })
  }
}
