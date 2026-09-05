// tests/task-reader.test.mjs — T10a TaskList reader tests.
//
// Real schema deviations from the v2.31 plan (discovered via fs inspection):
//   1. No `meta.json` exists in `~/.claude/tasks/<id>/` in current Claude Code.
//      Project → taskListId mapping lives at `~/.claude/projects/<mangled>/<taskListId>/`
//      where mangling = replace `/` with `-`.
//   2. Real task files use `subject` + `activeForm`, not `title`.
//   3. Hidden dotfiles `.lock` and `.highwatermark` exist alongside `<taskId>.json` files.
//
// readProjectTasks() supports BOTH shapes:
//   - Fixture shape (meta.json + title) — used by these tests and external tooling.
//   - Real shape (projectsRoot + mangled dir + subject) — used at runtime from hook.
// Normalized output always uses `title` (falls back to `subject` → `'(untitled)'`).

import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readProjectTasks } from '../lib/task-reader.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tasks-'));
  const taskListId = 'abc123';
  const taskDir = join(root, taskListId);
  mkdirSync(taskDir, { recursive: true });
  // meta.json identifies which project this task list belongs to
  writeFileSync(
    join(taskDir, 'meta.json'),
    JSON.stringify({
      taskListId,
      projectPath: '/mnt/data_ssd/dev/projects/mem',
    }),
  );
  writeFileSync(
    join(taskDir, 't1.json'),
    JSON.stringify({
      id: 't1',
      title: 'Write plan',
      status: 'completed',
    }),
  );
  writeFileSync(
    join(taskDir, 't2.json'),
    JSON.stringify({
      id: 't2',
      title: 'Implement T1',
      status: 'in_progress',
    }),
  );
  writeFileSync(
    join(taskDir, 't3.json'),
    JSON.stringify({
      id: 't3',
      title: 'Implement T2',
      status: 'pending',
    }),
  );
  return { root, projectPath: '/mnt/data_ssd/dev/projects/mem' };
}

test('readProjectTasks returns pending + in_progress only', () => {
  const { root, projectPath } = fixture();
  try {
    const tasks = readProjectTasks({ tasksRoot: root, projectPath });
    expect(tasks.map((t) => t.title)).toEqual(expect.arrayContaining(['Implement T1', 'Implement T2']));
    expect(tasks.find((t) => t.title === 'Write plan')).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('readProjectTasks returns empty when tasks dir is missing', () => {
  const tasks = readProjectTasks({ tasksRoot: '/nonexistent', projectPath: '/x' });
  expect(tasks).toEqual([]);
});

test('readProjectTasks filters by projectPath', () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-filter-'));
  try {
    const dir1 = join(root, 'list1');
    const dir2 = join(root, 'list2');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir1, 'meta.json'), JSON.stringify({ projectPath: '/project-a' }));
    writeFileSync(join(dir1, 't.json'), JSON.stringify({ id: 't', title: 'A task', status: 'pending' }));
    writeFileSync(join(dir2, 'meta.json'), JSON.stringify({ projectPath: '/project-b' }));
    writeFileSync(join(dir2, 't.json'), JSON.stringify({ id: 't', title: 'B task', status: 'pending' }));

    const tasksA = readProjectTasks({ tasksRoot: root, projectPath: '/project-a' });
    expect(tasksA).toHaveLength(1);
    expect(tasksA[0].title).toBe('A task');
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('readProjectTasks respects maxTasks cap', () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-cap-'));
  try {
    const dir = join(root, 'list');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ projectPath: '/p' }));
    for (let i = 0; i < 30; i++) {
      writeFileSync(
        join(dir, `t${i}.json`),
        JSON.stringify({
          id: `t${i}`,
          title: `Task ${i}`,
          status: 'pending',
        }),
      );
    }
    const tasks = readProjectTasks({ tasksRoot: root, projectPath: '/p', maxTasks: 5 });
    expect(tasks).toHaveLength(5);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('readProjectTasks sorts by mtime DESC', () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-sort-'));
  try {
    const dir = join(root, 'list');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ projectPath: '/p' }));
    writeFileSync(join(dir, 't1.json'), JSON.stringify({ id: 't1', title: 'older', status: 'pending' }));
    const t2Path = join(dir, 't2.json');
    writeFileSync(t2Path, JSON.stringify({ id: 't2', title: 'newer', status: 'pending' }));
    // Bump t2 mtime to 10s in the future so sort order is deterministic.
    const now = Date.now() + 10000;
    utimesSync(t2Path, now / 1000, now / 1000);

    const tasks = readProjectTasks({ tasksRoot: root, projectPath: '/p' });
    expect(tasks[0].title).toBe('newer');
  } finally {
    rmSync(root, { recursive: true });
  }
});

// Real-schema path: no meta.json, project mapping via `~/.claude/projects/<mangled>/<taskListId>/`.
test('readProjectTasks real-schema mode (projectsRoot + mangled dir + subject field)', () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-real-'));
  const projectsRoot = mkdtempSync(join(tmpdir(), 'projects-'));
  try {
    const listAId = 'list-a';
    const listBId = 'list-b';
    const dirA = join(root, listAId);
    const dirB = join(root, listBId);
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    // Real-world shape: no meta.json. Tasks use `subject`/`activeForm` fields.
    writeFileSync(
      join(dirA, '1.json'),
      JSON.stringify({
        id: '1',
        subject: 'Real task A',
        activeForm: 'Doing A',
        status: 'in_progress',
      }),
    );
    writeFileSync(join(dirA, '.lock'), '');
    writeFileSync(join(dirA, '.highwatermark'), '1');
    writeFileSync(
      join(dirB, '2.json'),
      JSON.stringify({
        id: '2',
        subject: 'Real task B',
        activeForm: 'Doing B',
        status: 'pending',
      }),
    );

    // Mapping lives at projectsRoot/<mangled-projectPath>/<taskListId>/
    // Claude Code mangles EVERY non-alphanumeric char to `-` (not just `/`),
    // so e.g. `/mnt/data_ssd/foo` → `-mnt-data-ssd-foo` (underscore also becomes dash).
    const projectPath = '/mnt/data_ssd/foo.bar';
    const mangled = '-mnt-data-ssd-foo-bar'; // `/`, `_`, `.` → `-`
    mkdirSync(join(projectsRoot, mangled, listAId), { recursive: true });
    // listBId NOT registered under this project → should be excluded.

    const tasks = readProjectTasks({ tasksRoot: root, projectsRoot, projectPath });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Real task A');
    expect(tasks[0].status).toBe('in_progress');
    expect(tasks[0].taskListId).toBe(listAId);
  } finally {
    rmSync(root, { recursive: true });
    rmSync(projectsRoot, { recursive: true });
  }
});

test('readProjectTasks skips malformed JSON without throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-malformed-'));
  try {
    const dir = join(root, 'list');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ projectPath: '/p' }));
    writeFileSync(join(dir, 't1.json'), '{ not valid json');
    writeFileSync(join(dir, 't2.json'), JSON.stringify({ id: 't2', title: 'ok', status: 'pending' }));

    const tasks = readProjectTasks({ tasksRoot: root, projectPath: '/p' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('ok');
  } finally {
    rmSync(root, { recursive: true });
  }
});
