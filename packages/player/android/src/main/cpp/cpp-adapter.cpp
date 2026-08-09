#include <jni.h>
#include <fbjni/fbjni.h>
#include <android/log.h>
#include "RnMediaPlayerOnLoad.hpp"

/**
 * Hand the JavaVM to the ffmpeg statically linked inside libmpv.so.
 *
 * mpv's `audiotrack` AO and ffmpeg's `mediacodec` decoders both reach Java
 * through ffmpeg's `av_jni_get_java_vm()`, which returns whatever
 * `av_jni_set_java_vm()` was given. mpv-android does exactly this in
 * `app/src/main/jni/main.cpp` (`prepare_environment()`:
 * `if (!env->GetJavaVM(&g_vm) && g_vm) av_jni_set_java_vm(g_vm, NULL);`).
 *
 * We cannot call `av_jni_set_java_vm` directly: ffmpeg is *statically* linked
 * into these prebuilts and the link script only exports `mpv_*`, so the symbol
 * is absent from libmpv.so's dynamic table (verified with `llvm-nm -D`).
 * media-kit patch their mpv to re-export it under an `mpv_`-prefixed name —
 * see `buildscripts/patches/mpv/002.lavc_set_java_vm.patch` in
 * media-kit/libmpv-android-audio-build, which adds
 * `int mpv_lavc_set_java_vm(void *vm) { return av_jni_set_java_vm(vm, NULL); }`
 * and lists it in `libmpv/mpv.def`.
 *
 * That symbol is therefore a property of the *prebuilt*, not of upstream mpv,
 * so it is deliberately not patched into the vendored `mpv/client.h` and is
 * declared here instead — in the Android-only translation unit. Declaring it
 * (rather than dlsym'ing) means the linker proves it exists at build time: a
 * libmpv bump that dropped the patch would fail the build loudly instead of
 * silently degrading to software decoding + a broken audiotrack AO at runtime.
 */
extern "C" int mpv_lavc_set_java_vm(void* vm);

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  // Safe here: linking against libmpv.so makes it a DT_NEEDED dependency of
  // this library, so the dynamic linker has already loaded and relocated it by
  // the time System.loadLibrary("RnMediaPlayer") triggers this callback.
  if (mpv_lavc_set_java_vm(vm) < 0) {
    __android_log_print(ANDROID_LOG_ERROR, "RnMediaPlayer",
                        "mpv_lavc_set_java_vm failed; audiotrack/mediacodec will not work");
  }

  return facebook::jni::initialize(vm, []() {
    margelo::nitro::rnmediaplayer::registerAllNatives();
  });
}
