import {
  withEntitlementsPlist,
  withInfoPlist,
  type ConfigPlugin,
  type InfoPlist,
} from 'expo/config-plugins'

/**
 * The scene-session role CarPlay looks up when the head unit connects.
 * (developer.apple.com/documentation/carplay/cptemplateapplicationscenedelegate,
 * read 2026-08-26.)
 */
const CARPLAY_ROLE = 'CPTemplateApplicationSceneSessionRoleApplication'

/** The role the *phone* window is created from once the app is scene-based. */
const WINDOW_ROLE = 'UIWindowSceneSessionRoleApplication'

/**
 * The two delegates this package ships, by their Objective-C runtime names.
 *
 * They are looked up by string from the plist, which is why both Swift classes
 * carry an explicit `@objc(...)` with the bare name — a Swift class is
 * otherwise registered as `<Module>.<Class>` and the lookup would silently find
 * nothing (CarPlay then connects a scene with no delegate: a black head unit).
 */
const CARPLAY_DELEGATE = 'RnMediaCarPlaySceneDelegate'
const WINDOW_DELEGATE = 'RnMediaWindowSceneDelegate'

/**
 * The Apple-approved, managed capability for a CarPlay **audio** app. Setting
 * the key is what makes the CarPlay simulator (I/O → External Displays →
 * CarPlay) show the app; a real head unit additionally needs the entitlement
 * granted on the developer account, which is a request only the app's owner can
 * make (developer.apple.com/documentation/carplay/requesting-carplay-entitlements).
 */
const CARPLAY_ENTITLEMENT = 'com.apple.developer.carplay-audio'

/** One entry of a `UISceneConfigurations` role array. */
interface SceneConfiguration {
  UISceneConfigurationName: string
  UISceneDelegateClassName: string
  UISceneClassName?: string
  UISceneStoryboardFile?: string
  [key: string]: unknown
}

interface SceneManifest {
  UIApplicationSupportsMultipleScenes?: boolean
  UISceneConfigurations?: Record<string, SceneConfiguration[]>
  [key: string]: unknown
}

const CARPLAY_SCENE: SceneConfiguration = {
  UISceneClassName: 'CPTemplateApplicationScene',
  UISceneConfigurationName: 'RnMediaCarPlay',
  UISceneDelegateClassName: CARPLAY_DELEGATE,
}

const WINDOW_SCENE: SceneConfiguration = {
  UISceneClassName: 'UIWindowScene',
  UISceneConfigurationName: 'RnMediaPhone',
  UISceneDelegateClassName: WINDOW_DELEGATE,
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function malformed(key: string, received: unknown): Error {
  return new Error(
    `[@afkcodes/timbre-media-session] Expected \`ios.infoPlist.${key}\` to be ` +
      `${key.endsWith('Configurations') ? 'an object of role arrays' : 'an object'}, ` +
      `received ${Array.isArray(received) ? 'an array' : typeof received}. ` +
      'Fix it in your app config, or drop `carPlay: true` and write the scene ' +
      'manifest yourself.'
  )
}

/**
 * Merge this package's two scene configurations into `plist`, in place, and
 * return it.
 *
 * Exported for the same reason `resolveDrawableTarget` is: it is the whole
 * decision, it is pure, and it is what the tests exercise.
 *
 * ## What it will and will not touch
 * - `UIApplicationSupportsMultipleScenes` is forced to `true`. It is not an
 *   opinion: without it iOS refuses to create a second scene, and the CarPlay
 *   scene *is* the second one (F11). An app that set it to `false` and also
 *   asked for CarPlay asked for two contradictory things; CarPlay wins, because
 *   it is the thing that was explicitly opted into.
 * - A role that already has **any** configuration is left completely alone.
 *   An app with its own `UIWindowSceneSessionRoleApplication` delegate has a
 *   scene-based launch path of its own, and replacing that delegate would
 *   replace the app's own startup — see `RnMediaWindowSceneDelegate`, which is
 *   only a shim for apps that have none.
 * - Anything else in the manifest (other roles, `UISceneStoryboardFile`,
 *   vendor keys) is preserved.
 */
export function applyCarPlaySceneManifest(plist: InfoPlist): InfoPlist {
  const existing = plist.UIApplicationSceneManifest
  if (existing !== undefined && !isPlainObject(existing)) {
    throw malformed('UIApplicationSceneManifest', existing)
  }

  const manifest: SceneManifest = { ...(existing as SceneManifest | undefined) }

  const configurations = manifest.UISceneConfigurations
  if (configurations !== undefined && !isPlainObject(configurations)) {
    throw malformed(
      'UIApplicationSceneManifest.UISceneConfigurations',
      configurations
    )
  }

  const roles: Record<string, SceneConfiguration[]> = { ...configurations }

  for (const [role, scene] of [
    [CARPLAY_ROLE, CARPLAY_SCENE],
    [WINDOW_ROLE, WINDOW_SCENE],
  ] as const) {
    const declared = roles[role]
    if (declared !== undefined && !Array.isArray(declared)) {
      throw malformed(
        `UIApplicationSceneManifest.UISceneConfigurations.${role}`,
        declared
      )
    }
    // Non-empty means the app (or another plugin) already owns this role.
    if (declared !== undefined && declared.length > 0) continue
    roles[role] = [{ ...scene }]
  }

  manifest.UIApplicationSupportsMultipleScenes = true
  manifest.UISceneConfigurations = roles
  // `InfoPlist`'s value type is `JSONValue`, and `SceneManifest`'s index
  // signature is `unknown` because a plist may legitimately carry keys this
  // file has never heard of. The cast is the seam between those two truths; the
  // object above is built only from JSON-representable values.
  plist.UIApplicationSceneManifest = manifest as never
  return plist
}

/**
 * Makes an Expo app a CarPlay **audio** app.
 *
 * Two edits, and they are exactly the two things an app cannot express any
 * other way under prebuild (F11):
 *
 * 1. `UIApplicationSceneManifest` — CarPlay only connects to a **UIScene-based**
 *    app. Adopting scenes is all-or-nothing: the moment the manifest exists,
 *    iOS stops calling `application(_:didFinishLaunchingWithOptions:)`'s window
 *    setup as the launch path and creates the phone window from a scene
 *    instead. That is why this plugin writes *both* roles — the CarPlay one for
 *    the head unit, and the window one pointing at this package's shim so a
 *    stock React Native app still shows its UI on the phone.
 * 2. `com.apple.developer.carplay-audio` in the entitlements.
 *
 * ## Why this is opt-in
 * The scene manifest changes how *every* launch of the app works, on every
 * device, whether or not a car is ever plugged in. A library that merged it
 * unconditionally would rewrite the startup path of apps that never asked for
 * CarPlay. So it is `carPlay: true`, off by default — the same reasoning as
 * `withMediaButtonReceiver`.
 *
 * ## Idempotency
 * Re-running prebuild is a no-op: a role that already carries a configuration
 * is never touched, which covers both this plugin's own previous run and an app
 * that declared its own delegates.
 *
 * Bare (non-prebuild) projects paste the same two snippets themselves — they
 * are in the package README next to the `MediaButtonReceiver` block.
 */
export const withCarPlay: ConfigPlugin = (config) => {
  const withScenes = withInfoPlist(config, (infoPlistConfig) => {
    applyCarPlaySceneManifest(infoPlistConfig.modResults)
    return infoPlistConfig
  })

  return withEntitlementsPlist(withScenes, (entitlementsConfig) => {
    entitlementsConfig.modResults[CARPLAY_ENTITLEMENT] = true
    return entitlementsConfig
  })
}
