import { NitroModules } from 'react-native-nitro-modules'

import type {
  AudioSessionConfig,
  NativeInterruptionEvent,
  RnMediaAudioSession,
} from './specs/audio-session.nitro'
import type {
  AudioSessionApi,
  AudioSessionEventMap,
  AudioSessionEventName,
  AudioSessionInterruptionEvent,
  AudioSessionRouteChangeEvent,
  Unsubscribe,
} from './types'

/**
 * Turn the flat bridge struct into the discriminated union the public API
 * promises. Exported for tests — it is the only lossy step in the pipeline.
 */
export function narrowInterruptionEvent(
  event: NativeInterruptionEvent
): AudioSessionInterruptionEvent {
  return event.begin
    ? { begin: true, type: event.type, permanent: event.permanent }
    : { begin: false, shouldResume: event.shouldResume }
}

/**
 * Build an {@link AudioSessionApi} on top of a native hybrid object.
 *
 * Exposed (rather than only the singleton) so the whole facade can be exercised
 * against a fake `RnMediaAudioSession` without a device.
 */
export function createAudioSession(
  native: RnMediaAudioSession
): AudioSessionApi {
  function addListener<K extends AudioSessionEventName>(
    event: K,
    listener: (payload: AudioSessionEventMap[K]) => void
  ): Unsubscribe {
    switch (event) {
      case 'interruption': {
        const cb = listener as (payload: AudioSessionInterruptionEvent) => void
        const id = native.addInterruptionListener((e) => {
          cb(narrowInterruptionEvent(e))
        })
        return once(() => native.removeInterruptionListener(id))
      }
      case 'becomingNoisy': {
        const cb = listener as () => void
        const id = native.addBecomingNoisyListener(() => {
          cb()
        })
        return once(() => native.removeBecomingNoisyListener(id))
      }
      case 'routeChange': {
        const cb = listener as (payload: AudioSessionRouteChangeEvent) => void
        const id = native.addRouteChangeListener((e) => {
          cb({ reason: e.reason })
        })
        return once(() => native.removeRouteChangeListener(id))
      }
      default:
        // `event` is `never` here — this only fires if a caller from plain JS
        // passes an unknown name. Fail loudly rather than silently no-op.
        throw new Error(
          `[audio-session] Unknown event "${String(event)}". Expected one of: ` +
            'interruption, becomingNoisy, routeChange.'
        )
    }
  }

  return {
    configure(config: AudioSessionConfig): Promise<void> {
      return native.configure(config)
    },
    activate(): Promise<boolean> {
      return native.activate()
    },
    deactivate(): Promise<void> {
      return native.deactivate()
    },
    addListener,
  }
}

/** Makes an unsubscribe function safe to call more than once. */
function once(fn: () => void): Unsubscribe {
  let called = false
  return () => {
    if (called) return
    called = true
    fn()
  }
}

let instance: AudioSessionApi | undefined

/**
 * The process-wide audio session.
 *
 * The native hybrid object is created on first use, not at import time — this
 * keeps `import '@rn-media/audio-session'` free of native side effects (and
 * keeps the module importable in a plain Node/vitest process).
 *
 * A singleton is the deliberate exception to CLAUDE.md principle 5: the OS
 * audio session and audio focus are themselves singular.
 */
export const AudioSession: AudioSessionApi = {
  configure: (config) => resolveInstance().configure(config),
  activate: () => resolveInstance().activate(),
  deactivate: () => resolveInstance().deactivate(),
  addListener: (event, listener) =>
    resolveInstance().addListener(event, listener),
}

function resolveInstance(): AudioSessionApi {
  instance ??= createAudioSession(
    NitroModules.createHybridObject<RnMediaAudioSession>('RnMediaAudioSession')
  )
  return instance
}
