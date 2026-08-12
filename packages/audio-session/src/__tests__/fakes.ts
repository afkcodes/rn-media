import type {
  AudioSessionConfig,
  NativeInterruptionEvent,
  NativeRouteChangeEvent,
  RnMediaAudioSession,
} from '../specs/audio-session.nitro'
import type { AudioSessionPlayerLike } from '../wire'

/**
 * In-memory stand-in for the Kotlin/Swift hybrid object.
 *
 * Mirrors the real contract exactly — id-based listener registration included —
 * so a test that passes here is testing the same wiring that ships.
 */
export class FakeNativeAudioSession implements RnMediaAudioSession {
  readonly name = 'RnMediaAudioSession'

  readonly configureCalls: AudioSessionConfig[] = []
  activateCalls = 0
  deactivateCalls = 0

  /** Resolution of the next `activate()`. */
  activateResult = true
  /** When set, `configure()` rejects with it. */
  configureError: Error | undefined

  private nextId = 1
  private readonly interruptionListeners = new Map<
    number,
    (event: NativeInterruptionEvent) => void
  >()
  private readonly becomingNoisyListeners = new Map<number, () => void>()
  private readonly routeChangeListeners = new Map<
    number,
    (event: NativeRouteChangeEvent) => void
  >()

  configure(config: AudioSessionConfig): Promise<void> {
    this.configureCalls.push(config)
    return this.configureError != null
      ? Promise.reject(this.configureError)
      : Promise.resolve()
  }

  activate(): Promise<boolean> {
    this.activateCalls += 1
    return Promise.resolve(this.activateResult)
  }

  deactivate(): Promise<void> {
    this.deactivateCalls += 1
    return Promise.resolve()
  }

  addInterruptionListener(
    listener: (event: NativeInterruptionEvent) => void
  ): number {
    const id = this.nextId++
    this.interruptionListeners.set(id, listener)
    return id
  }

  removeInterruptionListener(listenerId: number): void {
    this.interruptionListeners.delete(listenerId)
  }

  addBecomingNoisyListener(listener: () => void): number {
    const id = this.nextId++
    this.becomingNoisyListeners.set(id, listener)
    return id
  }

  removeBecomingNoisyListener(listenerId: number): void {
    this.becomingNoisyListeners.delete(listenerId)
  }

  addRouteChangeListener(
    listener: (event: NativeRouteChangeEvent) => void
  ): number {
    const id = this.nextId++
    this.routeChangeListeners.set(id, listener)
    return id
  }

  removeRouteChangeListener(listenerId: number): void {
    this.routeChangeListeners.delete(listenerId)
  }

  // --- HybridObject surface (unused by this package, present for the type) ---

  toString(): string {
    return '[HybridObject RnMediaAudioSession]'
  }

  equals(other: RnMediaAudioSession): boolean {
    return this === other
  }

  dispose(): void {
    this.interruptionListeners.clear()
    this.becomingNoisyListeners.clear()
    this.routeChangeListeners.clear()
  }

  // --- Test drivers ---

  get listenerCounts(): {
    interruption: number
    becomingNoisy: number
    routeChange: number
  } {
    return {
      interruption: this.interruptionListeners.size,
      becomingNoisy: this.becomingNoisyListeners.size,
      routeChange: this.routeChangeListeners.size,
    }
  }

  emitInterruption(event: NativeInterruptionEvent): void {
    for (const listener of [...this.interruptionListeners.values()])
      listener(event)
  }

  emitBecomingNoisy(): void {
    for (const listener of [...this.becomingNoisyListeners.values()]) listener()
  }

  emitRouteChange(event: NativeRouteChangeEvent): void {
    for (const listener of [...this.routeChangeListeners.values()])
      listener(event)
  }
}

/** Records every call so a test can assert on ordering, not just end state. */
export class FakePlayer implements AudioSessionPlayerLike {
  readonly calls: string[] = []
  private volume: number

  constructor(initialVolume = 1) {
    this.volume = initialVolume
  }

  play(): void {
    this.calls.push('play')
  }

  pause(): void {
    this.calls.push('pause')
  }

  setVolume(volume: number): void {
    this.volume = volume
    this.calls.push(`setVolume(${volume})`)
  }

  getVolume(): number {
    return this.volume
  }
}

/** `begin: true` interruption fixture. */
export function beginInterruption(
  type: 'duck' | 'pause',
  permanent = false
): NativeInterruptionEvent {
  return { begin: true, type, shouldResume: false, permanent }
}

/** `begin: false` interruption fixture. */
export function endInterruption(
  shouldResume: boolean
): NativeInterruptionEvent {
  return { begin: false, type: 'pause', shouldResume, permanent: false }
}
