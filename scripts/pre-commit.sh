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
CLAUDE_VER=$(grep -oP '(?<=\*\*Version\*\*: )\S+' CLAUDE.md)

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

echo "[pre-commit] Running tests..."
npx vitest run || {
  echo "[pre-commit] ❌ Tests failed. Fix errors before committing."
  exit 1
}

echo "[pre-commit] ✅ All checks passed."
