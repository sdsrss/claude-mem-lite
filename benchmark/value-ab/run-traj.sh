#!/bin/bash
# One value A/B trajectory: S1 then S2 in fresh `claude -p` processes, a lazy commit and the hidden eval on a clean
# clone after each. Called by launch.sh, which sets VA, ROOT, VALUEAB_CLAUDE_BIN and VALUEAB_CREDENTIALS.
# Usage: run-traj.sh <arm c|p> <model> <id>
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARM="$1"; MODEL="$2"; ID="$3"
VA="${VA:?}"; ROOT="${ROOT:?}"
CLAUDE_BIN="${VALUEAB_CLAUDE_BIN:?}"; CREDS="${VALUEAB_CREDENTIALS:?}"
T="$ROOT/$ID"; PROJ="$T/invoicer"; CFG="$VA/cfg/$ID"; H="$VA/home/$ID"; MEMD="$VA/memdir/$ID"; LOG="$VA/runs/$ID"
[ -e "$T" ] && { echo "exists: $T" >&2; exit 2; }
mkdir -p "$T/tmp" "$T/evaltmp" "$CFG" "$H" "$LOG"
cp -a "$VA/seed/invoicer" "$PROJ"
# A true default user: its own config dir holding only the credentials link. Both arms allow Bash (Claude Code
# 2.1.331 denies `npm test` under -p + acceptEdits, where a real user would approve it) and the plugin's MCP tools.
ln -s "$CREDS" "$CFG/.credentials.json"
printf '%s\n' '{"permissions":{"allow":["Bash","mcp__plugin_claude-mem-lite_mem-lite"]}}' > "$CFG/settings.json"
printf '[user]\n\tname = Dev\n\temail = dev@example.com\n[init]\n\tdefaultBranch = main\n' > "$H/.gitconfig"
envs=(PATH="$PATH" HOME="$H" USER="${USER:-dev}" SHELL=/bin/bash LANG=C.UTF-8
  TMPDIR="$T/tmp" CLAUDE_CONFIG_DIR="$CFG" DISABLE_AUTOUPDATER=1
  HTTPS_PROXY="${HTTPS_PROXY:-}" HTTP_PROXY="${HTTP_PROXY:-}" https_proxy="${https_proxy:-}" http_proxy="${http_proxy:-}"
  NO_PROXY="${NO_PROXY:-}" no_proxy="${no_proxy:-}")
extra=()
if [ "$ARM" = p ]; then
  mkdir -p "$MEMD"
  envs+=(CLAUDE_MEM_DIR="$MEMD" CLAUDE_MEM_SKIP_UPDATE=1 CLAUDE_CODE_PATH="$HERE/claude-wrap.sh"
    VALUEAB_CLAUDE_BIN="$CLAUDE_BIN" WRAP_LOG="$LOG/bg")
  extra=(--plugin-dir "$VA/plugin")
fi
GAP_DAYS="${GAP_DAYS:-0}"
echo "{\"id\":\"$ID\",\"arm\":\"$ARM\",\"model\":\"$MODEL\",\"gapDays\":$GAP_DAYS,\"start\":\"$(date -u +%FT%TZ)\"}" > "$LOG/meta.json"
for N in 1 2; do
  if [ "$N" = 2 ]; then
    # what the S2 session can see before it starts
    mkdir -p "$LOG/preS2"
    cp -a "$CFG/projects" "$LOG/preS2/cfgprojects" 2>/dev/null
    git -C "$PROJ" grep -n -i -E 'SAVE10|FLAT5|coupon|优惠码|第 ?2 ?步|step 2|TODO' > "$LOG/preS2/repo-hits.txt" 2>/dev/null
  fi
  ( cd "$PROJ" && env -i "${envs[@]}" timeout 1200 "$CLAUDE_BIN" -p "$(cat "$HERE/prompts/S$N.txt")" \
      --model "$MODEL" --permission-mode acceptEdits --output-format json "${extra[@]}" \
      > "$LOG/S$N.json" 2> "$LOG/S$N.err" )
  echo "S$N exit=$? $(date -u +%FT%TZ)" >> "$LOG/progress.txt"
  sleep 10
  if [ "$ARM" = p ]; then
    # wait (max 240 s) for the plugin's detached workers: every logged call ended, no process with this data dir
    for _ in $(seq 1 48); do
      s=$(find "$LOG/bg" -name '*.start' 2>/dev/null | wc -l); e=$(find "$LOG/bg" -name '*.end' 2>/dev/null | wc -l)
      live=0
      for pid in $(pgrep -u "$(id -u)" -x node) $(pgrep -u "$(id -u)" -f -- "$CLAUDE_BIN"); do
        tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qxF "CLAUDE_MEM_DIR=$MEMD" && live=1 && break
      done
      [ "$s" = "$e" ] && [ "$live" = 0 ] && break
      sleep 5
    done
  fi
  git -C "$PROJ" add -A && git -C "$PROJ" commit -q --allow-empty -m "session $N"
  git clone -q "$PROJ" "$T/clone-S$N"
  node "$HERE/eval.mjs" "$T/clone-S$N" "$T/evaltmp" > "$LOG/eval-S$N.json" 2> "$LOG/eval-S$N.err"
  mkdir -p "$LOG/post-S$N"
  cp -a "$CFG/projects" "$LOG/post-S$N/cfgprojects" 2>/dev/null
  if [ "$ARM" = p ] && [ -f "$MEMD/claude-mem-lite.db" ]; then
    sqlite3 -readonly "$MEMD/claude-mem-lite.db" ".backup '$LOG/post-S$N/mem.db'"
  fi
  git -C "$PROJ" show --stat HEAD > "$LOG/post-S$N/commit.txt"
  if [ "$N" = 1 ] && [ "$GAP_DAYS" != 0 ]; then
    # Long-gap arm: S2 starts as if S1 were GAP_DAYS old. The plugin's private store and runtime files move back
    # (age-store.mjs); the host's transcripts get old mtimes in both arms. The system clock is not touched.
    if [ "$ARM" = p ] && [ -f "$MEMD/claude-mem-lite.db" ]; then
      node "$HERE/age-store.mjs" "$MEMD/claude-mem-lite.db" "$GAP_DAYS" --runtime "$MEMD/runtime" > "$LOG/aged.json"
    fi
    old=$(( $(date +%s) - GAP_DAYS * 86400 ))
    [ -d "$CFG/projects" ] && find "$CFG/projects" -type f -exec touch -d "@$old" {} +
  fi
done
echo "done $(date -u +%FT%TZ)" >> "$LOG/progress.txt"
