package com.rnmediamediasession

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences

/**
 * The smallest `Context` [ResumptionStore]'s read path can be handed.
 *
 * Deliberately not Robolectric: the read path touches exactly two Android
 * surfaces — `getApplicationContext()` and `getSharedPreferences()` — and a
 * fifteen-line fake keeps the whole suite a plain JVM run with no simulated
 * framework to configure, version-match or wait for.
 *
 * @param entries what the preferences file already contains.
 * @param failing when true, reading preferences throws — the "storage is
 *   broken" branch, which must degrade to "no resumption" and never propagate.
 */
internal class FakeContext(
  private val entries: Map<String, String> = emptyMap(),
  private val failing: Boolean = false,
) : ContextWrapper(null) {

  override fun getApplicationContext(): Context = this

  override fun getSharedPreferences(name: String?, mode: Int): SharedPreferences {
    if (failing) throw IllegalStateException("prefs unavailable")
    return FakePreferences(entries)
  }
}

/**
 * Read-only in-memory `SharedPreferences`. Only `getString` is implemented —
 * anything else being called would mean the code under test grew a dependency
 * this fake should be made to model deliberately, so the failure is loud.
 */
private class FakePreferences(private val entries: Map<String, String>) : SharedPreferences {

  override fun getString(key: String?, defValue: String?): String? = entries[key] ?: defValue

  override fun getAll(): MutableMap<String, *> = entries.toMutableMap()

  override fun contains(key: String?): Boolean = entries.containsKey(key)

  override fun getStringSet(key: String?, defValues: MutableSet<String>?) = unsupported()

  override fun getInt(key: String?, defValue: Int): Int = unsupported()

  override fun getLong(key: String?, defValue: Long): Long = unsupported()

  override fun getFloat(key: String?, defValue: Float): Float = unsupported()

  override fun getBoolean(key: String?, defValue: Boolean): Boolean = unsupported()

  override fun edit(): SharedPreferences.Editor = unsupported()

  override fun registerOnSharedPreferenceChangeListener(
    listener: SharedPreferences.OnSharedPreferenceChangeListener?,
  ) = unsupported()

  override fun unregisterOnSharedPreferenceChangeListener(
    listener: SharedPreferences.OnSharedPreferenceChangeListener?,
  ) = unsupported()

  private fun unsupported(): Nothing =
    throw UnsupportedOperationException("FakePreferences only models reads")
}
