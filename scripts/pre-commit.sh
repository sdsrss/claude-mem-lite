#!/usr/bin/env bash
# Pre-commit hook: version sync + lint + test before commit
# Catches errors locally before they reach GitHub CI

set -e

# ── Version sync check ──────────────────────────────────────────────────────
# Ensures package.json, package-lock.json, plugin.json, marketplace.json, CLAUDE.md all match
echo "[pre-commit] Checking version sync..."
PKG_VER=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('package.json')).version)")
LOCK_VER=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('package-lock.json')).version)")
PLUGIN_VER=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json')).version)")
MKT_VER=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json')).plugins[0].version)")
# `-m1` is NOT enough and a bare match is wrong: CLAUDE.md contains the literal string
# `**Version**: <v>` a second time, inside the sentence describing the release guard, so the
# unanchored pattern returned TWO lines ("3.96.1" and "<v>`"). The comparison below then saw
# a two-line value, reported `package.json=3.96.1 vs CLAUDE.md=3.96.1` — the printed values
# LOOK equal because the second line is off the end of the message — and exited 1. Every
# invocation of this script failed at step 1, so the eslint / format:check / vitest gates
# below it had never run; nothing caught it because the script is not wired as a git hook
# and ci.yml only shellchecks it. (A20260905-R5-P1-2, found while committing the R5 batch.)
#
# Anchor on the list-item form that actually carries the version. The guard sentence's copy
# is mid-line and preceded by a backtick, so `^- ` excludes it without depending on which
# occurrence comes first.
CLAUDE_VER=$(grep -oP '(?<=^- \*\*Version\*\*: )\S+' CLAUDE.md)
# A version check that silently extracts the wrong number of things is worse than none: it
# sends the reader to "sync all 5 files" that are already in sync. Fail with the real cause.
CLAUDE_VER_COUNT=$(printf '%s' "$CLAUDE_VER" | grep -c '' || true)
if [ "$CLAUDE_VER_COUNT" != "1" ]; then
  echo "[pre-commit] ❌ Could not read a single version from CLAUDE.md (got $CLAUDE_VER_COUNT match(es))."
  echo "[pre-commit]    Expected exactly one line matching '- **Version**: <x>'. Fix the file or this pattern."
  exit 1
fi

MISMATCH=0
if [ "$PKG_VER" != "$LOCK_VER" ]; then
  echo "[pre-commit] ❌ Version mismatch: package.json=$PKG_VER vs package-lock.json=$LOCK_VER"
  MISMATCH=1
fi
if [ "$PKG_VER" != "$PLUGIN_VER" ]; then
  echo "[pre-commit] ❌ Version mismatch: package.json=$PKG_VER vs plugin.json=$PLUGIN_VER"
  MISMATCH=1
fi
if [ "$PKG_VER" != "$MKT_VER" ]; then
  echo "[pre-commit] ❌ Version mismatch: package.json=$PKG_VER vs marketplace.json=$MKT_VER"
  MISMATCH=1
fi
if [ "$PKG_VER" != "$CLAUDE_VER" ]; then
  echo "[pre-commit] ❌ Version mismatch: package.json=$PKG_VER vs CLAUDE.md=$CLAUDE_VER"
  MISMATCH=1
fi
if [ "$MISMATCH" -eq 1 ]; then
  echo "[pre-commit] Fix: sync all 5 files to the same version, then re-commit."
  exit 1
fi
echo "[pre-commit] Versions synced: $PKG_VER"

# ── Lockfile @emnapi integrity check ────────────────────────────────────────
# A single-platform `npm install` prunes cross-platform @emnapi optional-native
# entries from package-lock.json, which breaks the CI runner's `npm ci`
# ("Missing: @emnapi/core@... from lock file"). This has recurred multiple times
# (mem P#6031 / #8644). Block any commit that REDUCES the @emnapi entry count vs
# the committed lock — that's the prune signature. Legit increases pass through.
if git diff --cached --name-only | grep -qx 'package-lock.json'; then
  STAGED_EMNAPI=$(git show :package-lock.json 2>/dev/null | grep -c '@emnapi' || true)
  HEAD_EMNAPI=$(git show HEAD:package-lock.json 2>/dev/null | grep -c '@emnapi' || true)
  if [ "${HEAD_EMNAPI:-0}" -gt 0 ] && [ "${STAGED_EMNAPI:-0}" -lt "${HEAD_EMNAPI:-0}" ]; then
    if [ "${DISABLE_EMNAPI_GUARD:-0}" = "1" ]; then
      echo "[pre-commit] ⚠ @emnapi entries dropped $HEAD_EMNAPI -> $STAGED_EMNAPI (DISABLE_EMNAPI_GUARD=1, allowing)"
    else
      echo "[pre-commit] ❌ package-lock.json @emnapi entries dropped: $HEAD_EMNAPI -> $STAGED_EMNAPI"
      echo "[pre-commit]    A single-platform 'npm install' pruned cross-platform optional native"
      echo "[pre-commit]    deps the CI runner's 'npm ci' needs (recurring — mem P#6031 / #8644)."
      echo "[pre-commit]    Fix: restore the committed lock + surgically patch only the changed dep"
      echo "[pre-commit]    (version+resolved+integrity), or regenerate preserving optionals."
      echo "[pre-commit]    Override (rare, intentional drop): DISABLE_EMNAPI_GUARD=1 git commit ..."
      exit 1
    fi
  fi
fi

# ── Baselines move guard ────────────────────────────────────────────────────
# docs/measurement/baselines.md has promised since e1824ffd (2026-09-08) that every row
# CLAUDE.md's Baselines table replaces is moved there verbatim. Nothing enforced it: of the
# 14 commits after the promise that changed the rows, 9 overwrote the old row instead, and
# the rows were recovered from git on 2026-11-09. When the staged table differs from HEAD's,
# the outgoing rows must be in the STAGED record as one `> `-quoted block. Checking line by
# line is not enough: Knip rows repeat byte for byte across stamps, so lines of an unmoved
# row are often already in the file. Every row change committed since the promise is
# re-checked against the staged record too, so a commit made with this hook off, or a later
# edit that drops a moved block, is refused at the next commit; replaying this on the 14 real
# changes refused the 9 overwrites and passed the 5 moves. The history runs strictly after
# e1824ffd's commit time: that commit recorded the rows it replaced in a reformatted shape.
# Tested by tests/pre-commit-baselines-guard.test.mjs.
BASELINES_RC=0
BASELINES_OUT=$(node --input-type=module - <<'NODE'
import { execFileSync } from 'node:child_process';
const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};
const show = (spec) => git('show', spec);
const rows = (text) => {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith('| Baseline | Value'));
  if (at < 0) return [];
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith('|---')) continue;
    if (!/^\| (Tests|Knip|Coverage) \|/.test(l)) break;
    out.push(l);
  }
  return out;
};
const record = show(':docs/measurement/baselines.md');
const missing = [];
const check = (label, outgoing, incoming) => {
  if (outgoing.join('\n') === incoming.join('\n')) return;
  // No table before the change gives an empty block, which every record includes.
  const block = outgoing.map((r) => `> ${r}`).join('\n');
  if (!record.includes(block)) missing.push(label, block);
};
check('Replaced by this commit:', rows(show('HEAD:CLAUDE.md')), rows(show(':CLAUDE.md')));
// Filtered here, not with `git log --since`, which stops at the first run of older commits.
const PROMISE = Date.parse('2026-09-08T23:24:04Z') / 1000;
for (const line of git('log', '--format=%H %ct', 'HEAD', '--', 'CLAUDE.md').split('\n')) {
  const [sha, time] = line.split(' ');
  if (!sha || Number(time) <= PROMISE) continue;
  check(`Replaced by ${sha.slice(0, 8)}, already committed:`, rows(show(`${sha}^:CLAUDE.md`)), rows(show(`${sha}:CLAUDE.md`)));
}
if (missing.length === 0) process.exit(0);
console.log(missing.join('\n'));
process.exit(1);
NODE
) || BASELINES_RC=$?
if [ "$BASELINES_RC" -eq 1 ]; then
  if [ "${DISABLE_BASELINES_GUARD:-0}" = "1" ]; then
    echo "[pre-commit] ⚠ Baselines rows replaced without moving the old ones (DISABLE_BASELINES_GUARD=1, allowing)"
  else
    echo "[pre-commit] ❌ CLAUDE.md's Baselines rows were replaced, but the rows they replaced are not in"
    echo "[pre-commit]    the staged docs/measurement/baselines.md. Add each block there verbatim, as one"
    echo "[pre-commit]    quoted block under a 'Superseded row moved from CLAUDE.md' heading:"
    while IFS= read -r line; do echo "[pre-commit]      $line"; done <<< "$BASELINES_OUT"
    echo "[pre-commit]    Override (the old row was never a reading, e.g. a typo fix): DISABLE_BASELINES_GUARD=1 git commit ..."
    exit 1
  fi
elif [ "$BASELINES_RC" -ne 0 ]; then
  echo "[pre-commit] ❌ The Baselines move guard could not run (node exited $BASELINES_RC)."
  exit 1
fi

# ── Frozen-corpus guard ─────────────────────────────────────────────────────
# The LIVE replay benchmarks dump frozen corpora so a later A/B can be run over the same
# denominator. `benchmark/results/` is gitignored, but that is one door and these files
# take an arbitrary path from --dump / --shapes / --corpus. One of the two families is
# genuinely sensitive: `*-shapes-*.json` carries real failing commands and their real
# stderr, pulled from live transcripts. (The citation corpus holds no transcript text —
# its longest string is a project path — but it does carry session UUIDs and absolute
# paths, so it is out too.)
#
# Scope, stated honestly because the first version of this comment overclaimed: this
# matches the gitignored directory OR the dated dump NAMING CONVENTION. It is a convention
# reminder, not a content gate — `--dump f.json` writes a file this cannot see. Widened
# below to not require the date and to accept `_` separators, which covers the shapes the
# benchmarks actually emit; a real gate would have to scan staged blobs for session-UUID
# and absolute-path shapes, which is a bigger change than a release should carry.
STAGED_CORPUS=$(git diff --cached --name-only --diff-filter=ACMR \
  | grep -E '(^|/)benchmark/results/|[-_]shapes[-_0-9]*\.json$|[-_]corpus[-_0-9]*\.json$' || true)
if [ -n "$STAGED_CORPUS" ]; then
  if [ "${DISABLE_CORPUS_GUARD:-0}" = "1" ]; then
    echo "[pre-commit] ⚠ frozen corpus staged (DISABLE_CORPUS_GUARD=1, allowing):"
    while IFS= read -r f; do echo "[pre-commit]      $f"; done <<< "$STAGED_CORPUS"
  else
    echo "[pre-commit] ❌ Frozen benchmark corpus staged for commit:"
    while IFS= read -r f; do echo "[pre-commit]      $f"; done <<< "$STAGED_CORPUS"
    echo "[pre-commit]    These hold real command text / stderr / session ids from live"
    echo "[pre-commit]    transcripts and are never committed. Keep them out of the tree"
    echo "[pre-commit]    (benchmark/results/ is gitignored) and pass them by path."
    echo "[pre-commit]    Override (you have checked the contents): DISABLE_CORPUS_GUARD=1 git commit ..."
    exit 1
  fi
fi

# ── Lint ─────────────────────────────────────────────────────────────────────
echo "[pre-commit] Running eslint..."
npx eslint . || {
  echo "[pre-commit] ❌ Lint failed. Fix errors before committing."
  exit 1
}

# ── Format ───────────────────────────────────────────────────────────────────
# Added with the 2026-09-05 P1-3 reformat. Before that the tree had a .prettierrc
# nothing enforced and 525 of 531 files failing `format:check`, so the command was
# a permanently-red signal rather than a gate.
#
# Placed AFTER the lint block on purpose: tests/pre-commit-corpus-guard.test.mjs slices
# this script from `# ── Frozen-corpus guard` to `# ── Lint ` and executes those bytes in a
# throwaway fixture repo, so a step between those two anchors runs where npm and prettier
# do not exist. It still gates before the full suite, which is the expensive part.
echo "[pre-commit] Checking formatting..."
npm run format:check || {
  echo "[pre-commit] ❌ Formatting. Run: npm run format  (twice — one file needs a second"
  echo "[pre-commit]    pass to reach a fixed point), then re-stage."
  exit 1
}

# ── Tests ────────────────────────────────────────────────────────────────────
# Reuse a full green run on this exact tree instead of repeating it: the agent's habit is
# "run the full suite, then commit", which made every commit pay the suite twice (395
# commits, 44.2 s median, 4.35 h — docs/audits/20260925-200912-session-history-analysis.md).
# The stamp is written only by scripts/green-stamp-reporter.mjs after a full, passing,
# unfiltered run whose tree did not change while it ran, and is honoured only with nothing
# unstaged. Any miss runs the suite exactly as before. Force it: PRE_COMMIT_FULL_TEST=1.
if STAMP_MSG=$(node scripts/green-stamp.mjs check); then
  echo "[pre-commit] Tests: reusing green run — $STAMP_MSG"
else
  echo "[pre-commit] Running tests ($STAMP_MSG)..."
  # `npm test`, not bare `vitest run`: its script puts TMPDIR on disk. Every run leaves a
  # vitest ssr cache (45 MB for a full-suite run), and /tmp here is a RAM-backed tmpfs (D#55).
  npm test || {
    echo "[pre-commit] ❌ Tests failed. Fix errors before committing."
    exit 1
  }
fi

echo "[pre-commit] ✅ All checks passed."
