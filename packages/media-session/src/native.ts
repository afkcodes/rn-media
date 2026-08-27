import { NitroModules } from 'react-native-nitro-modules'

import type { RnMediaMediaSession } from './specs/media-session.nitro'

let instance: RnMediaMediaSession | undefined

/**
 * The native hybrid object, created on first use.
 *
 * Not at import time: `import '@afkcodes/timbre-media-session'` must stay free of
 * native side effects so the package is importable in a plain Node/vitest
 * process (and so a screen that merely *references* the service does not spin
 * up a media session).
 */
export function getNativeMediaSession(): RnMediaMediaSession {
  instance ??= NitroModules.createHybridObject<RnMediaMediaSession>(
    'RnMediaMediaSession'
  )
  return instance
}
