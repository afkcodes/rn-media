package com.rnmediamediasession

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The persisted schema version is written down twice — `PERSISTENCE_SCHEMA_VERSION`
 * in `src/persistence.ts` (the writer) and [ResumptionStore.SCHEMA_VERSION] here
 * (the reader) — and it has to be, because the reader runs in a process with no
 * JavaScript in it: a constant that must cross the bridge to be read is a
 * constant the resumption path cannot read at all.
 *
 * What is avoidable is the *silent* drift. Bumping the TS constant alone would
 * not break a build, would not fail a test, and would not be noticed until an
 * upgraded app stopped being resumable — a symptom that looks like a platform
 * flake and reproduces only across a version boundary.
 *
 * So this test reads the TS source and compares. No codegen, no generated
 * header, no build step: one constant, one regex, one assertion, run by the
 * same `testReleaseUnitTest` CI already runs. Reading a sibling source file is
 * legitimate here precisely because this test never ships — it exists only in
 * the repository, where both halves are always present.
 */
class SchemaVersionSyncTest {

  @Test
  fun `the Kotlin reader and the TypeScript writer agree on the schema version`() {
    val source = persistenceSource()
    val match = SCHEMA_VERSION_PATTERN.find(source.readText())

    assertTrue(
      "Could not find `export const PERSISTENCE_SCHEMA_VERSION = <n>` in ${source.path}. " +
        "If it was renamed or moved, update this guard in the same commit — it is the " +
        "only thing keeping the TS writer and the Kotlin reader in step.",
      match != null,
    )

    assertEquals(
      "PERSISTENCE_SCHEMA_VERSION in persistence.ts and ResumptionStore.SCHEMA_VERSION have " +
        "drifted. A record written by one is unreadable by the other, which silently disables " +
        "playback resumption after an app upgrade. Bump both, in the same commit.",
      requireNotNull(match).groupValues[1].toInt(),
      ResumptionStore.SCHEMA_VERSION,
    )
  }

  /**
   * `src/persistence.ts`, resolved from the package root the Gradle build hands
   * over (`rnMedia.packageRoot`). A Test task's working directory is not worth
   * resting on, and a wrong path here must fail loudly rather than vacuously
   * pass.
   */
  private fun persistenceSource(): File {
    val root = requireNotNull(System.getProperty("rnMedia.packageRoot")) {
      "The `rnMedia.packageRoot` system property is not set. It is configured in " +
        "android/build.gradle (testOptions.unitTests.all) and this test cannot run without it."
    }
    val file = File(root, "src/persistence.ts")
    assertTrue("Expected the TS source at ${file.path}", file.isFile)
    return file
  }

  private companion object {
    val SCHEMA_VERSION_PATTERN =
      Regex("""export\s+const\s+PERSISTENCE_SCHEMA_VERSION\s*=\s*(\d+)""")
  }
}
