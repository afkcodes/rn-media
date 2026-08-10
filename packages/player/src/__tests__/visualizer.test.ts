import { describe, expect, it } from 'vitest'
import type { VisualizerCapabilities } from '../visualizer'
import {
  AGC_SILENCE_DB,
  VISUALIZER_DEFAULTS,
  createDecodeState,
  decodeVisualizerFrame,
  resolveVisualizerOptions,
} from '../visualizer'
import { toneCapture, visualizerCapture } from './fake-mpv-client'

/**
 * The engine's real limits — the patch's bounds narrowed by `PcmTap`'s, and the
 * same numbers on both platforms because it is the same code.
 */
const CAPABILITIES: VisualizerCapabilities = {
  fft: true,
  waveform: true,
  maxFps: 60,
  minFftSize: 64,
  maxFftSize: 16384,
}

function options(overrides: Partial<Parameters<typeof resolveVisualizerOptions>[0]> = {}) {
  return resolveVisualizerOptions(overrides, CAPABILITIES)
}

/** Linear magnitude for a given dBFS band power in a single bin. */
function magnitudeForDb(db: number): number {
  return 10 ** (db / 20)
}

describe('resolveVisualizerOptions', () => {
  it('clamps fps to what the engine supports', () => {
    expect(options({ fps: 240 }).fps).toBe(60)
    expect(options({ fps: 0 }).fps).toBe(1)
    expect(options().fps).toBe(VISUALIZER_DEFAULTS.fps)
  })

  it('rounds fftSize down to a power of two inside the legal range', () => {
    expect(options({ fftSize: 3000 }).fftSize).toBe(2048)
    expect(options({ fftSize: 1 }).fftSize).toBe(64)
    expect(options({ fftSize: 99999 }).fftSize).toBe(16384)
  })

  it('keeps the dB window non-degenerate', () => {
    const resolved = options({ minDb: -20, maxDb: -40 })
    expect(resolved.maxDb).toBeGreaterThan(resolved.minDb)
  })

  it('ignores explicitly-undefined fields rather than overwriting defaults', () => {
    expect(options({ bands: undefined }).bands).toBe(VISUALIZER_DEFAULTS.bands)
  })

  it('clamps smoothing coefficients into (0, 1]', () => {
    expect(options({ attack: 5 }).attack).toBe(1)
    expect(options({ release: -1 }).release).toBe(0.001)
  })

  it('clamps the spectral tilt to a sane range', () => {
    expect(options({ tiltDbPerOctave: 99 }).tiltDbPerOctave).toBe(12)
    expect(options({ tiltDbPerOctave: -99 }).tiltDbPerOctave).toBe(-12)
  })

  it('applies neither tilt nor auto-gain by default', () => {
    // The default has to be the real spectrum. Both knobs exist, both are
    // display aids, and both are opt-in — if this ever flips, a default
    // subscription stops representing the audio and starts flattering it.
    expect(options().tiltDbPerOctave).toBe(0)
    expect(options().autoGain).toBe(false)
    expect(options({ autoGain: true }).autoGain).toBe(true)
    expect(options({ tiltDbPerOctave: 3 }).tiltDbPerOctave).toBe(3)
  })
})

describe('decodeVisualizerFrame — calibration', () => {
  it('returns undefined when the capture carries no bins', () => {
    const capture = visualizerCapture({ magnitudes: [] })
    expect(
      decodeVisualizerFrame(capture, options(), createDecodeState(8))
    ).toBeUndefined()
  })

  it('maps a full-scale tone to the top of the window and silence to the floor', () => {
    // No auto-gain, so the mapping means exactly one thing.
    const resolved = options({
      bands: 4,
      autoGain: false,
      tiltDbPerOctave: 0,
      attack: 1,
      minDb: -72,
      maxDb: 0,
    })
    const loud = decodeVisualizerFrame(
      toneCapture(200, 1, { bins: 513 }),
      resolved,
      createDecodeState(4)
    )
    expect(Math.max(...loud!.bands)).toBeCloseTo(1, 5)

    const silent = decodeVisualizerFrame(
      visualizerCapture({ magnitudes: new Array(513).fill(0) }),
      resolved,
      createDecodeState(4)
    )
    expect(Math.max(...silent!.bands)).toBe(0)
  })

  it('aggregates a band by power, not by its loudest bin', () => {
    // Two bins at -40 dB each sum to -37 dB of band power; taking the maximum
    // would report -40. Power is what makes a band respond to how much energy
    // it holds instead of to whichever bin happened to spike.
    const resolved = options({
      bands: 1,
      autoGain: false,
      tiltDbPerOctave: 0,
      attack: 1,
      minHz: 20,
      maxHz: 24000,
      minDb: -60,
      maxDb: 0,
    })
    const one = new Array(513).fill(0)
    one[100] = magnitudeForDb(-40)
    const two = [...one]
    two[101] = magnitudeForDb(-40)

    const single = decodeVisualizerFrame(
      visualizerCapture({ magnitudes: one }),
      resolved,
      createDecodeState(1)
    )!
    const doubled = decodeVisualizerFrame(
      visualizerCapture({ magnitudes: two }),
      resolved,
      createDecodeState(1)
    )!
    // +3.01 dB over a 60 dB window == +0.0502 of full height.
    expect(doubled.bands[0]! - single.bands[0]!).toBeCloseTo(3.0103 / 60, 3)
  })

  it('hands the linear magnitudes through untouched', () => {
    const capture = toneCapture(7, 0.25, { bins: 33 })
    const frame = decodeVisualizerFrame(capture, options({ bands: 4 }), createDecodeState(4))!
    expect(frame.magnitudes).toHaveLength(33)
    expect(frame.magnitudes[7]).toBeCloseTo(0.25, 6)
    expect(frame.magnitudes[6]).toBe(0)
  })

  it('passes the sample rate, timestamp and drop count through', () => {
    const capture = visualizerCapture({
      magnitudes: new Array(33).fill(0.1),
      sampleRate: 44100,
      capturedAt: 12345,
      dropped: 7,
    })
    const frame = decodeVisualizerFrame(capture, options({ bands: 4 }), createDecodeState(4))!
    expect(frame.sampleRate).toBe(44100)
    expect(frame.capturedAt).toBe(12345)
    expect(frame.dropped).toBe(7)
  })
})

describe('decodeVisualizerFrame — bands', () => {
  it('puts a tone in the band that covers its frequency', () => {
    const resolved = options({
      bands: 8,
      autoGain: false,
      attack: 1,
      minHz: 40,
      maxHz: 16000,
    })
    // 513 bins at 48 kHz → ~46.9 Hz per bin. Bin 64 ≈ 3000 Hz.
    const frame = decodeVisualizerFrame(
      toneCapture(64, 1, { bins: 513 }),
      resolved,
      createDecodeState(8)
    )!
    const loudest = frame.bands.indexOf(Math.max(...frame.bands))
    // ln(3000/40) / (ln(16000/40) / 8) = 5.77, i.e. band 5.
    expect(loudest).toBe(5)
  })

  it('never leaves a low band empty just because no bin lands in it', () => {
    // Bin width at 48 kHz / 512 points is ~187 Hz, so the bottom bands of a
    // 32-band log axis contain no bin at all. Without the nearest-bin fallback
    // the whole bass third would sit at zero forever and look broken.
    const resolved = options({
      bands: 32,
      fftSize: 512,
      autoGain: false,
      attack: 1,
    })
    const magnitudes = new Array(129).fill(0)
    magnitudes[0] = 1
    magnitudes[1] = 1
    const frame = decodeVisualizerFrame(
      visualizerCapture({ magnitudes }),
      resolved,
      createDecodeState(32)
    )!
    // Band 0 spans ~32-35 Hz and contains no bin; the fallback gives it the
    // nearest one instead of leaving the whole bass third at zero forever.
    expect(frame.bands[0]).toBeGreaterThan(0)
  })

  it('produces exactly `bands` values', () => {
    for (const bands of [1, 5, 32, 64]) {
      const frame = decodeVisualizerFrame(
        toneCapture(10, 0.5, { bins: 129 }),
        options({ bands }),
        createDecodeState(bands)
      )!
      expect(frame.bands).toHaveLength(bands)
      expect(frame.peaks).toHaveLength(bands)
    }
  })

  it('hands out a fresh array per frame, never a live view of the state', () => {
    const state = createDecodeState(4)
    const resolved = options({ bands: 4 })
    const first = decodeVisualizerFrame(toneCapture(10, 1, { bins: 129 }), resolved, state)!
    const snapshot = Array.from(first.bands)
    decodeVisualizerFrame(toneCapture(10, 0, { bins: 129 }), resolved, state)
    expect(Array.from(first.bands)).toEqual(snapshot)
  })

  it('resets the smoothing buffer when the band count changes', () => {
    const state = createDecodeState(4)
    decodeVisualizerFrame(toneCapture(10, 1, { bins: 129 }), options({ bands: 4 }), state)
    const frame = decodeVisualizerFrame(
      toneCapture(10, 1, { bins: 129 }),
      options({ bands: 16 }),
      state
    )!
    expect(frame.bands).toHaveLength(16)
  })

  it('reuses the cached band plan while the geometry is unchanged', () => {
    const state = createDecodeState(8)
    const resolved = options({ bands: 8 })
    decodeVisualizerFrame(toneCapture(10, 1, { bins: 129 }), resolved, state)
    const plan = state.plan
    decodeVisualizerFrame(toneCapture(10, 1, { bins: 129 }), resolved, state)
    // Identity, not equality: rebuilding costs a log/exp/log2 per band on every
    // frame for numbers that cannot move during a subscription.
    expect(state.plan).toBe(plan)
  })

  it('rebuilds the plan when the sample rate changes', () => {
    const state = createDecodeState(8)
    const resolved = options({ bands: 8 })
    decodeVisualizerFrame(
      visualizerCapture({ magnitudes: new Array(129).fill(0.1), sampleRate: 48000 }),
      resolved,
      state
    )
    const plan = state.plan
    decodeVisualizerFrame(
      visualizerCapture({ magnitudes: new Array(129).fill(0.1), sampleRate: 44100 }),
      resolved,
      state
    )
    expect(state.plan).not.toBe(plan)
  })
})

describe('decodeVisualizerFrame — spectral tilt', () => {
  it('lifts high bands relative to low ones', () => {
    // Music's power falls at roughly 3 dB per octave. Drawn untilted, the top
    // of the display barely moves — this is what fixes that.
    const flat = new Array(513).fill(magnitudeForDb(-45))
    // A wide window on purpose: the point is the *relative* shift between the
    // bottom and top bands, which clamping at either end would hide.
    const resolved = (tilt: number) =>
      options({
        bands: 8,
        autoGain: false,
        attack: 1,
        tiltDbPerOctave: tilt,
        minDb: -80,
        maxDb: 20,
      })

    const untilted = decodeVisualizerFrame(
      visualizerCapture({ magnitudes: flat }),
      resolved(0),
      createDecodeState(8)
    )!
    expect(untilted.bands[0]).toBeGreaterThan(0)
    expect(untilted.bands[7]).toBeGreaterThan(0)
    const tilted = decodeVisualizerFrame(
      visualizerCapture({ magnitudes: flat }),
      resolved(3),
      createDecodeState(8)
    )!
    expect(tilted.bands[7]!).toBeGreaterThan(untilted.bands[7]!)
    expect(tilted.bands[0]!).toBeLessThan(untilted.bands[0]!)
  })

  it('is a no-op at zero', () => {
    const flat = new Array(513).fill(magnitudeForDb(-45))
    const a = decodeVisualizerFrame(
      visualizerCapture({ magnitudes: flat }),
      options({ bands: 4, autoGain: false, attack: 1, tiltDbPerOctave: 0 }),
      createDecodeState(4)
    )!
    const b = decodeVisualizerFrame(
      visualizerCapture({ magnitudes: flat }),
      options({ bands: 4, autoGain: false, attack: 1, tiltDbPerOctave: 0 }),
      createDecodeState(4)
    )!
    expect(Array.from(a.bands)).toEqual(Array.from(b.bands))
  })
})

describe('decodeVisualizerFrame — auto-gain', () => {
  /** Runs `frames` identical captures through one state and returns the last. */
  function settle(magnitude: number, frames: number, overrides = {}) {
    const state = createDecodeState(4)
    const resolved = options({
      bands: 4,
      attack: 1,
      tiltDbPerOctave: 0,
      autoGain: true,
      ...overrides,
    })
    let last
    for (let i = 0; i < frames; i++) {
      last = decodeVisualizerFrame(
        toneCapture(100, magnitude, { bins: 513 }),
        resolved,
        state
      )!
    }
    return last!
  }

  it('lifts a quiet source until it uses the display', () => {
    // -35 dBFS sits near the bottom of the default -40…-10 window. With the
    // gain on it climbs to the top of it; the same source with `autoGain: false`
    // stays where the dB axis says it belongs.
    const quiet = settle(magnitudeForDb(-35), 400)
    expect(quiet.gainDb).toBeGreaterThan(10)
    expect(Math.max(...quiet.bands)).toBeGreaterThan(0.7)

    const literal = settle(magnitudeForDb(-35), 400, { autoGain: false })
    expect(Math.max(...literal.bands)).toBeLessThan(0.25)
  })

  it('is bounded, so it can never invent a full-height display', () => {
    const veryQuiet = settle(magnitudeForDb(-90), 800)
    expect(veryQuiet.gainDb).toBeLessThanOrEqual(18)
  })

  it('backs off faster than it builds', () => {
    const state = createDecodeState(4)
    const resolved = options({ bands: 4, attack: 1, tiltDbPerOctave: 0, autoGain: true })
    // Settle quiet, so there is real gain to shed.
    for (let i = 0; i < 400; i++) {
      decodeVisualizerFrame(toneCapture(100, magnitudeForDb(-60), { bins: 513 }), resolved, state)
    }
    const before = state.gainDb
    decodeVisualizerFrame(toneCapture(100, 1, { bins: 513 }), resolved, state)
    const afterOneLoudFrame = state.gainDb
    // One loud frame must move the gain down by a quarter of the error, which
    // is an order of magnitude more than one quiet frame moves it up.
    expect(before - afterOneLoudFrame).toBeGreaterThan(3)
  })

  it('holds still in silence instead of amplifying the noise floor', () => {
    const state = createDecodeState(4)
    const resolved = options({ bands: 4, attack: 1, tiltDbPerOctave: 0, autoGain: true })
    for (let i = 0; i < 200; i++) {
      decodeVisualizerFrame(toneCapture(100, magnitudeForDb(-40), { bins: 513 }), resolved, state)
    }
    const settled = state.gainDb
    for (let i = 0; i < 200; i++) {
      decodeVisualizerFrame(
        toneCapture(100, magnitudeForDb(AGC_SILENCE_DB - 10), { bins: 513 }),
        resolved,
        state
      )
    }
    expect(state.gainDb).toBe(settled)
  })

  it('reports zero gain and never moves the window when off — the default', () => {
    const off = settle(magnitudeForDb(-30), 400, { autoGain: false })
    expect(off.gainDb).toBe(0)
    // -30 dBFS in the default -40…-10 window is (−30 + 40) / 30, and it stays
    // there however long the source runs: the default is a calibrated meter,
    // not a slow one.
    expect(Math.max(...off.bands)).toBeCloseTo(10 / 30, 5)
  })
})

describe('decodeVisualizerFrame — smoothing', () => {
  it('rises with attack and falls with release', () => {
    const state = createDecodeState(1)
    const resolved = options({
      bands: 1,
      autoGain: false,
      tiltDbPerOctave: 0,
      attack: 0.5,
      release: 0.1,
      minHz: 20,
      maxHz: 24000,
      minDb: -60,
      maxDb: 0,
    })
    const loud = toneCapture(100, 1, { bins: 513 })
    const quiet = visualizerCapture({ magnitudes: new Array(513).fill(0) })

    const first = decodeVisualizerFrame(loud, resolved, state)!
    expect(first.bands[0]).toBeCloseTo(0.5, 5)
    const second = decodeVisualizerFrame(loud, resolved, state)!
    expect(second.bands[0]).toBeCloseTo(0.75, 5)
    // Falling uses `release`, so the drop from 0.75 is a tenth of the way.
    const third = decodeVisualizerFrame(quiet, resolved, state)!
    expect(third.bands[0]).toBeCloseTo(0.675, 5)
  })
})

describe('decodeVisualizerFrame — waveform', () => {
  it('is absent unless the capture carried one', () => {
    const frame = decodeVisualizerFrame(
      toneCapture(10, 0.5, { bins: 33 }),
      options({ bands: 4 }),
      createDecodeState(4)
    )!
    expect(frame.waveform).toBeUndefined()
    expect(frame.peak).toBeUndefined()
    expect(frame.rms).toBeUndefined()
  })

  it('reports peak and rms over float samples', () => {
    const capture = visualizerCapture({
      magnitudes: new Array(33).fill(0),
      waveform: [0, 0.5, -0.75, 0.25],
    })
    const frame = decodeVisualizerFrame(capture, options({ bands: 4 }), createDecodeState(4))!
    expect(frame.waveform).toHaveLength(4)
    expect(frame.peak).toBeCloseTo(0.75, 6)
    expect(frame.rms).toBeCloseTo(Math.sqrt((0 + 0.25 + 0.5625 + 0.0625) / 4), 6)
  })
})

describe('decodeVisualizerFrame — peak ballistics', () => {
  const resolved = options({
    bands: 1,
    autoGain: false,
    tiltDbPerOctave: 0,
    attack: 1,
    release: 1,
    minHz: 20,
    maxHz: 24000,
    minDb: -60,
    maxDb: 0,
    peakHoldFrames: 3,
    peakGravity: 0.01,
  })
  const loud = toneCapture(100, 1, { bins: 513 })
  const silent = visualizerCapture({ magnitudes: new Array(513).fill(0) })

  it('snaps a cap up instantly to a new high-water mark', () => {
    const state = createDecodeState(1)
    const frame = decodeVisualizerFrame(loud, resolved, state)!
    expect(frame.peaks[0]).toBeCloseTo(frame.bands[0]!, 6)
  })

  it('hangs for peakHoldFrames before falling at all', () => {
    const state = createDecodeState(1)
    const high = decodeVisualizerFrame(loud, resolved, state)!.peaks[0]!
    for (let i = 0; i < 3; i++) {
      expect(decodeVisualizerFrame(silent, resolved, state)!.peaks[0]).toBeCloseTo(high, 6)
    }
    expect(decodeVisualizerFrame(silent, resolved, state)!.peaks[0]).toBeLessThan(high)
  })

  it('accelerates as it falls instead of drooping exponentially', () => {
    const state = createDecodeState(1)
    decodeVisualizerFrame(loud, resolved, state)
    for (let i = 0; i < 3; i++) decodeVisualizerFrame(silent, resolved, state)
    const a = decodeVisualizerFrame(silent, resolved, state)!.peaks[0]!
    const b = decodeVisualizerFrame(silent, resolved, state)!.peaks[0]!
    const c = decodeVisualizerFrame(silent, resolved, state)!.peaks[0]!
    expect(a - b).toBeLessThan(b - c)
  })

  it('never falls below the bar it caps', () => {
    const state = createDecodeState(1)
    decodeVisualizerFrame(loud, resolved, state)
    for (let i = 0; i < 200; i++) {
      const frame = decodeVisualizerFrame(loud, resolved, state)!
      expect(frame.peaks[0]).toBeGreaterThanOrEqual(frame.bands[0]! - 1e-6)
    }
  })

  it('hands out a fresh peaks array per frame', () => {
    const state = createDecodeState(1)
    const first = decodeVisualizerFrame(loud, resolved, state)!
    const snapshot = Array.from(first.peaks)
    for (let i = 0; i < 10; i++) decodeVisualizerFrame(silent, resolved, state)
    expect(Array.from(first.peaks)).toEqual(snapshot)
  })
})
