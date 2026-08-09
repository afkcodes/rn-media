/**
 * Stand-in for `react-native-nitro-modules` inside vitest (see
 * `vitest.config.mts`). The real package pulls in a React Native runtime, which
 * a plain Node process does not have.
 *
 * Nothing in the test suite is allowed to reach the real native module: every
 * test injects a fake. Calling through here is therefore a bug, and says so.
 */
export const NitroModules = {
  createHybridObject(name: string): never {
    throw new Error(
      `[test] NitroModules.createHybridObject("${name}") was called. ` +
        'Tests must inject a fake native module instead of touching the real one.'
    )
  },
}
