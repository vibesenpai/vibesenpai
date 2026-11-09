#!/usr/bin/env bash
# Checks a published release from the outside: the GitHub release, marketplace.json, npm and the docs,
# then a real install in a separate Claude Code profile. Local only; it spends on your account.
# Usage: scripts/validate-release.sh <version> [--spend] [--profile <dir>] [--keep]
#   --spend    also run the model reads (stage 3). Off by default.
#   --profile  Claude Code profile to use (CLAUDE_CONFIG_DIR). Kept between runs so you log in once.
#   --keep     keep the work directory (store, downloads, project) for inspection.
set -euo pipefail

repo=vibesenpai/vibesenpai
version=""; spend=0; keep=0
profile="${XDG_CACHE_HOME:-$HOME/.cache}/vibesenpai-validate/claude"
while [ $# -gt 0 ]; do
  case "$1" in
    --spend) spend=1 ;;
    --keep) keep=1 ;;
    --profile) profile="$2"; shift ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) version="${1#v}" ;;
  esac
  shift
done
[ -n "$version" ] || { echo "usage: $0 <version> [--spend] [--profile <dir>] [--keep]" >&2; exit 2; }
tag="v$version"
zipname="vibesenpai-$version.zip"

work=$(mktemp -d "${TMPDIR:-/tmp}/vs-validate.XXXXXX")
[ "$keep" = 1 ] || trap 'rm -rf "$work"' EXIT

passed=0; warned=0
pass() { passed=$((passed + 1)); printf '  \033[32mok\033[0m    %s\n' "$1"; }
warn() { warned=$((warned + 1)); printf '  \033[33mnote\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1" >&2; [ "$keep" = 1 ] && echo "  work dir: $work" >&2; exit 1; }
stage() { printf '\n%s\n' "$1"; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const v=($1);console.log(v===undefined?'':typeof v==='object'?JSON.stringify(v):v)})"; }
downloads() { gh release view "$tag" -R "$repo" --json assets | json "j.assets.find(a=>a.name==='$zipname')?.downloadCount"; }

for t in gh node npm curl unzip claude shasum; do command -v "$t" >/dev/null || fail "$t is not on PATH"; done
echo "validating $repo $tag   (work: $work)"

# ---------------------------------------------------------------------------------------------------
stage "1 · what was published"

assets=$(gh release view "$tag" -R "$repo" --json assets | json "j.assets.map(a=>a.name).join(' ')") \
  || fail "no GitHub release $tag"
[ "$assets" = "$zipname" ] || fail "release $tag should hold only $zipname; it holds: $assets"
pass "GitHub release $tag holds $zipname"

market=$(gh api "repos/$repo/contents/.claude-plugin/marketplace.json?ref=main" -H 'Accept: application/vnd.github.raw')
url=$(printf '%s' "$market" | json "j.plugins.find(p=>p.name==='vibesenpai').source.url")
want_sha=$(printf '%s' "$market" | json "j.plugins.find(p=>p.name==='vibesenpai').source.sha256")
[ "$url" = "https://github.com/$repo/releases/download/$tag/$zipname" ] || fail "marketplace.json on main points at '$url', not $tag"
pass "marketplace.json on main points at $tag"

count_before=$(downloads)
curl -fsSL -o "$work/$zipname" "$url" || fail "could not download $url"
got_sha=$(shasum -a 256 "$work/$zipname" | cut -d' ' -f1)
[ "$got_sha" = "$want_sha" ] || fail "zip sha256 $got_sha does not match marketplace.json $want_sha"
pass "zip sha256 matches marketplace.json"

mkdir -p "$work/unzipped"
unzip -q "$work/$zipname" -d "$work/unzipped"
plugin="$work/unzipped/vibesenpai"
for f in .claude-plugin/plugin.json package.json; do
  v=$(json "j.version" < "$plugin/$f")
  [ "$v" = "$version" ] || fail "$f in the zip says $v, not $version"
done
pass "plugin.json and package.json in the zip say $version"
if find "$plugin" \( -name '*.test.tsx' -o -name '*.spec.ts' \) | grep -q .; then fail "the zip contains test files"; fi
pass "the zip holds no test files"
claude plugin validate "$plugin" >"$work/validate.log" 2>&1 || { cat "$work/validate.log" >&2; fail "claude plugin validate rejected the zip"; }
pass "claude plugin validate accepts the zip"

npm_latest=$(npm view vibesenpai dist-tags.latest 2>/dev/null || true)
if [ "$npm_latest" = "$version" ]; then
  files=$(npm view "vibesenpai@$version" dist.fileCount)
  [ "$files" -le 3 ] || fail "npm vibesenpai@$version holds $files files; the pointer package holds README, LICENSE, package.json"
  pass "npm latest is $version, a pointer with no code"
else
  warn "npm latest is '${npm_latest:-none}', not $version: publish the pointer package"
fi

for p in "" start/install/ dimensions/; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://vibesenpai.github.io/vibesenpai/$p")
  [ "$code" = 200 ] || fail "docs /$p returned $code"
done
pass "docs site answers"

# ---------------------------------------------------------------------------------------------------
stage "2 · a real install, in the profile $profile"

mkdir -p "$profile"
export CLAUDE_CONFIG_DIR="$profile"
export VIBESENPAI_ARCHIVE="$work/store"
export VIBESENPAI_CONFIG="$work/config.json"
# The release must find transcripts by itself: these would hide that.
unset VIBESENPAI_SOURCES VIBESENPAI_DISABLE VIBESENPAI_PRESET VIBESENPAI_MUTE

# A previous run's install is removed so this one is a first install.
claude plugin uninstall vibesenpai@vibesenpai </dev/null >/dev/null 2>&1 || true
claude plugin marketplace remove vibesenpai </dev/null >/dev/null 2>&1 || true

claude plugin marketplace add "$repo" </dev/null >"$work/add.log" 2>&1 || { cat "$work/add.log" >&2; fail "marketplace add failed"; }
pass "marketplace added"
claude plugin install vibesenpai@vibesenpai </dev/null >"$work/install.log" 2>&1 || { cat "$work/install.log" >&2; fail "plugin install failed"; }
installed=$(claude plugin list --json </dev/null)
iv=$(printf '%s' "$installed" | json "j.find(p=>p.id==='vibesenpai@vibesenpai')?.version")
root=$(printf '%s' "$installed" | json "j.find(p=>p.id==='vibesenpai@vibesenpai')?.installPath")
[ "$iv" = "$version" ] || { printf '%s\n' "$installed" >&2; fail "installed version is '$iv', not $version"; }
[ -f "$root/src/cli.ts" ] || fail "installed copy has no src/cli.ts at '$root'"
pass "installed $version at $root"
cli() { NODE_NO_WARNINGS=1 node --experimental-strip-types "$root/src/cli.ts" "$@"; }

# Off before the first session, so stage 2 spends nothing on model reads.
cli judge --disable --apply >/dev/null
pass "model reads off for stage 2"

mkdir -p "$work/project"
(cd "$work/project" && git init -q)
out=$(cd "$work/project" && claude -p 'Reply with the single word ok.' --output-format json </dev/null 2>"$work/p1.err") \
  || { cat "$work/p1.err" >&2; printf '%s\n' "$out" | tail -5 >&2; fail "claude -p failed. If it asks to log in: CLAUDE_CONFIG_DIR=$profile claude, then /login"; }
sid=$(printf '%s' "$out" | json "j.session_id")
[ -n "$sid" ] || fail "claude -p gave no session id"
pass "a headless session ran ($sid)"

ls "$profile"/projects/*/"$sid".jsonl >/dev/null 2>&1 || fail "no transcript for $sid under $profile/projects"
# The Stop hook starts the free checks' history pass; wait for it to end.
for _ in $(seq 1 60); do
  st=$(json "j.lastEnd?.status" < "$VIBESENPAI_ARCHIVE/jobs/standing.json" 2>/dev/null || true)
  [ -n "$st" ] && break
  sleep 2
done
[ "$st" = ok ] || fail "the history pass did not end ok (status '${st:-never ran}'; see $VIBESENPAI_ARCHIVE/jobs/standing.stderr)"
pass "the Stop hook fired and the history pass ended ok"

report=$(cd "$work/project" && cli report --json 2>"$work/report.err") || { cat "$work/report.err" >&2; fail "report --json failed"; }
seen=$(printf '%s' "$report" | json "j.sessions.some(s=>s.sessionId==='$sid')")
[ "$seen" = true ] || fail "the installed plugin does not see session $sid: it is not reading CLAUDE_CONFIG_DIR/projects"
pass "the installed plugin reads the session from CLAUDE_CONFIG_DIR"

# The pane's tests are not in the zip; run the tag's tests against the released pane.
mkdir -p "$work/pane"
cp -R "$plugin/." "$work/pane/"
git -C "$(dirname "$0")/.." show "$tag:hooks/pane.test.tsx" >"$work/pane/hooks/pane.test.tsx" 2>/dev/null \
  || fail "could not read hooks/pane.test.tsx at $tag from this checkout (git fetch --tags)"
(cd "$work/pane" && VIBESENPAI_DISABLE=1 claude plugin test . </dev/null >"$work/pane.log" 2>&1) \
  || { tail -20 "$work/pane.log" >&2; fail "the pane's tests fail on the released pane"; }
pass "the released pane passes its tests ($(grep -Eo '[0-9]+ pass' "$work/pane.log" | tail -1))"

# D69: does an install count once, and does an update check count again? GitHub's count lags.
sleep 20
count_installed=$(downloads)
claude plugin update vibesenpai@vibesenpai </dev/null >"$work/update.log" 2>&1 || warn "plugin update exited non-zero: $(tail -1 "$work/update.log")"
sleep 20
count_updated=$(downloads)
warn "downloads: $count_before before (this script's own download adds 1), $count_installed after install, $count_updated after update check"

# ---------------------------------------------------------------------------------------------------
if [ "$spend" = 1 ]; then
  stage "3 · the model reads (spends tokens)"
  cli judge --enable --apply >/dev/null
  pass "model reads on"
  (cd "$work/project" && claude -p 'Create notes.txt containing the word hello.' --permission-mode acceptEdits </dev/null >/dev/null 2>"$work/p2.err") \
    || { cat "$work/p2.err" >&2; fail "first turn failed"; }
  (cd "$work/project" && claude -p -c 'No, I said a markdown file. Rename it to notes.md, and never create .txt files in this project.' --permission-mode acceptEdits </dev/null >/dev/null 2>"$work/p3.err") \
    || { cat "$work/p3.err" >&2; fail "second turn failed"; }
  pass "a two-turn session with a correction ran"

  calls=0
  for _ in $(seq 1 90); do
    calls=$(cd "$work/project" && cli report --json 2>/dev/null | json "j.spend?.allTime?.calls ?? 0" || echo 0)
    [ "${calls:-0}" -gt 0 ] && break
    sleep 5
  done
  [ "${calls:-0}" -gt 0 ] || fail "no model call was recorded in 7.5 minutes (see $VIBESENPAI_ARCHIVE/jobs/judge.stderr)"
  jst=$(json "j.lastEnd?.status" < "$VIBESENPAI_ARCHIVE/jobs/judge.json" 2>/dev/null || true)
  pass "the model reads ran ($calls call(s), last status ${jst:-running})"
  found=$(cd "$work/project" && cli report --json | json "j.sessions.reduce((n,s)=>n+s.judged.length,0)")
  if [ "${found:-0}" -gt 0 ]; then pass "$found model finding(s)"; else warn "the model reads found nothing in the corrected session (a model can miss)"; fi

  # A read already running may still call the model; wait for it to end first.
  for _ in $(seq 1 120); do [ -d "$VIBESENPAI_ARCHIVE/jobs/judge.lease" ] || break; sleep 5; done
  calls=$(cd "$work/project" && cli report --json | json "j.spend?.allTime?.calls ?? 0")
  cli judge --disable --apply >/dev/null
  (cd "$work/project" && claude -p 'Reply with the single word ok.' </dev/null >/dev/null 2>&1) || true
  sleep 30
  after=$(cd "$work/project" && cli report --json | json "j.spend?.allTime?.calls ?? 0")
  [ "$after" = "$calls" ] || fail "model calls went from $calls to $after after the reads were turned off"
  pass "turning the reads off stops them"
else
  printf '\n3 · the model reads: skipped (pass --spend to run them)\n'
fi

printf '\n%s checks passed, %s notes. %s is good.\n' "$passed" "$warned" "$tag"
