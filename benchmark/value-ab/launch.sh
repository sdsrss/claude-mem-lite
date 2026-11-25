#!/bin/bash
# Value A/B batch: the plugin (this repo's HEAD) against host memory only, on the S1 -> S2 continuation scenario.
# Method, traps and the 2026-11-24 reading: docs/measurement/rulers.md "value A/B".
# Usage: launch.sh <workdir> [--opus N] [--sonnet N] [--control-opus N] [--control-sonnet N] [--gap-days D] [--parallel P]
#   defaults: 8 and 4 trajectories per arm (control counts default to the same), no gap, 12 in parallel.
#   --gap-days D: S2 starts as if S1 were D days old (age-store.mjs); 8 is past the 7-day exit-handoff window.
# Spends real model calls (~50 sessions at the defaults). Projects go under $XDG_RUNTIME_DIR; delete them after.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
VA="${1:?usage: launch.sh <workdir> [options], see the header}"; shift
OPUS=8; SONNET=4; PAR=12; CTL_OPUS=; CTL_SONNET=; GAP_DAYS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --opus) OPUS="$2"; shift 2 ;;
    --sonnet) SONNET="$2"; shift 2 ;;
    --parallel) PAR="$2"; shift 2 ;;
    --control-opus) CTL_OPUS="$2"; shift 2 ;;
    --control-sonnet) CTL_SONNET="$2"; shift 2 ;;
    --gap-days) GAP_DAYS="$2"; shift 2 ;;
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
export VA ROOT VALUEAB_CLAUDE_BIN VALUEAB_CREDENTIALS GAP_DAYS
mkdir -p "$VA" "$ROOT"
if [ ! -d "$VA/plugin" ]; then
  mkdir -p "$VA/plugin"
  git -C "$REPO" archive HEAD | tar -x -C "$VA/plugin"
  cp -a "$REPO/node_modules" "$VA/plugin/node_modules"
  git -C "$REPO" rev-parse HEAD > "$VA/plugin.sha"
fi
[ -d "$VA/seed/invoicer" ] || node "$HERE/seed.mjs" "$VA/seed/invoicer"
echo "claude $("$VALUEAB_CLAUDE_BIN" --version 2>/dev/null) · plugin $(cat "$VA/plugin.sha") · gap ${GAP_DAYS}d · root $ROOT" | tee "$VA/launch.log"
list=()
add() { # model-tag model n-plugin n-control: arms alternate which launches first
  local n=$(( $3 > $4 ? $3 : $4 ))
  for i in $(seq 1 "$n"); do
    local p=() c=()
    [ "$i" -le "$3" ] && p=("p $2 $1-p-$i")
    [ "$i" -le "$4" ] && c=("c $2 $1-c-$i")
    if [ $((i % 2)) = 1 ]; then list+=("${p[@]}" "${c[@]}"); else list+=("${c[@]}" "${p[@]}"); fi
  done
}
add o "$OPUS_MODEL" "$OPUS" "${CTL_OPUS:-$OPUS}"
add s "$SONNET_MODEL" "$SONNET" "${CTL_SONNET:-$SONNET}"
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
