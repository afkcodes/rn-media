/**
 * Stand-in for `react-native-nitro-modules` inside vitest (see
 * `vitest.config.mts`). The real package pulls in a React Native runtime, which
 * a plain Node process does not have.
 *
 * `src/player.ts` imports `src/native-client.ts` statically, so the module
 * graph reaches Nitro even though no test ever calls it. Nothing in the suite
 * is allowed to construct a real hybrid object — every test injects a fake
 * `MpvClient` — so getting here is a bug, and says so.
 */
export const NitroModules = {
  createHybridObject(name: string): never {
    throw new Error(
      `[test] NitroModules.createHybridObject("${name}") was called. ` +
        'Tests must inject a fake MpvClient (PlayerOptions.createClient) ' +
        'instead of touching the real native module.'
    )
  },
}
