package com.rnmediacast

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.uimanager.ViewManager
import com.margelo.nitro.rnmediacast.RnMediaCastOnLoad
import com.margelo.nitro.rnmediacast.views.HybridRnMediaCastButtonManager

/**
 * Exposes no TurboModules — it exists so React Native's Android autolinking
 * has a `ReactPackage` to instantiate, whose class initializer loads
 * `libRnMediaCast.so`. Loading the library runs `JNI_OnLoad`, which registers
 * the `RnMediaCast` Hybrid Object with Nitro's registry; without it
 * `NitroModules.createHybridObject('RnMediaCast')` would throw at runtime.
 *
 * It also carries the one thing autolinking cannot infer: the `ViewManager`
 * for the `<CastButton/>` Nitro HybridView. Nitro generates the manager but
 * React Native only sees view managers a `ReactPackage` hands it, so without
 * this list the JS component would render nothing and log an unknown-component
 * error.
 */
class RnMediaCastPackage : BaseReactPackage() {
  override fun getModule(
    name: String,
    reactContext: ReactApplicationContext
  ): NativeModule? = null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
    ReactModuleInfoProvider { emptyMap() }

  // The `in Nothing` projections are React Native's own signature
  // (ReactPackage.kt) — an override has to spell them exactly.
  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): List<ViewManager<in Nothing, in Nothing>> =
    listOf(HybridRnMediaCastButtonManager())

  companion object {
    init {
      RnMediaCastOnLoad.initializeNative()
    }
  }
}
