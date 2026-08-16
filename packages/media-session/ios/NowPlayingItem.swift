//
//  NowPlayingItem.swift
//  RnMediaMediaSession
//
//  Which single item the now-playing surface describes, resolved from the two
//  metadata channels the app broadcasts.
//

import Foundation

/**
 * The current item as the lock screen should see it: the queue entry at the
 * broadcast index, with the `setMediaItem` channel overlaid field by field.
 *
 * ## The defect this exists to fix
 * The iOS side used to publish `setMediaItem` and *nothing else*. Two
 * consequences, both app-visible and both silent:
 *
 * 1. An app that broadcast a queue plus a `queueIndex` and no `setMediaItem`
 *    got a **blank lock screen** on iOS, while Android showed the queue entry
 *    (`Snapshot.baseTimeline`). Queue-only broadcasting is a perfectly ordinary
 *    shape — it is what `QueueHandler` produces before a track is prepared.
 * 2. An app that broadcast both got only what the *item* carried: a queue rich
 *    in `artist`/`artworkUri` plus a `setMediaItem` carrying `{id, title,
 *    duration}` — the normal split, because durations are learned late — lost
 *    the artist and the artwork on iOS and kept them on Android.
 *
 * Android has had the merge since `enrichedWith` was introduced. This is its
 * twin, and the rule is deliberately identical, mismatch behaviour included.
 *
 * ## Why this is not a merged `NativeMediaItem`
 * `NativeMediaItem` is a C++-backed bridge struct; building one per broadcast
 * would allocate through the interop layer to produce a value only this file
 * reads. A plain Swift value with exactly the fields iOS can publish is cheaper,
 * `Equatable`, and cannot accidentally be handed back across the bridge.
 *
 * `year`, `subtitle` and `extras` are absent on purpose: MediaPlayer has no key
 * for any of them (see `NativeMediaItem`'s TSDoc), so there is nothing for a
 * merge to feed. They round-trip through the JS layer's persistence untouched.
 */
struct NowPlayingItem: Equatable {
  let id: String
  let title: String
  let artist: String?
  let album: String?
  let genre: String?
  let albumArtist: String?
  let trackNumber: Double?
  let discNumber: Double?
  let artworkUri: String?
  let duration: Double?
  let isLive: Bool?

  /**
   * The duration to act on, in milliseconds, or `nil` when there is none.
   *
   * `isLive` wins over a duration the app also sent — the Swift twin of Kotlin's
   * `NativeMediaItem.effectiveDurationMs`, and the one place liveness is decided
   * so the scrubber, the seekability and the end-of-track sleep timer cannot
   * disagree about it.
   */
  var effectiveDurationMs: Double? {
    isLive == true ? nil : duration
  }

  /// A queue entry (or a bare `setMediaItem`) with nothing overlaid.
  init(_ item: NativeMediaItem) {
    id = item.id
    title = item.title
    artist = item.artist
    album = item.album
    genre = item.genre
    albumArtist = item.albumArtist
    trackNumber = item.trackNumber
    discNumber = item.discNumber
    artworkUri = item.artworkUri
    duration = item.duration
    isLive = item.isLive
  }

  /**
   * The channel-priority rule, field by field: **what the overlay carries wins,
   * what it omits falls back to the base.**
   *
   * The base is the queue entry, the overlay is `setMediaItem`. The caller must
   * have checked that the two describe the same track (equal ids) — merging
   * across ids would paste one track's metadata onto another. See
   * ``NowPlaying/resolve(item:queue:queueIndex:)``.
   *
   * `title` is the one non-optional field, so "absent" cannot be expressed as
   * `nil`; a blank title is treated as absent rather than allowed to blank out a
   * perfectly good queue title. Same rule as Kotlin's `item.title.ifBlank { … }`.
   */
  init(base: NativeMediaItem, overlay: NativeMediaItem) {
    // Equal by precondition; the queue's identity stays authoritative for the
    // timeline position it belongs to.
    id = base.id
    title = overlay.title.isBlankForMerge ? base.title : overlay.title
    artist = overlay.artist ?? base.artist
    album = overlay.album ?? base.album
    genre = overlay.genre ?? base.genre
    albumArtist = overlay.albumArtist ?? base.albumArtist
    trackNumber = overlay.trackNumber ?? base.trackNumber
    discNumber = overlay.discNumber ?? base.discNumber
    artworkUri = overlay.artworkUri ?? base.artworkUri
    duration = overlay.duration ?? base.duration
    isLive = overlay.isLive ?? base.isLive
  }
}

/**
 * The resolved current item, plus the timeline position it sits at.
 *
 * The pair is what identifies "the thing playing" for the end-of-track sleep
 * timer: ids legitimately repeat inside a queue and the index alone moves under
 * a queue edit that changed nothing, so neither half is sufficient by itself.
 * Same reasoning, same shape, as Kotlin's `Snapshot.currentItemKey`.
 */
struct NowPlaying: Equatable {
  let index: Int
  let item: NowPlayingItem
  /**
   * Non-`nil` when `setMediaItem` described something that is **not** the queue
   * entry at the broadcast index — a human-readable description of the
   * disagreement, for the caller to log once.
   *
   * It means the item's fields (typically its duration, and with it the
   * scrubber) are being dropped rather than merged, which is almost always the
   * two broadcasts having got out of step. Reported as data rather than logged
   * here so this type stays a pure value.
   */
  let mismatch: String?

  var key: String { "\(index):\(item.id)" }

  /**
   * Pick the entry the now-playing surface describes, and merge the two
   * metadata channels onto it.
   *
   * Deliberately the same three cases, in the same priority order, as Kotlin's
   * `Snapshot.baseTimeline` — the two platforms disagreeing about *which* item
   * is current is exactly the class of bug this package exists to prevent:
   *
   * 1. A valid `queueIndex` into a non-empty queue — the normal case. The queue
   *    entry is the base and `setMediaItem` is overlaid onto it when the ids
   *    agree. **When they do not, the queue entry wins unchanged**, which is
   *    Android's behaviour verbatim.
   * 2. No usable queue position but a `setMediaItem` — ad-hoc playback, and the
   *    window between `setMediaItem` and the `setPlaybackState` carrying the new
   *    index. The item is the whole timeline; there is nothing to merge into.
   * 3. Neither — the first queue entry if there is one, otherwise `nil`, which
   *    is how "clear the now-playing info" is said.
   */
  static func resolve(
    item: NativeMediaItem?,
    queue: [NativeMediaItem],
    queueIndex: Int
  ) -> NowPlaying? {
    if queueIndex >= 0, queueIndex < queue.count {
      let base = queue[queueIndex]
      guard let overlay = item else {
        return NowPlaying(index: queueIndex, item: NowPlayingItem(base), mismatch: nil)
      }
      if overlay.id == base.id {
        return NowPlaying(
          index: queueIndex,
          item: NowPlayingItem(base: base, overlay: overlay),
          mismatch: nil
        )
      }
      return NowPlaying(
        index: queueIndex,
        item: NowPlayingItem(base),
        mismatch: "item id '\(overlay.id)' vs queue[\(queueIndex)] id '\(base.id)'"
      )
    }
    if let overlay = item {
      return NowPlaying(index: 0, item: NowPlayingItem(overlay), mismatch: nil)
    }
    guard let first = queue.first else { return nil }
    return NowPlaying(index: 0, item: NowPlayingItem(first), mismatch: nil)
  }
}

private extension String {
  /// Kotlin's `String.isBlank()`: empty, or nothing but whitespace.
  var isBlankForMerge: Bool {
    allSatisfy { $0.isWhitespace }
  }
}
