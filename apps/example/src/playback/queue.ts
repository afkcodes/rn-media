/**
 * The app's view of mpv's queue, and the four operations that change it.
 *
 * ## Why the app keeps a list at all
 * `PlayerState.playlist` is a **cursor** — index and count — not the contents.
 * That is deliberate: mirroring mpv's playlist array across the bridge on every
 * edit would put a variable-size payload on the hot path and make the snapshot a
 * second copy of state mpv already owns. So the *contents* are a pull, and the
 * app joins them to its own `TRACKS` metadata here.
 *
 * ## What this file used to be
 * A hand-rolled walk: `playlist-count`, then `playlist/N/filename` for every
 * `N`. That is `N + 1` blocking round-trips into mpv's core, and — worse — it is
 * not *coherent*: a `playlist-move` landing halfway through the walk returns two
 * halves of two different orders. `player.playlist.entries()` replaced it with
 * **one** `mpv_get_property("playlist", MPV_FORMAT_NODE)`, which mpv builds under
 * its own lock, so the answer is one generation of the queue whatever else is
 * happening. Same information, constant cost, and no way to read a torn list.
 *
 * ## Identity, not position
 * Rows are joined to `TRACKS` by **URI**, and carry mpv's `entryId` — "unique
 * for the entire life time of the current mpv core instance", and stable across
 * inserts, removes, moves and shuffles. An `index → metadata` map would be
 * silently one row off from the first "play next" onwards: the queue stays
 * correct and the labels do not, which shows up later as the wrong artwork on
 * the wrong song.
 */
import type { Player, PlaylistEntry } from '@rn-media/player'
import { TRACKS, type Track } from '../data/tracks'

/** One queue row: what mpv holds, joined to what this app knows about it. */
export interface QueueRow {
  /** mpv's entry id — the identity that survives every queue edit. */
  readonly entryId: number
  /** Whether `playlist-current-pos` points at this entry. */
  readonly current: boolean
  /** The app's metadata for it, or a placeholder for something it did not queue. */
  readonly track: Track
}

export interface QueueMirrorHooks {
  /** The player, or `undefined` before it exists. */
  readonly player: () => Player | undefined
  /** The queue changed — re-broadcast channel 3 and re-render. */
  readonly onChange: (rows: readonly QueueRow[]) => void
  /** A queue command was accepted; used to clear a stale error banner. */
  readonly onEdited: () => void
  /** A queue command was rejected. Typed, surfaced, never swallowed. */
  readonly onError: (cause: unknown) => void
}

export class QueueMirror {
  readonly #hooks: QueueMirrorHooks
  #rows: readonly QueueRow[] = TRACKS.map((track, index) => ({
    entryId: -1 - index,
    current: index === 0,
    track,
  }))

  constructor(hooks: QueueMirrorHooks) {
    this.#hooks = hooks
  }

  get rows(): readonly QueueRow[] {
    return this.#rows
  }

  get tracks(): readonly Track[] {
    return this.#rows.map((row) => row.track)
  }

  at(index: number): Track | undefined {
    return this.#rows[index]?.track
  }

  /**
   * Re-read the queue from mpv.
   *
   * Called from the player's `queueChanged` event, which is what says "the
   * contents moved" — `'resized'` for an add/remove/clear (mpv's observed
   * `playlist-count`), `'reordered'` for a move/shuffle/unshuffle (which change
   * no observable property at all, so the library emits it from the methods).
   * Not on a timer, and not per render.
   */
  sync(): void {
    const player = this.#hooks.player()
    if (player === undefined) return
    try {
      this.#adopt(player.playlist.entries())
    } catch (cause) {
      console.warn('[example] could not read the playlist:', cause)
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
   * "Add to end" — the plain `append` cell of `loadfile`'s table, and the
   * counterpart the queue list shows next to {@link playNext} so both insert
   * positions are one tap away. Duplicates are legal and expected: the row's
   * identity is mpv's `entryId`, and the media-session queue channel carries
   * the same id twice without complaint (see `NativeMediaItem.id`).
   */
  async addLast(track: Track): Promise<void> {
    await this.#run((player) => player.playlist.add(track.uri))
  }

  /**
   * Remove one entry. Removing the *current* one stops it and starts the next
   * — mpv's rule, not ours, and the queue list says so in its footnote.
   */
  async remove(index: number): Promise<void> {
    await this.#run((player) => player.playlist.remove(index))
  }

  /**
   * Shuffle everything, including the entry that is playing.
   *
   * mpv keeps the *entry* current, not the index, so the music does not stop —
   * but `playlist-pos` almost certainly changes and arrives as a `trackChanged`
   * for a track that did not change. Treat that event as "the cursor moved".
   *
   * Note there is no follow-up read here: `shuffle()` **returns the resulting
   * order**, because mpv's `playlist-shuffle` reports nothing about the
   * permutation it performed and an app's only alternative was to guess.
   */
  async shuffle(): Promise<void> {
    await this.#run(async (player) => {
      this.#adopt(await player.playlist.shuffle())
    })
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
    await this.#run(async (player) => {
      this.#adopt(await player.playlist.unshuffle())
    })
  }

  /** Removes every entry *except* the one playing. */
  async clear(): Promise<void> {
    await this.#run((player) => player.playlist.clear())
  }

  /** Join mpv's entries to `TRACKS` and publish, skipping an empty answer. */
  #adopt(entries: readonly PlaylistEntry[]): void {
    // `[]` is what an idle core answers, and blanking the queue list because
    // mpv has not been given a playlist yet would be a worse lie than being one
    // event stale.
    if (entries.length === 0) return
    this.#rows = entries.map((entry, index) => ({
      entryId: entry.entryId,
      current: entry.current,
      track: matchTrack(entry.uri) ?? unknownTrack(entry.uri, index),
    }))
    this.#hooks.onChange(this.#rows)
  }

  async #run(action: (player: Player) => Promise<void>): Promise<void> {
    const player = this.#hooks.player()
    if (player === undefined) return
    try {
      await action(player)
      // `shuffle`/`unshuffle` already adopted their own answer; for the rest
      // this is the one read that follows the edit. `queueChanged` will also
      // fire, and a second read of an unchanged queue is idempotent.
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
function matchTrack(uri: string): Track | undefined {
  return (
    TRACKS.find((track) => track.uri === uri) ??
    // mpv normalises `file://` URIs to bare paths before handing them back
    // (observed on device: `file:///product/media/...` came back as
    // `/product/media/...`, and the row rendered "Not in TRACKS"). Compare
    // with the scheme stripped from both sides.
    TRACKS.find((track) => stripFileScheme(track.uri) === stripFileScheme(uri)) ??
    TRACKS.find((track) => uri.endsWith(track.uri))
  )
}

/** `file:///x` → `/x`; anything else unchanged. */
function stripFileScheme(uri: string): string {
  return uri.startsWith('file://') ? uri.slice('file://'.length) : uri
}

/** A queue row for something this app did not put there. */
function unknownTrack(uri: string, index: number): Track {
  return {
    id: `unknown-${index}`,
    title: uri === '' ? 'Unknown entry' : uri,
    artist: 'Not in TRACKS',
    uri,
  }
}
