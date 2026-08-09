import { defineConfig } from 'vitest/config'

/**
 * Vitest configuration for the device-free TypeScript test suite.
 *
 * The tests never construct a real native client: the `Player` takes its
 * `MpvClient` factory by injection, so the suite runs against
 * `src/__tests__/fake-mpv-client.ts` in plain Node. `src/player.ts` does import
 * `src/native-client.ts` statically, though, so the *module graph* reaches
 * `react-native-nitro-modules` (which needs a React Native runtime) — hence the
 * stub alias below, the same one `@rn-media/audio-session` and
 * `@rn-media/media-session` use. The only DOM need is
 * `@testing-library/react`'s renderer, hence the `jsdom` environment.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    globals: false,
    restoreMocks: true,
    alias: {
      'react-native-nitro-modules': new URL(
        './src/__tests__/nitro-stub.ts',
        import.meta.url
      ).pathname,
    },
  },
})
