// Long-gap arm of the value A/B: move a trajectory's PRIVATE store back in time between S1 and S2, so S2 starts as
// if S1 were N days old. Every `*_epoch` column and every integer `*_at` column (ms) drops by N days; every text
// `*_at` column holding an ISO time is rewritten the same; files under the data dir's runtime/ get their mtimes
// moved too. The system clock is not touched: a skewed clock would make the CLI think its OAuth token expired.
// Usage: node benchmark/value-ab/age-store.mjs <store.db> <days> [--runtime <dir>]
import Database from 'better-sqlite3';
import { readdirSync, statSync, utimesSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY = 86400000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function ageFiles(dir, ms) {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) n += ageFiles(p, ms);
    const t = new Date(st.mtimeMs - ms);
    utimesSync(p, t, t);
    n++;
  }
  return n;
}

/** Shift one store back by `days`; refuses the real store. Returns { rows, columns, files }. */
export function shiftStore(dbPath, days, { runtimeDir } = {}) {
  const path = resolve(dbPath);
  const realDir = resolve(homedir(), '.claude-mem-lite');
  if (path === realDir || path.startsWith(realDir + sep)) {
    throw new Error(`refusing the real store: ${path} (age only a trajectory's private CLAUDE_MEM_DIR)`);
  }
  if (!(days > 0)) throw new Error(`days must be > 0, got ${days}`);
  const ms = Math.round(days * DAY);
  const db = new Database(path, { fileMustExist: true });
  let rows = 0;
  const columns = [];
  try {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'`,
      )
      .all()
      .map((r) => r.name);
    db.transaction(() => {
      for (const t of tables) {
        const cols = db
          .prepare(`SELECT name FROM pragma_table_info(?)`)
          .all(t)
          .map((r) => r.name)
          .filter((c) => c.endsWith('_epoch') || c.endsWith('_at'));
        for (const c of cols) {
          const q = (s) => `"${s.replace(/"/g, '""')}"`;
          const n1 = db
            .prepare(`UPDATE ${q(t)} SET ${q(c)} = ${q(c)} - ? WHERE typeof(${q(c)}) = 'integer'`)
            .run(ms).changes;
          let n2 = 0;
          const upd = db.prepare(`UPDATE ${q(t)} SET ${q(c)} = ? WHERE rowid = ?`);
          for (const r of db
            .prepare(`SELECT rowid AS id, ${q(c)} AS v FROM ${q(t)} WHERE typeof(${q(c)}) = 'text'`)
            .all()) {
            if (ISO.test(r.v)) n2 += upd.run(new Date(Date.parse(r.v) - ms).toISOString(), r.id).changes;
          }
          if (n1 + n2) columns.push(`${t}.${c}:${n1 + n2}`);
          rows += n1 + n2;
        }
      }
    })();
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  const files = runtimeDir ? ageFiles(runtimeDir, ms) : 0;
  return { rows, columns, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dbPath, days, flag, runtimeDir] = process.argv.slice(2);
  if (!dbPath || !days || (flag && flag !== '--runtime')) {
    console.error('usage: node benchmark/value-ab/age-store.mjs <store.db> <days> [--runtime <dir>]');
    process.exit(2);
  }
  console.log(JSON.stringify(shiftStore(dbPath, Number(days), { runtimeDir })));
}
