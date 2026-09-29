#!/usr/bin/env bash
# claude-mem-lite: PreToolUse:Bash prefilter for file recall.
#
# Why this hook exists (docs/audits/20260926-154904-session-history-analysis-r2.md, N1):
# pre-tool-recall.js fires on Edit|Write|NotebookEdit|Read, and on Opus 5.5 only 18.0% of
# file edits and 14.7% of file reads went through those tools — the rest were `sed -i`,
# `cat > f <<EOF`, python patches and `sed -n`/`cat`. The face with the highest measured
# cite rate (41.7%) fell to ~1/9 of its former firing rate without a single error.
#
# Why a bash prefilter: Bash is most tool calls, and most of them (git, npm, vitest, gh,
# grep) read or write no single file. Starting Node for each costs ~55 ms; this script
# costs a bash start and two regex tests, and hands off only commands that LOOK like they
# view or write a file. It is deliberately loose — pre-tool-recall.js parses the command
# properly (lib/bash-file-targets.mjs) and exits silently when there is no target.
#
# The file name must contain `pre-tool-recall`: lib/citation-tracker.mjs attributes a
# transcript's hook attachment to the pretool face by that substring of the hook COMMAND,
# and this command line is the only one the transcript records for a Bash firing.

# Read the payload FIRST, before any early exit: exiting with stdin unread hands the
# writer an EPIPE (seen as an uncaught error in this repo's own test harness when the
# off switch fired before the write finished). Only the first 256 KB is kept; the rest is
# drained, or a multi-megabyte heredoc still hits EPIPE (pre-ship delta review P3-6).
{
  input=$(head -c 262144)
  cat >/dev/null
}

[[ -n "$CLAUDE_MEM_HOOK_RUNNING" ]] && exit 0
# Off switch for this leg alone (Edit/Write/Read recall is unaffected).
# Case-insensitive like the other switches (bash 3.2 on macOS has no ${var,,}).
case "${CLAUDE_MEM_BASH_RECALL:-}" in [Oo][Ff][Ff] | 0 | [Ff][Aa][Ll][Ss][Ee] | [Nn][Oo]) exit 0 ;; esac

# The command string, still JSON-escaped (`\n`, `\"`) — the tests below do not need it
# decoded. `\"command\"` also appears inside other fields only as escaped text (`\\\"`),
# which this anchored form does not match first: tool_input precedes tool_use_id/cwd.
if [[ "$input" =~ \"command\"[[:space:]]*:[[:space:]]*\"(([^\"\\]|\\.)*)\" ]]; then
  cmd="${BASH_REMATCH[1]}"
else
  exit 0
fi

# Only the head of a command is judged: a verb that decides this sits in its first lines,
# and bash's regex engine is superlinear on some whitespace-free runs (`;x=;x=…` read 5.5 s
# at 30 KB — pre-ship round-3 review P2-3). 16 KB bounds every shape; the node side still
# parses the whole command.
cmd="${cmd:0:16384}"

# fd plumbing is never a file target.
cmd="${cmd//[0-9]>&[0-9]/}"
cmd="${cmd//>&[0-9]/}"
cmd="${cmd//>\/dev\/null/}"

# Tokens the node side never recalls, dropped before the tests below: /tmp paths (session
# scratch; kept when the project itself lives under /tmp) and `$VAR…` expansions. Measured
# on this repo's transcripts, they were the bulk of the commands that started Node for
# nothing.
scan="$cmd"
_n=0
if [[ "${CLAUDE_PROJECT_DIR:-}" != /tmp/* ]]; then
  # Anchored at a token start: `<repo>/tmp/x.mjs` is a project file, not /tmp.
  while [[ $_n -lt 20 && "$scan" =~ (^|[[:space:]\"\'=])(/tmp/[^[:space:]\"\']*) ]]; do
    scan="${scan/"${BASH_REMATCH[2]}"/}"
    _n=$((_n + 1))
  done
fi
while [[ $_n -lt 40 && "$scan" =~ (\$[A-Za-z_{][^[:space:]\"\']*) ]]; do
  scan="${scan/"${BASH_REMATCH[1]}"/}"
  _n=$((_n + 1))
done

# A file-shaped token must appear somewhere (`lib/x.mjs`, `"/abs/y.json"`).
[[ "$scan" =~ \.[A-Za-z][A-Za-z0-9_-]{0,9}([^A-Za-z0-9_-]|$) ]] || exit 0

# …and one of: a view/write verb at the START of a command (after `;`, `&&`, `||`, `(`
# or a newline — NOT after a single `|`, where `| head` / `| sed -n` read stdin, which
# is most Bash tails), a pipe into `tee`, an inline or heredoc program (`python3 -c`,
# `node -e`, `python3 - <<`; a plain `node x.mjs` runs a file, it does not edit one),
# or an output redirection.
# JSON escapes a tab as `\t`, so it counts as whitespace here; wrappers (`time`, `env`,
# `sudo -u x`, `timeout -s KILL 5`) and assignments may sit before the verb.
ws='([[:space:]]|\\t)'
#
# Every token class below excludes the backslash, so no token can swallow a JSON escape
# (`\t`, `\n`) and each token boundary is unique. A token that could span `\t` made the
# match superlinear: a 149 KB tab-separated heredoc took 8.8 s, over the hook's 3 s timeout
# (pre-ship delta review P2-B). For the same reason a `\t` is whitespace, not a command start.
# Wrapper options that take a value (`sudo -u root`, `timeout -s KILL 5`) are one token.
tok='[^[:space:]\;&|()]'
wrap="(([A-Za-z_][A-Za-z0-9_]*=${tok}*|then|do|else|if|\\{|!|sudo|time|env|nice|nohup|command|timeout|-[ugsknCDhprtU]${ws}+[^-[:space:]\\]${tok}*|-${tok}+|[0-9]+[smhd]?)${ws}+)*"
start="(^|;|&&|\\|\\||\\(|\\\\n)${ws}*${wrap}"
verb_re="${start}(cat|head|tail|nl|less|more|bat|sed|perl|tee|cp|mv|ln|touch|truncate|install)${ws}"
# Interpreters by basename (`/usr/bin/python3`, `python3.12`); a heredoc in any spelling
# (`<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<-EOF`).
prog_re="${start}(${tok}*/)?(python[0-9.]*|node)(${ws}+--?[A-Za-z0-9_=.-]+)*${ws}*(-[a-zA-Z]*[cep](${ws}|$)|-(${ws}|$)|<<)"
tee_re='\|[[:space:]]*tee[[:space:]]'
redir_re='>[[:space:]]*[^[:space:]&|;>]'
if [[ "$cmd" =~ $verb_re ]] || [[ "$cmd" =~ $prog_re ]] || [[ "$cmd" =~ $tee_re ]] || [[ "$scan" =~ $redir_re ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 0
  printf '%s' "$input" | node "${SCRIPT_DIR}/scripts/hook-launcher.mjs" scripts/pre-tool-recall.js
fi
exit 0
