/**
 * The app's mirror of mpv's playlist, and the four operations that change it.
 *
 * ## Why a mirror exists at all
 * `PlayerState.playlist` is a **cursor** — index and count — not the contents.
 * That is a deliberate library decision (mirroring mpv's playlist array across
 * the bridge would be a second source of truth that can go stale), and it costs
 * nothing right up until the queue becomes editable. Then an index no longer
 * identifies a `TRACKS` entry, so the app has to keep its own model.
 *
 * ## Why it is rebuilt from mpv rather than updated locally
 * `playlist.shuffle()` permutes mpv's array and reports **nothing** about the
 * permutation, so there is no local edit that could reproduce it. Reading
 * `playlist/N/filename` back is the only honest answer, and once that path
 * exists it is also the right one for inserts and clears — one code path,
 * always agreeing with the engine.
 */
import type { Player } from '@rn-media/player'
import { MpvProperty, playlistFilenameProperty } from '@rn-media/player'
import { TRACKS, type Track } from '../data/tracks'

export interface QueueMirrorHooks {
  /** The player, or `undefined` before it exists. */
  readonly player: () => Player | undefined
  /** The mirror changed — re-broadcast channel 3 and re-render. */
  readonly onChange: (tracks: readonly Track[]) => void
  /** A queue command was accepted; used to clear a stale error banner. */
  readonly onEdited: () => void
  /** A queue command was rejected. Typed, surfaced, never swallowed. */
  readonly onError: (cause: unknown) => void
}

export class QueueMirror {
  readonly #hooks: QueueMirrorHooks
  #tracks: readonly Track[] = TRACKS
  #lastCount = -1

  constructor(hooks: QueueMirrorHooks) {
    this.#hooks = hooks
  }

  get tracks(): readonly Track[] {
    return this.#tracks
  }

  at(index: number): Track | undefined {
    return this.#tracks[index]
  }

  /**
   * Re-mirror when mpv's playlist length has moved without this app asking — an
   * insert that landed late, a `playlist-clear` from a remote surface.
   *
   * `count > 0` because the first snapshots arrive before `loadPlaylist` has
   * appended anything, and an empty mirror there would blank the queue card.
   */
  syncIfChanged(count: number): void {
    if (count === this.#lastCount || count <= 0) return
    this.#lastCount = count
    this.sync()
  }

  /** Rebuild from `playlist/N/filename`, which is the authority. */
  sync(): void {
    const player = this.#hooks.player()
    if (player === undefined) return
    try {
      const count = player.getPropertyNumber(MpvProperty.playlistCount) ?? 0
      if (count <= 0) return
      const next: Track[] = []
      for (let index = 0; index < count; index += 1) {
        const uri = player.getPropertyString(playlistFilenameProperty(index))
        next.push(matchTrack(uri) ?? unknownTrack(uri, index))
      }
      this.#lastCount = count
      this.#tracks = next
      this.#hooks.onChange(next)
    } catch (cause) {
      console.warn('[example] could not mirror the playlist:', cause)
    }
  }

  /**
   * "Play next" — one atomic `insert-next`, never append-then-move.
   *
   * The library maps this onto mpv's single `loadfile … insert-next` action.
   * The two-command emulation (`add` + `playlist-move`) has a window in between
   * where the queue is briefly wrong, which is observable through
   * `playlist-count` *and* readable by mpv's own prefetch, which consults the
   * queue on its own schedule.
   *
   * The honest caveat, from `PlaylistAddOptions`: if a prefetch is already
   * running, the inserted entry does not get one of its own, and at the boundary
   * mpv drops the in-flight prefetch and opens cold. Inserting well before the
   * current track ends is free.
   */
  async playNext(track: Track): Promise<void> {
    await this.#run((player) =>
      player.playlist.add(track.uri, { position: 'next' })
    )
  }

  /**
   * Shuffle everything, including the entry that is playing.
   *
   * mpv keeps the *entry* current, not the index, so the music does not stop —
   * but `playlist-pos` almost certainly changes and arrives as a `trackChanged`
   * for a track that did not change. Treat that event as "the cursor moved".
   */
  async shuffle(): Promise<void> {
    await this.#run((player) => player.playlist.shuffle())
  }

  /**
   * One level of undo, and only one.
   *
   * mpv restores the order by sorting on an `original_index` stamped at shuffle
   * time, so successive unshuffles do nothing. To return to a user-visible order
   * after several shuffles, keep that order in the app and rebuild with
   * `loadPlaylist`.
   */
  async unshuffle(): Promise<void> {
    await this.#run((player) => player.playlist.unshuffle())
  }

  /** Removes every entry *except* the one playing. */
  async clear(): Promise<void> {
    await this.#run((player) => player.playlist.clear())
  }

  async #run(action: (player: Player) => Promise<void>): Promise<void> {
    const player = this.#hooks.player()
    if (player === undefined) return
    try {
      await action(player)
      this.sync()
      this.#hooks.onEdited()
    } catch (cause) {
      this.#hooks.onError(cause)
    }
  }
}

/**
 * Find the `TRACKS` entry mpv is holding at a playlist slot.
 *
 * The `endsWith` fallback is deliberate insurance, not superstition: mpv
 * normalises the URI it hands back from a load hook, and a *relative local
 * path* is made absolute against the process working directory
 * (`mp_normalize_path`, mpv 0.41.0 `player/command.c:564`). Every URI in this
 * app is absolute, so the exact match is expected to win — but a prefixed
 * filename should degrade to the right row rather than to "unknown".
 */
function matchTrack(uri: string | undefined): Track | undefined {
  if (uri === undefined) return undefined
  return (
    TRACKS.find((track) => track.uri === uri) ??
    TRACKS.find((track) => uri.endsWith(track.uri))
  )
}

/** A queue row for something this app did not put there. */
function unknownTrack(uri: string | undefined, index: number): Track {
  return {
    id: `unknown-${index}`,
    title: uri ?? 'Unknown entry',
    artist: 'Not in TRACKS',
    uri: uri ?? '',
  }
}
