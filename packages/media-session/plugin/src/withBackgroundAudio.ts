import { withInfoPlist, type ConfigPlugin } from 'expo/config-plugins'

/**
 * The only `UIBackgroundModes` entry this library needs: without it iOS
 * suspends the app on backgrounding and the AVAudioSession is torn down
 * mid-track, so neither playback nor the now-playing surfaces survive.
 */
const AUDIO_MODE = 'audio'

/**
 * Merges `audio` into `UIBackgroundModes`.
 *
 * The merge is deliberate rather than an assignment: prebuild runs mods over
 * whatever the app already declares (`ios.infoPlist` in app config, another
 * library's plugin, or a previously generated `Info.plist` that is being
 * re-synced), and both duplicating `audio` and dropping a sibling mode such as
 * `voip` would be a regression the app never asked for.
 */
export const withBackgroundAudio: ConfigPlugin = (config) =>
  withInfoPlist(config, (infoPlistConfig) => {
    const existing = infoPlistConfig.modResults.UIBackgroundModes

    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(
        '[@afkcodes/timbre-media-session] Expected `ios.infoPlist.UIBackgroundModes` to be an ' +
          `array of strings, received ${typeof existing}. Fix it in your app config, ` +
          'e.g. `"UIBackgroundModes": ["audio"]`.'
      )
    }

    const modes = existing ?? []
    infoPlistConfig.modResults.UIBackgroundModes = modes.includes(AUDIO_MODE)
      ? modes
      : [...modes, AUDIO_MODE]

    return infoPlistConfig
  })
