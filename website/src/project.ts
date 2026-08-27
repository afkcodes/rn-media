/**
 * The ONE place the project's identity lives.
 *
 * The npm scope is still the `@timbre/*` placeholder (CLAUDE.md: the final
 * name is a pending decision and the rename must stay a one-file edit). Every
 * name reference on the site — nav title, footer, install commands, prose —
 * resolves from this object, either directly (`docusaurus.config.ts` spreads it
 * in) or through the shared MDX components in `src/components/Project.tsx`. No
 * page hardcodes the name; grep proves it.
 *
 * To rebrand: edit this file. Nothing else in `docs/` or `src/pages/` mentions
 * the name.
 */
export const PROJECT = {
  /** Display name, used in the navbar, titles and prose. */
  name: 'timbre',
  /** One sentence. The whole pitch. */
  tagline: 'One audio engine for React Native — the same libmpv core on iOS and Android.',
  /** npm scope for the four packages (placeholder until the rename). */
  scope: '@timbre',
  /** The four published packages, in dependency-neutral order. */
  packages: ['player', 'audio-session', 'media-session', 'cast'] as const,
  /** GitHub org/user. */
  org: 'afkcodes',
  /** GitHub repo name. */
  repo: 'rn-media',
  /** Full repository URL. */
  repoUrl: 'https://github.com/afkcodes/rn-media',
  /**
   * The future documentation domain. Not yet public (spec §6, name gate); the
   * GitHub Pages URL below is what CI builds against until then.
   */
  futureDomain: 'https://timbre.afk.codes',
  /** GitHub Pages origin + base, used until the domain is chosen. */
  pagesUrl: 'https://afkcodes.github.io',
  pagesBaseUrl: '/rn-media/',
} as const

/** `@timbre/player`, `@timbre/media-session`, … from a bare package name. */
export const pkg = (name: string): string => `${PROJECT.scope}/${name}`
