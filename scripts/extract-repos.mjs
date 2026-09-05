#!/usr/bin/env node
// Extract skills/agents from cloned repos into managed/ directory structure
// Target structure:
//   managed/agents/<plugin-name>/agents/<agent>.md
//   managed/agents/<plugin-name>/skills/<skill>/SKILL.md
//   managed/skills/<skill-name>/SKILL.md

import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REPOS_DIR = join(ROOT, 'managed', 'repos');
const AGENTS_DIR = join(ROOT, 'managed', 'agents');
const SKILLS_DIR = join(ROOT, 'managed', 'skills');

// Already extracted — skip these repos
const SKIP_REPOS = new Set([
  'wshobson-agents',
  'davila7-claude-code-templates',
  'obra-superpowers',
  'anthropics-skills',
  'sanyuan0704-code-review-expert',
  'lackeyjb-playwright-skill',
  'nextlevelbuilder-ui-ux-pro-max-skill',
  'OthmanAdi-planning-with-files',
]);

// Repos with no extractable content
const EMPTY_REPOS = new Set([
  'frankbria-ralph-claude-code',
  'diet103-infrastructure-showcase',
  'yusufkaraaslan-Skill_Seekers',
]);

const stats = { agents: 0, skills: 0, skipped: 0 };

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function hasYamlFrontmatter(content) {
  return content.trimStart().startsWith('---');
}

function isValidAgent(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    if (!content.trim() || content.trim().length < 50) return false;
    return hasYamlFrontmatter(content);
  } catch {
    return false;
  }
}

function isValidSkill(dirPath) {
  const skillMd = join(dirPath, 'SKILL.md');
  if (existsSync(skillMd)) return true;
  // Some skills use AGENTS.md as primary
  const agentsMd = join(dirPath, 'AGENTS.md');
  return existsSync(agentsMd);
}

function copyAgent(src, destDir, name) {
  ensureDir(destDir);
  const dest = join(destDir, name + '.md');
  if (existsSync(dest)) {
    stats.skipped++;
    return;
  }
  copyFileSync(src, dest);
  stats.agents++;
}

function copySkill(srcDir, destDir) {
  ensureDir(destDir);
  const skillMd = join(srcDir, 'SKILL.md');
  const agentsMd = join(srcDir, 'AGENTS.md');
  if (existsSync(skillMd)) {
    const dest = join(destDir, 'SKILL.md');
    if (existsSync(dest)) {
      stats.skipped++;
      return;
    }
    copyFileSync(skillMd, dest);
    // Also copy AGENTS.md if exists
    if (existsSync(agentsMd)) copyFileSync(agentsMd, join(destDir, 'AGENTS.md'));
    stats.skills++;
  } else if (existsSync(agentsMd)) {
    // Convert AGENTS.md to SKILL.md if no SKILL.md exists
    const dest = join(destDir, 'SKILL.md');
    if (existsSync(dest)) {
      stats.skipped++;
      return;
    }
    copyFileSync(agentsMd, dest);
    stats.skills++;
  }
}

// ── Repo-specific extractors ───────────────────────────────────────────────

function extractVoltAgent(repoDir) {
  const pluginName = 'voltagent-subagents';
  const categoriesDir = join(repoDir, 'categories');
  if (!existsSync(categoriesDir)) return;

  for (const cat of readdirSync(categoriesDir).sort()) {
    const catDir = join(categoriesDir, cat);
    if (!statSync(catDir).isDirectory()) continue;
    // Category name like "01-core-development" → "core-development"
    const catName = cat.replace(/^\d+-/, '');
    const destAgentDir = join(AGENTS_DIR, `${pluginName}-${catName}`, 'agents');

    for (const file of readdirSync(catDir)) {
      if (!file.endsWith('.md')) continue;
      const src = join(catDir, file);
      if (isValidAgent(src)) {
        copyAgent(src, destAgentDir, file.replace('.md', ''));
      }
    }
  }
}

function extractVijaythecoder(repoDir) {
  const pluginName = 'vijay-agents';
  const agentsDir = join(repoDir, 'agents');
  if (!existsSync(agentsDir)) return;

  // Recursively find all .md files under agents/
  function walkDir(dir, category) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walkDir(full, category || entry);
      } else if (entry.endsWith('.md') && isValidAgent(full)) {
        const destAgentDir = join(AGENTS_DIR, `${pluginName}-${category || 'general'}`, 'agents');
        copyAgent(full, destAgentDir, entry.replace('.md', ''));
      }
    }
  }
  walkDir(agentsDir, null);
}

function extractPluginRepo(repoDir, pluginName) {
  // Repos with .claude-plugin/ structure: agents/*.md + skills/*/SKILL.md
  const agentsSrc = join(repoDir, 'agents');
  const skillsSrc = join(repoDir, 'skills');

  if (existsSync(agentsSrc)) {
    const destAgentDir = join(AGENTS_DIR, pluginName, 'agents');
    for (const file of readdirSync(agentsSrc)) {
      if (!file.endsWith('.md')) continue;
      const src = join(agentsSrc, file);
      if (isValidAgent(src)) {
        copyAgent(src, destAgentDir, file.replace('.md', ''));
      }
    }
  }

  if (existsSync(skillsSrc)) {
    const destSkillBase = join(AGENTS_DIR, pluginName, 'skills');
    for (const skillName of readdirSync(skillsSrc)) {
      const skillDir = join(skillsSrc, skillName);
      if (!statSync(skillDir).isDirectory()) continue;
      if (isValidSkill(skillDir)) {
        copySkill(skillDir, join(destSkillBase, skillName));
      }
    }
  }
}

function extractVercelLabs(repoDir) {
  const skillsSrc = join(repoDir, 'skills');
  if (!existsSync(skillsSrc)) return;

  for (const name of readdirSync(skillsSrc)) {
    const skillDir = join(skillsSrc, name);
    if (!statSync(skillDir).isDirectory()) continue;
    // Skip binary files
    if (name.endsWith('.ai')) continue;
    if (isValidSkill(skillDir)) {
      copySkill(skillDir, join(SKILLS_DIR, `vercel-${name}`));
    }
  }
}

function extractKimFindskill(repoDir) {
  // Has original/SKILL.md and windows/SKILL.md
  for (const variant of ['original', 'windows']) {
    const dir = join(repoDir, variant);
    if (existsSync(dir) && isValidSkill(dir)) {
      copySkill(dir, join(SKILLS_DIR, `findskill-${variant}`));
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log('🔍 Extracting skills/agents from cloned repos...\n');

  if (!existsSync(REPOS_DIR)) {
    console.log('No repos directory found');
    return;
  }

  for (const repo of readdirSync(REPOS_DIR).sort()) {
    if (SKIP_REPOS.has(repo) || EMPTY_REPOS.has(repo)) continue;
    const repoDir = join(REPOS_DIR, repo);
    if (!statSync(repoDir).isDirectory()) continue;

    const before = { a: stats.agents, s: stats.skills };

    if (repo === 'VoltAgent-awesome-claude-code-subagents') {
      extractVoltAgent(repoDir);
    } else if (repo === 'vijaythecoder-awesome-claude-agents') {
      extractVijaythecoder(repoDir);
    } else if (repo === 'Yeachan-Heo-oh-my-claudecode') {
      extractPluginRepo(repoDir, 'oh-my-claudecode');
    } else if (repo === 'affaan-m-everything-claude-code') {
      extractPluginRepo(repoDir, 'everything-claude-code');
    } else if (repo === 'vercel-labs-agent-skills') {
      extractVercelLabs(repoDir);
    } else if (repo === 'KimYx0207-findskill') {
      extractKimFindskill(repoDir);
    } else {
      console.log(`  ⏭️  ${repo} — no extractor defined`);
      continue;
    }

    const da = stats.agents - before.a;
    const ds = stats.skills - before.s;
    if (da || ds) {
      console.log(`  ✅ ${repo}: ${da} agents, ${ds} skills`);
    } else {
      console.log(`  ⏭️  ${repo}: nothing new to extract`);
    }
  }

  console.log(`\n📊 Extraction complete:`);
  console.log(`   Agents: ${stats.agents}`);
  console.log(`   Skills: ${stats.skills}`);
  console.log(`   Skipped (existing): ${stats.skipped}`);
}

main();
