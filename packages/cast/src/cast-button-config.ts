/**
 * React Native view config for the `RnMediaCastButton` Nitro HybridView.
 *
 * This mirrors `nitrogen/generated/shared/json/RnMediaCastButtonConfig.json`
 * by hand rather than importing it, because that file lives OUTSIDE `src/`:
 * an `import '../nitrogen/…json'` resolves for Metro (the package's
 * `react-native` field points at `src/`) but not from the published
 * `lib/commonjs` build, where the relative path would climb out of `lib/`.
 * A copy inside `src` is the only form that works for both.
 *
 * The copy cannot drift: `__tests__/cast-button-config.test.ts` asserts it is
 * deep-equal to the generated JSON, so adding a prop to the spec fails the
 * suite until this is updated.
 */
export const castButtonViewConfig = {
  uiViewClassName: 'RnMediaCastButton',
  supportsRawText: false,
  bubblingEventTypes: {},
  directEventTypes: {},
  validAttributes: {
    tintColor: true,
    hybridRef: true,
  },
}
