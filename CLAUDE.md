# CLAUDE.md

## Branching and merging

New feature development goes through a pull request — branch off `main`, open a
PR, merge it back with **squash merge**. `main` keeps one commit per feature.

Direct commits to `main` are for repo housekeeping only: docs, changelog,
release packaging, and this file.

## Tests

```
node test.mjs
```

Drives the real extension in Chrome for Testing over CDP. `VERTICAL=1` adds a
headful run against the vertical tab strip. Both must be green before a PR
merges — there is no CI, so run them locally.

## Releasing

`manifest.json`, `CHANGELOG.md`, `EXTENSION.md` and `README.md` move together on
any release that changes user-facing behaviour or permissions. `EXTENSION.md` is
the Chrome Web Store listing, and its CHANGES section mirrors `CHANGELOG.md`.
