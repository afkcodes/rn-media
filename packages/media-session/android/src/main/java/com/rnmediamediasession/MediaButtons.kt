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
      }
    }

    return builder.build()
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

      val button = CommandButton.Builder(iconOf(control))
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

  private fun iconOf(control: MediaControl): @CommandButton.Icon Int = when (control) {
    MediaControl.PLAY -> CommandButton.ICON_PLAY
    MediaControl.PAUSE -> CommandButton.ICON_PAUSE
    MediaControl.STOP -> CommandButton.ICON_STOP
    MediaControl.SKIPTONEXT -> CommandButton.ICON_NEXT
    MediaControl.SKIPTOPREVIOUS -> CommandButton.ICON_PREVIOUS
    MediaControl.FASTFORWARD -> CommandButton.ICON_FAST_FORWARD
    MediaControl.REWIND -> CommandButton.ICON_REWIND
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
    }
  }

  private const val OVERFLOW = CommandButton.SLOT_OVERFLOW
}
