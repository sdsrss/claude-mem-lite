// N3 (session-history analysis r2 §4.3): every ORDER BY on created_at_epoch in the SHIPPED
// population ends on an id tiebreaker, or is named below with the reason it cannot.
//
// Why a population guard: `ORDER BY created_at_epoch DESC` with no id INVERTS on a tie —
// SQLite hands back ascending rowid, oldest first — and the class was fixed site by site
// across three releases (d06dc32, 8876cc4, 43571e3), each found by a review that happened
// to read that file. The per-site guards (search-order-tiebreak, pre-tool-recall-tiebreak,
// …) pin behaviour; this one pins the population, so the next site is red on the commit
// that writes it instead of on the review that stumbles over it.
//
// Population = package.json#files, not a directory walk: that list is what a user installs,
// and it includes `scripts/*.js`, which a `.mjs`-only sweep misses. SQL is read from the
// AST (string literals, template literals, `+` chains), never from source lines: a line
// scan cannot see an ORDER BY that leads with a multi-line CASE term, which is how D#9's
// first pass shipped the 'wide' pool untiebroken. SQL `--` comments are stripped, because
// several statements quote the banned form inside their own comments.
//
// The rule, per ORDER BY clause: find the first term that names created_at / created_at_epoch;
// some LATER term must be `id` / `rowid` (same table alias), and when the created_at term is a
// bare column its tiebreaker runs in the same direction. `ABS(created_at_epoch - ?)` is an
// expression, so either direction passes there.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as acorn from 'acorn';
import { createTestDb } from './test-helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// Each entry: the file, the table the statement reads, the clause as normalised below, how
// many such clauses that file holds, and why they stay untiebroken. `count` is exact in both
// directions, so a stale entry is as red as a missing one.
const ALLOWED = [
  {
    file: 'hook-handoff.mjs',
    table: 'session_handoffs',
    clause: 'created_at_epoch DESC',
    count: 8,
    reason: 'HANDOFF_NO_ID',
  },
  {
    file: 'hook-context.mjs',
    table: 'session_handoffs',
    clause: 'created_at_epoch DESC',
    count: 2,
    reason: 'HANDOFF_NO_ID',
  },
  {
    file: 'lib/startup-dashboard.mjs',
    table: 'session_handoffs',
    clause: 'created_at_epoch DESC',
    count: 1,
    reason: 'HANDOFF_NO_ID',
  },
];

const REASONS = {
  // Judged 2026-09-26 (findings.md, the created_at_epoch tie bullet): the table has no id
  // column, and its rowid is not recency — the writer is an UPSERT that keeps the row's
  // original rowid, so `rowid DESC` would pick the older write whenever the lower-rowid row
  // was rewritten last. A real tiebreaker needs a column, i.e. a migration. The case at the
  // bottom turns red if that column ever lands, so the excuse cannot outlive its premise.
  HANDOFF_NO_ID: 'session_handoffs has no id column and its rowid is not write order',
};

const KEY = /\b(?:(\w+)\.)?created_at(?:_epoch)?\b/;
const BARE_KEY = /^(?:(\w+)\.)?created_at(?:_epoch)?(?:\s+(ASC|DESC))?$/i;
const TIEBREAK = /^(?:(\w+)\.)?(?:id|rowid)(?:\s+(ASC|DESC))?$/i;

function shippedJs() {
  const files = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).files;
  return files.filter((f) => /\.(mjs|js)$/.test(f));
}

function shippedNonJs() {
  const files = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).files;
  return files.filter((f) => !/\.(mjs|js)$/.test(f));
}

/** Static text of a string / template / `+` chain; an interpolation reads as `${…}`. */
function staticText(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') {
    return node.quasis
      .map((q, i) => (q.value.cooked ?? q.value.raw) + (i < node.expressions.length ? '${…}' : ''))
      .join('');
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const l = staticText(node.left);
    const r = staticText(node.right);
    if (l === null && r === null) return null;
    return (l ?? '${…}') + (r ?? '${…}');
  }
  return null;
}

/** Every maximal string-ish node in a module, with its start line. */
function sqlStrings(source) {
  const ast = acorn.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowHashBang: true,
    locations: true,
  });
  const out = [];
  (function walk(node, insidePlusChain) {
    if (!node || typeof node.type !== 'string') return;
    const isPlus = node.type === 'BinaryExpression' && node.operator === '+';
    if (!insidePlusChain && (node.type === 'Literal' || node.type === 'TemplateLiteral' || isPlus)) {
      const text = staticText(node);
      if (text !== null) out.push({ line: node.loc.start.line, text });
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'loc') continue;
      if (Array.isArray(v)) v.forEach((c) => walk(c, false));
      else if (v && typeof v.type === 'string') walk(v, isPlus && (k === 'left' || k === 'right'));
    }
  })(ast, false);
  return out;
}

const stripSqlComments = (s) => s.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

/** Each ORDER BY clause in `sql`: its terms, its offset, and the table it reads. */
function orderClauses(sql) {
  const res = [];
  const re = /ORDER\s+BY\s/gi;
  let m;
  while ((m = re.exec(sql))) {
    let i = m.index + m[0].length;
    let depth = 0;
    const start = i;
    for (; i < sql.length; i++) {
      const c = sql[i];
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break; // closes a window's OVER (…)
        depth--;
      } else if (c === ';' && depth === 0) break;
      else if (depth === 0 && /^\s(?:LIMIT|OFFSET|UNION|RETURNING)\b/i.test(sql.slice(i, i + 12))) break;
    }
    const terms = [];
    let cur = '';
    let d = 0;
    for (const c of sql.slice(start, i)) {
      if (c === '(') d++;
      if (c === ')') d--;
      if (c === ',' && d === 0) {
        terms.push(cur);
        cur = '';
      } else cur += c;
    }
    terms.push(cur);
    // The nearest FROM before the clause; a window's OVER (ORDER BY …) sits in the SELECT
    // list, ahead of its FROM, so fall back to the first one after it.
    const before = [...sql.slice(0, m.index).matchAll(/\bFROM\s+(\w+)/gi)];
    const after = sql.slice(m.index).match(/\bFROM\s+(\w+)/i);
    res.push({
      offset: m.index,
      terms: terms.map((t) => t.trim().replace(/\s+/g, ' ')).filter(Boolean),
      table: before.length ? before[before.length - 1][1] : (after?.[1] ?? null),
    });
  }
  return res;
}

/** null when the clause does not order by created_at; else whether its tiebreak is valid. */
function judgeClause(terms) {
  const k = terms.findIndex((t) => KEY.test(t));
  if (k < 0) return null;
  const keyTerm = terms[k];
  const bare = keyTerm.match(BARE_KEY);
  const alias = keyTerm.match(KEY)[1] ?? null;
  const ok = terms.slice(k + 1).some((t) => {
    const tb = t.match(TIEBREAK);
    if (!tb) return false;
    if ((tb[1] ?? null) !== alias) return false;
    if (!bare) return true;
    return (bare[2] ?? 'ASC').toUpperCase() === (tb[2] ?? 'ASC').toUpperCase();
  });
  return { ok };
}

/** The census: every created_at ordering in the shipped JS, judged. */
function census() {
  const sites = [];
  const fragments = [];
  const unparsed = [];
  for (const rel of shippedJs()) {
    let strings;
    try {
      strings = sqlStrings(readFileSync(join(REPO, rel), 'utf8'));
    } catch (e) {
      unparsed.push(`${rel}: ${e.message}`);
      continue;
    }
    for (const { line, text } of strings) {
      const sql = stripSqlComments(text);
      let ordered = false;
      for (const c of orderClauses(sql)) {
        const verdict = judgeClause(c.terms);
        if (!verdict) continue;
        ordered = true;
        sites.push({
          file: rel,
          line: line + (sql.slice(0, c.offset).match(/\n/g) || []).length,
          table: c.table,
          clause: c.terms.join(', '),
          ok: verdict.ok,
        });
      }
      // An ordering term held in its own string (`ORDER BY ${order}`) would escape the clause
      // parse above, so a created_at term with a direction outside any ORDER BY is a finding
      // too — except in DDL, where it is an index definition.
      if (
        !ordered &&
        /\bcreated_at(?:_epoch)?\s+(?:ASC|DESC)\b/i.test(sql) &&
        !/\bCREATE\s+(?:UNIQUE\s+)?(?:INDEX|TABLE)\b/i.test(sql)
      ) {
        fragments.push(`${rel}:${line}  ${sql.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
      }
    }
  }
  return { sites, fragments, unparsed };
}

describe('N3 — every created_at ORDER BY in the shipped tree has an id tiebreaker', () => {
  const { sites, fragments, unparsed } = census();

  it('premise: the census parses the whole population and reaches the hard shapes', () => {
    expect(unparsed).toEqual([]);
    expect(shippedJs().length).toBeGreaterThan(100);
    expect(sites.length).toBeGreaterThanOrEqual(70);
    // Every clause resolved its table, which the allowlist keys on.
    expect(sites.filter((s) => !s.table).map((s) => `${s.file}:${s.line}`)).toEqual([]);
    const has = (pred) => sites.some(pred);
    // A clause that LEADS with a multi-line CASE term — the shape a line grep cannot see.
    expect(has((s) => s.file === 'hook-optimize.mjs' && s.clause.startsWith('CASE') && s.ok)).toBe(true);
    // A window function's ORDER BY inside OVER (…), closed by its own paren.
    expect(
      has(
        (s) =>
          s.file === 'lib/deferred-work.mjs' && s.clause === 'priority DESC, created_at_epoch ASC, id ASC',
      ),
    ).toBe(true);
    // An interpolated term ahead of the key, and a `scripts/*.js` file (not a .mjs).
    expect(
      has((s) => s.file === 'scripts/pre-tool-recall.js' && s.clause.includes('${…} DESC') && s.ok),
    ).toBe(true);
    // The allowlisted shape is really seen, on the table the allowlist names.
    expect(has((s) => s.file === 'hook-handoff.mjs' && s.table === 'session_handoffs' && !s.ok)).toBe(true);
  });

  it('every untiebroken ordering is allowlisted, with an exact count per file / table / clause', () => {
    const counts = new Map();
    const offenders = [];
    for (const s of sites.filter((x) => !x.ok)) {
      const entry = ALLOWED.find((a) => a.file === s.file && a.table === s.table && a.clause === s.clause);
      if (!entry) {
        offenders.push(`${s.file}:${s.line}  FROM ${s.table}  ORDER BY ${s.clause}`);
        continue;
      }
      counts.set(entry, (counts.get(entry) ?? 0) + 1);
    }
    expect(
      offenders,
      'ORDER BY created_at_epoch without an id tiebreaker (append `, id <same direction>`)',
    ).toEqual([]);
    for (const a of ALLOWED) {
      expect(REASONS[a.reason], `${a.file}: allowlist reason`).toBeTruthy();
      expect(counts.get(a) ?? 0, `${a.file} ${a.table} "${a.clause}" allowlist count`).toBe(a.count);
    }
  });

  it('no created_at ordering term hides in a string outside its ORDER BY', () => {
    expect(fragments).toEqual([]);
  });

  it('the non-JS shipped files carry no created_at ORDER BY (so the JS census is the whole population)', () => {
    const hits = [];
    for (const rel of shippedNonJs()) {
      let text;
      try {
        text = readFileSync(join(REPO, rel), 'utf8');
      } catch {
        continue; // a generated file absent from a dev tree (npm-shrinkwrap.json) holds no SQL
      }
      if (/ORDER\s+BY[^;]{0,200}?created_at/i.test(text)) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });

  it("HANDOFF_NO_ID's premise holds: session_handoffs still has no id column", () => {
    const db = createTestDb();
    try {
      const cols = db
        .prepare('PRAGMA table_info(session_handoffs)')
        .all()
        .map((c) => c.name);
      expect(cols).toContain('created_at_epoch'); // premise: the PRAGMA read the real table
      expect(cols).not.toContain('id');
    } finally {
      db.close();
    }
  });

  it('the judge says NO to each wrong tiebreak shape', () => {
    expect(judgeClause(['created_at_epoch DESC']).ok).toBe(false);
    expect(judgeClause(['created_at_epoch DESC', 'id ASC']).ok).toBe(false); // wrong direction
    expect(judgeClause(['o.created_at_epoch DESC', 'id DESC']).ok).toBe(false); // wrong alias
    expect(judgeClause(['id DESC', 'created_at_epoch DESC']).ok).toBe(false); // id BEFORE the key
    expect(judgeClause(['created_at_epoch DESC', 'id DESC']).ok).toBe(true);
    expect(judgeClause(['project', 'created_at_epoch', 'id']).ok).toBe(true);
    expect(judgeClause(['ABS(created_at_epoch - ?) ASC', 'id DESC']).ok).toBe(true);
    expect(judgeClause(['score', 'id DESC'])).toBe(null);
  });
});
