#!/usr/bin/env node
// @ts-check
/**
 * Workspace-link guard — "tests prove code works, not that it ships".
 *
 * ## The incident this exists for (2026-08-14)
 *
 * `@rn-media/cast` passed 121 unit tests, ESLint, `tsc`, Android `lintRelease`
 * and `assembleRelease`, and the APK was installed on a device — and the
 * feature was simply not there. The workspace link for the package was missing
 * from `node_modules`, so React Native's autolinking never saw a fourth native
 * module, Gradle never configured it, and the build SUCCEEDED without it. Every
 * gate we own was green because every gate we own tests the SOURCE. Nothing
 * tested the ARTIFACT.
 *
 * So this script asks two questions that no test asks:
 *
 *   1. Does every package under `packages/*` actually resolve from the example
 *      app — the thing autolinking walks — and does it resolve to the package
 *      IN THIS REPO rather than a same-named copy from a registry?
 *   2. (with `--apk`) Is each one's native artifact actually INSIDE the APK
 *      that was built?
 *
 * Question 2 is the one that bit us, and it is cheap and non-flaky here for a
 * specific reason: every package's Android module builds a shared library whose
 * name is set in its own `android/CMakeLists.txt` (`set (PACKAGE_NAME …)`), and
 * `lib/<abi>/lib<PACKAGE_NAME>.so` entries in an APK are never renamed,
 * shrunk away or obfuscated — R8/ProGuard touch bytecode, not `lib/`. So the
 * check is a string lookup in the zip's central directory: no dex parsing, no
 * `aapt`, no Android SDK, no assumptions about minification. (A dex-symbol
 * check WOULD be flaky under R8 for exactly the reason `lib/` is not, which is
 * why it is not what this does.)
 *
 * Usage:
 *   node scripts/check-workspace-links.mjs
 *   node scripts/check-workspace-links.mjs --apk apps/example/android/app/build/outputs/apk/debug/app-debug.apk
 *   node scripts/check-workspace-links.mjs --json
 *
 * Exit codes: 0 = every check passed. 1 = at least one FAILED. There is no
 * "warning" exit: a package that cannot be resolved is a package that will not
 * ship, and this script exists because that failure was silent once already.
 *
 * Design notes (same house rules as check-upstream.mjs):
 *   - Plain Node 22, zero dependencies, no build step. It has to be runnable
 *     the moment `npm ci` finishes and before anything is compiled.
 *   - Nothing is hardcoded. The package list is `packages/*`, the names come
 *     from each `package.json`, the expected `.so` names come from each
 *     `CMakeLists.txt`. Adding `packages/foo` puts it under the guard with no
 *     edit here — which is the whole point, since the failure mode is a NEW
 *     package being silently absent.
 *   - Resolution is done with Node's own resolver from the example's
 *     `package.json`, not by `readdir`-ing a `node_modules` directory. npm
 *     workspaces hoist links to the ROOT `node_modules/@scope/name` and only
 *     un-hoist on conflict, so "is the symlink in apps/example/node_modules"
 *     is the wrong question and answering it would produce a false alarm on a
 *     perfectly good tree. What matters is what a resolver walking up from
 *     apps/example finds — that is precisely what Metro, the RN CLI and
 *     Gradle's autolinking do.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  lstatSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const EXAMPLE_DIR = join(REPO_ROOT, 'apps/example');
const EXAMPLE_MANIFEST = join(EXAMPLE_DIR, 'package.json');

// ─────────────────────────────────────────────────────────────────────────────
// Tiny utilities
// ─────────────────────────────────────────────────────────────────────────────

/** @param {string} abs */
function rel(abs) {
  return relative(REPO_ROOT, abs).split('\\').join('/');
}

/** @param {string} p @returns {any|null} */
function readJson(p) {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** realpath that never throws — a broken symlink must read as a finding. */
function realpathOrNull(/** @type {string} */ p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * The `node_modules/<name>` entry a resolver walking up from apps/example hits
 * first, and whether it is a link or a real directory.
 *
 * `require.resolve` alone cannot answer this: Node resolves symlinks, so it
 * hands back `packages/cast/…` and every install looks identical. The
 * distinction matters — a *symlink* is the workspace, a *real directory* under
 * `node_modules` is a published copy shadowing it — and so does the location,
 * because npm hoists workspace links to the root and un-hoists only on
 * conflict. Reporting the actual path is what makes "the link is missing"
 * legible rather than mysterious.
 * @param {string} name
 * @returns {{ path: string, kind: 'workspace link'|'real directory' }|null}
 */
function findNodeModulesEntry(name) {
  let dir = EXAMPLE_DIR;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    try {
      const st = lstatSync(candidate);
      return {
        path: candidate,
        kind: st.isSymbolicLink() ? 'workspace link' : 'real directory',
      };
    } catch {
      // not here; keep walking up
    }
    const parent = dirname(dir);
    if (dir === REPO_ROOT || parent === dir) return null;
    dir = parent;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every directory under `packages/` that carries a `package.json`.
 * A directory WITHOUT one is reported rather than skipped: a package whose
 * manifest is missing is exactly as unshippable as one whose link is missing.
 * @returns {{ dir: string, slug: string, name: string|null, error: string|null,
 *             soName: string|null }[]}
 */
function discoverPackages() {
  if (!existsSync(PACKAGES_DIR)) return [];
  const out = [];
  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(PACKAGES_DIR, entry.name);
    const manifest = readJson(join(dir, 'package.json'));
    out.push({
      dir,
      slug: entry.name,
      name: typeof manifest?.name === 'string' ? manifest.name : null,
      error: manifest ? null : `no readable package.json in ${rel(dir)}`,
      soName: readNativeLibraryName(dir),
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * The shared-library name the package's Android module produces, parsed out of
 * its own `android/CMakeLists.txt` (`set (PACKAGE_NAME RnMediaCast)` → the APK
 * carries `lib/<abi>/libRnMediaCast.so`). `null` means the package has no
 * Android native module, and is therefore not expected in the APK's `lib/`.
 * @param {string} packageDir
 */
function readNativeLibraryName(packageDir) {
  const file = join(packageDir, 'android/CMakeLists.txt');
  if (!existsSync(file)) return null;
  const m = /^\s*set\s*\(\s*PACKAGE_NAME\s+([A-Za-z0-9_+-]+)\s*\)/m.exec(
    readFileSync(file, 'utf8'),
  );
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 1 — every workspace package resolves from the example, in-repo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ check: string, subject: string, ok: boolean, detail: string }} Result
 */

/** @returns {Result[]} */
function checkLinks() {
  /** @type {Result[]} */
  const results = [];
  const packages = discoverPackages();

  if (packages.length === 0) {
    return [
      {
        check: 'discovery',
        subject: 'packages/*',
        ok: false,
        detail: 'no workspace packages found — is this the repo root?',
      },
    ];
  }

  const exampleManifest = readJson(EXAMPLE_MANIFEST);
  if (!exampleManifest) {
    return [
      {
        check: 'discovery',
        subject: rel(EXAMPLE_MANIFEST),
        ok: false,
        detail: 'unreadable — the example app is the on-device test bed and every package must be wired into it',
      },
    ];
  }
  /** @type {Record<string, string>} */
  const exampleDeps = {
    ...(exampleManifest.devDependencies ?? {}),
    ...(exampleManifest.dependencies ?? {}),
  };

  // Node's own resolver, anchored at the example's manifest: this is the walk
  // Metro and the RN CLI perform, hoisting and all.
  const requireFromExample = createRequire(EXAMPLE_MANIFEST);

  for (const pkg of packages) {
    const subject = pkg.name ?? `packages/${pkg.slug}`;

    if (pkg.error || !pkg.name) {
      results.push({
        check: 'manifest',
        subject,
        ok: false,
        detail: pkg.error ?? 'package.json has no "name"',
      });
      continue;
    }

    // (a) declared. An undeclared package can still resolve by accident via a
    //     hoisted link, so this is checked separately and first: the example
    //     must ASK for the package, or a future `npm ci` is free to prune it.
    const declared = Object.prototype.hasOwnProperty.call(
      exampleDeps,
      pkg.name,
    );
    results.push({
      check: 'declared',
      subject: pkg.name,
      ok: declared,
      detail: declared
        ? `apps/example/package.json depends on it ("${exampleDeps[pkg.name]}")`
        : `apps/example/package.json does NOT depend on it — autolinking will never see it, and the APK will build fine without it`,
    });

    // (b) resolvable from the example.
    let resolved = null;
    let resolveError = '';
    try {
      resolved = requireFromExample.resolve(`${pkg.name}/package.json`);
    } catch (e) {
      resolveError = e instanceof Error ? e.message.split('\n')[0] : String(e);
    }
    if (resolved == null) {
      results.push({
        check: 'resolves',
        subject: pkg.name,
        ok: false,
        detail: `does not resolve from apps/example — the workspace link is missing. Run \`npm install\` at the repo root. (${resolveError})`,
      });
      continue;
    }
    const resolvedDir = dirname(resolved);
    const entry = findNodeModulesEntry(pkg.name);
    results.push({
      check: 'resolves',
      subject: pkg.name,
      ok: true,
      detail: entry
        ? `${rel(entry.path)} → ${rel(resolvedDir)} (${entry.kind})`
        : `${rel(resolvedDir)} (resolved, but via no node_modules entry between apps/example and the repo root — unexpected)`,
    });

    // (c) it is THIS repo's copy, not a same-named package from a registry.
    const wantReal = realpathOrNull(pkg.dir);
    const gotReal = realpathOrNull(resolvedDir);
    const inRepo = wantReal != null && gotReal === wantReal;
    results.push({
      check: 'in-repo',
      subject: pkg.name,
      ok: inRepo,
      detail: inRepo
        ? `→ ${rel(pkg.dir)}`
        : `resolves to ${gotReal ? rel(gotReal) : '<unresolvable>'}, NOT ${rel(pkg.dir)} — a published copy is shadowing the workspace, so the code under test is not the code that ships`,
    });

    // (d) the name on the tin matches the name inside it. A rename that lands
    //     in packages/ but not in the example's dependencies resolves to a
    //     STALE copy without any of this failing otherwise.
    const resolvedName = readJson(resolved)?.name;
    const nameOk = resolvedName === pkg.name;
    results.push({
      check: 'name',
      subject: pkg.name,
      ok: nameOk,
      detail: nameOk
        ? `package.json name matches the example's dependency key`
        : `resolved package is named "${String(resolvedName)}"`,
    });
  }

  // The reverse direction: an `@scope/x` the example depends on that has no
  // packages/x behind it. That is a dependency npm will try to fetch from the
  // registry — either a typo or a package that was deleted/renamed.
  const scopes = new Set(
    packages
      .map((p) => p.name)
      .filter((n) => typeof n === 'string' && n.startsWith('@'))
      .map((n) => /** @type {string} */ (n).split('/')[0]),
  );
  const known = new Set(packages.map((p) => p.name));
  for (const dep of Object.keys(exampleDeps)) {
    if (!scopes.has(dep.split('/')[0]) || known.has(dep)) continue;
    results.push({
      check: 'orphan-dep',
      subject: dep,
      ok: false,
      detail: `apps/example depends on it but there is no packages/* providing it — npm would resolve this from the registry`,
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 2 — the built APK actually contains each package's native library
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entry names from a zip's central directory, read straight off disk.
 *
 * A pure-Node reader rather than `unzip`/`aapt` so the check has the same
 * dependency footprint as the rest of this script (none) and behaves the same
 * on a runner as on a laptop. Only names are read; nothing is inflated.
 * @param {string} apkPath
 * @returns {{ names: string[] } | { error: string }}
 */
function readZipEntryNames(apkPath) {
  let fd;
  try {
    fd = openSync(apkPath, 'r');
  } catch (e) {
    return { error: `cannot open: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    const size = fstatSync(fd).size;
    // The end-of-central-directory record is last, but may be followed by up to
    // 64 KiB of zip comment, so scan that window backwards for its signature.
    const tailLen = Math.min(size, 0x10000 + 22);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return { error: 'no end-of-central-directory record — not a zip/APK?' };

    const entryCount = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      return { error: 'zip64 central directory — this reader does not handle it (say so rather than report a false miss)' };
    }

    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);
    /** @type {string[]} */
    const names = [];
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      names.push(cd.toString('utf8', p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (names.length !== entryCount) {
      return { error: `central directory is truncated or malformed (read ${names.length} of ${entryCount} entries)` };
    }
    return { names };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {string} apkPath
 * @returns {Result[]}
 */
function checkApk(apkPath) {
  const abs = resolve(REPO_ROOT, apkPath);
  const zip = readZipEntryNames(abs);
  if ('error' in zip) {
    return [{ check: 'apk', subject: rel(abs), ok: false, detail: zip.error }];
  }

  // The ABIs the APK was actually built for. Derived from the artifact rather
  // than assumed, because `-PreactNativeArchitectures` legitimately varies
  // between a CI build and a local one, and a check that assumed four ABIs
  // would cry wolf on every single-ABI build.
  const abis = [
    ...new Set(
      zip.names
        .filter((n) => n.startsWith('lib/') && n.endsWith('.so'))
        .map((n) => n.split('/')[1]),
    ),
  ].sort();

  /** @type {Result[]} */
  const results = [];
  if (abis.length === 0) {
    return [
      {
        check: 'apk',
        subject: rel(abs),
        ok: false,
        detail: `contains no lib/<abi>/*.so at all (${zip.names.length} entries) — wrong artifact, or a build that produced no native code`,
      },
    ];
  }
  results.push({
    check: 'apk',
    subject: rel(abs),
    ok: true,
    detail: `${zip.names.length} entries, ABIs: ${abis.join(', ')}`,
  });

  const entries = new Set(zip.names);
  for (const pkg of discoverPackages()) {
    const subject = pkg.name ?? `packages/${pkg.slug}`;
    if (!pkg.soName) {
      results.push({
        check: 'in-apk',
        subject,
        ok: true,
        detail: 'no android/CMakeLists.txt — no native library expected',
      });
      continue;
    }
    const missing = abis.filter(
      (abi) => !entries.has(`lib/${abi}/lib${pkg.soName}.so`),
    );
    results.push({
      check: 'in-apk',
      subject,
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `lib${pkg.soName}.so present for ${abis.length === 1 ? abis[0] : `all ${abis.length} ABIs`}`
          : `lib${pkg.soName}.so MISSING for ${missing.join(', ')} — the package did not make it into the APK (autolinking never saw it, or Gradle never configured its module)`,
    });
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

/** @param {string[][]} rows */
function asciiTable(rows) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => [...(r[c] ?? '')].length)));
  const line = (/** @type {string} */ l, /** @type {string} */ m, /** @type {string} */ r) =>
    l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const fmt = (/** @type {string[]} */ r) =>
    '│ ' + r.map((c, i) => (c ?? '').padEnd(widths[i])).join(' │ ') + ' │';
  return [line('┌', '┬', '┐'), fmt(rows[0]), line('├', '┼', '┤'), ...rows.slice(1).map(fmt), line('└', '┴', '┘')].join('\n');
}

/** @param {Result[]} results */
function renderConsole(results) {
  const head = ['Check', 'Package', 'Status', 'Detail'];
  const body = results.map((r) => [r.check, r.subject, r.ok ? 'ok' : 'FAILED', r.detail]);
  const failed = results.filter((r) => !r.ok);
  const out = [asciiTable([head, ...body]), ''];
  if (failed.length) {
    out.push(`${failed.length} check${failed.length === 1 ? '' : 's'} FAILED.`);
    if (failed.some((r) => r.check !== 'in-apk')) {
      out.push(
        '',
        'A package that does not resolve from apps/example is a package the build will happily omit:',
        'autolinking skips it, Gradle never configures its module, the APK comes out smaller, and every',
        'test still passes. Fix with `npm install` at the repo root, then re-run.',
      );
    }
    if (failed.some((r) => r.check === 'in-apk')) {
      out.push(
        '',
        'A native library missing from the APK means the build SUCCEEDED without that package. If the',
        'link checks above are green, the tree is fine and the artifact is stale: rebuild it. If they',
        'are not, fix them first — that is the same failure, one step earlier.',
      );
    }
  } else {
    out.push(
      `All ${results.length} checks passed — every packages/* resolves from apps/example, in-repo${
        results.some((r) => r.check === 'in-apk') ? ', and every native library is inside the APK' : ''
      }.`,
    );
  }
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);

  const apkIndex = argv.indexOf('--apk');
  if (apkIndex >= 0 && !argv[apkIndex + 1]) {
    console.error('check-workspace-links: --apk needs a path to an .apk');
    process.exit(1);
  }

  const results = [
    ...checkLinks(),
    ...(apkIndex >= 0 ? checkApk(argv[apkIndex + 1]) : []),
  ];

  if (args.has('--json')) {
    console.log(JSON.stringify({ results, failed: results.filter((r) => !r.ok).length }, null, 2));
  } else {
    console.log(renderConsole(results));
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const failed = results.filter((r) => !r.ok);
    const md = [
      '## Workspace links',
      '',
      failed.length ? `**${failed.length} check(s) FAILED.**` : '**All checks passed.**',
      '',
      '| Check | Package | Status | Detail |',
      '| --- | --- | --- | --- |',
      ...results.map((r) => `| ${r.check} | \`${r.subject}\` | ${r.ok ? '🟢 ok' : '🔴 FAILED'} | ${r.detail} |`),
      '',
    ].join('\n');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  }

  if (results.some((r) => !r.ok)) process.exit(1);
}

main();
