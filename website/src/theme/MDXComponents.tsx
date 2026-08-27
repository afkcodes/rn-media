import MDXComponents from '@theme-original/MDXComponents'

import {
  Constraint,
  Install,
  NpmScope,
  Pkg,
  ProjectName,
  RepoFile,
  RepoLink,
} from '../components/Project'

/**
 * Register the name components globally so every MDX page can write
 * `<ProjectName />` / `<Pkg name="player" />` without an import — and so no page
 * ever hardcodes the name.
 */
export default {
  ...MDXComponents,
  ProjectName,
  NpmScope,
  Pkg,
  Install,
  RepoLink,
  RepoFile,
  Constraint,
}
