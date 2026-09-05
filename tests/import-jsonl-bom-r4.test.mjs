// R4 E2E audit (LOW) — importJsonl dropped line 1 when the transcript file carried a
// leading UTF-8 BOM: Node's utf8 read leaves the BOM on, so line 1 parsed as
// a U+FEFF-prefixed "{...}" makes JSON.parse throw, so the line is silently "skipped". Real CC
// transcripts are BOM-less, but an editor-touched / re-encoded file can carry one.
import { describe, it, expect, beforeEach } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { createTestDb } from './test-helpers.mjs';
import { importJsonl } from '../lib/import-jsonl.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures/sample-claude-jsonl/sample.jsonl');

describe('importJsonl — leading UTF-8 BOM (R4)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });

  it('imports every line even when the file starts with a BOM (line 1 not dropped)', async () => {
    const raw = readFileSync(FIXTURE, 'utf8');
    const BOM = String.fromCharCode(0xfeff);
    const bomPath = join(mkdtempSync(join(tmpdir(), 'bom-')), 'bom.jsonl');
    writeFileSync(bomPath, BOM + raw); // prepend the BOM
    const r = await importJsonl(db, bomPath, { project: 'proj' });
    expect(r.prompts).toBe(2); // both prompts imported — the BOM-prefixed first line survived
  });
});
