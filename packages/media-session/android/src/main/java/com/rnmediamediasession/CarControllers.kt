package com.rnmediamediasession

import android.provider.MediaStore
import com.margelo.nitro.rnmediamediasession.NativeSearchFocus

/**
 * Who is on the other end of a browse/media request, decided by data alone.
 *
 * Every function here is pure and unit-tested (`CarControllersTest`). The
 * `ControllerInfo` reads that feed them live one call site away, in the session
 * callback, because *that* part needs a session and this part needs to be
 * checked without one.
 */
internal object CarControllers {

  /**
   * May this controller send `Player.COMMAND_SET_MEDIA_ITEM` — i.e. tap a
   * browse item and have it play?
   *
   * The command is granted **per controller**, never globally, because it is
   * the one command that can replace the app's whole playlist. Android Auto and
   * Automotive OS need it (a tap in the browse tree arrives as
   * `onPlayFromMediaId` → `handleMediaRequest` →
   * `dispatchSessionTaskWithPlayerCommand(COMMAND_SET_MEDIA_ITEM, …)`,
   * `MediaSessionLegacyStub`, media3 1.11.0); a trusted controller — the system
   * UI, an enabled notification listener, the app's own `MediaController` —
   * already gets it in media3's own default for trusted connections
   * (`ConnectionResult.DEFAULT_PLAYER_COMMANDS`), and taking it away from them
   * would be a regression, not a hardening.
   *
   * Everything else — a third-party app's untrusted `MediaController` — is
   * refused, which matches media3's `DEFAULT_UNTRUSTED_PLAYER_COMMANDS`
   * (read-only commands only).
   *
   * Note that `ControllerInfo.isTrusted()` is documented by media3 as *"not a
   * security validation"*; it is a UX signal. That is exactly the weight it
   * carries here: the two car packages are named explicitly so the feature does
   * not depend on it, and the trusted arm only re-states a default media3
   * already applies.
   */
  fun carCommands(isAuto: Boolean, isAutomotive: Boolean, isTrusted: Boolean): Boolean =
    isAuto || isAutomotive || isTrusted

  /**
   * The `CarConnection.kind` string for a controller, or `null` when it is not
   * a car at all.
   *
   * Deliberately **not** `isTrusted`: the system UI is trusted and is not a
   * car, and this value drives `useCarConnection()` (and the revival rule in
   * [RnMediaMediaSessionService.onGetChildren] — a SystemUI bind must never
   * boot the app).
   */
  fun carConnection(isAuto: Boolean, isAutomotive: Boolean): String? = when {
    isAutomotive -> AUTOMOTIVE_OS
    isAuto -> ANDROID_AUTO
    else -> null
  }

  /**
   * Which of two car kinds wins when both are connected.
   *
   * Automotive OS *is* the head unit; the Auto companion is a phone projecting
   * onto one. If both are somehow present, the more specific statement is the
   * built-in car.
   */
  fun strongerConnection(a: String?, b: String?): String = when {
    a == AUTOMOTIVE_OS || b == AUTOMOTIVE_OS -> AUTOMOTIVE_OS
    a == ANDROID_AUTO || b == ANDROID_AUTO -> ANDROID_AUTO
    else -> NONE
  }

  /**
   * Widen a voice query's focus extras into the bridge struct.
   *
   * The values come from `MediaStore`'s own constants (they are compile-time
   * `String` constants, so this stays pure and testable): Assistant sets
   * `android.intent.extra.focus` to the *entry content type* of what it
   * classified, plus the matching `EXTRA_MEDIA_*` strings. Nothing is
   * guaranteed — a bare "play music" arrives with no focus and no extras, which
   * is what `kind = "any"` means.
   *
   * An unrecognised MIME type is `"any"` rather than an error: the set is the
   * platform's to extend, and a query we cannot classify is still a query the
   * app can answer.
   */
  @Suppress("DEPRECATION") // `MediaStore.Audio.Playlists` — see the `when` below.
  fun searchFocus(
    focus: String?,
    artist: String?,
    album: String?,
    title: String?,
    genre: String?,
    playlist: String?,
  ): NativeSearchFocus = NativeSearchFocus(
    kind = when (focus) {
      MediaStore.Audio.Artists.ENTRY_CONTENT_TYPE -> "artist"
      MediaStore.Audio.Albums.ENTRY_CONTENT_TYPE -> "album"
      MediaStore.Audio.Media.ENTRY_CONTENT_TYPE -> "title"
      MediaStore.Audio.Genres.ENTRY_CONTENT_TYPE -> "genre"
      // `MediaStore.Audio.Playlists` is deprecated (scoped storage removed the
      // *table*), but the MIME string is still what Assistant puts in
      // `android.intent.extra.focus` for a playlist query — the constant is the
      // vocabulary here, not a query target. Naming the constant rather than
      // pasting its value is what keeps that verifiable.
      MediaStore.Audio.Playlists.ENTRY_CONTENT_TYPE -> "playlist"
      else -> "any"
    },
    artist = artist?.ifEmpty { null },
    album = album?.ifEmpty { null },
    title = title?.ifEmpty { null },
    genre = genre?.ifEmpty { null },
    playlist = playlist?.ifEmpty { null },
  )

  const val ANDROID_AUTO = "androidAuto"
  const val AUTOMOTIVE_OS = "automotiveOs"
  const val NONE = "none"
}
