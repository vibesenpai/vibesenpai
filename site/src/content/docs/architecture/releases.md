---
title: Releases and install counts
description: The plugin ships as a zip on a tagged GitHub release, and installs are counted from that zip's downloads. No telemetry.
---

This page explains how a release is built and how installs are counted
without telemetry. In short: the plugin ships as a zip on a tagged GitHub
release, and GitHub's download count for that zip is the measure
([DECISIONS.md D69](https://github.com/vibesenpai/vibesenpai/blob/main/DECISIONS.md)).

## Why not ask Claude Code for install counts?

It has none to give. Its documentation says: *"Claude Code doesn't report a
plugin's usage back to its author."* Public install counts exist only for the
`claude-plugins-official` marketplace.

## What else was considered?

| option | counts | not chosen because |
|---|---|---|
| a ping from the plugin | anything | it is telemetry; the product does not phone home |
| `marketplace.json` served from our own URL | adds and every refresh | also fetched on update and on install-by-name; our domain becomes a supply-chain point |
| GitHub clone traffic | unique cloners | a 14-day window; mixes refreshes, updates and CI |
| **release zip, `archive` source** | **zip downloads** | chosen |

## How is a release made?

A tag `v<version>` runs `.github/workflows/release.yml`:

1. typecheck and the test suite
2. a check that the tag matches the version in `.claude-plugin/plugin.json` and
   `package.json`
3. `scripts/build-release.sh` builds the zip of the runtime files
   (`marketplace.json` stays out, because it holds the zip's hash)
4. a GitHub release is created with the zip attached
5. only then, a commit points the `marketplace.json` entry at the zip, with its
   `sha256`

The hash is taken from the uploaded bytes, never from a rebuild, so a changed
zip fails to install. If the last step fails, the entry keeps its previous
source. The install command does not change.

A release requires Claude Code 2.1.224 or later, the version that added the
`archive` source.

## What does one download mean?

| event | downloads the zip |
|---|---|
| first install | yes |
| installing again on the same machine | no, unless the cache is gone |
| marketplace refresh | no: that clones the repo for `marketplace.json` |
| updating to a new version | yes |
| background auto-update | off by default for marketplaces other than Anthropic's |

So the count is **first installs plus manual upgrades**, per release. GitHub
does not deduplicate, so it is not a count of people.

The full reasoning, with the documentation quoted, is in
[docs/distribution.md](https://github.com/vibesenpai/vibesenpai/blob/main/docs/distribution.md#releases-and-install-counts-2026-11-08).
