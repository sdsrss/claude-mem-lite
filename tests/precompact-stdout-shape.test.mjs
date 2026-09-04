// PreCompact must write BARE text to stdout — never the hook-stdout JSON envelope.
//
// This is the one hook face in the tree where the envelope is wrong, so it reads like
// an inconsistency waiting to be tidied up. It is not. Verified against the Claude Code
// 2.1.260 bundle (2026-09-04):
//
//   • the hook runner sets `result.output = status === 0 ? stdout : stderr` — the RAW
//     stdout, whatever it is, separately from the parsed `answer`;
//   • `executePreCompactHooks` reads exactly that field:
//       v = results.filter(r => r.succeeded && !r.blocked && r.output.trim()).map(r => r.output.trim())
//       return { newCustomInstructions: v.length ? v.join("\n\n") : undefined, … }
//   • and `newCustomInstructions` is handed to the compaction summarizer as its
//     `customInstructions` at four call sites.
//
// So routing this through lib/hook-stdout.mjs would deliver `{"hookSpecificOutput":…}`
// to the summarizer as its literal instruction text. The header of lib/hook-stdout.mjs
// used to assert the opposite ("every other event — dropped in silence"), which would
// have made hook-precompact.mjs look like dead code; both are corrected together.
//
// Two assertions, on purpose. The behavioural one pins what actually reaches the host;
// the source one names the specific refactor that would break it, because a future
// envelope emitted only on a code path this fixture does not reach would slip past the
// first assertion alone.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { insertDeferred } from '../lib/deferred-work.mjs';
import { handlePreCompact } from '../hook-precompact.mjs';

// join(), not `new URL('../x.mjs', import.meta.url)` — the URL form silently removes the
// named module from knip's unused-export report (CLAUDE.md knip rule 4).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'test';
const SESSION = 'cc-precompact-shape';

describe('handlePreCompact writes bare text, not an envelope', () => {
  let db;
  let runtimeDir;
  let written;
  let spy;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-pc', project: PROJECT });
    runtimeDir = mkdtempSync(join(tmpdir(), 'precompact-shape-'));
    written = [];
    spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    spy.mockRestore();
    db.close();
    try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* gone */ }
  });

  it('emits a bare <claude-mem-context> block that is not parseable as JSON', () => {
    // Deferred work renders unconditionally, so this fixture does not depend on the
    // quiet/adopted gating that empties the Key Context sections under a real cwd.
    insertDeferred(db, { project: PROJECT, title: 'a carried-over item', priority: 2 });

    handlePreCompact({ db, project: PROJECT, sessionId: SESSION, runtimeDir });

    // Premise: an empty render writes nothing, and every assertion below would then
    // pass over an empty array. This is the case that keeps the suite from going vacuous.
    expect(written.length, 'PreCompact emitted nothing — the shape assertions are vacuous')
      .toBeGreaterThan(0);

    const out = written.join('');
    expect(out).toContain('<claude-mem-context>');
    expect(out.trim().startsWith('{'),
      'stdout starts with { — the host would parse it as an envelope and hand the '
      + 'summarizer literal JSON as its custom instructions').toBe(false);
    // The whole stdout becomes newCustomInstructions verbatim, so a stray JSON document
    // anywhere in it is the same defect one line further down.
    expect(out).not.toContain('hookSpecificOutput');
  });

  it('the source does not reach for the envelope writer', () => {
    const src = readFileSync(join(ROOT, 'hook-precompact.mjs'), 'utf8');
    for (const banned of ['hook-stdout', 'queueHookContext', 'flushHookStdout']) {
      expect(src.includes(banned),
        `hook-precompact.mjs now references ${banned}. PreCompact's output is read as RAW `
        + 'stdout by executePreCompactHooks and becomes the compaction summarizer\'s '
        + 'customInstructions — an envelope there ships JSON as instructions. See the '
        + 'corrections block at the top of lib/hook-stdout.mjs.').toBe(false);
    }
    // Self-check: the matcher must be able to say yes, or a renamed export would make
    // this pass by finding nothing rather than by the invariant holding.
    expect(readFileSync(join(ROOT, 'scripts/pre-tool-recall.js'), 'utf8'))
      .toContain('queueHookContext');
  });
});
