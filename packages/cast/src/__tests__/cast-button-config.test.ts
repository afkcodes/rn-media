import { describe, expect, it } from 'vitest'

import generated from '../../nitrogen/generated/shared/json/RnMediaCastButtonConfig.json'
import { castButtonViewConfig } from '../cast-button-config'

describe('castButtonViewConfig', () => {
  // The runtime copy lives in `src` on purpose (the generated JSON is outside
  // it and would not resolve from the published `lib/commonjs` build). This is
  // the guard that keeps the copy honest: adding, renaming or removing a prop
  // in `specs/cast-button.nitro.ts` regenerates the JSON and fails here until
  // `cast-button-config.ts` is updated to match.
  it('is deep-equal to the nitrogen-generated view config', () => {
    expect(castButtonViewConfig).toEqual(generated)
  })

  it('names the native component the ViewManager registers', () => {
    // `HybridRnMediaCastButtonManager.getName()` on Android and the
    // `RnMediaCastButton` HybridObject registration on iOS both use this
    // string; a mismatch is an unknown-component error at mount time.
    expect(castButtonViewConfig.uiViewClassName).toBe('RnMediaCastButton')
  })

  it('declares hybridRef, which every Nitro view carries implicitly', () => {
    expect(castButtonViewConfig.validAttributes.hybridRef).toBe(true)
  })
})
