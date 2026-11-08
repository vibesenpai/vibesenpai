#!/usr/bin/env bash
# Builds the plugin's release zip: the runtime files at a commit, one directory down. DECISIONS.md D69.
# Usage: scripts/build-release.sh <commit-ish> <version> <out-dir>
set -euo pipefail

ref="$1"
version="$2"
out="$3"

mkdir -p "$out"
zip="$out/vibesenpai-$version.zip"
# marketplace.json stays out: it holds this zip's hash.
git archive --format=zip --prefix=vibesenpai/ -o "$zip" "$ref" -- \
  .claude-plugin/plugin.json hooks commands src scripts types \
  package.json LICENSE NOTICE README.md \
  ':(exclude)hooks/*.test.tsx'
echo "$zip"
