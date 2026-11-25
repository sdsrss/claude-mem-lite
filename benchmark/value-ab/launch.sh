#!/bin/bash
# Value A/B batch: the plugin (this repo's HEAD) against host memory only, on the S1 -> S2 continuation scenario.
# Method, traps and the 2026-11-24 reading: docs/measurement/rulers.md "value A/B".
# Usage: launch.sh <workdir> [--opus N] [--sonnet N] [--parallel P]     (defaults 8, 4, 12)
# Spends real model calls (~50 sessions at the defaults). Projects go under $XDG_RUNTIME_DIR; delete them after.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
VA="${1:?usage: launch.sh <workdir> [--opus N] [--sonnet N] [--parallel P]}"; shift
OPUS=8; SONNET=4; PAR=12
while [ $# -gt 0 ]; do
  case "$1" in
    --opus) OPUS="$2"; shift 2 ;;
    --sonnet) SONNET="$2"; shift 2 ;;
    --parallel) PAR="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
OPUS_MODEL="${VALUEAB_OPUS_MODEL:-claude-opus-5-5}"; SONNET_MODEL="${VALUEAB_SONNET_MODEL:-claude-sonnet-5-5}"
ROOT="${VALUEAB_ROOT:-${XDG_RUNTIME_DIR:?set XDG_RUNTIME_DIR or VALUEAB_ROOT}/agent-tmp-valueab-$(date -u +%Y%m%dT%H%M%S)}"
# The plugin drops file edges for anything under /tmp/claude-<uid>/ (isTransientPath), and an ancestor
# CLAUDE.md loads as project instructions: keep projects out of both.
case "$ROOT" in /tmp/claude-*) echo "ROOT under /tmp/claude-<uid>/ hides file edges: $ROOT" >&2; exit 2 ;; esac
d="$(dirname "$ROOT")"
while [ "$d" != / ]; do
  if [ -e "$d/CLAUDE.md" ] || [ -e "$d/.claude/CLAUDE.md" ]; then echo "ancestor instructions at $d" >&2; exit 2; fi
  d="$(dirname "$d")"
done
VALUEAB_CLAUDE_BIN="$(readlink -f "$(command -v claude)")" || { echo "claude not on PATH" >&2; exit 2; }
VALUEAB_CREDENTIALS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"
[ -f "$VALUEAB_CREDENTIALS" ] || { echo "no credentials at $VALUEAB_CREDENTIALS" >&2; exit 2; }
export VA ROOT VALUEAB_CLAUDE_BIN VALUEAB_CREDENTIALS
mkdir -p "$VA" "$ROOT"
if [ ! -d "$VA/plugin" ]; then
  mkdir -p "$VA/plugin"
  git -C "$REPO" archive HEAD | tar -x -C "$VA/plugin"
  cp -a "$REPO/node_modules" "$VA/plugin/node_modules"
  git -C "$REPO" rev-parse HEAD > "$VA/plugin.sha"
fi
[ -d "$VA/seed/invoicer" ] || node "$HERE/seed.mjs" "$VA/seed/invoicer"
echo "claude $("$VALUEAB_CLAUDE_BIN" --version 2>/dev/null) · plugin $(cat "$VA/plugin.sha") · root $ROOT" | tee "$VA/launch.log"
list=()
add() { # model-tag model n: arms alternate which launches first
  for i in $(seq 1 "$3"); do
    if [ $((i % 2)) = 1 ]; then list+=("p $2 $1-p-$i" "c $2 $1-c-$i"); else list+=("c $2 $1-c-$i" "p $2 $1-p-$i"); fi
  done
}
add o "$OPUS_MODEL" "$OPUS"
add s "$SONNET_MODEL" "$SONNET"
for job in "${list[@]}"; do
  while [ "$(jobs -rp | wc -l)" -ge "$PAR" ]; do sleep 2; done
  read -r arm model id <<< "$job"
  echo "launch $id $(date -u +%T)" | tee -a "$VA/launch.log"
  "$HERE/run-traj.sh" "$arm" "$model" "$id" > "$VA/runs-$id.out" 2>&1 &
  sleep 3 # staggered: concurrent starts on one expiring OAuth token race its refresh
done
wait
echo "batch done $(date -u +%T)" | tee -a "$VA/launch.log"
node "$HERE/analyze.mjs" "$VA"
