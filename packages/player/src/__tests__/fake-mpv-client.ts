import type { HybridObject, UInt64 } from 'react-native-nitro-modules'
import type {
  MpvClient,
  MpvEndFileReason,
  MpvEvent,
  MpvFormat,
  MpvLogLevel,
  MpvPropertyValue,
  PrefetchStartedEvent,
  SourceResolutionRequest,
  VisualizerCapture,
} from '../specs/mpv-client.nitro'

/**
 * An in-memory stand-in for the native `MpvClient` HybridObject.
 *
 * The whole point of injecting the client factory is that this file exists:
 * no test in this package loads `react-native-nitro-modules` or touches a
 * device, yet every code path above the Nitro boundary is exercised. Only the
 * *type* of `UInt64`/`HybridObject` is imported, and `import type` is erased.
 */
export class FakeMpvClient implements MpvClient {
  /** Nitro HybridObject identity. */
  readonly name = 'MpvClient'

  /** Options passed to {@link initialize}. */
  initOptions: Record<string, string> | undefined

  /** Every command issued, in order. */
  readonly commands: string[][] = []

  /** Properties written via `setProperty*`, latest value wins. */
  readonly written = new Map<string, MpvPropertyValue>()

  /** Values `getProperty*` should return. */
  readonly readable = new Map<string, MpvPropertyValue>()

  /**
   * Values `getPropertyMap` should return, keyed by property name.
   *
   * Separate from {@link readable} because a node-map read is a different mpv
   * format, not a different rendering of the same value: mpv answers
   * `metadata` as a map and refuses to answer it as a string.
   */
  readonly readableMaps = new Map<string, Record<string, string>>()

  /** How many `getPropertyMap` reads were issued, in order. */
  readonly mapReads: string[] = []

  /**
   * Property names whose `getProperty*` should throw, keyed to the message.
   *
   * Native distinguishes "unavailable" (→ `undefined`) from every other mpv
   * status (→ throw); `readable` covers the first case and this covers the
   * second — notably `[mpv:-8]` (`MPV_ERROR_PROPERTY_NOT_FOUND`), which is what
   * mpv answers for a metadata key that is not present.
   */
  readonly readErrors = new Map<string, string>()

  /** Properties currently observed, and in which format. */
  readonly observations = new Map<string, MpvFormat>()

  /** How many times {@link destroy} was called. */
  destroyCount = 0

  /** Whether {@link initialize} has run. */
  initialized = false

  /** Set to make the next `command()` reject with this message. */
  commandRejection: string | undefined

  /** Set to make `initialize()` throw with this message. */
  initRejection: string | undefined

  /** Set to make `setProperty*` throw with this message. */
  setPropertyRejection: string | undefined

  /** Set to make `startVisualizer()` throw with this message. */
  visualizerRejection: string | undefined

  /** Return values of every `emit()` so far — the back-pressure signal. */
  readonly listenerReturns: boolean[] = []

  /**
   * Every `startVisualizer` call, in order, and every `stopVisualizer` as
   * `'stop'`. This is the leak evidence: a subscribe/unsubscribe cycle must
   * leave a matched pair, and nothing running afterwards.
   */
  readonly visualizerCalls: (
    | { readonly kind: 'start'; readonly fftSize: number; readonly fps: number; readonly waveform: boolean }
    | { readonly kind: 'stop' }
  )[] = []

  /**
   * Every source-resolution call, in order — the whole native contract as a
   * transcript, so a test can assert that a URL was pushed into the cache
   * *before* mpv would have asked for it.
   */
  readonly resolverCalls: (
    | { readonly kind: 'install'; readonly timeoutMs: number }
    | { readonly kind: 'uninstall' }
    | { readonly kind: 'clear' }
    | {
        readonly kind: 'set'
        readonly logical: string
        readonly resolved: string
        readonly ttlMs: number
      }
    | {
        readonly kind: 'complete'
        readonly logical: string
        readonly resolved: string | undefined
        readonly ttlMs: number
      }
  )[] = []

  /** Set to make `installSourceResolver()` throw with this message. */
  installResolverRejection: string | undefined

  #listener: ((events: MpvEvent[]) => boolean) | undefined
  #visualizerListener: ((capture: VisualizerCapture) => boolean) | undefined
  #resolutionListener: ((request: SourceResolutionRequest) => void) | undefined
  #prefetchListener: ((event: PrefetchStartedEvent) => void) | undefined

  /** Whether a batch listener is currently registered. */
  get hasListener(): boolean {
    return this.#listener !== undefined
  }

  /**
   * Deliver one batch, exactly as native would.
   *
   * @returns The listener's back-pressure answer, or `false` if none is
   * registered.
   */
  emit(events: readonly MpvEvent[]): boolean {
    if (this.#listener === undefined) return false
    const keepGoing = this.#listener([...events])
    this.listenerReturns.push(keepGoing)
    return keepGoing
  }

  initialize(options: Record<string, string>): void {
    if (this.initRejection !== undefined) throw new Error(this.initRejection)
    this.initOptions = { ...options }
    this.initialized = true
  }

  destroy(): void {
    this.destroyCount += 1
    this.initialized = false
  }

  async command(args: string[]): Promise<void> {
    this.commands.push([...args])
    if (this.commandRejection !== undefined) {
      const message = this.commandRejection
      this.commandRejection = undefined
      throw new Error(message)
    }
  }

  getPropertyString(name: string): string | undefined {
    const value = this.#read(name)
    return typeof value === 'string' ? value : undefined
  }

  getPropertyNumber(name: string): number | undefined {
    const value = this.#read(name)
    return typeof value === 'number' ? value : undefined
  }

  getPropertyBool(name: string): boolean | undefined {
    const value = this.#read(name)
    return typeof value === 'boolean' ? value : undefined
  }

  getPropertyMap(name: string): Record<string, string> | undefined {
    this.mapReads.push(name)
    const failure = this.readErrors.get(name)
    if (failure !== undefined) throw new Error(failure)
    return this.readableMaps.get(name)
  }

  setPropertyString(name: string, value: string): void {
    this.#set(name, value)
  }

  setPropertyNumber(name: string, value: number): void {
    this.#set(name, value)
  }

  setPropertyBool(name: string, value: boolean): void {
    this.#set(name, value)
  }

  observeProperty(name: string, format: MpvFormat): void {
    this.observations.set(name, format)
  }

  unobserveProperty(name: string): void {
    this.observations.delete(name)
  }

  setEventBatchListener(onEventBatch: (events: MpvEvent[]) => boolean): void {
    this.#listener = onEventBatch
  }

  startVisualizer(fftSize: number, fps: number, waveform: boolean): void {
    if (this.visualizerRejection !== undefined) {
      throw new Error(this.visualizerRejection)
    }
    this.visualizerCalls.push({ kind: 'start', fftSize, fps, waveform })
  }

  stopVisualizer(): void {
    this.visualizerCalls.push({ kind: 'stop' })
  }

  setVisualizerListener(onCapture: (capture: VisualizerCapture) => boolean): void {
    this.#visualizerListener = onCapture
  }

  /** Whether a visualizer listener is currently registered. */
  get hasVisualizerListener(): boolean {
    return this.#visualizerListener !== undefined
  }

  /** Whether a native capture is running, by the fake's own bookkeeping. */
  get visualizerRunning(): boolean {
    const last = this.visualizerCalls.at(-1)
    return last !== undefined && last.kind === 'start'
  }

  /** Deliver one capture, exactly as the native sampler would. */
  emitCapture(capture: VisualizerCapture): boolean {
    if (this.#visualizerListener === undefined) return false
    return this.#visualizerListener(capture)
  }

  setSourceResolutionListener(
    onRequest: (request: SourceResolutionRequest) => void
  ): void {
    this.#resolutionListener = onRequest
  }

  /** Whether a resolution listener is currently registered. */
  get hasResolutionListener(): boolean {
    return this.#resolutionListener !== undefined
  }

  /** Whether the native hooks are armed, by the fake's own bookkeeping. */
  get resolverInstalled(): boolean {
    for (let i = this.resolverCalls.length - 1; i >= 0; i -= 1) {
      const call = this.resolverCalls[i]
      if (call?.kind === 'install') return true
      if (call?.kind === 'uninstall') return false
    }
    return false
  }

  /** Deliver one request, exactly as a load hook would. */
  emitResolutionRequest(request: SourceResolutionRequest): void {
    this.#resolutionListener?.(request)
  }

  setPrefetchStartedListener(
    onPrefetchStarted: (event: PrefetchStartedEvent) => void
  ): void {
    this.#prefetchListener = onPrefetchStarted
  }

  /** Whether a prefetch listener is currently registered. */
  get hasPrefetchListener(): boolean {
    return this.#prefetchListener !== undefined
  }

  /**
   * Deliver one prefetch notification, exactly as the prefetch hook would.
   *
   * Note what the fake does *not* model, deliberately: on a stock (non-fork)
   * libmpv this is never called at all, which is the whole of that binary's
   * behaviour — the hook is registered and never raised.
   */
  emitPrefetchStarted(event: PrefetchStartedEvent): void {
    this.#prefetchListener?.(event)
  }

  /** Every `setResolvedSource` push, as a `logical -> resolved` map. */
  get resolvedSources(): Map<string, string> {
    const map = new Map<string, string>()
    for (const call of this.resolverCalls) {
      if (call.kind === 'set') map.set(call.logical, call.resolved)
      if (call.kind === 'clear' || call.kind === 'uninstall') map.clear()
    }
    return map
  }

  installSourceResolver(timeoutMs: number): void {
    if (this.installResolverRejection !== undefined) {
      throw new Error(this.installResolverRejection)
    }
    this.resolverCalls.push({ kind: 'install', timeoutMs })
  }

  uninstallSourceResolver(): void {
    this.resolverCalls.push({ kind: 'uninstall' })
  }

  setResolvedSource(logical: string, resolved: string, ttlMs: number): void {
    this.resolverCalls.push({ kind: 'set', logical, resolved, ttlMs })
  }

  clearResolvedSources(): void {
    this.resolverCalls.push({ kind: 'clear' })
  }

  completeResolution(
    logical: string,
    resolved: string | undefined,
    ttlMs: number
  ): void {
    this.resolverCalls.push({ kind: 'complete', logical, resolved, ttlMs })
  }

  attachVideoOutput(_handle: UInt64): void {
    throw new Error('[mpv:unsupported] `attachVideoOutput` is not implemented.')
  }

  detachVideoOutput(): void {
    throw new Error('[mpv:unsupported] `detachVideoOutput` is not implemented.')
  }

  getRawHandle(): UInt64 {
    return 0xdeadbeefn as UInt64
  }

  equals(other: HybridObject<{ android: 'c++'; ios: 'c++' }>): boolean {
    return (this as unknown) === other
  }

  dispose(): void {
    this.destroy()
  }

  toString(): string {
    return '[HybridObject FakeMpvClient]'
  }

  #read(name: string): MpvPropertyValue | undefined {
    const failure = this.readErrors.get(name)
    if (failure !== undefined) throw new Error(failure)
    return this.readable.get(name)
  }

  #set(name: string, value: MpvPropertyValue): void {
    if (this.setPropertyRejection !== undefined) {
      throw new Error(this.setPropertyRejection)
    }
    this.written.set(name, value)
    this.readable.set(name, value)
  }
}

// ---------------------------------------------------------------------------
// Event fixture builders — the shape native actually delivers (flat struct).
// ---------------------------------------------------------------------------

/** A `kind: 'property'` event. */
export function propertyEvent(
  name: string,
  value?: MpvPropertyValue
): MpvEvent {
  return value === undefined
    ? { kind: 'property', name }
    : { kind: 'property', name, value }
}

/** A `kind: 'startFile'` event. */
export function startFileEvent(): MpvEvent {
  return { kind: 'startFile' }
}

/** A `kind: 'endFile'` event. */
export function endFileEvent(
  endFileReason: MpvEndFileReason,
  error?: string
): MpvEvent {
  return error === undefined
    ? { kind: 'endFile', endFileReason }
    : { kind: 'endFile', endFileReason, error }
}

/** A `kind: 'seek'` event. */
export function seekEvent(): MpvEvent {
  return { kind: 'seek' }
}

/** A `kind: 'playbackRestart'` event. */
export function playbackRestartEvent(): MpvEvent {
  return { kind: 'playbackRestart' }
}

/** A `kind: 'log'` event. */
export function logEvent(
  logLevel: MpvLogLevel,
  name: string,
  text: string
): MpvEvent {
  return { kind: 'log', logLevel, name, text }
}

/** A `kind: 'shutdown'` event. */
export function shutdownEvent(): MpvEvent {
  return { kind: 'shutdown' }
}

// ---------------------------------------------------------------------------
// Visualizer fixture builders
// ---------------------------------------------------------------------------

/**
 * A synthetic {@link VisualizerCapture}, the shape the native sampler delivers.
 *
 * `magnitudes` are **linear**, calibrated so `1.0` is a full-scale sinusoid —
 * the same calibration the C++ suite asserts against a real transform, so the
 * numbers a TypeScript test writes here mean what they mean on a device.
 */
export function visualizerCapture(options: {
  readonly magnitudes: readonly number[]
  readonly waveform?: readonly number[]
  readonly sampleRate?: number
  readonly capturedAt?: number
  readonly seq?: number
  readonly dropped?: number
}): VisualizerCapture {
  const fftSize = (options.magnitudes.length - 1) * 2
  const capture: VisualizerCapture = {
    magnitudes: Float32Array.from(options.magnitudes).buffer,
    waveform:
      options.waveform === undefined
        ? undefined
        : Float32Array.from(options.waveform).buffer,
    fftSize,
    sampleRate: options.sampleRate ?? 48000,
    capturedAt: options.capturedAt ?? 1_000,
    seq: options.seq ?? 1,
    dropped: options.dropped ?? 0,
  }
  return capture
}

/**
 * A capture whose spectrum is silent except for one bin — the easiest way to
 * assert that a given band picked up a given frequency.
 */
export function toneCapture(
  bin: number,
  amplitude: number,
  options: { readonly bins?: number; readonly sampleRate?: number; readonly seq?: number } = {}
): VisualizerCapture {
  const bins = options.bins ?? 1025
  const magnitudes = new Array<number>(bins).fill(0)
  magnitudes[bin] = amplitude
  return visualizerCapture({
    magnitudes,
    sampleRate: options.sampleRate ?? 48000,
    seq: options.seq,
  })
}
