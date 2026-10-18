#!/usr/bin/env bash
# Validate the parser against PUBLIC Claude Code transcripts.
#
# Testing only against your own sessions is both privacy-awkward and
# unrepresentative: one machine exercises one OS, one version, one set of
# habits. This pulls two MIT-licensed corpora and runs the parser over them.
#
# What it caught the first time it ran:
#   - 42 distinct harness versions, where local data had 4
#   - 5 record types never seen locally — `summary`, `cost-state`, `pr-link`
#     (all carrying real signal) plus `progress` and `frame-link` (noise)
#   - Codex rollouts outside any `.codex/` directory, being handed to the
#     Claude Code parser instead of refused
#   - 2,414 Linux home paths, which a macOS machine never exercises
#   - 99 transcripts containing sidechains, where local data had none
#
# The corpora are NOT vendored, and NOT npm devDependencies. Committing other
# people's transcripts would violate the same rule that stops us copying yours;
# see scripts/corpus.json for why the dependency route does not work either.
#
# Commits are PINNED in scripts/corpus.json. Both upstreams are live, and an
# unpinned clone would quietly turn the baseline into a number about whatever
# HEAD happened to be that morning. `--update` re-pins deliberately.
set -euo pipefail

MANIFEST="$(dirname "$0")/corpus.json"
UPDATE=0
DIR=""
for arg in "$@"; do
  case "$arg" in
    --update) UPDATE=1 ;;
    *) DIR="$arg" ;;
  esac
done
DIR="${DIR:-/tmp/agentsensei-corpus}"
mkdir -p "$DIR"

jqlike() { node -e "
  const m = JSON.parse(require('fs').readFileSync('$MANIFEST','utf8'));
  console.log(m.corpora.map(c => [c.dest, c.repo, c.sha].join(' ')).join('\n'));
"; }

# Fetch one pinned commit. GitHub allows fetching an arbitrary SHA, so this stays
# a shallow fetch rather than a full clone plus checkout.
fetch_pinned() {
  local dest="$1" repo="$2" sha="$3" path="$DIR/$dest"
  if [ -d "$path/.git" ]; then
    local at
    at="$(git -C "$path" rev-parse HEAD)"
    if [ "$at" = "$sha" ]; then
      echo "  $dest at pinned $sha"
      return
    fi
    # Re-checkout rather than skip: a stale clone is how the baseline silently
    # starts describing a corpus nobody validated.
    echo "  $dest at $at, re-checking out pinned $sha"
  else
    echo "  fetching $repo @ $sha"
    git init -q "$path"
    git -C "$path" remote add origin "https://github.com/$repo.git"
  fi
  git -C "$path" fetch -q --depth 1 origin "$sha"
  git -C "$path" checkout -q FETCH_HEAD
}

echo "fetching pinned public corpora into $DIR"
while read -r dest repo sha; do
  [ -n "$dest" ] && fetch_pinned "$dest" "$repo" "$sha"
done <<< "$(jqlike)"

if [ "$UPDATE" = "1" ]; then
  echo
  echo "--update: re-pinning to current upstream HEAD"
  while read -r dest repo sha; do
    [ -n "$dest" ] || continue
    git -C "$DIR/$dest" fetch -q --depth 1 origin HEAD
    git -C "$DIR/$dest" checkout -q FETCH_HEAD
    new="$(git -C "$DIR/$dest" rev-parse HEAD)"
    echo "  $dest: $sha -> $new"
    node -e "
      const fs = require('fs'), p = '$MANIFEST';
      const m = JSON.parse(fs.readFileSync(p,'utf8'));
      m.corpora.find(c => c.dest === '$dest').sha = '$new';
      fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
    "
  done <<< "$(jqlike)"
  echo "  manifest updated — review the baseline diff before committing"
fi

AGENTSENSEI_CORPUS="$DIR" node --experimental-strip-types scripts/verify-corpus.ts
