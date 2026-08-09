import { NitroModules } from 'react-native-nitro-modules'
import type { MpvClient } from './specs/mpv-client.nitro'

/**
 * Create a new, independent mpv core.
 *
 * Each call constructs one `mpv_handle` with its own event thread — there is
 * no singleton, so multiple players can run side by side. The returned client
 * is *not* initialized yet; call `initialize()` before using it, and
 * `destroy()` when you are done (the finalizer is only a backstop).
 *
 * Most applications should use {@link Player} instead; this is the raw layer
 * it is built on, kept public as a complete escape hatch.
 *
 * @example
 * ```ts
 * const client = createMpvClient()
 * client.initialize({})
 * try {
 *   console.log(client.getPropertyString('mpv-version'))
 * } finally {
 *   client.destroy()
 * }
 * ```
 *
 * @remarks
 * This module is the *only* one in the package that imports
 * `react-native-nitro-modules`. `Player.create()` imports it statically (a
 * dynamic import would become a Metro split bundle fetched over HTTP in dev);
 * the unit test suite, which injects its own client factory, keeps the real
 * Nitro module out of the process with a vitest alias instead.
 */
export function createMpvClient(): MpvClient {
  return NitroModules.createHybridObject<MpvClient>('MpvClient')
}
