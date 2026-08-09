import { createRunOncePlugin, type ConfigPlugin } from 'expo/config-plugins'

import { withBackgroundAudio } from './withBackgroundAudio'
import { withAndroidNotificationIcon } from './withNotificationIcon'

/**
 * Options for the `@rn-media/media-session` Expo config plugin.
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
}

const withRnMediaMediaSession: ConfigPlugin<MediaSessionPluginProps | void> = (
  config,
  props
) => {
  const iconPath = props ? props.androidNotificationIcon : undefined

  const withAudio = withBackgroundAudio(config)

  return iconPath === undefined
    ? withAudio
    : withAndroidNotificationIcon(withAudio, iconPath)
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
  withAndroidNotificationIcon,
}
export {
  resolveDrawableTarget,
  type DrawableTarget,
} from './withNotificationIcon'
