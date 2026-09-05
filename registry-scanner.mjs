// claude-mem-lite: Resource scanner — discovers skills/agents from filesystem
// Scans user local dirs and managed pre-installed dirs

import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { debugCatch } from './utils.mjs';
import { DB_DIR } from './schema.mjs';
import { discoverFlat, discoverPlugin, discoverPlugins } from './resource-discovery.mjs';

/**
 * @typedef {object} ScannedResource
 * @property {string} name Resource name (directory name)
 * @property {'skill'|'agent'} type Resource type
 * @property {'preinstalled'|'user'} source Source origin
 * @property {string} localPath Absolute path to resource directory
 * @property {string} content Combined content of resource files
 * @property {string} fileHash SHA-256 hash of content
 * @property {string|null} repoUrl GitHub repo URL if preinstalled
 */

// ─── Resource Location Convention ─────────────────────────────────────────────
// Two resource locations, differentiated by naming convention:
//   managed/skills/{skill}/          → standalone skills, name: "{skill}"
//   managed/agents/{plugin}/skills/  → plugin-attached skills, name: "{plugin}/{skill}"
//   managed/agents/{plugin}/agents/  → plugin agents, name: "{plugin}/{agent}"
// Both scanned by same scanner; deduplication by "type:name" key.

// ─── Scan Sources ────────────────────────────────────────────────────────────

/**
 * Build the list of directories to scan for skill and agent resources.
 * @param {string} dataDir Base data directory for managed resources
 * @returns {{path: string, type: string, source: string, layout: string}[]}
 */
function getScanSources(dataDir) {
  const home = homedir();
  return [
    // User local resources (highest priority) — flat layout
    { path: join(home, '.claude', 'skills'), type: 'skill', source: 'user', layout: 'flat' },
    { path: join(home, '.claude', 'agents'), type: 'agent', source: 'user', layout: 'flat' },
    // Pre-installed managed resources
    { path: join(dataDir, 'managed', 'skills'), type: 'skill', source: 'preinstalled', layout: 'flat' },
    // Agent plugins contain both agents and skills in nested structure
    { path: join(dataDir, 'managed', 'agents'), type: null, source: 'preinstalled', layout: 'plugins' },
  ];
}

// ─── Content Reading ─────────────────────────────────────────────────────────

/**
 * Read the primary markdown content file from a resource directory.
 * Searches skill.md, agent.md, README.md, then any .md or .yaml file.
 * @param {string} dirPath Absolute path to the resource directory
 * @returns {string} File content or empty string if not found
 */
function readResourceContent(dirPath) {
  // Priority: skill.md / agent.md > README.md > first .md file
  const candidates = ['skill.md', 'agent.md', 'SKILL.md', 'AGENT.md', 'README.md'];

  for (const name of candidates) {
    const fp = join(dirPath, name);
    if (existsSync(fp)) {
      try {
        return readFileSync(fp, 'utf8');
      } catch {
        continue;
      }
    }
  }

  // Fallback: first .md file found
  try {
    const files = readdirSync(dirPath).filter((f) => f.endsWith('.md'));
    if (files.length > 0) {
      return readFileSync(join(dirPath, files[0]), 'utf8');
    }
  } catch {}

  // Last resort: look for .yaml/.yml files (some agents use YAML)
  try {
    const yamlFiles = readdirSync(dirPath).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    if (yamlFiles.length > 0) {
      return readFileSync(join(dirPath, yamlFiles[0]), 'utf8');
    }
  } catch {}

  return '';
}

/**
 * Compute SHA-256 hash of content for change detection.
 * @param {string} content File content to hash
 * @returns {string|null} Hex-encoded SHA-256 hash, or null if content is empty
 */
function computeHash(content) {
  if (!content) return null;
  return createHash('sha256').update(content).digest('hex');
}

// ─── Directory Scanning ──────────────────────────────────────────────────────

/**
 * Scan a single directory for resources.
 * Each subdirectory (or .md file) is treated as one resource.
 * Delegates path discovery to discoverFlat(), then reads content via buildScannedResource().
 * @param {string} dirPath Directory to scan
 * @param {'skill'|'agent'} type Resource type
 * @param {'preinstalled'|'user'} source Source origin
 * @returns {ScannedResource[]} Array of discovered resources
 */
export function scanDirectory(dirPath, type, source) {
  const discovered = discoverFlat(dirPath, type, { strict: false, includeFiles: true });
  const resources = [];
  for (const d of discovered) {
    const res = buildScannedResource(d, source);
    if (res) resources.push(res);
  }
  return resources;
}

// ─── Plugin Scanning ──────────────────────────────────────────────────────

/**
 * Build a ScannedResource from a DiscoveredResource by reading content.
 * @param {{type: string, name: string, absPath: string}} discovered
 * @param {'preinstalled'|'user'} source
 * @returns {ScannedResource|null}
 */
function buildScannedResource(discovered, source) {
  try {
    const stat = statSync(discovered.absPath);
    let content;
    if (stat.isDirectory()) {
      content = readResourceContent(discovered.absPath);
    } else {
      content = readFileSync(discovered.absPath, 'utf8');
    }
    if (!content || content.length < 10) return null;
    return {
      name: discovered.name,
      type: discovered.type,
      source,
      localPath: discovered.absPath,
      content,
      fileHash: computeHash(content),
      repoUrl: null,
    };
  } catch (e) {
    debugCatch(e, `buildScannedResource(${discovered.absPath})`);
    return null;
  }
}

/**
 * Scan a single agent plugin directory for nested agents and skills.
 * @param {string} pluginDir Absolute path to plugin directory
 * @param {string} pluginName Plugin directory name
 * @param {'preinstalled'|'user'} source Source origin
 * @returns {ScannedResource[]} Discovered agents and skills
 */
export function scanPluginResources(pluginDir, pluginName, source) {
  const discovered = discoverPlugin(pluginDir, pluginName);
  const resources = [];
  for (const d of discovered) {
    const res = buildScannedResource(d, source);
    if (res) resources.push(res);
  }
  return resources;
}

/**
 * Scan a plugins directory (e.g. managed/agents/) for all plugin subdirs.
 * @param {string} dirPath Directory containing plugin directories
 * @param {'preinstalled'|'user'} source Source origin
 * @returns {ScannedResource[]} All discovered plugin resources
 */
export function scanPluginsDirectory(dirPath, source) {
  const discovered = discoverPlugins(dirPath);
  const resources = [];
  for (const d of discovered) {
    const res = buildScannedResource(d, source);
    if (res) resources.push(res);
  }
  return resources;
}

// ─── Main Scan ───────────────────────────────────────────────────────────────

/**
 * Scan all resource sources and return discovered resources.
 * Deduplicates by (type, name) — user resources take priority over preinstalled.
 * @param {object} [config] Configuration
 * @param {string} [config.dataDir] Data directory (defaults to DB_DIR)
 * @returns {ScannedResource[]} All discovered resources
 */
export function scanAllResources(config = {}) {
  const dataDir = config.dataDir || DB_DIR;
  const sources = getScanSources(dataDir);
  const seen = new Map(); // key: "type:name" -> resource

  for (const src of sources) {
    const resources =
      src.layout === 'plugins'
        ? scanPluginsDirectory(src.path, src.source)
        : scanDirectory(src.path, src.type, src.source);
    for (const res of resources) {
      const key = `${res.type}:${res.name}`;
      // User resources override preinstalled (scanned first due to source order)
      if (!seen.has(key)) {
        seen.set(key, res);
      }
    }
  }

  return [...seen.values()];
}

/**
 * Compare scanned resources against DB state to find what needs indexing.
 * @param {Database} db Registry database
 * @param {ScannedResource[]} scanned Scanned resources
 * @returns {{toIndex: ScannedResource[], toDisable: object[]}} Resources needing action
 */
export function diffResources(db, scanned) {
  const existing = new Map();
  const rows = db.prepare('SELECT id, type, name, file_hash, local_path, status FROM resources').all();
  for (const r of rows) existing.set(`${r.type}:${r.name}`, r);

  const toIndex = [];
  const scannedKeys = new Set();

  for (const res of scanned) {
    const key = `${res.type}:${res.name}`;
    scannedKeys.add(key);
    const ex = existing.get(key);

    if (!ex) {
      // New resource
      toIndex.push(res);
    } else if (ex.file_hash !== res.fileHash) {
      // Content changed
      toIndex.push(res);
    }
    // else: unchanged, skip
  }

  // Resources in DB but not on filesystem → disable
  // Only disable resources that have a local_path (filesystem-backed).
  // Resources without local_path were imported via metadata/registry and
  // cannot be validated by filesystem scan.
  const toDisable = [];
  for (const [key, row] of existing) {
    if (!scannedKeys.has(key) && row.status === 'active' && row.local_path) {
      toDisable.push(row);
    }
  }

  return { toIndex, toDisable };
}
