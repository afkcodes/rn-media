/**
 * Typed audio filter chains over mpv's `af` property.
 *
 * ## What this is
 *
 * mpv's `af` option is an ordered list of audio filters. Filter *names* it does
 * not know itself are looked up in libavfilter
 * (`filters/user_filters.c: check_af_lavfi` → `avfilter_get_by_name`), so every
 * ffmpeg audio filter compiled into our libmpv is reachable by name. This
 * module is the typed front end for that: {@link AudioFilters} factories build
 * validated {@link AudioFilter} descriptors, and {@link compileAudioFilters}
 * turns a list of them into the exact string mpv's own serialiser would print.
 *
 * ## Why filter-per-entry instead of one `lavfi=[…]` graph
 *
 * Both work. We emit one mpv entry per filter (`equalizer=f=100:g=6,crossfeed`)
 * rather than a single `lavfi=[equalizer=f=100:g=6,crossfeed]` graph because in
 * that form mpv hands each key/value straight to `av_opt_set`
 * (`f_lavfi.c: mp_set_avopts_pos`, the `direct_filter` path) — there is no
 * libavfilter graph-description parser in the way, so no second layer of
 * escaping rules (`[`, `]`, `\`, quoted commas) to get wrong. mpv's own
 * sub-option escaping is the only thing to satisfy, and it is exactly one rule
 * (see {@link escapeAfParam}). It also means mpv names the offending filter
 * when one fails, and that these entries compose with mpv's builtins (`format`,
 * `scaletempo`) in one list.
 *
 * ## Interaction with playback speed
 *
 * None — deliberately. mpv appends its speed handling *after* the user chain:
 * `af` entries become `p->user_filters`, while the `aspeed` auto-filter that
 * inserts `scaletempo2` lives in `p->post_filters` (mpv 0.41.0
 * `filters/f_output_chain.c:30-34`, `filters/f_auto_filters.c:462-513` — the
 * `MP_VERBOSE(f, "adding scaletempo2")` branch is at `:490`). mpv offers the
 * speed command to user filters first and only mpv's own `scaletempo`/
 * `scaletempo2`/`rubberband` ever accept it, so a lavfi filter never swallows
 * it. EQ therefore applies at the source rate and pitch correction happens
 * downstream, whatever `player.setRate()` is doing.
 *
 * ## Interaction with ReplayGain
 *
 * Also none. ReplayGain is applied in mpv's volume domain (the `replaygain*`
 * options feed `ao` gain), not in the filter chain, so {@link Player.setReplayGain}
 * and filters compose freely. The one thing to be aware of is *headroom*: a
 * ReplayGain boost and an EQ boost add up and can clip. Put
 * {@link AudioFilters.volume} with a negative gain at the head of the chain, or
 * {@link AudioFilters.limiter} at the tail.
 *
 * @packageDocumentation
 */

import { PlayerErrorException } from './errors'
import { escapeSubparam } from './subparam'

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * One `key=value` pair of a filter's sub-options, in the order it will be
 * written. A tuple rather than an object because the compiled string is part of
 * this module's contract and must be deterministic.
 */
export type AudioFilterOption = readonly [key: string, value: string]

/**
 * One entry of an mpv audio filter chain.
 *
 * Build these with the {@link AudioFilters} factories, which validate against
 * the underlying filter's documented ranges. {@link AudioFilters.custom} makes
 * arbitrary (including future) libavfilter filters reachable without a release.
 */
export interface AudioFilter {
  /**
   * The filter name as mpv/libavfilter knows it — e.g. `equalizer`,
   * `superequalizer`, or an mpv builtin such as `format`.
   */
  readonly name: string
  /** Sub-options, in emission order. */
  readonly options: readonly AudioFilterOption[]
  /**
   * Optional mpv filter label (`@name:filter=…`). Labels let mpv's `af add` /
   * `af toggle` commands address a single entry; this library never needs one,
   * but the escape hatch stays open.
   */
  readonly label?: string
  /**
   * `false` emits mpv's `!` disable marker, keeping the entry in the chain but
   * bypassed. Defaults to `true`.
   */
  readonly enabled?: boolean
}

// ---------------------------------------------------------------------------
// mpv sub-option escaping
// ---------------------------------------------------------------------------

/**
 * Escape one filter sub-option key or value the way mpv itself does.
 *
 * mpv's serialiser (`options/m_option.c: append_param`) writes a parameter
 * verbatim when every character is in mpv's `NAMECH` alphabet, and otherwise as
 * `%<bytecount>%<string>`. Its parser accepts exactly that form
 * (`read_subparam`, the `bstr_eatstart0(&p, "%")` branch), so applying the same
 * rule here makes the compiled string byte-identical to what reading the `af`
 * property back returns — which is what the round-trip test asserts.
 *
 * The rule itself lives in `subparam.ts` because `loadfile`'s per-file option
 * list is read back by the *same* mpv function and needs the identical
 * treatment; this name is kept as the filter-facing spelling of it.
 *
 * @param value - Raw key or value.
 * @returns The escaped form, safe to place in an `af` string.
 */
export function escapeAfParam(value: string): string {
  return escapeSubparam(value)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** mpv parses a filter name with `bstrspn(pstr, NAMECH)` — same alphabet. */
const FILTER_NAME = /^[a-zA-Z0-9_-]+$/

/**
 * Whether a string is spellable as a filter name, label or option key.
 *
 * Package-internal: the one place that owns mpv's `NAMECH` alphabet, so a
 * caller that has to check a name before building a filter (`af-command`'s
 * label and parameter) cannot drift from what {@link assertValidAudioFilters}
 * enforces.
 */
export function isAudioFilterName(value: string): boolean {
  return typeof value === 'string' && FILTER_NAME.test(value)
}

function invalid(message: string): never {
  throw new PlayerErrorException({
    code: 'invalid-state',
    message,
    retryable: false,
  })
}

/**
 * Format a number for an mpv/ffmpeg sub-option value.
 *
 * Rejects non-finite values (`av_opt_set` would parse `NaN`/`Infinity`
 * inconsistently) and exponent notation, which only appears far outside every
 * range this module accepts.
 */
function num(value: number, what: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(`${what} must be a finite number, got ${String(value)}.`)
  }
  const text = String(value)
  if (text.includes('e') || text.includes('E')) {
    invalid(`${what} is out of the representable range (${text}).`)
  }
  return text
}

/** Range-check a number and format it. */
function range(value: number, min: number, max: number, what: string): string {
  const text = num(value, what)
  if (value < min || value > max) {
    invalid(`${what} must be between ${min} and ${max}, got ${text}.`)
  }
  return text
}

/**
 * Validate a whole chain before it is written.
 *
 * Catches the things mpv would reject with a generic
 * "error accessing property" — names that cannot be parsed, empty option keys,
 * values carrying an unescapable byte. Range checks live in the factories,
 * where the filter's documented bounds are known.
 *
 * @param filters - The chain to check.
 * @throws {@link PlayerErrorException} with code `invalid-state`.
 */
export function assertValidAudioFilters(filters: readonly AudioFilter[]): void {
  if (!Array.isArray(filters)) {
    invalid('Audio filters must be an array.')
  }
  for (const [index, filter] of filters.entries()) {
    const where = `filters[${index}]`
    if (filter === null || typeof filter !== 'object') {
      invalid(`${where} must be an AudioFilter object.`)
    }
    if (!FILTER_NAME.test(filter.name)) {
      invalid(
        `${where}.name must match ${String(FILTER_NAME)} (mpv's filter-name alphabet), got ${JSON.stringify(filter.name)}.`
      )
    }
    if (filter.label !== undefined && !FILTER_NAME.test(filter.label)) {
      invalid(
        `${where}.label must match ${String(FILTER_NAME)}, got ${JSON.stringify(filter.label)}.`
      )
    }
    if (!Array.isArray(filter.options)) {
      invalid(`${where}.options must be an array of [key, value] pairs.`)
    }
    for (const [optionIndex, option] of filter.options.entries()) {
      const optionWhere = `${where}.options[${optionIndex}]`
      if (!Array.isArray(option) || option.length !== 2) {
        invalid(`${optionWhere} must be a [key, value] pair.`)
      }
      const [key, value] = option
      if (typeof key !== 'string' || !FILTER_NAME.test(key)) {
        invalid(
          `${optionWhere} key must match ${String(FILTER_NAME)}, got ${JSON.stringify(key)}.`
        )
      }
      if (typeof value !== 'string') {
        invalid(`${optionWhere} value must be a string, got ${typeof value}.`)
      }
      if (value.includes('\0')) {
        invalid(`${optionWhere} value must not contain a NUL byte.`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/**
 * Compile a filter chain into the string mpv's `af` property takes.
 *
 * The output format is mpv's own, reproduced from
 * `options/m_option.c: print_obj_settings_list`:
 * `[@label:][!]name[=key=value[:key=value…]]`, entries joined with `,`, keys
 * and values escaped by {@link escapeAfParam}. Reading `af` back from mpv after
 * setting it returns this string verbatim.
 *
 * @param filters - The chain. An empty list compiles to `''`, which is how mpv
 * spells "no filters".
 * @returns The `af` property value.
 * @throws {@link PlayerErrorException} with code `invalid-state` if the chain
 * is malformed (see {@link assertValidAudioFilters}).
 */
export function compileAudioFilters(filters: readonly AudioFilter[]): string {
  assertValidAudioFilters(filters)
  return filters
    .map((filter) => {
      const label =
        filter.label !== undefined && filter.label !== ''
          ? `@${filter.label}:`
          : ''
      const disabled = filter.enabled === false ? '!' : ''
      const options =
        filter.options.length === 0
          ? ''
          : `=${filter.options
              .map(
                ([key, value]) =>
                  `${escapeAfParam(key)}=${escapeAfParam(value)}`
              )
              .join(':')}`
      return `${label}${disabled}${filter.name}${options}`
    })
    .join(',')
}

// ---------------------------------------------------------------------------
// Runtime (in-place) parameters
// ---------------------------------------------------------------------------

/**
 * The sub-options that can be changed on a **running** filter, per filter name.
 *
 * Writing the `af` property replaces the chain: mpv keeps only the entries whose
 * arguments are byte-identical (`filters/f_output_chain.c:554-561`,
 * `m_obj_settings_equal`) and destroys and recreates every entry that changed,
 * dropping whatever that entry had buffered. That is correct for a settings
 * change and ruinous for a slider — see {@link Player.setAudioFilterParam},
 * which sends mpv's `af-command` instead and mutates the live filter.
 *
 * An entry belongs in this table only when the underlying libavfilter filter
 * both implements `process_command` **and** flags the option
 * `AV_OPT_FLAG_RUNTIME_PARAM`; anything else is refused at runtime by
 * `ff_filter_process_command` (`libavfilter/avfilter.c:905-916` — it looks the
 * option up with that flag and returns `ENOSYS` when it is absent). Both entries
 * below are read off FFmpeg n8.1.2, the tree our engine binaries are built from:
 *
 * - `equalizer` — `libavfilter/af_biquads.c:1522-1533`. `frequency`/`f`,
 *   `width_type`/`t`, `width`/`w` and `gain`/`g` all carry `FLAGS`, which is
 *   `…|AV_OPT_FLAG_RUNTIME_PARAM` (`:1444`), and the filter's `process_command`
 *   (`:1410-1420`) recomputes the biquad coefficients with
 *   `config_filter(outlink, 0)` — **`reset = 0`**, so the filter's two-sample
 *   state survives (`:1028-1031` silences the state only when `reset` is set).
 *   A gain change is therefore a coefficient update on a running filter, not a
 *   restart.
 * - `volume` — `libavfilter/af_volume.c:66-68` (`A|F|T`, `T` being
 *   `AV_OPT_FLAG_RUNTIME_PARAM`, `:64`) and its own `process_command`
 *   (`:307-321`), which re-parses the gain expression and, in the default
 *   `eval=once` mode (`:74-75`), applies it immediately.
 *
 * Short option names are used because that is what {@link AudioFilters} emits;
 * libavfilter accepts either spelling.
 */
export const AUDIO_FILTER_RUNTIME_PARAMS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  equalizer: Object.freeze(['f', 't', 'w', 'g']),
  volume: Object.freeze(['volume']),
})

/** One `af-command`: which labelled entry, which sub-option, its new value. */
export interface AudioFilterParamChange {
  /**
   * The entry to command, as it should end up — the whole filter rather than
   * just its label, because `af-command` needs both halves of its address:
   * the label to find the mpv entry, and the filter name to find the
   * libavfilter filter inside it (see {@link Player.setAudioFilterParam}).
   */
  readonly filter: AudioFilter
  /** The sub-option key, as {@link AudioFilters} spells it (`g`, `volume`). */
  readonly param: string
  /** The new value, already in the filter's own grammar (`-4.5`, `-6dB`). */
  readonly value: string
}

/**
 * Work out whether one chain can be turned into another **in place**.
 *
 * The question a slider asks sixty times a second: *is this change a new filter
 * graph, or the same graph with a different number in it?* Only the second can
 * be applied with {@link Player.setAudioFilterParam}; the first needs the whole
 * `af` property rewritten, which recreates the changed entries.
 *
 * Two chains are the same graph when they have the same entries, in the same
 * order, with the same names, labels, enabled flags and sub-option keys — and
 * every differing *value* sits on a labelled entry and is listed in
 * {@link AUDIO_FILTER_RUNTIME_PARAMS} for that filter. A label is required
 * because `af-command` addresses entries by label
 * (`player/command.c:6716-6738` → `filters/f_output_chain.c:445-465`).
 *
 * @param from - The chain mpv is currently running.
 * @param to - The chain wanted.
 * @returns The commands that get from one to the other — `[]` when they are
 * identical — or `undefined` when the chain has to be rewritten instead.
 *
 * @example
 * ```ts
 * const changes = diffAudioFilterParams(current, next)
 * if (changes === undefined) {
 *   player.setAudioFilters(next)
 * } else {
 *   for (const change of changes) {
 *     await player.setAudioFilterParam(change.filter, change.param, change.value)
 *   }
 * }
 * ```
 */
export function diffAudioFilterParams(
  from: readonly AudioFilter[],
  to: readonly AudioFilter[]
): readonly AudioFilterParamChange[] | undefined {
  if (from.length !== to.length) return undefined
  const changes: AudioFilterParamChange[] = []
  for (const [index, before] of from.entries()) {
    const after = to[index] as AudioFilter
    if (
      before.name !== after.name ||
      before.label !== after.label ||
      (before.enabled === false) !== (after.enabled === false) ||
      before.options.length !== after.options.length
    ) {
      return undefined
    }
    const runtime = AUDIO_FILTER_RUNTIME_PARAMS[after.name] ?? []
    for (const [optionIndex, [key, value]] of before.options.entries()) {
      const [nextKey, nextValue] = after.options[
        optionIndex
      ] as AudioFilterOption
      if (key !== nextKey) return undefined
      if (value === nextValue) continue
      // A value can only be pushed into a running filter when mpv can address
      // the entry (label) and libavfilter accepts the option at runtime.
      if (
        after.label === undefined ||
        after.label === '' ||
        !runtime.includes(key)
      ) {
        return undefined
      }
      changes.push({ filter: after, param: key, value: nextValue })
    }
  }
  return changes
}

// ---------------------------------------------------------------------------
// Shared option shapes
// ---------------------------------------------------------------------------

/**
 * How a biquad filter's `width` is interpreted (ffmpeg's `width_type`/`t`).
 *
 * From `af_biquads.c:1480-1487` (`WIDTH_TYPE_OPTION`) — `h` Hz, `q` Q-factor,
 * `o` octave, `s` slope, `k` kHz.
 */
export type BiquadWidthType = 'h' | 'q' | 'o' | 's' | 'k'

const WIDTH_TYPES: readonly BiquadWidthType[] = ['h', 'q', 'o', 's', 'k']

function widthType(value: BiquadWidthType | undefined, what: string): string {
  if (value === undefined) return 'q'
  if (!WIDTH_TYPES.includes(value)) {
    invalid(
      `${what} must be one of ${WIDTH_TYPES.join(' | ')}, got ${JSON.stringify(value)}.`
    )
  }
  return value
}

/**
 * Options common to the `equalizer`/`bass`/`treble` biquad filters.
 *
 * All three share one option table shape (`af_biquads.c:1522-1533`,
 * `:1539-1552`, `:1565-1578`): `f` 0–999999 Hz, `w` 0–99999 (`WIDTH_OPTION`,
 * `:1476-1478`), `g` −900…+900 dB.
 */
interface BiquadShapingOptions {
  /** Centre frequency in Hz (`f`), 0–999999. */
  readonly frequency?: number
  /**
   * Band width, 0–99999, interpreted per {@link widthType} (`w`). ffmpeg
   * defaults to 1.0 for `equalizer` and 0.5 for the shelves.
   */
  readonly width?: number
  /** How `width` is read (`t`). Defaults to `'q'` (Q-factor), as ffmpeg does. */
  readonly widthType?: BiquadWidthType
  /** Gain in dB (`g`), −900…+900. */
  readonly gain: number
}

function bool(value: boolean, what: string): string {
  if (typeof value !== 'boolean') {
    invalid(`${what} must be a boolean, got ${typeof value}.`)
  }
  return value ? '1' : '0'
}

/** Push `[key, format(value)]` only when the caller supplied the value. */
function optional(
  options: AudioFilterOption[],
  key: string,
  value: number | undefined,
  min: number,
  max: number,
  what: string
): void {
  if (value === undefined) return
  options.push([key, range(value, min, max, what)])
}

// ---------------------------------------------------------------------------
// Filter factories
// ---------------------------------------------------------------------------

/** {@link AudioFilters.equalizer} options. */
export interface EqualizerOptions extends BiquadShapingOptions {
  /**
   * Centre frequency in Hz. Required — the ffmpeg default of `0`
   * (`af_biquads.c:1523`) is useless.
   */
  readonly frequency: number
}

/** {@link AudioFilters.bass} / {@link AudioFilters.treble} options. */
export interface ShelfOptions extends BiquadShapingOptions {
  /**
   * Shelf slope: 1 or 2 poles (`p`). Defaults to ffmpeg's 2
   * (`af_biquads.c:1546-1547`, `:1572-1573`).
   */
  readonly poles?: 1 | 2
}

/**
 * {@link AudioFilters.lowpass} / {@link AudioFilters.highpass} options.
 *
 * `af_biquads.c:1629-1640` / `:1646-1657`. Same bounds as the shaping filters;
 * ffmpeg's default width for both is 0.707 (Butterworth Q).
 */
export interface PassOptions {
  /** Corner (−3 dB) frequency in Hz (`f`), 0–999999. */
  readonly frequency: number
  /** Band width, 0–99999, interpreted per {@link widthType} (`w`). */
  readonly width?: number
  /** How `width` is read (`t`). Defaults to `'q'`, as ffmpeg does. */
  readonly widthType?: BiquadWidthType
  /** 1 or 2 poles (`p`). Defaults to ffmpeg's 2. */
  readonly poles?: 1 | 2
}

/** {@link AudioFilters.graphicEqualizer} options. */
export interface GraphicEqualizerOptions {
  /**
   * Exactly 18 band gains in **dB**, ordered to match
   * {@link GRAPHIC_EQUALIZER_BANDS}.
   *
   * ffmpeg's `superequalizer` takes *linear* gains in `[0, 20]` with `1` as
   * unity (`af_superequalizer.c:330-347`, one `AV_OPT_TYPE_FLOAT` per band;
   * the value lands in `param[i].gain` and is used as an amplitude multiplier
   * when the FIR is designed). This API takes dB because that is what an EQ UI
   * has, and converts with `10 ** (dB / 20)` — so **the `+26.02 dB` ceiling is
   * ours**, the dB spelling of ffmpeg's linear 20, and anything above it is
   * rejected rather than silently clamped.
   */
  readonly gainsDb: readonly number[]
}

/** Centre frequencies of `superequalizer`'s 18 bands, in Hz. */
export const GRAPHIC_EQUALIZER_BANDS: readonly number[] = [
  65, 92, 131, 185, 262, 370, 523, 740, 1047, 1480, 2093, 2960, 4186, 5920,
  8372, 11840, 16744, 20000,
]

/**
 * ffmpeg caps each `superequalizer` band's linear gain at 20 (≈ +26.02 dB)
 * — `af_superequalizer.c:330-347`, the max column of every `<n>b` option.
 */
const GRAPHIC_EQUALIZER_MAX_LINEAR = 20

/**
 * {@link AudioFilters.crossfeed} options.
 *
 * `af_crossfeed.c:356-363`. `block_size` (0–32768) is not exposed.
 */
export interface CrossfeedOptions {
  /** Crossfeed strength, 0–1 (`strength`). ffmpeg default 0.2. */
  readonly strength?: number
  /** Soundstage wideness, 0–1 (`range`). ffmpeg default 0.5. */
  readonly range?: number
  /** Curve slope, 0.01–1 (`slope`). ffmpeg default 0.5. */
  readonly slope?: number
  /** Input level, 0–1 (`level_in`). ffmpeg default 0.9. */
  readonly levelIn?: number
  /** Output level, 0–1 (`level_out`). ffmpeg default 1. */
  readonly levelOut?: number
}

/**
 * {@link AudioFilters.compressor} options (ffmpeg `acompressor`).
 *
 * `af_sidechaincompress.c:75-95` — one table shared with
 * `sidechaincompress`, which is why `level_sc` is in it and not here (this
 * filter has no sidechain input).
 */
export interface CompressorOptions {
  /** Input gain, 0.015625–64 (`level_in`). */
  readonly levelIn?: number
  /** Threshold as a linear amplitude, 0.000976563–1 (`threshold`). */
  readonly threshold?: number
  /** Compression ratio, 1–20 (`ratio`). */
  readonly ratio?: number
  /** Attack in ms, 0.01–2000 (`attack`). */
  readonly attack?: number
  /** Release in ms, 0.01–9000 (`release`). */
  readonly release?: number
  /** Make-up gain, 1–64 (`makeup`). */
  readonly makeup?: number
  /** Knee, 1–8 (`knee`). */
  readonly knee?: number
  /** Downward (default) or upward compression (`mode`). */
  readonly mode?: 'downward' | 'upward'
  /** Channel linking (`link`). */
  readonly link?: 'average' | 'maximum'
  /** Level detection (`detection`). */
  readonly detection?: 'peak' | 'rms'
  /** Dry/wet mix, 0–1 (`mix`). */
  readonly mix?: number
}

/**
 * {@link AudioFilters.limiter} options (ffmpeg `alimiter`).
 *
 * `af_alimiter.c:81-92`. `latency` (delay compensation, default off) is not
 * exposed.
 */
export interface LimiterOptions {
  /** Input level, 0.015625–64 (`level_in`). */
  readonly levelIn?: number
  /** Output level, 0.015625–64 (`level_out`). */
  readonly levelOut?: number
  /** Ceiling as a linear amplitude, 0.0625–1 (`limit`). */
  readonly limit?: number
  /** Attack in ms, 0.1–80 (`attack`). */
  readonly attack?: number
  /** Release in ms, 1–8000 (`release`). */
  readonly release?: number
  /** Auto-release (`asc`). */
  readonly autoRelease?: boolean
  /** Auto-release strength, 0–1 (`asc_level`). */
  readonly autoReleaseLevel?: number
  /**
   * Make-up gain back to full scale (`level`). ffmpeg default `true`.
   *
   * **This is what makes `limit` a ceiling you cannot hear.** The name suggests
   * automatic levelling of the programme; it is not. It is one constant:
   * `level = 1 / limit`, applied to every output sample
   * (`af_alimiter.c:140,289`). So at the default `limit` of `1` it multiplies
   * by exactly 1 and does nothing at all — it can neither raise quiet material
   * nor touch loud material. It only bites when you lower the ceiling: with
   * `{ limit: 0.891 }` (−1 dBFS) the limiter holds peaks at −1 dBFS and then
   * scales the whole signal back up by 1.122, so the output peaks at 0 dBFS
   * again. Pass `autoLevel: false` alongside any `limit` below 1 if you wanted
   * the headroom you asked for.
   */
  readonly autoLevel?: boolean
}

/**
 * {@link AudioFilters.dynamicNormalizer} options (ffmpeg `dynaudnorm`).
 *
 * `af_dynaudnorm.c:129-155`. `correctdc`/`c`, `altboundary`/`b`,
 * `channels`/`h`, `overlap`/`o` and the `curve` expression are not exposed;
 * reach them through {@link AudioFilters.custom} if ever needed.
 */
export interface DynamicNormalizerOptions {
  /**
   * Frame length in ms, 10–8000 (`f`). ffmpeg default 500. The option is
   * `AV_OPT_TYPE_INT` (`af_dynaudnorm.c:130-131`), so a fractional value would
   * be rounded by `av_opt_set` behind the caller's back — this factory
   * requires an integer instead.
   */
  readonly frameLengthMs?: number
  /**
   * Gaussian window size, 3–301 (`g`). ffmpeg default 31. Must be an **odd**
   * integer — see {@link AudioFilters.dynamicNormalizer} for why we reject an
   * even one where ffmpeg silently fixes it.
   */
  readonly gaussSize?: number
  /** Target peak, 0–1 (`p`). ffmpeg default 0.95. */
  readonly peak?: number
  /** Max amplification, 1–100 (`m`). ffmpeg default 10. */
  readonly maxGain?: number
  /** Target RMS, 0–1; 0 (ffmpeg's default) disables RMS targeting (`r`). */
  readonly targetRms?: number
  /**
   * Couple channels so the stereo image is preserved (`n`). ffmpeg default
   * `true`.
   */
  readonly coupling?: boolean
  /** Compress factor, 0–30; 0 (ffmpeg's default) disables (`s`). */
  readonly compress?: number
  /** Input threshold, 0–1 (`t`). ffmpeg default 0. */
  readonly threshold?: number
}

/**
 * {@link AudioFilters.loudnorm} options (ffmpeg `loudnorm`, EBU R128).
 *
 * `af_loudnorm.c:106-129`. The four `measured_*` inputs of the two-pass
 * workflow, `print_format` and `stats_file` are not exposed: a live player has
 * no analysis pass to feed them (see {@link AudioFilters.loudnorm}).
 */
export interface LoudnormOptions {
  /**
   * Integrated loudness target in LUFS, −70…−5 (`I`, `af_loudnorm.c:107`).
   * ffmpeg default −24.
   */
  readonly integrated?: number
  /**
   * Loudness range target in LU, 1–50 (`LRA`, `af_loudnorm.c:109`). ffmpeg
   * default 7.
   */
  readonly loudnessRange?: number
  /**
   * Maximum true peak in dBTP, −9…0 (`TP`, `af_loudnorm.c:111`). ffmpeg
   * default −2.
   */
  readonly truePeak?: number
  /** Offset gain in dB, −99…99 (`offset`, `af_loudnorm.c:120`). */
  readonly offset?: number
  /**
   * Normalise linearly when possible (`linear`, `af_loudnorm.c:121`). ffmpeg
   * default `true` — but inert in live playback, see
   * {@link AudioFilters.loudnorm}.
   */
  readonly linear?: boolean
  /** Treat mono as dual-mono (`dual_mono`, `af_loudnorm.c:122`). */
  readonly dualMono?: boolean
}

/** {@link AudioFilters.volume} options. */
export interface VolumeOptions {
  /**
   * Gain in dB. Negative values buy headroom ahead of an EQ boost.
   *
   * **The ±100 dB bound is ours, not ffmpeg's.** `volume`'s only gain option
   * is an *expression string* (`af_volume.c:67-68`, `AV_OPT_TYPE_STRING`
   * defaulting to `"1.0"`) evaluated by `av_expr_eval`, so libavfilter imposes
   * no numeric range at all. We write `<n>dB`, which libavutil's expression
   * parser understands natively and — importantly — parses sign-first, so
   * `-6dB` is −6 dB and not `-(6dB)` (`libavutil/eval.c:120-123` and the
   * `parse_dB` special case at `:574-587`).
   */
  readonly gainDb: number
}

/**
 * Factories for the audio filters this library ships bindings for.
 *
 * ## Where the ranges come from
 *
 * Every factory validates its arguments and throws `invalid-state` rather than
 * letting mpv reject the whole chain with a generic message. Values the caller
 * omits are simply not written, so ffmpeg's own defaults apply.
 *
 * Unless a doc comment says otherwise, a bound here is **read off the
 * `AVOption` table of the filter in FFmpeg n8.1.2** — the tree our engine
 * binaries are actually built from (`packages/player/android/libmpv.gradle`
 * `ffmpegVersion`, `packages/player/ios/libmpv.pin` `LIBMPV_FFMPEG_VERSION`).
 * Every citation below is `libavfilter/<file>:<line>` at the `n8.1.2` tag. The
 * AVOption table is the truth; `doc/filters.texi` is prose about it and is
 * cited only where it says something the table cannot.
 *
 * Re-audited in full against n8.1.2 (2026-08-14). Nothing in the wrapped
 * surface moved between n6.0 — which these bounds were originally taken from,
 * and which the engine has not shipped since the `rnmedia.5`/`rnmedia.4`
 * engine move — and n8.1.2: the only changes to these seven option tables are
 * a cosmetic `.unit =` designated-initializer refactor and `loudnorm` gaining
 * a `stats_file` option this API does not expose. What was stale was the
 * *label* on the ranges, not the ranges.
 *
 * ## Where a range is OURS
 *
 * Three bounds in this file are deliberately not ffmpeg's, and each says so at
 * its own definition:
 *   - {@link AudioFilters.volume} — ffmpeg's `volume` option is an *expression
 *     string* with no numeric bounds at all; ±100 dB is our sanity limit.
 *   - {@link AudioFilters.graphicEqualizer} — takes dB and converts, so
 *     ffmpeg's linear `[0, 20]` becomes a `+26.02 dB` ceiling.
 *   - {@link AudioFilters.dynamicNormalizer} `gaussSize` — ffmpeg *warns and
 *     silently rounds* an even window up to odd; we reject it instead.
 *
 * Anything not listed here — including `firequalizer` and `anequalizer`, which
 * are compiled in but configured through ffmpeg expression strings rather than
 * scalars (`af_anequalizer.c:84`'s `params` is one `AV_OPT_TYPE_STRING`) — is
 * reachable through {@link AudioFilters.custom}.
 */
export const AudioFilters = {
  /**
   * A single parametric peaking band (ffmpeg `equalizer`).
   *
   * The building block of a parametric EQ: stack several to shape a curve.
   *
   * @example
   * ```ts
   * AudioFilters.equalizer({ frequency: 5000, width: 2, gain: -12 })
   * ```
   */
  equalizer(options: EqualizerOptions): AudioFilter {
    const out: AudioFilterOption[] = [
      ['f', range(options.frequency, 0, 999999, 'equalizer.frequency')],
      ['t', widthType(options.widthType, 'equalizer.widthType')],
    ]
    optional(out, 'w', options.width, 0, 99999, 'equalizer.width')
    out.push(['g', range(options.gain, -900, 900, 'equalizer.gain')])
    return { name: 'equalizer', options: out }
  },

  /**
   * Low-shelf boost/cut (ffmpeg `bass`).
   *
   * @example
   * ```ts
   * AudioFilters.bass({ frequency: 110, gain: 6 })
   * ```
   */
  bass(options: ShelfOptions): AudioFilter {
    return shelf('bass', options)
  },

  /** High-shelf boost/cut (ffmpeg `treble`). */
  treble(options: ShelfOptions): AudioFilter {
    return shelf('treble', options)
  },

  /** Two-pole low-pass (ffmpeg `lowpass`). */
  lowpass(options: PassOptions): AudioFilter {
    return pass('lowpass', options)
  },

  /**
   * Two-pole high-pass (ffmpeg `highpass`).
   *
   * A 30–40 Hz high-pass is the cheapest way to stop a bass boost from
   * wasting excursion on inaudible rumble.
   */
  highpass(options: PassOptions): AudioFilter {
    return pass('highpass', options)
  },

  /**
   * 18-band graphic equaliser (ffmpeg `superequalizer`), gains in dB.
   *
   * Band centres are {@link GRAPHIC_EQUALIZER_BANDS}. This is an FFT filter:
   * it costs more CPU than a stack of {@link AudioFilters.equalizer} bands but
   * gives a flat, phase-consistent response and maps 1:1 onto a slider UI.
   *
   * @example
   * ```ts
   * // +12 dB on the bottom two bands, flat elsewhere
   * AudioFilters.graphicEqualizer({
   *   gainsDb: [12, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
   * })
   * ```
   */
  graphicEqualizer(options: GraphicEqualizerOptions): AudioFilter {
    const gains = options.gainsDb
    if (!Array.isArray(gains) || gains.length !== 18) {
      invalid(
        `graphicEqualizer.gainsDb must have exactly 18 entries (one per band in GRAPHIC_EQUALIZER_BANDS), got ${Array.isArray(gains) ? String(gains.length) : typeof gains}.`
      )
    }
    const out: AudioFilterOption[] = gains.map((gainDb, index) => {
      const what = `graphicEqualizer.gainsDb[${index}] (${String(GRAPHIC_EQUALIZER_BANDS[index])} Hz)`
      num(gainDb, what)
      const linear = 10 ** (gainDb / 20)
      if (linear > GRAPHIC_EQUALIZER_MAX_LINEAR) {
        invalid(
          `${what} must be at most +26.02 dB (ffmpeg caps superequalizer band gain at ${GRAPHIC_EQUALIZER_MAX_LINEAR}× linear), got ${String(gainDb)} dB.`
        )
      }
      // 6 decimals is well below the filter's float precision and keeps the
      // compiled string short and stable across platforms.
      return [`${String(index + 1)}b`, String(Number(linear.toFixed(6)))]
    })
    return { name: 'superequalizer', options: out }
  },

  /**
   * Headphone crossfeed (ffmpeg `crossfeed`) — bleeds a filtered copy of each
   * channel into the other so hard-panned mixes stop feeling like two separate
   * sounds inside the head.
   */
  crossfeed(options: CrossfeedOptions = {}): AudioFilter {
    const out: AudioFilterOption[] = []
    optional(out, 'strength', options.strength, 0, 1, 'crossfeed.strength')
    optional(out, 'range', options.range, 0, 1, 'crossfeed.range')
    optional(out, 'slope', options.slope, 0.01, 1, 'crossfeed.slope')
    optional(out, 'level_in', options.levelIn, 0, 1, 'crossfeed.levelIn')
    optional(out, 'level_out', options.levelOut, 0, 1, 'crossfeed.levelOut')
    return { name: 'crossfeed', options: out }
  },

  /** Dynamic-range compressor (ffmpeg `acompressor`). */
  compressor(options: CompressorOptions = {}): AudioFilter {
    const out: AudioFilterOption[] = []
    optional(
      out,
      'level_in',
      options.levelIn,
      0.015625,
      64,
      'compressor.levelIn'
    )
    if (options.mode !== undefined) {
      if (options.mode !== 'downward' && options.mode !== 'upward') {
        invalid(
          `compressor.mode must be 'downward' | 'upward', got ${JSON.stringify(options.mode)}.`
        )
      }
      out.push(['mode', options.mode])
    }
    optional(
      out,
      'threshold',
      options.threshold,
      0.000976563,
      1,
      'compressor.threshold'
    )
    optional(out, 'ratio', options.ratio, 1, 20, 'compressor.ratio')
    optional(out, 'attack', options.attack, 0.01, 2000, 'compressor.attack')
    optional(out, 'release', options.release, 0.01, 9000, 'compressor.release')
    optional(out, 'makeup', options.makeup, 1, 64, 'compressor.makeup')
    optional(out, 'knee', options.knee, 1, 8, 'compressor.knee')
    if (options.link !== undefined) {
      if (options.link !== 'average' && options.link !== 'maximum') {
        invalid(
          `compressor.link must be 'average' | 'maximum', got ${JSON.stringify(options.link)}.`
        )
      }
      out.push(['link', options.link])
    }
    if (options.detection !== undefined) {
      if (options.detection !== 'peak' && options.detection !== 'rms') {
        invalid(
          `compressor.detection must be 'peak' | 'rms', got ${JSON.stringify(options.detection)}.`
        )
      }
      out.push(['detection', options.detection])
    }
    optional(out, 'mix', options.mix, 0, 1, 'compressor.mix')
    return { name: 'acompressor', options: out }
  },

  /**
   * Look-ahead brickwall limiter (ffmpeg `alimiter`).
   *
   * The honest tail of any chain that boosts: EQ gain plus ReplayGain can push
   * peaks past full scale, and this is what stops that becoming clipping.
   *
   * @remarks
   * What it costs when it is *not* working, which is most of the time — worth
   * knowing, because {@link equalizerPresetChain} appends one by default:
   *
   * - **Below full scale it is sample-identical.** The gain reduction is a
   *   single running scalar that starts at 1 and is only ever moved by a
   *   sample whose magnitude exceeds `limit`; nothing else in the path scales
   *   (`af_alimiter.c:102,180,236,239,269-275,289`). No colouration, no
   *   compression of programme material, no level change.
   * - **It delays the signal by `attack`, and does not compensate.** The
   *   look-ahead buffer is `attack × sampleRate` samples — 240 samples, 5.0 ms
   *   at 48 kHz on the default 5 ms attack — and ffmpeg's `latency` option,
   *   which trims the primed silence and flushes the tail, defaults to off and
   *   is not exposed here (`af_alimiter.c:376-379`). So a chain that has just
   *   been built emits 5 ms of silence first, and the last 5 ms of the stream
   *   is never flushed. Inaudible for playback; it is still the one thing that
   *   is not transparent.
   * - It runs in `double` (`FILTER_SINGLE_SAMPLEFMT(AV_SAMPLE_FMT_DBL)`), so
   *   libavfilter inserts `aresample` around it. Lossless, not free.
   */
  limiter(options: LimiterOptions = {}): AudioFilter {
    const out: AudioFilterOption[] = []
    optional(out, 'level_in', options.levelIn, 0.015625, 64, 'limiter.levelIn')
    optional(
      out,
      'level_out',
      options.levelOut,
      0.015625,
      64,
      'limiter.levelOut'
    )
    optional(out, 'limit', options.limit, 0.0625, 1, 'limiter.limit')
    optional(out, 'attack', options.attack, 0.1, 80, 'limiter.attack')
    optional(out, 'release', options.release, 1, 8000, 'limiter.release')
    if (options.autoRelease !== undefined) {
      out.push(['asc', bool(options.autoRelease, 'limiter.autoRelease')])
    }
    optional(
      out,
      'asc_level',
      options.autoReleaseLevel,
      0,
      1,
      'limiter.autoReleaseLevel'
    )
    if (options.autoLevel !== undefined) {
      out.push(['level', bool(options.autoLevel, 'limiter.autoLevel')])
    }
    return { name: 'alimiter', options: out }
  },

  /**
   * Sliding-window loudness normaliser (ffmpeg `dynaudnorm`).
   *
   * Prefer this over {@link AudioFilters.loudnorm} for live playback: it works
   * at the stream's own sample rate, whereas `loudnorm` forces the whole chain
   * through 192 kHz.
   *
   * `frameLengthMs` and `gaussSize` map to `AV_OPT_TYPE_INT` options
   * (`af_dynaudnorm.c:130-133`) and are required to be integers here, because
   * `av_opt_set` would otherwise round a fractional value silently. `gaussSize`
   * must additionally be odd: **that rejection is ours** — ffmpeg logs
   * `"filter size %d is invalid. Changing to an odd value."` and ORs the low
   * bit in (`af_dynaudnorm.c:165-167`), i.e. it runs a *different* filter from
   * the one that was asked for, with the warning buried in mpv's log.
   */
  dynamicNormalizer(options: DynamicNormalizerOptions = {}): AudioFilter {
    const out: AudioFilterOption[] = []
    if (options.frameLengthMs !== undefined) {
      range(options.frameLengthMs, 10, 8000, 'dynamicNormalizer.frameLengthMs')
      if (!Number.isInteger(options.frameLengthMs)) {
        invalid(
          `dynamicNormalizer.frameLengthMs must be an integer (ffmpeg's \`f\` is AV_OPT_TYPE_INT and would round a fraction silently), got ${String(options.frameLengthMs)}.`
        )
      }
      out.push(['f', String(options.frameLengthMs)])
    }
    if (options.gaussSize !== undefined) {
      range(options.gaussSize, 3, 301, 'dynamicNormalizer.gaussSize')
      if (!Number.isInteger(options.gaussSize) || options.gaussSize % 2 === 0) {
        invalid(
          `dynamicNormalizer.gaussSize must be an odd integer (ffmpeg would round an even window up to odd and run a different filter than you asked for), got ${String(options.gaussSize)}.`
        )
      }
      out.push(['g', String(options.gaussSize)])
    }
    optional(out, 'p', options.peak, 0, 1, 'dynamicNormalizer.peak')
    optional(out, 'm', options.maxGain, 1, 100, 'dynamicNormalizer.maxGain')
    optional(out, 'r', options.targetRms, 0, 1, 'dynamicNormalizer.targetRms')
    if (options.coupling !== undefined) {
      out.push(['n', bool(options.coupling, 'dynamicNormalizer.coupling')])
    }
    optional(out, 's', options.compress, 0, 30, 'dynamicNormalizer.compress')
    optional(out, 't', options.threshold, 0, 1, 'dynamicNormalizer.threshold')
    return { name: 'dynaudnorm', options: out }
  },

  /**
   * EBU R128 loudness normalisation (ffmpeg `loudnorm`).
   *
   * **Prefer `Player.setLoudnessNormalization`** — the managed toggle over
   * this same filter, which coexists with a chain set through
   * `setAudioFilters` instead of being clobbered by it, and whose TSDoc
   * carries the full cost sheet. This factory remains for hand-built chains
   * that need options the toggle does not expose (`linear`, `offset`).
   *
   * **Expensive on mobile, by construction.** In its single-pass (dynamic)
   * mode `loudnorm` advertises exactly one input sample rate — 192 000 Hz
   * (FFmpeg 8.1.2 `af_loudnorm.c:740,752`; `doc/filters.texi`: "the audio
   * stream will be upsampled to 192 kHz") — so libavfilter resamples the
   * stream up to 192 kHz for this filter and back down afterwards, and the
   * filter buffers 3 s of lookahead (`af_loudnorm.c:697,775`). Note `linear`
   * is inert in live playback: ffmpeg's linear mode requires all four
   * `measured_*` values from a prior analysis pass (`af_loudnorm.c:820-825`),
   * which a live player cannot have. If all you want is "make quiet tracks
   * louder", {@link AudioFilters.dynamicNormalizer} or `Player.setReplayGain`
   * costs a fraction of it.
   */
  loudnorm(options: LoudnormOptions = {}): AudioFilter {
    const out: AudioFilterOption[] = []
    optional(out, 'I', options.integrated, -70, -5, 'loudnorm.integrated')
    optional(out, 'LRA', options.loudnessRange, 1, 50, 'loudnorm.loudnessRange')
    optional(out, 'TP', options.truePeak, -9, 0, 'loudnorm.truePeak')
    optional(out, 'offset', options.offset, -99, 99, 'loudnorm.offset')
    if (options.linear !== undefined) {
      out.push(['linear', bool(options.linear, 'loudnorm.linear')])
    }
    if (options.dualMono !== undefined) {
      out.push(['dual_mono', bool(options.dualMono, 'loudnorm.dualMono')])
    }
    return { name: 'loudnorm', options: out }
  },

  /**
   * Fixed gain (ffmpeg `volume`), in dB.
   *
   * This is chain-domain gain, distinct from `Player.setVolume` (mpv's output
   * volume) and from ReplayGain. Its job here is headroom: put
   * `AudioFilters.volume({ gainDb: -6 })` at the head of a chain whose EQ
   * boosts 6 dB and nothing clips.
   *
   * The ±100 dB bound is this library's, not libavfilter's — see
   * {@link VolumeOptions.gainDb}.
   */
  volume(options: VolumeOptions): AudioFilter {
    const gainDb = range(options.gainDb, -100, 100, 'volume.gainDb')
    return { name: 'volume', options: [['volume', `${gainDb}dB`]] }
  },

  /**
   * Any other filter mpv or libavfilter knows, by name.
   *
   * The escape hatch that keeps this module thin: `firequalizer`,
   * `anequalizer`, `aformat`, `anull` and mpv's own builtins are all reachable
   * without waiting for a typed wrapper. Options are written in object key
   * order; values are stringified as-is (numbers via `String`).
   *
   * @example
   * ```ts
   * // Arbitrary-curve linear-phase EQ, ffmpeg expression syntax
   * AudioFilters.custom('firequalizer', {
   *   gain_entry: 'entry(100,-3);entry(1000,0);entry(10000,4)',
   * })
   * ```
   */
  custom(
    name: string,
    options: Readonly<Record<string, string | number | boolean>> = {}
  ): AudioFilter {
    const out: AudioFilterOption[] = Object.entries(options).map(
      ([key, value]) => {
        if (typeof value === 'number') {
          return [key, num(value, `custom(${name}).${key}`)] as const
        }
        if (typeof value === 'boolean') {
          return [key, bool(value, `custom(${name}).${key}`)] as const
        }
        if (typeof value !== 'string') {
          invalid(
            `custom(${name}).${key} must be a string, number or boolean, got ${typeof value}.`
          )
        }
        return [key, value] as const
      }
    )
    const filter: AudioFilter = { name, options: out }
    assertValidAudioFilters([filter])
    return filter
  },
} as const

function shelf(name: 'bass' | 'treble', options: ShelfOptions): AudioFilter {
  const out: AudioFilterOption[] = []
  optional(out, 'f', options.frequency, 0, 999999, `${name}.frequency`)
  out.push(['t', widthType(options.widthType, `${name}.widthType`)])
  optional(out, 'w', options.width, 0, 99999, `${name}.width`)
  out.push(['g', range(options.gain, -900, 900, `${name}.gain`)])
  if (options.poles !== undefined) {
    out.push(['p', String(range(options.poles, 1, 2, `${name}.poles`))])
  }
  return { name, options: out }
}

function pass(name: 'lowpass' | 'highpass', options: PassOptions): AudioFilter {
  const out: AudioFilterOption[] = [
    ['f', range(options.frequency, 0, 999999, `${name}.frequency`)],
    ['t', widthType(options.widthType, `${name}.widthType`)],
  ]
  optional(out, 'w', options.width, 0, 99999, `${name}.width`)
  if (options.poles !== undefined) {
    out.push(['p', String(range(options.poles, 1, 2, `${name}.poles`))])
  }
  return { name, options: out }
}
