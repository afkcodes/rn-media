import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PlayerError } from '../errors'
import { PlayerErrorException, toPlayerError } from '../errors'
import type {
  EqualizerPreset,
  EqualizerPresetChainOptions,
} from '../equalizer-presets'
import {
  EQUALIZER_BANDS,
  EQUALIZER_BAND_COUNT,
  EQUALIZER_PRESETS,
  EQUALIZER_PRESET_LIST,
  defineEqualizerPreset,
  equalizerPresetChain,
} from '../equalizer-presets'
import type { EqualizerSettings, EqualizerStorage } from '../equalizer-storage'
import {
  DEFAULT_EQUALIZER_STORAGE_KEY,
  parseEqualizerSettings,
  serializeEqualizerSettings,
} from '../equalizer-storage'
import type { AudioFilter } from '../filters'
import { compileAudioFilters, diffAudioFilterParams } from '../filters'
import type { Player } from '../player'

/**
 * One slider of the equaliser: the ISO octave centre it sits on, and where the
 * user has it.
 *
 * A band is identified by its **index** — its position in
 * {@link EQUALIZER_BANDS}, which is also the index every `gainsDb` array in
 * this package is ordered by. (The entry-id rule that governs the *queue* does
 * not apply here: the band set is a fixed-length, never-reordered array, so the
 * index is the identity.)
 */
export interface EqualizerBand {
  /** Centre frequency in Hz — the label to draw under the slider. */
  readonly frequency: number
  /** The band's gain in dB. Negative cuts, positive boosts, `0` is off. */
  readonly gainDb: number
}

/** Inclusive slider bounds, in dB. */
export interface EqualizerGainRange {
  readonly min: number
  readonly max: number
}

/**
 * Default bounds for a band slider: ±12 dB.
 *
 * Not ffmpeg's limit (±900 dB) and not the built-in presets' self-imposed ceiling
 * (±9 dB) — it is the range a consumer EQ can offer without the result being
 * unusable. Past about ±12 dB a one-octave bell stops sounding like tone
 * control and starts sounding like damage, and the pre-amp
 * {@link equalizerPresetChain} computes has to give back everything the boost
 * gained anyway. Override with `UseEqualizerOptions.gainRangeDb` if your UI
 * wants a different feel.
 */
export const DEFAULT_EQUALIZER_GAIN_RANGE_DB: EqualizerGainRange =
  Object.freeze({ min: -12, max: 12 })

/** Ten zeroes — the flat curve, and what {@link Equalizer.reset} returns to. */
const FLAT_GAINS: readonly number[] = Object.freeze(
  Array.from({ length: EQUALIZER_BAND_COUNT }, () => 0)
)

/** Options for {@link useEqualizer}. */
export interface UseEqualizerOptions {
  /**
   * The curve to start on — a built-in id (`'rock'`), or any
   * {@link EqualizerPreset}. Defaults to flat, which compiles to **no filters
   * at all**, so an equaliser nobody has touched costs nothing.
   *
   * Read once, on mount. A persisted curve (see {@link storage}) wins over it.
   */
  readonly initialPreset?: string | EqualizerPreset
  /**
   * Whether the EQ starts switched on. Defaults to `true` — with flat gains
   * that is still an empty chain, and it means the first slider drag is
   * audible without a second tap.
   *
   * Read once, on mount; a persisted value wins over it.
   */
  readonly initialEnabled?: boolean
  /**
   * The rest of *your* filter chain — crossfeed, a compressor, an `aformat`,
   * anything from `AudioFilters`. They are appended after the EQ bands, so the
   * signal is equalised first.
   *
   * @deprecated Call `player.setAudioFilters([...])` directly. This hook now
   * owns only its own labelled entries and composes with the user chain
   * instead of replacing it, so there is nothing left for this option to work
   * around. It still behaves exactly as it did — the entries land in the same
   * place in the chain — and it will be removed one release from now.
   *
   * @remarks
   * **This existed because `Player.setAudioFilters` used to be replaced
   * wholesale by this hook.** It no longer is: the hook writes
   * `Player.setEqualizerFilters`, which rewrites the `@rnmedia_eq_…` entries
   * and leaves every other filter — yours, and the managed loudness entry —
   * exactly where it is. A chain set behind the hook's back now survives a
   * slider drag, which is what this option was invented to fake.
   *
   * The one behavioural difference between the two routes is *position*.
   * Entries passed here sit inside the managed half, immediately after the EQ
   * limiter; entries passed to `setAudioFilters` sit after the managed half,
   * which is the same place in the compiled chain. They are interchangeable
   * today, and the direct call is the one that keeps working.
   *
   * May change between renders; the chain is rewritten only when it actually
   * compiles to something different.
   */
  readonly extraFilters?: readonly AudioFilter[]
  /**
   * How the EQ curve is compiled — pre-amp on top of the automatic headroom,
   * the bell width, and the tail limiter. See
   * {@link EqualizerPresetChainOptions}.
   *
   * Note the limiter is **on by default for every curve that is not flat**,
   * cut-only curves included; `{ limiter: false }` removes it. It is
   * sample-identical below full scale, so this is not a tone decision — see
   * {@link EqualizerPresetChainOptions.limiter} for what it does and does not
   * change.
   *
   * `editable` is not yours to set here: this hook always compiles an editable
   * chain, because that is what lets a slider move a band without rebuilding
   * the filter graph (see the remarks on {@link useEqualizer}).
   */
  readonly chain?: Omit<EqualizerPresetChainOptions, 'editable'>
  /**
   * Slider bounds. Every gain that goes in through this hook is **clamped** to
   * them. Defaults to {@link DEFAULT_EQUALIZER_GAIN_RANGE_DB}.
   */
  readonly gainRangeDb?: EqualizerGainRange
  /**
   * Where the user's equaliser is remembered — their saved curves *and*
   * whatever they last had applied.
   *
   * Omit it and everything is in-memory for the session, which is the correct
   * default for a library: an EQ that silently writes to a storage engine the
   * app did not choose is a dependency, not a feature. See
   * {@link EqualizerStorage}.
   *
   * Read once, on mount.
   */
  readonly storage?: EqualizerStorage
  /** Storage key. Defaults to {@link DEFAULT_EQUALIZER_STORAGE_KEY}. */
  readonly storageKey?: string
  /**
   * A read or write against {@link storage} failed — a broken dependency, not
   * bad data (a corrupt *record* is handled silently, because that is an
   * ordinary runtime condition and the answer to it is "start from the
   * defaults").
   *
   * Unhandled, it is one `console.warn`. It is a callback rather than a
   * returned field because it is not renderable state: nothing on an EQ screen
   * changes because a write failed, and putting it in the snapshot would make
   * every consumer destructure something it will never draw.
   */
  readonly onStorageError?: (cause: unknown) => void
}

/**
 * The equaliser: its live state, and every operation an EQ screen performs on
 * it.
 *
 * Stable identity — the object is rebuilt only when something in it actually
 * changed — so passing it whole to a memoised `<EqualizerScreen>` costs no
 * render on an unrelated player update.
 */
export interface Equalizer {
  /** Whether the EQ is applied at all. `false` leaves your other filters running. */
  readonly enabled: boolean
  /**
   * One entry per band of {@link EQUALIZER_BANDS}, low to high — the array to
   * `.map()` into sliders.
   */
  readonly bands: readonly EqualizerBand[]
  /**
   * The same curve as {@link bands}, as the bare `gainsDb` array every other
   * function in this package takes. Hand it to `defineEqualizerPreset`, store
   * it, diff it.
   */
  readonly gainsDb: readonly number[]
  /** The slider bounds every gain is clamped to. */
  readonly gainRangeDb: EqualizerGainRange
  /**
   * The preset the current curve *is*, or `undefined` when it matches none —
   * which is what a UI shows as "Custom".
   *
   * Derived by comparing the gains, not remembered from the last
   * {@link applyPreset}: dragging a slider away from `Rock` and back onto it
   * lands on `Rock` again, and no sequence of edits can leave the chip
   * highlighted on a curve that is not playing.
   */
  readonly preset: EqualizerPreset | undefined
  /**
   * Everything selectable, in picker order: the built-ins
   * ({@link EQUALIZER_PRESET_LIST}, `Flat` first then alphabetical) followed by
   * the user's saved curves in save order.
   */
  readonly presets: readonly EqualizerPreset[]
  /**
   * Just the user's saved curves — the subset {@link deletePreset} accepts, so
   * a picker can draw a delete affordance on exactly the right rows.
   */
  readonly savedPresets: readonly EqualizerPreset[]
  /**
   * Why the last apply failed, or `undefined` while the chain is healthy.
   *
   * The realistic cause is a libmpv built without the filters (`code: 'mpv'`,
   * `errno: -11`): mpv rejects the whole chain, leaves the previous one
   * playing, and this says so. The UI state here is still what the user asked
   * for — read `player.getAudioFilters()` for what mpv actually has.
   */
  readonly error: PlayerError | undefined
  /**
   * Whether the persisted equaliser has been read back yet.
   *
   * Always `true` when no `storage` was given (there is nothing to wait for),
   * and already `true` on the first render for a *synchronous* engine (MMKV),
   * which is read through inside the mount effect.
   *
   * With an asynchronous engine (AsyncStorage) it is `false` until the record
   * arrives, and **nothing is written to mpv** in the meantime — so a saved
   * curve is applied once, rather than flat first and the real curve a
   * microtask later.
   */
  readonly hydrated: boolean
  /** Switch the EQ half of the chain on or off, keeping the curve. */
  setEnabled(enabled: boolean): void
  /**
   * Move one band.
   *
   * @param index - Position in {@link EQUALIZER_BANDS} / {@link bands}.
   * @param gainDb - New gain, **clamped** to {@link gainRangeDb} — a slider
   * cannot throw halfway through a drag.
   * @throws {@link PlayerErrorException} `invalid-state` if `index` is not a
   * band, or `gainDb` is not a finite number. Both are programming errors, not
   * user input.
   */
  setBandGain(index: number, gainDb: number): void
  /**
   * Replace the whole curve at once — restoring a profile, or applying a curve
   * computed somewhere else.
   *
   * @param gainsDb - Exactly {@link EQUALIZER_BAND_COUNT} finite gains, low
   * band first. Each is clamped to {@link gainRangeDb}.
   * @throws {@link PlayerErrorException} `invalid-state` on the wrong length or
   * a non-finite entry.
   */
  setBandGains(gainsDb: readonly number[]): void
  /**
   * Apply a preset — the chip tap.
   *
   * @param preset - A built-in id (`'rock'`), a saved preset's id, or any
   * {@link EqualizerPreset} object (which need not be in {@link presets}).
   * @throws {@link PlayerErrorException} `invalid-state` when a string names no
   * known preset.
   */
  applyPreset(preset: string | EqualizerPreset): void
  /**
   * Flatten every band to 0 dB — the "Reset" button.
   *
   * Only the curve: {@link enabled} and the saved presets are untouched, and a
   * flat curve compiles to an empty chain, so this genuinely removes the EQ
   * from the signal path rather than leaving ten no-op biquads in it.
   */
  reset(): void
  /**
   * Save the current curve under a name, so it joins {@link presets}.
   *
   * Saving twice under the same name **replaces** — the name is the identity of
   * a user curve, which is what "Save as…" means everywhere else.
   *
   * @param name - Human label. Non-empty.
   * @returns The stored preset, so a caller can select it or show it
   * immediately.
   * @throws {@link PlayerErrorException} `invalid-state` on an empty name.
   */
  savePreset(name: string): EqualizerPreset
  /**
   * Forget a saved curve.
   *
   * Deleting the preset that is currently applied does not change the sound —
   * the curve stays exactly where it is, it simply stops having a name.
   *
   * @param id - A {@link savedPresets} id. An unknown id is a no-op (deleting
   * twice is not an error).
   * @throws {@link PlayerErrorException} `invalid-state` for a built-in id —
   * those ship with the library and cannot be removed.
   */
  deletePreset(id: string): void
}

/** The mutable half, kept in one object so an edit is one render. */
interface EqualizerState {
  readonly enabled: boolean
  readonly gainsDb: readonly number[]
  readonly savedPresets: readonly EqualizerPreset[]
}

/** Prefix that keeps a user curve's id out of the built-ins' namespace. */
const SAVED_PRESET_PREFIX = 'custom:'

/**
 * How long after the last in-place gain change the chain is committed to mpv's
 * `af` property, in milliseconds.
 *
 * The one timer in this hook, and it buys correctness rather than smoothness.
 * `af-command` changes a *running* filter; mpv's `af` string still says what
 * the filter was built with, and anything that rebuilds the chain from that
 * string — the next track, an audio-device switch, a loudness-normalization
 * toggle — would put the old gains back. So once the finger stops, the chain is
 * written once and the property becomes true again.
 *
 * 250 ms is comfortably longer than the gap between two frames of a drag (so a
 * gesture commits once, not per frame) and short enough that no realistic track
 * change lands inside the window.
 */
const COMMIT_DELAY_MS = 250

/**
 * A ten-band equaliser as one hook: the curve, the presets, the persistence,
 * and the one `af` write that puts it on the signal.
 *
 * Before this, an EQ screen meant composing four exports and owning the state
 * between them — `EQUALIZER_PRESET_LIST` for the chips,
 * `equalizerPresetChain` to compile, `defineEqualizerPreset` for a user curve,
 * `setAudioFilters` to apply, and a `useState` per slider. That is the library
 * making the app do its arithmetic. This is the same machinery with the
 * bookkeeping done:
 *
 * ```tsx
 * const eq = useEqualizer(player)
 *
 * return (
 *   <>
 *     {eq.presets.map((p) => (
 *       <Chip key={p.id} label={p.name} active={p.id === eq.preset?.id}
 *             onPress={() => eq.applyPreset(p)} />
 *     ))}
 *     {eq.bands.map((band, index) => (
 *       <Slider key={band.frequency} value={band.gainDb}
 *               minimumValue={eq.gainRangeDb.min}
 *               maximumValue={eq.gainRangeDb.max}
 *               onValueChange={(db) => eq.setBandGain(index, db)} />
 *     ))}
 *   </>
 * )
 * ```
 *
 * @param player - The player, or `undefined` before it has been created. The
 * hook holds its state either way, so a screen can render (and be edited)
 * before the core exists; the chain is written as soon as one appears.
 * @param options - See {@link UseEqualizerOptions}.
 * @returns See {@link Equalizer}.
 *
 * @remarks
 * **There is no `onBandChange`/`onPresetChange` event, on purpose.** The
 * returned object *is* the notification: every mutator re-renders the
 * component that holds the hook, and the value is a fresh immutable snapshot.
 * An event carrying the same fact would be a second source of truth for
 * consumers to fall out of sync with, and a subscription for the common case
 * (one EQ screen) to pay for. Several components can call the hook
 * independently — they will each have their own curve, which is the honest
 * consequence of not keeping app state in the library; hoist it if you want
 * one.
 *
 * **What is written, and when — drag it, it is built for that.** Nothing is
 * written unless the compiled chain would actually differ, and *how* it is
 * written depends on what changed:
 *
 * - **Only gains changed** (the slider case): each moved band is pushed into
 *   the running filter with `Player.setAudioFilterParam` — mpv's `af-command`,
 *   which updates the biquad's coefficients and leaves its state alone. No
 *   chain rebuild, no blocked JS thread (the command is async), no click. The
 *   curve is compiled `editable` precisely so this path is available: ten
 *   labelled bands whose *shape* never depends on their values.
 * - **The graph changed** (EQ toggled, `chain` options changed, or the curve
 *   left/returned to flat): one `Player.setEqualizerFilters`, which rebuilds
 *   the entries that differ. That is the expensive path, and it is now
 *   reached once per gesture at most.
 * - **{@link COMMIT_DELAY_MS} after the last in-place change**: one
 *   `setEqualizerFilters` that makes mpv's `af` property agree with the running
 *   chain again, so the curve survives the next track, device switch or
 *   normalization toggle. Until it lands, `player.getAudioFilters()` still
 *   shows the pre-drag string — that read-back is mpv's property, and the whole
 *   point of the fast path is not to write it.
 *
 * An `af-command` that mpv refuses (nothing playing, an older engine, a filter
 * that will not take the parameter at runtime) switches this hook to
 * commit-only for the rest of the player's life: the curve then lands once the
 * gesture settles rather than following the finger. That is the honest
 * degradation — the alternative, rewriting the chain per frame, is what makes
 * playback stutter, and it is never the right answer.
 *
 * **One timer, and only for the commit above.** Nothing else here ticks; every
 * update is caused by a call you made or by the persisted record arriving. The
 * pending commit is flushed on unmount.
 *
 * **Unmounting does not clear the chain.** `af` is a global mpv option that
 * survives track changes, and an EQ screen closing is not a reason to stop
 * equalising. Call `setEnabled(false)` — or `player.clearAudioFilters()` — to
 * take it off.
 *
 * **Ownership is scoped to the entries it wrote.** This hook owns
 * `Player.setEqualizerFilters` — the labelled `@rnmedia_eq_…` half of the
 * chain — and nothing else. `player.setAudioFilters([...])` keeps working
 * while an EQ screen is mounted, and keeps working *after* a slider drag: the
 * two halves are composed (equaliser → your chain → loudness normalization),
 * not overwritten. {@link UseEqualizerOptions.extraFilters} was the workaround
 * for the old wholesale behaviour and is deprecated.
 */
export function useEqualizer(
  player: Player | undefined,
  options: UseEqualizerOptions = {}
): Equalizer {
  const gainRangeDb = options.gainRangeDb ?? DEFAULT_EQUALIZER_GAIN_RANGE_DB
  const rangeRef = useRef(gainRangeDb)
  rangeRef.current = gainRangeDb

  // Captured once, for the same reason `usePlayer` captures its options: these
  // describe how the hook starts, and re-reading them on every render would
  // mean a fresh object literal re-seeding state forever.
  const seedRef = useRef(options)

  const [state, setState] = useState<EqualizerState>(() => {
    const seed = seedRef.current
    const initial =
      seed.initialPreset === undefined
        ? FLAT_GAINS
        : resolvePreset(seed.initialPreset, []).gainsDb
    return {
      enabled: seed.initialEnabled ?? true,
      gainsDb: clampGains(
        initial,
        seed.gainRangeDb ?? DEFAULT_EQUALIZER_GAIN_RANGE_DB
      ),
      savedPresets: [],
    }
  })
  const [error, setError] = useState<PlayerError | undefined>(undefined)
  // With no storage there is nothing to wait for, so the very first render is
  // already hydrated and the chain can be written immediately.
  const [hydrated, setHydrated] = useState(
    () => seedRef.current.storage === undefined
  )

  // Read by the mutators, which are stable across renders and therefore cannot
  // close over the live values.
  const stateRef = useRef(state)
  stateRef.current = state

  // What was last written to storage, so an unchanged state (a re-render, or
  // the record that was just restored) costs no storage round-trip.
  const writtenRef = useRef<string | undefined>(undefined)

  /* ---------------------------- restore ---------------------------------- */

  useEffect(() => {
    const { storage, storageKey, onStorageError } = seedRef.current
    if (storage === undefined) return undefined
    let cancelled = false

    const adopt = (raw: string | null): void => {
      if (cancelled) return
      const result = parseEqualizerSettings(raw)
      if (result.status === 'restored') {
        const restored: EqualizerState = {
          enabled: result.settings.enabled,
          gainsDb: clampGains(result.settings.gainsDb, rangeRef.current),
          savedPresets: result.settings.presets,
        }
        setState(restored)
        // Mark what was just read as already written, so the restore does not
        // immediately provoke a write of the record it came from.
        writtenRef.current = serializeEqualizerSettings({
          enabled: restored.enabled,
          gainsDb: restored.gainsDb,
          presets: restored.savedPresets,
        })
      }
      // Every other status — empty, corrupt, a version this build cannot read
      // — means the same thing to a UI: start from the defaults. The typed
      // result exists for callers of `parseEqualizerSettings`; here it would
      // only be a branch that does nothing.
      setHydrated(true)
    }

    const fail = (cause: unknown): void => {
      if (cancelled) return
      reportStorageError(onStorageError, cause)
      setHydrated(true)
    }

    try {
      // Not `await`: a *synchronous* engine (MMKV, a plain Map) is read through
      // synchronously, so hydration finishes inside this effect and the very
      // first `af` write is already the restored curve. Awaiting would defer it
      // a microtask for no reason and cost a render. The same shape
      // `@timbre/media-session`'s `withPersistence` uses, for the same reason.
      const read = storage.getItem(storageKey ?? DEFAULT_EQUALIZER_STORAGE_KEY)
      if (read instanceof Promise) read.then(adopt, fail)
      else adopt(read)
    } catch (cause) {
      fail(cause)
    }

    return () => {
      cancelled = true
    }
  }, [])

  /* ------------------------------ persist -------------------------------- */

  useEffect(() => {
    const { storage, storageKey, onStorageError } = seedRef.current
    if (storage === undefined || !hydrated) return
    const settings: EqualizerSettings = {
      enabled: state.enabled,
      gainsDb: state.gainsDb,
      presets: state.savedPresets,
    }
    const serialized = serializeEqualizerSettings(settings)
    if (serialized === writtenRef.current) return
    writtenRef.current = serialized
    try {
      const written = storage.setItem(
        storageKey ?? DEFAULT_EQUALIZER_STORAGE_KEY,
        serialized
      )
      // A synchronous engine (MMKV) has already finished here; an async one
      // (AsyncStorage) reports through the same channel a throw would.
      if (written instanceof Promise) {
        written.catch((cause: unknown) => {
          reportStorageError(onStorageError, cause)
        })
      }
    } catch (cause) {
      reportStorageError(onStorageError, cause)
    }
  }, [hydrated, state])

  /* ------------------------------- apply --------------------------------- */

  /**
   * The whole `af` user half: the EQ bands (with their headroom pre-amp and
   * limiter) followed by the app's own filters.
   *
   * Recomputed whenever a caller re-renders with fresh `chain`/`extraFilters`
   * literals — deliberately, because keying this on a hand-rolled signature
   * would be a dependency lie. The cost is the summed magnitude-response walk
   * inside `equalizerPresetChain`: ~60 frequency steps × 10 bands, tens of
   * microseconds, and *nothing* is written to mpv unless the compiled string
   * actually differs (see the effect below).
   */
  const chain = useMemo<readonly AudioFilter[]>(() => {
    const eq = state.enabled
      ? equalizerPresetChain(
          { gainsDb: state.gainsDb },
          // `editable` is what makes a drag possible: every entry is labelled
          // and the shape stops depending on the gains, so moving a band is an
          // `af-command` rather than a chain rebuild. See the effect below.
          { ...(options.chain ?? {}), editable: true }
        )
      : []
    return Object.freeze([...eq, ...(options.extraFilters ?? [])])
  }, [state.enabled, state.gainsDb, options.chain, options.extraFilters])

  /**
   * What the player is actually producing: the chain, and its compiled `af`
   * grammar. Comparing the compiled string — rather than the array identity —
   * is what makes an equivalent chain rebuilt by an unrelated re-render free.
   *
   * Not the same as "what mpv's `af` property says": in-place gain changes
   * deliberately leave the property behind until {@link COMMIT_DELAY_MS} later.
   * {@link committedRef} is that second fact.
   */
  const appliedRef = useRef<
    | {
        readonly player: Player
        readonly chain: readonly AudioFilter[]
        readonly compiled: string
      }
    | undefined
  >(undefined)
  /** The last chain actually written to the `af` property, for that player. */
  const committedRef = useRef<string | undefined>(undefined)
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )
  /** In-flight `af-command`s — see the write path for why they are counted. */
  const inFlightRef = useRef(0)
  /** A chain was written while commands were in flight; write it again. */
  const staleRef = useRef(false)
  /** Whether `af-command` works on this player. One failure answers it. */
  const inPlaceRef = useRef(true)

  /** Write the whole chain. The rebuild path — correct, and never smooth. */
  const write = useCallback(
    (target: Player, next: readonly AudioFilter[], compiled: string): void => {
      if (commitTimerRef.current !== undefined) {
        clearTimeout(commitTimerRef.current)
        commitTimerRef.current = undefined
      }
      try {
        // The managed half only. Anything the app set through
        // `setAudioFilters`, and the managed loudness entry, are composed
        // around this by the Player and are not ours to rewrite.
        target.setEqualizerFilters(next)
        appliedRef.current = { player: target, chain: next, compiled }
        committedRef.current = compiled
        // A command issued before this write may still be in mpv's queue, and
        // libmpv gives no ordering guarantee between an async command and a
        // property write that takes the core lock. Rather than reason about
        // it, note it and write again once the queue has drained.
        if (inFlightRef.current > 0) staleRef.current = true
        // Identity-stable when already clear, so a healthy re-apply is free.
        setError((previous) => (previous === undefined ? previous : undefined))
      } catch (thrown) {
        // Not recorded as applied: mpv kept the previous chain, so the next
        // change must be pushed even if it compiles to the same string.
        appliedRef.current = undefined
        committedRef.current = undefined
        setError(toPlayerError(thrown))
      }
    },
    []
  )

  /** Write the applied chain to `af` if the property has fallen behind it. */
  const commit = useCallback(
    (target: Player): void => {
      const applied = appliedRef.current
      if (
        target.destroyed ||
        applied === undefined ||
        applied.player !== target ||
        applied.compiled === committedRef.current
      ) {
        return
      }
      write(target, applied.chain, applied.compiled)
    },
    [write]
  )

  /** Arm (or re-arm) the write that makes mpv's `af` property true again. */
  const scheduleCommit = useCallback(
    (target: Player): void => {
      if (commitTimerRef.current !== undefined) {
        clearTimeout(commitTimerRef.current)
      }
      commitTimerRef.current = setTimeout(() => {
        commitTimerRef.current = undefined
        commit(target)
      }, COMMIT_DELAY_MS)
    },
    [commit]
  )

  useEffect(() => {
    if (player === undefined || player.destroyed || !hydrated) return
    const compiled = compileAudioFilters(chain)
    const applied = appliedRef.current
    const same = applied !== undefined && applied.player === player
    if (same && applied.compiled === compiled) return
    // A different player is a different engine: ask it again.
    if (!same) inPlaceRef.current = true

    // The fast path: same graph, different numbers. Push them into the running
    // filters instead of rebuilding the chain around them.
    const changes = same
      ? diffAudioFilterParams(applied.chain, chain)
      : undefined
    if (changes === undefined || changes.length === 0) {
      write(player, chain, compiled)
      return
    }

    appliedRef.current = { player, chain, compiled }
    // An engine that cannot take the commands is not a reason to go back to
    // rewriting the chain per frame — that is the thing that ruins playback.
    // It is a reason to stop pretending the change is live and let the commit
    // land it once the gesture settles.
    if (!inPlaceRef.current) {
      scheduleCommit(player)
      return
    }

    inFlightRef.current += 1
    void (async () => {
      let failed = false
      try {
        for (const change of changes) {
          await player.setAudioFilterParam(
            change.filter,
            change.param,
            change.value
          )
        }
      } catch {
        failed = true
      }
      // Decremented before either branch below, so that a rewrite issued from
      // here is not mistaken for one racing an in-flight command.
      inFlightRef.current -= 1
      const current = appliedRef.current
      if (player.destroyed || current?.player !== player) return
      if (failed) {
        // Not swallowed, and not retried: every failure mode is a property of
        // this player (no audio chain, an engine whose filters take nothing at
        // runtime), not of this one change. Stop using the fast path and let
        // the commit below carry the curve, which is correct — just not live.
        inPlaceRef.current = false
        scheduleCommit(player)
      } else if (inFlightRef.current === 0 && staleRef.current) {
        staleRef.current = false
        write(player, current.chain, current.compiled)
      }
    })()

    scheduleCommit(player)
  }, [player, hydrated, chain, write, commit, scheduleCommit])

  // Unmount is the last chance to make mpv's `af` property true again: an EQ
  // screen closed mid-drag must not leave the chain one rebuild away from
  // reverting. Mount-lifetime, not per-change — the effect above owns the
  // ordinary path.
  useEffect(() => {
    return () => {
      if (commitTimerRef.current !== undefined) {
        clearTimeout(commitTimerRef.current)
        commitTimerRef.current = undefined
      }
      const applied = appliedRef.current
      if (applied !== undefined) commit(applied.player)
    }
  }, [commit])

  /* ----------------------------- projections ----------------------------- */

  const bands = useMemo<readonly EqualizerBand[]>(
    () =>
      Object.freeze(
        state.gainsDb.map((gainDb, index) => ({
          frequency: EQUALIZER_BANDS[index] as number,
          gainDb,
        }))
      ),
    [state.gainsDb]
  )

  const presets = useMemo<readonly EqualizerPreset[]>(
    () => Object.freeze([...EQUALIZER_PRESET_LIST, ...state.savedPresets]),
    [state.savedPresets]
  )

  const preset = useMemo(
    () =>
      presets.find((candidate) => sameGains(candidate.gainsDb, state.gainsDb)),
    [presets, state.gainsDb]
  )

  /* ------------------------------ mutators ------------------------------- */

  // Every mutator is stable across renders: they read the live values through
  // refs and go through `setState`, whose identity React guarantees. That is
  // what lets the returned object keep its identity when nothing changed.

  const setEnabled = useCallback((enabled: boolean) => {
    setState((previous) =>
      previous.enabled === enabled ? previous : { ...previous, enabled }
    )
  }, [])

  const setBandGains = useCallback((gainsDb: readonly number[]) => {
    const clamped = clampGains(gainsDb, rangeRef.current)
    setState((previous) =>
      sameGains(previous.gainsDb, clamped)
        ? previous
        : { ...previous, gainsDb: clamped }
    )
  }, [])

  const setBandGain = useCallback((index: number, gainDb: number) => {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= EQUALIZER_BAND_COUNT
    ) {
      throw invalid(
        `setBandGain: index must be an integer in 0…${String(EQUALIZER_BAND_COUNT - 1)}, got ${String(index)}.`
      )
    }
    if (typeof gainDb !== 'number' || !Number.isFinite(gainDb)) {
      throw invalid(
        `setBandGain: gainDb must be a finite number, got ${String(gainDb)}.`
      )
    }
    const value = clamp(gainDb, rangeRef.current)
    setState((previous) => {
      if (previous.gainsDb[index] === value) return previous
      const gainsDb = [...previous.gainsDb]
      gainsDb[index] = value
      return { ...previous, gainsDb: Object.freeze(gainsDb) }
    })
  }, [])

  const applyPreset = useCallback(
    (candidate: string | EqualizerPreset) => {
      const resolved = resolvePreset(candidate, stateRef.current.savedPresets)
      setBandGains(resolved.gainsDb)
    },
    [setBandGains]
  )

  const reset = useCallback(() => {
    setBandGains(FLAT_GAINS)
  }, [setBandGains])

  const savePreset = useCallback((name: string): EqualizerPreset => {
    if (typeof name !== 'string' || name.trim() === '') {
      throw invalid('savePreset: name must be a non-empty string.')
    }
    const label = name.trim()
    // `defineEqualizerPreset` is the one place that validates a curve against
    // ffmpeg's ranges; going through it means a saved preset can never be
    // something the filter factory would later reject.
    const created = defineEqualizerPreset(
      `${SAVED_PRESET_PREFIX}${label}`,
      label,
      stateRef.current.gainsDb
    )
    setState((previous) => ({
      ...previous,
      savedPresets: Object.freeze([
        ...previous.savedPresets.filter((saved) => saved.id !== created.id),
        created,
      ]),
    }))
    return created
  }, [])

  const deletePreset = useCallback((id: string) => {
    if (!id.startsWith(SAVED_PRESET_PREFIX)) {
      throw invalid(
        `deletePreset: '${id}' is a built-in preset; only curves saved with \`savePreset\` can be deleted.`
      )
    }
    setState((previous) => {
      const savedPresets = previous.savedPresets.filter(
        (saved) => saved.id !== id
      )
      return savedPresets.length === previous.savedPresets.length
        ? previous
        : { ...previous, savedPresets: Object.freeze(savedPresets) }
    })
  }, [])

  return useMemo<Equalizer>(
    () => ({
      enabled: state.enabled,
      bands,
      gainsDb: state.gainsDb,
      gainRangeDb,
      preset,
      presets,
      savedPresets: state.savedPresets,
      error,
      hydrated,
      setEnabled,
      setBandGain,
      setBandGains,
      applyPreset,
      reset,
      savePreset,
      deletePreset,
    }),
    [
      state.enabled,
      state.gainsDb,
      state.savedPresets,
      bands,
      gainRangeDb,
      preset,
      presets,
      error,
      hydrated,
      setEnabled,
      setBandGain,
      setBandGains,
      applyPreset,
      reset,
      savePreset,
      deletePreset,
    ]
  )
}

/* -------------------------------------------------------------------------- */
/*                                  helpers                                   */
/* -------------------------------------------------------------------------- */

function invalid(message: string): PlayerErrorException {
  return new PlayerErrorException({
    code: 'invalid-state',
    message,
    retryable: false,
  })
}

/** A built-in id, a saved id, or the preset object itself. */
function resolvePreset(
  candidate: string | EqualizerPreset,
  saved: readonly EqualizerPreset[]
): EqualizerPreset {
  if (typeof candidate !== 'string') return candidate
  const builtIn = (
    EQUALIZER_PRESETS as Record<string, EqualizerPreset | undefined>
  )[candidate]
  const found = builtIn ?? saved.find((preset) => preset.id === candidate)
  if (found === undefined) {
    throw invalid(
      `'${candidate}' is not a known preset. Pass a built-in id (see EQUALIZER_PRESETS), a saved preset's id, or the preset object.`
    )
  }
  return found
}

function clamp(value: number, range: EqualizerGainRange): number {
  return Math.min(range.max, Math.max(range.min, value))
}

/**
 * Validate the shape once and clamp every entry.
 *
 * Length and finiteness throw — those are programming errors that would reach
 * an ffmpeg filter — while an out-of-range value clamps, because that is a
 * slider at its stop, not a bug.
 */
function clampGains(
  gainsDb: readonly number[],
  range: EqualizerGainRange
): readonly number[] {
  if (!Array.isArray(gainsDb) || gainsDb.length !== EQUALIZER_BAND_COUNT) {
    throw invalid(
      `gainsDb must have exactly ${String(EQUALIZER_BAND_COUNT)} entries (one per band in EQUALIZER_BANDS), got ${Array.isArray(gainsDb) ? String(gainsDb.length) : typeof gainsDb}.`
    )
  }
  return Object.freeze(
    gainsDb.map((gain, index) => {
      if (typeof gain !== 'number' || !Number.isFinite(gain)) {
        throw invalid(
          `gainsDb[${String(index)}] must be a finite number, got ${String(gain)}.`
        )
      }
      return clamp(gain, range)
    })
  )
}

function sameGains(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

function reportStorageError(
  onStorageError: ((cause: unknown) => void) | undefined,
  cause: unknown
): void {
  if (onStorageError !== undefined) {
    onStorageError(cause)
    return
  }
  console.warn(
    '[@timbre/player] useEqualizer: the storage adapter failed. Pass `onStorageError` to handle it.',
    cause
  )
}
