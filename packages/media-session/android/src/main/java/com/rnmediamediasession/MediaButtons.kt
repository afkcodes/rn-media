package com.rnmediamediasession

import android.annotation.SuppressLint
import android.content.Context
import android.os.Bundle
import androidx.annotation.OptIn
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.CommandButton
import androidx.media3.session.R
import androidx.media3.session.SessionCommand
import com.google.common.collect.ImmutableList
import com.margelo.nitro.rnmediamediasession.MediaCapability
import com.margelo.nitro.rnmediamediasession.MediaControl
import com.margelo.nitro.rnmediamediasession.MediaRepeatMode
import com.margelo.nitro.rnmediamediasession.RemoteVolumeControl

/**
 * Translation of the broadcast `capabilities` / `controls` / `customActions`
 * into media3's two separate concepts.
 *
 * The two are genuinely different things in media3 1.x and conflating them is
 * the source of most "my button does nothing" reports:
 *
 * - **`Player.Commands`** decides what is *possible*. `SimpleBasePlayer` never
 *   calls a `handle*` method for a command it does not contain — it returns
 *   from the public setter before dispatching (`shouldHandleCommand`), silently.
 *   `DefaultMediaNotificationProvider` also reads them to decide which default
 *   buttons exist at all.
 * - **media button preferences** (`List<CommandButton>` with slots) decide what
 *   is *shown*, and where. This replaced `setCustomLayout` + "compact view
 *   indices"; the collapsed notification is now expressed as the three named
 *   slots `SLOT_BACK` / `SLOT_CENTRAL` / `SLOT_FORWARD`.
 */
@OptIn(UnstableApi::class)
internal object MediaButtons {

  /**
   * Commands that are always available.
   *
   * `COMMAND_GET_METADATA` is not optional despite looking like it:
   * `DefaultMediaNotificationProvider` reads title, artist and artwork behind
   * `player.isCommandAvailable(COMMAND_GET_METADATA)`, so omitting it produces
   * a blank notification with working buttons — the single most confusing
   * failure mode in media3.
   *
   * `COMMAND_PREPARE` is included so `MediaController.prepare()` (used by
   * System UI playback resumption) is not rejected; the facade has nothing to
   * prepare and answers immediately.
   *
   * `COMMAND_RELEASE` is deliberately absent: a stray controller calling
   * `Player.release()` must not be able to tear down a session the app still
   * owns. `MediaService.stopService()` is the only way out (PLAN §5.4).
   */
  private fun Player.Commands.Builder.addAlways(): Player.Commands.Builder = this
    .add(Player.COMMAND_GET_CURRENT_MEDIA_ITEM)
    .add(Player.COMMAND_GET_TIMELINE)
    .add(Player.COMMAND_GET_METADATA)
    .add(Player.COMMAND_PREPARE)

  /**
   * `capabilities ∪ controls` → `Player.Commands`.
   *
   * Controls contribute too: an app that asks for a "next" button but forgets
   * the `skipToNext` capability would otherwise get a button media3 refuses to
   * wire up. Being generous here is safe — the app still decides what its
   * handler does.
   */
  fun commands(snapshot: Snapshot): Player.Commands {
    // Written out with `add` rather than `addAll(*intArrayOf(...))`: lint's
    // @IntDef check cannot see through a Kotlin spread, and silencing it would
    // give up the check that catches a genuinely wrong constant here.
    val builder = Player.Commands.Builder().addAlways()

    for (capability in snapshot.capabilities) {
      when (capability) {
        MediaCapability.PLAY, MediaCapability.PAUSE ->
          builder.add(Player.COMMAND_PLAY_PAUSE)

        MediaCapability.STOP ->
          builder.add(Player.COMMAND_STOP)

        MediaCapability.SEEK -> builder
          .add(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
          .add(Player.COMMAND_SEEK_TO_DEFAULT_POSITION)

        MediaCapability.SKIPTONEXT -> builder
          .add(Player.COMMAND_SEEK_TO_NEXT)
          .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)

        MediaCapability.SKIPTOPREVIOUS -> builder
          .add(Player.COMMAND_SEEK_TO_PREVIOUS)
          .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)

        MediaCapability.SKIPTOQUEUEITEM ->
          builder.add(Player.COMMAND_SEEK_TO_MEDIA_ITEM)

        MediaCapability.SETRATE ->
          builder.add(Player.COMMAND_SET_SPEED_AND_PITCH)

        // Load-bearing, not decorative: `DefaultMediaNotificationProvider`
        // decides whether to draw the repeat/shuffle buttons from the player's
        // available commands, and `SimpleBasePlayer` refuses to dispatch
        // `handleSetRepeatMode`/`handleSetShuffleModeEnabled` without them.
        MediaCapability.SETREPEATMODE ->
          builder.add(Player.COMMAND_SET_REPEAT_MODE)

        MediaCapability.SETSHUFFLE ->
          builder.add(Player.COMMAND_SET_SHUFFLE_MODE)
      }
    }

    for (control in snapshot.controls) {
      when (control) {
        MediaControl.PLAY, MediaControl.PAUSE ->
          builder.add(Player.COMMAND_PLAY_PAUSE)

        MediaControl.STOP ->
          builder.add(Player.COMMAND_STOP)

        MediaControl.SKIPTONEXT -> builder
          .add(Player.COMMAND_SEEK_TO_NEXT)
          .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)

        MediaControl.SKIPTOPREVIOUS -> builder
          .add(Player.COMMAND_SEEK_TO_PREVIOUS)
          .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)

        MediaControl.FASTFORWARD ->
          builder.add(Player.COMMAND_SEEK_FORWARD)

        MediaControl.REWIND ->
          builder.add(Player.COMMAND_SEEK_BACK)

        MediaControl.REPEATMODE ->
          builder.add(Player.COMMAND_SET_REPEAT_MODE)

        MediaControl.SHUFFLE ->
          builder.add(Player.COMMAND_SET_SHUFFLE_MODE)
      }
    }

    addRemoteVolume(builder, snapshot.remote)

    return builder.build()
  }

  private fun addRemoteVolume(builder: Player.Commands.Builder, remote: RemoteDevice?) {
    for (command in deviceVolumeCommands(remote)) builder.add(command.toMedia3())
  }

  /** Every custom action currently advertised, as session commands. */
  fun sessionCommands(snapshot: Snapshot): List<SessionCommand> =
    snapshot.customActions.map { SessionCommand(it.name, Bundle.EMPTY) }

  /**
   * The ordered button list handed to `MediaSession.setMediaButtonPreferences`.
   *
   * Slot assignment: a control listed in `compactControlIndices` gets its
   * natural collapsed slot first, then a secondary slot, then overflow — media3
   * "place[s] the button in the first available and allowed slot", so an
   * ordered preference list is how two back-ish buttons both survive. Controls
   * outside the compact set are overflow-only.
   */
  fun buttons(
    context: Context,
    snapshot: Snapshot,
  ): ImmutableList<CommandButton> {
    val buttons = ImmutableList.builder<CommandButton>()
    val compact = snapshot.compactControlIndices.toSet()

    // `play` and `pause` are one button in every media3 surface — the icon is
    // chosen by `Util.shouldShowPlayButton`, not by us. An app that lists both
    // (the natural thing to write) must not get two identical buttons fighting
    // for SLOT_CENTRAL, with the loser silently demoted to overflow.
    var emittedPlayPause = false

    snapshot.controls.forEachIndexed { index, control ->
      val isPlayPause = control == MediaControl.PLAY || control == MediaControl.PAUSE
      if (isPlayPause && emittedPlayPause) return@forEachIndexed
      if (isPlayPause) emittedPlayPause = true

      val button = CommandButton.Builder(iconOf(control, snapshot))
        .setPlayerCommand(playerCommandOf(control))
        // NOT optional, despite `CommandButton` defaulting it to "".
        // `MediaSessionLegacyStub.createPlaybackStateCompat` re-derives a custom
        // layout from the media button preferences and turns each entry into a
        // legacy `PlaybackStateCompat.CustomAction`, whose builder throws
        // `IllegalArgumentException: You must specify a name to build a
        // CustomAction` on an empty name. That happens inside
        // `setMediaButtonPreferences`, i.e. on the main thread during service
        // creation, so an unnamed button crashes the whole service.
        .setDisplayName(displayNameOf(context, control))
      if (index in compact) applyCompactSlots(button, control) else button.setSlots(OVERFLOW)
      buttons.add(button.build())
    }

    for (action in snapshot.customActions) {
      buttons.add(
        CommandButton.Builder(CommandButton.ICON_UNDEFINED)
          .setSessionCommand(SessionCommand(action.name, Bundle.EMPTY))
          .setDisplayName(action.title)
          // A custom action has no media3 icon constant, so `ICON_UNDEFINED`
          // resolves to resource id 0 — and `DefaultActionFactory` feeds that
          // straight into `IconCompat.createWithResource`, which is how apps end
          // up with an invisible or crashing notification action below API 33.
          // A real resource is therefore never optional here; a platform
          // drawable that is guaranteed to exist is the last resort.
          .setCustomIconResId(
            action.icon?.let { drawableResId(context, it) }?.takeIf { it != 0 }
              ?: android.R.drawable.ic_menu_more
          )
          // Custom actions never take a collapsed slot: those three are for
          // transport controls, and Android 13+ derives the collapsed row from
          // the session itself. Overflow is where the platform expects them.
          .setSlots(OVERFLOW)
          .build()
      )
    }

    return buttons.build()
  }

  /**
   * Resolve a drawable resource *name* against the consuming app's resources.
   *
   * Names rather than ids because the ids only exist in the app's generated
   * `R`, which a library cannot reference. Returns `0` when unresolvable, which
   * every caller treats as "fall back".
   *
   * `getIdentifier` is flagged `DiscouragedApi` for exactly that reason —
   * reflection defeats resource shrinking. There is no alternative for a
   * library that must name a *consumer's* drawable, and the lookup happens once
   * per session start, not per notification.
   */
  @SuppressLint("DiscouragedApi")
  fun drawableResId(context: Context, name: String): Int =
    context.resources.getIdentifier(name, "drawable", context.packageName)
      .takeIf { it != 0 }
      ?: context.resources.getIdentifier(name, "mipmap", context.packageName)

  /**
   * The icon for a control.
   *
   * Takes the snapshot because the two toggles are drawn from *state*: media3
   * ships a distinct icon per repeat mode (`ICON_REPEAT_OFF/_ONE/_ALL`) and per
   * shuffle state, and a toggle whose icon does not track its state is worse
   * than no toggle. Everything else ignores the snapshot — play/pause is a
   * single button whose face media3 picks itself via `Util.shouldShowPlayButton`.
   */
  private fun iconOf(control: MediaControl, snapshot: Snapshot): @CommandButton.Icon Int =
    when (control) {
      MediaControl.PLAY -> CommandButton.ICON_PLAY
      MediaControl.PAUSE -> CommandButton.ICON_PAUSE
      MediaControl.STOP -> CommandButton.ICON_STOP
      MediaControl.SKIPTONEXT -> CommandButton.ICON_NEXT
      MediaControl.SKIPTOPREVIOUS -> CommandButton.ICON_PREVIOUS
      MediaControl.FASTFORWARD -> CommandButton.ICON_FAST_FORWARD
      MediaControl.REWIND -> CommandButton.ICON_REWIND
      MediaControl.REPEATMODE -> when (snapshot.repeatMode) {
        MediaRepeatMode.OFF -> CommandButton.ICON_REPEAT_OFF
        MediaRepeatMode.ONE -> CommandButton.ICON_REPEAT_ONE
        MediaRepeatMode.ALL -> CommandButton.ICON_REPEAT_ALL
      }
      MediaControl.SHUFFLE ->
        if (snapshot.shuffleEnabled) CommandButton.ICON_SHUFFLE_ON
        else CommandButton.ICON_SHUFFLE_OFF
    }

  /**
   * Accessibility label / legacy custom-action name for a transport button.
   *
   * media3 ships localised strings for exactly the controls it draws itself, so
   * these are the same words the default notification uses, in the user's
   * language. `stop` has no media3 string (media3 has no stop button), and a
   * library cannot add translations to a consumer's app, so it falls back to
   * the platform's own "stop" label.
   */
  private fun displayNameOf(context: Context, control: MediaControl): String = when (control) {
    MediaControl.PLAY -> context.getString(R.string.media3_controls_play_description)
    MediaControl.PAUSE -> context.getString(R.string.media3_controls_pause_description)
    MediaControl.SKIPTONEXT ->
      context.getString(R.string.media3_controls_seek_to_next_description)
    MediaControl.SKIPTOPREVIOUS ->
      context.getString(R.string.media3_controls_seek_to_previous_description)
    MediaControl.FASTFORWARD ->
      context.getString(R.string.media3_controls_seek_forward_description)
    MediaControl.REWIND -> context.getString(R.string.media3_controls_seek_back_description)
    MediaControl.STOP -> context.getString(android.R.string.cancel)
    // media3 ships localised strings only for the controls it draws itself
    // (play, pause, next, previous, seek forward, seek back — verified against
    // the shipped 1.11.0 AAR's res/values). It has repeat/shuffle *icons* but no
    // repeat/shuffle strings, the platform has no such string either, and a
    // library cannot add translations to a consumer's app. So these two are
    // English, and the name is never nothing — an empty display name throws
    // inside `setMediaButtonPreferences` and takes the service down with it.
    MediaControl.REPEATMODE -> "Repeat"
    MediaControl.SHUFFLE -> "Shuffle"
  }

  private fun playerCommandOf(control: MediaControl): @Player.Command Int = when (control) {
    // One command covers both directions; the icon and media3's
    // `Util.shouldShowPlayButton` decide which face is drawn.
    MediaControl.PLAY, MediaControl.PAUSE -> Player.COMMAND_PLAY_PAUSE
    MediaControl.STOP -> Player.COMMAND_STOP
    MediaControl.SKIPTONEXT -> Player.COMMAND_SEEK_TO_NEXT
    MediaControl.SKIPTOPREVIOUS -> Player.COMMAND_SEEK_TO_PREVIOUS
    MediaControl.FASTFORWARD -> Player.COMMAND_SEEK_FORWARD
    MediaControl.REWIND -> Player.COMMAND_SEEK_BACK
    MediaControl.REPEATMODE -> Player.COMMAND_SET_REPEAT_MODE
    MediaControl.SHUFFLE -> Player.COMMAND_SET_SHUFFLE_MODE
  }

  /**
   * Slot preference for a control that the app put in the collapsed set.
   *
   * media3 "place[s] the button in the first available and allowed slot", so
   * the list is ordered: natural slot, then the secondary one, then overflow.
   * That is what lets an app ask for e.g. rewind *and* previous without one of
   * them silently disappearing.
   *
   * Takes the builder rather than returning an `IntArray` because `setSlots` is
   * a vararg of `@CommandButton.Slot` and lint cannot verify constants through
   * a Kotlin spread operator.
   */
  private fun applyCompactSlots(button: CommandButton.Builder, control: MediaControl) {
    when (control) {
      MediaControl.PLAY, MediaControl.PAUSE, MediaControl.STOP ->
        button.setSlots(CommandButton.SLOT_CENTRAL, OVERFLOW)

      MediaControl.SKIPTOPREVIOUS, MediaControl.REWIND ->
        button.setSlots(CommandButton.SLOT_BACK, CommandButton.SLOT_BACK_SECONDARY, OVERFLOW)

      MediaControl.SKIPTONEXT, MediaControl.FASTFORWARD ->
        button.setSlots(CommandButton.SLOT_FORWARD, CommandButton.SLOT_FORWARD_SECONDARY, OVERFLOW)

      // The two toggles never claim a primary slot. `SLOT_CENTRAL` is
      // play/pause, and the back/forward slots are transport — a shuffle button
      // where "previous" belongs is the layout every music app avoids. The
      // secondary slots are precisely where Android 13+ shades put them, and
      // overflow is the honest fallback when a transport control got there
      // first (media3 takes "the first available and allowed slot").
      MediaControl.SHUFFLE ->
        button.setSlots(CommandButton.SLOT_BACK_SECONDARY, OVERFLOW)

      MediaControl.REPEATMODE ->
        button.setSlots(CommandButton.SLOT_FORWARD_SECONDARY, OVERFLOW)
    }
  }

  private const val OVERFLOW = CommandButton.SLOT_OVERFLOW
}

/* -------------------------------------------------------------------------- */
/*                       Device volume: the decision, pure                    */
/* -------------------------------------------------------------------------- */

/**
 * A media3 device-volume command, named so the *decision* about which ones to
 * advertise can be made — and unit-tested — without touching `Player.Commands`.
 *
 * `Player.Commands` is backed by media3's `FlagSet`, which is backed by
 * `android.util.SparseBooleanArray`. Under the stub `android.jar` a plain JVM
 * test gets a set that silently swallows every `add` and answers `false` to
 * every `contains`, so asserting on a built `Commands` would pass whatever the
 * code did. Splitting the policy out (this enum plus [deviceVolumeCommands])
 * from the constant mapping ([toMedia3]) makes both halves testable on a JVM
 * with nothing stubbed — the same split, for the same reason, as
 * `MediaRepeatMode.toMedia3()`.
 */
internal enum class DeviceVolumeCommand {
  /**
   * Not optional, despite reading like a nicety: media3 fetches the value it
   * reports to the platform through
   * `PlayerWrapper.getDeviceVolumeWithCommandCheck()`, which returns a hard `0`
   * when this command is missing. Without it the system would show the remote
   * device as silent no matter how loud it actually is.
   */
  GET,

  /**
   * What a **hardware volume key press** becomes. The platform delivers
   * `VolumeProvider.onAdjustVolume(±1)`, which media3 turns into
   * `Player.increase/decreaseDeviceVolume`. Its presence is also what makes the
   * provider controllable at all — `VOLUME_CONTROL_RELATIVE` in
   * `MediaSessionLegacyStub.createVolumeProviderCompat`; without it the
   * provider is `VOLUME_CONTROL_FIXED` and the keys are dead.
   */
  ADJUST,

  /**
   * The `_WITH_FLAGS` twin, advertised alongside [ADJUST] because media3 checks
   * for it *first* and it is the one that carries `FLAG_SHOW_UI` — which is
   * what makes the system's volume panel appear as the user holds the rocker.
   */
  ADJUST_WITH_FLAGS,

  /**
   * Upgrades the provider to `VOLUME_CONTROL_ABSOLUTE`, which is what draws the
   * system's remote volume *slider* and delivers `onSetVolumeTo`.
   */
  SET,

  /** The `_WITH_FLAGS` twin of [SET]. See [ADJUST_WITH_FLAGS]. */
  SET_WITH_FLAGS,
}

/**
 * Which device-volume commands a published remote output implies.
 *
 * `null` — local playback — implies **none**, and that is the whole
 * compatibility story: `createVolumeProviderCompat` returns `null` for a
 * `PLAYBACK_TYPE_LOCAL` `DeviceInfo` before it looks at a single command, so an
 * app that never publishes a remote device is untouched by any of this.
 */
internal fun deviceVolumeCommands(remote: RemoteDevice?): List<DeviceVolumeCommand> =
  when (remote?.volumeControl) {
    null -> emptyList()
    // Readable, not writable. Nothing beyond the getter, so the keys stay dead
    // — the honest rendering of "the app says it cannot drive this volume".
    RemoteVolumeControl.FIXED -> listOf(DeviceVolumeCommand.GET)

    RemoteVolumeControl.RELATIVE -> listOf(
      DeviceVolumeCommand.GET,
      DeviceVolumeCommand.ADJUST,
      DeviceVolumeCommand.ADJUST_WITH_FLAGS,
    )

    RemoteVolumeControl.ABSOLUTE -> listOf(
      DeviceVolumeCommand.GET,
      DeviceVolumeCommand.ADJUST,
      DeviceVolumeCommand.ADJUST_WITH_FLAGS,
      DeviceVolumeCommand.SET,
      DeviceVolumeCommand.SET_WITH_FLAGS,
    )
  }

/**
 * The media3 constant, written out rather than derived. Same rule as
 * `MediaRepeatMode.toMedia3()`: a coincidence is not a contract.
 *
 * The `@Player.Command` return annotation is load-bearing for lint, not
 * decoration — it is what lets `Player.Commands.Builder.add(@Command int)`
 * accept a value that is not a literal constant at the call site.
 *
 * `COMMAND_ADJUST_DEVICE_VOLUME` and `COMMAND_SET_DEVICE_VOLUME` are deprecated
 * upstream in favour of their `_WITH_FLAGS` twins, and are advertised anyway
 * for the same reason media3's own `RemoteCastPlayer` does — its
 * `PERMANENT_AVAILABLE_COMMANDS` lists all four behind a
 * `@SuppressWarnings("deprecation")` and the comment "Deprecated commands are
 * still available, e.g. COMMAND_ADJUST_DEVICE_VOLUME" (media3 1.11.0). A
 * `MediaController` built against an older media3 asks with the old constant,
 * and dropping it would make that controller's volume silently dead while
 * saving nothing.
 */
@Suppress("DEPRECATION")
internal fun DeviceVolumeCommand.toMedia3(): @Player.Command Int = when (this) {
  DeviceVolumeCommand.GET -> Player.COMMAND_GET_DEVICE_VOLUME
  DeviceVolumeCommand.ADJUST -> Player.COMMAND_ADJUST_DEVICE_VOLUME
  DeviceVolumeCommand.ADJUST_WITH_FLAGS -> Player.COMMAND_ADJUST_DEVICE_VOLUME_WITH_FLAGS
  DeviceVolumeCommand.SET -> Player.COMMAND_SET_DEVICE_VOLUME
  DeviceVolumeCommand.SET_WITH_FLAGS -> Player.COMMAND_SET_DEVICE_VOLUME_WITH_FLAGS
}
