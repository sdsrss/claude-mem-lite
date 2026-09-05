// lib/plan-reader.mjs — list recent plan files under ~/.claude/plans/ (T10b).
// For startup-dashboard (T10c); pure function; silent on I/O errors.
//
// Real schema observed in Claude Code ~/.claude/plans/ (2026-04):
//   Flat directory of *.md files at root level. No nesting by project.
//   Example: `imperative-baking-hamster.md`, `zippy-frolicking-liskov.md`.

import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DEFAULT_PLANS_ROOT = join(homedir(), '.claude', 'plans');

/**
 * Return up to `limit` most recently modified .md plan files.
 *
 * @param {object} [options]
 * @param {string} [options.plansRoot=~/.claude/plans] - Override root (testing).
 * @param {number} [options.limit=5]
 * @returns {Array<{name:string, path:string, mtime:number}>} name is the basename without .md
 */
export function recentPlans({ plansRoot = DEFAULT_PLANS_ROOT, limit = 5 } = {}) {
  let files;
  try {
    files = readdirSync(plansRoot);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      let mtime = 0;
      try {
        mtime = statSync(join(plansRoot, f)).mtimeMs;
      } catch {
        // Race: file vanished between readdir and stat. Keep entry with mtime=0
        // so it sorts last; caller sees a stable name at worst.
      }
      return { name: f.replace(/\.md$/, ''), path: join(plansRoot, f), mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}
