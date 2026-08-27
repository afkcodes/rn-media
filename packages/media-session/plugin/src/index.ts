import { createRunOncePlugin, type ConfigPlugin } from 'expo/config-plugins'

import { withBackgroundAudio } from './withBackgroundAudio'
import { withCarPlay } from './withCarPlay'
import { withMediaButtonReceiver } from './withMediaButtonReceiver'
import { withAndroidNotificationIcon } from './withNotificationIcon'

/**
 * Options for the `@afkcodes/timbre-media-session` Expo config plugin.
 *
 * Everything required for background playback is applied without options —
 * Android needs nothing at all (the library manifest merges the
 * foreground-service permissions and the `mediaPlayback` service into the app),
 * and iOS only needs the background audio mode.
 */
export interface MediaSessionPluginProps {
  /**
   * Path — relative to the project root — of a drawable to install as the
   * Android notification small icon, e.g. `'./assets/ic_notification.xml'`.
   *
   * Supply a **vector drawable** (`.xml`) or a 96x96 px white-on-transparent
   * `.png`/`.webp`; the file name (without extension) becomes the resource name
   * to pass as `android.notificationIcon` when calling `MediaService.init`.
   *
   * Only meaningful under Expo prebuild, where `android/` is generated and the
   * app has no other way to add a resource. Omit it to keep media3's built-in
   * small icon.
   */
  readonly androidNotificationIcon?: string

  /**
   * Add media3's `MediaButtonReceiver` to the generated Android manifest.
   *
   * Required by — and only by — playback resumption after process death
   * (`android.playbackResumption` at `MediaService.init`): media3 reads the
   * declaration as the app's promise that it can resume, and without it the
   * System UI never offers a resumption card and a headset play cannot revive a
   * killed process. Set both or neither.
   *
   * Off by default, and deliberately not merged in from the library's own
   * manifest: it changes media-button routing for every app that installs the
   * package. Bare (non-prebuild) projects paste the receiver into their own
   * `AndroidManifest.xml` instead — see the package README.
   *
   * @default false
   */
  readonly playbackResumption?: boolean

  /**
   * Make the app a CarPlay **audio** app: adds `UIApplicationSceneManifest`
   * (this package's CarPlay and phone-window scene delegates) to `Info.plist`
   * and `com.apple.developer.carplay-audio` to the entitlements.
   *
   * Off by default, and deliberately so: the scene manifest changes how *every*
   * launch of the app works on every device, car or no car. Adopting it is the
   * app's decision, exactly as `playbackResumption` is on Android.
   *
   * The key alone is enough for the CarPlay simulator (I/O → External Displays
   * → CarPlay). A real head unit additionally needs Apple to grant the
   * entitlement on your developer account — a request only you can make:
   * https://developer.apple.com/documentation/carplay/requesting-carplay-entitlements
   *
   * Bare (non-prebuild) projects add the same two snippets by hand — see the
   * package README.
   *
   * @default false
   */
  readonly carPlay?: boolean
}

const withRnMediaMediaSession: ConfigPlugin<MediaSessionPluginProps | void> = (
  config,
  props
) => {
  const iconPath = props ? props.androidNotificationIcon : undefined
  const playbackResumption = props ? props.playbackResumption === true : false
  const carPlay = props ? props.carPlay === true : false

  const withAudio = withBackgroundAudio(config)
  const withScenes = carPlay ? withCarPlay(withAudio) : withAudio
  const withReceiver = playbackResumption
    ? withMediaButtonReceiver(withScenes)
    : withScenes

  return iconPath === undefined
    ? withReceiver
    : withAndroidNotificationIcon(withReceiver, iconPath)
}

const pkg = require('../../package.json') as { name: string; version: string }

/**
 * Run-once so that an app listing the plugin itself *and* depending on another
 * library that lists it does not get the mods applied twice.
 */
export default createRunOncePlugin(
  withRnMediaMediaSession,
  pkg.name,
  pkg.version
)

export {
  withRnMediaMediaSession,
  withBackgroundAudio,
  withCarPlay,
  withMediaButtonReceiver,
  withAndroidNotificationIcon,
}
export { applyCarPlaySceneManifest } from './withCarPlay'
export {
  resolveDrawableTarget,
  type DrawableTarget,
} from './withNotificationIcon'
