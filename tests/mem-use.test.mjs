import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRegistryTestDb } from './test-helpers.mjs';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function insertSkill(db, { name, invocationName = null, localPath = '', capabilitySummary = '' }) {
  db.prepare(
    `
    INSERT INTO resources (name, type, source, file_hash, status, local_path, invocation_name, capability_summary, trigger_patterns, keywords, intent_tags, use_cases, domain_tags, tech_stack)
    VALUES (?, 'skill', 'preinstalled', 'hash', 'active', ?, ?, ?, ?, ?, ?, ?, '', '')
  `,
  ).run(name, localPath, invocationName || name, capabilitySummary, name, name, name, name);
}

describe('mem_use logic', () => {
  let db;
  const TMP = join(tmpdir(), 'mem-use-test-' + process.pid);
  const SKILL_DIR = join(TMP, 'managed', 'skills', 'humanizer');
  const SKILL_PATH = join(SKILL_DIR, 'SKILL.md');

  beforeEach(() => {
    db = createRegistryTestDb();
    mkdirSync(SKILL_DIR, { recursive: true });
    writeFileSync(SKILL_PATH, '---\nname: humanizer\n---\n# Humanizer\nRemove AI patterns.');
  });

  afterEach(() => {
    db.close();
    rmSync(TMP, { recursive: true, force: true });
  });

  it('finds skill by exact name', () => {
    insertSkill(db, { name: 'humanizer', localPath: SKILL_PATH });
    const row = db
      .prepare(`SELECT name, local_path FROM resources WHERE name = ? AND status = 'active'`)
      .get('humanizer');
    expect(row).toBeTruthy();
    expect(row.local_path).toBe(SKILL_PATH);
  });

  it('finds skill by invocation_name', () => {
    insertSkill(db, { name: 'my-humanizer', invocationName: 'humanizer', localPath: SKILL_PATH });
    const row = db
      .prepare(`SELECT name, local_path FROM resources WHERE invocation_name = ? AND status = 'active'`)
      .get('humanizer');
    expect(row).toBeTruthy();
    expect(row.name).toBe('my-humanizer');
  });

  it('returns undefined for non-existent skill', () => {
    const row = db
      .prepare(`SELECT name FROM resources WHERE name = ? AND status = 'active'`)
      .get('nonexistent');
    expect(row).toBeUndefined();
  });

  it('skips inactive resources', () => {
    db.prepare(
      `
      INSERT INTO resources (name, type, source, file_hash, status, local_path, invocation_name, capability_summary, trigger_patterns, keywords, intent_tags, use_cases, domain_tags, tech_stack)
      VALUES ('dead-skill', 'skill', 'user', 'hash', 'disabled', '/tmp/x', 'dead-skill', '', '', '', '', '', '', '')
    `,
    ).run();
    const row = db
      .prepare(`SELECT name FROM resources WHERE name = ? AND status = 'active'`)
      .get('dead-skill');
    expect(row).toBeUndefined();
  });

  it('exact match query finds by name OR invocation_name', () => {
    insertSkill(db, { name: 'humanizer', invocationName: 'hu', localPath: SKILL_PATH });
    // Match by name
    const byName = db
      .prepare(
        `SELECT id, name FROM resources WHERE status = 'active' AND type = 'skill' AND (name = ? OR invocation_name = ?) LIMIT 1`,
      )
      .get('humanizer', 'humanizer');
    expect(byName).toBeTruthy();
    // Match by invocation_name
    const byInvoc = db
      .prepare(
        `SELECT id, name FROM resources WHERE status = 'active' AND type = 'skill' AND (name = ? OR invocation_name = ?) LIMIT 1`,
      )
      .get('hu', 'hu');
    expect(byInvoc).toBeTruthy();
    expect(byInvoc.name).toBe('humanizer');
  });
});
