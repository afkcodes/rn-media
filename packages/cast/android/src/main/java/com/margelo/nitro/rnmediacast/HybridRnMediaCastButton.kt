// Same hard rule as `HybridRnMediaCast.kt`: nitrogen hardcodes the
// implementation class into the generated ViewManager as
// `com.margelo.nitro.<androidNamespace>.<implementationClassName>` (see
// nitrogen/generated/android/kotlin/.../views/HybridRnMediaCastButtonManager.kt),
// so this file cannot move to `com.rnmediacast`.
package com.margelo.nitro.rnmediacast

import android.content.Context
import android.graphics.Canvas
import android.graphics.PorterDuff
import android.view.View
import androidx.mediarouter.app.MediaRouteButton
import com.facebook.react.uimanager.ThemedReactContext
import com.google.android.gms.cast.framework.CastButtonFactory

/**
 * The Android half of `<CastButton/>`: the framework's own cast affordance,
 * wrapped as a Nitro HybridView.
 *
 * Why `MediaRouteButton` + `CastButtonFactory` and not our own `Pressable`
 * calling `showCastPicker()` — the whole reason this component exists:
 * `CastButtonFactory.setUpMediaRouteButton(Context, MediaRouteButton)` is the
 * only wiring that reaches the **system output switcher**. Verified in the
 * shipped artifacts (play-services-cast-framework 22.3.1,
 * mediarouter 1.8.0-beta01):
 *
 * - `CastButtonFactory.setUpMediaRouteButton` sets the button's selector from
 *   `CastContext.getMergedSelector()` and registers it so a later
 *   `CastContext` init re-applies it. It tolerates a GMS-less device: the
 *   internal `CastContext` getter catches the load failure and returns null
 *   ("Failed to load module from Google Play services … Ignoring this failure
 *   silently"), so construction never throws.
 * - `MediaRouteButton.showDialog()` then branches on
 *   `MediaRouterParams.isOutputSwitcherEnabled() && MediaRouter.isMediaTransferEnabled()`
 *   → `SystemOutputSwitcherDialogController.showDialog(context)` (the SYSTEM
 *   sheet, Android 13+ with `MediaTransferReceiver` in the manifest), else the
 *   in-app `MediaRouteChooserDialogFragment`. The first branch is switched on
 *   by `CastOptions.setShowSystemOutputSwitcherOnCastIconClick(true)`, which
 *   `RnMediaCastOptionsProvider` already sets.
 *
 * Threading contract
 * ------------------
 * UI THREAD ONLY, and that is guaranteed rather than defended: React Native
 * creates views from `SurfaceMountingManager.createView`, which is
 * `@UiThread`, and pushes props from the ViewManager's `updateState` on the
 * same thread. Both `MediaRouter.getInstance` (in the `MediaRouteButton`
 * constructor) and `CastButtonFactory.setUpMediaRouteButton`
 * (`Preconditions.checkMainThread("Must be called from the main thread.")`)
 * assert it themselves, so a violation would be loud, never silent.
 *
 * Deliberately NOT a `RecyclableView`: a recycled button would keep the
 * `MediaRouteButton` bound to the Activity of its first surface, and that
 * Activity is what the pre-Android-13 chooser dialog is shown from
 * (`MediaRouteButton.getActivity()` unwraps the view's context). A fresh
 * button per mount costs one view allocation and cannot show a dialog on a
 * dead Activity.
 */
class HybridRnMediaCastButton(context: ThemedReactContext) :
  HybridRnMediaCastButtonSpec() {

  private val button = TintedMediaRouteButton(context)

  override val view: View = button

  override var tintColor: Double? = null
    set(value) {
      field = value
      // `processColor` packs ARGB into a (signed, on Android) 32-bit int and
      // Nitro carries it as a double; `toInt()` is the exact inverse for
      // every value it can produce.
      button.iconTint = value?.toInt()
    }

  init {
    CastButtonFactory.setUpMediaRouteButton(context, button)
  }
}

/**
 * A [MediaRouteButton] whose icon can be recoloured per instance.
 *
 * `MediaRouteButton` takes its icon tint from the *theme* attribute
 * `mediaRouteButtonTint`, read once in its constructor; there is no public
 * per-instance setter, and `setRemoteIndicatorDrawable` would mean shipping
 * our own copy of Google's cast icon (and losing the connecting animation and
 * the connected state that come with theirs — the Cast Design Checklist wants
 * the standard icon).
 *
 * So the icon is recoloured where it is drawn: `super.onDraw` renders into an
 * offscreen layer, then `SRC_IN` paints the tint through exactly the pixels it
 * covered. Whatever state the framework draws — idle, connecting animation,
 * connected — keeps its shape and gets the app's colour. The layer is only
 * allocated when a tint is actually set, and a cast button repaints on route
 * changes, not per frame.
 */
private class TintedMediaRouteButton(context: Context) : MediaRouteButton(context) {
  /** Packed ARGB, or null for "leave the framework's own tint alone". */
  var iconTint: Int? = null
    set(value) {
      if (field == value) return
      field = value
      invalidate()
    }

  override fun onDraw(canvas: Canvas) {
    val tint = iconTint
    if (tint == null) {
      super.onDraw(canvas)
      return
    }
    val layer = canvas.saveLayer(null, null)
    super.onDraw(canvas)
    canvas.drawColor(tint, PorterDuff.Mode.SRC_IN)
    canvas.restoreToCount(layer)
  }
}
