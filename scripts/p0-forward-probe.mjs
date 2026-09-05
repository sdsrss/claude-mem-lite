#!/usr/bin/env node
// Forward probe: seed injection_count from scan data into probe DB, measure
// noise penalty impact on top-noise IDs vs top-cited IDs.
//
// Read-only against real DB except for a transient copy in memory.

import Database from 'better-sqlite3';
import { readdirSync, statSync, createReadStream, copyFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { homedir, tmpdir } from 'node:os';
import { noisePenaltyClause } from '../scoring-sql.mjs';
import { resolveDataDir } from '../lib/resolve-data-dir.mjs';
import { OBS_ID_DIGITS, citationIdRe } from '../lib/citation-tracker.mjs';

const MEM_DB = join(resolveDataDir(process.env.CLAUDE_MEM_DIR), 'claude-mem-lite.db');
const TRANSCRIPTS = join(homedir(), '.claude', 'projects', '-mnt-data-ssd-dev-projects-mem');
const CUTOFF = Date.now() - 30 * 24 * 3600 * 1000;

// ─── Scan transcripts to get injection counts + cite counts ──────────────────
const files = readdirSync(TRANSCRIPTS)
  .filter((n) => n.endsWith('.jsonl'))
  .map((n) => ({ p: join(TRANSCRIPTS, n), mt: statSync(join(TRANSCRIPTS, n)).mtimeMs }))
  .filter((f) => f.mt >= CUTOFF);

const injectedIds = new Map();
const citedIds = new Map();
// Calibers come from the owner (lib/citation-tracker.mjs), not from a local literal. This
// file carried a seventh hand-written `{3,6}` — narrower than every other copy in the repo
// at BOTH ends, so it could see neither `#1`-`#99` nor 7-digit ids — and it was found only
// because the v3.80.0 pre-tag review noticed the sweep guard was not looking in scripts/.
// `idRegex` is the numerator (bare `#NN` in prose); `injectLineRegex` is a denominator and
// stays anchored by the `[type]`/icon suffix, which is what makes widening it safe here.
const idRegex = citationIdRe();
const injectLineRegex = new RegExp(`#${OBS_ID_DIGITS}\\s*(?:\\[[a-z_]+\\]|[🔴🟡🟢🔵🟣📝🔍💬])`, 'u');

for (const f of files) {
  const rl = createInterface({ input: createReadStream(f.p), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    // Injections: attachment or user-wrapped
    const texts = [];
    if (obj.type === 'attachment' && typeof obj.attachment?.content === 'string') {
      texts.push(['inject', obj.attachment.content]);
    }
    if (obj.message?.role === 'user' && Array.isArray(obj.message.content)) {
      for (const blk of obj.message.content) {
        if (blk.type === 'tool_result' && typeof blk.content === 'string')
          texts.push(['inject', blk.content]);
        if (blk.type === 'text' && typeof blk.text === 'string') texts.push(['inject', blk.text]);
      }
    }
    for (const [, t] of texts) {
      if (injectLineRegex.test(t)) {
        const ids = t.match(idRegex) || [];
        for (const tok of ids) {
          const id = Number(tok.slice(1));
          injectedIds.set(id, (injectedIds.get(id) || 0) + 1);
        }
      }
    }
    // Cites (assistant text)
    if (obj.message?.role === 'assistant' && Array.isArray(obj.message.content)) {
      for (const blk of obj.message.content) {
        if (blk.type === 'text' && typeof blk.text === 'string') {
          if (/Related memories|Past similar questions/.test(blk.text)) continue;
          const ids = blk.text.match(idRegex) || [];
          for (const tok of ids) {
            const id = Number(tok.slice(1));
            citedIds.set(id, (citedIds.get(id) || 0) + 1);
          }
        }
      }
    }
  }
}

// ─── Snapshot real DB to /tmp, open writable for seeding ─────────────────────
const SNAP = join(tmpdir(), `p0-probe-${process.pid}.db`);
copyFileSync(MEM_DB, SNAP);
const pdb = new Database(SNAP);

// Seed injection_count from scan data (the post-v26 expected distribution)
try {
  pdb.exec('ALTER TABLE observations ADD COLUMN injection_count INTEGER NOT NULL DEFAULT 0');
} catch {}
try {
  pdb.exec('ALTER TABLE observations ADD COLUMN last_injected_at INTEGER');
} catch {}
const upd = pdb.prepare('UPDATE observations SET injection_count = ? WHERE id = ?');
for (const [id, cnt] of injectedIds) upd.run(cnt, id);

// ─── Forward probe: for each top-noise ID, compute current penalty ───────────
const penaltySql = noisePenaltyClause('o');
const probeStmt = pdb.prepare(`
  SELECT o.id, o.type, o.title, o.injection_count, o.access_count,
         ${penaltySql} as penalty
  FROM observations o
  WHERE o.id = ?
`);

function tierLabel(p) {
  if (p <= 0.25) return '✂️  0.2× (tier-2)';
  if (p <= 0.75) return '🟡 0.5× (tier-1)';
  return '🟢 1.0× (kept)';
}

const topNoise = [...injectedIds.entries()]
  .filter(([id]) => !citedIds.has(id))
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10);

console.log('=== Top injected-never-cited IDs (noise candidates) ===');
console.log('  ID       type       inject  access  penalty           title');
console.log('  ' + '-'.repeat(78));
for (const [id] of topNoise) {
  const row = probeStmt.get(id);
  if (!row) {
    console.log(`  #${id}  (not in DB — transcript-only ref)`);
    continue;
  }
  console.log(
    `  #${String(row.id).padEnd(5)} ${(row.type || '').padEnd(10)} ${String(row.injection_count).padStart(6)} ${String(row.access_count).padStart(7)}  ${tierLabel(row.penalty).padEnd(18)} ${(row.title || '').slice(0, 48)}`,
  );
}

const topCited = [...citedIds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log();
console.log('=== Top cited IDs (verify penalty spares them) ===');
console.log('  ID       type       inject  access  penalty           title');
console.log('  ' + '-'.repeat(78));
for (const [id] of topCited) {
  const row = probeStmt.get(id);
  if (!row) {
    console.log(`  #${id}  (not in DB)`);
    continue;
  }
  console.log(
    `  #${String(row.id).padEnd(5)} ${(row.type || '').padEnd(10)} ${String(row.injection_count).padStart(6)} ${String(row.access_count).padStart(7)}  ${tierLabel(row.penalty).padEnd(18)} ${(row.title || '').slice(0, 48)}`,
  );
}

// Aggregate impact
const allInjected = [...injectedIds.keys()];
let t2 = 0,
  t1 = 0,
  keep = 0,
  missing = 0;
for (const id of allInjected) {
  const row = probeStmt.get(id);
  if (!row) {
    missing++;
    continue;
  }
  if (row.penalty <= 0.25) t2++;
  else if (row.penalty <= 0.75) t1++;
  else keep++;
}
console.log();
console.log(`=== Aggregate penalty impact on ${allInjected.length} unique injected IDs ===`);
console.log(`  tier-2 (0.2×):  ${t2}`);
console.log(`  tier-1 (0.5×):  ${t1}`);
console.log(`  kept  (1.0×):  ${keep}`);
console.log(`  not in DB:     ${missing}  (transcript refs older than current DB)`);

pdb.close();
try {
  unlinkSync(SNAP);
} catch {}
