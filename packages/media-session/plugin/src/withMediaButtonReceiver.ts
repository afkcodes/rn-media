import {
  AndroidConfig,
  withAndroidManifest,
  type ConfigPlugin,
} from 'expo/config-plugins'

/**
 * media3's own receiver. Declaring it is what makes
 * `MediaSessionLegacyStub.canResumePlaybackOnStart()` true — that method is
 * literally "is there a receiver for `ACTION_MEDIA_BUTTON` in this app?" — and
 * that is what makes the System UI offer a resumption card and routes a
 * headset/Bluetooth play into a process that is no longer running.
 */
const RECEIVER_NAME = 'androidx.media3.session.MediaButtonReceiver'

const MEDIA_BUTTON_ACTION = 'android.intent.action.MEDIA_BUTTON'

type ManifestApplication = AndroidConfig.Manifest.ManifestApplication
/** Not exported by `expo/config-plugins`; taken off the application type. */
type ManifestReceiver = NonNullable<ManifestApplication['receiver']>[number]

function isMediaButtonFilter(
  filter: NonNullable<ManifestReceiver['intent-filter']>[number]
): boolean {
  return (
    filter.action?.some(
      (action) => action.$['android:name'] === MEDIA_BUTTON_ACTION
    ) ?? false
  )
}

/**
 * Adds media3's `MediaButtonReceiver` to the app's manifest.
 *
 * ## Why a plugin can do what the library must not
 * `@rn-media/media-session` deliberately does **not** merge this receiver in
 * from its own manifest: an AAR's declaration lands in every app that installs
 * the package, changing media-button routing for apps that never asked for
 * playback resumption, and media3 reads the declaration as the app's *promise*
 * that it can resume. So it stays the app's decision — which for a bare project
 * is a copy-paste into `AndroidManifest.xml`, and for a prebuild project cannot
 * be, because `android/` is regenerated. This mod is that same copy-paste,
 * expressed where an Expo app is able to make the decision: opt-in, off by
 * default, and applied only when `playbackResumption: true`.
 *
 * ## Idempotency
 * Prebuild runs mods over whatever is already there — a previously generated
 * `android/`, another library's plugin, or the app's own
 * `android.manifest` edits. So:
 * - a receiver with this name and a `MEDIA_BUTTON` filter is left completely
 *   alone (attributes included: an app that set `android:enabled` or an
 *   explicit `android:process` meant it);
 * - a receiver with this name but no `MEDIA_BUTTON` filter gets the filter, and
 *   only the filter — that declaration is invisible to
 *   `PackageManager.queryBroadcastReceivers`, so resumption would be silently
 *   inert with the receiver seemingly present;
 * - anything else appends one receiver.
 *
 * The receiver must stay `android:exported="true"`: the sender is the system's
 * media-button dispatcher, not the app.
 */
export const withMediaButtonReceiver: ConfigPlugin = (config) =>
  withAndroidManifest(config, (manifestConfig) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(
      manifestConfig.modResults
    )
    const receivers = application.receiver ?? []
    const existing = receivers.find(
      (receiver) => receiver.$['android:name'] === RECEIVER_NAME
    )

    if (existing === undefined) {
      application.receiver = [
        ...receivers,
        {
          $: { 'android:name': RECEIVER_NAME, 'android:exported': 'true' },
          'intent-filter': [{ action: [{ $: { 'android:name': MEDIA_BUTTON_ACTION } }] }],
        },
      ]
      return manifestConfig
    }

    const filters = existing['intent-filter'] ?? []
    if (!filters.some(isMediaButtonFilter)) {
      existing['intent-filter'] = [
        ...filters,
        { action: [{ $: { 'android:name': MEDIA_BUTTON_ACTION } }] },
      ]
    }

    return manifestConfig
  })
