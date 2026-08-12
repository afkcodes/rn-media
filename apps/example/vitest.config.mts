import { defineConfig } from 'vitest/config'

/**
 * Vitest configuration for the example app's device-free logic tests.
 *
 * Only pure-TS playback modules are tested here (the first was
 * `playback/output.ts`, added with the task #43 ReplayGain regression). Those
 * modules import the workspace packages with `import type` only, so nothing in
 * the runtime module graph reaches React Native — plain Node, no jsdom, no
 * nitro stub. Anything that renders or touches a native module stays on the
 * device test bed (`App.tsx` and friends), which is what this app is for.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    restoreMocks: true,
  },
})
