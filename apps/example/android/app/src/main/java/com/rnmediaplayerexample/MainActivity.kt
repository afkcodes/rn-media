package com.rnmediaplayerexample

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

/**
 * Note what is **no longer** here: a `dispatchKeyEvent` override forwarding the
 * hardware volume keys to the cast session.
 *
 * That override was this app's foreground-only workaround for volume keys not
 * reaching the receiver, and it is gone because the library now does the whole
 * job properly. While the cast side owns playback the app publishes
 * `MediaService.setRemotePlayback({ volume, muted })`; the media session then
 * advertises `DeviceInfo.PLAYBACK_TYPE_REMOTE`, media3 puts the platform
 * session into remote volume handling (`MediaSession.setPlaybackToRemote` —
 * "This must be called to receive volume button events"), and Android routes
 * every volume press to the session's volume provider instead of to the phone's
 * music stream.
 *
 * Because the routing lives on the *session* rather than on an Activity, it
 * works in exactly the states an Activity cannot help with — app backgrounded,
 * screen locked — and it keeps working in the foreground, where the key event
 * simply falls through to the platform's session routing instead of being
 * intercepted here. One path for both, verified on device (POCO F4 + Mi Smart
 * Speaker, 2026-08-14).
 */
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
}
