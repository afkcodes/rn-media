import { createRunOncePlugin, type ConfigPlugin } from 'expo/config-plugins'

import { withCastAndroid } from './withCastAndroid'
import { withCastIosDeploymentTarget, withCastIosPlist } from './withCastIos'

/**
 * Options for the `@timbre/cast` Expo config plugin.
 *
 * Zero props is a working setup: the Default Media Receiver, generated
 * Bonjour strings, a stock local-network prompt text, and the shipped
 * Android `OptionsProvider`.
 */
export interface CastPluginProps {
  /**
   * Cast receiver application id from the Cast Developer Console. Omit for
   * the Default Media Receiver (zero-config). Drives BOTH platforms: the
   * Android `RECEIVER_APPLICATION_ID` meta-data our `OptionsProvider` reads,
   * and the app-ID-specific `_<APPID>._googlecast._tcp` Bonjour string iOS
   * discovery requires — the string everyone gets wrong by hand, which is
   * why the plugin generates it.
   */
  readonly receiverAppId?: string

  /**
   * `NSLocalNetworkUsageDescription` text for the iOS local-network
   * permission prompt (shown by the OS on first cast use, never earlier).
   * Defaults to a sensible sentence naming the app.
   */
  readonly localNetworkUsageDescription?: string
}

/**
 * NOTE the loud one: installing this plugin raises the app's
 * `ios.deploymentTarget` to **16.0** (the google-cast-sdk pod's own floor).
 * See the package README's "iOS 16 requirement" section before shipping.
 *
 * Bare (non-prebuild) projects apply the same changes by hand — the README's
 * "Bare React Native setup" section lists the exact manifest and Info.plist
 * lines.
 */
const withRnMediaCast: ConfigPlugin<CastPluginProps | void> = (
  config,
  props
) => {
  const receiverAppId = props ? props.receiverAppId : undefined
  const localNetworkUsageDescription = props
    ? props.localNetworkUsageDescription
    : undefined

  const withAndroid = withCastAndroid(config, { receiverAppId })
  const withPlist = withCastIosPlist(withAndroid, {
    receiverAppId,
    localNetworkUsageDescription,
  })
  return withCastIosDeploymentTarget(withPlist)
}

const pkg = require('../../package.json') as { name: string; version: string }

/**
 * Run-once so that an app listing the plugin itself *and* depending on
 * another library that lists it does not get the mods applied twice.
 */
export default createRunOncePlugin(withRnMediaCast, pkg.name, pkg.version)

export {
  withRnMediaCast,
  withCastAndroid,
  withCastIosPlist,
  withCastIosDeploymentTarget,
}
