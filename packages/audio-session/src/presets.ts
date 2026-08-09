import type { AudioSessionConfig } from './specs/audio-session.nitro'

/**
 * Recursively `Object.freeze` a value and return it unchanged, type included.
 *
 * The presets are module-level shared objects: one app mutating
 * `AudioSessionPresets.music.android` would silently change the configuration
 * every other caller in the process gets. Freezing turns that into a `TypeError`
 * in strict mode (and a no-op otherwise) instead of a ghost.
 *
 * The signature is `T => T` on purpose. Returning `Readonly<T>` would surface
 * `readonly IosAudioSessionCategoryOption[]` for `categoryOptions`, which is no
 * longer assignable to the bridge's mutable `IosAudioSessionCategoryOption[]` —
 * the presets would stop being usable as an {@link AudioSessionConfig}. Runtime
 * immutability is the goal here; the declared shape stays exactly as before.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value
  }
  // Freeze first, then recurse: a cyclic graph would otherwise not terminate.
  Object.freeze(value)
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

/**
 * Ready-made {@link AudioSessionConfig}s.
 *
 * The two presets exist to encode the duck-vs-pause distinction, which is the
 * only decision most apps ever have to make:
 *
 * - `music` — long-form media. Lets the system duck us automatically when a
 *   notification or navigation prompt cuts in (Android 8+ does this without
 *   ever calling us back), which is the right behaviour for music.
 * - `speech` — podcasts / audiobooks / anything spoken. Ducked speech is
 *   unintelligible, so we opt out of automatic ducking
 *   (`setWillPauseWhenDucked(true)`) and ask to be told instead, and we tag the
 *   content as speech on both platforms (`CONTENT_TYPE_SPEECH`,
 *   `AVAudioSession.Mode.spokenAudio`). Android's own docs single this case
 *   out: "automatic ducking is not performed when the user is listening to
 *   speech content" and "if you want your app to pause when asked to duck […]
 *   call setWillPauseWhenDucked(true)"
 *   (https://developer.android.com/media/optimize/audio-focus).
 *
 * NOTE: neither preset sets `interruptSpokenAudioAndMixWithOthers`. Apple
 * reserves that option for apps whose "audio is occasional and spoken, such as
 * in a turn-by-turn navigation app" — a podcast player is the app being
 * interrupted, not the one interrupting.
 */
export const AudioSessionPresets = deepFreeze({
  music: {
    ios: {
      category: 'playback',
      mode: 'defaultMode',
      categoryOptions: [],
      routeSharingPolicy: 'longFormAudio',
    },
    android: {
      usage: 'media',
      contentType: 'music',
      focusGain: 'gain',
      willPauseWhenDucked: false,
    },
  },
  speech: {
    ios: {
      category: 'playback',
      mode: 'spokenAudio',
      categoryOptions: [],
      routeSharingPolicy: 'longFormAudio',
    },
    android: {
      usage: 'media',
      contentType: 'speech',
      focusGain: 'gain',
      willPauseWhenDucked: true,
    },
  },
} satisfies Record<'music' | 'speech', AudioSessionConfig>)
