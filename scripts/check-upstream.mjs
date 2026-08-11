#!/usr/bin/env node
// @ts-check
/**
 * Upstream currency watcher — CLAUDE.md "Dependency policy → Currency rule".
 *
 *   "Engine pieces (mpv, ffmpeg via our binary forks), media3, the Nitro pair,
 *    and the tested RN version track latest stable […] A scheduled CI watcher
 *    compares our pins to upstream latest and opens a tracking issue when we
 *    fall behind."
 *
 * This is that watcher. It SURFACES drift and nothing else: no auto-bump, no
 * PRs. The currency rule is evaluate-then-ship (verification playbook, patch
 * rebase, device re-verification), and none of that is a robot's job.
 *
 * Usage:
 *   node scripts/check-upstream.mjs            # print the table, exit 0
 *   node scripts/check-upstream.mjs --json     # machine-readable dump
 *   node scripts/check-upstream.mjs --github   # + maintain the tracking issue
 *                                              #   (needs GH_TOKEN/GITHUB_TOKEN
 *                                              #    and GITHUB_REPOSITORY)
 *   node scripts/check-upstream.mjs --dry-run  # as --github, but reads only:
 *                                              #   prints the write it would do
 *
 * Design notes:
 *   - Plain Node 22, zero dependencies, so it runs locally exactly as it runs
 *     in CI (`npm ci` is not a prerequisite for knowing whether we lag).
 *   - Every pin is PARSED out of the repo, never hardcoded. After a bump the
 *     script keeps working with no edit here; if a pin file is restructured the
 *     row goes 'unknown' and says so, which is a visible failure rather than a
 *     silent false 'current'.
 *   - Every network source is allowed to be down. A failed fetch yields status
 *     'unknown' with the error in the notes. A source being unreachable must
 *     never crash the run and must never be reported as 'current'.
 *   - The fork tags (`v1.1.9-rnmedia.2`, `v0.7.2-rnmedia.2`) are OURS and do
 *     not map onto an upstream version, so they are context rows, never drift.
 *     What is compared for the engine is the mpv/ffmpeg version embedded in
 *     the binaries, which the pin files record as metadata.
 *   - The engine is more than mpv+FFmpeg: mbedTLS, libplacebo and libxml2 are
 *     compiled into the same artifact, so they get rows too, once per platform.
 *     They are per-fork build-script choices, which means the two platforms CAN
 *     disagree — and a disagreement is itself a finding (CLAUDE.md makes parity
 *     a gate), so it is printed loudly rather than resolved silently. A pin of
 *     `none` means the component is not in the artifact at all (libxml2, since
 *     the rnmedia.7/.6 parity pair): the row stays on the table as 'info' and
 *     no upstream is contacted for it — see `isNotShipped`.
 *   - The engine's richer source of truth is the workshop repo
 *     (afkcodes/rn-media-engine, manifest/engine.json). This watcher does not
 *     read it, on purpose: it parses the pin files in THIS repo, so it reports
 *     what rn-media actually ships. It is the safety net, not the manifest.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ISSUE_LABEL = 'upstream-drift';
const ISSUE_TITLE_PREFIX = 'Upstream currency:';
/** Marker that identifies a body this script generated. */
const BODY_MARKER = '<!-- rn-media-upstream-watcher -->';
const USER_AGENT = 'rn-media-upstream-watcher';

// ─────────────────────────────────────────────────────────────────────────────
// Tiny utilities
// ─────────────────────────────────────────────────────────────────────────────

/** @param {string} p */
function readIfExists(p) {
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/**
 * 1-based line number of the first line matching `re`, or null.
 * @param {string} text @param {RegExp} re
 */
function lineOf(text, re) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return null;
}

/** @param {string} abs */
function rel(abs) {
  return relative(REPO_ROOT, abs).split('\\').join('/');
}

/**
 * Numeric-segment version compare with a "prerelease sorts before release"
 * rule. Enough for mpv (0.41.0), ffmpeg (n9.0), media3 (1.11.0) and npm
 * semver; deliberately NOT a full semver implementation — the only thing this
 * has to answer is "are we behind?".
 * @param {string} a @param {string} b
 * @returns {number} <0 if a<b, 0 if equal, >0 if a>b
 */
function compareVersions(a, b) {
  const split = (/** @type {string} */ v) => {
    const [core, ...pre] = String(v).replace(/^[nv]/, '').split('-');
    return {
      nums: core.split('.').map((x) => parseInt(x, 10) || 0),
      pre: pre.join('-'),
    };
  };
  const A = split(a);
  const B = split(b);
  const len = Math.max(A.nums.length, B.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (A.nums[i] ?? 0) - (B.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1; // 1.0.0 > 1.0.0-rc1
  if (!B.pre) return -1;
  return A.pre < B.pre ? -1 : 1;
}

/** Strip an npm range operator: "^0.36.1" → "0.36.1". @param {string} r */
function bareVersion(r) {
  return String(r).replace(/^[\^~>=<\s]+/, '').trim();
}

/**
 * The pin value that means "this component is NOT in the artifact we ship".
 *
 * Both pin files state absence with a value rather than by deleting the field,
 * so that a reader can tell "we removed it" from "nobody recorded it" — see the
 * `libxml2Version` / `LIBMPV_LIBXML2_VERSION` comments, which is where the
 * convention is defined. It arrived with the rnmedia.7/.6 parity pair, which
 * dropped libxml2 from both audio artifacts (FFmpeg reaches it only from the
 * DASH demuxer, which neither fork enables).
 *
 * Consequences here, all three deliberate:
 *   1. no upstream lookup is performed for a component nobody ships — asking
 *      GNOME GitLab what the newest libxml2 is, in order to compare it against
 *      nothing, is a request that can only produce a fake 'unknown' when it
 *      fails;
 *   2. the row is 'info', never behind/unknown — "absent on purpose" is not
 *      drift, and it must not be able to open the tracking issue;
 *   3. `none` on ONE platform against a version on the other is still
 *      divergence, and is printed loudly. That is the case parity actually
 *      cares about.
 * @param {string|null|undefined} v
 */
function isNotShipped(v) {
  return String(v ?? '').trim().toLowerCase() === 'none';
}

/** @param {string|null|undefined} iso */
function isoDate(iso) {
  if (!iso) return '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Network: every call is retried, timed out, and allowed to fail
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

/**
 * @param {string} url
 * @param {{ headers?: Record<string,string>, method?: string, body?: unknown, timeoutMs?: number, attempts?: number }} [opt]
 * @returns {Promise<{ ok: true, status: number, text: string, headers: Headers } | { ok: false, error: string, status?: number }>}
 */
async function request(url, opt = {}) {
  const attempts = opt.attempts ?? 3;
  let lastErr = 'unknown error';
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: opt.method ?? 'GET',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/json',
          ...(opt.body ? { 'content-type': 'application/json' } : {}),
          ...opt.headers,
        },
        body: opt.body ? JSON.stringify(opt.body) : undefined,
        signal: AbortSignal.timeout(opt.timeoutMs ?? 20_000),
      });
      const text = await res.text();
      if (!res.ok) {
        // 4xx other than 429 is a contract problem, not a blip — do not retry.
        if (res.status < 500 && res.status !== 429) {
          return { ok: false, error: `HTTP ${res.status}`, status: res.status };
        }
        lastErr = `HTTP ${res.status}`;
      } else {
        return { ok: true, status: res.status, text, headers: res.headers };
      }
    } catch (e) {
      lastErr = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
  }
  return { ok: false, error: lastErr };
}

/**
 * @param {string} url @param {{ headers?: Record<string,string> }} [opt]
 * @returns {Promise<{ ok: true, data: any, headers: Headers } | { ok: false, error: string, status?: number }>}
 */
async function getJson(url, opt = {}) {
  const res = await request(url, opt);
  if (!res.ok) return res;
  try {
    return { ok: true, data: JSON.parse(res.text), headers: res.headers };
  } catch {
    return { ok: false, error: 'invalid JSON in response' };
  }
}

/** GitHub REST helper. @param {string} path @param {object} [opt] */
async function gh(path, opt = {}) {
  const res = await getJson(path.startsWith('http') ? path : `https://api.github.com${path}`, {
    ...opt,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(opt.headers ?? {}),
    },
  });
  // 403/429 from api.github.com is almost always the rate limit, and the
  // unauthenticated ceiling (60/h) is low enough that a few local runs in a row
  // hit it. Say so, rather than leaving a bare "HTTP 403" to be puzzled over.
  if (!res.ok && (res.status === 403 || res.status === 429)) {
    return {
      ...res,
      error: `${res.error} (GitHub rate limit${TOKEN ? '' : ' — set GH_TOKEN to raise it from 60/h to 5000/h'})`,
    };
  }
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pin readers — all of these parse the real files
// ─────────────────────────────────────────────────────────────────────────────

/**
 * packages/player/android/libmpv.gradle → the `ext.libmpv = [ … ]` block.
 * Returns the key/value scalars plus the file/line where the block starts.
 */
function readAndroidEnginePin() {
  const file = join(REPO_ROOT, 'packages/player/android/libmpv.gradle');
  const text = readIfExists(file);
  if (text == null) return { file, error: 'file not found', values: {}, lines: {} };

  const start = text.indexOf('ext.libmpv');
  if (start < 0) return { file, error: 'no `ext.libmpv` block', values: {}, lines: {} };
  const open = text.indexOf('[', start);
  if (open < 0) return { file, error: 'malformed `ext.libmpv` block', values: {}, lines: {} };

  // Bracket-match to the end of the map literal so nested maps (sha256) are
  // included and nothing after the block can be mistaken for a pin field.
  let depth = 0;
  let end = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return { file, error: 'unterminated `ext.libmpv` block', values: {}, lines: {} };

  const blockStartLine = text.slice(0, open).split('\n').length;
  /** @type {Record<string,string>} */
  const values = {};
  /** @type {Record<string,number>} */
  const lines = {};
  const blockLines = text.slice(open, end).split('\n');
  for (let i = 0; i < blockLines.length; i++) {
    const raw = blockLines[i];
    if (/^\s*\/\//.test(raw)) continue; // comment-only line
    const code = raw.replace(/\/\/.*$/, ''); // trailing comment (values are quoted, never contain //)
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'([^']*)'/.exec(code);
    if (m) {
      values[m[1]] = m[2];
      lines[m[1]] = blockStartLine + i;
    }
  }
  return { file, error: null, values, lines, blockStartLine };
}

/**
 * packages/player/ios/libmpv.pin → `KEY=value` lines (`#` comments).
 */
function readIosEnginePin() {
  const file = join(REPO_ROOT, 'packages/player/ios/libmpv.pin');
  const text = readIfExists(file);
  if (text == null) return { file, error: 'file not found', values: {}, lines: {} };
  /** @type {Record<string,string>} */
  const values = {};
  /** @type {Record<string,number>} */
  const lines = {};
  text.split('\n').forEach((raw, i) => {
    const m = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(raw);
    if (!m) return;
    values[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    lines[m[1]] = i + 1;
  });
  return { file, error: null, values, lines };
}

/**
 * media3. Primary source is the gradle.properties key that build.gradle reads
 * (`…_media3Version`); the literal coordinate in build.gradle is the fallback,
 * so moving the pin between the two files does not blind the watcher.
 */
function readMedia3Pin() {
  const candidates = [
    join(REPO_ROOT, 'packages/media-session/android/gradle.properties'),
    join(REPO_ROOT, 'packages/media-session/android/build.gradle'),
  ];
  for (const file of candidates) {
    const text = readIfExists(file);
    if (text == null) continue;
    const prop = /^[ \t]*[\w.]*media3Version[ \t]*=[ \t]*([^\s#]+)/m.exec(text);
    if (prop) {
      return { file, version: prop[1], line: lineOf(text, /[\w.]*media3Version[ \t]*=/), error: null };
    }
    const coord = /androidx\.media3:[\w-]+:(\d[^"'\s}]*)/.exec(text);
    if (coord) {
      return { file, version: coord[1], line: lineOf(text, /androidx\.media3:[\w-]+:\d/), error: null };
    }
  }
  return { file: candidates[0], version: null, line: null, error: 'no media3 version found in packages/media-session' };
}

/**
 * Every package.json in the workspace (root, packages/*, apps/*).
 * peerDependencies are deliberately excluded: those are compatibility FLOORS
 * (`react-native: ">=0.82.0"`), not pins, and treating a floor as a pin would
 * report permanent phantom drift.
 * @returns {{ file: string, deps: Record<string, { version: string, field: string, line: number|null }> }[]}
 */
function readWorkspacePackageJsons() {
  /** @type {string[]} */
  const files = [join(REPO_ROOT, 'package.json')];
  for (const dir of ['packages', 'apps']) {
    const base = join(REPO_ROOT, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = join(base, entry.name, 'package.json');
      if (existsSync(p)) files.push(p);
    }
  }
  return files.map((file) => {
    const text = readFileSync(file, 'utf8');
    /** @type {Record<string, { version: string, field: string, line: number|null }>} */
    const deps = {};
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { file, deps };
    }
    for (const field of ['dependencies', 'devDependencies']) {
      for (const [name, version] of Object.entries(json[field] ?? {})) {
        if (typeof version !== 'string') continue;
        // Match name AND value: package.json's top-level `"react-native":
        // "src/index"` entry field would otherwise win the line lookup over
        // the actual dependency entry further down.
        const esc = (/** @type {string} */ s) => s.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
        deps[name] = {
          version,
          field,
          line:
            lineOf(text, new RegExp(`"${esc(name)}"\\s*:\\s*"${esc(version)}"`)) ??
            lineOf(text, new RegExp(`"${esc(name)}"\\s*:`)),
        };
      }
    }
    return { file, deps };
  });
}

/**
 * Collapse one npm package's pins across the workspace into a single "ours".
 * Divergence between packages is itself a finding, so it is surfaced in the
 * notes rather than silently resolved to the max.
 * @param {ReturnType<typeof readWorkspacePackageJsons>} pkgs @param {string} name
 */
function collapseNpmPin(pkgs, name) {
  /** @type {{ file: string, line: number|null, version: string }[]} */
  const found = [];
  for (const p of pkgs) {
    const d = p.deps[name];
    if (d) found.push({ file: p.file, line: d.line, version: d.version });
  }
  if (found.length === 0) return { version: null, sources: [], distinct: [], error: `${name} not found in any package.json` };
  const distinct = [...new Set(found.map((f) => bareVersion(f.version)))];
  // Report the LOWEST distinct pin as "ours": if any package lags, we lag.
  const version = distinct.slice().sort(compareVersions)[0];
  return { version, sources: found, distinct, error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstream resolvers
// ─────────────────────────────────────────────────────────────────────────────

/** Latest stable mpv. `/releases/latest` already excludes drafts+prereleases. */
async function fetchMpvLatest() {
  const r = await gh('/repos/mpv-player/mpv/releases/latest');
  if (!r.ok) return { error: r.error };
  return { version: String(r.data.tag_name ?? '').replace(/^v/, ''), date: isoDate(r.data.published_at), url: r.data.html_url };
}

/**
 * FFmpeg release lines. FFmpeg publishes no GitHub Releases, only tags, and the
 * tag list is NOT sorted usefully by the API (it is reverse-lexicographic, so
 * `n10.x` would land below `n1.x` the day 10 ships). So: page through the whole
 * tag list (5 pages today), keep only stable `n<major>.<minor>[.<patch>]` tags,
 * and sort numerically ourselves.
 *
 * Returns the top TWO release lines, because a brand-new major can be days old
 * and "you are two majors behind" reads very differently from "the new major
 * landed on Tuesday".
 */
async function fetchFfmpegLines() {
  /** @type {{ name: string, commitUrl: string }[]} */
  const tags = [];
  let url = 'https://api.github.com/repos/FFmpeg/FFmpeg/tags?per_page=100';
  for (let page = 0; page < 10 && url; page++) {
    const r = await gh(url);
    if (!r.ok) return { error: r.error };
    if (!Array.isArray(r.data)) return { error: 'unexpected tags payload' };
    for (const t of r.data) tags.push({ name: String(t.name), commitUrl: t?.commit?.url ?? '' });
    const link = r.headers.get('link') ?? '';
    const next = /<([^>]+)>;\s*rel="next"/.exec(link);
    url = next ? next[1] : '';
  }
  const stable = tags.filter((t) => /^n\d+\.\d+(\.\d+)?$/.test(t.name));
  if (stable.length === 0) return { error: 'no stable n* tags found' };

  /** @type {Map<number, { name: string, commitUrl: string }>} */
  const byMajor = new Map();
  for (const t of stable) {
    const major = parseInt(t.name.slice(1), 10);
    const cur = byMajor.get(major);
    if (!cur || compareVersions(t.name, cur.name) > 0) byMajor.set(major, t);
  }
  const majors = [...byMajor.keys()].sort((a, b) => b - a);
  const pick = async (/** @type {number|undefined} */ major) => {
    if (major === undefined) return null;
    const t = /** @type {{name:string,commitUrl:string}} */ (byMajor.get(major));
    let date = '';
    if (t.commitUrl) {
      const c = await gh(t.commitUrl);
      if (c.ok) date = isoDate(c.data?.commit?.committer?.date ?? c.data?.commit?.author?.date);
    }
    return { version: t.name.replace(/^n/, ''), tag: t.name, date };
  };
  return { latest: await pick(majors[0]), previous: await pick(majors[1]) };
}

/** media3 via Google Maven's maven-metadata.xml `<release>`. */
async function fetchMedia3Latest() {
  const url = 'https://dl.google.com/dl/android/maven2/androidx/media3/media3-session/maven-metadata.xml';
  const r = await request(url, { headers: { accept: 'application/xml' } });
  if (!r.ok) return { error: r.error };
  const m = /<release>([^<]+)<\/release>/.exec(r.text);
  if (!m) return { error: '<release> not present in maven-metadata.xml' };
  const upd = /<lastUpdated>(\d{4})(\d{2})(\d{2})/.exec(r.text);
  return { version: m[1].trim(), date: upd ? `${upd[1]}-${upd[2]}-${upd[3]}` : '' };
}

/**
 * npm `latest` dist-tag. Uses the dist-tags endpoint (a few hundred bytes)
 * rather than the packument — react-native's abbreviated packument is ~7 MB,
 * which is a lot of bandwidth to buy a publish date we do not need.
 * @param {string} pkg
 */
async function fetchNpmLatest(pkg) {
  const r = await getJson(`https://registry.npmjs.org/-/package/${encodeURIComponent(pkg)}/dist-tags`);
  if (!r.ok) return { error: r.error };
  const v = r.data?.latest;
  if (!v) return { error: 'no `latest` dist-tag' };
  return { version: String(v), date: '' };
}

/** Latest release of a GitHub repo (used for the fork-base context rows). */
async function fetchRepoLatestRelease(/** @type {string} */ repo) {
  const r = await gh(`/repos/${repo}/releases/latest`);
  if (!r.ok) return { error: r.error };
  return { version: String(r.data.tag_name ?? ''), date: isoDate(r.data.published_at) };
}

// ── engine sub-dependencies (mbedTLS, libplacebo, libxml2) ───────────────────
//
// None of these three publishes a usable "latest release" endpoint for our
// purposes, so all three are resolved from the TAG list and sorted here:
//   - mbedTLS's `/releases/latest` exists but names the tag `mbedtls-4.2.0`
//     while the tag list uses `v4.2.0`, and it cannot answer the question that
//     actually matters for a pin on an LTS branch ("what is newest on 3.x?").
//   - libplacebo publishes tags, not releases.
//   - libxml2 does not live on GitHub at all; it is GNOME GitLab.
// Same reasoning as fetchFfmpegLines: tag order from an API is never the order
// you want, so ordering is always our job.

/** Tags that name a plain stable version. `v3.6.7`, `mbedtls-4.2.0`, `2.10.3`
 *  match; `v6.337.0-rc1`, `polarssl-1.1.0-rc0`, `yotta-2.3.2` do not. */
const STABLE_TAG = /^(?:v|mbedtls-)?(\d+(?:\.\d+){1,3})$/;

/**
 * All tags of a GitHub repo, paged.
 * @param {string} repo @param {number} [maxPages] mbedTLS is 3 pages of 100
 *   today (polarssl-era tags included); 5 leaves room without spending the
 *   unauthenticated 60/h rate limit on a repo that will never need it.
 * @returns {Promise<{ tags: { name: string, commitUrl: string }[] } | { error: string }>}
 */
async function fetchGithubTags(repo, maxPages = 5) {
  /** @type {{ name: string, commitUrl: string }[]} */
  const tags = [];
  let url = `https://api.github.com/repos/${repo}/tags?per_page=100`;
  for (let page = 0; page < maxPages && url; page++) {
    const r = await gh(url);
    if (!r.ok) return { error: r.error };
    if (!Array.isArray(r.data)) return { error: 'unexpected tags payload' };
    for (const t of r.data) tags.push({ name: String(t.name), commitUrl: t?.commit?.url ?? '' });
    const link = r.headers.get('link') ?? '';
    const next = /<([^>]+)>;\s*rel="next"/.exec(link);
    url = next ? next[1] : '';
  }
  return { tags };
}

/**
 * All tags of a GitLab project. Unlike GitHub's, this payload carries the
 * commit date inline, so no follow-up request is needed for the release date.
 * @param {string} host @param {string} project e.g. `GNOME/libxml2`
 * @returns {Promise<{ tags: { name: string, date: string }[] } | { error: string }>}
 */
async function fetchGitlabTags(host, project) {
  const r = await getJson(`https://${host}/api/v4/projects/${encodeURIComponent(project)}/repository/tags?per_page=100`);
  if (!r.ok) return r;
  if (!Array.isArray(r.data)) return { error: 'unexpected tags payload' };
  return { tags: r.data.map((/** @type {any} */ t) => ({ name: String(t.name), date: isoDate(t?.commit?.committed_date) })) };
}

/**
 * Highest stable tag, plus the highest stable tag on OUR OWN major line.
 *
 * The line matters because "behind" is not always the whole story for a
 * sub-dependency: mbedTLS 3.6 is a maintained LTS branch while 4.x is a new
 * API generation, so `3.6.1 → 3.6.7` and `3.6.1 → 4.2.0` are two different
 * findings and the row should be able to say both. The line note is emitted
 * only when it differs from the overall latest, so a component whose major
 * never changes (libxml2 has been 2.x since forever) does not print noise.
 *
 * @param {{ name: string, date?: string }[]} tags @param {string|null|undefined} ours
 */
function pickLatestTag(tags, ours) {
  /** @type {{ name: string, version: string, date?: string }[]} */
  const stable = [];
  for (const t of tags) {
    const m = STABLE_TAG.exec(t.name);
    if (m) stable.push({ ...t, version: m[1] });
  }
  if (stable.length === 0) return { error: 'no stable version tags found' };
  const best = (/** @type {typeof stable} */ list) =>
    list.reduce((a, b) => (compareVersions(b.version, a.version) > 0 ? b : a));
  const latest = best(stable);
  let line = null;
  if (ours) {
    const major = parseInt(String(ours).replace(/^[nv]/, ''), 10);
    const sameLine = stable.filter((t) => parseInt(t.version, 10) === major);
    if (sameLine.length) line = best(sameLine);
  }
  return { latest, line: line && compareVersions(line.version, latest.version) !== 0 ? line : null };
}

/**
 * A GitHub-hosted engine sub-dependency. One extra request resolves the
 * winning tag's date; a failure there costs the date, never the comparison.
 * @param {string} repo @param {string|null|undefined} ours
 */
async function fetchGithubTagLatest(repo, ours) {
  const r = await fetchGithubTags(repo);
  if ('error' in r) return { error: r.error };
  const picked = pickLatestTag(r.tags, ours);
  if ('error' in picked) return { error: picked.error };
  const t = /** @type {{ name: string, version: string, commitUrl?: string }} */ (picked.latest);
  let date = '';
  if (t.commitUrl) {
    const c = await gh(t.commitUrl);
    if (c.ok) date = isoDate(c.data?.commit?.committer?.date ?? c.data?.commit?.author?.date);
  }
  return { version: t.version, date, line: picked.line };
}

/** libxml2 lives on GNOME GitLab; there is no upstream GitHub repo, only mirrors. */
async function fetchLibxml2Latest(/** @type {string|null|undefined} */ ours) {
  const r = await fetchGitlabTags('gitlab.gnome.org', 'GNOME/libxml2');
  if ('error' in r) return { error: r.error };
  const picked = pickLatestTag(r.tags, ours);
  if ('error' in picked) return { error: picked.error };
  return { version: picked.latest.version, date: picked.latest.date ?? '', line: picked.line };
}

// ─────────────────────────────────────────────────────────────────────────────
// Row building
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {'behind'|'current'|'ahead'|'unknown'|'info'} Status
 * @typedef {{ component: string, ours: string, latest: string, released: string, status: Status,
 *             notes: string, unknownReason?: 'pin'|'upstream'|null }} Row
 */

/**
 * @param {{ component: string, ours: string|null|undefined, latest: string|null|undefined,
 *           released?: string, notes?: string[], oursError?: string|null, latestError?: string|null }} spec
 * @returns {Row}
 */
function compareRow(spec) {
  const notes = (spec.notes ?? []).filter(Boolean);
  /** @type {Status} */
  let status;
  /** @type {'pin'|'upstream'|null} */
  let unknownReason = null;
  if (!spec.ours || spec.oursError) {
    status = 'unknown';
    unknownReason = 'pin';
    notes.unshift(`could not read our pin: ${spec.oursError ?? 'not found'}`);
  } else if (!spec.latest || spec.latestError) {
    status = 'unknown';
    unknownReason = 'upstream';
    notes.unshift(`upstream lookup failed: ${spec.latestError ?? 'no version returned'}`);
  } else {
    const c = compareVersions(spec.ours, spec.latest);
    status = c < 0 ? 'behind' : c > 0 ? 'ahead' : 'current';
  }
  return {
    component: spec.component,
    ours: spec.ours || '—',
    latest: spec.latest || 'unknown',
    released: spec.released || '—',
    status,
    notes: notes.join('; '),
    unknownReason,
  };
}

/** @returns {Promise<{ rows: Row[], context: Row[], behind: number, unknown: number, generatedAt: string }>} */
async function collect() {
  const android = readAndroidEnginePin();
  const ios = readIosEnginePin();
  const media3Pin = readMedia3Pin();
  const pkgs = readWorkspacePackageJsons();
  const nitroRuntime = collapseNpmPin(pkgs, 'react-native-nitro-modules');
  const nitrogen = collapseNpmPin(pkgs, 'nitrogen');
  const rn = collapseNpmPin(pkgs, 'react-native');

  // Line hint for the sub-dependency resolvers: the LOWER of the two platform
  // pins, for the same reason collapseNpmPin reports the lowest npm pin as
  // "ours" — if either fork lags, we lag. A platform that does not ship the
  // component contributes no hint (`none` is not a low version).
  const lowerPin = (/** @type {string|undefined} */ a, /** @type {string|undefined} */ b) => {
    const av = isNotShipped(a) ? undefined : a;
    const bv = isNotShipped(b) ? undefined : b;
    return av && bv ? (compareVersions(av, bv) <= 0 ? av : bv) : av || bv;
  };

  /** Sentinel for a component neither platform ships: no lookup was attempted. */
  const NOT_SHIPPED_UPSTREAM = { notShipped: true };
  /**
   * Run an engine sub-dependency's upstream lookup only if at least one
   * platform actually ships it. Wrapped at the call site rather than inside
   * each resolver so the resolvers stay dumb about our pin conventions.
   * @param {string|undefined} a @param {string|undefined} b @param {() => Promise<any>} run
   */
  const ifShipped = (a, b, run) =>
    isNotShipped(a) && isNotShipped(b) ? Promise.resolve(NOT_SHIPPED_UPSTREAM) : run();

  const [
    mpv,
    ffmpeg,
    media3,
    nitroRuntimeLatest,
    nitrogenLatest,
    rnLatest,
    androidBase,
    iosBase,
    mbedtls,
    libplacebo,
    libxml2,
  ] = await Promise.all([
    fetchMpvLatest(),
    fetchFfmpegLines(),
    fetchMedia3Latest(),
    fetchNpmLatest('react-native-nitro-modules'),
    fetchNpmLatest('nitrogen'),
    fetchNpmLatest('react-native'),
    fetchRepoLatestRelease('media-kit/libmpv-android-audio-build'),
    fetchRepoLatestRelease('media-kit/libmpv-darwin-build'),
    ifShipped(android.values.mbedtlsVersion, ios.values.LIBMPV_MBEDTLS_VERSION, () =>
      fetchGithubTagLatest('Mbed-TLS/mbedtls', lowerPin(android.values.mbedtlsVersion, ios.values.LIBMPV_MBEDTLS_VERSION)),
    ),
    // haasn is libplacebo's own author and upstream's own mirror; the darwin
    // fork fetches its tarballs from there too, because code.videolan.org
    // refuses connections from some networks.
    ifShipped(android.values.libplaceboVersion, ios.values.LIBMPV_LIBPLACEBO_VERSION, () =>
      fetchGithubTagLatest('haasn/libplacebo', lowerPin(android.values.libplaceboVersion, ios.values.LIBMPV_LIBPLACEBO_VERSION)),
    ),
    // Neither fork ships libxml2 as of the rnmedia.7/.6 parity pair, so this
    // resolves to the sentinel and GNOME GitLab is never contacted.
    ifShipped(android.values.libxml2Version, ios.values.LIBMPV_LIBXML2_VERSION, () =>
      fetchLibxml2Latest(lowerPin(android.values.libxml2Version, ios.values.LIBMPV_LIBXML2_VERSION)),
    ),
  ]);

  const androidSrc = android.error ? '' : `${rel(android.file)}:${android.lines.mpvVersion ?? android.blockStartLine}`;
  const iosSrc = ios.error ? '' : `${rel(ios.file)}:${ios.lines.LIBMPV_MPV_VERSION ?? 1}`;
  /** Per-field source location, so a row points at the line it was read from. */
  const androidField = (/** @type {string} */ k) => (android.error ? '' : `${rel(android.file)}:${android.lines[k] ?? android.blockStartLine}`);
  const iosField = (/** @type {string} */ k) => (ios.error ? '' : `${rel(ios.file)}:${ios.lines[k] ?? 1}`);

  /**
   * The engine is ONE engine — CLAUDE.md makes platform parity a GATE, not a
   * preference — so the two forks disagreeing about what is inside them is a
   * finding in its own right, exactly like collapseNpmPin's distinct-set check
   * one axis over. Compared with compareVersions rather than by string, because
   * the FFmpeg pins spell the same version two ways (`n8.1.2` vs `8.1.2`) and
   * that is formatting, not drift.
   * A `none` pin (component not shipped) is handled ahead of the version
   * compare, because `compareVersions('none', …)` would parse it as 0 and
   * report the right answer for the wrong reason — and, more importantly,
   * because "one platform ships this and the other does not" is a sharper
   * finding than a version skew and deserves to read that way.
   * @param {string|undefined} a Android pin @param {string|undefined} b iOS pin
   */
  const divergence = (a, b) => {
    if (!a || !b) return '';
    if (isNotShipped(a) && isNotShipped(b)) return ''; // absent on both = parity
    if (isNotShipped(a) || isNotShipped(b)) {
      return isNotShipped(a)
        ? `DIVERGENT across platforms: Android does NOT ship this component, iOS pins ${b}`
        : `DIVERGENT across platforms: Android pins ${a}, iOS does NOT ship this component`;
    }
    return compareVersions(a, b) !== 0 ? `DIVERGENT across platforms: Android ${a}, iOS ${b}` : '';
  };

  /** @type {Row[]} */
  const rows = [];

  // ── engine: mpv, once per platform (the two forks are versioned separately
  //    and have in fact drifted apart — Android ships 0.35.1, iOS 0.36.0).
  rows.push(
    compareRow({
      component: 'mpv (Android engine)',
      ours: android.values.mpvVersion,
      oursError: android.error ?? (android.values.mpvVersion ? null : 'no `mpvVersion` in ext.libmpv'),
      latest: mpv.version,
      latestError: mpv.error,
      released: mpv.date,
      notes: [
        androidSrc && `pin: ${androidSrc}`,
        divergence(android.values.mpvVersion, ios.values.LIBMPV_MPV_VERSION),
        'embedded in our fork build; bumping means rebasing the fork',
      ],
    }),
  );
  rows.push(
    compareRow({
      component: 'mpv (iOS engine)',
      ours: ios.values.LIBMPV_MPV_VERSION,
      oursError: ios.error ?? (ios.values.LIBMPV_MPV_VERSION ? null : 'no LIBMPV_MPV_VERSION'),
      latest: mpv.version,
      latestError: mpv.error,
      released: mpv.date,
      notes: [iosSrc && `pin: ${iosSrc}`, divergence(android.values.mpvVersion, ios.values.LIBMPV_MPV_VERSION)],
    }),
  );

  // ── engine: ffmpeg.
  //
  //    This row is EXPECTED to read 'behind' and that is not a bug to be muted.
  //    Our FFmpeg is chosen by what the pinned mpv actually requires, and a
  //    fresh FFmpeg major routinely postdates the mpv release that has to build
  //    against it. Rather than special-case a version here — which would rot the
  //    day the pin moves — each pin file may carry a free-text rationale
  //    (`ffmpegPinNote` in ext.libmpv, `LIBMPV_FFMPEG_PIN_NOTE` in libmpv.pin)
  //    and it is surfaced verbatim in the notes column. The row still says
  //    BEHIND; it just also says why, in the pin's own words.
  const ffLatest = 'error' in ffmpeg ? null : ffmpeg.latest;
  const ffPrev = 'error' in ffmpeg ? null : ffmpeg.previous;
  const ffErr = 'error' in ffmpeg ? ffmpeg.error : ffLatest ? null : 'no release line resolved';
  const ffPrevNote = ffPrev ? `previous line: n${ffPrev.version}${ffPrev.date ? ` (${ffPrev.date})` : ''}` : '';
  for (const [component, version, err, src, pinNote] of /** @type {[string, string|undefined, string|null, string, string|undefined][]} */ ([
    [
      'FFmpeg (Android engine)',
      android.values.ffmpegVersion,
      android.error ?? (android.values.ffmpegVersion ? null : 'no `ffmpegVersion` field in ext.libmpv — only a prose comment'),
      androidSrc,
      android.values.ffmpegPinNote,
    ],
    [
      'FFmpeg (iOS engine)',
      ios.values.LIBMPV_FFMPEG_VERSION,
      ios.error ?? (ios.values.LIBMPV_FFMPEG_VERSION ? null : 'no LIBMPV_FFMPEG_VERSION'),
      ios.error ? '' : `${rel(ios.file)}:${ios.lines.LIBMPV_FFMPEG_VERSION ?? 1}`,
      ios.values.LIBMPV_FFMPEG_PIN_NOTE,
    ],
  ])) {
    rows.push(
      compareRow({
        component,
        ours: version,
        oursError: err,
        latest: ffLatest ? `n${ffLatest.version}` : null,
        latestError: ffErr,
        released: ffLatest?.date ?? '',
        notes: [
          src && `pin: ${src}`,
          pinNote && `PINNED DELIBERATELY: ${pinNote}`,
          divergence(android.values.ffmpegVersion, ios.values.LIBMPV_FFMPEG_VERSION),
          ffPrevNote,
          'a fresh FFmpeg major can be days old — read the line ages before treating this as urgent',
        ],
      }),
    );
  }

  // ── engine sub-dependencies: mbedTLS, libplacebo, libxml2.
  //
  //    These are not "extras": they are compiled INTO the artifact we ship, so
  //    a CVE in any of them is a CVE in rn-media. Until now only mpv and FFmpeg
  //    were watched, which meant the engine's own TLS stack could go stale in
  //    total silence.
  //
  //    Two things make these rows different from mpv/FFmpeg:
  //      1. They are per-fork build-script choices, so the two platforms CAN
  //         disagree — and today they do. That is what `divergence()` prints.
  //      2. Being behind can be correct (libplacebo 7.x does not build against
  //         mpv 0.41), so, exactly like FFmpeg, each pin file may carry a
  //         free-text rationale that is surfaced verbatim.
  //
  //    The richer source of truth for the engine as a whole is the workshop
  //    repo (afkcodes/rn-media-engine, manifest/engine.json). This watcher
  //    deliberately does NOT read it: it parses the pin files that are actually
  //    in THIS repo, so it reports what rn-media ships rather than what the
  //    workshop intends. It is the safety net, not the manifest.
  for (const sub of /** @type {{ component: string, ours: string|undefined, oursError: string|null, src: string, pinNote: string|undefined, upstream: any, diverge: string, extra?: string }[]} */ ([
    {
      component: 'mbedTLS (Android engine)',
      ours: android.values.mbedtlsVersion,
      oursError: android.error ?? (android.values.mbedtlsVersion ? null : 'no `mbedtlsVersion` in ext.libmpv'),
      src: androidField('mbedtlsVersion'),
      pinNote: android.values.mbedtlsPinNote,
      upstream: mbedtls,
      diverge: divergence(android.values.mbedtlsVersion, ios.values.LIBMPV_MBEDTLS_VERSION),
      extra: 'FFmpeg TLS backend, statically linked into the engine — a CVE here is a CVE in ours',
    },
    {
      component: 'mbedTLS (iOS engine)',
      ours: ios.values.LIBMPV_MBEDTLS_VERSION,
      oursError: ios.error ?? (ios.values.LIBMPV_MBEDTLS_VERSION ? null : 'no LIBMPV_MBEDTLS_VERSION'),
      src: iosField('LIBMPV_MBEDTLS_VERSION'),
      pinNote: ios.values.LIBMPV_MBEDTLS_PIN_NOTE,
      upstream: mbedtls,
      diverge: divergence(android.values.mbedtlsVersion, ios.values.LIBMPV_MBEDTLS_VERSION),
      extra: 'ships as the Mbedcrypto/Mbedtls/Mbedx509 frameworks in the xcframework bundle',
    },
    {
      component: 'libplacebo (Android engine)',
      ours: android.values.libplaceboVersion,
      oursError: android.error ?? (android.values.libplaceboVersion ? null : 'no `libplaceboVersion` in ext.libmpv'),
      src: androidField('libplaceboVersion'),
      pinNote: android.values.libplaceboPinNote,
      upstream: libplacebo,
      diverge: divergence(android.values.libplaceboVersion, ios.values.LIBMPV_LIBPLACEBO_VERSION),
      extra: 'MANDATORY since mpv 0.37 and reached from non-video code, so it cannot be stripped',
    },
    {
      component: 'libplacebo (iOS engine)',
      ours: ios.values.LIBMPV_LIBPLACEBO_VERSION,
      oursError: ios.error ?? (ios.values.LIBMPV_LIBPLACEBO_VERSION ? null : 'no LIBMPV_LIBPLACEBO_VERSION'),
      src: iosField('LIBMPV_LIBPLACEBO_VERSION'),
      pinNote: ios.values.LIBMPV_LIBPLACEBO_PIN_NOTE,
      upstream: libplacebo,
      diverge: divergence(android.values.libplaceboVersion, ios.values.LIBMPV_LIBPLACEBO_VERSION),
      extra: 'static inside Mpv.framework — bumping it does not change the framework count',
    },
    {
      component: 'libxml2 (Android engine)',
      ours: android.values.libxml2Version,
      oursError: android.error ?? (android.values.libxml2Version ? null : 'no `libxml2Version` in ext.libmpv'),
      src: androidField('libxml2Version'),
      pinNote: android.values.libxml2PinNote,
      upstream: libxml2,
      diverge: divergence(android.values.libxml2Version, ios.values.LIBMPV_LIBXML2_VERSION),
      extra: 'was FFmpeg --enable-libxml2, reachable only from the DASH demuxer neither fork enables — dropped in v1.1.9-rnmedia.7; upstream is GNOME GitLab, not GitHub',
    },
    {
      component: 'libxml2 (iOS engine)',
      ours: ios.values.LIBMPV_LIBXML2_VERSION,
      oursError: ios.error ?? (ios.values.LIBMPV_LIBXML2_VERSION ? null : 'no LIBMPV_LIBXML2_VERSION'),
      src: iosField('LIBMPV_LIBXML2_VERSION'),
      pinNote: ios.values.LIBMPV_LIBXML2_PIN_NOTE,
      upstream: libxml2,
      diverge: divergence(android.values.libxml2Version, ios.values.LIBMPV_LIBXML2_VERSION),
      extra: 'was static inside Avformat — dropped from the audio variant in v0.7.2-rnmedia.6; the darwin fork still pins it for the VIDEO variant this repo does not build',
    },
  ])) {
    // A component this platform does not ship gets a ROW, not a skip. The
    // file's row model is "every tracked component is on the table, always" —
    // a component that silently disappears from the output reads as a watcher
    // bug, and the whole point of `none` being a value is that absence is
    // stated rather than inferred. 'info' is the status the context rows
    // already use and is excluded from the behind/unknown tallies by
    // construction, so this can never open or hold open the tracking issue.
    // The divergence note is still emitted: if the OTHER platform ships it,
    // that is precisely the parity finding this table exists to surface.
    if (isNotShipped(sub.ours)) {
      rows.push({
        component: sub.component,
        ours: 'not shipped',
        latest: '—',
        released: '—',
        status: 'info',
        notes: [
          sub.src && `pin: ${sub.src}`,
          'NOT SHIPPED: the pin records this component as absent from the artifact, so there is nothing to compare and no upstream lookup is made',
          sub.diverge,
          sub.extra,
        ]
          .filter(Boolean)
          .join('; '),
        unknownReason: null,
      });
      continue;
    }
    const up = sub.upstream;
    const line = 'error' in up ? null : up.line;
    rows.push(
      compareRow({
        component: sub.component,
        ours: sub.ours,
        oursError: sub.oursError,
        latest: 'error' in up ? null : up.version,
        latestError: 'error' in up ? up.error : null,
        released: 'error' in up ? '' : up.date,
        notes: [
          sub.src && `pin: ${sub.src}`,
          sub.pinNote && `PINNED DELIBERATELY: ${sub.pinNote}`,
          sub.diverge,
          // An LTS/maintenance branch is a real answer to "are we behind":
          // mbedTLS 3.6 is maintained while 4.x is a new API generation.
          line ? `newest on our own ${String(sub.ours ?? '').split('.')[0]}.x line: ${line.version}${line.date ? ` (${line.date})` : ''}` : '',
          sub.extra,
        ],
      }),
    );
  }

  // ── media3
  rows.push(
    compareRow({
      component: 'androidx.media3',
      ours: media3Pin.version,
      oursError: media3Pin.error,
      latest: 'error' in media3 ? null : media3.version,
      latestError: 'error' in media3 ? media3.error : null,
      released: 'error' in media3 ? '' : media3.date,
      notes: [
        media3Pin.version && `pin: ${rel(media3Pin.file)}${media3Pin.line ? `:${media3Pin.line}` : ''}`,
        'Google Maven <release>; date is the metadata lastUpdated',
      ],
    }),
  );

  // ── the Nitro pair (moves as ONE unit: nitrogen generates against a runtime)
  for (const [component, pin, latest] of /** @type {[string, ReturnType<typeof collapseNpmPin>, any][]} */ ([
    ['react-native-nitro-modules', nitroRuntime, nitroRuntimeLatest],
    ['nitrogen', nitrogen, nitrogenLatest],
  ])) {
    rows.push(
      compareRow({
        component,
        ours: pin.version,
        oursError: pin.error,
        latest: latest.version,
        latestError: latest.error,
        notes: [
          pin.sources.length ? `pin: ${pin.sources.map((s) => `${rel(s.file)}${s.line ? `:${s.line}` : ''}`).join(', ')}` : '',
          pin.distinct.length > 1 ? `DIVERGENT across packages: ${pin.distinct.join(', ')}` : '',
          'the Nitro pair is bumped together, with codegen re-run',
        ],
      }),
    );
  }

  // ── tested RN
  rows.push(
    compareRow({
      component: 'react-native (tested)',
      ours: rn.version,
      oursError: rn.error,
      latest: rnLatest.version,
      latestError: rnLatest.error,
      notes: [
        rn.sources.length ? `pin: ${rn.sources.map((s) => `${rel(s.file)}${s.line ? `:${s.line}` : ''}`).join(', ')}` : '',
        rn.distinct.length > 1 ? `DIVERGENT across packages: ${rn.distinct.join(', ')}` : '',
        'peerDependencies floors are excluded — those are floors, not pins',
      ],
    }),
  );

  // ── context rows: never counted as drift. Our fork tags are ours and do not
  //    map onto an upstream version; what they are useful for is showing which
  //    upstream build-script release our fork is rebased onto.
  /** @type {Row[]} */
  const context = [
    {
      component: 'fork: libmpv-android-audio-build',
      ours: `${android.values.owner ?? '?'} @ ${android.values.release ?? '?'}`,
      latest: 'error' in androidBase ? 'unknown' : `media-kit @ ${androidBase.version}`,
      released: 'error' in androidBase ? '' : androidBase.date,
      status: 'info',
      notes: ['error' in androidBase ? `upstream lookup failed: ${androidBase.error}` : 'our tag is `<upstream>-rnmedia.N`; rebase target for an engine bump'].filter(Boolean).join('; '),
    },
    {
      component: 'fork: libmpv-darwin-build',
      ours: `${(ios.values.LIBMPV_DARWIN_BUILD_REPO ?? '?').split('/')[0]} @ ${ios.values.LIBMPV_DARWIN_BUILD_TAG ?? '?'}`,
      latest: 'error' in iosBase ? 'unknown' : `media-kit @ ${iosBase.version}`,
      released: 'error' in iosBase ? '' : iosBase.date,
      status: 'info',
      notes: ['error' in iosBase ? `upstream lookup failed: ${iosBase.error}` : 'the fork\'s ffmpeg configure flags must survive any rebase'].filter(Boolean).join('; '),
    },
  ];

  return {
    rows,
    context,
    behind: rows.filter((r) => r.status === 'behind').length,
    unknown: rows.filter((r) => r.status === 'unknown').length,
    // A pin we cannot READ is a repo problem that deserves the tracking issue.
    // A source we cannot REACH is (usually) an outage: it must never be allowed
    // to read as "current" and must never close the issue, but it should not
    // open one either, or every GitHub hiccup files a bug.
    unreadablePins: rows.filter((r) => r.unknownReason === 'pin').length,
    upstreamFailures: rows.filter((r) => r.unknownReason === 'upstream').length,
    generatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_TEXT = {
  behind: 'BEHIND',
  current: 'current',
  ahead: 'ahead',
  unknown: 'unknown',
  info: 'info',
};
const STATUS_MD = {
  behind: '🔴 behind',
  current: '🟢 current',
  ahead: '🔵 ahead',
  unknown: '⚪ unknown',
  info: 'ℹ️ info',
};

/**
 * The one sentence that has to be honest: "all current" is only ever said when
 * every tracked row actually resolved.
 * @param {Awaited<ReturnType<typeof collect>>} result
 */
function summaryLine(result) {
  const tail = [
    result.unreadablePins ? `${result.unreadablePins} pin${result.unreadablePins === 1 ? '' : 's'} unreadable` : '',
    result.upstreamFailures ? `${result.upstreamFailures} upstream lookup${result.upstreamFailures === 1 ? '' : 's'} failed` : '',
  ].filter(Boolean);
  if (result.behind > 0) {
    return `${result.behind} pin${result.behind === 1 ? '' : 's'} behind upstream${tail.length ? ` (${tail.join(', ')})` : ''}.`;
  }
  if (tail.length) return `No drift found, but currency is UNVERIFIED: ${tail.join(', ')}.`;
  return 'All tracked pins are current.';
}

/** @param {Awaited<ReturnType<typeof collect>>} result */
function issueTitle(result) {
  const base = `${ISSUE_TITLE_PREFIX} ${result.behind} pin${result.behind === 1 ? '' : 's'} behind`;
  return result.unreadablePins ? `${base}, ${result.unreadablePins} unverifiable` : base;
}

/** @param {string[][]} rows */
function asciiTable(rows) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => [...(r[c] ?? '')].length)));
  const line = (/** @type {string} */ l, /** @type {string} */ m, /** @type {string} */ r) =>
    l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const fmt = (/** @type {string[]} */ r) =>
    '│ ' + r.map((c, i) => (c ?? '').padEnd(widths[i])).join(' │ ') + ' │';
  return [line('┌', '┬', '┐'), fmt(rows[0]), line('├', '┼', '┤'), ...rows.slice(1).map(fmt), line('└', '┴', '┘')].join('\n');
}

/** @param {Awaited<ReturnType<typeof collect>>} result */
function renderConsole(result) {
  const head = ['Component', 'Ours', 'Latest', 'Released', 'Status'];
  const body = [...result.rows, ...result.context].map((r) => [r.component, r.ours, r.latest, r.released, STATUS_TEXT[r.status]]);
  const out = [asciiTable([head, ...body]), ''];
  const withNotes = [...result.rows, ...result.context].filter((r) => r.notes);
  if (withNotes.length) {
    out.push('Notes:');
    for (const r of withNotes) out.push(`  ${r.component}: ${r.notes}`);
    out.push('');
  }
  out.push(summaryLine(result));
  return out.join('\n');
}

/** @param {Awaited<ReturnType<typeof collect>>} result */
function renderIssueBody(result) {
  const md = (/** @type {Row[]} */ rows) =>
    [
      '| Component | Ours | Latest | Released | Status | Notes |',
      '| --- | --- | --- | --- | --- | --- |',
      ...rows.map(
        (r) =>
          `| ${r.component} | \`${r.ours}\` | \`${r.latest}\` | ${r.released || '—'} | ${STATUS_MD[r.status]} | ${r.notes || '—'} |`,
      ),
    ].join('\n');

  return [
    BODY_MARKER,
    `**${summaryLine(result)}**`,
    '',
    'Per CLAUDE.md → Dependency policy → **Currency rule**: engine pieces, media3, the Nitro pair and',
    'the tested RN version track latest stable — *evaluate within two weeks of an upstream stable',
    'release, ship after the full verification playbook*. This watcher only surfaces drift; it never',
    'bumps anything and never opens a PR.',
    '',
    '## Tracked pins',
    '',
    md(result.rows),
    '',
    '## Context (never counted as drift)',
    '',
    'Our libmpv fork tags are *ours* — `<upstream>-rnmedia.N` — and do not map onto an upstream version.',
    'What is compared above is the mpv/FFmpeg version **embedded in the binaries**, recorded as metadata',
    'in the pin files. These rows show which upstream build-script release the forks are rebased onto.',
    '',
    md(result.context),
    '',
    '---',
    '',
    '<sub>Regenerated on every run of `.github/workflows/upstream-currency.yml`',
    `(\`node scripts/check-upstream.mjs --github\`). Edits are overwritten. Last run: ${result.generatedAt}.</sub>`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub issue upkeep — exactly ONE issue, found by label, idempotent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} repo
 * @param {Awaited<ReturnType<typeof collect>>} result
 * @param {{ dryRun?: boolean }} [opt] `dryRun` performs the reads (auth, label
 *   lookup, issue search) and prints the write it would have made — enough to
 *   validate the whole path without touching the repo.
 */
async function maintainIssue(repo, result, opt = {}) {
  const dry = opt.dryRun === true;
  /** @param {string} what @param {() => Promise<any>} run */
  const write = async (what, run) => {
    if (dry) {
      console.log(`[dry-run] would ${what}`);
      return { ok: true, data: { number: 0 } };
    }
    return run();
  };
  if (!TOKEN) throw new Error('--github requires GH_TOKEN or GITHUB_TOKEN');
  const title = issueTitle(result);
  const body = renderIssueBody(result);

  // The three-way decision. `behind === 0` on its own is NOT grounds to close:
  // if every upstream source were unreachable, every row would be 'unknown',
  // drift would count zero, and closing the issue would report a green that was
  // never measured.
  const wantsIssue = result.behind > 0 || result.unreadablePins > 0;
  const canDeclareGreen = result.unknown === 0;

  // 1. Ensure the label exists. 404 → create it; anything else is fatal,
  //    because silently proceeding would create an unlabelled issue that the
  //    next run cannot find, and "exactly one issue" would break.
  const label = await gh(`/repos/${repo}/labels/${ISSUE_LABEL}`);
  if (!label.ok) {
    if (label.status === 404) {
      const created = await write(`create label \`${ISSUE_LABEL}\``, () =>
        gh(`/repos/${repo}/labels`, {
          method: 'POST',
          body: { name: ISSUE_LABEL, color: 'd93f0b', description: 'A pinned dependency lags upstream latest stable (CLAUDE.md currency rule)' },
        }),
      );
      if (!created.ok) throw new Error(`could not create label ${ISSUE_LABEL}: ${created.error}`);
      if (!dry) console.log(`Created label \`${ISSUE_LABEL}\`.`);
    } else {
      throw new Error(`could not read label ${ISSUE_LABEL}: ${label.error}`);
    }
  }

  // 2. Find the one issue. Open first; a closed one is reused (reopened)
  //    rather than replaced, so drift that comes back does not spawn issue #2.
  const openList = await gh(`/repos/${repo}/issues?labels=${ISSUE_LABEL}&state=open&per_page=100`);
  if (!openList.ok) throw new Error(`could not list issues: ${openList.error}`);
  const open = (openList.data ?? []).filter((/** @type {any} */ i) => !i.pull_request);
  if (open.length > 1) {
    console.warn(`WARNING: ${open.length} open \`${ISSUE_LABEL}\` issues — using #${open[0].number}, close the rest by hand.`);
  }

  if (!wantsIssue && !canDeclareGreen) {
    // Nothing measured as behind, but something did not resolve. Leave whatever
    // state the issue is in untouched and make the run's log say why.
    console.warn(`Currency UNVERIFIED this run (${result.upstreamFailures} upstream lookup(s) failed) — leaving the tracking issue untouched.`);
    return { action: 'skipped-unverified' };
  }

  if (!wantsIssue) {
    if (open.length === 0) {
      console.log('No drift and no open issue — nothing to do.');
      return { action: 'noop' };
    }
    for (const issue of open) {
      const closed = await write(`comment on and close #${issue.number} (no drift)`, async () => {
        await gh(`/repos/${repo}/issues/${issue.number}/comments`, {
          method: 'POST',
          body: { body: `${BODY_MARKER}\nAll tracked pins are current as of ${result.generatedAt}. Closing; this issue is reopened automatically if drift returns.` },
        });
        return gh(`/repos/${repo}/issues/${issue.number}`, {
          method: 'PATCH',
          body: { title, body, state: 'closed', state_reason: 'completed' },
        });
      });
      if (!closed.ok) throw new Error(`could not close issue #${issue.number}: ${closed.error}`);
      if (!dry) console.log(`Closed #${issue.number} (no drift).`);
    }
    return { action: 'closed' };
  }

  const target =
    open[0] ??
    (await (async () => {
      const closedList = await gh(`/repos/${repo}/issues?labels=${ISSUE_LABEL}&state=closed&sort=updated&direction=desc&per_page=20`);
      if (!closedList.ok) return null;
      return (closedList.data ?? []).find(
        (/** @type {any} */ i) => !i.pull_request && String(i.title).startsWith(ISSUE_TITLE_PREFIX) && String(i.body ?? '').includes(BODY_MARKER),
      );
    })());

  if (!target) {
    const created = await write(`create issue "${title}" labelled \`${ISSUE_LABEL}\``, () =>
      gh(`/repos/${repo}/issues`, { method: 'POST', body: { title, body, labels: [ISSUE_LABEL] } }),
    );
    if (!created.ok) throw new Error(`could not create issue: ${created.error}`);
    if (!dry) console.log(`Created #${created.data.number}: ${title}`);
    return { action: 'created', number: created.data.number };
  }

  // Skip the write when nothing changed except the timestamp — an unchanged
  // table should not notify subscribers every week. Note the ISO timestamp
  // contains dots (milliseconds), so this has to match the whole stamp, not
  // "up to the next period".
  const stripStamp = (/** @type {string} */ b) => String(b ?? '').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ts>');
  if (target.state === 'open' && target.title === title && stripStamp(target.body) === stripStamp(body)) {
    console.log(`#${target.number} already up to date (${title}).`);
    return { action: 'unchanged', number: target.number };
  }

  const patched = await write(`${target.state === 'closed' ? 'reopen' : 'update'} #${target.number} as "${title}"`, () =>
    gh(`/repos/${repo}/issues/${target.number}`, { method: 'PATCH', body: { title, body, state: 'open' } }),
  );
  if (!patched.ok) throw new Error(`could not update issue #${target.number}: ${patched.error}`);
  if (!dry) console.log(`${target.state === 'closed' ? 'Reopened' : 'Updated'} #${target.number}: ${title}`);
  return { action: target.state === 'closed' ? 'reopened' : 'updated', number: target.number };
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = new Set(process.argv.slice(2));
  const result = await collect();

  if (args.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderConsole(result));
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Upstream currency\n\n${renderIssueBody(result)}\n`);
  }

  if (args.has('--github') || args.has('--dry-run')) {
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo) throw new Error('--github requires GITHUB_REPOSITORY (owner/repo)');
    await maintainIssue(repo, result, { dryRun: args.has('--dry-run') });
  }

  // A watcher that can never watch has to be loud. A partial outage is a
  // warning (the surviving rows still measured something); every single row
  // failing upstream means either the internet is gone or an API we parse
  // changed shape, and both need a human.
  // "Every row that could have been compared failed" — not "every row",
  // because a row whose pin is unreadable never reaches an upstream lookup and
  // would otherwise make this condition unreachable.
  const comparable = result.rows.length - result.unreadablePins;
  if (comparable > 0 && result.upstreamFailures === comparable) {
    console.error('check-upstream: EVERY upstream lookup failed — nothing was measured this run.');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`check-upstream: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
