#!/bin/bash
# Background-LLM logger for the value A/B's plugin arm (CLAUDE_CODE_PATH points here). For `-p` calls it runs the
# real CLI with --output-format json, keeps the envelope in $WRAP_LOG (call count, cost, model) and hands the
# plugin only the result text, so the plugin sees what it would see without the wrapper.
real="${VALUEAB_CLAUDE_BIN:?}"
case " $* " in *" -p "*) ;; *) exec "$real" "$@" ;; esac
mkdir -p "${WRAP_LOG:?}"
id="$(date +%s%N)-$$"
: > "$WRAP_LOG/$id.start"
out="$("$real" "$@" --output-format json)"
rc=$?
printf '%s' "$out" > "$WRAP_LOG/$id.json"
: > "$WRAP_LOG/$id.end"
printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.result??""));process.exitCode=j.is_error?1:0}catch{process.stdout.write(s)}})'
nrc=$?
[ "$rc" -ne 0 ] && exit "$rc"
exit "$nrc"
