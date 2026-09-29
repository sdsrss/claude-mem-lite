// Every injection surface stays under the host's 10,000-character hook-output cap.
//
// Over the cap the host does not truncate at 10,000: it writes the text to a file and hands
// the model a 2,000-character preview it is never asked to follow (lib/hook-text-cap.mjs
// quotes the hooks reference). Three layers here:
//   1. capHookText / writePlainHookText units;
//   2. the envelope writer caps each field it emits;
//   3. a REAL overflow reached through a shipped surface — the UserPromptSubmit deferred-work
//      block, which injects a D#'s detail "never truncated" — spawned as a subprocess;
//   4. STRUCTURAL: no registered hook entry point writes stdout except through the two
//      capped writers, so a new plain write cannot bypass the cap unnoticed.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import {
  HOOK_TEXT_CAP,
  capHookText,
  writePlainHookText,
  resetPlainHookText,
  idsShownWhole,
} from '../lib/hook-text-cap.mjs';
import {
  queueHookContext,
  queueHookSystemMessage,
  flushHookStdout,
  resetHookStdout,
  previewHookContext,
} from '../lib/hook-stdout.mjs';
import { initSchema } from '../schema.mjs';
import { keyContextIdsFileName } from '../lib/injected-ids.mjs';
import { handlePreCompact } from '../hook-precompact.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A subprocess env that cannot read or write the real install. */
function sandboxEnv(root, data) {
  const home = join(root, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete env[k];
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PWD;
  return Object.assign(env, {
    HOME: home,
    CLAUDE_MEM_DIR: data,
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_REPOS: '1',
    MEM_NO_AUTO_ADOPT: '1',
  });
}

function rows(n, width = 90) {
  return Array.from({ length: n }, (_, i) => `- #${i + 1} ${'x'.repeat(width)}`);
}

describe('capHookText', () => {
  it('returns text within the cap unchanged', () => {
    const s = rows(10).join('\n');
    expect(capHookText(s)).toBe(s);
  });

  it('trims by whole lines under the cap and names the dropped ids', () => {
    const s = rows(300).join('\n'); // ~29K
    const out = capHookText(s);
    expect(out.length).toBeLessThanOrEqual(HOOK_TEXT_CAP);
    const lines = out.split('\n');
    // every kept row is whole
    for (const l of lines.slice(0, -1)) expect(l).toMatch(/^- #\d+ x{90}$/);
    const footer = lines[lines.length - 1];
    expect(footer).toMatch(
      /^\[claude-mem-lite\] \d+ more line\(s\) not shown — hook output limit \(ids: #\d+/,
    );
    // kept rows are #1..#(lines.length-1), so the first dropped one is #(lines.length)
    expect(footer).toContain(`(ids: #${lines.length},`);
    expect(footer).toMatch(/\+\d+ more\)$/);
  });

  it('closes a tag block whose closing line was cut', () => {
    const s = ['<memory-context relevance="high">', ...rows(300), '</memory-context>'].join('\n');
    const out = capHookText(s);
    expect(out.length).toBeLessThanOrEqual(HOOK_TEXT_CAP);
    expect(out.startsWith('<memory-context relevance="high">')).toBe(true);
    expect(out.endsWith('</memory-context>')).toBe(true);
    expect(out.match(/<\/memory-context>/g)).toHaveLength(1);
  });

  it('a line cut short is marked, and its footer names the ids in the cut part (review P3-1)', () => {
    const line = `Memory — a past lesson applies. You must: ${'do the thing. '.repeat(80)}(#4242)`;
    const out = capHookText(line, 700);
    expect(out.length).toBeLessThanOrEqual(700);
    const [head, footer] = out.split('\n');
    expect(head.endsWith('…')).toBe(true);
    expect(footer).toBe('[claude-mem-lite] a line was cut short — hook output limit (ids: #4242)');
  });

  it('a cut never lands inside an id: it backs off to the word boundary (delta review P3-A)', () => {
    for (let pad = 0; pad < 12; pad++) {
      const text = `${'w'.repeat(pad)} ${'word '.repeat(38)}E#34567 tail ${'z '.repeat(300)}`;
      const [head, footer] = capHookText(text, 700).split('\n');
      const shown = head.slice(0, -1); // drop the ellipsis
      expect(text.startsWith(shown)).toBe(true);
      // the cut sits at a token boundary: what follows it in the original is whitespace
      expect(/^\s/.test(text.slice(shown.length)) || /\s$/.test(shown)).toBe(true);
      if (!shown.includes('E#34567')) expect(footer).toContain('E#34567');
    }
  });

  it('never leaves half of a surrogate pair at the cut (review P3-1)', () => {
    for (let pad = 0; pad < 4; pad++) {
      const out = capHookText(`${'x'.repeat(pad)}${'🔴'.repeat(400)}`, 700);
      expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out)).toBe(false);
    }
  });

  it('the footer does not count a closing line it re-appends (review P3-3)', () => {
    const rows = Array.from({ length: 200 }, (_, i) => `- row ${i} ${'y'.repeat(90)}`);
    const out = capHookText(['<memory-context>', ...rows, '</memory-context>'].join('\n'));
    const shown = out.split('\n').filter((l) => l.startsWith('- row ')).length;
    const n = Number(out.match(/(\d+) more line\(s\) not shown/)[1]);
    expect(shown + n).toBe(200);
  });

  it('hard-cuts a single line longer than the budget', () => {
    const out = capHookText('y'.repeat(50_000));
    expect(out.length).toBeLessThanOrEqual(HOOK_TEXT_CAP);
    expect(out.startsWith('yyyy')).toBe(true);
  });
});

describe('writePlainHookText — the budget is per process', () => {
  beforeEach(() => resetPlainHookText());

  it('two chunks that each fit are capped together', () => {
    const written = [];
    const write = (s) => written.push(s);
    writePlainHookText(rows(70).join('\n'), { write }); // ~6.6K
    writePlainHookText(rows(70).join('\n'), { write }); // would reach ~13K
    const total = written.join('');
    expect(total.length).toBeLessThanOrEqual(HOOK_TEXT_CAP);
    expect(total).toContain('not shown — hook output limit');
  });

  it('a chunk arriving after the budget is spent becomes a one-line note', () => {
    const written = [];
    const write = (s) => written.push(s);
    writePlainHookText('z'.repeat(9_800), { write });
    writePlainHookText(['<memory-context>', '- #77 later row', '</memory-context>'].join('\n'), { write });
    const total = written.join('');
    expect(total.length).toBeLessThanOrEqual(HOOK_TEXT_CAP);
    expect(written[1]).toMatch(
      /^\[claude-mem-lite\] 3 more line\(s\) not shown — hook output limit \(ids: #77\)\n$/,
    );
  });
});

describe('flushHookStdout caps each field separately', () => {
  beforeEach(() => resetHookStdout());

  it('additionalContext and systemMessage are each ≤ the cap', () => {
    let out = '';
    queueHookContext('SessionStart', rows(300).join('\n'));
    queueHookSystemMessage('n'.repeat(12_000));
    flushHookStdout({ write: (s) => (out += s) });
    const env = JSON.parse(out);
    expect(env.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(HOOK_TEXT_CAP);
    expect(env.hookSpecificOutput.additionalContext).toContain('not shown — hook output limit');
    expect(env.systemMessage.length).toBeLessThanOrEqual(HOOK_TEXT_CAP);
  });
});

describe('a real overflow through a shipped surface (subprocess)', () => {
  // Created in beforeAll, not at collection: a `-t` filter skips this suite's afterAll, and
  // a collection-time mkdtemp would then be left behind in the system temp dir.
  let ROOT;
  beforeAll(() => {
    ROOT = mkdtempSync(join(tmpdir(), 'mem-textcap-'));
  });
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

  it('UserPromptSubmit deferred-work block with a 30K detail stays under the cap', () => {
    const data = join(ROOT, 'data');
    const cwd = join(ROOT, 'proj-textcap');
    for (const d of [data, cwd]) mkdirSync(d, { recursive: true });
    const env = sandboxEnv(ROOT, data);
    const detail = rows(320)
      .map((l) => `item ${l.slice(2)}`)
      .join('\n'); // ~30K, one line per row; must not start with '-' (a CLI flag)
    const add = spawnSync(
      process.execPath,
      [join(REPO, 'cli.mjs'), 'defer', 'add', 'Overflowing deferred item', '--detail', detail],
      { cwd, env, encoding: 'utf8' },
    );
    expect(add.status, add.stderr).toBe(0);
    const id = Number((add.stdout + add.stderr).match(/D#(\d+)/)[1]);
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'user-prompt-search.js')], {
      cwd,
      env,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 'cc-textcap', prompt: `please pick up D#${id} now` }),
    });
    expect(r.status, r.stderr).toBe(0);
    // premise: the surface really fired — otherwise a length check passes vacuously
    expect(r.stdout).toContain(`D#${id}`);
    expect(r.stdout).toContain('Overflowing deferred item');
    expect(r.stdout.length).toBeLessThanOrEqual(HOOK_TEXT_CAP);
    expect(r.stdout).toContain('not shown — hook output limit');
  });
});

// D#108: every surface books what it injected — the dedup marker (which suppresses a row on
// BOTH UserPromptSubmit faces for the window), injection_count (a noise signal ranking reads)
// and the Key Context marker. Booked before this fix from the rows the surface RENDERED, so a
// row the cap then dropped was suppressed as if the model had seen it.
describe('only what the cap kept is booked as delivered (D#108)', () => {
  beforeEach(() => {
    resetPlainHookText();
    resetHookStdout();
  });

  it('writePlainHookText returns exactly what it wrote, and nothing once no room is left', () => {
    const written = [];
    const write = (s) => written.push(s);
    const first = writePlainHookText(rows(150).join('\n'), { write }); // ~14K → trimmed
    expect(`${first}\n`).toBe(written[0]);
    const second = writePlainHookText('- #9001 late row', { write }); // budget spent → note
    expect(`${second}\n`).toBe(written[1]);
    expect(second).not.toContain('late row');
    writePlainHookText('n'.repeat(9_000), { write: () => {}, cap: HOOK_TEXT_CAP * 3 }); // unrelated cap
    resetPlainHookText();
    writePlainHookText('z'.repeat(9_990), { write: () => {} });
    expect(writePlainHookText('- #9002 no room even for a note', { write: () => {} })).toBe('');
  });

  it('idsShownWhole keeps an entry only when all of its text survived', () => {
    const entries = rows(150).map((line, i) => ({ id: i + 1, text: line }));
    const multi = { id: 'D7', text: 'D#7 head\n  detail one\n  detail two' };
    const shown = capHookText([multi.text, ...entries.map((e) => e.text)].join('\n'));
    const kept = idsShownWhole(shown, [multi, ...entries]);
    expect(kept[0]).toBe('D7');
    const n = shown.split('\n').filter((l) => /^- #\d+ x{90}$/.test(l)).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(150); // premise: the cap really dropped rows
    expect(kept).toEqual(['D7', ...entries.slice(0, n).map((e) => e.id)]);
    // a multi-line entry cut after its head is not "shown"
    const cut = capHookText(`D#8 head\n${'  detail\n'.repeat(3000)}`);
    expect(
      idsShownWhole(cut, [{ id: 'D8', text: `D#8 head\n${'  detail\n'.repeat(3000)}`.trimEnd() }]),
    ).toEqual([]);
  });

  it('previewHookContext is exactly the additionalContext the flush writes', () => {
    queueHookContext('SessionStart', rows(80).join('\n'));
    queueHookContext('SessionStart', rows(80).join('\n'));
    const preview = previewHookContext();
    let out = '';
    flushHookStdout({ write: (s) => (out += s) });
    expect(preview).toBe(JSON.parse(out).hookSpecificOutput.additionalContext);
    expect(preview).toContain('not shown — hook output limit'); // premise: capped
  });

  describe('subprocess: UserPromptSubmit rows the cap dropped are not booked', () => {
    let ROOT; // beforeAll, not collection time — see 'a real overflow' above
    beforeAll(() => {
      ROOT = mkdtempSync(join(tmpdir(), 'mem-textcap-book-'));
    });
    afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

    /** A fresh store per case: rows and markers from one case must not feed the next. */
    function sandbox(name, extraEnv = {}) {
      const data = join(ROOT, name, 'data');
      const cwd = join(ROOT, name, 'proj-textcap-book');
      for (const d of [data, cwd]) mkdirSync(d, { recursive: true });
      const env = { ...sandboxEnv(join(ROOT, name), data), ...extraEnv };
      const cli = (args) =>
        spawnSync(process.execPath, [join(REPO, 'cli.mjs'), ...args], { cwd, env, encoding: 'utf8' });
      const ups = (session, prompt) =>
        spawnSync(process.execPath, [join(REPO, 'scripts', 'user-prompt-search.js')], {
          cwd,
          env,
          encoding: 'utf8',
          input: JSON.stringify({ session_id: session, prompt }),
        });
      // Distinct vocabulary per row: `save` skips a row too similar to an existing one.
      const saveObs = (k) => {
        // 12 tokens: long enough that the rendered title (70) and lesson (50) are both cut to
        // their display width, which the partial-trim case below sizes its window from.
        const uniq = (tag) => Array.from({ length: 12 }, (_, j) => `${tag}${k}x${j}`).join(' ');
        const s = cli([
          'save',
          `zorbleWidget cache invalidation ${uniq('n')}`,
          '--title',
          `zorbleWidget cache invalidation ${uniq('t')}`,
          '--lesson',
          `zorbleWidget lesson ${uniq('l')}`,
          '--type',
          'bugfix',
          '--importance',
          '2',
        ]);
        expect(s.status, s.stderr).toBe(0);
        const m = s.stdout.match(/Saved #(\d+)/);
        expect(m, s.stdout).not.toBeNull();
        return Number(m[1]);
      };
      const deferWithDetail = (title, detail) => {
        const add = cli(['defer', 'add', title, '--detail', detail]);
        expect(add.status, add.stderr).toBe(0);
        return Number((add.stdout + add.stderr).match(/D#(\d+)/)[1]);
      };
      const markerIds = (session) => {
        const dir = join(data, 'runtime');
        const f = readdirSync(dir).find((n) => n.startsWith('.claude-mem-injected-') && n.endsWith(session));
        return f ? JSON.parse(readFileSync(join(dir, f), 'utf8')).ids.map(String) : [];
      };
      const injectionCounts = (ids) => {
        const db = new Database(join(data, 'claude-mem-lite.db'), { readonly: true });
        try {
          return ids.map(
            (id) => db.prepare('SELECT injection_count c FROM observations WHERE id = ?').get(id).c,
          );
        } finally {
          db.close();
        }
      };
      return { ups, saveObs, deferWithDetail, markerIds, injectionCounts };
    }
    const shownIn = (stdout, ids) => ids.filter((id) => new RegExp(`(^|\\n)#${id} `).test(stdout));

    it('a D# block that spends the budget leaves the FTS rows unbooked', () => {
      const sb = sandbox('none');
      const obsIds = [1, 2, 3].map(sb.saveObs);
      const detail = rows(320)
        .map((l) => `item ${l.slice(2)}`)
        .join('\n');
      const did = sb.deferWithDetail('Overflowing deferred item', detail);

      const r = sb.ups('cc-book-a', `please pick up D#${did} and fix the zorbleWidget cache invalidation`);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`D#${did}`); // premise: the D# block fired
      expect(shownIn(r.stdout, obsIds)).toEqual([]);
      const booked = sb.markerIds('cc-book-a');
      for (const id of obsIds)
        expect(booked, `#${id} was dropped by the cap but booked`).not.toContain(String(id));
      // The D# item's head was shown and its detail cut: booked, because a re-injection is cut
      // the same way — it is the first block in the budget (pre-tag review P2-1).
      expect(booked, 'a D# item shown up to the cap is booked').toContain(`D${did}`);
      expect(sb.injectionCounts(obsIds)).toEqual([0, 0, 0]);

      // Premise for the NO above: without the D# block the same rows are shown and booked,
      // so the marker/count reads can say yes.
      const p = sb.ups('cc-book-b', 'fix the zorbleWidget cache invalidation');
      expect(p.status, p.stderr).toBe(0);
      const shownIds = shownIn(p.stdout, obsIds);
      expect(shownIds.length).toBeGreaterThan(0);
      expect(sb.markerIds('cc-book-b')).toEqual(expect.arrayContaining(shownIds.map(String)));
      expect(sb.injectionCounts(shownIds).every((c) => c === 1)).toBe(true);
    });

    // Pre-tag review P2-1: an item whose detail alone exceeds the budget can never be shown
    // whole. Booking only whole items left it unbooked, so every prompt naming it re-sent the
    // same ~9.6K cut block, uncharged against the per-session cap.
    it('a D# item too long to ever fit is injected once per dedup window, not on every prompt', () => {
      const sb = sandbox('dloop');
      const detail = rows(320)
        .map((l) => `item ${l.slice(2)}`)
        .join('\n');
      const did = sb.deferWithDetail('Overflowing deferred item', detail);
      const first = sb.ups('cc-dloop', `please pick up D#${did} now`);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain(`D#${did}`); // premise: injected, and cut
      expect(first.stdout).toContain('not shown — hook output limit');
      expect(sb.markerIds('cc-dloop')).toContain(`D${did}`);
      const again = sb.ups('cc-dloop', `and D#${did} again please`);
      expect(again.status, again.stderr).toBe(0);
      expect(again.stdout).not.toContain(`D#${did}`);
    });

    it('a D# item whose head the cap dropped stays unbooked; the one shown is booked', () => {
      const sb = sandbox('dpair');
      const big = sb.deferWithDetail(
        'Overflowing deferred item',
        rows(320)
          .map((l) => `item ${l.slice(2)}`)
          .join('\n'),
      );
      const small = sb.deferWithDetail('Second referenced item', 'short detail');
      const r = sb.ups('cc-dpair', `pick up D#${big} and D#${small}`);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`D#${big} `); // premise: the first item's head was shown
      expect(r.stdout).not.toContain('Second referenced item'); // premise: the second was cut whole
      const booked = sb.markerIds('cc-dpair');
      expect(booked).toContain(`D${big}`);
      expect(booked).not.toContain(`D${small}`);
    });

    // Pre-tag delta review P3-1: "cut the same way every time" holds for the FIRST item only.
    // A later item cut by the sibling ahead of it fits whole on its own, so booking it on its
    // head suppressed its unseen tail when it was named alone.
    it('a later D# item cut by a sibling stays unbooked, and is delivered when named alone', () => {
      const sb = sandbox('dsib');
      const lines = (n, tag) =>
        Array.from({ length: n }, (_, i) => `${tag} line ${i} ${'q'.repeat(85)}`).join('\n');
      const a = sb.deferWithDetail('First sibling item', lines(55, 'a'));
      const b = sb.deferWithDetail('Second sibling item', lines(65, 'b'));
      const r = sb.ups('cc-dsib', `D#${a} and D#${b} please`);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('Second sibling item'); // premise: B's head was shown…
      expect(r.stdout).not.toContain('b line 64 '); // …and its tail was cut
      const booked = sb.markerIds('cc-dsib');
      expect(booked).toContain(`D${a}`);
      expect(booked).not.toContain(`D${b}`);
      const alone = sb.ups('cc-dsib', `ok continue with D#${b} now`);
      expect(alone.stdout).toContain('b line 64 '); // delivered whole on its own
    });

    // The case the all-dropped one above cannot see: with nothing shown the booking block is
    // skipped whole, so booking every candidate instead of the shown ones stays green there.
    //
    // Narrow by construction. The FTS block is at most five rows (~660 characters) and the cap
    // keeps a 500-character reserve, so it is cut PART-way only when the D# block leaves
    // between ~682 and ~701 characters of the handler's 10,000 (rows at full display width). The D# block is therefore
    // built to an exact length, and the premises below fail loudly if the format drifts
    // out of the window rather than letting the booking asserts pass on an uncut block.
    it('a partly trimmed FTS block books exactly the rows it showed', () => {
      const sb = sandbox('partial', { CLAUDE_MEM_UPS_MAX_RESULTS: '5' });
      const obsIds = Array.from({ length: 5 }, (_, i) => sb.saveObs(i + 1));
      const title = 'Partly overflowing deferred item';
      const header = '[mem] Deferred work referenced in prompt (open items, full detail):';
      const head = `D#1 🟡 [P2] ${title}`; // premise-checked: a fresh store's first D# is 1
      const target = 10_000 - 690 - 1; // leaves 690 of the budget: inside the window
      let left = target - header.length - 1 - head.length - 1;
      const detailLines = [];
      while (left > 0) {
        const sep = detailLines.length ? 1 : 0;
        const w = Math.min(97, left - 2 - sep);
        detailLines.push('d'.repeat(Math.max(1, w)));
        left -= Math.max(1, w) + 2 + sep;
      }
      expect([header, head, ...detailLines.map((l) => `  ${l}`)].join('\n').length).toBe(target);
      const did = sb.deferWithDetail(title, detailLines.join('\n'));
      expect(did).toBe(1);

      const r = sb.ups('cc-book-p', `please pick up D#${did} and fix the zorbleWidget cache invalidation`);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('not shown — hook output limit'); // premise: the cap fired
      const shown = shownIn(r.stdout, obsIds);
      expect(shown.length, `premise: some rows shown\n${r.stdout.slice(-900)}`).toBeGreaterThan(0);
      expect(shown.length, 'premise: some rows cut').toBeLessThan(obsIds.length);
      const cut = obsIds.filter((id) => !shown.includes(id));

      const booked = sb.markerIds('cc-book-p');
      for (const id of shown) expect(booked).toContain(String(id));
      for (const id of cut) expect(booked, `#${id} was cut but booked`).not.toContain(String(id));
      expect(sb.injectionCounts(shown).every((c) => c === 1)).toBe(true);
      expect(sb.injectionCounts(cut).every((c) => c === 0)).toBe(true);
    });
  });

  describe('PreCompact: Key Context rows cut by the cap are not booked', () => {
    let ROOT; // beforeAll, not collection time — see 'a real overflow' above
    beforeAll(() => {
      ROOT = mkdtempSync(join(tmpdir(), 'mem-textcap-keyctx-'));
    });
    afterAll(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      rmSync(ROOT, { recursive: true, force: true });
    });

    it('a Last Session line that fills the budget leaves the Key Context ids out of the marker', () => {
      vi.stubEnv('CLAUDE_PROJECT_DIR', ROOT); // unadopted → Key Context renders
      vi.stubEnv('CLAUDE_MEM_QUIET_HOOKS', '');
      vi.stubEnv('MEM_NO_AUTO_ADOPT', '1'); // §9-A: injected steering would count as adopted
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const db = new Database(':memory:');
      initSchema(db);
      const P = 'p-keyctx-cap';
      const now = Date.now();
      for (const s of ['s0', 's1']) {
        db.prepare(
          `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
           VALUES (?, ?, ?, ?, ?, 'active')`,
        ).run(s, s, P, new Date(now).toISOString(), now);
      }
      const ins = db.prepare(
        `INSERT INTO observations (memory_session_id, project, text, type, title, lesson_learned, importance, created_at, created_at_epoch)
         VALUES ('s1', ?, 't', 'decision', ?, 'keep it', 2, ?, ?)`,
      );
      const ids = [1, 2, 3].map((k) =>
        Number(ins.run(P, `Key row ${k}`, new Date(now).toISOString(), now + k).lastInsertRowid),
      );
      const summary = (lessons) =>
        db
          .prepare(
            `INSERT INTO session_summaries (memory_session_id, project, request, lessons, created_at, created_at_epoch)
             VALUES ('s0', ?, 'req', ?, ?, ?)`,
          )
          .run(P, JSON.stringify(lessons), new Date(now).toISOString(), now);

      // premise: with a normal summary the rows render and are booked
      summary(['short']);
      handlePreCompact({ db, project: P, sessionId: 'sk', runtimeDir: ROOT });
      const file = join(ROOT, keyContextIdsFileName(P, 'sk'));
      expect(JSON.parse(readFileSync(file, 'utf8')).ids.sort()).toEqual([...ids].sort());

      db.prepare('DELETE FROM session_summaries').run();
      summary(['l'.repeat(4_000), 'm'.repeat(4_000), 'n'.repeat(4_000)]);
      handlePreCompact({ db, project: P, sessionId: 'sk', runtimeDir: ROOT });
      expect(JSON.parse(readFileSync(file, 'utf8')).ids).toEqual([]);
      db.close();
    });
  });
});

describe('STRUCTURAL: hook entry points write stdout only through the capped writers', () => {
  // The files that deliver injected text. hook-stdout.mjs and hook-text-cap.mjs are the two
  // writers; everything else must call them.
  const ENTRIES = [
    'hook.mjs',
    'hook-precompact.mjs',
    'scripts/user-prompt-search.js',
    'scripts/pre-tool-recall.js',
    'scripts/post-tool-recall.js',
    'scripts/pre-agent-inject.js',
  ];

  for (const rel of ENTRIES) {
    it(`${rel} has no raw process.stdout.write`, () => {
      const p = join(REPO, rel);
      expect(existsSync(p)).toBe(true);
      const code = readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .join('\n');
      expect(code).not.toMatch(/process\.stdout\.write\(/);
    });
  }
});
