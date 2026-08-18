package com.rnmediamediasession

import android.os.Build
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The `startForegroundService()` promise, made testable.
 *
 * A foreground *transition* needs a device; deciding **which** transition to
 * make does not, and the deciding half is the half that has already shipped
 * wrong once. The original defect (ARCHITECTURE §30) was a start whose promise
 * nobody kept; the follow-up defect was a pre-Q "are we already foreground?"
 * signal that answered `true` forever, which would have skipped the keeping on
 * Android 8–9 for exactly the same crash. Both are decisions, so both are
 * pinned here rather than left to a phone.
 *
 * The invariant, stated once: **on API 26+, the only input that may lead to
 * doing nothing is a positive answer to "this service is foreground right
 * now".** `false` and `null` (unknown) must both keep the promise, because the
 * costs are not symmetric — a redundant promote-then-demote is two binder
 * calls, a missed one is an uncatchable process kill.
 */
class ForegroundPromiseTest {

  // MARK: - The exhaustive table

  @Test
  fun `pre-O carries no promise, whatever else is true`() {
    for (sdk in listOf(21, 23, 25)) {
      for (already in listOf(true, false, null)) {
        for (wants in listOf(true, false)) {
          for (canBuild in listOf(true, false)) {
            assertEquals(
              "sdk=$sdk already=$already wants=$wants canBuild=$canBuild",
              PromiseAction.SKIP,
              ForegroundPromise.decide(sdk, already, wants, canBuild),
            )
          }
        }
      }
    }
  }

  @Test
  fun `a service the OS says is already foreground is left alone`() {
    for (sdk in API_26_PLUS) {
      for (wants in listOf(true, false)) {
        for (canBuild in listOf(true, false)) {
          assertEquals(
            "sdk=$sdk wants=$wants canBuild=$canBuild",
            PromiseAction.SKIP,
            ForegroundPromise.decide(sdk, alreadyForeground = true, wants, canBuild),
          )
        }
      }
    }
  }

  @Test
  fun `still engaged and drawable - the real media notification`() {
    for (sdk in API_26_PLUS) {
      for (already in listOf(false, null)) {
        assertEquals(
          "sdk=$sdk already=$already",
          PromiseAction.PROMOTE_WITH_SNAPSHOT,
          ForegroundPromise.decide(
            sdk,
            alreadyForeground = already,
            wantsForeground = true,
            canBuildSnapshotNotification = true,
          ),
        )
      }
    }
  }

  @Test
  fun `the race already landed - promise kept with nothing drawn`() {
    for (sdk in API_26_PLUS) {
      for (already in listOf(false, null)) {
        for (canBuild in listOf(true, false)) {
          assertEquals(
            "sdk=$sdk already=$already canBuild=$canBuild",
            PromiseAction.PROMOTE_THEN_DEMOTE,
            ForegroundPromise.decide(
              sdk,
              alreadyForeground = already,
              wantsForeground = false,
              canBuildSnapshotNotification = canBuild,
            ),
          )
        }
      }
    }
  }

  @Test
  fun `engaged but nothing to draw with still keeps the promise`() {
    // No session yet, or no AndroidMediaSessionConfig: the user sees nothing,
    // but the process survives, which is the only part that is not negotiable.
    for (sdk in API_26_PLUS) {
      for (already in listOf(false, null)) {
        assertEquals(
          "sdk=$sdk already=$already",
          PromiseAction.PROMOTE_THEN_DEMOTE,
          ForegroundPromise.decide(
            sdk,
            alreadyForeground = already,
            wantsForeground = true,
            canBuildSnapshotNotification = false,
          ),
        )
      }
    }
  }

  // MARK: - The invariant itself

  @Test
  fun `on API 26+ nothing but a positive already-foreground may skip`() {
    var checked = 0
    for (sdk in API_26_PLUS) {
      for (already in listOf(false, null)) {
        for (wants in listOf(true, false)) {
          for (canBuild in listOf(true, false)) {
            assertNotEquals(
              "decide(sdk=$sdk, alreadyForeground=$already, wantsForeground=$wants, " +
                "canBuildSnapshotNotification=$canBuild) returned SKIP. On API 26+ that is a " +
                "startForegroundService() promise nobody keeps, which is an uncatchable " +
                "ForegroundServiceDidNotStartInTimeException and a dead process. Only a " +
                "*positive* answer from the OS may skip; `false` and `null` must not.",
              PromiseAction.SKIP,
              ForegroundPromise.decide(sdk, already, wants, canBuild),
            )
            checked++
          }
        }
      }
    }
    assertEquals("the sweep must actually run", API_26_PLUS.size * 2 * 2 * 2, checked)
  }

  @Test
  fun `unknown behaves exactly like not-foreground, never like foreground`() {
    for (sdk in API_26_PLUS) {
      for (wants in listOf(true, false)) {
        for (canBuild in listOf(true, false)) {
          assertEquals(
            "sdk=$sdk wants=$wants canBuild=$canBuild",
            ForegroundPromise.decide(sdk, alreadyForeground = false, wants, canBuild),
            ForegroundPromise.decide(sdk, alreadyForeground = null, wants, canBuild),
          )
        }
      }
    }
  }

  // MARK: - Nobody may add a promise without a keeper

  /**
   * Every `startForegroundService` this package writes has to be one this file
   * knows about.
   *
   * The original bug existed because two of the three start paths had an answer
   * and the third was never checked. A fourth call site added later would
   * reintroduce it silently — nothing compiles differently, nothing fails, and
   * the symptom is a process kill on a user's phone ten seconds later. So the
   * call sites are enumerated, and adding one fails here until its keeper is
   * named.
   *
   * Same technique and same justification as [SchemaVersionSyncTest] and
   * [SessionErrorCodeSyncTest]: the guard never ships, and both halves are
   * always present in the repository.
   */
  @Test
  fun `every startForegroundService call site is one with a documented keeper`() {
    val sources = sourceDir().walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
    assertTrue("Expected Kotlin sources under ${sourceDir().path}", sources.isNotEmpty())

    val found = sources.flatMap { file ->
      file.readLines().withIndex()
        .filter { (_, line) -> CALL_PATTERN.containsMatchIn(line) }
        .map { (index, _) -> "${file.name}:${index + 1}" }
    }.map { it.substringBefore(':') }.toSortedSet()

    assertEquals(
      "The set of files that call startForegroundService() has changed. Every such call is a " +
        "promise the OS collects on within its window, with an uncatchable process kill for " +
        "breaking it (ARCHITECTURE §30). Add the new one to KNOWN_STARTERS here only once its " +
        "keeper is named in the same commit — for the warm path that is " +
        "RnMediaMediaSessionService.keepForegroundPromise().",
      KNOWN_STARTERS,
      found,
    )
  }

  private fun sourceDir(): File {
    val root = requireNotNull(System.getProperty("rnMedia.packageRoot")) {
      "The `rnMedia.packageRoot` system property is not set. It is configured in " +
        "android/build.gradle (testOptions.unitTests.all) and this test cannot run without it."
    }
    val dir = File(root, "android/src/main/java/com/rnmediamediasession")
    assertTrue("Expected the Kotlin sources at ${dir.path}", dir.isDirectory)
    return dir
  }

  private companion object {
    /** O, P (the range the latch used to answer for), Q, and current. */
    val API_26_PLUS = listOf(
      Build.VERSION_CODES.O,
      Build.VERSION_CODES.P,
      Build.VERSION_CODES.Q,
      31,
      33,
      34,
      36,
    )

    /**
     * An actual call, not a mention: KDoc and comments name the method
     * constantly and must not trip the guard, so the pattern requires the
     * open parenthesis and rejects a line whose first non-space characters are
     * a comment marker.
     */
    val CALL_PATTERN = Regex("""^(?!\s*(//|\*|/\*)).*\bstartForegroundService\s*\(""")

    /**
     * The only file in this package that may promise a `startForeground()`.
     *
     * `MediaSessionController.startService` — the reported stack — is kept by
     * `RnMediaMediaSessionService.onStartCommand` -> `keepForegroundPromise`.
     * media3's own starters (`MediaButtonReceiver`,
     * `MediaNotificationManager.startForeground`) live in the AAR, not here,
     * and land in the same `onStartCommand`.
     */
    val KNOWN_STARTERS = sortedSetOf("MediaSessionController.kt")
  }
}
