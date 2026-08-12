import type { VisualizerCapture } from './specs/mpv-client.nitro'

/**
 * What the visualizer can deliver, probed from the linked libmpv rather than
 * assumed.
 *
 * @remarks
 * There is no per-platform branching here and no per-platform story to tell:
 * both platforms read the same two mpv properties from the same source patch
 * (ARCHITECTURE §11, §21). The one thing that can vary is the *binary* — a
 * libmpv older than `v1.1.9-rnmedia.3` / `v0.7.2-rnmedia.3` has no PCM tap — and
 * that is what {@link VisualizerCapabilities.fft} answers. A capability that
 * cannot be served fails with a typed error, never a silent no-op.
 */
export interface VisualizerCapabilities {
  /** Whether a frequency spectrum is available at all. */
  readonly fft: boolean
  /** Whether time-domain samples are available. Tracks {@link fft}. */
  readonly waveform: boolean
  /**
   * Fastest delivery rate, in frames per second.
   *
   * This is the rate frames are *delivered* at, which is not the rate new
   * spectral content arrives at: the tap only advances when the audio device
   * consumes a chunk, measured at ~20-45 Hz on Android. Delivering faster is
   * still worth doing, because the asymmetric smoothing below animates between
   * targets and can only do that on frames it is given.
   */
  readonly maxFps: number
  /** Smallest legal {@link VisualizerOptions.fftSize}. */
  readonly minFftSize: number
  /** Largest legal {@link VisualizerOptions.fftSize}. */
  readonly maxFftSize: number
}

/** Tuning for {@link VisualizerController.subscribe}. */
export interface VisualizerOptions {
  /**
   * Frames per second. Default {@link DEFAULT_VISUALIZER_FPS} (30), clamped to
   * {@link VisualizerCapabilities.maxFps} (60).
   */
  readonly fps?: number
  /** Number of log-spaced output bands. Default 32. */
  readonly bands?: number
  /**
   * Transform length in samples; a power of two. Default 2048.
   *
   * Bigger means finer frequency resolution (2048 at 48 kHz is ~23 Hz per bin)
   * and a longer window, so transients smear a little more. 1024 is snappier,
   * 4096 resolves bass better.
   */
  readonly fftSize?: number
  /**
   * Band power in dBFS mapped to `0`. Default -40.
   *
   * These are true dBFS: the native transform is calibrated so a full-scale
   * sine reads exactly `1.0` (`0 dBFS`), which the C++ suite asserts against a
   * real transform. The default window is the one place this module makes a
   * choice about *presentation*, because a dB axis has to start somewhere — and
   * it was chosen by measurement, not taste. On a modern commercial master
   * (48 kHz AAC, 2048-point transform, 20 log bands) the quiet bands measure
   * around -35 dBFS and the loud ones around -17, so a -40…-10 window puts real
   * content across the height with headroom left for transients. Nothing else
   * is applied by default: no tilt, no gain, no cosmetic curve.
   */
  readonly minDb?: number
  /** Band power in dBFS mapped to `1`. Default -10. */
  readonly maxDb?: number
  /** Lowest band edge in Hz. Default 32. */
  readonly minHz?: number
  /** Highest band edge in Hz, clamped to Nyquist. Default 16000. */
  readonly maxHz?: number
  /**
   * Spectral tilt in dB per octave, referenced to 1 kHz. **Default 0.**
   *
   * An opt-in display aid, off by default because the default has to be the
   * real spectrum. Music's power falls at roughly 3 dB per octave (which is why
   * "pink" noise, not white, sounds even), so `3` flattens that slope and makes
   * the top of the display as active as the bottom. It is a lie about the
   * audio, told deliberately — useful for a decorative bar display, wrong for
   * anything you would read a number off.
   */
  readonly tiltDbPerOctave?: number
  /**
   * Track the programme level and shift the dB window to follow it.
   * **Default `false`.**
   *
   * @remarks
   * The other opt-in display aid, and off for the same reason: with it on, bar
   * height stops meaning a level and starts meaning "loud relative to how loud
   * this has been lately", which is not a representation of the audio. Turn it
   * on when you would rather a quiet recording still filled the display than
   * have the display tell the truth about it.
   *
   * When on it is bounded (-6 to +18 dB), backs off four times faster than it
   * builds, and holds still below {@link AGC_SILENCE_DB} so it can never
   * amplify a noise floor into a full-height display. {@link
   * VisualizerFrame.gainDb} always reports what it is doing.
   */
  readonly autoGain?: boolean
  /**
   * Smoothing coefficient applied when a band *rises*, in `(0, 1]`. Higher is
   * snappier. Default 0.65.
   */
  readonly attack?: number
  /**
   * Smoothing coefficient applied when a band *falls*, in `(0, 1]`. Lower
   * decays more slowly. Default 0.12.
   */
  readonly release?: number
  /**
   * How fast a peak-hold cap accelerates downward, per frame. Default 0.004.
   *
   * This is gravity, not a decay rate: the cap hangs still for
   * {@link peakHoldFrames}, then falls with an accelerating velocity, which is
   * the classic Winamp ballistic. A plain exponential decay droops instead of
   * dropping and reads as sluggish.
   */
  readonly peakGravity?: number
  /**
   * Frames a peak cap hangs at its high-water mark before it starts to fall.
   * Default 15 (half a second at the default 30 fps).
   */
  readonly peakHoldFrames?: number
  /**
   * Also deliver time-domain samples. Default `false` — it doubles the
   * per-frame payload, and a bar visualiser does not need it.
   */
  readonly waveform?: boolean
}

/** One decoded frame, ready to paint. */
export interface VisualizerFrame {
  /**
   * Log-spaced bands in `[0, 1]`, asymmetrically smoothed. This is what a bar
   * visualiser wants: paint the values directly and the "bounce" is already
   * there, with no client-side animation.
   */
  readonly bands: Float32Array
  /**
   * Per-bin **linear** magnitudes, where `1.0` is a full-scale sinusoid.
   * Length is `fftSize / 2 + 1`; bin `k` is centred on `k * sampleRate /
   * fftSize` Hz.
   *
   * Handed through from native untouched — no dB mapping, no smoothing, no
   * copy — so a caller doing its own analysis (mel, Bark, chroma, peak
   * picking) starts from the real numbers rather than from this module's
   * opinions.
   */
  readonly magnitudes: Float32Array
  /**
   * Per-band peak-hold caps in `[0, 1]`, one per {@link bands} entry.
   *
   * Each rises instantly to a new high-water mark, hangs, then falls under
   * gravity — the little floating markers above the bars in a classic
   * spectrum analyser. Always present; computing them is a handful of
   * arithmetic per band, so there is no reason to make it opt-in.
   */
  readonly peaks: Float32Array
  /**
   * Mono time-domain samples in `[-1, 1]`, or `undefined` unless
   * {@link VisualizerOptions.waveform} was set. `fftSize` values, unwindowed.
   */
  readonly waveform?: Float32Array
  /** Peak absolute sample in `[0, 1]`. `undefined` without `waveform`. */
  readonly peak?: number
  /** RMS of the samples in `[0, 1]`. `undefined` without `waveform`. */
  readonly rms?: number
  /**
   * Auto-gain currently applied, in dB, or `0` when
   * {@link VisualizerOptions.autoGain} is off. Exposed because a display that
   * silently rescales itself should be able to say so.
   */
  readonly gainDb: number
  /** Sample rate of the visualised audio, in Hz. */
  readonly sampleRate: number
  /** `Date.now()`-comparable timestamp taken natively at capture. */
  readonly capturedAt: number
  /**
   * Frames the native sampler skipped since the previous one because this
   * listener had not finished with the last. Steadily non-zero means the
   * painting is too slow for the requested `fps`.
   */
  readonly dropped: number
}

/** Default frame rate requested by {@link VisualizerController.subscribe}. */
export const DEFAULT_VISUALIZER_FPS = 30

/**
 * Band power below which {@link VisualizerOptions.autoGain} stops adapting.
 *
 * Without a floor, an auto-gain converges on whatever is left when the music
 * stops — the noise floor — and paints it as a full-height display. -95 dBFS is
 * below anything that is content and above a digital-silence -inf.
 */
export const AGC_SILENCE_DB = -95

/** Defaults for every {@link VisualizerOptions} field. */
export const VISUALIZER_DEFAULTS = {
  fps: DEFAULT_VISUALIZER_FPS,
  bands: 32,
  fftSize: 2048,
  minDb: -40,
  maxDb: -10,
  minHz: 32,
  maxHz: 16000,
  tiltDbPerOctave: 0,
  autoGain: false,
  attack: 0.65,
  release: 0.12,
  peakGravity: 0.004,
  peakHoldFrames: 15,
  waveform: false,
} as const satisfies Required<VisualizerOptions>

/** Bounds the auto-gain may never leave, in dB. */
const AGC_MIN_GAIN_DB = -6
const AGC_MAX_GAIN_DB = 18
/** Per-frame coefficients: back off quickly, build slowly. */
const AGC_DOWN = 0.25
const AGC_UP = 0.02
/** Where the loudest band is aimed, as a fraction of the display window. */
const AGC_HEADROOM_DB = 3

/** Reference frequency for {@link VisualizerOptions.tiltDbPerOctave}. */
const TILT_REFERENCE_HZ = 1000

/**
 * Resolve user options against {@link VISUALIZER_DEFAULTS}, clamping every
 * field into a range the maths below is total over.
 *
 * @param options - Partial options as passed by the caller.
 * @param capabilities - The engine's probed limits.
 * @returns Fully-populated, range-checked options.
 */
export function resolveVisualizerOptions(
  options: VisualizerOptions | undefined,
  capabilities: VisualizerCapabilities
): Required<VisualizerOptions> {
  const merged = { ...VISUALIZER_DEFAULTS, ...stripUndefined(options) }
  const fftSize = clampPowerOfTwo(
    merged.fftSize,
    capabilities.minFftSize,
    capabilities.maxFftSize
  )
  // `maxDb` must stay strictly above `minDb`: they are the denominator of the
  // normalisation, and an inverted or empty window would produce NaN.
  const minDb = merged.minDb
  const maxDb = merged.maxDb > minDb ? merged.maxDb : minDb + 1
  return {
    fps: clamp(merged.fps, 1, capabilities.maxFps),
    bands: Math.max(1, Math.floor(merged.bands)),
    fftSize,
    minDb,
    maxDb,
    minHz: Math.max(1, merged.minHz),
    maxHz: Math.max(merged.minHz + 1, merged.maxHz),
    tiltDbPerOctave: clamp(merged.tiltDbPerOctave, -12, 12),
    autoGain: merged.autoGain,
    attack: clamp(merged.attack, 0.001, 1),
    release: clamp(merged.release, 0.001, 1),
    peakGravity: clamp(merged.peakGravity, 0, 1),
    peakHoldFrames: Math.max(0, Math.floor(merged.peakHoldFrames)),
    waveform: merged.waveform,
  }
}

/**
 * Which bins each band covers, plus the band's tilt correction.
 *
 * Recomputed only when the geometry changes (bin count, sample rate, band
 * count, band edges) rather than every frame: it costs a `log`, an `exp` and a
 * `log2` per band, and at 60 fps × 32 bands that is pure waste to repeat for
 * numbers that never move during a subscription.
 */
interface BandPlan {
  readonly bins: number
  readonly sampleRate: number
  readonly bands: number
  readonly minHz: number
  readonly maxHz: number
  readonly tiltDbPerOctave: number
  readonly start: Int32Array
  readonly end: Int32Array
  readonly tiltDb: Float32Array
}

/**
 * Per-subscription state the smoothing and the auto-gain need between frames.
 *
 * Kept explicit (rather than hidden in a closure) so the decode step stays a
 * pure function of `(capture, options, state)` and is trivially testable.
 */
export interface VisualizerDecodeState {
  /** Previous smoothed band values; grown/reset when `bands` changes. */
  smoothed: Float32Array
  /** Current peak-hold cap per band. */
  peaks: Float32Array
  /** Downward velocity of each cap, accumulated by gravity. */
  peakVelocity: Float32Array
  /** Frames each cap still hangs before it starts falling. */
  peakHold: Float32Array
  /** Scratch for per-band power, reused so decoding allocates nothing. */
  power: Float32Array
  /** Current auto-gain offset in dB; `0` until the first non-silent frame. */
  gainDb: number
  /** Cached band geometry, rebuilt only when it actually changes. */
  plan?: BandPlan
}

/** A fresh {@link VisualizerDecodeState} for `bands` bands. */
export function createDecodeState(bands: number): VisualizerDecodeState {
  return {
    smoothed: new Float32Array(bands),
    peaks: new Float32Array(bands),
    peakVelocity: new Float32Array(bands),
    peakHold: new Float32Array(bands),
    power: new Float32Array(bands),
    gainDb: 0,
  }
}

/**
 * Turn one native capture into a paintable {@link VisualizerFrame}.
 *
 * @param capture - Exactly what the native sampler delivered: linear
 * magnitudes calibrated so a full-scale sinusoid is `1.0`.
 * @param options - Resolved options (see {@link resolveVisualizerOptions}).
 * @param state - Mutable smoothing/auto-gain state; updated in place.
 * @returns The decoded frame, or `undefined` when the capture carried no bins.
 *
 * @remarks
 * The chain is: band **power** (the sum of squared magnitudes over the band's
 * bins, i.e. the physically real quantity, not the loudest bin) → dB → the
 * display window → asymmetric smoothing → peak ballistics. Aggregating by power
 * rather than by maximum is what makes a band respond to how much energy is in
 * it instead of to whichever bin happened to spike — the difference between
 * bars that track the music and bars that flicker.
 *
 * Spectral tilt and auto-gain sit in that chain too, between dB and the window,
 * and **both are off by default**. What comes out of a default subscription is
 * the measured spectrum of the audio: no cosmetic curve, no moving reference,
 * nothing but a dB axis and a smoothing filter.
 */
export function decodeVisualizerFrame(
  capture: VisualizerCapture,
  options: Required<VisualizerOptions>,
  state: VisualizerDecodeState
): VisualizerFrame | undefined {
  const magnitudes = new Float32Array(capture.magnitudes)
  if (magnitudes.length === 0) return undefined

  const plan = planFor(state, magnitudes.length, capture.sampleRate, options)
  const power = ensureLength(state, options.bands)

  // Band power, in dB, tilted. Kept in dB from here on because both the
  // auto-gain and the display window are dB-domain operations.
  let peakDb = Number.NEGATIVE_INFINITY
  for (let b = 0; b < options.bands; b++) {
    let sum = 0
    const end = plan.end[b]!
    for (let k = plan.start[b]!; k <= end; k++) {
      const magnitude = magnitudes[k]!
      sum += magnitude * magnitude
    }
    // `10 * log10(power)` — power, not amplitude, so no factor of 20.
    const db =
      sum > 0
        ? 10 * Math.log10(sum) + plan.tiltDb[b]!
        : Number.NEGATIVE_INFINITY
    power[b] = db
    if (db > peakDb) peakDb = db
  }

  const gainDb = options.autoGain ? advanceGain(state, peakDb, options) : 0
  state.gainDb = gainDb

  const span = options.maxDb - options.minDb
  for (let b = 0; b < options.bands; b++) {
    power[b] = clamp((power[b]! + gainDb - options.minDb) / span, 0, 1)
  }

  smoothInto(state, power, options)
  advancePeaks(state, options)

  let waveform: Float32Array | undefined
  let peak: number | undefined
  let rms: number | undefined
  if (capture.waveform !== undefined) {
    waveform = new Float32Array(capture.waveform)
    let peakAcc = 0
    let squareAcc = 0
    for (let i = 0; i < waveform.length; i++) {
      const sample = waveform[i]!
      const magnitude = sample < 0 ? -sample : sample
      if (magnitude > peakAcc) peakAcc = magnitude
      squareAcc += sample * sample
    }
    peak = peakAcc
    rms = waveform.length === 0 ? 0 : Math.sqrt(squareAcc / waveform.length)
  }

  return {
    bands: state.smoothed.slice(),
    magnitudes,
    peaks: state.peaks.slice(),
    waveform,
    peak,
    rms,
    gainDb,
    sampleRate: capture.sampleRate,
    capturedAt: capture.capturedAt,
    dropped: capture.dropped,
  }
}

/**
 * Move the auto-gain one frame toward the offset that would put the loudest
 * band just under the top of the window.
 *
 * Asymmetric on purpose: a track that gets louder must stop pegging the display
 * quickly, while a quiet passage should be allowed to *stay* quiet for a moment
 * rather than being pumped back up the instant it dips.
 */
function advanceGain(
  state: VisualizerDecodeState,
  peakDb: number,
  options: Required<VisualizerOptions>
): number {
  if (!Number.isFinite(peakDb) || peakDb < AGC_SILENCE_DB) {
    // Silence: hold. Adapting here would converge on the noise floor and paint
    // it full height the moment the music stops.
    return state.gainDb
  }
  const target = clamp(
    options.maxDb - AGC_HEADROOM_DB - peakDb,
    AGC_MIN_GAIN_DB,
    AGC_MAX_GAIN_DB
  )
  const coefficient = target < state.gainDb ? AGC_DOWN : AGC_UP
  return state.gainDb + (target - state.gainDb) * coefficient
}

/**
 * Band geometry for the current capture, rebuilt only when it changed.
 *
 * @remarks
 * The non-obvious part is the empty-band fallback. Bin width is
 * `sampleRate / fftSize` — about 23 Hz at 48 kHz with a 2048-point transform —
 * while the lowest bands are only a few Hz wide, so the bottom of a log axis
 * contains *no bin at all*. Without the fallback those bands sit at zero
 * forever and the visualiser looks broken on bass-heavy music; with it, they
 * take the nearest bin.
 */
function planFor(
  state: VisualizerDecodeState,
  bins: number,
  sampleRate: number,
  options: Required<VisualizerOptions>
): BandPlan {
  const existing = state.plan
  if (
    existing !== undefined &&
    existing.bins === bins &&
    existing.sampleRate === sampleRate &&
    existing.bands === options.bands &&
    existing.minHz === options.minHz &&
    existing.maxHz === options.maxHz &&
    existing.tiltDbPerOctave === options.tiltDbPerOctave
  ) {
    return existing
  }

  const count = options.bands
  const start = new Int32Array(count)
  const end = new Int32Array(count)
  const tiltDb = new Float32Array(count)

  const nyquist = sampleRate > 0 ? sampleRate / 2 : 1
  const hzPerBin = nyquist / Math.max(1, bins - 1)
  const low = Math.max(1, Math.min(options.minHz, nyquist))
  const high = Math.max(low + 1, Math.min(options.maxHz, nyquist))
  const ratio = Math.log(high / low)

  for (let b = 0; b < count; b++) {
    const startHz = low * Math.exp((ratio * b) / count)
    const endHz = low * Math.exp((ratio * (b + 1)) / count)
    let startBin = Math.ceil(startHz / hzPerBin)
    let endBin = Math.floor(endHz / hzPerBin)
    if (endBin < startBin) {
      const nearest = clamp(
        Math.round((startHz + endHz) / 2 / hzPerBin),
        0,
        bins - 1
      )
      startBin = nearest
      endBin = nearest
    }
    start[b] = clamp(startBin, 0, bins - 1)
    end[b] = clamp(endBin, 0, bins - 1)

    const centreHz = Math.sqrt(startHz * endHz)
    tiltDb[b] =
      options.tiltDbPerOctave * Math.log2(centreHz / TILT_REFERENCE_HZ)
  }

  const plan: BandPlan = {
    bins,
    sampleRate,
    bands: count,
    minHz: options.minHz,
    maxHz: options.maxHz,
    tiltDbPerOctave: options.tiltDbPerOctave,
    start,
    end,
    tiltDb,
  }
  state.plan = plan
  return plan
}

function ensureLength(
  state: VisualizerDecodeState,
  bands: number
): Float32Array {
  if (state.power.length !== bands) {
    state.power = new Float32Array(bands)
  }
  return state.power
}

/**
 * Move every peak-hold cap one frame: snap up to a new high-water mark, else
 * hang for `peakHoldFrames`, else fall under accumulating gravity.
 */
function advancePeaks(
  state: VisualizerDecodeState,
  options: Required<VisualizerOptions>
): void {
  const { smoothed, peaks, peakVelocity, peakHold } = state
  for (let i = 0; i < smoothed.length; i++) {
    const band = smoothed[i]!
    if (band >= peaks[i]!) {
      peaks[i] = band
      peakVelocity[i] = 0
      peakHold[i] = options.peakHoldFrames
    } else if (peakHold[i]! > 0) {
      peakHold[i] = peakHold[i]! - 1
    } else {
      peakVelocity[i] = peakVelocity[i]! + options.peakGravity
      const next = peaks[i]! - peakVelocity[i]!
      peaks[i] = next < band ? band : next
    }
  }
}

/** Asymmetric EMA: fast attack, slow release, applied in place. */
function smoothInto(
  state: VisualizerDecodeState,
  next: Float32Array,
  options: Required<VisualizerOptions>
): void {
  if (state.smoothed.length !== next.length) {
    state.smoothed = new Float32Array(next.length)
    state.peaks = new Float32Array(next.length)
    state.peakVelocity = new Float32Array(next.length)
    state.peakHold = new Float32Array(next.length)
  }
  const previous = state.smoothed
  for (let i = 0; i < next.length; i++) {
    const target = next[i]!
    const current = previous[i]!
    const coefficient = target > current ? options.attack : options.release
    previous[i] = current + (target - current) * coefficient
  }
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/** Largest power of two `<= value`, clamped into `[min, max]`. */
function clampPowerOfTwo(value: number, min: number, max: number): number {
  const bounded = clamp(Math.floor(value), min, max)
  const power = 2 ** Math.floor(Math.log2(bounded))
  return clamp(power, min, max)
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (value === undefined) return {}
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry
  }
  return out as Partial<T>
}
