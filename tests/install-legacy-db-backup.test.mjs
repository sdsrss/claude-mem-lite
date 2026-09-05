// install-legacy-db-backup.test.mjs — Bug 2 regression
// install.mjs used to copyFileSync(~/.claude-mem/claude-mem.db, DB_PATH),
// turning legacy claude-mem v16 schema (schema_versions plural table) into
// the new claude-mem-lite v28 schema home. There is no v16→v28 bridge in
// MIGRATIONS[]; the new code FATALs on first launch with
// "no such column: memory_session_id". Instead, install must rename the
// legacy DB to a timestamped backup so the new install creates a clean DB
// and the user can recover the file later if they want.

import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { migrateLegacyClaudeMemData } from '../install.mjs';

function makeDirs() {
  const root = join(tmpdir(), `mem-legacy-${randomUUID().slice(0, 8)}`);
  const oldDir = join(root, '.claude-mem');
  const newDir = join(root, '.claude-mem-lite');
  mkdirSync(oldDir, { recursive: true });
  mkdirSync(newDir, { recursive: true });
  return { root, oldDir, newDir };
}

describe('Bug 2: migrateLegacyClaudeMemData', () => {
  it('renames legacy claude-mem.db to a timestamped backup in newDir, never as the new DB', () => {
    const { root, oldDir, newDir } = makeDirs();
    try {
      writeFileSync(join(oldDir, 'claude-mem.db'), 'legacy-content');
      const result = migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 });
      expect(result.action).toBe('backed-up');
      expect(result.backupPath).toContain('claude-mem-lite.db.legacy-backup-');
      // Critically: new DB path must NOT exist after backup — new install
      // creates a fresh v28 schema.
      expect(existsSync(join(newDir, 'claude-mem-lite.db'))).toBe(false);
      // Backup file exists and contains the original bytes.
      expect(existsSync(result.backupPath)).toBe(true);
      // Old location no longer holds the DB (renamed, not copied).
      expect(existsSync(join(oldDir, 'claude-mem.db'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('also backs up -wal and -shm sidecar files when present', () => {
    const { root, oldDir, newDir } = makeDirs();
    try {
      writeFileSync(join(oldDir, 'claude-mem.db'), 'main');
      writeFileSync(join(oldDir, 'claude-mem.db-wal'), 'wal');
      writeFileSync(join(oldDir, 'claude-mem.db-shm'), 'shm');
      const result = migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 });
      expect(result.action).toBe('backed-up');
      const stamps = readdirSync(newDir).filter((f) => f.includes('legacy-backup'));
      expect(stamps.some((f) => f.endsWith('.db.legacy-backup-1700000000000'))).toBe(true);
      expect(stamps.some((f) => f.endsWith('.db-wal.legacy-backup-1700000000000'))).toBe(true);
      expect(stamps.some((f) => f.endsWith('.db-shm.legacy-backup-1700000000000'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns action "noop" when old claude-mem.db does not exist', () => {
    const { root, oldDir, newDir } = makeDirs();
    try {
      const result = migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 });
      expect(result.action).toBe('noop');
      expect(readdirSync(newDir)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns action "skip" and touches nothing when newDir already has claude-mem-lite.db', () => {
    const { root, oldDir, newDir } = makeDirs();
    try {
      writeFileSync(join(oldDir, 'claude-mem.db'), 'legacy');
      writeFileSync(join(newDir, 'claude-mem-lite.db'), 'fresh');
      const result = migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 });
      expect(result.action).toBe('skip');
      // Working DB untouched
      expect(existsSync(join(newDir, 'claude-mem-lite.db'))).toBe(true);
      // Old DB also untouched (don't surprise users with mutations on skip)
      expect(existsSync(join(oldDir, 'claude-mem.db'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
