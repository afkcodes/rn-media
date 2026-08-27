/**
 * The one storage engine this app persists through — an **app choice, not the
 * library's**.
 *
 * `@afkcodes/timbre-media-session` and `@afkcodes/timbre-player` both take `{ getItem, setItem }`
 * structurally and depend on nothing; this app happens to use
 * `react-native-mmkv` (an example-only dependency) because it is *synchronous*,
 * so a broadcast is on disk before `setPlaybackState` returns — which is what
 * makes surviving `adb shell am force-stop` a certainty rather than a race.
 * AsyncStorage satisfies the same interface with one more `await`.
 */
import type { MediaSessionStorage } from '@afkcodes/timbre-media-session'
import type { EqualizerStorage } from '@afkcodes/timbre-player'
import { createMMKV } from 'react-native-mmkv'

const mmkv = createMMKV({ id: 'rn-media-example' })

/** Where `withPersistence` tees the three broadcast channels. */
export const sessionStorage: MediaSessionStorage = {
  getItem: (key) => mmkv.getString(key) ?? null,
  setItem: (key, value) => mmkv.set(key, value),
}

/**
 * The same engine again, handed to `useEqualizer` so the user's curve survives a
 * restart. Deliberately the *same object*: `EqualizerStorage` and
 * `MediaSessionStorage` are structurally identical, which is exactly what lets
 * one app-chosen engine serve both libraries — swap in AsyncStorage here and
 * both follow. Being synchronous pays again: `useEqualizer` reads it through
 * synchronously, so the first `af` write on launch is already the restored curve.
 */
export const equalizerStorage: EqualizerStorage = sessionStorage
