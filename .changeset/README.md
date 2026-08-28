# Changesets

This folder is the release engine. Every change that should reach npm carries a
**changeset**: a small markdown file that names which packages moved and by how
much (patch / minor / major), plus a line for the changelog.

## Adding one (do this in your PR)

```sh
npm run changeset
```

Pick the packages you touched, pick the bump, write one human sentence. It
writes a file under `.changeset/` — commit it with your change. A PR that
touches a published package but adds no changeset is a PR that ships nothing.

Skip it only for changes that never reach a user: the example app, docs, CI,
tests. When in doubt, add one.

## What happens next (automated)

On merge to `main`, the release workflow opens a **"Version Packages"** PR that
consumes every pending changeset — bumping versions and writing each package's
`CHANGELOG.md`. Merging *that* PR publishes the changed packages to npm and cuts
the matching GitHub releases + git tags. Nothing publishes from a human laptop.

Versioning is **independent**: each of the four packages moves only when it
changes. See [`config.json`](./config.json) and the full docs at
<https://github.com/changesets/changesets>.
