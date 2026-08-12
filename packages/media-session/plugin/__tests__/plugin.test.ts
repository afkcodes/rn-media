import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type {
  AndroidConfig,
  ConfigPlugin,
  ExportedConfig,
  ExportedConfigWithProps,
  InfoPlist,
  ModPlatform,
} from 'expo/config-plugins'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import withRnMediaMediaSessionRunOnce, {
  resolveDrawableTarget,
  withRnMediaMediaSession,
} from '../src/index'

const PLUGIN_NAME = '@rn-media/media-session'

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
 * Builds the argument prebuild hands a mod. Only the fields mods are allowed to
 * read are filled in; anything else would be inventing a contract.
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

const RECEIVER_NAME = 'androidx.media3.session.MediaButtonReceiver'
const MEDIA_BUTTON_ACTION = 'android.intent.action.MEDIA_BUTTON'

/** What `expo prebuild` hands the manifest mod for a fresh template app. */
function baseManifest(receivers?: ManifestReceiver[]): AndroidManifest {
  return {
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      queries: [],
      application: [
        {
          $: { 'android:name': '.MainApplication' },
          activity: [{ $: { 'android:name': '.MainActivity' } }],
          ...(receivers === undefined ? {} : { receiver: receivers }),
        },
      ],
    },
  }
}

function receiversOf(manifest: AndroidManifest): ManifestReceiver[] {
  return manifest.manifest.application?.[0]?.receiver ?? []
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

describe('withBackgroundAudio (ios.infoPlist)', () => {
  it('adds the audio background mode to a plist that has none', async () => {
    const plist = await runInfoPlistMod(withRnMediaMediaSession(baseConfig()))

    expect(plist.UIBackgroundModes).toEqual(['audio'])
  })

  it('appends to — never replaces — modes the app already declares', async () => {
    const plist = await runInfoPlistMod(withRnMediaMediaSession(baseConfig()), {
      UIBackgroundModes: ['voip'],
    })

    expect(plist.UIBackgroundModes).toEqual(['voip', 'audio'])
  })

  it('does not duplicate an audio entry that is already there', async () => {
    const plist = await runInfoPlistMod(withRnMediaMediaSession(baseConfig()), {
      UIBackgroundModes: ['audio', 'fetch'],
    })

    expect(plist.UIBackgroundModes).toEqual(['audio', 'fetch'])
  })

  it('is idempotent across repeated prebuilds', async () => {
    const config = withRnMediaMediaSession(baseConfig())

    const first = await runInfoPlistMod(config)
    const second = await runInfoPlistMod(config, first)

    expect(second.UIBackgroundModes).toEqual(['audio'])
  })

  it('leaves every other plist key untouched', async () => {
    const plist = await runInfoPlistMod(withRnMediaMediaSession(baseConfig()), {
      CFBundleName: 'test-app',
      UIStatusBarHidden: true,
    })

    expect(plist.CFBundleName).toBe('test-app')
    expect(plist.UIStatusBarHidden).toBe(true)
  })

  it('refuses a malformed UIBackgroundModes rather than silently rewriting it', async () => {
    const config = withRnMediaMediaSession(baseConfig())

    await expect(
      // A string is what an app config typo produces; the plist type says
      // string[], so the cast is what a real user's JSON would look like.
      runInfoPlistMod(config, {
        UIBackgroundModes: 'audio' as unknown as string[],
      })
    ).rejects.toThrow(/UIBackgroundModes/)
  })
})

describe('run-once wrapper', () => {
  it('records the package in the plugin history', () => {
    const config = withRnMediaMediaSessionRunOnce(baseConfig())

    expect(config._internal?.pluginHistory?.[PLUGIN_NAME]).toMatchObject({
      name: PLUGIN_NAME,
    })
  })

  it('applies the mods once when the plugin is listed twice', async () => {
    const once = withRnMediaMediaSessionRunOnce(baseConfig())
    const twice = withRnMediaMediaSessionRunOnce(once)

    expect(withMods(twice).mods?.ios?.infoPlist).toBe(
      withMods(once).mods?.ios?.infoPlist
    )
    expect(await runInfoPlistMod(twice)).toEqual({
      UIBackgroundModes: ['audio'],
    })
  })
})

describe('resolveDrawableTarget', () => {
  it('routes a vector drawable to the density-independent folder', () => {
    expect(resolveDrawableTarget('./assets/ic_notification.xml')).toEqual({
      directory: 'drawable',
      fileName: 'ic_notification.xml',
      resourceName: 'ic_notification',
    })
  })

  it.each(['.png', '.webp'])(
    'routes a %s raster to drawable-xxxhdpi',
    (extension) => {
      expect(
        resolveDrawableTarget(`assets/ic_notification${extension}`)
      ).toEqual({
        directory: 'drawable-xxxhdpi',
        fileName: `ic_notification${extension}`,
        resourceName: 'ic_notification',
      })
    }
  )

  it('rejects an extension aapt2 would not compile', () => {
    expect(() => resolveDrawableTarget('assets/icon.svg')).toThrow(/must be a/)
  })

  it('rejects a file name Android cannot turn into a resource name', () => {
    expect(() => resolveDrawableTarget('assets/Ic-Notification.png')).toThrow(
      /not a valid Android resource name/
    )
  })
})

describe('withAndroidNotificationIcon (dangerous mod)', () => {
  let projectRoot: string
  let platformProjectRoot: string

  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(tmpdir(), 'rn-media-plugin-'))
    platformProjectRoot = path.join(projectRoot, 'android')
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  async function runAndroidMod(config: ExpoConfig): Promise<void> {
    const mod = withMods(config).mods?.android?.dangerous
    if (!mod)
      throw new Error('expected an android.dangerous mod to be registered')

    await mod(
      modConfig<unknown>(config, 'android', 'dangerous', undefined, {
        projectRoot,
        platformProjectRoot,
      })
    )
  }

  it('registers no android mod when no icon is configured', () => {
    expect(
      withMods(withRnMediaMediaSession(baseConfig())).mods?.android
    ).toBeUndefined()
  })

  it('copies a vector drawable into res/drawable', async () => {
    await writeFile(path.join(projectRoot, 'ic_notification.xml'), '<vector/>')

    await runAndroidMod(
      withRnMediaMediaSession(baseConfig(), {
        androidNotificationIcon: './ic_notification.xml',
      })
    )

    const written = await readFile(
      path.join(
        platformProjectRoot,
        'app/src/main/res/drawable/ic_notification.xml'
      ),
      'utf8'
    )
    expect(written).toBe('<vector/>')
  })

  it('copies a raster into res/drawable-xxxhdpi', async () => {
    await writeFile(
      path.join(projectRoot, 'ic_notification.png'),
      'not-really-a-png'
    )

    await runAndroidMod(
      withRnMediaMediaSession(baseConfig(), {
        androidNotificationIcon: 'ic_notification.png',
      })
    )

    const written = await readFile(
      path.join(
        platformProjectRoot,
        'app/src/main/res/drawable-xxxhdpi/ic_notification.png'
      ),
      'utf8'
    )
    expect(written).toBe('not-really-a-png')
  })

  it('fails the prebuild when the icon path does not exist', async () => {
    await expect(
      runAndroidMod(
        withRnMediaMediaSession(baseConfig(), {
          androidNotificationIcon: './missing.xml',
        })
      )
    ).rejects.toThrow(/does not exist/)
  })

  it('still applies the iOS background mode when an icon is configured', async () => {
    const config = withRnMediaMediaSession(baseConfig(), {
      androidNotificationIcon: './ic_notification.xml',
    })

    expect(await runInfoPlistMod(config)).toEqual({
      UIBackgroundModes: ['audio'],
    })
  })
})

describe('withMediaButtonReceiver (android.manifest)', () => {
  it('registers no manifest mod unless playbackResumption is on', () => {
    // Off by default, and off when explicitly false. The receiver changes
    // media-button routing for the whole app; it may only appear because
    // someone asked for it.
    expect(
      withMods(withRnMediaMediaSession(baseConfig())).mods?.android?.manifest
    ).toBeUndefined()
    expect(
      withMods(
        withRnMediaMediaSession(baseConfig(), { playbackResumption: false })
      ).mods?.android?.manifest
    ).toBeUndefined()
    // …and an unrelated option does not drag it in either.
    expect(
      withMods(
        withRnMediaMediaSession(baseConfig(), {
          androidNotificationIcon: './ic_notification.xml',
        })
      ).mods?.android?.manifest
    ).toBeUndefined()
  })

  it('adds the receiver media3 looks for', async () => {
    const manifest = await runManifestMod(
      withRnMediaMediaSession(baseConfig(), { playbackResumption: true })
    )

    // The exact shape the package README documents for bare projects — the
    // plugin is that copy-paste, not a variation on it.
    expect(receiversOf(manifest)).toEqual([
      {
        '$': { 'android:name': RECEIVER_NAME, 'android:exported': 'true' },
        'intent-filter': [
          { action: [{ $: { 'android:name': MEDIA_BUTTON_ACTION } }] },
        ],
      },
    ])
  })

  it('is idempotent across repeated prebuilds', async () => {
    const config = withRnMediaMediaSession(baseConfig(), {
      playbackResumption: true,
    })

    const first = await runManifestMod(config)
    const second = await runManifestMod(config, first)

    expect(receiversOf(second)).toHaveLength(1)
    expect(second).toEqual(first)
  })

  it('leaves a receiver the app already declared exactly as it is', async () => {
    const handWritten: ManifestReceiver = {
      '$': {
        'android:name': RECEIVER_NAME,
        'android:exported': 'true',
        'android:enabled': 'true',
      },
      'intent-filter': [
        { action: [{ $: { 'android:name': MEDIA_BUTTON_ACTION } }] },
      ],
    }

    const manifest = await runManifestMod(
      withRnMediaMediaSession(baseConfig(), { playbackResumption: true }),
      baseManifest([handWritten])
    )

    expect(receiversOf(manifest)).toEqual([handWritten])
  })

  it('repairs a declaration the package manager could not resolve', async () => {
    // A receiver with no MEDIA_BUTTON filter is invisible to
    // `queryBroadcastReceivers`, so media3 reads the app as unable to resume —
    // the receiver looks present and the feature is silently inert.
    const manifest = await runManifestMod(
      withRnMediaMediaSession(baseConfig(), { playbackResumption: true }),
      baseManifest([
        {
          '$': { 'android:name': RECEIVER_NAME, 'android:exported': 'true' },
          'intent-filter': [
            {
              action: [{ $: { 'android:name': 'com.example.SOMETHING_ELSE' } }],
            },
          ],
        },
      ])
    )

    const [receiver] = receiversOf(manifest)
    expect(receiver?.$).toEqual({
      'android:name': RECEIVER_NAME,
      'android:exported': 'true',
    })
    expect(receiver?.['intent-filter']).toEqual([
      { action: [{ $: { 'android:name': 'com.example.SOMETHING_ELSE' } }] },
      { action: [{ $: { 'android:name': MEDIA_BUTTON_ACTION } }] },
    ])
  })

  it('keeps every other receiver the app declares', async () => {
    const unrelated: ManifestReceiver = {
      $: { 'android:name': '.BootReceiver', 'android:exported': 'false' },
    }

    const manifest = await runManifestMod(
      withRnMediaMediaSession(baseConfig(), { playbackResumption: true }),
      baseManifest([unrelated])
    )

    expect(receiversOf(manifest)).toHaveLength(2)
    expect(receiversOf(manifest)[0]).toEqual(unrelated)
  })

  it('still applies the iOS background mode and the icon mod alongside it', async () => {
    const config = withRnMediaMediaSession(baseConfig(), {
      playbackResumption: true,
      androidNotificationIcon: './ic_notification.xml',
    })

    expect(await runInfoPlistMod(config)).toEqual({
      UIBackgroundModes: ['audio'],
    })
    expect(withMods(config).mods?.android?.dangerous).toBeDefined()
    expect(receiversOf(await runManifestMod(config))).toHaveLength(1)
  })

  it('applies the manifest mod once when the plugin is listed twice', async () => {
    const once = withRnMediaMediaSessionRunOnce(baseConfig(), {
      playbackResumption: true,
    })
    const twice = withRnMediaMediaSessionRunOnce(once, {
      playbackResumption: true,
    })

    expect(withMods(twice).mods?.android?.manifest).toBe(
      withMods(once).mods?.android?.manifest
    )
    expect(receiversOf(await runManifestMod(twice))).toHaveLength(1)
  })
})
