package com.rnmediamediasession

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import com.margelo.nitro.rnmediamediasession.AndroidMediaSessionConfig
import com.margelo.nitro.rnmediamediasession.MediaCapability
import com.margelo.nitro.rnmediamediasession.MediaControl
import com.margelo.nitro.rnmediamediasession.MediaCustomAction
import com.margelo.nitro.rnmediamediasession.MediaPlaybackStatus
import com.margelo.nitro.rnmediamediasession.MediaRepeatMode
import com.margelo.nitro.rnmediamediasession.MediaSessionConfig
import com.margelo.nitro.rnmediamediasession.NativeMediaItem
import org.json.JSONArray
import org.json.JSONObject

/**
 * The native half of persistence: everything the media service needs to know
 * about the last session **before any JavaScript exists in the process**.
 *
 * ## Why this is not just "read the app's storage"
 * Playback resumption is defined by what is missing. The OS creates the service
 * — from the System UI resumption card, a Bluetooth reconnect, a headset play —
 * into a fresh process, gives it roughly five seconds to call
 * `startForeground()`, and at that moment there is no React runtime, no Nitro
 * hybrid object and no app storage engine, because all three of those *are*
 * JavaScript. So the record is mirrored here, in `SharedPreferences` this
 * package owns: it survives process death and it reads back **synchronously**
 * on the main thread, which is the only shape that fits inside the window
 * (ARCHITECTURE §9 — native-first, JS is notified, never awaited).
 *
 * The app's own storage stays the source of truth; this is a cache, written
 * from the very same serialized string (`withPersistence` → `MediaServiceApi.
 * setResumptionSnapshot`) so the two copies cannot drift.
 *
 * ## Durability
 * Writes go to a single background thread and use `commit()`, not `apply()`.
 * `apply()` hands the write to a shared queue that the framework only
 * *guarantees* to flush at documented lifecycle transitions; a process this
 * feature exists for is one that gets killed without any. `commit()` on a
 * private thread costs the JS thread nothing, keeps ordering by construction
 * (one thread), and the pending payload is coalesced so a burst of three
 * broadcasts in a tick is one file write — the same rule the TS tee follows.
 *
 * ## Trust
 * Everything read here crossed a process death, so it is parsed as untrusted
 * input: every field is optional, every failure returns `null`, and nothing
 * throws. A record this package cannot understand means "no resumption", which
 * is exactly the behaviour that shipped before the feature existed.
 */
/**
 * The mirrored configuration a cold-started service rebuilds itself from.
 *
 * The Android half plus the cross-platform jump intervals — i.e. everything
 * `MediaSessionConfig` carries that this platform can act on. A dedicated type
 * rather than passing `AndroidMediaSessionConfig` around because the intervals
 * are deliberately *not* an Android option (they exist to make both platforms
 * agree) and hiding them inside the Android struct would say the opposite.
 */
internal data class MirroredConfig(
  val android: AndroidMediaSessionConfig,
  val jumpForwardMs: Long,
  val jumpBackwardMs: Long,
)

internal object ResumptionStore {

  private const val PREFS = "rn-media.media-session"

  /**
   * Schema-versioned key names rather than a version *field*: a reader that
   * does not know the key simply finds nothing, which is already the correct
   * behaviour ("no resumption"). Bump the suffix when the shape changes.
   *
   * Bumped to `v2` alongside `PERSISTENCE_SCHEMA_VERSION` 2 (repeat/shuffle on
   * the state, extended tags on media items, jump intervals and the notification
   * colour on the config). The superseded keys are removed on the next write —
   * see [putSession] / [putConfig] — so an upgraded app does not leave a
   * readable session record behind for nothing.
   */
  private const val KEY_SESSION = "resumption.session.v2"
  private const val KEY_CONFIG = "resumption.config.v2"

  /** Keys written by the previous schema, deleted on the first write after an upgrade. */
  private const val LEGACY_KEY_SESSION = "resumption.session.v1"
  private const val LEGACY_KEY_CONFIG = "resumption.config.v1"

  private val writer: Handler by lazy {
    Handler(HandlerThread("rn-media-resumption").apply { start() }.looper)
  }

  /** The single pending payload; a newer one replaces it (latest wins). */
  private val pending = arrayOfNulls<String>(1)

  private fun prefs(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  // MARK: - Write

  /**
   * Mirror the serialized `PersistedSession` record, or `null` to forget it.
   *
   * Called on the JS thread and returns immediately.
   */
  // ApplySharedPref suppressed deliberately (ARCHITECTURE §20): apply()'s flush
  // is only guaranteed at lifecycle transitions, and this feature exists for the
  // process that gets none. The write is already on a dedicated background thread.
  @android.annotation.SuppressLint("ApplySharedPref")
  fun putSession(context: Context, json: String?) {
    val app = context.applicationContext
    synchronized(pending) { pending[0] = json ?: "" }
    writer.post {
      val payload = synchronized(pending) { pending[0].also { pending[0] = null } } ?: return@post
      try {
        val editor = prefs(app).edit().remove(LEGACY_KEY_SESSION)
        if (payload.isEmpty()) editor.remove(KEY_SESSION) else editor.putString(KEY_SESSION, payload)
        editor.commit()
      } catch (error: Throwable) {
        Log.w(RnMediaMediaSessionService.TAG, "Could not mirror the session for resumption.", error)
      }
    }
  }

  /**
   * Mirror the Android config, so a service created with no JS can build the
   * same notification channel, icon and grace period the app configured.
   *
   * Written on every `initialize`, which is once per runtime — cheap enough to
   * do synchronously on the calling thread? No: `initialize` runs on the JS
   * thread and a file write there is exactly the kind of jank CLAUDE.md
   * principle 1 forbids. Same writer thread as the session.
   */
  // Deliberate commit() — same rationale as putSession above.
  @android.annotation.SuppressLint("ApplySharedPref")
  fun putConfig(context: Context, config: MediaSessionConfig?) {
    val app = context.applicationContext
    val json = config?.takeIf { it.android != null }?.let(::encodeConfig)
    writer.post {
      try {
        val editor = prefs(app).edit().remove(LEGACY_KEY_CONFIG)
        if (json == null) editor.remove(KEY_CONFIG) else editor.putString(KEY_CONFIG, json)
        editor.commit()
      } catch (error: Throwable) {
        Log.w(RnMediaMediaSessionService.TAG, "Could not mirror the config for resumption.", error)
      }
    }
  }

  /**
   * The mirrored config's wire shape, in one place.
   *
   * Split out of [putConfig] purely so it can be paired with [readConfig] in a
   * plain JVM test: [putConfig] itself hands the string to a `HandlerThread`,
   * which does not exist off-device, so an encode/decode round trip is the only
   * way to prove the two halves agree on field names. A `null` in any optional
   * field drops the key (`JSONObject.put` removes rather than stores `null`),
   * which is exactly what [readConfig]'s optional readers expect.
   */
  internal fun encodeConfig(config: MediaSessionConfig): String {
    val android = requireNotNull(config.android) { "encodeConfig needs an android config" }
    return JSONObject()
      .put("channelId", android.notificationChannelId)
      .put("channelName", android.notificationChannelName)
      .put("icon", android.notificationIcon)
      .put("stopForegroundOnPause", android.stopForegroundOnPause)
      .put("stopForegroundTimeoutMs", android.stopForegroundTimeoutMs)
      .put("playbackResumption", android.playbackResumption)
      .put("notificationColor", android.notificationColor)
      // Mirrored because a revived service builds a `BroadcastPlayer` before any
      // JavaScript exists, and that player's seek increments are what a
      // notification's fast-forward button resolves against. Without these the
      // resumed session would fall back to media3's asymmetric defaults — the
      // exact defect the option exists to remove — for the seconds before the
      // runtime arrives.
      .put("jumpForwardSeconds", config.jumpForwardSeconds)
      .put("jumpBackwardSeconds", config.jumpBackwardSeconds)
      .toString()
  }

  /**
   * Does this app declare a receiver for `ACTION_MEDIA_BUTTON`?
   *
   * The same question media3 asks —
   * `MediaSessionLegacyStub.queryPackageManagerForMediaButtonReceiver`, whose
   * answer *is* `canResumePlaybackOnStart()` ("Assume an app that intentionally
   * puts a `MediaButtonReceiver` into the manifest has implemented some kind of
   * resumption of the last recently played media item"). Without it the System
   * UI is never told this app can be resumed, so the whole feature is silently
   * inert — which is the single most likely way for an app to enable
   * `playbackResumption` and see nothing happen. Asked once per `initialize`
   * purely so that failure has a log line.
   */
  // Lint QueryPermissionsNeeded is a false positive here: the query is scoped
  // to our own package via setPackage(), and an app is always visible to itself.
  @android.annotation.SuppressLint("QueryPermissionsNeeded")
  fun hasMediaButtonReceiver(context: Context): Boolean = try {
    val intent = android.content.Intent(android.content.Intent.ACTION_MEDIA_BUTTON)
      .setPackage(context.packageName)
    context.packageManager.queryBroadcastReceivers(intent, 0).isNotEmpty()
  } catch (error: Throwable) {
    // A diagnostic must never be the thing that breaks initialization.
    Log.w(RnMediaMediaSessionService.TAG, "Could not query for a MediaButtonReceiver.", error)
    true
  }

  // MARK: - Read

  /**
   * The mirrored config, or `null` when this process has never seen an
   * `initialize` and no earlier one left anything behind.
   *
   * Synchronous by requirement, not by preference — see the class docs.
   */
  fun readConfig(context: Context): MirroredConfig? {
    val raw = try {
      prefs(context).getString(KEY_CONFIG, null)
    } catch (error: Throwable) {
      Log.w(RnMediaMediaSessionService.TAG, "Could not read the mirrored config.", error)
      null
    } ?: return null

    return try {
      val json = JSONObject(raw)
      val channelId = json.optString("channelId").takeIf { it.isNotEmpty() } ?: return null
      val channelName = json.optString("channelName").takeIf { it.isNotEmpty() } ?: return null
      MirroredConfig(
        android = AndroidMediaSessionConfig(
          notificationChannelId = channelId,
          notificationChannelName = channelName,
          notificationIcon = json.optStringOrNull("icon"),
          stopForegroundOnPause = json.optBoolean("stopForegroundOnPause", true),
          stopForegroundTimeoutMs = json.optDoubleOrNull("stopForegroundTimeoutMs"),
          playbackResumption = json.optBoolean("playbackResumption", false),
          notificationColor = json.optDoubleOrNull("notificationColor"),
        ),
        // Absent (a record written before the option existed) falls back to the
        // shared default rather than to media3's, which is the whole point.
        jumpForwardMs = json.optDoubleOrNull("jumpForwardSeconds")?.toJumpMs() ?: DEFAULT_JUMP_MS,
        jumpBackwardMs = json.optDoubleOrNull("jumpBackwardSeconds")?.toJumpMs() ?: DEFAULT_JUMP_MS,
      )
    } catch (error: Throwable) {
      Log.w(RnMediaMediaSessionService.TAG, "Ignoring an unreadable mirrored config.", error)
      null
    }
  }

  /**
   * The mirrored session as a [Snapshot] the facade player can serve directly,
   * or `null` when there is nothing usable.
   *
   * Two deliberate distortions of what was saved, both for the same reason —
   * *nothing is playing yet*:
   *
   * 1. **Status is forced to `STOPPED`.** The TS side already froze
   *    `playing`/`buffering` down to `paused` at write time (ARCHITECTURE §19),
   *    but `paused` is still too alive for this moment: it maps to
   *    `STATE_READY`, and media3 shows a notification for any session that is
   *    not `STATE_IDLE`. That would put a notification on screen the instant
   *    the System UI merely *binds* us to look at the resumption card. `STOPPED`
   *    maps to `STATE_IDLE`, which shows nothing and — this is the load-bearing
   *    part — is also the state `MediaLibrarySessionImpl.onGetChildrenOnHandler`
   *    requires before it will ask for the full recent item at boot time.
   * 2. **The anchor is re-stamped and frozen.** `rate = 0` against *this*
   *    process's `elapsedRealtime`, so the position cannot project forward from
   *    a timestamp belonging to a process that no longer exists.
   */
  fun readSession(context: Context): Snapshot? {
    val raw = try {
      prefs(context).getString(KEY_SESSION, null)
    } catch (error: Throwable) {
      Log.w(RnMediaMediaSessionService.TAG, "Could not read the mirrored session.", error)
      null
    } ?: return null

    return try {
      parseSession(JSONObject(raw))
    } catch (error: Throwable) {
      Log.w(RnMediaMediaSessionService.TAG, "Ignoring an unreadable mirrored session.", error)
      null
    }
  }

  /**
   * Parse the TS `PersistedRecord` shape. Internal for readability, not for
   * reuse: the shape is defined in `persistence.ts` and the two move together.
   */
  private fun parseSession(json: JSONObject): Snapshot? {
    if (json.optInt("v", -1) != SCHEMA_VERSION) return null

    val item = json.optJSONObject("mediaItem")?.let(::parseItem)
    val queue = json.optJSONArray("queue")?.let { array ->
      (0 until array.length()).mapNotNull { array.optJSONObject(it)?.let(::parseItem) }
    } ?: emptyList()
    // Nothing to show and nothing to resume. A record can legitimately look
    // like this — `clearPersisted` writes exactly it.
    if (item == null && queue.isEmpty()) return null

    val state = json.optJSONObject("playbackState")
    val position = state?.optJSONObject("position")?.optDouble("value", 0.0) ?: 0.0
    val queueIndex = state?.optIntOrNull("queueIndex") ?: -1

    return Snapshot(
      status = MediaPlaybackStatus.STOPPED,
      anchor = Anchor(
        valueMs = position.toLong().coerceAtLeast(0L),
        originMs = android.os.SystemClock.elapsedRealtime(),
        rate = 0f,
      ),
      speed = 1f,
      bufferedPositionMs = null,
      controls = state?.optJSONArray("controls").mapNotNull { control(it) },
      capabilities = state?.optJSONArray("capabilities").mapNotNull { capability(it) }.toSet(),
      customActions = state?.optJSONArray("customActions")?.let { array ->
        (0 until array.length()).mapNotNull { index ->
          val action = array.optJSONObject(index) ?: return@mapNotNull null
          val name = action.optString("name").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
          val title = action.optString("title").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
          MediaCustomAction(name, title, action.optStringOrNull("icon"))
        }
      } ?: emptyList(),
      compactControlIndices = state?.optJSONArray("compactControlIndices")?.let { array ->
        (0 until array.length()).map { array.optInt(it) }
      } ?: emptyList(),
      queueIndex = if (queueIndex in queue.indices) queueIndex else -1,
      errorMessage = null,
      repeatMode = state?.optStringOrNull("repeatMode")?.let(::repeatMode) ?: MediaRepeatMode.OFF,
      shuffleEnabled = state?.optBoolean("shuffleEnabled", false) ?: false,
      item = item,
      queue = queue,
    )
  }

  private fun parseItem(json: JSONObject): NativeMediaItem? {
    val id = json.optString("id").takeIf { it.isNotEmpty() } ?: return null
    val title = json.optString("title").takeIf { it.isNotEmpty() } ?: return null
    return NativeMediaItem(
      id = id,
      title = title,
      artist = json.optStringOrNull("artist"),
      album = json.optStringOrNull("album"),
      artworkUri = json.optStringOrNull("artworkUri"),
      duration = json.optDoubleOrNull("duration"),
      genre = json.optStringOrNull("genre"),
      albumArtist = json.optStringOrNull("albumArtist"),
      trackNumber = json.optDoubleOrNull("trackNumber"),
      discNumber = json.optDoubleOrNull("discNumber"),
      year = json.optDoubleOrNull("year"),
      subtitle = json.optStringOrNull("subtitle"),
      isLive = if (json.has("isLive") && !json.isNull("isLive")) json.optBoolean("isLive") else null,
      extras = json.optJSONObject("extras")?.let(::parseExtras),
    )
  }

  /**
   * `extras` back out of JSON as the string map the struct declares.
   *
   * Non-string values are coerced with `optString` rather than dropped: the
   * writer only ever puts strings there (the TS validator rejects anything
   * else), so a number here means the record was hand-edited or written by
   * something else — and keeping the key with its printed value tells the app
   * more than silently losing it.
   */
  private fun parseExtras(json: JSONObject): Map<String, String>? {
    val keys = json.keys()
    if (!keys.hasNext()) return null
    val out = HashMap<String, String>()
    for (key in keys) out[key] = json.optString(key)
    return out
  }

  private fun repeatMode(name: String): MediaRepeatMode? =
    runCatching { MediaRepeatMode.valueOf(name.uppercase()) }.getOrNull()

  /**
   * Enum names as the TS union spells them, matched case-insensitively.
   *
   * The generated Kotlin enumerators are the member name upper-cased with
   * separators stripped (`skipToNext` → `SKIPTONEXT`), which is the same
   * mapping `MediaControl.valueOf(name.uppercase())` performs — so this is a
   * lookup, not a hand-written table that could fall out of step with the spec.
   */
  private fun control(name: String): MediaControl? =
    runCatching { MediaControl.valueOf(name.uppercase()) }.getOrNull()

  private fun capability(name: String): MediaCapability? =
    runCatching { MediaCapability.valueOf(name.uppercase()) }.getOrNull()

  private inline fun <T> JSONArray?.mapNotNull(transform: (String) -> T?): List<T> {
    if (this == null) return emptyList()
    val out = ArrayList<T>(length())
    for (index in 0 until length()) {
      val value = optString(index).takeIf { it.isNotEmpty() } ?: continue
      transform(value)?.let(out::add)
    }
    return out
  }

  private fun JSONObject.optStringOrNull(name: String): String? =
    if (isNull(name)) null else optString(name).takeIf { it.isNotEmpty() }

  private fun JSONObject.optDoubleOrNull(name: String): Double? =
    if (isNull(name) || !has(name)) null else optDouble(name).takeIf { !it.isNaN() }

  private fun JSONObject.optIntOrNull(name: String): Int? =
    if (isNull(name) || !has(name)) null else optInt(name, -1)

  /**
   * Must equal `PERSISTENCE_SCHEMA_VERSION` in `persistence.ts`.
   *
   * Duplicated rather than bridged on purpose: a constant that has to cross the
   * bridge to be read is a constant the service cannot check when JavaScript is
   * exactly what it does not have. A mismatch here is read as "written by a
   * version I do not understand" and resumption is skipped — the same answer
   * `restorePersisted` gives the app.
   *
   * The duplication is guarded, not merely documented: `SchemaVersionSyncTest`
   * reads the number out of `persistence.ts` and fails this module's build if
   * the two ever disagree. That is why this is `internal` rather than
   * `private` — the object it lives in is already `internal`, so nothing about
   * the module's surface changes.
   */
  internal const val SCHEMA_VERSION = 2
}
