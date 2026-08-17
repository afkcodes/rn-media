package com.rnmediamediasession

import com.margelo.nitro.rnmediamediasession.SessionErrorCode
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Every session-error code has to be graded, and the grading lives in
 * TypeScript.
 *
 * The split is deliberate (see `SessionErrorReporter`): native says *what*
 * failed, `src/validate.ts` says how much it cost, once, for both platforms.
 * The failure mode that split creates is a code emitted by Kotlin or Swift that
 * TypeScript has never graded — which does not break a build, does not fail
 * typecheck, and shows up as a `'degraded'` label on something fatal.
 *
 * So this reads the table out of the TS source and compares it with the enum
 * nitrogen generated from the same spec. Same technique, and the same
 * justification, as [SchemaVersionSyncTest]: the test never ships, and both
 * halves are always present in the repository.
 *
 * Comparison is case-insensitive because that is the whole distance between the
 * two spellings — nitrogen upper-cases a union member and strips nothing else
 * (`backgroundPlaybackUnavailable` -> `BACKGROUNDPLAYBACKUNAVAILABLE`), which
 * is also why the spec requires the members to stay distinct
 * case-insensitively.
 */
class SessionErrorCodeSyncTest {

  @Test
  fun `every generated code is graded in validate ts, and nothing else is`() {
    val source = validateSource()
    val table = TABLE_PATTERN.find(source.readText())
    assertTrue(
      "Could not find `export const SESSION_ERROR_SEVERITY = { … }` in ${source.path}. " +
        "If it was renamed or moved, update this guard in the same commit — it is the only " +
        "thing keeping the native codes and their app-visible severities in step.",
      table != null,
    )

    val graded = KEY_PATTERN.findAll(requireNotNull(table).groupValues[1])
      .map { it.groupValues[1].uppercase() }
      .toSortedSet()
    val generated = SessionErrorCode.entries.map { it.name }.toSortedSet()

    assertEquals(
      "SESSION_ERROR_SEVERITY in validate.ts and the SessionErrorCode enum have drifted. " +
        "A code native can emit but TypeScript has not graded reaches the app labelled " +
        "'degraded' whatever it really cost. Add it to both, in the same commit.",
      generated,
      graded,
    )
  }

  /** `src/validate.ts`, resolved from the package root the Gradle build hands over. */
  private fun validateSource(): File {
    val root = requireNotNull(System.getProperty("rnMedia.packageRoot")) {
      "The `rnMedia.packageRoot` system property is not set. It is configured in " +
        "android/build.gradle (testOptions.unitTests.all) and this test cannot run without it."
    }
    val file = File(root, "src/validate.ts")
    assertTrue("Expected the TS source at ${file.path}", file.isFile)
    return file
  }

  private companion object {
    /** The object literal's body, from the opening brace to the closing one. */
    val TABLE_PATTERN =
      Regex("""SESSION_ERROR_SEVERITY\s*:[^=]*=\s*\{(.*?)\n\}""", RegexOption.DOT_MATCHES_ALL)

    /** `codeName: 'fatal',` — comments in between carry no colon-quote pair. */
    val KEY_PATTERN = Regex("""(\w+)\s*:\s*'(?:fatal|degraded)'""")
  }
}
