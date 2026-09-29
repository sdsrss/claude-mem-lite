// lib/task-reader.mjs — parse ~/.claude/tasks/<taskListId>/*.json for startup dashboard (T10a).
//
// Pure function over the filesystem. Filters to pending + in_progress tasks for a given project.
// Never throws — hooks must not break Claude Code. All I/O errors (ENOENT, permission denied,
// malformed JSON, races between readdir/stat) are silently skipped.
//
// Real schema observed in Claude Code ~/.claude/tasks/ (2026-04):
//   - No `meta.json` files exist. Task dirs contain only `<taskId>.json` + hidden
//     `.lock` / `.highwatermark` files.
//   - Tasks use fields: `id`, `subject`, `activeForm`, `description`, `status`,
//     `blocks`, `blockedBy`. Statuses: pending | in_progress | completed.
//   - Project → taskListId mapping lives at `~/.claude/projects/<mangled>/<taskListId>/`
//     where mangling = replace `/` with `-`.
//
// The v2.31 plan's fixture assumed a `meta.json`-based shape that is not how Claude Code
// actually organises tasks. This reader supports BOTH shapes so tests (which use meta.json
// per the plan) and runtime (which uses projectsRoot probing) both work:
//
//   Priority 1 — fixture / future-proof: if `<dir>/meta.json` exists and contains
//                `projectPath`, use it for project filtering.
//   Priority 2 — real Claude Code: if `projectsRoot/<mangled>/<taskListId>/` exists,
//                the task list belongs to `projectPath`.
//   Priority 3 — no `projectPath` filter supplied: include all tasks.
//
// Normalized output uses `title` (falls back to `subject` → `'(untitled)'`) so T10c has
// a single contract regardless of source shape.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { claudeConfigDir } from './data-paths.mjs';

const ACTIVE_STATUSES = new Set(['pending', 'in_progress']);

/**
 * Replace every non-alphanumeric character with `-`, mirroring Claude Code's
 * `~/.claude/projects/<mangled>/` naming convention.
 *
 * Evidence from `~/.claude/projects/` listing (verified 2026-04):
 *   /mnt/data_ssd/dev/projects/mem     → -mnt-data-ssd-dev-projects-mem     (`/` and `_` → `-`)
 *   /home/sds/.claude/plugins/...      → -home-sds--claude-plugins-...      (leading `.` → `-`, so `/.` → `--`)
 *   /mnt/data/hdd/project / /agent     → -mnt-data-hdd-project---agent      (spaces/slashes → `-`)
 *
 * @param {string} p - Absolute project path.
 * @returns {string} Mangled form suitable for `~/.claude/projects/<mangled>/`.
 */
function manglePath(p) {
  return String(p).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Read active tasks (pending + in_progress) across all task lists that belong to a given
 * project. Output is sorted by mtime DESC and capped at `maxTasks`.
 *
 * @param {object} [options]
 * @param {string} [options.tasksRoot=~/.claude/tasks] - Override tasks root (testing).
 * @param {string} [options.projectsRoot=~/.claude/projects] - Override projects root (testing).
 * @param {string} [options.projectPath] - Absolute project path to filter by. When undefined,
 *                                         returns tasks from every task list encountered.
 * @param {number} [options.maxTasks=20] - Cap on returned tasks.
 * @returns {Array<{id:string,title:string,status:string,taskListId:string,mtime:number}>}
 */
export function readProjectTasks({
  tasksRoot = join(claudeConfigDir(), 'tasks'),
  projectsRoot = join(claudeConfigDir(), 'projects'),
  projectPath,
  maxTasks = 20,
} = {}) {
  let listIds;
  try {
    listIds = readdirSync(tasksRoot);
  } catch {
    return [];
  }

  // Pre-compute the set of taskListIds registered under the project via projectsRoot
  // (real Claude Code layout). Used as a fallback when meta.json is absent.
  let projectListIds = null;
  if (projectPath) {
    try {
      const mangled = manglePath(projectPath);
      projectListIds = new Set(readdirSync(join(projectsRoot, mangled)));
    } catch {
      projectListIds = new Set();
    }
  }

  const out = [];
  outer: for (const id of listIds) {
    const dir = join(tasksRoot, id);

    // Project filter: meta.json (priority 1) → projectsRoot probe (priority 2) → all.
    if (projectPath) {
      let belongs;
      try {
        const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
        belongs = meta && meta.projectPath === projectPath;
      } catch {
        // No meta.json (or malformed) — fall back to real Claude Code layout.
        belongs = projectListIds.has(id);
      }
      if (!belongs) continue;
    }

    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const f of entries) {
      // Skip non-task files: meta.json, hidden .lock / .highwatermark, non-JSON.
      if (f === 'meta.json') continue;
      if (f.startsWith('.')) continue;
      if (!f.endsWith('.json')) continue;

      const filePath = join(dir, f);
      let task;
      try {
        task = JSON.parse(readFileSync(filePath, 'utf8'));
      } catch {
        continue;
      }
      if (!task || !ACTIVE_STATUSES.has(task.status)) continue;

      let mtime;
      try {
        mtime = statSync(filePath).mtimeMs;
      } catch {
        // Race: file disappeared between readdir and stat. Skip silently.
        continue;
      }

      out.push({
        id: task.id || f.replace(/\.json$/, ''),
        // Normalize: plan's `title` → real Claude Code's `subject` → fallback literal.
        title: task.title || task.subject || '(untitled)',
        status: task.status,
        taskListId: id,
        mtime,
      });
      if (out.length >= maxTasks) break outer;
    }
  }

  return out.sort((a, b) => b.mtime - a.mtime);
}
