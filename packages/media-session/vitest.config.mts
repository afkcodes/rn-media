import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'plugin/**/*.test.ts'],
    environment: 'node',
    // `src/native.ts` imports `react-native-nitro-modules` (which pulls in
    // react-native) purely to construct the singleton lazily. Tests never touch
    // the real native module, so stub the import rather than dragging a React
    // Native runtime into a plain Node process.
    alias: {
      'react-native-nitro-modules': new URL(
        './src/__tests__/nitro-stub.ts',
        import.meta.url
      ).pathname,
    },
  },
})
