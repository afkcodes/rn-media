package com.rnmediamediasession

import androidx.media3.common.Player
import com.margelo.nitro.rnmediamediasession.MediaRepeatMode
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The two hand-written translations between this package's vocabulary and
 * media3's, plus the jump-interval conversion.
 *
 * All three are pure integer arithmetic over compile-time constants, so they run
 * on a plain JVM with nothing stubbed — which is the point: they are the places
 * where a wrong constant produces a *plausible* wrong behaviour (repeat-one
 * where the user asked for repeat-all, a 5-second jump where they asked for 15)
 * rather than a crash anyone would notice.
 */
class MappingTest {

  // MARK: - Repeat mode

  @Test
  fun `every repeat mode maps onto its media3 constant`() {
    assertEquals(Player.REPEAT_MODE_OFF, MediaRepeatMode.OFF.toMedia3())
    assertEquals(Player.REPEAT_MODE_ONE, MediaRepeatMode.ONE.toMedia3())
    assertEquals(Player.REPEAT_MODE_ALL, MediaRepeatMode.ALL.toMedia3())
  }

  @Test
  fun `the media3 constants round trip back to the same mode`() {
    for (mode in MediaRepeatMode.entries) {
      assertEquals(mode, mode.toMedia3().toRepeatMode())
    }
  }

  @Test
  fun `an unknown media3 repeat constant folds to off rather than being dropped`() {
    // media3's @RepeatMode IntDef has three members today. If a fourth ever
    // arrives, telling the app "off" gives it a state it can render; ignoring
    // the press would be a dead button on the notification.
    assertEquals(MediaRepeatMode.OFF, 99.toRepeatMode())
    assertEquals(MediaRepeatMode.OFF, (-1).toRepeatMode())
  }

  // MARK: - Jump intervals

  @Test
  fun `jump seconds become milliseconds`() {
    assertEquals(15_000L, 15.0.toJumpMs())
    assertEquals(30_000L, 30.0.toJumpMs())
    assertEquals(500L, 0.5.toJumpMs())
  }

  @Test
  fun `the shared default is 15 seconds, not media3's asymmetric pair`() {
    // C.DEFAULT_SEEK_BACK_INCREMENT_MS is 5_000 and
    // C.DEFAULT_SEEK_FORWARD_INCREMENT_MS is 15_000 (media3 1.11.0). Inheriting
    // that asymmetry while iOS pinned 15/15 IS the parity defect this option
    // exists to fix, so the fallback must be symmetric.
    assertEquals(15_000L, DEFAULT_JUMP_MS)
  }

  @Test
  fun `a nonsensical jump interval falls back to the default, never to zero`() {
    // Rejected in TS; reachable here only from a mirrored config written by a
    // different version. A zero-length jump is a button that looks broken.
    assertEquals(DEFAULT_JUMP_MS, 0.0.toJumpMs())
    assertEquals(DEFAULT_JUMP_MS, (-5.0).toJumpMs())
    assertEquals(DEFAULT_JUMP_MS, Double.NaN.toJumpMs())
    assertEquals(DEFAULT_JUMP_MS, Double.POSITIVE_INFINITY.toJumpMs())
  }
}
