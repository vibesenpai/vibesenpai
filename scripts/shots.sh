#!/usr/bin/env bash
# Screenshots of the pane for the docs, taken by VHS from a real Claude Code session on the public
# demo corpus (scripts/corpus.json), never on your own sessions. How to run it: CONTRIBUTING.md.
#
#   scripts/shots.sh [--dir DIR] [--read] [name ...]
#
# --dir   where the corpus and the demo archive live; else $VIBESENPAI_SHOTS, else ~/.cache/vibesenpai-shots
# --read  run the model reads over the demo once first (paid, about $0.10), then turn them off again
# name    shots to take, from site/shots/<name>.tape; every one when none is named
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${VIBESENPAI_SHOTS:-${XDG_CACHE_HOME:-$HOME/.cache}/vibesenpai-shots}"
READ=0
NAMES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --read) READ=1; shift ;;
    *) NAMES+=("$1"); shift ;;
  esac
done

command -v vhs >/dev/null || { echo "shots: needs VHS (brew install vhs)"; exit 1; }
command -v ffmpeg >/dev/null || { echo "shots: needs ffmpeg (installed with VHS)"; exit 1; }

# The corpus is read in place. A recorded call keeps its transcript's path, so it must not move.
if ! git -C "$DIR/corpus/ccl" rev-parse --git-dir >/dev/null 2>&1; then
  echo "shots: fetching the pinned corpus into $DIR/corpus"
  bash "$ROOT/scripts/verify-corpus.sh" "$DIR/corpus" >/dev/null
fi
export VIBESENPAI_SOURCES="$DIR/corpus/ccl/test/test_data/real_projects"
export VIBESENPAI_ARCHIVE="$DIR/archive"
export VIBESENPAI_PRESET=standard
export NODE_NO_WARNINGS=1
mkdir -p "$VIBESENPAI_ARCHIVE"
cli() { node --experimental-strip-types "$ROOT/src/cli.ts" "$@"; }

if [ "$READ" = 1 ]; then
  # The same yes a person gives: a preview, then the yes. Turned off again so the card shows.
  cli judge --enable >/dev/null
  cli judge --yes --apply >/dev/null
  # The pass itself, in the foreground so reads are turned off only once it has finished, under a lease
  # as the supervisor hands one over, so its end is recorded (Status says ok, not never-ran).
  lease="$(node --experimental-strip-types -e "import('$ROOT/src/supervise/record.ts').then((r) => console.log(r.takeLease(process.env.VIBESENPAI_ARCHIVE, 'judge', 3600000)?.token ?? ''))")"
  VIBESENPAI_LEASE="$lease" node --experimental-strip-types "$ROOT/scripts/judge.ts"
  cli judge --disable --apply >/dev/null
  cli judge --status | sed -n '3,4p'
fi


# `# state: applied` gives the demo one applied fix for the shot, and takes it away after.
demo_state() {
  node --experimental-strip-types -e "
const { DatabaseSync } = require('node:sqlite');
Promise.all([import('$ROOT/src/harness/claude-code.ts'), import('$ROOT/src/outcome.ts'), import('$ROOT/src/store.ts')]).then(([h, o, st]) => {
  st.openStore(process.env.VIBESENPAI_ARCHIVE).close();
  const db = new DatabaseSync(process.env.VIBESENPAI_ARCHIVE + '/store.db');
  const here = h.projectKey('$ROOT');
  const rule = o.ruleHash('- Do only what was asked. If something adjacent needs doing, say so and wait.');
  db.prepare('DELETE FROM fix_applied WHERE fix_id = ? AND session_id = ?').run('dea0d0', 'demo');
  db.prepare('DELETE FROM rule_seen WHERE rule_hash = ? AND project = ?').run(rule, here);
  if ('$1' === 'on') {
    db.prepare('UPDATE session SET project = ? WHERE project = ?').run(here, '-Users-dain-workspace-claude-code-log-sample');
    const later = db.prepare(\"SELECT id FROM session WHERE project = ? AND first_ts >= '2025-07-16' ORDER BY first_ts LIMIT 1\").get(here);
    db.prepare('INSERT INTO fix_applied(fix_id, project, session_id, at) VALUES (?, ?, ?, ?)').run('dea0d0', here, 'demo', '2025-07-15T09:00:00.000Z');
    if (later) db.prepare('INSERT INTO rule_seen(rule_hash, project, session_id, at) VALUES (?, ?, ?, ?)').run(rule, here, later.id, '2025-07-16T09:51:45.996Z');
  }
  db.close();
});
"
}

# One Claude Code session per shot. The header opens the pane and lands on the Findings tab; the tape
# moves on from there; Esc drops the focus ring; the pane is cut out of the 2000x1200 frame.
# The pane draws its logo only where the terminal shows pictures; VHS's does not, so the shot
# names one that does and the logo is laid into the space the pane leaves for it.
TERM_AS="${VIBESENPAI_SHOTS_TERM:-iTerm.app}"
# Pixel density: every size below is written at 1x and multiplied by this.
S=2
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OUT="$ROOT/site/src/assets/docs"
MARK="$WORK/mark.png"
node --experimental-strip-types -e "import('$ROOT/hooks/logo.ts').then((m) => require('node:fs').writeFileSync('$MARK', Buffer.from(m.MARK_PNG, 'base64')))"
if [ ${#NAMES[@]} -eq 0 ]; then
  for t in "$ROOT"/site/shots/*.tape; do NAMES+=("$(basename "$t" .tape)"); done
fi

for name in "${NAMES[@]}"; do
  tape="$ROOT/site/shots/$name.tape"
  [ -f "$tape" ] || { echo "shots: no $tape"; exit 1; }
  # `# html-report: <file>` is the HTML report in a browser, not the pane: headless Chrome at the same
  # density, in a throwaway profile so your own browser profile is never touched.
  report="$(sed -n 's/^# html-report: *//p' "$tape")"
  if [ -n "$report" ]; then
    cli report --html --out "$WORK/report.html" >/dev/null
    "${VIBESENPAI_SHOTS_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}" --headless=new --disable-gpu \
      --hide-scrollbars --no-first-run --user-data-dir="$WORK/chrome" --window-size=1280,900 \
      --force-device-scale-factor="$S" --screenshot="$ROOT/$report" "file://$WORK/report.html" >/dev/null 2>&1
    [ -s "$ROOT/$report" ] || { echo "shots: $name failed"; exit 1; }
    echo "shots: $ROOT/$report"
    continue
  fi
  height="$(sed -n 's/^# height: *\([0-9]*\).*/\1/p' "$tape")"
  # `# open: <args>` opens the pane there (`/vibesenpai:insights <args>`); without it the tape walks by keys.
  open="$(sed -n 's/^# open: *//p' "$tape")"
  # `# reads: on` gives the demo a yes for this shot alone, as most people's pane is; no turn ends, so
  # nothing is read or sent. The yes is withdrawn after the shot.
  reads="$(sed -n 's/^# reads: *//p' "$tape")"
  state="$(sed -n 's/^# state: *//p' "$tape")"
  if [ "$state" = applied ]; then demo_state on; fi
  if [ "$reads" = on ]; then cli judge --enable >/dev/null && cli judge --yes --apply >/dev/null; fi
  # VHS's parser takes bare relative names for its outputs, so it runs inside $WORK.
  {
    # The recording itself is never used; text is the cheapest output VHS writes.
    echo "Output $name.txt"
    echo 'Set Shell zsh'
    # Twice the pixels at the same rows and columns, so the shots stay sharp on high-density screens.
    echo "Set Width $((2000 * S))"
    # Tall enough for an open finding, its fix and its answers.
    echo "Set Height $((1500 * S))"
    echo "Set FontSize $((16 * S))"
    echo "Set Padding $((60 * S))"
    echo "Env VIBESENPAI_SOURCES \"$VIBESENPAI_SOURCES\""
    echo "Env VIBESENPAI_ARCHIVE \"$VIBESENPAI_ARCHIVE\""
    echo 'Env VIBESENPAI_PRESET "standard"'
    echo "Env TERM_PROGRAM \"$TERM_AS\""
    echo 'Hide'
    # Claude Code saves no transcript for a session carrying this marker, so shots never land in your own
    # history (--no-session-persistence works only with --print). The default mode, not yours.
    echo 'Env CLAUDE_CODE_CHILD_SESSION "1"'
    echo "Type \"cd '$ROOT' && claude --permission-mode manual --plugin-dir .\""
    echo 'Enter'
    echo 'Sleep 12s'
    echo "Type \"/vibesenpai:insights${open:+ $open}\""
    echo 'Sleep 1s'
    echo 'Enter'
    # Navigate only once the pane has loaded its data: focus order depends on what it shows.
    echo 'Wait+Screen@60s /updated/'
    echo 'Sleep 2s'
    # Keys sent faster than the pane redraws land on the wrong button now and then.
    echo 'Set TypingSpeed 250ms'
    if [ -z "$open" ]; then
      # Into the pane: ctrl+x tab focuses it; three more tabs land on the Findings tab.
      printf '%s\n' 'Ctrl+X' 'Sleep 1s' 'Tab' 'Tab' 'Tab' 'Tab'
    fi
    grep -v '^#' "$tape" || true
    echo 'Show'
    echo 'Escape'
    echo 'Sleep 1s'
    echo 'Screenshot shot.png'
    # VHS writes the screenshot after the fact; quitting at once can leave none.
    echo 'Sleep 2s'
    echo 'Ctrl+C'
    echo 'Ctrl+C'
  } >"$WORK/$name.tape"
  # Each tape waits for text only its screen shows, so a wrong landing fails here; one retry.
  # A run that fails, or exits without its screenshot, is tried once more; a stale frame is never cut.
  shoot() { rm -f "$WORK/shot.png"; (cd "$WORK" && vhs "$name.tape" >"$WORK/vhs.log" 2>&1) && [ -s "$WORK/shot.png" ]; }
  if ! shoot; then
    echo "shots: $name did not reach its screen, retrying once"
    shoot || { cat "$WORK/vhs.log"; echo "shots: $name failed"; exit 1; }
  fi
  cp "$WORK/shot.png" "$DIR/frame-$name.png"
  # `# crop: <file from the repo root> <top> <height>` cuts several images from one frame; without one,
  # the whole pane from the top goes to site/src/assets/docs/<name>.png. Sizes are at 1x.
  crops="$(sed -n 's/^# crop: *//p' "$tape")"
  [ -n "$crops" ] || grep -q '^# frame-crop:' "$tape" || crops="site/src/assets/docs/$name.png 0 ${height:-990}"
  [ -n "$crops" ] && while read -r file top h; do
    # Cut the pane out; where the cut starts at the pane's top, lay the logo into the 10x5 cells it keeps
    # (about 101x97 px at this font). Add a margin in the pane's own colour: it draws its last column flush.
    logo=""
    [ "$top" = 0 ] && logo="[1]scale=$((97 * S)):$((97 * S))[m];[p][m]overlay=$((7 * S)):$((20 * S)),"
    ffmpeg -nostdin -loglevel error -y -i "$WORK/shot.png" -i "$MARK" -filter_complex \
      "[0]crop=$((840 * S)):$((h * S)):$((1100 * S)):$(((60 + top) * S))[p];${logo:-[p]}pad=iw+$((12 * S)):ih:0:0:color=0x262626" \
      "$ROOT/$file"
    echo "shots: $ROOT/$file"
  done <<<"$crops"
  # `# frame-crop: <file> <x> <y> <w> <h>` cuts from the whole terminal (chat, prompt box, pane), at 1x.
  sed -n 's/^# frame-crop: *//p' "$tape" | while read -r file x y w h; do
    # The logo goes into the pane's cells first, at the pane's own place in the frame.
    ffmpeg -nostdin -loglevel error -y -i "$WORK/shot.png" -i "$MARK" -filter_complex \
      "[1]scale=$((97 * S)):$((97 * S))[m];[0][m]overlay=$((1107 * S)):$((80 * S)),crop=$((w * S)):$((h * S)):$((x * S)):$((y * S))" \
      "$ROOT/$file"
    echo "shots: $ROOT/$file"
  done
  if [ "$reads" = on ]; then cli judge --disable --apply >/dev/null; fi
  if [ "$state" = applied ]; then demo_state off; fi
done
