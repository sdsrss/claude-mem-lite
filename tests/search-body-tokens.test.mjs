// Feature: per-result `~Nt` fetch-cost hint in search output (adopted from
// thedotmack/claude-mem's token-cost column — see reference_claude_mem_comparison).
// The 3-layer protocol (search → timeline → get) is token-efficient only if the
// agent can budget BEFORE paying for mem_get; this surfaces the estimated cost to
// fetch each result's full body so the agent prioritizes which IDs to expand.
import { describe, it, expect, vi } from 'vitest';
import { createTestDb, insertObs, insertSession } from './test-helpers.mjs';
import { attachBodyTokens } from '../search-engine.mjs';
import { handleSearchForTest } from '../server.mjs';
import { cmdSearchForTest } from '../mem-cli.mjs';

describe('attachBodyTokens — per-result full-body fetch-cost estimate', () => {
  it('estimates from the heavy fields (narrative) and scales with body size', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    insertObs(db, { title: 'widget alpha', narrative: 'tiny.' });
    insertObs(db, { title: 'widget beta', narrative: 'lorem ipsum dolor sit amet '.repeat(40) }); // ~1080 chars
    const results = [
      { source: 'obs', id: 1, title: 'widget alpha', subtitle: '', lesson_learned: null },
      { source: 'obs', id: 2, title: 'widget beta', subtitle: '', lesson_learned: null },
    ];
    attachBodyTokens(db, results);
    expect(results[0].bodyTokens).toBeGreaterThan(0);
    expect(results[1].bodyTokens).toBeGreaterThan(results[0].bodyTokens);
    db.close();
  });

  it('is robust to missing rows and empty input (floors at 1, never throws/NaN)', () => {
    const db = createTestDb();
    const results = [{ source: 'obs', id: 999, title: 't', subtitle: '', lesson_learned: null }];
    attachBodyTokens(db, results);
    expect(results[0].bodyTokens).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(results[0].bodyTokens)).toBe(true);
    expect(() => attachBodyTokens(db, [])).not.toThrow();
    db.close();
  });

  it('handles the CLI alias key (_source) as well as MCP source', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    insertObs(db, { title: 'kafka lag', narrative: 'consumer rebalance lag spike investigation' });
    const results = [{ _source: 'obs', id: 1, title: 'kafka lag', subtitle: '', lesson_learned: null }];
    attachBodyTokens(db, results);
    expect(results[0].bodyTokens).toBeGreaterThan(0);
    db.close();
  });
});

describe('search output surfaces the ~Nt fetch-cost hint', () => {
  function seed() {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    insertObs(db, {
      title: 'kafka consumer lag fix',
      narrative:
        'investigated kafka consumer group rebalance causing lag spikes; tuned max.poll.interval and session.timeout '.repeat(
          3,
        ),
      lessonLearned: 'rebalance storms come from slow poll loops, not broker load',
    });
    return db;
  }

  it('MCP mem_search renders a ~Nt token per result and explains it', async () => {
    const db = seed();
    const res = await handleSearchForTest(db, { query: 'kafka', deep: false }, {});
    const text = res.content[0].text;
    expect(text).toMatch(/~\d+t\b/); // per-row hint present
    expect(text.toLowerCase()).toMatch(/~nt|est\.? tokens|fetch/); // legend explains it
    db.close();
  });

  it('CLI search renders a ~Nt token per result', async () => {
    const db = seed();
    const writes = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    try {
      await cmdSearchForTest(db, ['kafka', '--no-deep'], {});
    } finally {
      spy.mockRestore();
    }
    const text = writes.join('');
    expect(text).toMatch(/~\d+t\b/);
    db.close();
  });
});
