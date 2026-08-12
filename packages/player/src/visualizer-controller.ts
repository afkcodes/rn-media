import { PlayerErrorException, toVisualizerError } from './errors'
import { MpvProperty } from './properties'
import type { MpvClient, VisualizerCapture } from './specs/mpv-client.nitro'
import type {
  VisualizerCapabilities,
  VisualizerFrame,
  VisualizerOptions,
} from './visualizer'
import {
  createDecodeState,
  decodeVisualizerFrame,
  resolveVisualizerOptions,
} from './visualizer'

/** Removes a visualizer subscription. Safe to call more than once. */
export type VisualizerUnsubscribe = () => void

/** Called once per decoded frame. */
export type VisualizerListener = (frame: VisualizerFrame) => void

/** Capabilities reported when the linked libmpv has no PCM tap. */
const UNAVAILABLE: VisualizerCapabilities = {
  fft: false,
  waveform: false,
  maxFps: 0,
  minFftSize: 0,
  maxFftSize: 0,
}

/**
 * Limits of the native engine. Fixed, not probed: they are the patch's own
 * bounds (`MP_PCM_TAP_MIN_FRAMES`/`MAX_FRAMES` narrowed by `PcmTap`'s
 * `kMinFftSize`/`kMaxFftSize`) and `kMaxVisualizerFps`, and they are the same
 * numbers on both platforms because it is the same code.
 */
const AVAILABLE: VisualizerCapabilities = {
  fft: true,
  waveform: true,
  maxFps: 60,
  minFftSize: 64,
  maxFftSize: 16384,
}

interface Subscription {
  readonly listener: VisualizerListener
  readonly options: Required<VisualizerOptions>
  readonly state: ReturnType<typeof createDecodeState>
}

/**
 * The lazy, reference-counted owner of one player's audio visualizer.
 *
 * ### Laziness is the whole contract
 * Nothing exists until the first {@link VisualizerController.subscribe}: mpv's
 * tap is disarmed, its ring is unallocated, and there is no sampler thread, no
 * FFT table and no window. The last unsubscribe releases all of it and disarms
 * mpv again, after which the audio thread's tap path is a single atomic load per
 * device chunk. This is why `subscribe` — not a manual `start`/`stop` pair — is
 * the primitive: a lifetime that is *derived from* the listener set cannot be
 * leaked by forgetting to call `stop()`. There is deliberately no free-standing
 * `start()`: it could only ever mean "hold the tap open with nobody looking",
 * which is the one state this design exists to make unrepresentable.
 *
 * ### Native parameters are the union, decode parameters are per subscriber
 * `fftSize`, `fps` and `waveform` configure the one shared native sampler, so
 * they are resolved as the union across live subscribers (largest transform,
 * fastest rate, waveform if anyone wants it). Everything else — band count, dB
 * window, tilt, auto-gain, smoothing — is pure maths applied per subscriber, so
 * two components can paint the same audio with different ballistics without
 * fighting over the engine.
 */
export class VisualizerController {
  readonly #client: MpvClient | undefined
  readonly #subscriptions = new Set<Subscription>()

  #capabilities: VisualizerCapabilities | undefined
  #active = false
  #destroyed = false
  /** Native parameters currently in force, for change detection on restart. */
  #applied: { fftSize: number; fps: number; waveform: boolean } | undefined

  /**
   * @param client - The player's mpv binding, or `undefined` when the player
   * was built without one (never in production; the tests do it).
   */
  constructor(client: MpvClient | undefined) {
    this.#client = client
  }

  /**
   * What this build can actually do. Probed once, then cached.
   *
   * The probe is a plain property read through the generic binding — if
   * `pcm-tap` exists, this libmpv carries the rn-media source patch and the
   * visualizer works; if it does not, mpv answers "no such property" and the
   * feature reports itself unavailable. One code path, both platforms, no
   * `Platform.OS`. Reading this allocates nothing.
   */
  get capabilities(): VisualizerCapabilities {
    if (this.#capabilities !== undefined) return this.#capabilities
    const client = this.#client
    if (client === undefined) {
      this.#capabilities = UNAVAILABLE
      return this.#capabilities
    }
    try {
      client.getPropertyNumber(MpvProperty.pcmTap)
      this.#capabilities = AVAILABLE
    } catch {
      this.#capabilities = UNAVAILABLE
    }
    return this.#capabilities
  }

  /** Whether a native capture is running right now. */
  get active(): boolean {
    return this.#active
  }

  /**
   * Start delivering frames to `listener`.
   *
   * @param listener - Called with one decoded {@link VisualizerFrame} per
   * capture, at up to `options.fps`.
   * @param options - Per-subscriber tuning; see {@link VisualizerOptions}.
   * @returns A function that removes this subscription — and, when it was the
   * last one, disarms the native tap completely.
   * @throws {@link PlayerErrorException} with code `unsupported` when the
   * linked libmpv has no PCM tap, or `disposed` after the owning player was
   * destroyed. It never fails silently.
   */
  subscribe(
    listener: VisualizerListener,
    options?: VisualizerOptions
  ): VisualizerUnsubscribe {
    if (this.#destroyed) {
      throw new PlayerErrorException({
        code: 'disposed',
        message: 'Player has been destroyed',
        retryable: false,
      })
    }
    const capabilities = this.capabilities
    const client = this.#client
    if (!capabilities.fft || client === undefined) {
      throw new PlayerErrorException({
        code: 'unsupported',
        message:
          'This libmpv has no PCM tap, so there is nothing to visualise. The ' +
          'visualizer needs a libmpv built from the rn-media forks (Android ' +
          '>= v1.1.9-rnmedia.3, iOS >= v0.7.2-rnmedia.3). Check ' +
          'player.visualizer.capabilities before subscribing.',
        retryable: false,
      })
    }

    const resolved = resolveVisualizerOptions(options, capabilities)
    const subscription: Subscription = {
      listener,
      options: resolved,
      state: createDecodeState(resolved.bands),
    }
    this.#subscriptions.add(subscription)

    try {
      this.#reconcile()
    } catch (thrown) {
      // Roll the subscription back so a rejected subscribe leaves no trace —
      // otherwise a failed start would keep a phantom listener that makes the
      // next unsubscribe tear down someone else's capture.
      this.#subscriptions.delete(subscription)
      throw new PlayerErrorException(toVisualizerError(thrown))
    }

    let removed = false
    return () => {
      if (removed) return
      removed = true
      this.#subscriptions.delete(subscription)
      this.#reconcile()
    }
  }

  /**
   * Deliver a native capture to every subscriber.
   *
   * Wired to the native listener by {@link Player}; not part of the public
   * API surface, but harmless to call with a synthetic capture in tests.
   *
   * @param capture - The raw capture as the native binding delivered it.
   */
  handleCapture(capture: VisualizerCapture): void {
    if (this.#subscriptions.size === 0) return
    for (const subscription of this.#subscriptions) {
      const frame = decodeVisualizerFrame(
        capture,
        subscription.options,
        subscription.state
      )
      if (frame === undefined) continue
      subscription.listener(frame)
    }
  }

  /**
   * Release everything. Called by `Player.destroy()`; idempotent.
   *
   * Drops every subscription first so the native teardown happens exactly
   * once, then stops the sampler.
   */
  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#subscriptions.clear()
    this.#stopNative()
  }

  /**
   * Bring the native sampler in line with the current subscriber set.
   *
   * Restarts only when the union of native parameters actually changed —
   * a second subscriber with compatible settings joins the running capture
   * instead of interrupting it.
   */
  #reconcile(): void {
    const client = this.#client
    if (client === undefined) return

    if (this.#subscriptions.size === 0) {
      this.#stopNative()
      return
    }

    let fftSize = 0
    let fps = 0
    let waveform = false
    for (const subscription of this.#subscriptions) {
      fftSize = Math.max(fftSize, subscription.options.fftSize)
      fps = Math.max(fps, subscription.options.fps)
      waveform = waveform || subscription.options.waveform
    }

    const applied = this.#applied
    if (
      this.#active &&
      applied !== undefined &&
      applied.fftSize === fftSize &&
      applied.fps === fps &&
      applied.waveform === waveform
    ) {
      return
    }

    client.startVisualizer(fftSize, fps, waveform)
    this.#active = true
    this.#applied = { fftSize, fps, waveform }
  }

  #stopNative(): void {
    if (!this.#active) return
    this.#active = false
    this.#applied = undefined
    try {
      this.#client?.stopVisualizer()
    } catch {
      // Teardown must not throw: `destroy()` is called from `Player.destroy()`,
      // which is itself a cleanup path. A failed disarm is already terminal for
      // the tap, and rethrowing here would mask the original reason the player
      // was being torn down.
    }
  }
}
