import { existsSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import {
  isValidAndroidAssetName,
  withDangerousMod,
  type ConfigPlugin,
} from 'expo/config-plugins'

/** Extensions `aapt2` accepts for a drawable, mapped to the folder they belong in. */
const DRAWABLE_DIRECTORY_BY_EXTENSION: Readonly<Record<string, string>> = {
  // A vector drawable is genuinely density-independent, so the unqualified
  // folder is correct for it.
  '.xml': 'drawable',
  // A raster in unqualified `drawable/` is interpreted as *mdpi* and upscaled
  // 4x on an xxxhdpi screen. Filing it under `drawable-xxxhdpi` instead makes a
  // 96x96 px source the 24 dp the platform asks of a notification small icon,
  // and every lower density is downscaled from it.
  '.png': 'drawable-xxxhdpi',
  '.webp': 'drawable-xxxhdpi',
}

export interface DrawableTarget {
  /** Resource folder under `android/app/src/main/res`. */
  readonly directory: string
  /** File name to write, extension included. */
  readonly fileName: string
  /**
   * Name the drawable is addressable by — this is the string the app passes as
   * `android.notificationIcon` to `MediaService.init`.
   */
  readonly resourceName: string
}

/**
 * Resolves where a source icon has to land for `aapt2` to compile it, and
 * rejects anything Android would silently mis-handle. Pure so it can be tested
 * without a filesystem.
 */
export function resolveDrawableTarget(iconPath: string): DrawableTarget {
  const extension = path.extname(iconPath).toLowerCase()
  const directory = DRAWABLE_DIRECTORY_BY_EXTENSION[extension]

  if (directory === undefined) {
    throw new Error(
      `[@afkcodes/timbre-media-session] \`androidNotificationIcon\` must be a ${Object.keys(
        DRAWABLE_DIRECTORY_BY_EXTENSION
      ).join('/')} file, received "${iconPath}".`
    )
  }

  const resourceName = path.basename(iconPath, path.extname(iconPath))
  if (!isValidAndroidAssetName(resourceName)) {
    throw new Error(
      `[@afkcodes/timbre-media-session] "${resourceName}" is not a valid Android resource name. ` +
        'Rename the file to lowercase letters, digits and underscores, starting with a ' +
        'letter and avoiding Java keywords (e.g. `ic_notification.xml`).'
    )
  }

  return { directory, fileName: `${resourceName}${extension}`, resourceName }
}

/**
 * Copies an app-supplied drawable into the generated Android project so that
 * `android.notificationIcon` has something to resolve at runtime.
 *
 * A prebuild app cannot add resources by hand — `android/` is regenerated —
 * and media3 falls back to its own `media3_notification_small_icon` when the
 * name does not resolve, which would silently un-brand the notification.
 *
 * This is a dangerous mod because there is no resource-file base mod to hook.
 * That is also why it needs no `modRequest.introspect` guard: the mod compiler
 * drops dangerous mods entirely in introspection mode.
 */
export const withAndroidNotificationIcon: ConfigPlugin<string> = (
  config,
  iconPath
) =>
  withDangerousMod(config, [
    'android',
    async (dangerousConfig) => {
      const { directory, fileName } = resolveDrawableTarget(iconPath)
      const source = path.resolve(
        dangerousConfig.modRequest.projectRoot,
        iconPath
      )

      if (!existsSync(source)) {
        throw new Error(
          `[@afkcodes/timbre-media-session] \`androidNotificationIcon\` points at "${iconPath}", ` +
            `which does not exist (resolved to "${source}").`
        )
      }

      const destinationDirectory = path.join(
        dangerousConfig.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        directory
      )
      await mkdir(destinationDirectory, { recursive: true })
      await copyFile(source, path.join(destinationDirectory, fileName))

      return dangerousConfig
    },
  ])
