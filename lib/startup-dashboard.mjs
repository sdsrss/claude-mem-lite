// lib/startup-dashboard.mjs — aggregates git/tasks/plans/handoff/events stats
// into a single SessionStart injection line (T10c v2.31).
//
// Pure function (with injectable stubs for test determinism). Never throws:
// every external reader is try/catch'd so a broken git repo, missing tasks dir,
// or absent events table cannot break SessionStart.

import { readGitState } from './git-state.mjs';
import { readProjectTasks } from './task-reader.mjs';
import { recentPlans } from './plan-reader.mjs';
import { isAdoptedHere } from './quiet-scope.mjs';
import { HANDOFF_EXPIRY_EXIT } from './handoff-constants.mjs';

function ageStr(ms) {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function readRecentHandoff(db, project) {
  try {
    // Only surface a handoff the UserPromptSubmit injection could actually deliver: apply
    // the SAME expiry the injection's pickHandoffToInject enforces (HANDOFF_EXPIRY_EXIT).
    // Without this the dashboard promised "context injects on your next message" for an
    // exit handoff >7d old that pickHandoffToInject filters as expired → the promise could
    // never be kept (batch2-reviewer Finding 1).
    return db
      .prepare(
        `
      SELECT created_at_epoch, working_on FROM session_handoffs
      WHERE project = ? AND type = 'exit' AND created_at_epoch > ?
      ORDER BY created_at_epoch DESC LIMIT 1
    `,
      )
      .get(project, Date.now() - HANDOFF_EXPIRY_EXIT);
  } catch {
    return null;
  }
}

/**
 * Build the dashboard injection string, or empty string when all sources empty.
 *
 * @param {object} options
 * @param {object} options.db - better-sqlite3 handle. May be null.
 * @param {string} options.project - project identifier used for handoff/events queries.
 * @param {string} [options.projectPath=process.cwd()] - filesystem root for git + tasks.
 * @param {object} [options.stubs] - per-field test injectors:
 *        {git?, tasks?, plans?, handoff?}. handoff: pass explicit null to skip;
 *        omit to fall through to DB query.
 * @returns {string} rendered dashboard or '' if no content.
 */
export function buildDashboard({ db, project, projectPath = process.cwd(), stubs = null } = {}) {
  const git = stubs?.git ?? readGitState({ cwd: projectPath });
  const tasks = stubs?.tasks ?? readProjectTasks({ projectPath });
  const plans = stubs?.plans ?? recentPlans({ limit: 3 });
  // stubs.handoff === null means "test asserted no handoff"; undefined means "query DB".
  const handoff = stubs && 'handoff' in stubs ? stubs.handoff : readRecentHandoff(db, project);

  let eventCount = 0;
  try {
    eventCount = db?.prepare(`SELECT COUNT(*) c FROM events WHERE project = ?`).get(project)?.c ?? 0;
  } catch {
    /* events table may not exist on very old DBs */
  }

  const parts = [];

  if ((git?.changed?.length ?? 0) > 0 || (git?.stashes?.length ?? 0) > 0) {
    parts.push('📊 Git:');
    if (git.changed.length > 0) {
      parts.push(`  - ${git.changed.length} uncommitted file(s) on ${git.branch || 'HEAD'}`);
    }
    if (git.stashes.length > 0) {
      parts.push(`  - ${git.stashes.length} stash(es)`);
    }
  }

  if (tasks.length > 0) {
    parts.push('📋 Active tasks:');
    for (const t of tasks.slice(0, 3)) {
      parts.push(`  - [${t.status}] ${t.title}`);
    }
    if (tasks.length > 3) parts.push(`  - (… +${tasks.length - 3} more)`);
  }

  if (plans.length > 0) {
    parts.push('📝 Recent plans:');
    for (const p of plans.slice(0, 2)) {
      parts.push(`  - ${p.name} (${ageStr(p.mtime)})`);
    }
  }

  if (handoff) {
    // Continuation POINTER only. The working_on CONTENT is delivered once — by the
    // UserPromptSubmit <session-handoff> block on a continuation-intent prompt
    // (renderHandoffInjection). Emitting the teaser here too double-injected working_on
    // into the model's context on every resume (post-defang: redundant, not unsafe).
    // Wording is CONDITIONAL ("resume it to restore"), not a promise of automatic
    // injection: the injection is gated on continuation-intent, so on a genuinely new
    // first task the gate stays silent (stale working_on correctly not injected) and the
    // pointer must not claim otherwise. readRecentHandoff already drops handoffs older than
    // the injection's own expiry, so a shown pointer is always deliverable on resume.
    parts.push(
      `🔄 Continuation available (/exit ${ageStr(handoff.created_at_epoch)}) — resume it to restore the full context.`,
    );
  }

  if (eventCount > 0) {
    parts.push(`💡 mem events: ${eventCount} entries (\`claude-mem-lite activity recent\`)`);
  }

  // Invited-memory hint (Phase F): persists every SessionStart until the user
  // adopts. Self-clearing — once the sentinel exists, isAdoptedHere() flips to
  // true and this line silently drops. MEM_NO_ADOPT_HINT=1 opts out permanently
  // for users who prefer the verbose hook layer.
  const adoptHint = buildAdoptHint({ projectPath, stubs });
  if (adoptHint) parts.push(adoptHint);

  if (parts.length === 0) return '';
  return `[mem] Startup dashboard:\n${parts.join('\n')}`;
}

function buildAdoptHint({ projectPath, stubs }) {
  if (process.env.MEM_NO_ADOPT_HINT === '1') return null;
  if (process.env.MEM_QUIET_HOOKS === '1') return null;
  // stubs.adopted === true/false lets tests assert both branches without touching FS.
  const adopted = stubs && 'adopted' in stubs ? stubs.adopted : isAdoptedHere(projectPath);
  if (adopted) return null;
  return '🧷 Invited-memory 未启用：`claude-mem-lite adopt` 写入 CLAUDE.md 托管块（通常每会话自动）→ 上下文省 ~40%，MCP 调用率提升；静音 `MEM_NO_ADOPT_HINT=1`';
}
