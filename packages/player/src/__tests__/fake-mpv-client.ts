import type { HybridObject, UInt64 } from 'react-native-nitro-modules'
import type {
  MpvClient,
  MpvEndFileReason,
  MpvEvent,
  MpvFormat,
  MpvLogLevel,
  MpvPropertyValue,
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

  /** Return values of every `emit()` so far — the back-pressure signal. */
  readonly listenerReturns: boolean[] = []

  #listener: ((events: MpvEvent[]) => boolean) | undefined

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
    const value = this.readable.get(name)
    return typeof value === 'string' ? value : undefined
  }

  getPropertyNumber(name: string): number | undefined {
    const value = this.readable.get(name)
    return typeof value === 'number' ? value : undefined
  }

  getPropertyBool(name: string): boolean | undefined {
    const value = this.readable.get(name)
    return typeof value === 'boolean' ? value : undefined
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
