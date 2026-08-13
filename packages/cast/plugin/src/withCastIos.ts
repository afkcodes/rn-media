import {
  withInfoPlist,
  withPodfileProperties,
  type ConfigPlugin,
} from 'expo/config-plugins'

/**
 * The receiver application id of Google's Default Media Receiver
 * (`kGCKDefaultMediaReceiverApplicationID` / `CastMediaControlIntent
 * .DEFAULT_MEDIA_RECEIVER_APPLICATION_ID`). Used for the app-ID-specific
 * Bonjour string when no custom receiver id is configured.
 */
const DEFAULT_MEDIA_RECEIVER_APP_ID = 'CC1AD845'

/** The google-cast-sdk pod's own floor (4.8.x); see RnMediaCast.podspec. */
const REQUIRED_IOS_VERSION = '16.0'

/**
 * The exact `NSBonjourServices` strings Cast discovery needs on iOS 14+
 * (developers.google.com/cast/docs/ios_sender: "Add `_googlecast._tcp` and
 * `_<your-app-id>._googlecast._tcp` to NSBonjourServices"). Getting the
 * app-ID-specific string wrong is the classic discovery-finds-nothing bug —
 * which is why the plugin generates it instead of documenting it.
 */
function bonjourServices(receiverAppId: string | undefined): string[] {
  const appId = receiverAppId ?? DEFAULT_MEDIA_RECEIVER_APP_ID
  return ['_googlecast._tcp', `_${appId}._googlecast._tcp`]
}

export const withCastIosPlist: ConfigPlugin<{
  receiverAppId?: string
  localNetworkUsageDescription?: string
}> = (config, { receiverAppId, localNetworkUsageDescription }) =>
  withInfoPlist(config, (plistConfig) => {
    const plist = plistConfig.modResults

    const existing = plist.NSBonjourServices
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(
        '[@rn-media/cast] Expected `ios.infoPlist.NSBonjourServices` to be an ' +
          `array of strings, received ${typeof existing}. Fix it in your app config.`
      )
    }
    // Merge, never assign: the app (or another library — Spotify SDK, SSDP
    // tooling) may already declare Bonjour services of its own.
    const services = (existing as string[] | undefined) ?? []
    const merged = [
      ...services,
      ...bonjourServices(receiverAppId).filter((s) => !services.includes(s)),
    ]
    plist.NSBonjourServices = merged

    // Without this key iOS 14+ silently denies local-network access and
    // discovery finds nothing. The prompt itself appears on first cast-button
    // use, never earlier — an OS rule, not a library choice.
    if (localNetworkUsageDescription !== undefined) {
      plist.NSLocalNetworkUsageDescription = localNetworkUsageDescription
    } else if (plist.NSLocalNetworkUsageDescription === undefined) {
      plist.NSLocalNetworkUsageDescription =
        `${plistConfig.name ?? 'This app'} uses the local network to discover ` +
        'Cast-enabled devices on your Wi-Fi network.'
    }

    return plistConfig
  })

/**
 * The google-cast-sdk pod requires iOS 16.0 while the React Native default
 * target is lower — without this bump `pod install` fails with a resolver
 * error naming the pod. Raises `ios.deploymentTarget` in Podfile properties
 * when it is absent or lower; never lowers an app that already targets
 * higher. Loud on purpose: this is a consumer-visible floor change (README
 * "iOS 16 requirement").
 */
export const withCastIosDeploymentTarget: ConfigPlugin = (config) =>
  withPodfileProperties(config, (propsConfig) => {
    const current = propsConfig.modResults['ios.deploymentTarget']
    if (
      current === undefined ||
      compareVersions(current, REQUIRED_IOS_VERSION) < 0
    ) {
      console.warn(
        `[@rn-media/cast] Raising ios.deploymentTarget from ${current ?? 'the RN default'} ` +
          `to ${REQUIRED_IOS_VERSION}: the google-cast-sdk pod requires iOS ${REQUIRED_IOS_VERSION}. ` +
          'Devices on older iOS versions will not be able to install the app.'
      )
      propsConfig.modResults['ios.deploymentTarget'] = REQUIRED_IOS_VERSION
    }
    return propsConfig
  })

/** `"15.1" < "16.0"` — numeric per dotted segment, missing segments are 0. */
function compareVersions(a: string, b: string): number {
  const as = a.split('.').map((s) => Number.parseInt(s, 10) || 0)
  const bs = b.split('.').map((s) => Number.parseInt(s, 10) || 0)
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const diff = (as[i] ?? 0) - (bs[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
