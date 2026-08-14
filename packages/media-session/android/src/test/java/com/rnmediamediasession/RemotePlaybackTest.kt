package com.rnmediamediasession

import androidx.media3.common.Player
import com.margelo.nitro.rnmediamediasession.NativeRemotePlayback
import com.margelo.nitro.rnmediamediasession.RemoteVolumeControl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The remote-output mapping: a normalised `0..1` level from JavaScript becoming
 * the integer device volume Android's `VolumeProvider` reports, and the
 * device-volume commands that decide whether the hardware volume keys reach the
 * app at all.
 *
 * Both halves are pure — arithmetic and a `when` over compile-time constants —
 * so they run on a plain JVM, and both are places where being wrong is
 * *plausible* rather than loud: a mis-scaled volume shows a speaker at 5 %
 * while it plays at full, and a missing command produces a volume rocker that
 * silently moves the phone's own stream instead of the speaker, which is
 * exactly the bug this feature exists to fix.
 */
class RemotePlaybackTest {

  private fun remote(
    volume: Double = 0.5,
    muted: Boolean = false,
    steps: Double = 20.0,
    volumeControl: RemoteVolumeControl = RemoteVolumeControl.ABSOLUTE,
    routingControllerId: String? = null,
    holdLocalAudioSlot: Boolean = false,
  ) =
    NativeRemotePlayback(
      volume,
      muted,
      steps,
      volumeControl,
      routingControllerId,
      holdLocalAudioSlot,
    )

  // MARK: - Level → notches

  @Test
  fun `a normalised level becomes the matching notch`() {
    assertEquals(0, remote(volume = 0.0).toDevice().volume)
    assertEquals(10, remote(volume = 0.5).toDevice().volume)
    assertEquals(20, remote(volume = 1.0).toDevice().volume)
    assertEquals(20, remote(volume = 1.0).toDevice().maxVolume)
  }

  @Test
  fun `an off-grid level rounds to the nearest notch rather than truncating`() {
    // A speaker's own knob lands anywhere. Truncating would make every
    // read-back one notch quieter than the device actually is, which is
    // invisible until someone compares the phone with the speaker.
    assertEquals(7, remote(volume = 0.37).toDevice().volume)
    assertEquals(8, remote(volume = 0.38).toDevice().volume)
  }

  @Test
  fun `the step count is honoured, not assumed`() {
    assertEquals(1, remote(volume = 0.25, steps = 4.0).toDevice().volume)
    assertEquals(4, remote(volume = 1.0, steps = 4.0).toDevice().volume)
  }

  @Test
  fun `mute and the routing controller id ride along untouched`() {
    val device = remote(muted = true, routingControllerId = "rc-7").toDevice()

    assertTrue(device.muted)
    assertEquals("rc-7", device.routingControllerId)
    assertNull(remote().toDevice().routingControllerId)
  }

  // MARK: - The local audio slot (bug #53)

  @Test
  fun `holding the local audio slot is opt-in, and off unless asked for`() {
    // It opens a real audio output for the whole remote session, so an app
    // that never mentions it must not pay the battery for it.
    assertFalse(remote().toDevice().holdLocalAudioSlot)
    assertFalse(shouldHoldLocalAudioSlot(remote().toDevice()))

    assertTrue(remote(holdLocalAudioSlot = true).toDevice().holdLocalAudioSlot)
    assertTrue(shouldHoldLocalAudioSlot(remote(holdLocalAudioSlot = true).toDevice()))
  }

  @Test
  fun `clearing remote playback releases the slot`() {
    // `setRemotePlayback(null)` means the phone has the audio back, so the
    // platform's "last played locally" slot is no longer worth holding — and a
    // track that outlived the session would be a pure battery leak.
    assertFalse(shouldHoldLocalAudioSlot(null))
  }

  @Test
  fun `a nonsense step count cannot produce a zero-width range`() {
    // TypeScript rejects these before they get here; a value arriving some
    // other way (an older bridge, a bug) must still not build a `DeviceInfo`
    // with maxVolume = 0, which renders as a dead slider rather than an error.
    assertEquals(1, remote(volume = 1.0, steps = 0.0).toDevice().maxVolume)
    assertEquals(1, remote(volume = 1.0, steps = -5.0).toDevice().maxVolume)
    assertEquals(1, remote(volume = 1.0, steps = Double.NaN).toDevice().maxVolume)
  }

  @Test
  fun `a nonsense level is clamped into the range rather than escaping it`() {
    assertEquals(20, remote(volume = 4.0).toDevice().volume)
    assertEquals(0, remote(volume = -1.0).toDevice().volume)
    assertEquals(0, remote(volume = Double.NaN).toDevice().volume)
  }

  // MARK: - Notches → level (the way back, for a slider drag)

  @Test
  fun `an integer device volume round trips back to the level it came from`() {
    val device = remote(volume = 0.35).toDevice()

    assertEquals(0.35, device.levelOf(device.volume), 1e-9)
    assertEquals(0.0, device.levelOf(0), 1e-9)
    assertEquals(1.0, device.levelOf(device.maxVolume), 1e-9)
  }

  @Test
  fun `a device volume outside the range is clamped, never extrapolated`() {
    val device = remote().toDevice()

    assertEquals(1.0, device.levelOf(99), 1e-9)
    assertEquals(0.0, device.levelOf(-3), 1e-9)
  }

  // MARK: - Commands
  //
  // Asserted on the *decision* (`deviceVolumeCommands`) and the *constants*
  // (`toMedia3`) rather than on a built `Player.Commands`, because a built one
  // proves nothing here: media3's `FlagSet` is backed by
  // `android.util.SparseBooleanArray`, which the stub `android.jar` no-ops, so
  // a JVM assertion on `Commands.contains(...)` is `false` whatever the code
  // did. That the two halves are actually wired into `MediaButtons.commands`
  // is what the device round proves.

  @Test
  fun `a local session implies no device-volume command at all`() {
    // The compatibility guarantee, asserted: media3 returns a null volume
    // provider for a LOCAL DeviceInfo before it looks at any command, so an app
    // that never publishes a remote device is untouched by this whole feature.
    assertTrue(deviceVolumeCommands(null).isEmpty())
  }

  @Test
  fun `an absolute device implies the getter, the nudge and the setter`() {
    assertEquals(
      listOf(
        // Not decorative: `PlayerWrapper.getDeviceVolumeWithCommandCheck`
        // returns a hard 0 without it, so the speaker would read as silent.
        DeviceVolumeCommand.GET,
        // The nudge is what a hardware key press becomes.
        DeviceVolumeCommand.ADJUST,
        DeviceVolumeCommand.ADJUST_WITH_FLAGS,
        // The setter upgrades the provider to VOLUME_CONTROL_ABSOLUTE, which is
        // what draws the system's remote volume slider.
        DeviceVolumeCommand.SET,
        DeviceVolumeCommand.SET_WITH_FLAGS,
      ),
      deviceVolumeCommands(remote().toDevice()),
    )
  }

  @Test
  fun `a relative device gets the keys but no slider`() {
    assertEquals(
      listOf(
        DeviceVolumeCommand.GET,
        DeviceVolumeCommand.ADJUST,
        DeviceVolumeCommand.ADJUST_WITH_FLAGS,
      ),
      deviceVolumeCommands(remote(volumeControl = RemoteVolumeControl.RELATIVE).toDevice()),
    )
  }

  @Test
  fun `a fixed device is readable and nothing more`() {
    // Deliberately dead keys: the app said it cannot drive this volume, and
    // pretending otherwise would move a number nothing acts on.
    assertEquals(
      listOf(DeviceVolumeCommand.GET),
      deviceVolumeCommands(remote(volumeControl = RemoteVolumeControl.FIXED).toDevice()),
    )
  }

  // Two of the four constants are deprecated upstream in favour of their
  // `_WITH_FLAGS` twins and are advertised anyway — see `toMedia3`, and media3's
  // own `RemoteCastPlayer.PERMANENT_AVAILABLE_COMMANDS`, which does the same.
  @Suppress("DEPRECATION")
  @Test
  fun `every command maps onto its media3 constant`() {
    assertEquals(Player.COMMAND_GET_DEVICE_VOLUME, DeviceVolumeCommand.GET.toMedia3())
    assertEquals(
      Player.COMMAND_ADJUST_DEVICE_VOLUME,
      DeviceVolumeCommand.ADJUST.toMedia3(),
    )
    assertEquals(
      Player.COMMAND_ADJUST_DEVICE_VOLUME_WITH_FLAGS,
      DeviceVolumeCommand.ADJUST_WITH_FLAGS.toMedia3(),
    )
    assertEquals(Player.COMMAND_SET_DEVICE_VOLUME, DeviceVolumeCommand.SET.toMedia3())
    assertEquals(
      Player.COMMAND_SET_DEVICE_VOLUME_WITH_FLAGS,
      DeviceVolumeCommand.SET_WITH_FLAGS.toMedia3(),
    )
  }

  @Test
  fun `no two commands collapse onto the same constant`() {
    // A copy-paste in the `when` would silently drop a command — and a missing
    // COMMAND_ADJUST_DEVICE_VOLUME is a volume rocker that moves the phone's
    // stream instead of the speaker, which is the bug this feature exists for.
    val constants = DeviceVolumeCommand.entries.map { it.toMedia3() }
    assertEquals(DeviceVolumeCommand.entries.size, constants.toSet().size)
  }
}
