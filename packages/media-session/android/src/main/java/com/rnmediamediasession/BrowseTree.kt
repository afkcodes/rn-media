package com.rnmediamediasession

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaConstants
import androidx.media3.session.SessionError
import com.margelo.nitro.rnmediamediasession.BrowseErrorCode
import com.margelo.nitro.rnmediamediasession.BrowseMediaType
import com.margelo.nitro.rnmediamediasession.BrowseStyle
import com.margelo.nitro.rnmediamediasession.NativeBrowseError
import com.margelo.nitro.rnmediamediasession.NativeBrowseItem

/**
 * The browse node the app described, as the browse node media3 (and through it
 * Android Auto) understands.
 *
 * Every key written here is a **public** `androidx.media3.session.MediaConstants`
 * constant. The `androidx.media3.session.legacy.MediaConstants` that holds the
 * same strings is `@RestrictTo(LIBRARY)` and is deliberately never imported —
 * the public class re-exports every value this file needs, and the ones it does
 * not are the ones media3 writes itself (`SEARCH_SUPPORTED`, see
 * `MediaLibraryServiceLegacyStub`).
 */
@OptIn(UnstableApi::class)
internal object BrowseTree {

  /**
   * Convert one node, rewriting `https://` artwork to this package's provider.
   *
   * Android Auto accepts **only** `content://` and `android.resource://` for
   * browse artwork — an `https://` icon URI simply does not render, and
   * `setIconBitmap` is worse (unsupported on Automotive OS, and a 1 MB binder
   * limit away from a `TransactionTooLargeException`). So the conversion is not
   * a nicety: it is the difference between covers and blank squares.
   * https://developer.android.com/training/cars/media/create-media-browser/media-artwork
   *
   * `file://`, `content://` and `android.resource://` pass through untouched.
   */
  fun toMediaItem(item: NativeBrowseItem, artwork: ArtworkRegistry?): MediaItem {
    val metadata = MediaMetadata.Builder()
      .setTitle(item.title)
      // Both, deliberately. `LegacyConversions.convertToMediaDescriptionCompat`
      // (media3 1.11.0) uses `displayTitle` as the description's title *and*
      // takes `subtitle` verbatim when it is present; with no `displayTitle` it
      // instead fills title/subtitle/description from title, artist, album — a
      // heuristic meant for now-playing metadata, which would put an empty
      // second line under every browse row.
      .setDisplayTitle(item.title)
      .setIsBrowsable(item.browsable)
      .setIsPlayable(item.playable)
      .setMediaType(mediaType(item.mediaType))
      .apply {
        item.subtitle?.let { setSubtitle(it) }
        artworkUri(item.artworkUri, artwork)?.let { setArtworkUri(it) }
        extrasFor(item)?.let { setExtras(it) }
      }
      .build()

    return MediaItem.Builder()
      .setMediaId(item.id)
      .setMediaMetadata(metadata)
      .build()
  }

  /**
   * The per-item browse extras, or `null` when the item asked for none.
   *
   * A `null` rather than an empty `Bundle` because `MediaMetadata.extras` is
   * carried into every legacy `MediaDescriptionCompat` and across a binder to
   * Android Auto; an empty bundle per row is pure transaction weight on the
   * path whose size limit media3 already truncates lists against
   * (`MediaUtils.TRANSACTION_SIZE_LIMIT_IN_BYTES`).
   */
  private fun extrasFor(item: NativeBrowseItem): Bundle? {
    val style = item.childStyle
    val group = item.group
    val completion = item.completion
    if (style == null && group == null && !item.isExplicit && completion == null) return null

    val extras = Bundle()
    if (style != null) {
      // The hint on a *browsable* item applies to its immediate children, which
      // is what `BrowseItem.childStyle` means. Both keys, because a node's
      // children can be a mix of folders and tracks and one style for the
      // screen is what the app asked for.
      val value = contentStyle(style)
      extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, value)
      extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, value)
    }
    if (group != null) {
      extras.putString(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_GROUP_TITLE, group)
    }
    if (item.isExplicit) {
      extras.putLong(
        MediaConstants.EXTRAS_KEY_IS_EXPLICIT,
        MediaConstants.EXTRAS_VALUE_ATTRIBUTE_PRESENT,
      )
    }
    if (completion != null) {
      extras.putInt(MediaConstants.EXTRAS_KEY_COMPLETION_STATUS, completionStatus(completion))
      // A double `0..1`, per the constant's own documentation. Written even for
      // the two endpoints: a car that reads the percentage and ignores the
      // status still draws the right bar.
      extras.putDouble(MediaConstants.EXTRAS_KEY_COMPLETION_PERCENTAGE, completion)
    }
    return extras
  }

  /** `0` untouched, `1` played, anything between partially played. */
  fun completionStatus(completion: Double): Int = when {
    completion <= 0.0 -> MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_NOT_PLAYED
    completion >= 1.0 -> MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_FULLY_PLAYED
    else -> MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_PARTIALLY_PLAYED
  }

  /** Android Auto's content-style values: 1 list, 2 grid, 3/4 the category pair. */
  fun contentStyle(style: BrowseStyle): Int = when (style) {
    BrowseStyle.LIST -> MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM
    BrowseStyle.GRID -> MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM
    BrowseStyle.CATEGORYLIST -> MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_CATEGORY_LIST_ITEM
    BrowseStyle.CATEGORYGRID -> MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_CATEGORY_GRID_ITEM
  }

  /** The bridge's semantic type as media3's `MediaMetadata.MEDIA_TYPE_*`. */
  fun mediaType(type: BrowseMediaType): Int = when (type) {
    BrowseMediaType.MIXED -> MediaMetadata.MEDIA_TYPE_MIXED
    BrowseMediaType.MUSIC -> MediaMetadata.MEDIA_TYPE_MUSIC
    BrowseMediaType.PODCASTEPISODE -> MediaMetadata.MEDIA_TYPE_PODCAST_EPISODE
    BrowseMediaType.RADIOSTATION -> MediaMetadata.MEDIA_TYPE_RADIO_STATION
    BrowseMediaType.AUDIOBOOKCHAPTER -> MediaMetadata.MEDIA_TYPE_AUDIO_BOOK_CHAPTER
    BrowseMediaType.FOLDERALBUMS -> MediaMetadata.MEDIA_TYPE_FOLDER_ALBUMS
    BrowseMediaType.FOLDERARTISTS -> MediaMetadata.MEDIA_TYPE_FOLDER_ARTISTS
    BrowseMediaType.FOLDERGENRES -> MediaMetadata.MEDIA_TYPE_FOLDER_GENRES
    BrowseMediaType.FOLDERPLAYLISTS -> MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS
    BrowseMediaType.FOLDERPODCASTS -> MediaMetadata.MEDIA_TYPE_FOLDER_PODCASTS
    BrowseMediaType.FOLDERRADIOSTATIONS -> MediaMetadata.MEDIA_TYPE_FOLDER_RADIO_STATIONS
    BrowseMediaType.FOLDERMIXED -> MediaMetadata.MEDIA_TYPE_FOLDER_MIXED
  }

  /**
   * The URI a browser should be handed for this artwork, or `null` for none.
   *
   * Pure enough to test: the `registry` is what turns an `https://` URL into a
   * hash, and `null` for it (no session context yet) means the https URL is
   * dropped rather than sent somewhere it will render as nothing.
   */
  @Suppress("UseKtx") // core-ktx is not a declared dependency — see `ArtworkRegistry.register`.
  fun artworkUri(uri: String?, registry: ArtworkRegistry?): Uri? {
    if (uri == null || uri.isEmpty()) return null
    if (!isHttp(uri)) return Uri.parse(uri)
    val hash = registry?.register(uri) ?: return null
    return registry.contentUri(hash)
  }

  fun isHttp(uri: String): Boolean =
    uri.startsWith("http://", ignoreCase = true) || uri.startsWith("https://", ignoreCase = true)

  /* ------------------------------- Errors --------------------------------- */

  /**
   * The app's browse error as media3's, with the resolution button attached.
   *
   * ## What actually reaches the car
   * media3 replicates a `LibraryResult` error into the *platform* playback
   * state — the only thing a legacy browser like Android Auto renders — for
   * `RESULT_ERROR_SESSION_AUTHENTICATION_EXPIRED` and
   * `RESULT_ERROR_SESSION_PARENTAL_CONTROL_RESTRICTED`, and for **no other
   * code** (`MediaLibrarySessionImpl.isReplicationErrorCode`, media3 1.11.0 —
   * read from the 1.11.0 sources, not from the release notes: the set is
   * narrower than the "authentication + premium" pairing the docs suggest).
   * The other three codes are returned faithfully and Auto draws them as an
   * empty list. `onGetLibraryRoot` is exempt from replication entirely.
   *
   * The resolution extras go in `SessionError.extras`, which is where
   * `MediaSessionLegacyStub.setLegacyError` reads them from when the
   * `LibraryParams` do not carry the intent key.
   */
  fun sessionError(
    context: Context,
    error: NativeBrowseError,
    requestCode: Int,
  ): SessionError {
    val extras = Bundle()
    val label = error.resolutionLabel
    val intent = resolutionIntent(context, error.resolutionUrl, requestCode)
    if (label != null && intent != null) {
      extras.putString(MediaConstants.EXTRAS_KEY_ERROR_RESOLUTION_ACTION_LABEL_COMPAT, label)
      extras.putParcelable(
        MediaConstants.EXTRAS_KEY_ERROR_RESOLUTION_ACTION_INTENT_COMPAT,
        intent,
      )
    }
    return SessionError(errorCode(error.code), error.message, extras)
  }

  fun errorCode(code: BrowseErrorCode): Int = when (code) {
    BrowseErrorCode.AUTHENTICATIONEXPIRED -> SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED
    BrowseErrorCode.PREMIUMACCOUNTREQUIRED -> SessionError.ERROR_SESSION_PREMIUM_ACCOUNT_REQUIRED
    BrowseErrorCode.NOTAVAILABLEINREGION -> SessionError.ERROR_SESSION_NOT_AVAILABLE_IN_REGION
    BrowseErrorCode.PARENTALCONTROLRESTRICTED ->
      SessionError.ERROR_SESSION_PARENTAL_CONTROL_RESTRICTED
    BrowseErrorCode.NOTSUPPORTED -> SessionError.ERROR_NOT_SUPPORTED
  }

  /**
   * The app's own launcher activity, carrying the resolution deep link.
   *
   * The app is the only thing that can resolve a sign-in — the car cannot draw
   * a login form — so the button opens the phone. `FLAG_IMMUTABLE` is required
   * from API 31 for a `PendingIntent` handed to another process, and correct
   * here anyway: nothing is meant to rewrite it.
   *
   * `null` when the app has no launcher activity (a service-only host), which
   * simply means no button — never a crash and never a dead one.
   */
  @Suppress("UseKtx") // See `artworkUri`.
  private fun resolutionIntent(
    context: Context,
    url: String?,
    requestCode: Int,
  ): PendingIntent? {
    if (url == null || url.isEmpty()) return null
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?: return null
    launch.data = Uri.parse(url)
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return PendingIntent.getActivity(
      context,
      requestCode,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }
}
