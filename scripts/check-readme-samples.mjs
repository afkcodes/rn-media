#!/usr/bin/env node
// @ts-check
/**
 * README sample typechecker — CLAUDE.md, the mission line:
 *
 *   "ease-of-use is a deliverable (zero-config defaults, hooks, typed
 *    everything, docs whose samples typecheck)"
 *
 * This is the thing that makes the last clause true. It extracts every ```ts /
 * ```tsx fenced block out of every shipped README and recipe, writes each one to
 * `.readme-samples/` as a standalone module, and runs `tsc --noEmit` over them
 * with `@afkcodes/timbre-*` mapped at the workspace packages' `src` — the real export
 * surface, not a stale `lib/` build. A sample that drifts from the code is then
 * a build error with a README line number on it.
 *
 * Usage:
 *   node scripts/check-readme-samples.mjs           # extract + typecheck
 *   node scripts/check-readme-samples.mjs --list    # what would be checked
 *   node scripts/check-readme-samples.mjs --keep    # leave .readme-samples/ in
 *                                                   # place on success (it is
 *                                                   # kept on failure anyway)
 *
 * Design notes:
 *   - Plain Node 22, zero dependencies, in the style of check-upstream.mjs, so
 *     it runs locally exactly as it runs in CI.
 *   - Errors are reported at `README.md:LINE`, never at the generated file: the
 *     generated file is a build artifact nobody should have to read. The
 *     mapping is exact because a block is copied verbatim and the one-line
 *     prelude is the only thing added above it.
 *   - **One project per file.** The `declare`s a file's prose earns are global
 *     to its project, and two files may legitimately introduce the same name
 *     (`tracks`, `player`) with different shapes. Separate projects keep those
 *     from colliding, and give the per-file block counts the report prints.
 *   - A block is a MODULE. If it declares no import/export of its own the
 *     harness appends `export {}` — the only edit ever made to sample text, and
 *     it changes no line numbering.
 *   - `AMBIENTS` is the whole allowance for identifiers the prose introduces
 *     but the block does not (`station`, `catalogue`, the `player` an earlier
 *     block created). It is deliberately small, per-README, and **typed** —
 *     nothing here is `any`, so a sample cannot pass by accident. A sample that
 *     needs more than a handful is a sample that should declare them itself,
 *     which is why `docs/recipes/` leans on one shared back end and nothing
 *     else: those samples are whole programs by contract.
 *   - `MODULES` is the same allowance for a *file* the prose names — `./library`
 *     in a recipe that opens `// src/playback.ts`. Written as a real source
 *     file next to the sample, so the import resolves the way the reader's
 *     would.
 *   - The check is never loosened to make a sample pass. The only compiler
 *     options that differ from the packages' own tsconfig are
 *     `noUnusedLocals`/`noUnusedParameters`, off because a README names things
 *     for the reader ("`const back = () => player.seekBy(-15)`") and an unused
 *     binding is not a type error. `strict` and `noUncheckedIndexedAccess` are
 *     the packages' own.
 *   - ```ts fragment (and ```tsx fragment) marks a block that is deliberately
 *     partial — an options object quoted on its own — and is skipped. Used
 *     sparingly; `--list` and the summary both print how many, so the count
 *     stays honest.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(REPO_ROOT, '.readme-samples');

// The generated tree is deleted and rewritten on every run, so pin it inside
// the repo before anything can point it elsewhere.
if (!resolve(OUT_DIR).startsWith(resolve(REPO_ROOT))) {
  throw new Error('refusing to operate outside the repo');
}

/** A package this repo documents but does not depend on. */
const ASYNC_STORAGE = `
declare module '@react-native-async-storage/async-storage' {
  const AsyncStorage: {
    getItem(key: string): Promise<string | null>
    setItem(key: string, value: string): Promise<void>
  }
  export default AsyncStorage
}
`;

/**
 * The catalogue / back end the `docs/recipes/` samples are written *against*.
 * Shared by every recipe project, because they document one imagined app.
 */
const RECIPE_BACKEND = `
declare const service: import('@afkcodes/timbre-media-session').MediaServiceApi
declare const station: { id: string; name: string; url: string; logoUri: string }
declare const episode: { id: string; url: string }
declare const progress: {
  get(id: string): number | undefined
  set(id: string, position: number): void
  delete(id: string): void
}
declare const server: string
declare const token: string
declare const auth: { isSignedIn(): Promise<boolean> }
declare const catalogue: {
  albums(): Promise<{ id: string; title: string; artist: string; coverUrl: string }[]>
  tracks(albumId: string): Promise<CatalogueTrack[]>
  track(id: string): Promise<CatalogueTrack>
  recent(limit: number): Promise<CatalogueTrack[]>
  search(query: string, focus?: import('@afkcodes/timbre-media-session').SearchFocus): Promise<CatalogueTrack[]>
}
interface CatalogueTrack {
  id: string
  title: string
  artist: string
  coverUrl: string
  streamUrl: string
  explicit?: boolean
}
declare const downloads: { on(event: 'complete', fn: () => void): void }
declare function banner(message: string): void
declare function badge(text: string | number): void
declare function clearBadge(): void
declare function showRetry(message: string): void
declare function setChapterUi(index: number | undefined): void
declare function setStationLine(
  name: string | undefined,
  genre: string | undefined,
  bitrate: string | undefined
): void
declare function Bar(): import('react').JSX.Element
`;

/**
 * Identifiers the prose around a block introduces. Global to that file's
 * project only; a block that binds the same name shadows this at module scope,
 * which is exactly what should happen.
 *
 * @type {Record<string, string>}
 */
const AMBIENTS = {
  // The root README's one quick start is a whole program; it needs nothing
  // beyond the `./library` module its own first lines import.
  root: '',
  'recipe-music-player': RECIPE_BACKEND,
  'recipe-radio': RECIPE_BACKEND,
  'recipe-podcast-audiobook': RECIPE_BACKEND,
  'recipe-self-hosted-library': RECIPE_BACKEND,
  'recipe-in-the-car': RECIPE_BACKEND,
  'recipe-cast': RECIPE_BACKEND,
  // `player` is the one created by the "Usage" block at the top of the file;
  // every later block in this README continues from it, and saying so once
  // beats repeating six lines of setup in every snippet.
  player: `
declare const player: import('@afkcodes/timbre-player').Player
declare const sources: readonly string[]
declare const uri: string
declare const curve: import('@afkcodes/timbre-player').EqualizerPreset
declare const myTracks: readonly { uri: string; title: string }[]
declare const api: { signPlaybackUrl(id: string): Promise<{ url: string }> }
declare function paint(bands: Float32Array): void
declare function refreshQueueUi(): void
declare function updateNowPlaying(
  metadata: import('@afkcodes/timbre-player').Metadata
): void
declare function setStation(name: string | undefined): void
declare function showBanner(text: string): void
declare function Chip(props: {
  label: string
  active?: boolean
  onPress: () => void
}): import('react').JSX.Element
declare function Slider(props: {
  value: number
  minimumValue: number
  maximumValue: number
  onValueChange?: (value: number) => void
  onSlidingComplete?: (value: number) => void
}): import('react').JSX.Element
${ASYNC_STORAGE}`,
  // Same idea: this README is written about a `service` and a `player` the
  // opening block created.
  'media-session': `
declare const service: import('@afkcodes/timbre-media-session').PersistedMediaService
declare const storage: import('@afkcodes/timbre-media-session').MediaSessionStorage
declare const config: import('@afkcodes/timbre-media-session').MediaServiceConfig
declare const player: {
  play(): Promise<void>
  pause(): Promise<void>
  release(): Promise<void>
  seek(position: number): Promise<void>
  load(id: string): Promise<void>
  rate: number
}
declare const backend: {
  setVolume(volume: number): Promise<void>
  setMuted(muted: boolean): Promise<void>
}
declare const items: readonly import('@afkcodes/timbre-media-session').MediaItem[]
declare const tracks: readonly { id: string; title: string }[]
declare const catalogue: {
  albums(): Promise<{ id: string; title: string; artist: string }[]>
  tracks(parentId: string): Promise<{ id: string; title: string; artist: string }[]>
  search(query: string): Promise<{ id: string; title: string; artist: string }[]>
}
declare const auth: { isSignedIn(): Promise<boolean> }
declare const MyHandler: new () => import('@afkcodes/timbre-media-session').MediaHandler
declare function loadChildren(
  parentId: string
): Promise<import('@afkcodes/timbre-media-session').BrowseItem[]>
declare function track(event: string): void
declare function banner(message: string): void
declare function badge(text: string | number): void
${ASYNC_STORAGE}`,
  'audio-session': `
declare const player: import('@afkcodes/timbre-player').Player
`,
  cast: `
declare const player: import('@afkcodes/timbre-player').Player
declare const queue: readonly {
  id: string
  mimeType: string
  title: string
  artist: string
  artUrl: string
}[]
declare const currentIndex: number
declare const tracks: readonly {
  streamUrl: string
  title: string
  artist: string
  artUrl: string
}[]
declare const url: string
declare const mimeType: string
declare const headers: Record<string, string>
declare function resolve(track: { id: string }): string
declare function broadcastReceiverState(
  snapshot: import('@afkcodes/timbre-cast').CastReceiverSnapshot
): void
declare function log(direction: 'toCast' | 'toLocal'): void
declare function showSkipNotice(
  skipped: readonly import('@afkcodes/timbre-cast').SkippedCastItem[]
): void
declare function refreshSignedUrls(): Promise<void>
`,
};

/**
 * Files a README's prose names by path. Written next to the samples so the
 * import resolves exactly as the reader's would.
 *
 * @type {Record<string, Record<string, string>>}
 */
const LIBRARY_MODULE = `
export interface Track {
  id: string
  title: string
  artist: string
  album: string
  artworkUri: string
  durationMs: number
  url: string
}
export const storage = {
  getItem: (_key: string): Promise<string | null> => Promise.resolve(null),
  setItem: (_key: string, _value: string): Promise<void> => Promise.resolve(),
}
`;

const UI_MODULE = `
export declare function Slider(props: {
  value: number
  minimumValue: number
  maximumValue: number
  onSlidingComplete: (value: number) => void
}): import('react').JSX.Element
`;

const MODULES = {
  root: { 'library.ts': LIBRARY_MODULE },
  'recipe-music-player': { 'library.ts': LIBRARY_MODULE, 'ui.ts': UI_MODULE },
};

/** Every shipped doc that carries samples, in the order the report prints them. */
const READMES = [
  { slug: 'root', file: 'README.md' },
  { slug: 'player', file: 'packages/player/README.md' },
  { slug: 'media-session', file: 'packages/media-session/README.md' },
  { slug: 'audio-session', file: 'packages/audio-session/README.md' },
  { slug: 'cast', file: 'packages/cast/README.md' },
  { slug: 'recipe-music-player', file: 'docs/recipes/music-player.md' },
  { slug: 'recipe-radio', file: 'docs/recipes/radio.md' },
  { slug: 'recipe-podcast-audiobook', file: 'docs/recipes/podcast-audiobook.md' },
  { slug: 'recipe-self-hosted-library', file: 'docs/recipes/self-hosted-library.md' },
  { slug: 'recipe-in-the-car', file: 'docs/recipes/in-the-car.md' },
  { slug: 'recipe-cast', file: 'docs/recipes/cast.md' },
];

/** `@afkcodes/timbre-*` resolves to the workspace source, never to a built `lib/`. */
const PATHS = {
  '@afkcodes/timbre-player': ['../../packages/player/src'],
  '@afkcodes/timbre-audio-session': ['../../packages/audio-session/src'],
  '@afkcodes/timbre-media-session': ['../../packages/media-session/src'],
  '@afkcodes/timbre-cast': ['../../packages/cast/src'],
};

/**
 * @typedef {object} Block
 * @property {string} slug
 * @property {string} file       README path, repo-relative
 * @property {number} startLine  1-based line of the block's first CODE line
 * @property {'ts'|'tsx'} lang
 * @property {boolean} fragment
 * @property {string} code
 * @property {string} out        generated file, repo-relative
 */

/**
 * Pull every fenced code block out of one README.
 *
 * Only fences at column 0 are considered. An indented fence is a snippet inside
 * a list item — prose, not a sample — and the two READMEs that use one say so
 * by indenting it.
 *
 * @param {string} slug
 * @param {string} file
 * @returns {Block[]}
 */
function extract(slug, file) {
  const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n');
  /** @type {Block[]} */
  const blocks = [];
  let index = 0;

  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\S+)(?:\s+(\S+))?\s*$/.exec(lines[i] ?? '');
    if (!open) continue;

    let end = i + 1;
    while (end < lines.length && lines[end] !== '```') end++;

    const lang = open[1];
    if (lang === 'ts' || lang === 'tsx') {
      index++;
      blocks.push({
        slug,
        file,
        startLine: i + 2,
        lang,
        fragment: open[2] === 'fragment',
        code: lines.slice(i + 1, end).join('\n'),
        out: join('.readme-samples', slug, `${String(index).padStart(2, '0')}.${lang}`),
      });
    }

    i = end;
  }

  return blocks;
}

/**
 * A block becomes a module. Top-level `await` needs one, and module scope is
 * what lets a sample's own `const player` shadow the ambient of the same name.
 *
 * @param {Block} block
 * @returns {string}
 */
function render(block) {
  const isModule = /^\s*(?:import|export)\b/m.test(block.code);
  // One line, so every line below it still matches the README.
  const prelude = `// ${block.file}:${block.startLine} — generated by scripts/check-readme-samples.mjs; do not edit`;
  return `${prelude}\n${block.code}${isModule ? '' : '\nexport {}\n'}`;
}

/** @param {Block[]} blocks */
function writeProjects(blocks) {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  // The generated tree is a build artifact. Keeping the ignore next to it means
  // no repo-root .gitignore edit can strand it.
  writeFileSync(join(OUT_DIR, '.gitignore'), '*\n');

  const compilerOptions = {
    // The packages' own strictness, minus the two rules that police unused
    // bindings: a README names things for the reader.
    strict: true,
    noUncheckedIndexedAccess: true,
    noFallthroughCasesInSwitch: true,
    noImplicitReturns: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
    allowUnreachableCode: false,
    allowUnusedLabels: false,
    noEmit: true,
    // `isolatedModules` from the base config forbids a sample's top-level
    // `await`; a README block is a program, not a module a bundler must split.
    isolatedModules: false,
    jsx: 'react-jsx',
    module: 'esnext',
    moduleResolution: 'bundler',
    target: 'esnext',
    types: [],
    skipLibCheck: true,
    paths: PATHS,
  };

  for (const readme of READMES) {
    const dir = join(OUT_DIR, readme.slug);
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      join(dir, '__ambients.d.ts'),
      `// Identifiers ${readme.file}'s prose introduces.\n` +
        `// See AMBIENTS in scripts/check-readme-samples.mjs.\n` +
        `${(AMBIENTS[readme.slug] ?? '').trimStart()}`
    );

    for (const [name, source] of Object.entries(MODULES[readme.slug] ?? {})) {
      writeFileSync(join(dir, name), source.trimStart());
    }

    writeFileSync(
      join(dir, 'tsconfig.json'),
      `${JSON.stringify(
        {
          extends: '@react-native/typescript-config',
          compilerOptions,
          include: ['**/*.ts', '**/*.tsx'],
        },
        null,
        2
      )}\n`
    );
  }

  for (const block of blocks) {
    if (block.fragment) continue;
    writeFileSync(join(REPO_ROOT, block.out), render(block));
  }
}

/**
 * Map a diagnostic on a generated file back to the README line it came from.
 *
 * @param {Block[]} blocks
 * @param {string} output
 * @returns {string}
 */
function remap(blocks, output) {
  /** @type {Map<string, Block>} */
  const byOut = new Map(blocks.map((b) => [b.out.replace(/\\/g, '/'), b]));

  return output.replace(
    /(^|\s)([^\s(]*\.readme-samples\/[^\s(]+?)\((\d+),(\d+)\)/gm,
    (match, lead, file, line, column) => {
      const key = file.replace(/\\/g, '/').replace(/^.*?\.readme-samples\//, '.readme-samples/');
      const block = byOut.get(key);
      if (!block) return match;
      // -1 for the one-line prelude; the block's text is otherwise verbatim.
      return `${lead}${block.file}(${block.startLine + Number(line) - 2},${column})`;
    }
  );
}

/** The repo is written in TypeScript 7; the root pin is a 6.x for ESLint only. */
function resolveTsc() {
  const candidates = [
    'apps/example/node_modules/typescript/bin/tsc',
    'packages/player/node_modules/typescript/bin/tsc',
    'node_modules/typescript/bin/tsc',
  ].map((c) => join(REPO_ROOT, c));
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error('no typescript found — run `npm install` first');
  return found;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const blocks = READMES.flatMap((r) => extract(r.slug, r.file));

  if (args.has('--list')) {
    for (const b of blocks) {
      console.log(
        `${b.file}:${b.startLine}\t${b.lang}${b.fragment ? ' fragment (skipped)' : ''}\t→ ${b.out}`
      );
    }
    return;
  }

  writeProjects(blocks);

  const tsc = resolveTsc();
  let failed = false;
  for (const readme of READMES) {
    try {
      execFileSync(process.execPath, [tsc, '--noEmit', '-p', `.readme-samples/${readme.slug}`], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (error) {
      failed = true;
      const e = /** @type {{stdout?: string, stderr?: string}} */ (error);
      console.error(remap(blocks, `${e.stdout ?? ''}${e.stderr ?? ''}`).trimEnd());
    }
  }

  console.log('');
  for (const readme of READMES) {
    const mine = blocks.filter((b) => b.slug === readme.slug);
    const skipped = mine.filter((b) => b.fragment).length;
    console.log(
      `  ${readme.file.padEnd(38)} ${String(mine.length - skipped).padStart(2)} blocks` +
        (skipped > 0 ? `  (+${skipped} fragment, skipped)` : '')
    );
  }
  const checked = blocks.filter((b) => !b.fragment).length;
  console.log(`\ncheck-readme-samples: ${checked} blocks, ${failed ? 'FAILED' : '0 errors'}\n`);

  if (failed) {
    console.error(`generated sources kept in ${relative(REPO_ROOT, OUT_DIR)}/ for inspection`);
    process.exitCode = 1;
  } else if (!args.has('--keep')) {
    rmSync(OUT_DIR, { recursive: true, force: true });
  }
}

try {
  main();
} catch (e) {
  console.error(`check-readme-samples: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
