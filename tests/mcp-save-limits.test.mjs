// P3-14: mem_save validated TYPES but not SIZE on its free-text fields, so an
// oversized value landed verbatim in an unbounded TEXT column — and every later FTS
// rebuild, minhash and vector recompute then paid for that row forever. `content` and
// `lesson_learned` already carry zod ceilings (max 50000 / max 500 in tool-schemas.mjs,
// which is a REJECTION), but `title` had none at all: `z.string().optional()`.
//
// The fix truncates with an explicit marker rather than rejecting — rejection would be
// a breaking contract change on a published MCP tool, truncation degrades gracefully.
//
// Two layers here: the wire test proves the registered handler applies the ceiling
// (a helper nobody calls would pass a unit test and fix nothing); the unit tests pin
// the marker/limit semantics, including the arms zod fronts today.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { clampSaveText, SAVE_TEXT_LIMITS } from '../server.mjs';

const SERVER_PATH = resolve(import.meta.dirname, '../server.mjs');
const DB_DIR = `/tmp/mem-save-limits-${process.pid}`;

let client, transport;

beforeAll(async () => {
  try {
    rmSync(DB_DIR, { recursive: true });
  } catch {
    /* fresh */
  }
  mkdirSync(`${DB_DIR}/runtime`, { recursive: true });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      ...process.env,
      CLAUDE_MEM_DIR: DB_DIR,
      CLAUDE_PROJECT_DIR: '/test/project',
      PWD: '/test/project',
      CLAUDE_MEM_AUTO_DEEP: '0',
    },
  });
  client = new Client({ name: 'save-limits-client', version: '0.0.0' });
  await client.connect(transport);
}, 15_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* already down */
  }
  try {
    await transport?.close();
  } catch {
    /* already down */
  }
  try {
    rmSync(DB_DIR, { recursive: true });
  } catch {
    /* best effort */
  }
});

describe('mem_save size ceiling', () => {
  it('truncates a runaway title instead of storing it verbatim', async () => {
    const hugeTitle = 'T'.repeat(20000);
    const res = await client.callTool({
      name: 'mem_save',
      arguments: {
        content: 'a runaway summarizer wrote an enormous title for this observation',
        title: hugeTitle,
        type: 'discovery',
      },
    });
    const text = (res?.content || []).map((c) => c.text).join('\n');
    expect(res.isError, text).toBeFalsy();
    const id = Number(text.match(/#(\d+)/)?.[1]);
    expect(Number.isInteger(id)).toBe(true);

    const db = new Database(join(DB_DIR, 'claude-mem-lite.db'), { readonly: true });
    const row = db.prepare('SELECT title FROM observations WHERE id = ?').get(id);
    db.close();

    expect(row.title.length).toBeLessThanOrEqual(SAVE_TEXT_LIMITS.title);
    expect(row.title).toMatch(/truncated/);
    expect(row.title.startsWith('TTTT')).toBe(true);
  });

  it('leaves a normal-sized save byte-identical (ceiling is a sanity bound, not a style rule)', async () => {
    const title = 'ordinary title for a normal save';
    const res = await client.callTool({
      name: 'mem_save',
      arguments: {
        content: 'an ordinary observation body about the retry backoff schedule',
        title,
        type: 'decision',
      },
    });
    const text = (res?.content || []).map((c) => c.text).join('\n');
    const id = Number(text.match(/#(\d+)/)?.[1]);
    const db = new Database(join(DB_DIR, 'claude-mem-lite.db'), { readonly: true });
    const row = db.prepare('SELECT title, narrative FROM observations WHERE id = ?').get(id);
    db.close();
    expect(row.title).toBe(title);
    expect(row.narrative).toBe('an ordinary observation body about the retry backoff schedule');
  });
});

describe('clampSaveText', () => {
  it('returns short input untouched (same reference, no marker)', () => {
    expect(clampSaveText('short', 100)).toBe('short');
    expect(clampSaveText('x'.repeat(100), 100)).toBe('x'.repeat(100));
  });

  it('never exceeds the limit and names the original size', () => {
    const out = clampSaveText('y'.repeat(9000), 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toContain('9000');
    expect(out).toMatch(/truncated/);
  });

  it('passes through non-strings unchanged (undefined / null optional fields)', () => {
    expect(clampSaveText(undefined, 500)).toBeUndefined();
    expect(clampSaveText(null, 500)).toBeNull();
  });

  it('publishes ceilings for content / title / lesson_learned', () => {
    // content + lesson_learned mirror the zod caps in tool-schemas.mjs, so the
    // published contract is not narrowed; title had no bound at all before.
    expect(SAVE_TEXT_LIMITS).toEqual({ content: 50000, title: 500, lesson_learned: 500 });
  });
});
