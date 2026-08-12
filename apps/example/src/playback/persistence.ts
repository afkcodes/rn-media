/**
 * Persistence glue: the storage engine, and reading back what the last process
 * left behind.
 *
 * Writing is one line and lives in the session bridge (`withPersistence`);
 * everything here is about the *read* on launch, which is the half with
 * branches worth showing.
 */
import { restorePersisted, type MediaSessionStorage } from '@rn-media/media-session'
import type { PersistedSession } from '@rn-media/media-session'
import { createMMKV } from 'react-native-mmkv'
import { TRACKS } from '../data/tracks'
import { formatTime } from '../components/SeekBar'

/**
 * Persistence storage for the media session — **an app-level choice, not the
 * library's**.
 *
 * `@rn-media/media-session` takes `{ getItem, setItem }` structurally and
 * depends on nothing; this app happens to use `react-native-mmkv` (an
 * example-only dependency) because it is *synchronous*, so a broadcast is on
 * disk before `setPlaybackState` returns — which is what makes surviving
 * `adb shell am force-stop` a certainty rather than a race. AsyncStorage
 * satisfies the same interface with two fewer lines and one more `await`.
 */
const mmkv = createMMKV({ id: 'rn-media-example' })

export const sessionStorage: MediaSessionStorage = {
  getItem: (key) => mmkv.getString(key) ?? null,
  setItem: (key, value) => mmkv.set(key, value),
}

/** Everything this launch recovered, in the shape the controller needs it. */
export interface RestoreOutcome {
  /** What `restorePersisted` handed back, for `applyPersisted` and the UI. */
  readonly session: PersistedSession | undefined
  /** Human-readable outcome, shown in the UI. */
  readonly note: string
  /** Track index to open on, recovered from the persisted session. */
  readonly resumeIndex: number | undefined
  /**
   * Position to seek to once mpv has actually opened the resumed entry.
   *
   * Not `loadPlaylist({ startPosition })`: that is mpv's per-file `start`
   * option and this player applies it to *every* entry appended, so the whole
   * queue would start 1:23 in. Seeking once, when the entry is ready, resumes
   * exactly one track.
   */
  readonly pendingResumeMs: number | undefined
}

const NOTHING: RestoreOutcome = {
  session: undefined,
  note: 'not attempted',
  resumeIndex: undefined,
  pendingResumeMs: undefined,
}

/**
 * Read back whatever the last process left behind.
 *
 * Every branch of `RestoreResult` is handled and none of them throws — that is
 * the point of the typed result. A first launch, an app downgrade and a
 * truncated write all land the app on the same happy path.
 */
export async function restoreSession(): Promise<RestoreOutcome> {
  try {
    const result = await restorePersisted(sessionStorage)
    switch (result.status) {
      case 'restored': {
        const { session } = result
        const id = session.mediaItem?.id
        const index = TRACKS.findIndex((t) => t.id === id)
        const positionMs = session.playbackState?.position.value ?? 0
        const age = Math.round((Date.now() - session.savedAt) / 1000)
        const note =
          `restored "${session.mediaItem?.title ?? '—'}" ` +
          `@ ${formatTime(positionMs / 1000)} ` +
          `· queue ${session.queue?.length ?? 0} · saved ${age}s ago`
        console.log(
          `[example] persistence: ${note}`,
          JSON.stringify(session.playbackState?.position)
        )
        return {
          session,
          note,
          resumeIndex: index >= 0 ? index : undefined,
          // `> 0` is the whole guard. A live entry is persisted at position
          // 0 by the session itself — it publishes no duration, which is the
          // library's live discriminator — so this app does not need its own
          // `track.live` check here, and would be wrong to trust one: the
          // authority on "is this seekable" is what was broadcast, not a
          // static flag in the queue file.
          pendingResumeMs: index >= 0 && positionMs > 0 ? positionMs : undefined,
        }
      }
      case 'empty':
        console.log('[example] persistence: nothing saved yet')
        return { ...NOTHING, note: 'nothing saved yet (first launch)' }
      case 'unsupportedVersion': {
        const note = `saved by schema v${result.found ?? '?'}, this build reads v${result.expected}`
        console.warn(`[example] persistence: ${note}`)
        return { ...NOTHING, note }
      }
      case 'corrupt': {
        const note = `corrupt record ignored: ${result.reason}`
        console.warn(`[example] persistence: ${note}`)
        return { ...NOTHING, note }
      }
    }
  } catch (cause) {
    // Only a broken storage engine reaches here — bad *data* is a result, not
    // an exception. Losing the saved session is survivable; hiding the reason
    // is not.
    console.error('[example] persistence: storage failed:', cause)
    return { ...NOTHING, note: 'storage unavailable' }
  }
}
