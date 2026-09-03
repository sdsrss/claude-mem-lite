#!/usr/bin/env node
// Convert command .md files to SKILL.md skills in managed agent plugins
// Usage: node scripts/convert-commands.mjs [--dry-run] [--delete-originals]

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { resolveDataDir } from '../lib/resolve-data-dir.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';

// D#29: honor CLAUDE_MEM_DIR (equals homedir when the env is unset).
const MANAGED_DIR = join(resolveDataDir(process.env.CLAUDE_MEM_DIR), 'managed');
const AGENTS_DIR = join(MANAGED_DIR, 'agents');

const DRY_RUN = process.argv.includes('--dry-run');
const DELETE_ORIGINALS = process.argv.includes('--delete-originals');

// Commands to skip — too specialized, multi-step workflows, or poor skill candidates
const SKIP_LIST = new Set([
  'context-restore',
  'smart-debug',
  'multi-agent-review',
  'security-sast',
  'tdd-green',
  'tdd-red',
  'tdd-refactor',
]);

// ─── Frontmatter Parsing ─────────────────────────────────────────────────────

// parseFrontmatter is lib/frontmatter.mjs's (audit 2026-09-02 P1-16). The copy that used
// to live here was a SIMPLIFIED cut with no `|` / `>` block support, so a `description: |`
// block — the normal shape in a SKILL.md — came back as the literal `|`.

// ─── Description Extraction ──────────────────────────────────────────────────

function extractDescription(frontmatter, body) {
  // Use existing frontmatter description if present
  if (frontmatter.description) return frontmatter.description;

  // Extract from first heading + first paragraph
  const lines = body.split('\n');
  let desc = '';
  let pastHeading = false;
  for (const line of lines) {
    if (line.startsWith('#')) {
      pastHeading = true;
      continue;
    }
    if (pastHeading && line.trim()) {
      desc = line.trim();
      break;
    }
  }
  // Truncate to reasonable length
  return desc.slice(0, 200) || 'Converted from command';
}

// ─── Conversion ──────────────────────────────────────────────────────────────

function convertCommand(commandPath, commandName) {
  const content = readFileSync(commandPath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(content);

  const description = extractDescription(frontmatter, body);

  // Replace $ARGUMENTS placeholder
  const convertedBody = body.replace(/\$ARGUMENTS/g, 'the target code or component');

  // Build SKILL.md content
  const skillContent = `---
name: ${commandName}
description: ${description}
---

${convertedBody}
`;

  return skillContent;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(AGENTS_DIR)) {
    console.error(`Agents directory not found: ${AGENTS_DIR}`);
    process.exit(1);
  }

  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Converting commands to skills...`);
  console.log(`Source: ${AGENTS_DIR}\n`);

  let converted = 0, skipped = 0, errors = 0;
  const results = [];

  for (const pluginName of readdirSync(AGENTS_DIR)) {
    const pluginDir = join(AGENTS_DIR, pluginName);
    if (!statSync(pluginDir).isDirectory()) continue;

    const commandsDir = join(pluginDir, 'commands');
    if (!existsSync(commandsDir)) continue;

    for (const file of readdirSync(commandsDir)) {
      if (!file.endsWith('.md')) continue;
      const commandName = basename(file, '.md');

      if (SKIP_LIST.has(commandName)) {
        console.log(`  SKIP  ${pluginName}/commands/${commandName}`);
        skipped++;
        continue;
      }

      const commandPath = join(commandsDir, file);
      const skillDir = join(pluginDir, 'skills', commandName);
      const skillPath = join(skillDir, 'SKILL.md');

      // Check if skill already exists
      if (existsSync(skillPath)) {
        console.log(`  EXISTS ${pluginName}/skills/${commandName}/SKILL.md`);
        skipped++;
        continue;
      }

      try {
        const skillContent = convertCommand(commandPath, commandName);

        if (DRY_RUN) {
          console.log(`  WOULD  ${pluginName}/commands/${commandName} → skills/${commandName}/SKILL.md`);
        } else {
          mkdirSync(skillDir, { recursive: true });
          writeFileSync(skillPath, skillContent, 'utf8');
          console.log(`  DONE   ${pluginName}/commands/${commandName} → skills/${commandName}/SKILL.md`);
        }
        results.push({ plugin: pluginName, command: commandName, status: 'converted' });
        converted++;
      } catch (e) {
        console.error(`  ERROR  ${pluginName}/commands/${commandName}: ${e.message}`);
        errors++;
      }
    }

    // Delete originals if requested
    if (DELETE_ORIGINALS && !DRY_RUN && existsSync(commandsDir)) {
      try {
        rmSync(commandsDir, { recursive: true, force: true });
        console.log(`  RMDIR  ${pluginName}/commands/`);
      } catch (e) {
        console.error(`  ERROR  Could not remove ${commandsDir}: ${e.message}`);
      }
    }
  }

  console.log(`\nSummary: ${converted} converted, ${skipped} skipped, ${errors} errors`);

  if (DRY_RUN) {
    console.log('\nRe-run without --dry-run to execute conversion.');
  } else if (converted > 0) {
    console.log('\nNext: run `node scripts/index-managed.mjs` to re-index.');
  }
}

main();
