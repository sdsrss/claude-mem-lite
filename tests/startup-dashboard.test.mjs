// tests/startup-dashboard.test.mjs — T10c dashboard aggregator tests.
// Uses stubs for git/tasks/plans/handoff so the test doesn't depend on the
// host filesystem or the repo's actual git state.

import { test, expect, describe } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { buildDashboard } from '../lib/startup-dashboard.mjs';

describe('startup dashboard (T10c)', () => {
  test('composes all sources into structured injection', () => {
    const db = createTestDb();
    const text = buildDashboard({
      db,
      project: 'mem',
      projectPath: process.cwd(),
      stubs: {
        git: { changed: ['M docs/plan.md'], stashes: [], branch: 'main', headSha: 'abc' },
        tasks: [{ id: 't1', title: 'impl T1', status: 'in_progress' }],
        plans: [{ name: '2026-04-14-mem-v2.31-mvp', path: '/x.md', mtime: Date.now() }],
        handoff: null,
        adopted: true,
      },
    });
    expect(text).toMatch(/Startup dashboard/);
    expect(text).toMatch(/uncommitted/);
    expect(text).toMatch(/impl T1/);
    expect(text).toMatch(/mem-v2\.31-mvp/);
    expect(text.length).toBeLessThan(2000);
  });

  test('returns empty string when all sources empty and project is adopted', () => {
    const db = createTestDb();
    const text = buildDashboard({
      db,
      project: 'mem',
      projectPath: '/tmp',
      stubs: {
        git: { changed: [], stashes: [], branch: 'main', headSha: '' },
        tasks: [],
        plans: [],
        handoff: null,
        adopted: true,
      },
    });
    expect(text).toBe('');
  });

  test('empty sources + not adopted → dashboard contains only the adopt hint', () => {
    const prevNoHint = process.env.MEM_NO_ADOPT_HINT;
    const prevQuiet = process.env.MEM_QUIET_HOOKS;
    delete process.env.MEM_NO_ADOPT_HINT;
    delete process.env.MEM_QUIET_HOOKS;
    try {
      const db = createTestDb();
      const text = buildDashboard({
        db,
        project: 'mem',
        projectPath: '/tmp',
        stubs: {
          git: { changed: [], stashes: [], branch: 'main', headSha: '' },
          tasks: [],
          plans: [],
          handoff: null,
          adopted: false,
        },
      });
      expect(text).toMatch(/Invited-memory 未启用/);
      expect(text).toMatch(/claude-mem-lite adopt/);
      expect(text).toMatch(/MEM_NO_ADOPT_HINT=1/);
    } finally {
      if (prevNoHint === undefined) delete process.env.MEM_NO_ADOPT_HINT;
      else process.env.MEM_NO_ADOPT_HINT = prevNoHint;
      if (prevQuiet === undefined) delete process.env.MEM_QUIET_HOOKS;
      else process.env.MEM_QUIET_HOOKS = prevQuiet;
    }
  });

  test('adopt hint dropped once project is adopted (self-clearing)', () => {
    const db = createTestDb();
    const text = buildDashboard({
      db,
      project: 'mem',
      projectPath: '/tmp',
      stubs: {
        git: { changed: ['M x'], stashes: [], branch: 'main', headSha: 'abc' },
        tasks: [],
        plans: [],
        handoff: null,
        adopted: true,
      },
    });
    expect(text).toMatch(/uncommitted/);
    expect(text).not.toMatch(/Invited-memory 未启用/);
  });

  test('MEM_NO_ADOPT_HINT=1 silences the hint even when not adopted', () => {
    const prev = process.env.MEM_NO_ADOPT_HINT;
    process.env.MEM_NO_ADOPT_HINT = '1';
    try {
      const db = createTestDb();
      const text = buildDashboard({
        db,
        project: 'mem',
        projectPath: '/tmp',
        stubs: {
          git: { changed: [], stashes: [], branch: 'main', headSha: '' },
          tasks: [],
          plans: [],
          handoff: null,
          adopted: false,
        },
      });
      expect(text).toBe('');
    } finally {
      if (prev === undefined) delete process.env.MEM_NO_ADOPT_HINT;
      else process.env.MEM_NO_ADOPT_HINT = prev;
    }
  });

  test('MEM_QUIET_HOOKS=1 also silences the hint', () => {
    const prev = process.env.MEM_QUIET_HOOKS;
    process.env.MEM_QUIET_HOOKS = '1';
    try {
      const db = createTestDb();
      const text = buildDashboard({
        db,
        project: 'mem',
        projectPath: '/tmp',
        stubs: {
          git: { changed: [], stashes: [], branch: 'main', headSha: '' },
          tasks: [],
          plans: [],
          handoff: null,
          adopted: false,
        },
      });
      expect(text).toBe('');
    } finally {
      if (prev === undefined) delete process.env.MEM_QUIET_HOOKS;
      else process.env.MEM_QUIET_HOOKS = prev;
    }
  });

  test('shows a continuation pointer (age signal, not the working_on content)', () => {
    const db = createTestDb();
    const text = buildDashboard({
      db,
      project: 'mem',
      projectPath: process.cwd(),
      stubs: {
        git: { changed: [], stashes: [], branch: 'main', headSha: 'abc' },
        tasks: [],
        plans: [],
        handoff: { created_at_epoch: Date.now() - 3600000, working_on: 'writing the plan' },
      },
    });
    // Pointer only — working_on CONTENT is delivered once by the <session-handoff> block
    // (UserPromptSubmit), so the dashboard must NOT duplicate it into the model context.
    // (This also means no replayed tool-XML can reach the dashboard surface anymore — the
    // defang responsibility for working_on now lives solely in renderHandoffInjection.)
    expect(text).toMatch(/Continuation available/);
    expect(text).not.toMatch(/writing the plan/);
  });

  test('truncates tasks list to 3 with ellipsis', () => {
    const db = createTestDb();
    const tasks = Array.from({ length: 7 }, (_, i) => ({
      id: `t${i}`,
      title: `task ${i}`,
      status: 'pending',
    }));
    const text = buildDashboard({
      db,
      project: 'mem',
      projectPath: process.cwd(),
      stubs: {
        git: { changed: [], stashes: [], branch: null, headSha: null },
        tasks,
        plans: [],
        handoff: null,
      },
    });
    expect(text).toMatch(/\+4 more/);
    // Only first 3 tasks rendered; "+4 more" line doesn't contain "task N"
    const shownTasks = text.match(/- \[pending\] task \d+/g) || [];
    expect(shownTasks.length).toBe(3);
  });

  test('includes events count when non-zero', () => {
    const db = createTestDb();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO events (project, event_type, title, importance, created_at_epoch)
                  VALUES (?, ?, ?, ?, ?)`,
      ).run('mem', 'lesson', `t${i}`, 1, now);
    }
    const text = buildDashboard({
      db,
      project: 'mem',
      projectPath: process.cwd(),
      stubs: {
        git: { changed: [], stashes: [], branch: null, headSha: null },
        tasks: [],
        plans: [],
        handoff: null,
      },
    });
    expect(text).toMatch(/mem events: 5/);
  });

  test('omits events line when count is zero', () => {
    const db = createTestDb();
    const text = buildDashboard({
      db,
      project: 'no-events-project',
      projectPath: process.cwd(),
      stubs: {
        git: { changed: ['M x'], stashes: [], branch: 'main', headSha: '' },
        tasks: [],
        plans: [],
        handoff: null,
      },
    });
    expect(text).not.toMatch(/mem events/);
  });

  test('renders both uncommitted and stashes when present', () => {
    const db = createTestDb();
    const text = buildDashboard({
      db,
      project: 'mem',
      projectPath: process.cwd(),
      stubs: {
        git: { changed: ['M a', 'M b'], stashes: ['stash@{0}: WIP'], branch: 'feat/x', headSha: 'def' },
        tasks: [],
        plans: [],
        handoff: null,
      },
    });
    expect(text).toMatch(/2 uncommitted file\(s\) on feat\/x/);
    expect(text).toMatch(/1 stash\(es\)/);
  });

  test('reads handoff from DB when stubs.handoff is omitted', () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
                VALUES ('mem', 'exit', 's1', 'resumable task', ?)`,
    ).run(Date.now() - 300000);
    const text = buildDashboard({
      db,
      project: 'mem',
      projectPath: process.cwd(),
      stubs: {
        git: { changed: [], stashes: [], branch: null, headSha: null },
        tasks: [],
        plans: [],
        // handoff intentionally omitted to exercise the readRecentHandoff path
      },
    });
    // DB-read path fired → the continuation pointer shows (working_on content itself is
    // delivered by the <session-handoff> block, not the dashboard).
    expect(text).toMatch(/Continuation available/);
    expect(text).not.toMatch(/resumable task/);
  });

  test('does NOT show the continuation pointer for an exit handoff older than the injection expiry', () => {
    const db = createTestDb();
    // >7 days old — pickHandoffToInject filters it as expired, so the UserPromptSubmit
    // injection could never deliver it. The dashboard must not promise a continuation it
    // can't fulfill (batch2-reviewer Finding 1 regression guard).
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
                VALUES ('mem', 'exit', 's1', 'ancient task', ?)`,
    ).run(Date.now() - 8 * 86400000);
    const text = buildDashboard({
      db,
      project: 'mem',
      projectPath: process.cwd(),
      stubs: {
        git: { changed: ['M x'], stashes: [], branch: 'main', headSha: 'abc' }, // ensure non-empty dashboard
        tasks: [],
        plans: [],
        // handoff omitted → exercises the age-filtered readRecentHandoff DB path
      },
    });
    expect(text).not.toMatch(/Continuation/);
    expect(text).not.toMatch(/ancient task/);
  });

  test('wall-clock under 200ms (perf budget)', () => {
    const db = createTestDb();
    const t0 = Date.now();
    buildDashboard({
      db,
      project: 'mem',
      projectPath: process.cwd(),
      stubs: {
        git: { changed: [], stashes: [], branch: null, headSha: null },
        tasks: [],
        plans: [],
        handoff: null,
      },
    });
    expect(Date.now() - t0).toBeLessThan(200);
  });
});
