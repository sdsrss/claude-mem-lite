// claude-mem-lite: Shared resource discovery — filesystem traversal for skills/agents
// Used by registry-scanner.mjs (runtime) and scripts/index-managed.mjs (offline)

import { existsSync, readdirSync, statSync } from 'fs';
import { join, basename, relative } from 'path';

/**
 * @typedef {object} DiscoveredResource
 * @property {'skill'|'agent'} type
 * @property {string} name Resource name (flat: basename, plugin: "plugin/name")
 * @property {string} absPath Absolute path to content file or directory
 * @property {string|null} parentPlugin Plugin name if nested, null if standalone
 */

// ─── Skill File Resolution ───────────────────────────────────────────────────

/**
 * Find the primary SKILL.md file within a skill directory.
 * Checks direct, .claude/skills/*, and skills/* paths.
 * @param {string} dir Skill directory
 * @returns {string|null} Absolute path to SKILL.md or null
 */
export function findSkillMd(dir) {
  const direct = join(dir, 'SKILL.md');
  if (existsSync(direct)) return direct;

  // .claude/skills/*/SKILL.md
  const dotClaude = join(dir, '.claude', 'skills');
  if (existsSync(dotClaude)) {
    try {
      for (const sub of readdirSync(dotClaude)) {
        const nested = join(dotClaude, sub, 'SKILL.md');
        if (existsSync(nested)) return nested;
      }
    } catch {}
  }

  // skills/*/SKILL.md (repos cloned as-is)
  const skillsDir = join(dir, 'skills');
  if (existsSync(skillsDir)) {
    try {
      for (const sub of readdirSync(skillsDir)) {
        const nested = join(skillsDir, sub, 'SKILL.md');
        if (existsSync(nested)) return nested;
      }
    } catch {}
  }
  return null;
}

// ─── Flat Discovery ──────────────────────────────────────────────────────────

/**
 * Discover resources in a flat directory (one resource per subdirectory).
 * @param {string} dirPath Directory to scan
 * @param {'skill'|'agent'} type Resource type
 * @param {object} [opts]
 * @param {string[]} [opts.skipNames] Directory names to skip
 * @param {boolean} [opts.strict=true] When false, skill dirs without SKILL.md are still discovered
 * @param {boolean} [opts.includeFiles=false] When true, loose .md files are also returned
 * @returns {DiscoveredResource[]}
 */
export function discoverFlat(dirPath, type, opts = {}) {
  if (!existsSync(dirPath)) return [];
  const skipNames = new Set(opts.skipNames || []);
  const strict = opts.strict !== false;
  const includeFiles = opts.includeFiles || false;

  const items = [];
  for (const name of readdirSync(dirPath)) {
    if (name.startsWith('.') || name === 'node_modules' || skipNames.has(name)) continue;
    const fullPath = join(dirPath, name);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (type === 'skill') {
        const skillMd = findSkillMd(fullPath);
        if (skillMd) {
          items.push({ type: 'skill', name, absPath: skillMd, parentPlugin: null });
        } else if (!strict) {
          items.push({ type: 'skill', name, absPath: fullPath, parentPlugin: null });
        }
      } else {
        items.push({ type: 'agent', name, absPath: fullPath, parentPlugin: null });
      }
    } else if (includeFiles && name.endsWith('.md')) {
      items.push({ type, name: basename(name, '.md'), absPath: fullPath, parentPlugin: null });
    }
  }
  return items;
}

// ─── Plugin Discovery ────────────────────────────────────────────────────────

/**
 * Discover agents and skills within a single plugin directory.
 * @param {string} pluginDir Absolute path to plugin directory
 * @param {string} pluginName Plugin directory name
 * @returns {DiscoveredResource[]}
 */
export function discoverPlugin(pluginDir, pluginName) {
  const items = [];

  // agents/*.md
  const agentSubDir = join(pluginDir, 'agents');
  if (existsSync(agentSubDir)) {
    try {
      for (const file of readdirSync(agentSubDir)) {
        if (!file.endsWith('.md')) continue;
        const absPath = join(agentSubDir, file);
        try {
          if (statSync(absPath).size === 0) continue;
        } catch {
          continue;
        }
        items.push({
          type: 'agent',
          name: `${pluginName}/${basename(file, '.md')}`,
          absPath,
          parentPlugin: pluginName,
        });
      }
    } catch {}
  }

  // skills/*/SKILL.md
  const skillSubDir = join(pluginDir, 'skills');
  if (existsSync(skillSubDir)) {
    try {
      for (const skillName of readdirSync(skillSubDir)) {
        const skillPath = join(skillSubDir, skillName, 'SKILL.md');
        if (existsSync(skillPath)) {
          items.push({
            type: 'skill',
            name: `${pluginName}/${skillName}`,
            absPath: skillPath,
            parentPlugin: pluginName,
          });
        }
      }
    } catch {}
  }

  return items;
}

/**
 * Discover all resources across all plugins in a plugins directory.
 * @param {string} dirPath Directory containing plugin subdirectories
 * @returns {DiscoveredResource[]}
 */
export function discoverPlugins(dirPath) {
  if (!existsSync(dirPath)) return [];

  const items = [];
  for (const pluginName of readdirSync(dirPath)) {
    if (pluginName.startsWith('.') || pluginName === 'node_modules') continue;
    const pluginDir = join(dirPath, pluginName);
    try {
      if (!statSync(pluginDir).isDirectory()) continue;
    } catch {
      continue;
    }
    items.push(...discoverPlugin(pluginDir, pluginName));
  }
  return items;
}

// ─── Convenience ─────────────────────────────────────────────────────────────

/**
 * Discover all managed resources (skills + agent plugins).
 * @param {string} managedDir Path to managed/ directory
 * @returns {DiscoveredResource[]}
 */
export function discoverAllManaged(managedDir) {
  return [
    ...discoverFlat(join(managedDir, 'skills'), 'skill', { skipNames: ['learned'] }),
    ...discoverPlugins(join(managedDir, 'agents')),
  ];
}

/**
 * Add relative file paths to discovered resources (for index-managed.mjs).
 * @param {DiscoveredResource[]} items Discovered resources
 * @param {string} managedDir Base managed directory for relative paths
 * @returns {Array<DiscoveredResource & {filePath: string}>}
 */
export function withRelativePaths(items, managedDir) {
  return items.map((item) => ({
    ...item,
    filePath: relative(managedDir, item.absPath),
  }));
}
