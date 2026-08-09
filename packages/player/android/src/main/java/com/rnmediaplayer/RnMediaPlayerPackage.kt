package com.rnmediaplayer

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.margelo.nitro.rnmediaplayer.RnMediaPlayerOnLoad

/**
 * Registers no React modules on purpose: every API this package exposes is a Nitro HybridObject,
 * which registers itself from C++ via `JNI_OnLoad`.
 *
 * This class exists solely so autolinking instantiates it, which initializes the class and runs the
 * companion `init` below — the only thing in the whole module that calls
 * `System.loadLibrary("RnMediaPlayer")`. Delete it and `libRnMediaPlayer.so` is never loaded, so
 * `NitroModules.createHybridObject('RnMediaPlayer')` fails at runtime with no build-time error.
 */
class RnMediaPlayerPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? = null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    emptyMap()
  }

  companion object {
    init {
      RnMediaPlayerOnLoad.initializeNative()
    }
  }
}
