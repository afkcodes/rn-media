import type {
  ConfigPlugin,
  ExportedConfig,
  ExportedConfigWithProps,
  InfoPlist,
  ModPlatform,
} from 'expo/config-plugins'
import { describe, expect, it } from 'vitest'

import {
  applyCarPlaySceneManifest,
  withRnMediaMediaSession,
} from '../src/index'

/** `@expo/config-plugins` does not re-export it; take it off the plugin type. */
type ExpoConfig = Parameters<ConfigPlugin>[0]

const CARPLAY_ROLE = 'CPTemplateApplicationSceneSessionRoleApplication'
const WINDOW_ROLE = 'UIWindowSceneSessionRoleApplication'
const CARPLAY_ENTITLEMENT = 'com.apple.developer.carplay-audio'

function baseConfig(): ExpoConfig {
  return { name: 'test-app', slug: 'test-app' }
}

function withMods(config: ExpoConfig): ExportedConfig {
  return config as ExportedConfig
}

/**
 * What prebuild hands the entitlements mod. `expo/config-plugins` does not
 * re-export `JSONObject`, so it is read off the mod's own signature rather than
 * re-declared — a re-declaration would drift the moment upstream's does.
 */
type EntitlementsMod = NonNullable<
  NonNullable<NonNullable<ExportedConfig['mods']>['ios']>['entitlements']
>
type Entitlements = Parameters<EntitlementsMod>[0]['modResults']

function modConfig<T>(
  config: ExpoConfig,
  modName: string,
  modResults: T
): ExportedConfigWithProps<T> {
  return {
    ...config,
    modResults,
    modRawConfig: config,
    modRequest: {
      projectRoot: '/app',
      platformProjectRoot: '/app/ios',
      modName,
      platform: 'ios' as ModPlatform,
      introspect: false,
    },
  }
}

async function runInfoPlistMod(
  config: ExpoConfig,
  initial: InfoPlist = {}
): Promise<InfoPlist> {
  const mod = withMods(config).mods?.ios?.infoPlist
  if (!mod) throw new Error('expected an ios.infoPlist mod to be registered')

  const result = await mod(modConfig(config, 'infoPlist', initial))
  return result.modResults
}

async function runEntitlementsMod(
  config: ExpoConfig,
  initial: Entitlements = {}
): Promise<Entitlements> {
  const mod = withMods(config).mods?.ios?.entitlements
  if (!mod) throw new Error('expected an ios.entitlements mod to be registered')

  const result = await mod(modConfig(config, 'entitlements', initial))
  return result.modResults
}

/** The shape the plist mod produces, narrowed for readable assertions. */
interface SceneManifest {
  UIApplicationSupportsMultipleScenes?: boolean
  UISceneConfigurations?: Record<string, Record<string, unknown>[]>
}

function manifestOf(plist: InfoPlist): SceneManifest {
  return plist.UIApplicationSceneManifest as unknown as SceneManifest
}

function carPlayConfig(): ExpoConfig {
  return withRnMediaMediaSession(baseConfig(), { carPlay: true })
}

describe('carPlay is opt-in', () => {
  it('registers no scene manifest and no entitlement without the prop', async () => {
    const config = withRnMediaMediaSession(baseConfig())

    expect(withMods(config).mods?.ios?.entitlements).toBeUndefined()
    expect(await runInfoPlistMod(config)).toEqual({
      UIBackgroundModes: ['audio'],
    })
  })

  it('is off when explicitly false, and not dragged in by another option', async () => {
    for (const props of [
      { carPlay: false },
      { playbackResumption: true },
      { androidNotificationIcon: './ic_notification.xml' },
    ]) {
      const config = withRnMediaMediaSession(baseConfig(), props)

      expect(withMods(config).mods?.ios?.entitlements).toBeUndefined()
      expect(
        (await runInfoPlistMod(config)).UIApplicationSceneManifest
      ).toBeUndefined()
    }
  })

  it('still merges the audio background mode when CarPlay is on', async () => {
    // The two iOS mods compose rather than replace each other: CarPlay without
    // background audio would connect to the car and then be suspended.
    expect((await runInfoPlistMod(carPlayConfig())).UIBackgroundModes).toEqual([
      'audio',
    ])
  })
})

describe('withCarPlay (ios.infoPlist)', () => {
  it('writes both scene roles and multiple-scene support', async () => {
    const manifest = manifestOf(await runInfoPlistMod(carPlayConfig()))

    expect(manifest.UIApplicationSupportsMultipleScenes).toBe(true)
    expect(manifest.UISceneConfigurations?.[CARPLAY_ROLE]).toEqual([
      {
        UISceneClassName: 'CPTemplateApplicationScene',
        UISceneConfigurationName: 'RnMediaCarPlay',
        UISceneDelegateClassName: 'RnMediaCarPlaySceneDelegate',
      },
    ])
    expect(manifest.UISceneConfigurations?.[WINDOW_ROLE]).toEqual([
      {
        UISceneClassName: 'UIWindowScene',
        UISceneConfigurationName: 'RnMediaPhone',
        UISceneDelegateClassName: 'RnMediaWindowSceneDelegate',
      },
    ])
  })

  it('is idempotent across repeated prebuilds', async () => {
    const config = carPlayConfig()

    const first = await runInfoPlistMod(config)
    const second = await runInfoPlistMod(config, first)

    expect(second).toEqual(first)
    expect(
      manifestOf(second).UISceneConfigurations?.[CARPLAY_ROLE]
    ).toHaveLength(1)
  })

  it('leaves a window-scene delegate the app already declared alone', async () => {
    // Replacing it would replace the app's own startup path; the shim this
    // package ships exists only for apps that have none.
    const mine = {
      UISceneClassName: 'UIWindowScene',
      UISceneConfigurationName: 'Default Configuration',
      UISceneDelegateClassName: 'MyAppSceneDelegate',
      UISceneStoryboardFile: 'Main',
    }

    const manifest = manifestOf(
      await runInfoPlistMod(carPlayConfig(), {
        UIApplicationSceneManifest: {
          UISceneConfigurations: { [WINDOW_ROLE]: [mine] },
        } as never,
      })
    )

    expect(manifest.UISceneConfigurations?.[WINDOW_ROLE]).toEqual([mine])
    // …and the CarPlay role is still added next to it.
    expect(manifest.UISceneConfigurations?.[CARPLAY_ROLE]).toHaveLength(1)
  })

  it('leaves a CarPlay delegate the app already declared alone', async () => {
    const mine = {
      UISceneClassName: 'CPTemplateApplicationScene',
      UISceneConfigurationName: 'Mine',
      UISceneDelegateClassName: 'MyCarPlaySceneDelegate',
    }

    const manifest = manifestOf(
      await runInfoPlistMod(carPlayConfig(), {
        UIApplicationSceneManifest: {
          UISceneConfigurations: { [CARPLAY_ROLE]: [mine] },
        } as never,
      })
    )

    expect(manifest.UISceneConfigurations?.[CARPLAY_ROLE]).toEqual([mine])
    expect(manifest.UISceneConfigurations?.[WINDOW_ROLE]).toHaveLength(1)
  })

  it('preserves unrelated roles and vendor keys in the manifest', async () => {
    const manifest = manifestOf(
      await runInfoPlistMod(carPlayConfig(), {
        UIApplicationSceneManifest: {
          UIApplicationPreferredDefaultSceneSessionRole: WINDOW_ROLE,
          UISceneConfigurations: {
            UISceneSessionRoleExternalDisplayNonInteractive: [
              { UISceneConfigurationName: 'External' },
            ],
          },
        } as never,
      })
    )

    expect(
      (manifest as Record<string, unknown>)
        .UIApplicationPreferredDefaultSceneSessionRole
    ).toBe(WINDOW_ROLE)
    expect(
      manifest.UISceneConfigurations?.[
        'UISceneSessionRoleExternalDisplayNonInteractive'
      ]
    ).toEqual([{ UISceneConfigurationName: 'External' }])
  })

  it('forces multiple-scene support back on', () => {
    // An app that says `false` and also asks for CarPlay asked for two
    // contradictory things — iOS will not create the CarPlay scene otherwise.
    const plist: InfoPlist = {
      UIApplicationSceneManifest: {
        UIApplicationSupportsMultipleScenes: false,
      } as never,
    }

    expect(
      manifestOf(applyCarPlaySceneManifest(plist))
        .UIApplicationSupportsMultipleScenes
    ).toBe(true)
  })

  it('leaves every other plist key untouched', async () => {
    const plist = await runInfoPlistMod(carPlayConfig(), {
      CFBundleName: 'test-app',
      UIStatusBarHidden: true,
    })

    expect(plist.CFBundleName).toBe('test-app')
    expect(plist.UIStatusBarHidden).toBe(true)
  })

  it('refuses a malformed scene manifest rather than rewriting it', () => {
    expect(() =>
      applyCarPlaySceneManifest({
        UIApplicationSceneManifest: 'yes' as never,
      })
    ).toThrow(/UIApplicationSceneManifest/)

    expect(() =>
      applyCarPlaySceneManifest({
        UIApplicationSceneManifest: { UISceneConfigurations: [] } as never,
      })
    ).toThrow(/UISceneConfigurations/)

    expect(() =>
      applyCarPlaySceneManifest({
        UIApplicationSceneManifest: {
          UISceneConfigurations: { [CARPLAY_ROLE]: {} },
        } as never,
      })
    ).toThrow(new RegExp(CARPLAY_ROLE))
  })
})

describe('withCarPlay (ios.entitlements)', () => {
  it('adds the managed CarPlay audio capability', async () => {
    expect(await runEntitlementsMod(carPlayConfig())).toEqual({
      [CARPLAY_ENTITLEMENT]: true,
    })
  })

  it('keeps entitlements the app already has', async () => {
    const entitlements = await runEntitlementsMod(carPlayConfig(), {
      'aps-environment': 'development',
    })

    expect(entitlements['aps-environment']).toBe('development')
    expect(entitlements[CARPLAY_ENTITLEMENT]).toBe(true)
  })

  it('is idempotent across repeated prebuilds', async () => {
    const config = carPlayConfig()

    const first = await runEntitlementsMod(config)
    const second = await runEntitlementsMod(config, first)

    expect(second).toEqual(first)
  })
})
