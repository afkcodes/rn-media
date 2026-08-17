package com.rnmediamediasession

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import com.margelo.nitro.rnmediamediasession.SessionErrorCode

/**
 * A silent local audio output, held only while an app has opted in through
 * `RemotePlayback.holdLocalAudioSlot`.
 *
 * ## Why this exists (bug #53)
 *
 * `MediaSessionService.dispatchAdjustVolumeLocked` discards the session it just
 * chose — and then drops the key entirely — when the *caller's* uid was the
 * last to play local audio:
 *
 * ```java
 * if (session != null && session.getUid() != uid
 *         && mAudioPlayerStateMonitor.hasUidPlayedAudioLast(uid)) {
 *     // b/275185436
 *     session = null;
 * ```
 *
 * With the screen off the caller is `PhoneWindowManager`, so `uid` is 1000 —
 * the system. Any system sound (a notification, a ringtone) therefore takes the
 * hardware volume keys away from a remote session, and because a remote backend
 * plays nothing on the local `STREAM_MUSIC`, the press moves *neither* device.
 * It is sticky rather than momentary: `cleanUpAudioPlaybackUids` walks from the
 * tail and breaks at the media button session's uid, so it can never evict
 * index 0, and an app whose audio is remote never plays locally to displace it.
 *
 * The one escape the platform documents is in the same file: when the head uid
 * goes *inactive*, `AudioPlayerStateMonitor.onPlaybackConfigChanged` promotes
 * the first still-**active** uid to index 0. Holding a started `AudioTrack`
 * makes this app that uid, so the slot comes back on its own the moment the
 * interfering sound ends. Nothing else in the public API moves that list.
 *
 * ## Why it is opt-in
 *
 * This opens a real output for the whole remote session, which keeps the audio
 * HAL awake — measurable battery for a feature the user only notices when they
 * reach for the rocker. It also makes `isStreamActive(STREAM_MUSIC)` true,
 * which *changes* the remaining failure mode rather than only removing one: if
 * the session is discarded for the other documented reason (playback is not
 * PLAYING), the key now moves the phone's volume instead of doing nothing.
 *
 * ## What it deliberately does not do
 *
 * - **No audio focus.** An `AudioTrack` never requests focus on its own
 *   (`PlayerBase` registration and `AudioManager.requestAudioFocus` are
 *   unrelated paths — `AudioTrack.java` contains no focus call at all), so this
 *   cannot fight `@rn-media/audio-session`'s focus wiring or duck anybody.
 *
 *   The *reverse* coupling exists and is accepted: `USAGE_MEDIA` is fadeable by
 *   default (`FadeManagerConfiguration.DEFAULT_FADEABLE_USAGES`), so if the app
 *   loses focus this track is faded to gain 0 like any other. That sets
 *   `MUTED_BY_VOLUME_SHAPER`, which `isActive()` treats as inactive, so the slot
 *   is briefly given up while something else owns the output. That is the
 *   correct behaviour — the volume keys belong to whatever is actually
 *   audible — and it self-heals when focus returns.
 * - **No engine involvement.** It does not touch the player. mpv stays paused
 *   through the handoff exactly as before; this is a second, silent output that
 *   exists only to hold a slot in a platform list.
 * - **Never outlives the remote session.** [set] is driven from the same
 *   `setRemotePlayback` call that publishes the device, so clearing remote
 *   playback releases the track in the same hop.
 *
 * Main-thread confined, like the rest of the controller's state.
 */
internal class LocalAudioSlot {
  private var track: AudioTrack? = null

  /** `true` while a track is held — for tests and for the log line. */
  val held: Boolean
    get() = track != null

  /**
   * Hold or release the slot. Idempotent in both directions, because
   * `setRemotePlayback` is republished on every remote volume change and
   * re-creating the track each time would be both wasteful and audible as a
   * gap in the platform's "active" bookkeeping.
   */
  fun set(enabled: Boolean) {
    if (enabled) start() else stop()
  }

  private fun start() {
    if (track != null) return
    track =
      runCatching { buildSilentTrack() }
        .onFailure {
          // Never fatal: the remote session still works, it is only the
          // screen-off volume keys that stay exposed to the platform's
          // heuristic. Reported once rather than thrown into a JS call —
          // `setRemotePlayback` is republished on every remote volume change,
          // so an un-deduplicated report would arrive per notch.
          SessionErrors.report(
            SessionErrorCode.LOCALAUDIOSLOTUNAVAILABLE,
            "holdLocalAudioSlot: could not open the silent output; hardware " +
              "volume keys may stop reaching the remote device once a system " +
              "sound plays (see RemotePlayback.holdLocalAudioSlot). " +
              "(${it.javaClass.simpleName}: ${it.message})",
            dedupeKey = "local-audio-slot",
            cause = it,
          )
        }
        .getOrNull()
  }

  private fun stop() {
    val current = track ?: return
    track = null
    // stop() before release(): release() alone leaves the platform's last
    // observed player state as STARTED for an instant, and the point of this
    // class is to be honest about exactly that bit.
    runCatching { current.stop() }
    runCatching { current.release() }
  }

  /**
   * The cheapest track that still registers as an active player.
   *
   * `MODE_STATIC` with an all-zero buffer and an infinite loop
   * (`setLoopPoints(0, frames, -1)`) means the framework holds the buffer and
   * repeats it forever: no writer thread, no periodic wakeup, no per-buffer
   * work in this process at all. `StaticAudioTrackServerProxy::pollPosition`
   * reports `INT64_MAX` frames ready for a `-1` loop count, so it also never
   * underruns — which matters because a static track that runs dry is dropped
   * from AudioFlinger's active list (`prepareTracks_l`) even though its Java
   * player state would still read STARTED.
   *
   * **The sample rate is the device's own**, not a token-small one: a mismatch
   * puts a resampler in the mixer path for every buffer, forever, to convert
   * silence into silence. 200 ms mono 16-bit at the native rate is ~19 kB and
   * costs nothing to hold.
   *
   * `USAGE_MEDIA` is required rather than cosmetic — it is what maps to
   * `STREAM_MUSIC` (`AudioAttributes.toVolumeStreamType`), so it is the only
   * usage that looks like the playback the platform heuristic reasons about.
   * The volume is deliberately left at 1.0: `setVolume(0f)` would set
   * `MUTED_BY_CLIENT_VOLUME`, and `AudioPlaybackConfiguration.isActive()`
   * returns false for a client-muted track — which would defeat the entire
   * point. Silence comes from zero *samples*, never from gain.
   */
  private fun buildSilentTrack(): AudioTrack {
    val sampleRate =
      AudioTrack.getNativeOutputSampleRate(AudioManager.STREAM_MUSIC).takeIf { it > 0 } ?: 44_100
    val frames = (sampleRate / 5).coerceAtLeast(MIN_LOOP_FRAMES) // 200 ms
    val bytes = frames * 2 // 16-bit mono

    val attributes =
      AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
        .apply {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Free hygiene: nobody's screen recorder should mix in our loop.
            setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_NONE)
          }
        }
        .build()
    val format =
      AudioFormat.Builder()
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setSampleRate(sampleRate)
        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
        .build()

    // `PERFORMANCE_MODE_POWER_SAVING` asks for the deep-buffer path, which
    // wakes the mixer far less often. Whether a HAL accepts a MODE_STATIC track
    // there is device-dependent and is NOT guaranteed by any AOSP contract, so
    // it is an attempt, not a requirement: falling back to the default mode
    // keeps the feature working on a device that refuses it.
    val track =
      buildTrack(attributes, format, bytes, powerSaving = true)
        ?: buildTrack(attributes, format, bytes, powerSaving = false)
        ?: error("AudioTrack.build() failed in both performance modes")

    // A zeroed buffer *is* the payload; MODE_STATIC copies it once. This write
    // is also what moves the track out of STATE_NO_STATIC_DATA, without which
    // play() throws — and setLoopPoints must precede play(), which rejects a
    // track that is already PLAYING.
    track.write(ShortArray(frames), 0, frames)
    check(track.setLoopPoints(0, frames, -1) == AudioTrack.SUCCESS) {
      "setLoopPoints rejected a ${frames}-frame infinite loop"
    }
    track.play()
    return track
  }

  private fun buildTrack(
    attributes: AudioAttributes,
    format: AudioFormat,
    bytes: Int,
    powerSaving: Boolean,
  ): AudioTrack? =
    runCatching {
        AudioTrack.Builder()
          .setAudioAttributes(attributes)
          .setAudioFormat(format)
          .setBufferSizeInBytes(bytes)
          .setTransferMode(AudioTrack.MODE_STATIC)
          .apply {
            if (powerSaving && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
              setPerformanceMode(AudioTrack.PERFORMANCE_MODE_POWER_SAVING)
            }
          }
          .build()
      }
      .getOrNull()

  private companion object {
    /** AudioFlinger's own `MIN_LOOP`, below which a loop is rejected. */
    const val MIN_LOOP_FRAMES = 16
  }
}
