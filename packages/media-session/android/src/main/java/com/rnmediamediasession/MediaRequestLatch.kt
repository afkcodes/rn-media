package com.rnmediamediasession

/**
 * Swallows the one `play` media3 synthesises as part of a browse tap.
 *
 * ## The trap
 * A tap on a playable browse item does not arrive as "play". It arrives as
 * `onPlayFromMediaId` → `MediaSessionLegacyStub.handleMediaRequest`, which —
 * after `MediaSession.Callback.onSetMediaItems` answers — runs a fixed
 * sequence on the player (media3 1.11.0):
 *
 * ```java
 * MediaUtils.setMediaItemsWithStartIndexAndPosition(player, mediaItemsWithStartPosition);
 * if (prepare) { … player.prepareIfCommandAvailable(); }
 * if (play)    { player.playIfCommandAvailable(); }
 * ```
 *
 * For a real player that is correct: the items were just set, so play them. For
 * *this* player it is a duplicate with the wrong target — the app has already
 * been told `playFromMediaId(id)` and is loading the new queue, while
 * `player.play()` becomes `handlers.play()`, i.e. "resume what is current",
 * i.e. **the track the user just navigated away from**. The audible result is a
 * fraction of a second of the previous song before the new one starts, on a car
 * stereo.
 *
 * ## Why a same-turn latch is exact rather than a guess
 * The whole sequence runs inside one message on the media3 application looper:
 * `onSetMediaItems` returns an already-completed future, `Futures.addCallback`
 * with `postOrRunOnApplicationHandler` therefore runs **inline**, and the
 * synthesised `play` lands before the looper takes its next message. So the
 * window is not a duration to tune — it is "the rest of this turn", which is
 * what [postToNextTurn] closes.
 *
 * Pure, and unit-tested (`MediaRequestLatchTest`) by running the turns by hand.
 */
internal class MediaRequestLatch(private val postToNextTurn: (() -> Unit) -> Unit) {

  private var armed = false
  private var disarmScheduled = false

  /** Called from `onSetMediaItems`, before the app is told anything. */
  fun arm() {
    armed = true
    if (disarmScheduled) return
    disarmScheduled = true
    postToNextTurn {
      armed = false
      disarmScheduled = false
    }
  }

  /**
   * `true` when this `play` is the synthesised one and must not be forwarded.
   *
   * Consuming, not peeking: a media request produces exactly one `play`, and a
   * second one in the same turn is a real user gesture that deserves to reach
   * the app.
   */
  fun consume(): Boolean {
    val was = armed
    armed = false
    return was
  }
}
