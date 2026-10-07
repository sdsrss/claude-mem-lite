#!/usr/bin/env bash
# claude-mem-lite: Fast bash pre-filter for PostToolUse hook
# Skips known low-value tools in ~5ms instead of launching Node (~80-150ms)
# SYNC: Skip list must match skip-tools.mjs (source of truth)
# Consistency enforced by tests/skip-tools.test.mjs

# Prevent recursive hooks
[[ -n "$CLAUDE_MEM_HOOK_RUNNING" ]] && exit 0

# Claude Code plugin-disable guard (audit P3-4).
# install.mjs writes DIRECT hook entries into ~/.claude/settings.json, so disabling the
# plugin in the Claude UI leaves them firing. hook.mjs exits 0 for that case, but the
# Read fast-path below never reaches Node: it kept appending to reads-<project>.txt on
# EVERY Read, while the 24h sweep that reaps those files (sweepOrphanEpisodeFiles, via
# runSessionStartAutoMaintain) sits behind that same Node-side exit — unbounded growth
# in runtime/ for a plugin the user believes is off.
# MUST agree with hook.mjs isPluginExplicitlyDisabled(): the same settings.json — the host's
# config home, an absolute CLAUDE_CONFIG_DIR else $HOME/.claude (lib/data-paths.mjs
# claudeConfigDir; a relative value is ignored on both sides) — the same plugin key, and the
# same fail-open-on-unreadable semantics (its try/catch returns false). Parity pinned by
# tests/post-tool-use-disabled.test.mjs.
# Cheap by construction: no `node`, no external command on this ~5ms per-tool-call path.
# `-r` covers missing/unreadable in one builtin test, and `$(<file)` slurps the whole file
# for ONE regex — measured +0.4ms/call vs +4.0ms for a `while read` loop over the same
# 239-line settings.json (bash pays a syscall + a regex per line there).
# The ERE (not a `==` glob) is what keeps a MINIFIED single-line settings.json from
# matching `"<key>": true, … "other": false` as a false positive: the pattern is anchored
# to the key, so only that key's own value can satisfy it.
# Deliberately NOT applied to the Node handoff at the tail: hook.mjs already self-guards
# there, so a bash false positive could only lose data, never save work.
case "$CLAUDE_CONFIG_DIR" in
  /* | [A-Za-z]:[\\/]*) _mem_settings_file="${CLAUDE_CONFIG_DIR}/settings.json" ;;
  *) _mem_settings_file="${HOME}/.claude/settings.json" ;;
esac
_mem_plugin_disabled() {
  [[ -r "$_mem_settings_file" ]] || return 1
  local _settings
  _settings=$(<"$_mem_settings_file")
  [[ "$_settings" =~ \"claude-mem-lite@sdsrss\"[[:space:]]*:[[:space:]]*false ]]
}

# Read stdin (tool hook JSON)
input=$(head -c 262144)

# Extract tool_name via bash regex — no subprocess
if [[ "$input" =~ \"tool_name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
  tool="${BASH_REMATCH[1]}"
else
  exit 0
fi

# Read tool: track file path for episode context, then exit (no Node needed)
if [[ "$tool" == "Read" ]]; then
  # Disabled plugin → write nothing; nothing would ever sweep the file (see guard above).
  # 2>/dev/null: a settings.json unlinked between the -r test and the read must stay
  # silent — Claude Code surfaces hook stderr.
  _mem_plugin_disabled 2>/dev/null && exit 0
  # D#69: a subagent's Read is not the main thread's context. The host sets a non-empty
  # `agent_id` only inside a subagent; hook.mjs keeps those calls out of the episode
  # buffer, but a Read never reaches it, so without this a reviewer reading an extracted
  # tree became files_read of the main thread's next observation (pre-ship review P3-5).
  # Same off switch as hook.mjs (lib/episode-input-filter.mjs episodeInputFilterEnabled:
  # 0/off/false/no, any case). Glob classes, not ${v,,}: bash 3.2 (macOS) lacks it.
  # ALL subagent Reads, unlike hook.mjs (which keeps a subagent call that edits the
  # project): this path cannot know whether the subagent will edit later, a Read only
  # feeds files_read, and the edit itself still reaches the buffer through hook.mjs.
  # The field can sit past the 256 KB head window (after a large tool_response): a
  # truncated payload — one that does not end in `}` — has its unread rest scanned too.
  # `grep -c`, not `-q`: it reads to EOF, so the writer never gets an EPIPE
  # (pre-ship delta review P3-7).
  _mem_sub=0
  if [[ "$input" =~ \"agent_id\"[[:space:]]*:[[:space:]]*\"[^\"]+\" ]]; then
    _mem_sub=1
  elif ! [[ "$input" =~ \}[[:space:]]*$ ]] &&
    grep -c '"agent_id"[[:space:]]*:[[:space:]]*"[^"]' >/dev/null 2>&1; then
    _mem_sub=1
  fi
  if [[ $_mem_sub == 1 ]]; then
    case "${CLAUDE_MEM_EPISODE_INPUT_FILTER:-}" in
      0|[oO][fF][fF]|[fF][aA][lL][sS][eE]|[nN][oO]) ;;
      *) exit 0 ;;
    esac
  fi
  _mem_read_to_node=0
  file_path=''
  if [[ "$input" =~ \"file_path\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    file_path="${BASH_REMATCH[1]}"
    # D14/D9: with a host pid the reads file belongs to the process (hook-episode.mjs
    # readsFile), which pins CLAUDE_PROJECT_DIR, so no project name is needed at all — and a
    # project name in a non-Latin script is exactly what bash cannot spell like Node.
    if [[ "${CLAUDE_PID:-}" =~ ^[1-9][0-9]{0,9}$ ]]; then
      _reads_key="@h${CLAUDE_PID}"
    else
      _dir="${CLAUDE_PROJECT_DIR:-$PWD}"
      # Strip trailing slashes so ${_dir##*/} / ${_dir%/*} match Node's path.basename /
      # path.dirname in inferProject(). Without this, CLAUDE_PROJECT_DIR="/org/proj/"
      # gave bash "proj--" (empty base) while JS gave "org--proj" — a name mismatch that
      # made flushEpisode read a DIFFERENT reads-<project>.txt, silently dropping this
      # session's Read context AND orphaning the bash-named file (nothing ever collects it).
      while [[ "$_dir" == */ && ${#_dir} -gt 1 ]]; do _dir="${_dir%/}"; done
      _base="${_dir##*/}"
      _parent="${_dir%/*}"; _parent="${_parent##*/}"
      if [[ -n "$_parent" && "$_parent" != "." && "$_parent" != "/" ]]; then
        project="${_parent}--${_base}"
      else
        project="${_base}"
      fi
      # Byte semantics for the test below. Not load-bearing on bash 5.3, which detected a
      # CJK name in C, C.UTF-8, en_US.UTF-8 and POSIX alike (probed 2026-09-29); set because
      # what a byte range means in a multibyte locale is up to the bash build, and bash 3.2
      # (macOS) could not be probed. Before D9 the sanitizer below turned one CJK character
      # into one '-' or three depending on the locale.
      _mem_lc_all_set="${LC_ALL+x}"; _mem_lc_all="${LC_ALL:-}"
      LC_ALL=C
      if [[ "$project" == *[$'\x80'-$'\xff']* ]]; then
        # Non-ASCII: Node's rule keeps letters and digits of every script (project-utils.mjs
        # projectNameFromDir), which needs Unicode tables. Hand the Read to hook.mjs.
        _mem_read_to_node=1
      else
        # Sanitize + truncate to 100 to match projectNameFromDir() for ASCII, where it is
        # exactly raw.replace(/[^a-zA-Z0-9_.-]/g,'-').slice(0,100). A >100-char parent--base
        # otherwise diverges from the JS side (same reads-file mismatch as above).
        project="${project//[^a-zA-Z0-9_.-]/-}"
        project="${project:0:100}"
        project="${project:-unknown}"
        _reads_key="$project"
      fi
      if [[ -n "$_mem_lc_all_set" ]]; then LC_ALL="$_mem_lc_all"; else unset LC_ALL; fi
    fi
  fi
  if [[ $_mem_read_to_node == 0 && -n "${file_path:-}" ]]; then
    # Honor CLAUDE_MEM_DIR relocation (mirrors schema.mjs DB_DIR → hook-shared RUNTIME_DIR).
    # hook.mjs flushEpisode reads reads-<project>.txt from CLAUDE_MEM_DIR/runtime; if this
    # bash fast-path wrote to $HOME unconditionally, a relocated install would drop all
    # Read context from episodes AND grow an uncollected reads file in $HOME forever.
    _data_dir="${CLAUDE_MEM_DIR:-$HOME/.claude-mem-lite}"
    # Test containment, mirroring containInTests() in lib/resolve-data-dir.mjs (audit
    # ENG-1). That guard sits at the NODE exit of this channel, and this channel has two:
    # the Read fast path above never reaches Node, so a test that spawned the prefilter
    # without setting CLAUDE_MEM_DIR appended straight into the developer's live runtime
    # dir. That is not hypothetical — it is what v3.83.0 had to clean up, and the fix
    # there was a single-file canary keyed on one fingerprint, so any other test using
    # any other project name still walked through.
    #
    # Same three conditions as the Node side, same order: guard armed, target IS the real
    # directory (not merely "outside tmp" — suites legitimately point HOME at fixtures),
    # and an absolute sandbox to redirect into. Pure builtins; no spawn on this ~5ms path.
    if [[ "${CLAUDE_MEM_TEST_GUARD:-}" == "1" ]]; then
      _real_dir="${CLAUDE_MEM_TEST_REALDIR:-$HOME/.claude-mem-lite}"
      # Node compares resolve(dir) !== resolve(real); a raw string compare here let
      # `CLAUDE_MEM_DIR="$HOME/.claude-mem-lite/"` (trailing slash) walk straight through
      # the guard and append into the live runtime dir — the exact leak this exists to
      # close. Trailing-slash strip only, with the same builtin loop used for `_dir` above:
      # a realpath spawn would blow the ~5ms budget, and a trailing slash is the spelling
      # difference that actually occurs.
      while [[ "$_data_dir" == */ && ${#_data_dir} -gt 1 ]]; do _data_dir="${_data_dir%/}"; done
      while [[ "$_real_dir" == */ && ${#_real_dir} -gt 1 ]]; do _real_dir="${_real_dir%/}"; done
      if [[ "$_data_dir" == "$_real_dir" ]]; then
        if [[ "${CLAUDE_MEM_TEST_SANDBOX:-}" == /* ]]; then
          _data_dir="$CLAUDE_MEM_TEST_SANDBOX"
        else
          _data_dir="${TMPDIR:-/tmp}"; _data_dir="${_data_dir%/}/claude-mem-test-fallback"
        fi
      fi
    fi
    # Mirror resolveRuntimeDir() (lib/resolve-data-dir.mjs): CLAUDE_MEM_RUNTIME_DIR wins when
    # non-empty, and a relative value resolves against cwd. Without this the two sides of the
    # channel disagreed whenever that override was set — bash appended to
    # $CLAUDE_MEM_DIR/runtime while hook.mjs read (and hook-shared.mjs reaped) the override
    # dir, which is both harms named at the top of this branch: every Read dropped from the
    # episode, and an orphaned file nothing ever collects.
    #
    # The override deliberately wins over the test-containment redirect above, because the
    # Node resolver ignores dataDir entirely once it is set. Mirroring it is the whole point;
    # a "safer" bash rule here would be a second policy nobody reviewed.
    #
    # Builtins only. This is the ~5ms pre-filter — a `node -e` resolver of the kind setup.sh
    # can afford at SessionStart costs ~27ms measured, on every tool call.
    if [[ -n "${CLAUDE_MEM_RUNTIME_DIR:-}" ]]; then
      runtime_dir="$CLAUDE_MEM_RUNTIME_DIR"
      [[ "$runtime_dir" == /* ]] || runtime_dir="${PWD}/${runtime_dir}"
    else
      runtime_dir="${_data_dir}/runtime"
    fi
    # Owner-only (0700 dir / 0600 file): reads-<project>.txt lists captured file
    # paths, so on a shared host the default umask leaked them to every local user.
    # umask is a shell builtin — no extra process on this ~5ms per-tool-call path
    # (a chmod would be a spawn). It only applies at creation; server.mjs
    # hardenRuntimeFiles() remediates files that predate this fix. Scoped safely:
    # this branch always exits before the node handoff below.
    umask 077
    mkdir -p "$runtime_dir" 2>/dev/null
    # Use printf to avoid shell interpretation of special characters in file paths
    printf '%s\n' "$file_path" >> "${runtime_dir}/reads-${_reads_key}.txt"
  fi
  [[ $_mem_read_to_node == 1 ]] || exit 0
fi

# SYNC: Must match SKIP_TOOLS and SKIP_PREFIXES in skip-tools.mjs
case "$tool" in
  # Exact matches (SKIP_TOOLS set — Read handled above)
  Glob|TodoRead|TodoWrite|TaskList|TaskGet|TaskCreate|TaskUpdate|\
  AskUserQuestion|EnterPlanMode|ExitPlanMode|\
  mcp__claude-in-chrome__screenshot|mcp__claude-in-chrome__read_page|\
  mcp__claude-in-chrome__tabs_context_mcp|mcp__claude-in-chrome__computer|\
  mcp__claude-in-chrome__find|mcp__claude-in-chrome__navigate)
    exit 0
    ;;
  # Prefix filters
  mem_*|mcp__mem__*|mcp__mem-lite__*|mcp__plugin_claude-mem-lite*|mcp__sequential*|mcp__plugin_context7*)
    exit 0
    ;;
esac

# Tool not skipped — hand off to Node for full processing.
# Routed through hook-launcher.mjs (self-heal on ERR_MODULE_NOT_FOUND).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
printf '%s' "$input" | node "${SCRIPT_DIR}/scripts/hook-launcher.mjs" hook.mjs post-tool-use
