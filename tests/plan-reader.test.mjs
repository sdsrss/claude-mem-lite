import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { recentPlans } from '../lib/plan-reader.mjs';

test('recentPlans returns sorted by mtime DESC', () => {
  const root = mkdtempSync(join(tmpdir(), 'plans-'));
  try {
    writeFileSync(join(root, 'old.md'), '# old');
    writeFileSync(join(root, 'new.md'), '# new');
    // bump mtime on new.md
    const future = Date.now() + 10000;
    utimesSync(join(root, 'new.md'), future / 1000, future / 1000);
    const result = recentPlans({ plansRoot: root, limit: 5 });
    expect(result[0].name).toBe('new');
    expect(result[1].name).toBe('old');
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('recentPlans returns empty when plans dir is missing', () => {
  const result = recentPlans({ plansRoot: '/nonexistent', limit: 5 });
  expect(result).toEqual([]);
});

test('recentPlans respects limit', () => {
  const root = mkdtempSync(join(tmpdir(), 'plans-limit-'));
  try {
    for (let i = 0; i < 10; i++) writeFileSync(join(root, `p${i}.md`), `# ${i}`);
    const result = recentPlans({ plansRoot: root, limit: 3 });
    expect(result).toHaveLength(3);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('recentPlans ignores non-.md files', () => {
  const root = mkdtempSync(join(tmpdir(), 'plans-ext-'));
  try {
    writeFileSync(join(root, 'foo.md'), '# foo');
    writeFileSync(join(root, 'bar.txt'), 'bar');
    writeFileSync(join(root, 'baz.json'), '{}');
    const result = recentPlans({ plansRoot: root, limit: 10 });
    expect(result.map((r) => r.name)).toEqual(['foo']);
  } finally {
    rmSync(root, { recursive: true });
  }
});
