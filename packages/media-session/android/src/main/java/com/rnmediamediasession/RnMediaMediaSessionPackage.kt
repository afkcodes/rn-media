package com.rnmediamediasession

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.margelo.nitro.rnmediamediasession.RnMediaMediaSessionOnLoad

/**
 * Exposes no TurboModules — it exists so React Native's Android autolinking has
 * a `ReactPackage` to instantiate, whose class initializer loads
 * `libRnMediaMediaSession.so`. Loading the library runs `JNI_OnLoad`, which
 * registers the `RnMediaMediaSession` Hybrid Object with Nitro's registry;
 * without it `NitroModules.createHybridObject('RnMediaMediaSession')` would
 * throw at runtime.
 */
class RnMediaMediaSessionPackage : BaseReactPackage() {
  override fun getModule(
    name: String,
    reactContext: ReactApplicationContext
  ): NativeModule? = null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
    ReactModuleInfoProvider { emptyMap() }

  companion object {
    init {
      RnMediaMediaSessionOnLoad.initializeNative()
    }
  }
}
