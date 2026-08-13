package com.rnmediaplayerexample

import android.view.KeyEvent
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.google.android.gms.cast.framework.CastContext

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "RnMediaPlayerExample"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * Hardware volume keys drive the SPEAKER while a cast session is up — what
   * Spotify does on Android, scoped to the foreground Activity because that is
   * where key events exist.
   *
   * Why the app has to do this at all (device-verified on this project's
   * POCO F4 round): `@rn-media/cast` deliberately disables the Cast
   * framework's own MediaSession (`setMediaSessionEnabled(false)` — the
   * media-session package is the single session owner, per the fan-out
   * contract), and that framework session is exactly the piece that would
   * have routed volume keys to the receiver (`setPlaybackToRemote`). The
   * app's media3 session advertises local playback, so without this override
   * the keys move the phone's silent music stream while the speaker plays on.
   * Background/lock-screen volume keys still cannot reach the receiver — that
   * needs a remote-playback media session, a documented follow-up in
   * ARCHITECTURE §25.
   */
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val keyCode = event.keyCode
    if (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
      val session =
          try {
            CastContext.getSharedInstance()?.sessionManager?.currentCastSession
          } catch (_: Exception) {
            null // framework not initialized (GMS-less, or cast never touched)
          }
      if (session != null && session.isConnected) {
        if (event.action == KeyEvent.ACTION_DOWN) {
          try {
            val delta = if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) VOLUME_STEP else -VOLUME_STEP
            session.volume = (session.volume + delta).coerceIn(0.0, 1.0)
          } catch (_: Exception) {
            // The session raced away between the check and the write; the
            // deviceVolume event stream keeps the UI honest either way.
          }
        }
        return true // consumed: the speaker owns loudness during the session
      }
    }
    return super.dispatchKeyEvent(event)
  }

  private companion object {
    /** One key press ≈ one notch on a 20-step volume rocker. */
    const val VOLUME_STEP = 0.05
  }
}
