/**
 * Persisting an equaliser: the record, its schema version, and the pure
 * serialise/parse pair `useEqualizer` drives.
 *
 * ## Why the storage engine is injected
 *
 * The library that picks a storage engine makes half its users ship two. So
 * this package gains **zero dependencies** from persistence — exactly the
 * precedent `@timbre/media-session` set with `MediaSessionStorage`, and for
 * the same reason. `AsyncStorage`, `react-native-mmkv`, `expo-sqlite/kv-store`
 * and a five-line in-memory map all already satisfy
 * {@link EqualizerStorage} structurally.
 *
 * ## Why it is not native
 *
 * The library we were audited against writes its custom presets to
 * `SharedPreferences` from Kotlin. That buys a preset bank that survives an app
 * update and costs an Android-only code path with no iOS twin — a platform-cap
 * compromise, which this project does not take. Ten numbers and a name are
 * JSON; JSON is what every RN storage engine already stores; and the caller
 * chooses the engine.
 *
 * @packageDocumentation
 */

import { EQUALIZER_BAND_COUNT } from './equalizer-presets'
import type { EqualizerPreset } from './equalizer-presets'

/**
 * Where an equaliser is written. **Injected, structurally typed, and never
 * depended on** — the same two-method shape as
 * `@timbre/media-session`'s `MediaSessionStorage`, deliberately, so an app
 * can hand both libraries the same object.
 *
 * Both methods may be synchronous or return a promise; `useEqualizer` handles
 * either.
 *
 * @example
 * ```ts
 * import AsyncStorage from '@react-native-async-storage/async-storage'
 * useEqualizer(player, { storage: AsyncStorage })          // async
 *
 * const mmkv = createMMKV({ id: 'eq' })
 * useEqualizer(player, {                                    // sync
 *   storage: {
 *     getItem: (k) => mmkv.getString(k) ?? null,
 *     setItem: (k, v) => mmkv.set(k, v),
 *   },
 * })
 * ```
 */
export interface EqualizerStorage {
  /** `null` (not `undefined`) for "nothing stored" — AsyncStorage's contract. */
  getItem(key: string): Promise<string | null> | string | null
  setItem(key: string, value: string): Promise<void> | void
}

/**
 * Version stamped into every record and required on the way back in.
 *
 * A reader that finds a version it does not know returns
 * {@link EqualizerRestoreResult} `unsupportedVersion` rather than guessing —
 * the whole point of the field. Bumped whenever the persisted shape changes in
 * a way an older reader would mis-read.
 *
 * ## Version history
 * - **1** — `{ enabled, gainsDb, presets }`.
 */
export const EQUALIZER_SCHEMA_VERSION = 1

/**
 * Default storage key. Namespaced so it cannot collide with the app's own, and
 * distinct from the media-session key so one engine can hold both.
 */
export const DEFAULT_EQUALIZER_STORAGE_KEY = 'rn-media.player.equalizer'

/**
 * Everything about an equaliser worth surviving a process death: whether it is
 * on, the curve it is set to, and the curves the user saved.
 *
 * Note what is *not* here — the built-in presets. They ship with the library
 * and are re-read from it on every launch, so an upgrade that retunes `Rock`
 * takes effect rather than being pinned forever by an old record.
 */
export interface EqualizerSettings {
  /** Whether the EQ half of the filter chain is applied at all. */
  readonly enabled: boolean
  /**
   * Exactly {@link EQUALIZER_BAND_COUNT} gains in dB, low band first — the
   * live curve, whether it came from a preset or from the user's sliders.
   */
  readonly gainsDb: readonly number[]
  /** The curves the user saved with `Equalizer.savePreset`, in save order. */
  readonly presets: readonly EqualizerPreset[]
}

/**
 * What {@link parseEqualizerSettings} found. A typed result, never a throw: a
 * corrupt record is an ordinary runtime condition (a half-written file, an app
 * downgrade, a user clearing storage), and an app whose EQ screen has to
 * `try/catch` its cold start will eventually not.
 *
 * A *storage* failure is different — that is a broken dependency, not bad data,
 * and it reaches the caller through `UseEqualizerOptions.onStorageError`.
 */
export type EqualizerRestoreResult =
  | { readonly status: 'restored'; readonly settings: EqualizerSettings }
  /** Nothing has been saved yet. */
  | { readonly status: 'empty' }
  /** Written by a different schema version. `found` is `undefined` if it was not a number. */
  | {
      readonly status: 'unsupportedVersion'
      readonly found: number | undefined
      readonly expected: number
    }
  /** Unparseable, or parsed into something that is not a usable equaliser. */
  | { readonly status: 'corrupt'; readonly reason: string }

/** The on-disk record. Internal — the version field is the compatibility contract. */
interface EqualizerRecord {
  v: number
  enabled: boolean
  gainsDb: number[]
  presets: EqualizerPreset[]
}

/**
 * Turn settings into the exact string {@link parseEqualizerSettings} reads
 * back.
 *
 * Pure, and separated from the hook precisely so the round-trip is testable
 * without React, a device or a storage engine.
 *
 * @param settings - What to write.
 * @returns A JSON record stamped with {@link EQUALIZER_SCHEMA_VERSION}.
 */
export function serializeEqualizerSettings(
  settings: EqualizerSettings
): string {
  const record: EqualizerRecord = {
    v: EQUALIZER_SCHEMA_VERSION,
    enabled: settings.enabled,
    gainsDb: [...settings.gainsDb],
    presets: settings.presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      gainsDb: [...preset.gainsDb],
    })),
  }
  return JSON.stringify(record)
}

/**
 * Read back what {@link serializeEqualizerSettings} wrote.
 *
 * @param raw - The stored string, or `null` for "nothing stored" (which is what
 * every `getItem` contract returns for a missing key).
 * @returns See {@link EqualizerRestoreResult}. Validation is deliberately
 * strict about the *curve* — a wrong-length or non-finite `gainsDb` would be
 * written straight into an ffmpeg filter — and forgiving about the preset
 * bank: an individual bad preset is dropped, because losing one saved curve is
 * a better outcome than refusing to restore the user's EQ at all.
 */
export function parseEqualizerSettings(
  raw: string | null | undefined
): EqualizerRestoreResult {
  if (raw === null || raw === undefined || raw === '') {
    return { status: 'empty' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (thrown) {
    return {
      status: 'corrupt',
      reason: `not JSON: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'corrupt', reason: 'record is not an object' }
  }

  const record = parsed as Partial<EqualizerRecord>
  if (record.v !== EQUALIZER_SCHEMA_VERSION) {
    return {
      status: 'unsupportedVersion',
      found: typeof record.v === 'number' ? record.v : undefined,
      expected: EQUALIZER_SCHEMA_VERSION,
    }
  }

  const gainsDb = validGains(record.gainsDb)
  if (gainsDb === undefined) {
    return {
      status: 'corrupt',
      reason: `gainsDb must be ${String(EQUALIZER_BAND_COUNT)} finite numbers`,
    }
  }
  if (typeof record.enabled !== 'boolean') {
    return { status: 'corrupt', reason: 'enabled must be a boolean' }
  }

  const presets: EqualizerPreset[] = []
  if (Array.isArray(record.presets)) {
    for (const candidate of record.presets) {
      const preset = validPreset(candidate)
      if (preset !== undefined) presets.push(preset)
    }
  }

  return {
    status: 'restored',
    settings: {
      enabled: record.enabled,
      gainsDb,
      presets,
    },
  }
}

/** `gainsDb` if it is exactly one finite number per band, else `undefined`. */
function validGains(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length !== EQUALIZER_BAND_COUNT) {
    return undefined
  }
  const gains: number[] = []
  for (const gain of value) {
    if (typeof gain !== 'number' || !Number.isFinite(gain)) return undefined
    gains.push(gain)
  }
  return gains
}

/** One stored preset, or `undefined` if it is not usable. */
function validPreset(value: unknown): EqualizerPreset | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<EqualizerPreset>
  if (typeof candidate.id !== 'string' || candidate.id === '') return undefined
  if (typeof candidate.name !== 'string' || candidate.name === '') {
    return undefined
  }
  const gainsDb = validGains(candidate.gainsDb)
  if (gainsDb === undefined) return undefined
  return Object.freeze({
    id: candidate.id,
    name: candidate.name,
    gainsDb: Object.freeze(gainsDb),
  })
}
