import type {
  AndroidConfig,
  ConfigPlugin,
  ExportedConfig,
  ExportedConfigWithProps,
  InfoPlist,
  ModPlatform,
} from 'expo/config-plugins'
import { afterEach, describe, expect, it, vi } from 'vitest'

import withRnMediaCastRunOnce, { withRnMediaCast } from '../src/index'

const PLUGIN_NAME = '@timbre/cast'

const OPTIONS_PROVIDER_KEY =
  'com.google.android.gms.cast.framework.OPTIONS_PROVIDER_CLASS_NAME'
const OPTIONS_PROVIDER_CLASS = 'com.rnmediacast.RnMediaCastOptionsProvider'
const RECEIVER_APP_ID_KEY = 'com.rnmediacast.RECEIVER_APPLICATION_ID'
const MEDIA_TRANSFER_RECEIVER =
  'androidx.mediarouter.media.MediaTransferReceiver'

/** `@expo/config-plugins` does not re-export it; take it off the plugin type. */
type ExpoConfig = Parameters<ConfigPlugin>[0]

function baseConfig(): ExpoConfig {
  return { name: 'test-app', slug: 'test-app' }
}

/**
 * `ConfigPlugin` is typed as `ExpoConfig -> ExpoConfig` upstream even though
 * every plugin in practice returns the `mods`-carrying variant, so reading the
 * mods a plugin registered needs this one widening.
 */
function withMods(config: ExpoConfig): ExportedConfig {
  return config as ExportedConfig
}

/**
 * Builds the argument prebuild hands a mod. Only the fields mods are allowed
 * to read are filled in; anything else would be inventing a contract.
 */
function modConfig<T>(
  config: ExpoConfig,
  platform: ModPlatform,
  modName: string,
  modResults: T,
  roots: { projectRoot: string; platformProjectRoot: string }
): ExportedConfigWithProps<T> {
  return {
    ...config,
    modResults,
    modRawConfig: config,
    modRequest: {
      projectRoot: roots.projectRoot,
      platformProjectRoot: roots.platformProjectRoot,
      modName,
      platform,
      introspect: false,
    },
  }
}

type AndroidManifest = AndroidConfig.Manifest.AndroidManifest
type ManifestApplication = AndroidConfig.Manifest.ManifestApplication
type ManifestReceiver = NonNullable<ManifestApplication['receiver']>[number]
type ManifestMetaData = NonNullable<ManifestApplication['meta-data']>[number]

/** What `expo prebuild` hands the manifest mod for a fresh template app. */
function baseManifest(overrides?: {
  receivers?: ManifestReceiver[]
  metaData?: ManifestMetaData[]
}): AndroidManifest {
  return {
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      queries: [],
      application: [
        {
          $: { 'android:name': '.MainApplication' },
          activity: [{ $: { 'android:name': '.MainActivity' } }],
          ...(overrides?.receivers === undefined
            ? {}
            : { receiver: overrides.receivers }),
          ...(overrides?.metaData === undefined
            ? {}
            : { 'meta-data': overrides.metaData }),
        },
      ],
    },
  }
}

function applicationOf(manifest: AndroidManifest): ManifestApplication {
  const application = manifest.manifest.application?.[0]
  if (application === undefined) throw new Error('manifest has no application')
  return application
}

function metaDataOf(manifest: AndroidManifest): ManifestMetaData[] {
  return applicationOf(manifest)['meta-data'] ?? []
}

function metaDataValue(
  manifest: AndroidManifest,
  name: string
): string | undefined {
  return metaDataOf(manifest).find((m) => m.$['android:name'] === name)?.$[
    'android:value'
  ]
}

async function runManifestMod(
  config: ExpoConfig,
  initial: AndroidManifest = baseManifest()
): Promise<AndroidManifest> {
  const mod = withMods(config).mods?.android?.manifest
  if (!mod) throw new Error('expected an android.manifest mod to be registered')

  const result = await mod(
    modConfig(config, 'android', 'manifest', initial, {
      projectRoot: '/app',
      platformProjectRoot: '/app/android',
    })
  )
  return result.modResults
}

async function runInfoPlistMod(
  config: ExpoConfig,
  initial: InfoPlist = {}
): Promise<InfoPlist> {
  const mod = withMods(config).mods?.ios?.infoPlist
  if (!mod) throw new Error('expected an ios.infoPlist mod to be registered')

  const result = await mod(
    modConfig(config, 'ios', 'infoPlist', initial, {
      projectRoot: '/app',
      platformProjectRoot: '/app/ios',
    })
  )
  return result.modResults
}

async function runPodfilePropertiesMod(
  config: ExpoConfig,
  initial: Record<string, string> = {}
): Promise<Record<string, string>> {
  const mod = withMods(config).mods?.ios?.podfileProperties
  if (!mod) {
    throw new Error('expected an ios.podfileProperties mod to be registered')
  }

  const result = await mod(
    modConfig(config, 'ios', 'podfileProperties', initial, {
      projectRoot: '/app',
      platformProjectRoot: '/app/ios',
    })
  )
  return result.modResults
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('withCastAndroid (android.manifest)', () => {
  it('adds the options provider, transfer receiver, and (with the prop) the receiver app id', async () => {
    const manifest = await runManifestMod(
      withRnMediaCast(baseConfig(), { receiverAppId: 'ABCD1234' })
    )

    expect(metaDataValue(manifest, OPTIONS_PROVIDER_KEY)).toBe(
      OPTIONS_PROVIDER_CLASS
    )
    expect(metaDataValue(manifest, RECEIVER_APP_ID_KEY)).toBe('ABCD1234')
    const receiver = applicationOf(manifest).receiver?.find(
      (r) => r.$['android:name'] === MEDIA_TRANSFER_RECEIVER
    )
    expect(receiver?.$['android:exported']).toBe('true')
  })

  it('without the prop no receiver-app-id meta-data is written (Default Media Receiver)', async () => {
    const manifest = await runManifestMod(withRnMediaCast(baseConfig()))

    expect(metaDataValue(manifest, OPTIONS_PROVIDER_KEY)).toBe(
      OPTIONS_PROVIDER_CLASS
    )
    expect(metaDataValue(manifest, RECEIVER_APP_ID_KEY)).toBeUndefined()
  })

  it("an app's own OPTIONS_PROVIDER declaration is left completely alone", async () => {
    const manifest = await runManifestMod(
      withRnMediaCast(baseConfig()),
      baseManifest({
        metaData: [
          {
            $: {
              'android:name': OPTIONS_PROVIDER_KEY,
              'android:value': 'com.example.MyOwnProvider',
            },
          },
        ],
      })
    )

    expect(metaDataValue(manifest, OPTIONS_PROVIDER_KEY)).toBe(
      'com.example.MyOwnProvider'
    )
  })

  it('a changed receiverAppId prop converges on the prop across prebuilds', async () => {
    const first = await runManifestMod(
      withRnMediaCast(baseConfig(), { receiverAppId: 'AAAA0000' })
    )
    const second = await runManifestMod(
      withRnMediaCast(baseConfig(), { receiverAppId: 'BBBB1111' }),
      first
    )

    expect(metaDataValue(second, RECEIVER_APP_ID_KEY)).toBe('BBBB1111')
  })

  it('is idempotent across repeated prebuilds', async () => {
    const config = withRnMediaCast(baseConfig(), { receiverAppId: 'ABCD1234' })

    const first = await runManifestMod(config)
    const second = await runManifestMod(config, first)

    expect(metaDataOf(second)).toEqual(metaDataOf(first))
    expect(
      applicationOf(second).receiver?.filter(
        (r) => r.$['android:name'] === MEDIA_TRANSFER_RECEIVER
      )
    ).toHaveLength(1)
  })

  it('appends to receivers the app already declares rather than replacing them', async () => {
    const existing: ManifestReceiver = {
      $: {
        'android:name': 'com.example.MyReceiver',
        'android:exported': 'false',
      },
    }
    const manifest = await runManifestMod(
      withRnMediaCast(baseConfig()),
      baseManifest({ receivers: [existing] })
    )

    const names = applicationOf(manifest).receiver?.map(
      (r) => r.$['android:name']
    )
    expect(names).toEqual(['com.example.MyReceiver', MEDIA_TRANSFER_RECEIVER])
  })
})

describe('withCastIosPlist (ios.infoPlist)', () => {
  it('generates both Bonjour strings — default receiver id when no prop', async () => {
    const plist = await runInfoPlistMod(withRnMediaCast(baseConfig()))

    expect(plist.NSBonjourServices).toEqual([
      '_googlecast._tcp',
      '_CC1AD845._googlecast._tcp',
    ])
  })

  it('generates the app-ID-specific Bonjour string from the prop', async () => {
    const plist = await runInfoPlistMod(
      withRnMediaCast(baseConfig(), { receiverAppId: 'ABCD1234' })
    )

    expect(plist.NSBonjourServices).toContain('_ABCD1234._googlecast._tcp')
  })

  it('merges with — never replaces — Bonjour services the app already declares', async () => {
    const plist = await runInfoPlistMod(withRnMediaCast(baseConfig()), {
      NSBonjourServices: ['_spotify-connect._tcp'],
    })

    expect(plist.NSBonjourServices).toEqual([
      '_spotify-connect._tcp',
      '_googlecast._tcp',
      '_CC1AD845._googlecast._tcp',
    ])
  })

  it('is idempotent across repeated prebuilds', async () => {
    const config = withRnMediaCast(baseConfig())

    const first = await runInfoPlistMod(config)
    const second = await runInfoPlistMod(config, first)

    expect(second.NSBonjourServices).toEqual(first.NSBonjourServices)
  })

  it('refuses a malformed NSBonjourServices rather than silently rewriting it', async () => {
    await expect(
      runInfoPlistMod(withRnMediaCast(baseConfig()), {
        NSBonjourServices: '_googlecast._tcp' as unknown as string[],
      })
    ).rejects.toThrow(/NSBonjourServices/)
  })

  it('writes a default local-network description naming the app', async () => {
    const plist = await runInfoPlistMod(withRnMediaCast(baseConfig()))

    expect(plist.NSLocalNetworkUsageDescription).toMatch(/test-app/)
    expect(plist.NSLocalNetworkUsageDescription).toMatch(/local network/)
  })

  it('the prop overrides, and an app-supplied description is kept when there is no prop', async () => {
    const overridden = await runInfoPlistMod(
      withRnMediaCast(baseConfig(), {
        localNetworkUsageDescription: 'Custom text.',
      })
    )
    expect(overridden.NSLocalNetworkUsageDescription).toBe('Custom text.')

    const kept = await runInfoPlistMod(withRnMediaCast(baseConfig()), {
      NSLocalNetworkUsageDescription: 'App wrote this.',
    })
    expect(kept.NSLocalNetworkUsageDescription).toBe('App wrote this.')
  })
})

describe('withCastIosDeploymentTarget (ios.podfileProperties)', () => {
  it('raises an absent deployment target to 16.0, loudly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const props = await runPodfilePropertiesMod(withRnMediaCast(baseConfig()))

    expect(props['ios.deploymentTarget']).toBe('16.0')
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/iOS 16\.0/))
  })

  it('raises a lower target (the RN default 15.1)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const props = await runPodfilePropertiesMod(withRnMediaCast(baseConfig()), {
      'ios.deploymentTarget': '15.1',
    })

    expect(props['ios.deploymentTarget']).toBe('16.0')
  })

  it('never lowers an app that already targets higher', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const props = await runPodfilePropertiesMod(withRnMediaCast(baseConfig()), {
      'ios.deploymentTarget': '17.0',
    })

    expect(props['ios.deploymentTarget']).toBe('17.0')
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('run-once wrapper', () => {
  it('records the package in the plugin history', () => {
    const config = withRnMediaCastRunOnce(baseConfig())

    expect(config._internal?.pluginHistory?.[PLUGIN_NAME]).toMatchObject({
      name: PLUGIN_NAME,
    })
  })

  it('applies the mods once when the plugin is listed twice', async () => {
    const once = withRnMediaCastRunOnce(baseConfig())
    const twice = withRnMediaCastRunOnce(once)

    expect(withMods(twice).mods?.ios?.infoPlist).toBe(
      withMods(once).mods?.ios?.infoPlist
    )
  })
})
