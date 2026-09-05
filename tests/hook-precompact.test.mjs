import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { handlePreCompact } from '../hook-precompact.mjs';

describe('handlePreCompact', () => {
  let db, stdout;
  beforeEach(() => {
    db = createTestDb();
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      stdout.push(String(s));
      return true;
    });
  });

  it('emits a <claude-mem-context> block on stdout when memory is non-empty', () => {
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
                VALUES (?, ?, ?, ?, ?, 'active')`,
    ).run('s1', 's1', 'p1', new Date().toISOString(), Date.now());
    db.prepare(
      `INSERT INTO observations (memory_session_id, project, text, type, title, narrative, importance, created_at, created_at_epoch)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      's1',
      'p1',
      'used jose JWT lib',
      'decision',
      'Auth: jose over jsonwebtoken',
      'edge runtime compat',
      2,
      new Date().toISOString(),
      Date.now(),
    );

    handlePreCompact({ db, project: 'p1', sessionId: 's1' });

    const out = stdout.join('');
    expect(out).toContain('<claude-mem-context>');
    expect(out).toContain('</claude-mem-context>');
    expect(out).toMatch(/Auth: jose over jsonwebtoken/);
  });

  it('emits nothing (or empty marker) when DB has no observations for project', () => {
    handlePreCompact({ db, project: 'empty-project', sessionId: 's-none' });
    const out = stdout.join('');
    expect(out).not.toMatch(/Auth: jose/);
  });

  it('does not throw on a fresh DB with no sessions', () => {
    expect(() => handlePreCompact({ db, project: 'fresh', sessionId: undefined })).not.toThrow();
  });
});
