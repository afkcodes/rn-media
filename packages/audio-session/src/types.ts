import type {
  AudioInterruptionType,
  AudioRouteChangeReason,
  AudioSessionConfig,
} from './specs/audio-session.nitro'

/**
 * An interruption, as the JS layer sees it.
 *
 * This is the discriminated union from the spec doc. The bridge carries a flat
 * struct instead (`NativeInterruptionEvent`) because nitrogen cannot express a
 * string-literal discriminator; {@link narrowInterruptionEvent} is the single
 * place that converts one into the other.
 */
export type AudioSessionInterruptionEvent =
  | {
      readonly begin: true
      /** What the OS is asking us to do while the interruption lasts. */
      readonly type: AudioInterruptionType
      /**
       * `true` when focus is gone for good (Android `AUDIOFOCUS_LOSS`). A
       * `begin: false` event with `shouldResume: true` will never follow.
       */
      readonly permanent: boolean
    }
  | {
      readonly begin: false
      /** `true` when the OS recommends resuming playback. */
      readonly shouldResume: boolean
    }

/** A route change, as the JS layer sees it. */
export interface AudioSessionRouteChangeEvent {
  readonly reason: AudioRouteChangeReason
}

/**
 * Payload delivered for each event name. `becomingNoisy` carries nothing —
 * `void` keeps `() => void` assignable as a listener.
 */
export interface AudioSessionEventMap {
  interruption: AudioSessionInterruptionEvent
  becomingNoisy: void
  routeChange: AudioSessionRouteChangeEvent
}

export type AudioSessionEventName = keyof AudioSessionEventMap

/** Removes the listener it was returned from. Idempotent. */
export type Unsubscribe = () => void

/**
 * The public singleton surface.
 *
 * Declared as an interface (rather than inferred from the implementation) so
 * that tests, and anyone wiring a different backend, can substitute a fake.
 */
export interface AudioSessionApi {
  /** Apply an {@link AudioSessionConfig} (or a preset) to the OS session. */
  configure(config: AudioSessionConfig): Promise<void>
  /**
   * Request the session/focus. Resolves `false` when the OS refuses — callers
   * must not start playback in that case.
   */
  activate(): Promise<boolean>
  /** Release the session/focus. */
  deactivate(): Promise<void>
  /** Subscribe to one of the three event streams. */
  addListener<K extends AudioSessionEventName>(
    event: K,
    listener: (payload: AudioSessionEventMap[K]) => void
  ): Unsubscribe
}
