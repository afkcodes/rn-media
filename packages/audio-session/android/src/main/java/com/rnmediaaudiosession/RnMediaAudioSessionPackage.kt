package com.rnmediaaudiosession

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.margelo.nitro.rnmediaaudiosession.RnMediaAudioSessionOnLoad

/**
 * Exposes no TurboModules — it exists so React Native's Android autolinking has
 * a `ReactPackage` to instantiate, whose class initializer loads
 * `libRnMediaAudioSession.so`. Loading the library runs `JNI_OnLoad`, which
 * registers the `RnMediaAudioSession` Hybrid Object with Nitro's registry;
 * without it `NitroModules.createHybridObject('RnMediaAudioSession')` would
 * throw at runtime.
 */
class RnMediaAudioSessionPackage : BaseReactPackage() {
  override fun getModule(
    name: String,
    reactContext: ReactApplicationContext
  ): NativeModule? = null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
    ReactModuleInfoProvider { emptyMap() }

  companion object {
    init {
      RnMediaAudioSessionOnLoad.initializeNative()
    }
  }
}
