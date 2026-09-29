// Search and get mark an observation that was machine-written rather than saved explicitly
// (lib/provenance.mjs). The CLI get header is pinned in tests/cli.test.mjs, which already
// mocks the schema onto an in-memory DB; `── #N ──` for an explicit save stays pinned in
// tests/feature-sweep-mcp.test.mjs.

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { isAutoWritten } from '../lib/provenance.mjs';
import { saveObservation } from '../lib/save-observation.mjs';
import { snippetAddsInfo } from '../search-engine.mjs';
import { handleSearchForTest } from '../server.mjs';
import { cmdSearchForTest } from '../mem-cli.mjs';

const LEGEND = ' · 🤖 = auto-written, not an explicit save';

describe('isAutoWritten', () => {
  it('is false for an explicit save', () => {
    expect(isAutoWritten('manual-prov')).toBe(false);
  });

  it('is true for every machine writer', () => {
    expect(isAutoWritten('hook-prov-1a2b3c4d')).toBe(true);
    expect(isAutoWritten('import-8e0fba1e-1100-4c5e-9d1a-000000000000')).toBe(true);
    expect(isAutoWritten('compress-prov')).toBe(true);
    // Rows imported from older stores carry a bare session uuid.
    expect(isAutoWritten('8e0fba1e-1100-4c5e-9d1a-000000000000')).toBe(true);
  });

  it('is false for an unknown id', () => {
    expect(isAutoWritten(null)).toBe(false);
    expect(isAutoWritten(undefined)).toBe(false);
    expect(isAutoWritten('')).toBe(false);
  });

  it('agrees with the namespace saveObservation writes', () => {
    const db = createTestDb();
    saveObservation(db, { content: 'a deliberate note about the gizmo', project: 'prov' });
    const row = db.prepare('SELECT memory_session_id FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(isAutoWritten(row.memory_session_id)).toBe(false);
  });
});

describe('snippetAddsInfo', () => {
  const title = 'gizmo calibration drifts after reboot on the bench rig';

  it('is false when the excerpt is the title with highlight markers', () => {
    expect(snippetAddsInfo('»gizmo« calibration drifts after reboot on the bench rig', title)).toBe(false);
  });

  it('is false when the excerpt is a cut piece of the title', () => {
    expect(snippetAddsInfo('…calibration drifts after »reboot« on…', title)).toBe(false);
  });

  it('is true when the excerpt says something the title does not', () => {
    expect(snippetAddsInfo('…the »gizmo« loses its offset on cold boot…', title)).toBe(true);
  });

  it('is false for a missing or trivially short excerpt', () => {
    expect(snippetAddsInfo('', title)).toBe(false);
    expect(snippetAddsInfo(null, title)).toBe(false);
    expect(snippetAddsInfo('»gizmo«', 'other')).toBe(false);
  });
});

describe('search marks machine-written observations', () => {
  let db, manualId, autoId;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'manual-prov', project: 'prov' });
    insertSession(db, { id: 'hook-prov-1a2b3c4d', project: 'prov' });
    manualId = Number(
      insertObs(db, {
        sessionId: 'manual-prov',
        project: 'prov',
        title: 'gizmo calibration drifts after reboot',
        narrative: 'gizmo calibration drifts after reboot',
      }).lastInsertRowid,
    );
    autoId = Number(
      insertObs(db, {
        sessionId: 'hook-prov-1a2b3c4d',
        project: 'prov',
        title: 'Recalibrated gizmo offsets',
        narrative: 'Ran the gizmo offset script against the bench rig and stored the new offsets',
      }).lastInsertRowid,
    );
  });

  const mcpLines = async () =>
    (await handleSearchForTest(db, { query: 'gizmo', project: 'prov' }, {})).content[0].text.split('\n');
  const rowAt = (lines, id) => lines.findIndex((l) => l.startsWith(`#${id} `));

  async function cliOut(extra = []) {
    let out = '';
    const orig = process.stdout.write;
    process.stdout.write = (s) => ((out += s), true);
    try {
      await cmdSearchForTest(db, ['gizmo', '--project', 'prov', ...extra], {});
    } finally {
      process.stdout.write = orig;
    }
    return out;
  }
  const cliLines = async () => (await cliOut()).split('\n');

  it('MCP tags only the machine-written row and explains the tag', async () => {
    const lines = await mcpLines();
    expect(lines[rowAt(lines, autoId)]).toContain('] 🤖 ');
    expect(lines[rowAt(lines, manualId)]).not.toContain('🤖');
    expect(lines[0]).toContain(LEGEND);
  });

  it('MCP omits the legend when every row is an explicit save', async () => {
    db.prepare('DELETE FROM observations WHERE id = ?').run(autoId);
    const text = (await mcpLines()).join('\n');
    expect(text).toContain(`#${manualId} `);
    expect(text).not.toContain('🤖');
  });

  it('MCP does not repeat a short save title as its snippet', async () => {
    const lines = await mcpLines();
    expect(lines[rowAt(lines, manualId) + 1]).not.toMatch(/calibration drifts after reboot/);
  });

  it('MCP still shows a snippet that adds to the title', async () => {
    const lines = await mcpLines();
    expect(lines[rowAt(lines, autoId) + 1]).toMatch(/offset script against the bench rig/);
  });

  it('CLI tags only the machine-written row and explains the tag', async () => {
    const lines = await cliLines();
    expect(lines[rowAt(lines, autoId)]).toContain(' 🤖 ');
    expect(lines[rowAt(lines, manualId)]).not.toContain('🤖');
    expect(lines.join('\n')).toContain(LEGEND);
  });

  it('CLI --json carries the flag on observation rows', async () => {
    const { results } = JSON.parse(await cliOut(['--json']));
    const byId = Object.fromEntries(results.filter((r) => r.source === 'obs').map((r) => [r.id, r.auto]));
    expect(byId).toEqual({ [manualId]: false, [autoId]: true });
  });
});
