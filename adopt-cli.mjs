// CLAUDE.md-steering plan (v3.13): CLI handlers for
//   claude-mem-lite adopt   [--all] [--force] [--dry-run] [--status] [--disable|--enable]
//   claude-mem-lite unadopt [--all] [--force] [--dry-run] [--status]
//
// adopt   = write the managed block into <cwd>/CLAUDE.md + drop
//           <cwd>/.claude/plugin_claude_mem_lite.md, and migrate this project's
//           legacy memory-dir sentinel away.
// unadopt = remove the CLAUDE.md block + detail doc (and clean any legacy residue).
//
// The project path is needed to write CLAUDE.md, but the per-project memdir slug
// (~/.claude/projects/<encoded>/) is a LOSSY encoding of the real cwd — it cannot
// be decoded back to a filesystem path. So `--all` cannot adopt arbitrary projects;
// it is redefined as a legacy-cleanup sweep (strip old memory-dir sentinels across
// every memdir). New-scheme adoption happens per-project on SessionStart (cwd known).

import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
} from 'fs';
import { claudeConfigDir, claudeStatePath } from './lib/data-paths.mjs';
import { join, isAbsolute, relative, dirname } from 'path';
import {
  memdirPath,
  disableSentinelPath,
  isAutoAdoptDisabled,
  isAutoAdoptDisabledFor,
  legacyMemdirPath,
  removePluginSection,
  removePluginDoc,
  isAdopted as memdirIsAdopted,
  hasPluginState,
} from './memdir.mjs';
import {
  writeManaged,
  removeManaged,
  isAdopted as claudeMdIsAdopted,
  hasResidue as claudeMdHasResidue,
  needsRefresh,
  readBlock,
  migrateLegacyMemoryDir,
  hasLegacyMemdirSentinel,
  claudeMdPath,
  detailDocPath,
  addAgentsImports,
  holdsOnlyOwnLines,
} from './claudemd.mjs';
import { PLUGIN_SLUG, CURRENT_SENTINEL_VERSION, buildClaudeMdBlock, getDetailDoc } from './adopt-content.mjs';
import {
  localSteeringRoot,
  readLocalSteering,
  writeLocalSteering,
  removeLocalSteering,
  ensureSteeringDetailDoc,
  localMdPath,
  forgetLocalSteering,
  localSteeringRemembered,
  agentsMdForNewClaudeMd,
  claudeMdSwitchesOffAgentsBelow,
  tildePath,
  RULES_MD,
  RULES_REFUSAL_TEXT,
  LOCAL_MD,
  LOCAL_REFUSAL_TEXT,
  planLocalSteering,
  localMdRefused,
  trackedByGit,
  ignoredByGit,
  isSharedAncestor,
  samePath,
  localFileLinked,
} from './lib/local-steering.mjs';

/**
 * Remove the auto-written local block (CLAUDE.local.md, or the D#212 rules file) for the project at
 * `cwd`, if there is one.
 * @returns {{action: 'removed'|'partial'|'absent', residue?: string, path?: string}}
 */
function dropLocalSteering(cwd, { atRootOnly = false, keepTracked = false } = {}) {
  const root = localSteeringRoot(cwd);
  if (!root) return { action: 'absent' };
  // `atRootOnly`: a CLAUDE.md written or synced in a subdirectory steers that subtree only, so the
  // root's local file stays for every other session there; taking it out also read as the user's
  // removal at the root (pre-tag defect review of D#212, P2-2). Sessions in that subdirectory load
  // both. `keepTracked`: the session-start sync leaves a file git tracks (P2-3).
  if (atRootOnly && !samePath(root, cwd)) return { action: 'absent' };
  // Runs even when the block is already gone (deleted by hand): removeLocalSteering then drops
  // the exclude lines it added (pre-tag defect review, mutation M7).
  const r = removeLocalSteering(root, PLUGIN_SLUG, { keepTracked });
  return r.action === 'absent' ? { action: 'absent' } : { ...r, path: r.path ?? localMdPath(root) };
}

function log(msg) {
  console.log(msg);
}

function detectCwd() {
  return process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
}

function projectsRoot() {
  return join(claudeConfigDir(), 'projects');
}

function listAllMemdirs() {
  const base = projectsRoot();
  if (!existsSync(base)) return [];
  const out = [];
  for (const name of readdirSync(base)) {
    const memdir = join(base, name, 'memory');
    try {
      if (existsSync(memdir) && statSync(memdir).isDirectory()) {
        out.push({ projectSlug: name, memdir });
      }
    } catch {
      /* ignore entries we can't stat */
    }
  }
  return out;
}

function claudeConfigPath() {
  return claudeStatePath();
}

// Real adopted-project paths come from Claude Code's own ~/.claude.json `projects`
// map (keys are absolute cwds Claude Code has opened). The memdir slug under
// ~/.claude/projects/ is a LOSSY encoding that can't be decoded back to a path,
// so this is the only source that lets `unadopt --all` reach scattered CLAUDE.md
// managed blocks. Filtered to absolute, still-existing dirs; claudeMdIsAdopted()
// then gates which actually carry our block. Caveat: a project Claude Code never
// recorded is invisible here and needs a per-project `unadopt`.
function listKnownProjectDirs() {
  const p = claudeConfigPath();
  if (!existsSync(p)) return [];
  try {
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    const projects = cfg && cfg.projects && typeof cfg.projects === 'object' ? Object.keys(cfg.projects) : [];
    return projects.filter((d) => typeof d === 'string' && isAbsolute(d) && existsSync(d));
  } catch {
    return [];
  }
}

function hasFlag(args, flag) {
  return Array.isArray(args) && args.includes(flag);
}

// ─── Per-project auto-adopt opt-out sentinel ─────────────────────────────────
// The `.mem-no-auto-adopt` escape hatch lives in memdir.mjs since report §9-A: lib/quiet-scope.mjs
// has to ask it too (injected steering counts as adopted), and lib/ may not import this face.
export { disableSentinelPath, isAutoAdoptDisabled };

/**
 * cmdAdopt — write the CLAUDE.md managed block + detail doc for the current
 * project, and migrate its legacy memory-dir sentinel away.
 *
 * `--all` does NOT adopt every project (their real paths are unrecoverable from
 * the lossy memdir slug) — it sweeps the legacy memory-dir cleanup across all
 * memdirs. `--status`/`--disable`/`--enable` as before.
 */
export function cmdAdopt(args = []) {
  if (hasFlag(args, '--status')) return statusAll();
  if (hasFlag(args, '--disable')) return cmdDisable(args);
  if (hasFlag(args, '--enable')) return cmdEnable(args);
  if (hasFlag(args, '--all')) return migrateAll(args);

  const force = hasFlag(args, '--force');
  const dryRun = hasFlag(args, '--dry-run');
  const cwd = detectCwd();

  adoptOne(cwd, { force, dryRun });
}

function adoptOne(cwd, { force, dryRun }) {
  const block = buildClaudeMdBlock();
  const doc = getDetailDoc();
  const version = CURRENT_SENTINEL_VERSION;
  // Claude Code stops reading AGENTS.md once a CLAUDE.md exists: the one written here imports
  // the AGENTS.md files beside it and names the ones it cannot import.
  const agents = agentsMdForNewClaudeMd(cwd, PLUGIN_SLUG);
  const imports = agents?.imports ?? [];
  const elsewhere = (verb) =>
    (agents?.elsewhere ?? []).map(
      (p) =>
        `  ⚠ ${p} ${verb} loading in sessions here once CLAUDE.md exists; set Project instructions to claude-md-and-agents-md in /config to keep it`,
    );
  // D#225: at $HOME or `/` the file is above every project there, which no list above can name.
  // Written anyway (adopt was asked to), and said.
  const switchesOffBelow = claudeMdSwitchesOffAgentsBelow(cwd, PLUGIN_SLUG);
  const sharedNote = (verb) =>
    switchesOffBelow
      ? [
          `  ⚠ ${claudeMdPath(cwd)} ${verb} Claude Code reading the AGENTS.md of every project below ${cwd} that has one; to steer one project, run adopt inside it instead${verb === 'stops' ? ' (`claude-mem-lite unadopt` here takes this back)' : ''}, or set Project instructions to claude-md-and-agents-md in /config`,
        ]
      : [];

  if (dryRun) {
    log(`[adopt --dry-run] ${cwd}`);
    log(`  CLAUDE.md block:  ${claudeMdPath(cwd)} (${block.length} chars, ${version})`);
    log(`  detail doc:       ${detailDocPath(cwd, PLUGIN_SLUG)} (${doc.length} chars)`);
    if (imports.length > 0)
      log(`  AGENTS.md:        would import ${imports.join(', ')} at the top of CLAUDE.md`);
    for (const line of elsewhere('would stop')) log(line);
    for (const line of sharedNote('would stop')) log(line);
    if (hasLegacyMemdirSentinel(cwd, PLUGIN_SLUG)) {
      log(`  legacy migrate:   would strip memory-dir sentinel @ ${memdirPath(cwd)}`);
    }
    return { action: 'dry-run' };
  }

  try {
    const mig = migrateLegacyMemoryDir(cwd, PLUGIN_SLUG, { force });
    const r = writeManaged(cwd, { slug: PLUGIN_SLUG, version, block, doc });
    const importNote =
      imports.length > 0 && addAgentsImports(cwd, PLUGIN_SLUG, imports) === 'added'
        ? ` (+imported ${imports.join(', ')}: Claude Code stops reading AGENTS.md once a CLAUDE.md exists)`
        : '';
    const migNote = mig.action === 'removed' ? ' (+migrated legacy memdir)' : '';
    // CLAUDE.md now carries the block; a CLAUDE.local.md copy would load it twice.
    const local = dropLocalSteering(cwd, { atRootOnly: true });
    const localNote =
      local.action === 'absent'
        ? ''
        : local.action === 'skipped-symlink'
          ? ` (left ${local.path} alone: it is a symlink)`
          : local.action === 'failed'
            ? ` (could not remove the block from ${local.path}, so sessions here load it twice)`
            : ` (+removed the block from ${local.path})`;
    log(`[adopt] ${cwd} → ${r.action}${migNote}${localNote}${importNote}`);
    for (const line of elsewhere('stops')) log(line);
    for (const line of sharedNote('stops')) log(line);
    // The copy that could not come out loads beside CLAUDE.md: said, and not a success (R3-4).
    if (local.action === 'failed') {
      if (local.residue) log(`  ⚠ ${local.residue}`);
      process.exitCode = 1;
    }
    return r;
  } catch (e) {
    log(`[adopt] ${cwd} → error: ${e.message}`);
    process.exitCode = 1;
    return { action: 'failed' };
  }
}

/**
 * migrateAll — `claude-mem-lite adopt --all`: legacy-cleanup sweep. Strips the
 * old memory-dir sentinel + detail doc from every memdir. Does NOT write any
 * CLAUDE.md block (target paths are unrecoverable) — that happens per-project on
 * the next SessionStart. Respects the foreign-content guard unless --force.
 */
function migrateAll(args) {
  const force = hasFlag(args, '--force');
  const dryRun = hasFlag(args, '--dry-run');
  const dirs = listAllMemdirs();
  if (dirs.length === 0) {
    log('[adopt --all] no memdirs found');
    return;
  }

  let removed = 0,
    absent = 0,
    skipped = 0;
  for (const { projectSlug, memdir } of dirs) {
    if (dryRun) {
      const has = memdirIsAdopted(memdir, PLUGIN_SLUG);
      const action = !has
        ? 'absent'
        : hasPluginState(memdir, PLUGIN_SLUG) || force
          ? 'would-remove'
          : 'would-skip-foreign';
      log(`[adopt --all --dry-run] ${projectSlug} → ${action}`);
      if (action === 'would-remove') removed++;
      else if (action === 'would-skip-foreign') skipped++;
      else absent++;
      continue;
    }
    const r = removePluginSection(memdir, PLUGIN_SLUG, { force });
    if (r.action === 'removed') {
      removePluginDoc(memdir, PLUGIN_SLUG);
      removed++;
    } else if (r.action === 'skipped-foreign') skipped++;
    else absent++;
  }
  log('');
  log(
    `[adopt --all] legacy memory-dir cleanup over ${dirs.length} project(s): ${removed} cleaned, ${skipped} skipped-foreign, ${absent} none.`,
  );
  log(
    "[adopt --all] CLAUDE.md adoption is per-project — it runs automatically on each project's next SessionStart.",
  );
}

/**
 * silentAutoAdopt — SessionStart idempotent sync (migration vehicle).
 *
 * Called every plugin-mode SessionStart (NOT gated by the one-shot marker, so
 * existing users whose marker predates v3.13 still migrate). Order:
 *   1. respect per-project `.mem-no-auto-adopt` opt-out → skip.
 *   2. migrate legacy memory-dir sentinel away (idempotent; no-op once gone).
 *   3. a managed block in CLAUDE.md → keep it in sync, refreshing if shipped content drifted
 *      (unless CLAUDE_MEM_NO_TEMPLATE_REFRESH=1), and drop a local copy (no double steering). A
 *      file holding only the plugin's lines gets adopt's AGENTS.md import (`agents` in the result).
 *   4. otherwise, inside a git work tree → the block in <top-level>/CLAUDE.local.md, or — where
 *      CLAUDE.local.md would switch off an AGENTS.md (D#212) — in
 *      <top-level>/.claude/rules/claude-mem-lite.md with CLAUDE_MEM_RULES_STEERING=1 or once that
 *      file carries the block, and injected otherwise (step 5), kept out of commits via
 *      info/exclude; return 'local' (`written` says what changed, `file` which file). In a subdirectory, a root CLAUDE.md block →
 *      'already-adopted', a root opt-out → 'disabled'.
 *   5. otherwise (no git, $HOME, a tracked or symlinked file, an npm-publishable root, any git
 *      failure) → write nothing, return 'inject' (the caller puts the steering into SessionStart
 *      context; `detail` says why the rules file was refused in an AGENTS.md repository, `off`
 *      when the switch is all that is missing) — or
 *      'already-adopted' when that file carries the block.
 * Silent: never logs, never throws. Returns { ok, action, reason } for debugLog.
 */
export function silentAutoAdopt({ cwd, markerDir, markerKey }) {
  try {
    if (isAutoAdoptDisabledFor(cwd)) {
      return { ok: true, action: 'disabled', reason: 'disabled-by-sentinel' };
    }
    migrateLegacyMemoryDir(cwd, PLUGIN_SLUG);

    const block = buildClaudeMdBlock();
    const doc = getDetailDoc();
    const version = CURRENT_SENTINEL_VERSION;

    // Report §9-A (docs/audits/20260929-sandbox-usage-eval.md): a project with NO managed
    // block is no longer written into. The first SessionStart used to add CLAUDE.md and
    // .claude/plugin_claude_mem_lite.md to every repository the user opened — 4 of 4 sandbox
    // repos, swept into the next `git add -A` — and the startup dashboard then reported them
    // as the user's uncommitted work. The same text now rides SessionStart context
    // ('inject'); only an explicit `adopt` writes files. A project that already carries the
    // block (adopted explicitly, or by an older version) is kept in sync exactly as before,
    // including a half state whose detail doc went missing.
    //
    // r3 (tasks/specs/sandbox-eval-l3.md, report §8.5): injection kept the repository clean but
    // cost most of the proactive memory writes (1.5 vs 5.25 per trajectory) and never reached
    // subagents (0/12). Inside a git work tree the block now goes to CLAUDE.local.md, which the
    // host loads like CLAUDE.md and info/exclude keeps out of commits (5.25 writes, 12/12).
    const hasBlock = blockIn(cwd);
    if (!hasBlock) {
      if (markerDir && markerKey) writeMarker(markerDir, markerKey);
      const root = localSteeringRoot(cwd);
      if (root) {
        // A session started below the top-level (pre-tag claims review P2-3, P1-4): the host
        // loads the root's CLAUDE.md as an ancestor, so a block there already steers this
        // session; and an opt-out recorded for the root covers the file that lives there.
        if (!samePath(root, cwd)) {
          if (blockIn(root)) return { ok: true, action: 'already-adopted', reason: 'root-claude-md' };
          // Off for the project means off here too: no file, no injected copy, no /adopt offer
          // (delta review P2-2; lib/quiet-scope.mjs mirrors it).
          if (isAutoAdoptDisabledFor(root)) return { ok: true, action: 'disabled', reason: 'root-disabled' };
        }
        const localBlock = buildClaudeMdBlock({ detailDocRef: tildePath(ensureSteeringDetailDoc()) });
        const r = writeLocalSteering(root, {
          slug: PLUGIN_SLUG,
          version,
          block: localBlock,
          frozen: process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH === '1',
          cwd,
        });
        if (r.action !== 'refused')
          return {
            ok: true,
            action: 'local',
            written: r.action,
            file: r.file,
            ...(r.moved ? { moved: true } : {}),
          };
        // A refused file that carries the block anyway (tracked, or behind a link) is loaded by
        // the host: injecting it too would load it twice.
        if (r.present) return { ok: true, action: 'already-adopted', reason: `local-${r.reason}` };
        if (r.reason !== 'agents-md') return { ok: true, action: 'inject', reason: `local-${r.reason}` };
        return {
          ok: true,
          action: 'inject',
          reason: 'local-agents-md',
          detail: r.detail,
          ...agentsWays(root, cwd),
          agentsMd: r.agentsMd,
        };
      }
      return { ok: true, action: 'inject' };
    }
    dropLocalSteering(cwd, { atRootOnly: true, keepTracked: true });
    let action = 'already-adopted';
    if (!claudeMdIsAdopted(cwd, PLUGIN_SLUG)) {
      writeManaged(cwd, { slug: PLUGIN_SLUG, version, block, doc });
      action = 'adopted';
    } else if (
      process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH !== '1' &&
      needsRefresh(cwd, { slug: PLUGIN_SLUG, version, block, doc })
    ) {
      writeManaged(cwd, { slug: PLUGIN_SLUG, version, block, doc });
      action = 'refreshed';
    }
    const agents = syncAgentsImports(cwd);
    if (markerDir && markerKey) writeMarker(markerDir, markerKey);
    return agents ? { ok: true, action, agents } : { ok: true, action };
  } catch (e) {
    try {
      if (markerDir && markerKey) writeMarker(markerDir, markerKey);
    } catch {
      /* best-effort */
    }
    return { ok: false, action: 'skipped', reason: 'error', err: e };
  }
}

// A CLAUDE.md holding nothing but this plugin's lines — the block auto-adopt wrote into every
// project before 6.20.0, or an adopt from before it imported AGENTS.md — switches off the AGENTS.md
// beside it like a new one would (Claude Code 2.1.277+), so it gets the import adopt writes now.
// `imported`: what was added this time (the file changed); `elsewhere`: the AGENTS.md files an
// import cannot keep loading. Null when there is nothing to say. A file with the user's own lines
// is left alone: AGENTS.md was off because of them. CLAUDE_MEM_NO_TEMPLATE_REFRESH=1 freezes the
// file here as it freezes the block; nothing else stops an import the user deleted from coming
// back, as nothing stops a hand-edited block from being refreshed.
function syncAgentsImports(cwd) {
  if (process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH === '1') return null;
  // Not at $HOME or `/` (pre-tag defect review of D#212, P2-5): an import in ~/CLAUDE.md reaches every
  // project below it, each asking to approve an import from outside its directory.
  if (isSharedAncestor(cwd)) return null;
  // The cheap check first: most CLAUDE.md files hold the user's own lines, and the full answer
  // asks git.
  if (!holdsOnlyOwnLines(claudeMdPath(cwd), PLUGIN_SLUG)) return null;
  const agents = agentsMdForNewClaudeMd(cwd, PLUGIN_SLUG);
  if (!agents) return null;
  const imported =
    agents.imports.length > 0 && addAgentsImports(cwd, PLUGIN_SLUG, agents.imports) === 'added'
      ? agents.imports
      : [];
  if (imported.length === 0 && agents.elsewhere.length === 0) return null;
  return { imported, elsewhere: agents.elsewhere };
}

/**
 * The ways to a file that leave AGENTS.md loading, where the rules file was refused (pre-tag claims
 * review P1-1, P2-1). `settingGivesFile`: with Project instructions = claude-md-and-agents-md the
 * plugin writes CLAUDE.local.md, unless that file is refused here too (a package root, a remembered
 * removal). `adoptImports`: `/adopt` in `cwd` imports every AGENTS.md the CLAUDE.md it writes would
 * switch off — not so when one is above `cwd` or tracked below it.
 * @returns {{ settingGivesFile: boolean, adoptImports: boolean }}
 */
function agentsWays(root, cwd) {
  const a = agentsMdForNewClaudeMd(cwd, PLUGIN_SLUG);
  return {
    settingGivesFile: !localMdRefused(root),
    adoptImports: Boolean(a && a.imports.length > 0 && a.elsewhere.length === 0),
  };
}

// Whether `dir`'s CLAUDE.md carries the block. A CLAUDE.md that is a directory or cannot be read
// carries nothing (pre-tag delta review of the D#212 repairs, D9): the sync goes on to a local file
// or injection instead of throwing and leaving the session with no guidance.
function blockIn(dir) {
  try {
    return readBlock(dir, PLUGIN_SLUG).body !== null;
  } catch {
    return false;
  }
}

function writeMarker(markerDir, markerKey) {
  if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true });
  const path = join(markerDir, `.auto-adopt-${markerKey}`);
  writeFileSync(path, JSON.stringify({ firstAttemptAt: new Date().toISOString() }));
}

export function hasAutoAdoptMarker(markerDir, markerKey) {
  return existsSync(join(markerDir, `.auto-adopt-${markerKey}`));
}

/**
 * cmdDisable — `claude-mem-lite adopt --disable [--all]`.
 * Writes `<memdir>/.mem-no-auto-adopt` so SessionStart auto-adopt skips this
 * project permanently. Does NOT remove a CLAUDE.md block (the user asked for that one, by
 * running adopt) — pair with `unadopt`. DOES remove the CLAUDE.local.md block, which
 * auto-adopt wrote on its own: "turn the guidance off here" has to mean it stops loading.
 */
function cmdDisable(args) {
  const all = hasFlag(args, '--all');
  const localTargets = all ? listKnownProjectDirs() : [detectCwd()];
  for (const dir of localTargets) {
    const r = dropLocalSteering(dir);
    if (r.action !== 'absent') log(`[adopt --disable] ${r.path} → ${r.action}`);
    if (r.residue) log(`  ⚠ ${r.residue}`);
    if (r.action === 'failed') process.exitCode = 1;
  }
  // Known projects too, not only memdirs that already exist: Claude Code creates `memory/`
  // only when its auto-memory is used, and a project without one was left armed (pre-tag
  // defect review P2-4).
  const targets = all
    ? [
        ...new Set([
          ...listAllMemdirs().map((m) => m.memdir),
          ...listKnownProjectDirs().map((d) => memdirPath(d)),
        ]),
      ]
    : [memdirPath(detectCwd())];

  if (targets.length === 0) {
    log('[adopt --disable] no memdirs found');
    return;
  }

  let disabled = 0,
    already = 0;
  for (const memdir of targets) {
    if (!existsSync(memdir)) mkdirSync(memdir, { recursive: true });
    const path = disableSentinelPath(memdir);
    if (existsSync(path)) {
      log(`[adopt --disable] ${memdir} → already-disabled`);
      already++;
      continue;
    }
    writeFileSync(path, JSON.stringify({ disabledAt: new Date().toISOString() }) + '\n');
    log(`[adopt --disable] ${memdir} → disabled`);
    disabled++;
  }
  log('');
  log(
    `[adopt --disable] ${targets.length} target(s): ${disabled} newly disabled, ${already} already disabled`,
  );
}

/**
 * cmdEnable — `claude-mem-lite adopt --enable [--all]`. Removes the
 * `.mem-no-auto-adopt` sentinel so the next SessionStart can auto-adopt again.
 */
function cmdEnable(args) {
  const all = hasFlag(args, '--all');
  // Re-arm the CLAUDE.local.md block too: a block the user or `unadopt` removed is not written
  // back until this forgets that it was (lib/local-steering.mjs).
  for (const dir of all ? listKnownProjectDirs() : [detectCwd()]) {
    const root = localSteeringRoot(dir);
    if (root && forgetLocalSteering(root))
      log(`[adopt --enable] ${root}: the next session may write the local steering file again`);
  }
  // The legacy ~/.claude memdir too: isAutoAdoptDisabledFor still honours a sentinel an earlier
  // version left there, so --enable must be able to remove it.
  const cwdNow = detectCwd();
  const targets = all
    ? listAllMemdirs().map((m) => m.memdir)
    : [memdirPath(cwdNow), legacyMemdirPath(cwdNow)].filter(Boolean);

  if (targets.length === 0) {
    log('[adopt --enable] no memdirs found');
    return;
  }

  let enabled = 0,
    absent = 0;
  for (const memdir of targets) {
    const path = disableSentinelPath(memdir);
    if (!existsSync(path)) {
      log(`[adopt --enable] ${memdir} → absent`);
      absent++;
      continue;
    }
    try {
      unlinkSync(path);
    } catch {
      /* best-effort */
    }
    log(`[adopt --enable] ${memdir} → enabled`);
    enabled++;
  }
  log('');
  log(`[adopt --enable] ${targets.length} target(s): ${enabled} re-enabled, ${absent} not-disabled`);
}

/**
 * statusAll — report the current project's new-scheme adoption, plus a sweep of
 * how many memdirs still carry the legacy sentinel (i.e. await migration).
 */
// The `local:` line of `adopt --status`: the file that carries the block, or why there is none and
// what changes it — from the same checks the next session runs (planLocalSteering), so it does not
// promise a file that session would refuse (pre-tag claims review P2-2).
function localSteeringStatus(cwd) {
  const root = localSteeringRoot(cwd);
  const runs = autoAdoptRuns(cwd, root);
  // CLAUDE.md first: where it carries the block, no local file is written and nothing is injected,
  // in a git work tree or not (pre-tag delta review of the D#212 repairs, D11).
  if (blockIn(cwd) || (root && blockIn(root))) {
    const cur = root ? readLocalSteering(root, PLUGIN_SLUG) : null;
    if (cur === null || cur.body === null) return '— none: CLAUDE.md carries the block';
    const kept = localFileLinked(root, cur.path)
      ? 'behind a symbolic link'
      : trackedByGit(root, relative(root, cur.path))
        ? 'tracked by git'
        : null;
    // The sync takes the copy out only from a session at the root, when it runs, and where it can
    // (round-3 review, R3-6, R3-4); otherwise both load.
    if (!kept && runs && samePath(root, cwd) && removable(cur.path))
      return `— none: CLAUDE.md carries the block (the local copy in ${cur.path} is removed at the next session start)`;
    return `⚠ CLAUDE.md carries the block, and ${cur.path} also does${kept ? ` (${kept}; the plugin leaves it as it is)` : ''}: sessions here load it twice`;
  }
  if (root) {
    const cur = readLocalSteering(root, PLUGIN_SLUG);
    if (cur.body !== null) return currentLocalLine(root, cwd, cur, runs);
  }
  // Before "not a git work tree": with auto-adopt off nothing is injected either (R3-13).
  if (isAutoAdoptDisabledFor(cwd) || (root && isAutoAdoptDisabledFor(root)))
    return '— none: auto-adopt is off for this project (`claude-mem-lite adopt --enable` turns it back on)';
  if (process.env.MEM_NO_AUTO_ADOPT === '1')
    return '— none: MEM_NO_AUTO_ADOPT=1, so no local file is written';
  if (!root)
    return '— none here: not a git work tree, or its root is $HOME or / (steering is injected at session start)';
  if (localSteeringRemembered(root)) {
    const removed =
      '✗ removed: deleted by you or unadopt, so it is not written again (steering is injected at session start)';
    // Beside an AGENTS.md, --enable alone writes nothing with the rules file switched off (pre-tag
    // opt-in review F2), and neither does the switch where the rules file is refused anyway (delta
    // review F-1).
    const plan = planLocalSteering(root, PLUGIN_SLUG, cwd);
    const beside = plan.agentsMd ?? 'the AGENTS.md';
    if (plan.file === RULES_MD && plan.refusal === 'off')
      return `${removed}; beside ${beside} a file comes back only with CLAUDE_MEM_RULES_STEERING=1 and then \`claude-mem-lite adopt --enable\``;
    if (plan.file === RULES_MD && plan.refusal)
      return `${removed}; beside ${beside}, ${rulesWhy(plan.refusal)}`;
    return `${removed}; after \`claude-mem-lite adopt --enable\` the next session may write it again`;
  }
  const plan = planLocalSteering(root, PLUGIN_SLUG, cwd);
  if (!plan.refusal)
    return `— none yet: the next session writes ${join(root, plan.file)}${plan.agentsMd ? ` (a CLAUDE.local.md would stop Claude Code reading ${plan.agentsMd})` : ''}`;
  if (plan.file === LOCAL_MD)
    return `✗ not written: CLAUDE.local.md ${LOCAL_REFUSAL_TEXT[plan.refusal]} (steering is injected at session start)`;
  const ways = agentsWays(root, cwd);
  const alt = [
    ways.settingGivesFile
      ? 'set Project instructions to claude-md-and-agents-md in /config and CLAUDE.local.md is written instead'
      : null,
    ways.adoptImports ? 'run `claude-mem-lite adopt`, whose CLAUDE.md imports AGENTS.md' : null,
  ].filter(Boolean);
  return `✗ not written: Claude Code stops reading ${plan.agentsMd ?? 'the AGENTS.md'} once a CLAUDE.local.md exists, and ${rulesWhy(plan.refusal)} (steering is injected at session start${alt.length ? `; ${alt.join(', or ')}` : ''})`;
}

// The `local:` line for a local file that carries the block: what the next session does with it,
// from the same checks that session runs (round-3 review, R3-1, R3-13). A ✓ said "excluded from
// git" of a file a `.gitignore` rule let through, and of one the next session takes out or moves.
function currentLocalLine(root, cwd, cur, runs) {
  const rel = relative(root, cur.path);
  if (localFileLinked(root, cur.path))
    return `✓ ${cur.path} (behind a symbolic link; the plugin leaves it as it is)`;
  if (trackedByGit(root, rel)) return `✓ ${cur.path} (tracked by git; the plugin leaves it as it is)`;
  const plan = runs ? planLocalSteering(root, PLUGIN_SLUG, cwd) : null;
  if (plan?.refusal) {
    const why =
      plan.file === LOCAL_MD
        ? `CLAUDE.local.md ${LOCAL_REFUSAL_TEXT[plan.refusal]}`
        : rel === LOCAL_MD
          ? `a CLAUDE.local.md stops Claude Code reading ${plan.agentsMd}, and ${rulesWhy(plan.refusal)}`
          : RULES_REFUSAL_TEXT[plan.refusal];
    // That session loaded the file, so it gets no injected copy; the ones after it do.
    return `⚠ ${cur.path} (auto-written, but ${why}: the next session removes it, and the steering is injected after that)`;
  }
  if (plan && plan.file !== rel)
    return `✓ ${cur.path} (auto-written, excluded from git; the next session moves it to ${join(root, plan.file)}: a CLAUDE.local.md stops Claude Code reading ${plan.agentsMd})`;
  if (!ignoredByGit(root, rel))
    return `⚠ ${cur.path} (auto-written, but git sees it: a .gitignore rule outranks .git/info/exclude)`;
  return `✓ ${cur.path} (auto-written, excluded from git)`;
}

// Why there is no rules file, as the second half of a sentence. Off is a switch, not a failure.
function rulesWhy(refusal) {
  return refusal === 'off'
    ? `${RULES_MD} is written only with CLAUDE_MEM_RULES_STEERING=1`
    : `${RULES_MD} cannot be written here: ${RULES_REFUSAL_TEXT[refusal]}`;
}

// Whether the next session start runs the sync that writes, moves and removes the local file.
function autoAdoptRuns(cwd, root) {
  return (
    process.env.MEM_NO_AUTO_ADOPT !== '1' &&
    !isAutoAdoptDisabledFor(cwd) &&
    !(root && isAutoAdoptDisabledFor(root))
  );
}

// Whether `p` can be edited or deleted, so a promise to take it out can be kept (R3-4).
function removable(p) {
  try {
    accessSync(p, fsConstants.W_OK);
    accessSync(dirname(p), fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// CLAUDE.md read for a report: a directory or an unreadable file there crashed `adopt --status`
// and the `unadopt` dry runs (round-3 review, R3-7). `null` = it cannot be read.
function safely(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

function statusAll() {
  const cwd = detectCwd();
  const adoptedHere = safely(() => claudeMdIsAdopted(cwd, PLUGIN_SLUG));
  log('[adopt --status] current project:');
  log(`  cwd:        ${cwd}`);
  log(
    `  CLAUDE.md:  ${adoptedHere === null ? '✗ cannot be read (a directory, or no permission)' : adoptedHere ? `✓ adopted (${CURRENT_SENTINEL_VERSION})` : '✗ not adopted'}`,
  );
  log(`  local:      ${localSteeringStatus(cwd)}`);
  if (hasLegacyMemdirSentinel(cwd, PLUGIN_SLUG)) {
    log('  legacy:     ⚠ memory-dir sentinel still present (migrates on next SessionStart, or run `adopt`)');
  }

  const dirs = listAllMemdirs();
  let legacy = 0,
    disabled = 0;
  for (const { memdir } of dirs) {
    if (memdirIsAdopted(memdir, PLUGIN_SLUG)) legacy++;
    if (isAutoAdoptDisabled(memdir)) disabled++;
  }
  log('');
  log(
    `[adopt --status] scanned ${dirs.length} memdir(s): ${legacy} with legacy sentinel (await migration), ${disabled} auto-adopt-disabled.`,
  );
  if (legacy > 0)
    log('[adopt --status] run `claude-mem-lite adopt --all` to sweep legacy memory-dir sentinels now.');

  const known = listKnownProjectDirs();
  let adoptedCount = 0;
  for (const dir of known) if (safely(() => claudeMdHasResidue(dir, PLUGIN_SLUG))) adoptedCount++;
  log(
    `[adopt --status] known projects (~/.claude.json): ${known.length} scanned, ${adoptedCount} with a CLAUDE.md managed block or partial residue (detail doc/state).`,
  );
  if (adoptedCount > 0)
    log('[adopt --status] run `claude-mem-lite unadopt --all` to remove every CLAUDE.md block.');

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ? 'set' : 'unset';
  const noAutoAdopt = process.env.MEM_NO_AUTO_ADOPT === '1' ? '1 (opt-out)' : 'unset';
  log('');
  log('Auto-adopt gates (next SessionStart fires only if these pass):');
  log(
    `  CLAUDE_PLUGIN_ROOT  = ${pluginRoot}  (any install path is consent; gate is the per-project opt-out below)`,
  );
  log(`  MEM_NO_AUTO_ADOPT   = ${noAutoAdopt}  (global escape hatch)`);
  log('Per-project opt-out: `claude-mem-lite adopt --disable` (run --enable to re-arm).');
}

/**
 * cmdUnadopt — remove the CLAUDE.md managed block + detail doc for the current
 * project, and clean any legacy memory-dir residue. `--all` sweeps the legacy
 * memory-dir cleanup across every memdir (CLAUDE.md blocks for other projects
 * can't be located from the lossy slug). Idempotent: exit code stays 0.
 */
/**
 * unadoptAll — `claude-mem-lite unadopt --all`. Removes the CLAUDE.md managed
 * block + detail doc from EVERY adopted project Claude Code knows about (real
 * paths from ~/.claude.json `projects`), then sweeps the legacy memory-dir
 * residue across all memdirs. removeManaged is slug-scoped, so user content and
 * other plugins' blocks are never touched. Honors --dry-run / --force.
 *
 * Unlike `adopt --all` (still a legacy-only sweep — adopting arbitrary projects
 * is unsafe), unadopt is purely subtractive, so reaching every known project is
 * both safe and what the uninstall hint promises.
 */
function unadoptAll(args) {
  const force = hasFlag(args, '--force');
  const dryRun = hasFlag(args, '--dry-run');

  // 1. New scheme: scrub CLAUDE.md managed blocks across known project paths.
  const projectDirs = listKnownProjectDirs();
  let blocks = 0,
    partial = 0,
    locals = 0,
    failures = 0;
  for (const dir of projectDirs) {
    // One project the sweep cannot read (a directory where a file belongs) ended the whole sweep
    // with a stack trace (round-3 review, R3-7): said, counted, and the sweep goes on.
    try {
      const r = unadoptProject(dir, dryRun);
      blocks += r.blocks;
      partial += r.partial;
      locals += r.locals;
      failures += r.failures;
    } catch (e) {
      log(`[unadopt --all] ${dir} → error: ${e?.message ?? e}`);
      failures++;
    }
  }

  // 2. Legacy memory-dir cleanup across every memdir (foreign-content guarded).
  const dirs = listAllMemdirs();
  let legacy = 0;
  for (const { memdir } of dirs) {
    if (dryRun) {
      if (memdirIsAdopted(memdir, PLUGIN_SLUG) && (hasPluginState(memdir, PLUGIN_SLUG) || force)) legacy++;
      continue;
    }
    const r = removePluginSection(memdir, PLUGIN_SLUG, { force });
    if (r.action === 'removed') {
      removePluginDoc(memdir, PLUGIN_SLUG);
      legacy++;
    }
  }

  log('');
  const partialNote = partial > 0 ? ` (+${partial} partial-residue cleanup(s))` : '';
  const failedNote = failures > 0 ? `; ${failures} could not be removed (see above)` : '';
  log(
    `[unadopt --all] ${dryRun ? 'would remove' : 'removed'} ${blocks} CLAUDE.md block(s)${partialNote} and ${locals} local-file block(s) across ${projectDirs.length} known project(s); ${legacy} legacy memory-dir sentinel(s) ${dryRun ? 'pending' : 'cleaned'}${failedNote}.`,
  );
  if (failures > 0) process.exitCode = 1;
  if (projectDirs.length === 0) {
    log(
      '[unadopt --all] no known projects found in ~/.claude.json — if a project was adopted but never opened in Claude Code, run `claude-mem-lite unadopt` from inside it.',
    );
  }
}

// One known project of `unadopt --all`: its local-file block, then its CLAUDE.md residue.
function unadoptProject(dir, dryRun) {
  const n = { blocks: 0, partial: 0, locals: 0, failures: 0 };
  // The local-file block auto-adopt writes (CLAUDE.local.md or the rules file) is swept first and
  // independently: a project carries one or the other, and either way nothing of ours should
  // survive.
  const root = localSteeringRoot(dir);
  const cur = root ? readLocalSteering(root, PLUGIN_SLUG) : null;
  if (cur && cur.body !== null) {
    if (dryRun) {
      log(`[unadopt --all --dry-run] ${cur.path} → would-remove`);
      n.locals++;
    } else {
      const lr = removeLocalSteering(root, PLUGIN_SLUG);
      log(`[unadopt --all] ${lr.path ?? cur.path} → ${lr.action}`);
      if (lr.residue) log(`  ⚠ ${lr.residue}`);
      // A block that could not come out is not counted as removed (R3-4).
      if (lr.action === 'failed') n.failures++;
      else n.locals++;
    }
  }
  // hasResidue, not isAdopted: the sweep must also catch PARTIAL residue
  // (block without detail doc, or an orphaned doc/state sidecar) —
  // isAdopted's block-AND-doc gate skipped those projects forever.
  if (!claudeMdHasResidue(dir, PLUGIN_SLUG)) return n;
  if (dryRun) {
    log(
      `[unadopt --all --dry-run] ${dir} → would-remove plugin residue (CLAUDE.md block and/or detail doc/state)`,
    );
    n.blocks++;
    return n;
  }
  const r = removeManaged(dir, PLUGIN_SLUG);
  if (r.action === 'removed') {
    log(`[unadopt --all] ${dir} → removed`);
    n.blocks++;
  } else {
    log(`[unadopt --all] ${dir} → cleaned partial residue (detail doc/state, no block)`);
    n.partial++;
  }
  // OUTSIDE the branch, because residue is orthogonal to what happened to the block: a
  // project can have its block removed AND still carry an unpaired sentinel. An orphan is
  // the one kind of residue the sweep cannot finish — its block has no end marker, so its
  // extent is unknowable — and the two lines above would otherwise imply the project is
  // clean. Inside the else-branch it was also unreachable for the 'removed' case, which is
  // how the print survived a mutation with the whole suite green (pre-ship review P2-2).
  if (r.residue) log(`  ⚠ ${r.residue}`);
  return n;
}

export function cmdUnadopt(args = []) {
  if (hasFlag(args, '--status')) return statusAll();

  const all = hasFlag(args, '--all');
  const dryRun = hasFlag(args, '--dry-run');
  const force = hasFlag(args, '--force');

  if (all) return unadoptAll(args);

  const cwd = detectCwd();
  if (dryRun) {
    const root = localSteeringRoot(cwd);
    const cur = root ? readLocalSteering(root, PLUGIN_SLUG) : null;
    if (cur && cur.body !== null) log(`[unadopt --dry-run] would-remove the block in ${cur.path}`);
    const residue = safely(() => claudeMdHasResidue(cwd, PLUGIN_SLUG));
    const blockState =
      residue === null
        ? 'CLAUDE.md cannot be read (a directory, or no permission)'
        : residue
          ? 'would-remove CLAUDE.md block + detail doc'
          : 'no CLAUDE.md block';
    const legacy = hasLegacyMemdirSentinel(cwd, PLUGIN_SLUG)
      ? 'would-clean legacy memory-dir sentinel'
      : 'no legacy residue';
    log(`[unadopt --dry-run] ${cwd}`);
    log(`  ${blockState}`);
    log(`  ${legacy}`);
    return;
  }

  const r = removeManaged(cwd, PLUGIN_SLUG);
  const mig = migrateLegacyMemoryDir(cwd, PLUGIN_SLUG, { force });
  const migNote = mig.action === 'removed' ? ' (+cleaned legacy memdir)' : '';
  log(`[unadopt] ${cwd} → ${r.action}${migNote}`);
  const local = dropLocalSteering(cwd);
  if (local.action !== 'absent') log(`[unadopt] ${local.path} → ${local.action}`);
  if (local.residue) log(`  ⚠ ${local.residue}`);
  if (local.action === 'failed') process.exitCode = 1;
  // 'partial' is the outcome that used to print as 'absent': the sidecar files are gone but
  // an unpaired sentinel still holds steering text in the user's CLAUDE.md, and only they can
  // decide where that text ends. Silence here is what let it survive every sweep.
  if (r.residue) log(`  ⚠ ${r.residue}`);
}
