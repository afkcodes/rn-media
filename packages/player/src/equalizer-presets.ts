/**
 * Tuned 10-band equaliser presets, and the tools to define your own.
 *
 * ## Why 10 bands
 *
 * Ten ISO octave centres — 31 Hz to 16 kHz, doubling each step
 * ({@link EQUALIZER_BANDS}) — is what a hardware graphic EQ has, what every
 * consumer EQ UI shows, and what the classic preset curves were drawn for. It
 * is also *cheap*: each band is one biquad (ffmpeg's `equalizer`), so a full
 * ten-band curve costs a handful of multiply-adds per sample and no FFT.
 *
 * Presets are therefore plain data — ten gains in dB. Serialisable, diffable,
 * storable in a user profile, testable without a device.
 *
 * ## Going finer than ten bands
 *
 * Nothing here caps you at ten. `AudioFilters.equalizer(...)` places a
 * parametric band at any frequency with any Q, so an arbitrary curve is just a
 * longer chain; and `AudioFilters.graphicEqualizer({ gainsDb })` gives the
 * 18-band FFT equaliser (`superequalizer`) when you want fixed fine-grained
 * sliders instead. This module is the well-trodden default, not a ceiling.
 *
 * ## How these curves were built
 *
 * They follow the shapes the industry converged on (the Winamp/foobar lineage
 * that Apple Music, Spotify and every phone EQ inherited). Two deliberate
 * constraints:
 *
 * - **Nothing exceeds ±9 dB.** Consumer EQs that swing ±20 dB sound impressive
 *   for a second and clip for the rest of the track.
 * - **Curves are continuous.** Adjacent bands never jump more than ~3 dB, which
 *   is what stops a graphic EQ sounding phasey and hollow.
 *
 * A boost is still a boost, so apply presets with {@link equalizerPresetChain}
 * rather than bare: it computes the exact pre-amp that brings the summed
 * response back to unity, and appends the limiter that covers the rest — the
 * peaks a phase shift moves in time, which no pre-amp can predict from the
 * magnitude response. Between them nothing a preset does reaches the DAC above
 * full scale.
 *
 * @packageDocumentation
 */

import { PlayerErrorException } from './errors'
import type { AudioFilter } from './filters'
import { AudioFilters } from './filters'

/**
 * The ten ISO octave band centres, in Hz, low to high.
 *
 * Standard graphic-EQ spacing: each centre is double the last, so a one-octave
 * bell on each band tiles the spectrum with no gaps and no overlap pile-up.
 */
export const EQUALIZER_BANDS: readonly number[] = Object.freeze([
  31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
])

/** Number of bands in an {@link EqualizerPreset}. */
export const EQUALIZER_BAND_COUNT = EQUALIZER_BANDS.length

/**
 * A named equaliser curve: one gain in dB per band of {@link EQUALIZER_BANDS}.
 */
export interface EqualizerPreset {
  /** Stable machine identifier — safe to persist. */
  readonly id: string
  /** Human label for a picker. */
  readonly name: string
  /** Exactly {@link EQUALIZER_BAND_COUNT} gains, in dB, low band first. */
  readonly gainsDb: readonly number[]
}

/**
 * Curves, low band first.
 *
 * Band map for reading the numbers: `31 62` sub-bass · `125 250` bass ·
 * `500` low-mid · `1k 2k` mid · `4k` presence · `8k` brilliance · `16k` air.
 */
const CURVES = {
  flat: ['Flat', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],

  // Body without boxiness: guitars live at 80-160 Hz, and the 250-500 Hz cut is
  // what keeps a close-mic'd acoustic from sounding like a cardboard box.
  acoustic: ['Acoustic', [0, 2, 1.5, -1, -1, 0.5, 1.5, 2.5, 2, 1]],

  // Weight, not mud. The peak sits at 62 Hz where kick and bass fundamentals
  // are, and is already rolling off by 250 Hz. 31 Hz gets only half of it:
  // almost nothing musical lives there, few drivers reproduce it, and the
  // excursion it costs is excursion the rest of the octave needs.
  bassBoost: ['Bass Boost', [3, 6, 4, 1, 0, 0, 0, 0, 0, 0]],
  bassReducer: ['Bass Reducer', [-3, -6, -4, -1, 0, 0, 0, 0, 0, 0]],

  // The concert-hall shape: extended at both ends, with a dip at 2 kHz — the
  // exact region where massed strings turn shrill on small systems.
  classical: ['Classical', [1, 2, 1, 0, -0.5, -0.5, -1.5, -0.5, 2, 3]],

  // Sub weight and hat sparkle with the low-mids pulled out from between them,
  // so the four-on-the-floor stays punchy rather than congested.
  dance: ['Dance', [4, 5, 2, -1, -2, -1.5, 0, 2, 4, 3]],

  // Warm and dark on purpose: everything above 2 kHz comes down, which is what
  // makes this the one to fall asleep to.
  deep: ['Deep', [4, 5, 3, 1, 0, -1, -2.5, -3, -2, -1]],

  electronic: ['Electronic', [4, 4, 2, 0, -1, 0, 1, 2, 3, 3]],

  // 808s carry the low end; the 500 Hz dip stops them fighting the vocal, and
  // 2-4 kHz keeps the delivery intelligible over them.
  hipHop: ['Hip-Hop', [5, 6, 3, 0, -1, 0.5, 1.5, 2, 2, 1.5]],

  // Almost flat, deliberately. Upright bass gets its 62 Hz body, brushes and
  // ride get 8 kHz, and nothing else is touched.
  jazz: ['Jazz', [1, 3, 2, 0, -1, -0.5, 0.5, 1.5, 2.5, 2]],

  latin: ['Latin', [2, 4, 2, -1, -1.5, -0.5, 1, 2.5, 3.5, 3]],

  // Equal-loudness compensation (Fletcher-Munson): the ears' sensitivity to
  // bass and air collapses at low levels, so this restores them and dips the
  // mids the ears over-weight. Correct for quiet listening, wrong when loud.
  loudness: ['Loudness', [6, 7, 4, 1, -1, -2, -1.5, 0.5, 3.5, 5]],

  // Intimate and mid-forward, with both extremes softened.
  lounge: ['Lounge', [-3, -2, 0, 1, 1.5, 1, 1.5, 2, 0.5, -1]],

  // Soundboard body at 62-125 Hz, hammer detail at 4-8 kHz, and 250 Hz out of
  // the way so the left hand stays defined instead of thick.
  piano: ['Piano', [0, 2, 1.5, -0.5, 0.5, 1, 1, 2, 2.5, 2]],

  // Modern pop is a vocal record: 1-2 kHz forward, low end tight rather than
  // big, and the top restrained so it survives an hour of listening.
  pop: ['Pop', [-1, 1, 1, 0.5, 1.5, 3, 2.5, 1, 0, -0.5]],

  // Silky rather than bright: deep and warm, with the lift moved to 16 kHz so
  // it reads as air instead of sibilance at 8 kHz.
  rnb: ['R&B', [4, 5, 3, 0, -0.5, 1, 1.5, 1, 2, 2.5]],

  // Not a symmetrical smile. Real guitar records need the 400-600 Hz mud
  // pulled out and 2-4 kHz *pushed*, which is where the bite is — scooping
  // there is the classic amateur mistake that leaves rock sounding hollow.
  rock: ['Rock', [2, 4, 2.5, 0, -2, -1, 1, 2.5, 3, 2]],

  // For phone and laptop drivers, which produce essentially nothing below
  // 150 Hz. Boosting 31-62 Hz there is pure distortion and battery; the weight
  // has to be bought at 125-250 Hz, where the driver can actually move air and
  // the ear fills in the missing fundamental.
  smallSpeakers: ['Small Speakers', [0, 2, 5, 4, 1.5, 1, 2, 1, 2, 0]],

  // Voice uses none of the bottom two octaves, so they only carry handling
  // noise and rumble. Presence at 1-2 kHz buys intelligibility; 8 kHz stays
  // flat because lifting it is how you turn every "s" into a hiss.
  spokenWord: ['Spoken Word', [-8, -6, -3, -1, 1, 3, 3.5, 2.5, 0, -1]],

  trebleBoost: ['Treble Boost', [0, 0, 0, 0, 0, 0.5, 1.5, 3, 4.5, 5]],
  trebleReducer: ['Treble Reducer', [0, 0, 0, 0, 0, -0.5, -1.5, -3, -4.5, -5]],

  // Lift the presence band and pull back the low-mids that mask it — a cut
  // where the competition is does more for a vocal than a boost on the vocal.
  vocalBoost: ['Vocal Boost', [-2, -2, -1, 0, 1.5, 3, 3, 2, 0.5, -0.5]],
} as const satisfies Readonly<
  Record<string, readonly [string, readonly number[]]>
>

/** Identifier of a built-in preset. */
export type EqualizerPresetId = keyof typeof CURVES

/** Every built-in preset, keyed by {@link EqualizerPresetId}. */
export const EQUALIZER_PRESETS: Readonly<
  Record<EqualizerPresetId, EqualizerPreset>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(CURVES).map(([id, [name, gainsDb]]) => [
      id,
      Object.freeze({ id, name, gainsDb: Object.freeze([...gainsDb]) }),
    ])
  ) as Record<EqualizerPresetId, EqualizerPreset>
)

/**
 * The built-in presets in display order: `Flat` first, then alphabetical by
 * name — which is the order a picker should show them in.
 */
export const EQUALIZER_PRESET_LIST: readonly EqualizerPreset[] = Object.freeze([
  EQUALIZER_PRESETS.flat,
  ...Object.values(EQUALIZER_PRESETS)
    .filter((preset) => preset.id !== 'flat')
    .sort((a, b) => a.name.localeCompare(b.name, 'en')),
])

/**
 * Build a **custom** preset from your own band gains.
 *
 * Use this for a user-designed curve (an in-app slider bank, or something
 * restored from storage): it validates the shape up front, so a corrupt saved
 * profile fails at load with a clear message instead of at playback with mpv's.
 *
 * @param id - Stable identifier. Anything you like; it never reaches mpv.
 * @param name - Human label.
 * @param gainsDb - Exactly {@link EQUALIZER_BAND_COUNT} gains in dB, low band
 * first. Each must be finite and within ±900 dB (ffmpeg's biquad range); in
 * practice keep them inside ±12.
 * @throws {@link PlayerErrorException} with code `invalid-state`.
 *
 * @example
 * ```ts
 * const mine = defineEqualizerPreset('mine', 'My Curve', sliderValues)
 * player.setAudioFilters(equalizerPresetChain(mine))
 * ```
 */
export function defineEqualizerPreset(
  id: string,
  name: string,
  gainsDb: readonly number[]
): EqualizerPreset {
  const invalid = (message: string): never => {
    throw new PlayerErrorException({
      code: 'invalid-state',
      message: `defineEqualizerPreset: ${message}`,
      retryable: false,
    })
  }
  if (typeof id !== 'string' || id === '') {
    invalid('id must be a non-empty string.')
  }
  if (typeof name !== 'string' || name === '') {
    invalid('name must be a non-empty string.')
  }
  if (!Array.isArray(gainsDb) || gainsDb.length !== EQUALIZER_BAND_COUNT) {
    invalid(
      `gainsDb must have exactly ${String(EQUALIZER_BAND_COUNT)} entries (one per band in EQUALIZER_BANDS), got ${Array.isArray(gainsDb) ? String(gainsDb.length) : typeof gainsDb}.`
    )
  }
  // Delegate the numeric checks to the one place that owns ffmpeg's ranges, so
  // validation can never drift between here and the filter factory.
  gainsDb.forEach((gain, index) => {
    AudioFilters.equalizer({
      frequency: EQUALIZER_BANDS[index] as number,
      gain,
    })
  })
  return Object.freeze({ id, name, gainsDb: Object.freeze([...gainsDb]) })
}

/**
 * Magnitude, in dB, of one RBJ peaking band at a given frequency ratio.
 *
 * The analogue prototype ffmpeg's `equalizer` is derived from
 * (`libavfilter/af_biquads.c`, Robert Bristow-Johnson's cookbook):
 *
 * ```
 *          s² + s·(A/Q) + 1
 *   H(s) = ────────────────,   A = 10^(G/40),  s = j·(f/f0)
 *          s² + s/(A·Q) + 1
 * ```
 *
 * @param gainDb - The band's gain.
 * @param q - The band's Q.
 * @param ratio - `f / f0`.
 */
function bandMagnitudeDb(gainDb: number, q: number, ratio: number): number {
  if (gainDb === 0) return 0
  const a = 10 ** (gainDb / 40)
  const squared = ratio * ratio
  const base = (1 - squared) ** 2
  const numerator = base + ((a * ratio) / q) ** 2
  const denominator = base + (ratio / (a * q)) ** 2
  return 10 * Math.log10(numerator / denominator)
}

/** Q of a peaking band of the given bandwidth in octaves (RBJ's relation). */
function qForOctaves(octaves: number): number {
  const span = 2 ** octaves
  return Math.sqrt(span) / (span - 1)
}

/**
 * The true peak of a curve's combined magnitude response, in dB.
 *
 * **This is the part a naive graphic EQ gets wrong.** The bands are one octave
 * apart and one octave wide, so neighbours overlap and their gains *add*: five
 * adjacent sliders at +6 dB do not produce a +6 dB shelf, they produce roughly
 * +9 dB in the middle. Taking the largest slider as the headroom figure would
 * therefore under-attenuate by several dB and clip exactly on the presets that
 * boost hardest.
 *
 * So the response is evaluated properly — every band summed at 1/6-octave steps
 * across 20 Hz to 20 kHz — and the largest value is what
 * {@link equalizerPresetChain} attenuates by. Same thing a mastering EQ's
 * auto-gain does.
 *
 * @param gainsDb - One gain per band of {@link EQUALIZER_BANDS}.
 * @param bandwidthOctaves - Bell width used for every band.
 * @returns The peak gain in dB (may be negative for a cut-only curve).
 */
export function peakResponseDb(
  gainsDb: readonly number[],
  bandwidthOctaves = 1
): number {
  const q = qForOctaves(bandwidthOctaves)
  const step = 2 ** (1 / 6)
  let peak = Number.NEGATIVE_INFINITY
  for (let frequency = 20; frequency <= 20000; frequency *= step) {
    let total = 0
    for (const [index, gainDb] of gainsDb.entries()) {
      const centre = EQUALIZER_BANDS[index] as number
      total += bandMagnitudeDb(gainDb, q, frequency / centre)
    }
    if (total > peak) peak = total
  }
  return peak
}

/**
 * mpv filter label of the pre-amp entry of an **editable** chain
 * ({@link EqualizerPresetChainOptions.editable}).
 */
export const EQUALIZER_PREAMP_LABEL = 'rnmedia_eq_preamp'

/**
 * mpv filter label of the tail limiter of an **editable** chain
 * ({@link EqualizerPresetChainOptions.editable}).
 */
export const EQUALIZER_LIMITER_LABEL = 'rnmedia_eq_limiter'

/**
 * mpv filter label of one band of an **editable** chain
 * ({@link EqualizerPresetChainOptions.editable}) — `rnmedia_eq_1000` for the
 * 1 kHz band.
 *
 * The label is how `Player.setAudioFilterParam` addresses a single band while
 * it runs. It is derived from the band's centre frequency rather than its
 * index because that is what makes a `getAudioFilters()` read-back legible on
 * a device; the band set is fixed and frozen, so the two are equivalent.
 *
 * @param index - Position in {@link EQUALIZER_BANDS}.
 * @throws {@link PlayerErrorException} with code `invalid-state` when `index`
 * is not a band.
 */
export function equalizerBandLabel(index: number): string {
  const frequency = EQUALIZER_BANDS[index]
  if (frequency === undefined) {
    throw new PlayerErrorException({
      code: 'invalid-state',
      message: `equalizerBandLabel: index must be an integer in 0…${String(EQUALIZER_BAND_COUNT - 1)}, got ${String(index)}.`,
      retryable: false,
    })
  }
  return `rnmedia_eq_${String(frequency)}`
}

/** Options for {@link equalizerPresetChain}. */
export interface EqualizerPresetChainOptions {
  /**
   * Extra gain in dB applied on top of the automatic headroom pre-amp.
   *
   * The automatic part is neither optional nor configurable: the chain always
   * attenuates by the preset's largest positive band gain, which is exactly
   * what stops a boost from clipping. This is for taste on top of that.
   * Defaults to `0`.
   */
  readonly preampDb?: number
  /**
   * Append a brickwall limiter (`alimiter`) as the last EQ stage. Defaults to
   * `true`, and **is on for every curve that is not flat** — including a curve
   * that only cuts, and including a single band at +0.1 dB.
   *
   * That sounds like overkill and is not, because the pre-amp and the limiter
   * bound different things:
   *
   * - The pre-amp is a **frequency-domain** bound. {@link peakResponseDb} is
   *   `max |H(f)|`, so after attenuation no steady sine can leave the chain
   *   above unity.
   * - Clipping is a **time-domain** event, and the tight bound on a filter's
   *   sample-peak gain is the L1 norm of its impulse response, which is
   *   strictly larger. Measured over these curves at 48 kHz: `Rock` after its
   *   −4.8 dB pre-amp still has +4.9 dB of worst-case peak gain, and
   *   `Bass Reducer` — pure cuts, so **no pre-amp at all**, by construction —
   *   has +5.7 dB. Even one band at +0.1 dB has +0.03 dB. A phase shift moves
   *   energy in time, and modern masters arrive at 0 dBFS with nowhere to put
   *   it.
   *
   * So the honest predicate for "this curve cannot clip" is `‖h‖₁ ≤ 1`, and
   * that is false for every non-flat curve — which is exactly the condition
   * this option already keys on. A flat curve compiles to no chain, so it gets
   * no limiter either.
   *
   * The limiter is not a tone control: below full scale it is sample-identical
   * (see {@link AudioFilters.limiter}, which also documents the one thing it
   * *does* cost — 5 ms of uncompensated look-ahead). Turn it off only if
   * something later in your chain already limits, or if you are handing the
   * output somewhere with real headroom.
   */
  readonly limiter?: boolean
  /**
   * Bell width per band, in octaves. Defaults to `1` — one octave, which is the
   * spacing of {@link EQUALIZER_BANDS}, so the bells tile the spectrum evenly.
   * Narrower is more surgical and more audible as "EQ"; wider is smoother.
   */
  readonly bandwidthOctaves?: number
  /**
   * Compile a chain whose **gains can be changed while it plays**. Defaults to
   * `false`. This is what a slider bank wants; `useEqualizer` turns it on.
   *
   * Rewriting `af` is how a chain is normally changed, and it is the wrong tool
   * for a drag: mpv destroys and recreates every entry whose arguments differ
   * (`filters/f_output_chain.c:554-561`), so dozens of writes a second means
   * dozens of filter rebuilds a second. `Player.setAudioFilterParam` avoids
   * that by pushing one number into the running filter — but it can only do so
   * when the entry carries a **label**, and only when the rest of the chain has
   * not moved.
   *
   * So this option changes two things, both in service of that:
   *
   * - **Every entry is labelled** — {@link EQUALIZER_PREAMP_LABEL},
   *   {@link equalizerBandLabel} per band, {@link EQUALIZER_LIMITER_LABEL}.
   * - **The shape stops depending on the gains.** All ten bands are emitted
   *   even at 0 dB, and the pre-amp is emitted even at 0 dB, so moving a band
   *   through zero does not add or remove an entry. (A band at 0 dB is an exact
   *   identity biquad — `A = 1` makes the RBJ numerator and denominator equal —
   *   so the ten always-present bands change nothing but the CPU bill, which is
   *   ten biquads.)
   *
   * What does **not** change: a completely flat curve still compiles to an
   * empty chain. An equaliser nobody has touched costs nothing either way, and
   * the flat ↔ touched transition is the one rebuild a drag can still cause.
   */
  readonly editable?: boolean
}

/**
 * Turn a preset into a **safe, ready-to-apply filter chain**.
 *
 * The chain is:
 *
 * 1. `volume` — attenuated by the preset's largest positive gain (plus
 *    {@link EqualizerPresetChainOptions.preampDb}), so the loudest band comes
 *    back to unity rather than above it. A preset that only cuts gets no
 *    pre-amp, because it needs none.
 * 2. One `equalizer` biquad per **non-zero** band. Bands sitting at 0 dB are
 *    omitted entirely — they would be arithmetic no-ops that still cost a
 *    filter instance, so `Bass Boost` compiles to five bands, not ten.
 * 3. `alimiter` — the safety net for the sample peaks the pre-amp's
 *    frequency-domain bound cannot catch. **On for every non-flat curve**,
 *    cut-only curves included; opt out with
 *    {@link EqualizerPresetChainOptions.limiter}, which explains why the
 *    default is what it is and what it costs (5 ms of look-ahead; below full
 *    scale it changes no sample).
 *
 * A flat preset compiles to an empty chain: no filters, no cost, no pointless
 * trip through the filter graph.
 *
 * With {@link EqualizerPresetChainOptions.editable} the same three stages come
 * out **labelled**, and with all ten bands present, so a slider can move one of
 * them through `Player.setAudioFilterParam` without the chain being rebuilt.
 *
 * @param preset - A built-in from {@link EQUALIZER_PRESETS}, a custom one from
 * {@link defineEqualizerPreset}, or any `{ gainsDb }` you have to hand.
 * @param options - See {@link EqualizerPresetChainOptions}.
 * @returns A chain for `Player.setAudioFilters`.
 *
 * @example
 * ```ts
 * import { EQUALIZER_PRESETS, equalizerPresetChain } from '@rn-media/player'
 *
 * player.setAudioFilters(equalizerPresetChain(EQUALIZER_PRESETS.rock))
 * player.setAudioFilters(equalizerPresetChain(EQUALIZER_PRESETS.flat)) // clears
 * ```
 */
export function equalizerPresetChain(
  preset: Pick<EqualizerPreset, 'gainsDb'>,
  options: EqualizerPresetChainOptions = {}
): readonly AudioFilter[] {
  const gainsDb = preset.gainsDb
  if (!Array.isArray(gainsDb) || gainsDb.length !== EQUALIZER_BAND_COUNT) {
    throw new PlayerErrorException({
      code: 'invalid-state',
      message: `equalizerPresetChain: gainsDb must have exactly ${String(EQUALIZER_BAND_COUNT)} entries, got ${Array.isArray(gainsDb) ? String(gainsDb.length) : typeof gainsDb}.`,
      retryable: false,
    })
  }

  const preampDb = options.preampDb ?? 0
  const bandwidthOctaves = options.bandwidthOctaves ?? 1
  const bands = gainsDb
    .map((gain, index) => ({
      gain,
      frequency: EQUALIZER_BANDS[index] as number,
    }))
    .filter((band) => band.gain !== 0)

  if (bands.length === 0 && preampDb === 0) return []

  // Headroom comes from the *summed* response, not the largest slider — see
  // peakResponseDb for why those are not the same number. Rounded to 1 dp
  // because the value is cosmetic in the compiled string and a raw float would
  // make the `af` read-back unreadable.
  const headroomDb = -Math.max(0, peakResponseDb(gainsDb, bandwidthOctaves))
  const totalPreampDb = Number((headroomDb + preampDb).toFixed(1))

  const editable = options.editable === true
  const chain: AudioFilter[] = []
  if (totalPreampDb !== 0 || editable) {
    const volume = AudioFilters.volume({ gainDb: totalPreampDb })
    chain.push(editable ? { ...volume, label: EQUALIZER_PREAMP_LABEL } : volume)
  }
  // Editable chains emit every band, so that moving one through 0 dB is a
  // different *value*, not a different chain. See `editable`.
  const emitted = editable
    ? gainsDb.map((gain, index) => ({
        gain,
        frequency: EQUALIZER_BANDS[index] as number,
      }))
    : bands
  for (const [index, band] of emitted.entries()) {
    const entry = AudioFilters.equalizer({
      frequency: band.frequency,
      widthType: 'o',
      width: bandwidthOctaves,
      gain: band.gain,
    })
    chain.push(
      editable ? { ...entry, label: equalizerBandLabel(index) } : entry
    )
  }
  if ((editable || bands.length > 0) && options.limiter !== false) {
    const limiter = AudioFilters.limiter()
    chain.push(
      editable ? { ...limiter, label: EQUALIZER_LIMITER_LABEL } : limiter
    )
  }
  return chain
}
