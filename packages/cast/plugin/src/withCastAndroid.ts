import {
  AndroidConfig,
  withAndroidManifest,
  type ConfigPlugin,
} from 'expo/config-plugins'

/**
 * The Cast framework's manifest hook: it instantiates this class reflectively
 * to get its `CastOptions`. The value points at the provider this package
 * ships (`packages/cast/android/.../RnMediaCastOptionsProvider.kt`).
 */
const OPTIONS_PROVIDER_KEY =
  'com.google.android.gms.cast.framework.OPTIONS_PROVIDER_CLASS_NAME'
const OPTIONS_PROVIDER_CLASS = 'com.rnmediacast.RnMediaCastOptionsProvider'

/** Read by `RnMediaCastOptionsProvider`; absent = Default Media Receiver. */
const RECEIVER_APP_ID_KEY = 'com.rnmediacast.RECEIVER_APPLICATION_ID'

/**
 * androidx.mediarouter's marker receiver. Declaring it is what enables the
 * whole output-switcher feature set (stream transfer, remote-to-local) —
 * without it the `CastOptions` flags the library sets are silently inert
 * (developers.google.com/cast/docs/android_sender/output_switcher).
 */
const MEDIA_TRANSFER_RECEIVER =
  'androidx.mediarouter.media.MediaTransferReceiver'

type ManifestApplication = AndroidConfig.Manifest.ManifestApplication
/** Not exported by `expo/config-plugins`; taken off the application type. */
type ManifestReceiver = NonNullable<ManifestApplication['receiver']>[number]
type ManifestMetaData = NonNullable<ManifestApplication['meta-data']>[number]

function upsertMetaData(
  application: ManifestApplication,
  name: string,
  value: string,
  { keepExisting }: { keepExisting: boolean }
): void {
  const items = application['meta-data'] ?? []
  const existing = items.find((item) => item.$['android:name'] === name)
  if (existing !== undefined) {
    // An existing OPTIONS_PROVIDER declaration is the app's own choice (its
    // own provider, or another library's) — clobbering it would break that
    // app's cast setup at runtime with nothing failing at build time. The
    // receiver-app-id, by contrast, is OUR key: the plugin prop is its source
    // of truth and re-running prebuild must converge on the prop.
    if (!keepExisting) existing.$['android:value'] = value
    return
  }
  const entry: ManifestMetaData = {
    $: { 'android:name': name, 'android:value': value },
  }
  application['meta-data'] = [...items, entry]
}

/**
 * Adds the three Android pieces of Cast setup to the generated manifest:
 *
 * 1. `OPTIONS_PROVIDER_CLASS_NAME` meta-data pointing at the shipped
 *    `RnMediaCastOptionsProvider` (left alone if the app already declares a
 *    provider of its own);
 * 2. the `RECEIVER_APPLICATION_ID` meta-data, when the prop is set;
 * 3. the `MediaTransferReceiver` manifest entry (exported, no intent filter —
 *    it is a marker the system queries, not a real receiver).
 *
 * Deliberately a plugin mod rather than entries in the library's own
 * AndroidManifest: an AAR-merged provider would collide with apps that
 * already have one, and `MediaTransferReceiver` changes system-UI behaviour
 * for every app that installs the package — both are the app's decision.
 * Bare (non-prebuild) projects paste the same three lines by hand (README).
 */
export const withCastAndroid: ConfigPlugin<{ receiverAppId?: string }> = (
  config,
  { receiverAppId }
) =>
  withAndroidManifest(config, (manifestConfig) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(
      manifestConfig.modResults
    )

    upsertMetaData(application, OPTIONS_PROVIDER_KEY, OPTIONS_PROVIDER_CLASS, {
      keepExisting: true,
    })
    if (receiverAppId !== undefined) {
      upsertMetaData(application, RECEIVER_APP_ID_KEY, receiverAppId, {
        keepExisting: false,
      })
    }

    const receivers = application.receiver ?? []
    if (
      !receivers.some(
        (receiver) => receiver.$['android:name'] === MEDIA_TRANSFER_RECEIVER
      )
    ) {
      const entry: ManifestReceiver = {
        // Must stay exported: the caller is the system's media routing, not
        // the app.
        $: {
          'android:name': MEDIA_TRANSFER_RECEIVER,
          'android:exported': 'true',
        },
      }
      application.receiver = [...receivers, entry]
    }

    return manifestConfig
  })
