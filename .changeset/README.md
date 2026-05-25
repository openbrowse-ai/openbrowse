# Changesets

This directory holds in-flight changesets for the OpenBrowse extension.

## When to add a changeset

If your PR changes user-facing behavior — features, bug fixes, UI, agent behavior, providers, connectors used at runtime — run:

```bash
pnpm changeset
```

You'll be prompted to:

1. Pick which packages are affected (currently only `openbrowse` is versioned; `openbrowse-docs` and `@openbrowse/connectors` are ignored — see `.changeset/config.json`).
2. Pick the bump type (`patch`, `minor`, `major`).
3. Write a one-line summary of the change. This becomes a bullet in the next release's `CHANGELOG.md`.

A markdown file is created in `.changeset/` — commit it with your PR.

## When you don't need a changeset

- Internal refactors with no user-visible effect
- Tests-only changes
- Doc-only changes (the docs site is not versioned)
- CI / repo-config changes
- Dependency bumps without behavior changes

## How the release flow works

1. PRs land on `main`, each carrying a `.changeset/*.md`.
2. The `Changesets` workflow (`.github/workflows/changesets.yml`) opens or updates a "Version Packages" PR that bumps `apps/extension/package.json`, regenerates `apps/extension/CHANGELOG.md`, and deletes the consumed changeset files.
3. Merging the Version Packages PR creates a git tag `vX.Y.Z`.
4. The tag triggers `release.yml`, which builds the extension zip and publishes it as a GitHub Release.
5. Chrome Web Store upload is still a deliberate manual step.

Full upstream docs: <https://github.com/changesets/changesets>.
