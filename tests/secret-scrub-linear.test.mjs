// D#130 — scrubSecrets must stay linear on crafted input. Every stored field goes through it
// on a synchronous hook path, and Stop's timeout is 5 s. Four patterns were super-linear
// (growth per doubling of the input, 40k -> 80k chars on the pre-fix code, 2026-09-27: 3.9-4.0x
// each; every other pattern ~2x):
//   - `"\w*(?:password|…)\w*"` and `['"]\w*(?:…)\w*['"]`: from ONE quote, `\w*` runs to the end
//     of a word run, then backtracks through every keyword position, each rescanning the run;
//   - the JWT pattern: every `-eyJ` inside one dotless run is a new start that scans to the
//     run's end;
//   - the PEM pattern: every BEGIN with no END scanned to the end of the text.
// The v6.18.0 security re-check drove the first two through a report Done to 27,970 ms.
import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { scrubSecrets } from '../secret-scrub.mjs';
import { writeStopSummary, FAST_SUMMARY_LIMITS } from '../lib/fast-summary.mjs';
import { insertSession } from './test-helpers.mjs';

const N = 200_000;
const ms = (fn) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

// 40 alternating labelled values drive scrubSecrets to its 32-pass cap, so every pass rescans
// whatever follows them.
const CHAIN = Array.from({ length: 40 }, (_, i) => (i % 2 ? 'secret: abcdefgh' : 'token: abcdefgh')).join(
  ' ',
);

const PROSE = 'the quick brown fox jumps over a lazy dog '.repeat(Math.ceil(N / 42));
const thenProse = (body) => body + 'x\n' + PROSE.slice(0, N - body.length - 2);

// D#607 F1: a BEGIN under `left`, `headers` lines `<header>-----BEGIN RSA PRIVATE KEY-----`, a run of
// `line` to N / `share`, then prose; a prefix given as a function gets the line's number (Read
// columns, grep). One reading of a long blank run is the released reader's own cost (6.30.8, one
// BEGIN over 200k chars of `-` lines: 2.6x benign, 18x under coverage), so the run is sized for that
// one reading to fit the budget and for one reading per header BEGIN not to.
const headerBegins = (left, header, line, headers = 16, share = 4) => {
  const at = (p, n) => (typeof p === 'function' ? p(n) : p);
  let n = 1;
  let head = `${at(left, n++)}-----BEGIN RSA PRIVATE KEY-----\n`;
  for (let h = 0; h < headers; h++) head += `${at(header, n++)}-----BEGIN RSA PRIVATE KEY-----\n`;
  const run = [];
  for (let len = head.length; len < N / share;) {
    const l = at(line, n++);
    run.push(l);
    len += l.length;
  }
  return thenProse(head + run.join(''));
};
const col = (n) => String(n).padStart(6);
const LONG_PATH = 'src/very_long/project_path/to_some/deeply_nested/module_dir/sub_pkg/config.py:';
const CONTEXT_UNIT = " KEY = '''-----BEGIN RSA PRIVATE KEY-----\n-abc: def\n the context line after it\n";
const ESCAPE_DEPTH_BEGINS = [1, 2, 4, 8]
  .map((d) => `'-----BEGIN RSA PRIVATE KEY-----${'\\'.repeat(d)}n-a: b${'\\'.repeat(d)}n`)
  .join('');
const HEADER_BEGINS_IN_KEY =
  "+KEY = '''-----BEGIN RSA PRIVATE KEY-----\n" +
  '+Comment: -----BEGIN RSA PRIVATE KEY-----\n'.repeat(16) +
  '+MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun\n+QWERTYUIOPasdfg\nprose line\n';
// D#641: a context BEGIN over a context key line, then a removed short line (the first reading takes the
// context line, the diff reading reads it again); a rotated key whose removed lines end with a short one
// (the added lines read on); context header BEGINs over a run of unmarked context key lines with one
// removed line at its end (each header BEGIN's reading takes the run; only the last spans no BEGIN).
// The first two in one hunk, under one header (D#649): those readings apply inside a hunk only.
const HUNK = '\n@@ -1,99999 +1,99999 @@\n';
const OPENSSH_UNIT = ` -----BEGIN OPENSSH PRIVATE KEY-----\n ${'b3BlbnNzaC1rZXktdjE'.padEnd(70, 'A')}\n-x\n`;
const ROTATED_UNIT = ` -----BEGIN RSA PRIVATE KEY-----\n-MIIEowIBAAKCAQEA${'B'.repeat(48)}\n-abc\n+MIIEpAIBAAKCAQEA${'C'.repeat(48)}\n+abc\n`;
const contextHeadersOverContextKey = () => {
  let t =
    " KEY = '''-----BEGIN RSA PRIVATE KEY-----\n" + ' Comment: -----BEGIN RSA PRIVATE KEY-----\n'.repeat(15);
  const line = ` ${'D'.repeat(64)}\n`;
  t += line.repeat(Math.floor((N / 4 - t.length) / line.length)) + '-x\n';
  const prose = 'the quick brown fox jumps over a lazy dog '.repeat(Math.ceil(N / 42));
  return t + prose.slice(0, N - t.length);
};
// D#649: hunks a context BEGIN can be in. Each BEGIN asks for its hunk, read from the header down once
// per call and depth. Hunks at four escape depths in turn (a hunk's line at one depth runs across the
// others' text), small hunks one after another, and one large hunk whose lines hold a header's text.
// Over all of N, under coverage on the dev machine: 9.0x, 6.9x and 5.3-5.7x (v6.30.10 3.9x, 3.5x,
// 3.6x; D#641's readings alone, every BEGIN taken as in a hunk, 5.7x, 5.3x, 3.9x); plain 3.8x, 3.2x,
// 2.8x. Sized for CI's margin (D#651), a share of N then prose: 4.3x, 4.6x, 4.3x. A reader made anew for
// each question reads 68-1,047x, and a hunk read from its header for each, 857x on the large hunk (both
// past 10x plain too). Finding a line's break natively in a hunk (15x -> 9x on the first, all of N) is
// measured, not guarded: without it the sized shape reads 6.8x.
const escBreak = (d) => '\\'.repeat(d) + 'n';
const HUNK_DEPTHS = [1, 2, 4, 8]
  .map(
    (d) =>
      `@@ -1,3 +1,3 @@${escBreak(d)} -----BEGIN RSA PRIVATE KEY-----${escBreak(d)} a: b${escBreak(d)}-x${escBreak(d)}`,
  )
  .join('');
const SMALL_HUNK = '\n@@ -1,3 +1,3 @@\n -----BEGIN RSA PRIVATE KEY-----\n a: b\n-x';
const HEADER_TEXT_UNIT = ' x = "@@ -1 +1 @@"\n -----BEGIN RSA PRIVATE KEY-----\n a: b\n';
const share = (unit, s) => thenProse(unit.repeat(Math.floor((N * s) / unit.length)));
const SPACED_PATH = 'My Keys/conf.py';
const SPACED_GREP_UNIT =
  `${SPACED_PATH}:5:KEY = '''-----BEGIN RSA PRIVATE KEY-----\n${SPACED_PATH}-6-abc: def\n` +
  `${SPACED_PATH}-7-the line after it\n--\n${SPACED_PATH}-12-and the next match context\n`;

describe('scrubSecrets stays linear on crafted input (D#130)', () => {
  const shapes = {
    jsonVendorKey: '"' + 'secret'.repeat(N / 6),
    quotedKey: "'" + 'passwd'.repeat(N / 6),
    quotedKeyDouble: '"' + 'password'.repeat(N / 8),
    jwtDashRun: 'eyJ-'.repeat(N / 4),
    // A word-hyphen start is allowed once per word, never inside a hyphen run.
    jwtWordDashRun: ('sess-eyJ' + 'A'.repeat(20) + ' ').repeat(N / 29),
    jwtHyphenWords: ('a-'.repeat(20) + 'eyJ' + 'A'.repeat(20) + ' ').repeat(Math.ceil(N / 64)),
    // An unterminated key header's body runs past certificate headers to the next key header.
    pemHeaderThenCerts:
      CHAIN + ' -----BEGIN RSA PRIVATE KEY-----\n' + '-----BEGIN CERTIFICATE-----\nMIIB\n'.repeat(N / 33),
    pemLongLabels: CHAIN + ' ' + ('-----BEGIN ' + 'A'.repeat(200) + '\n').repeat(Math.ceil(N / 212)),
    // Every BEGIN with no END scanned to the end of the text, on each of the 32 passes.
    pemHeadersNoEnd: CHAIN + ' ' + '-----BEGIN RSA PRIVATE KEY-----\n'.repeat(N / 32),
    // Linear but slow: D#128's code-label branch ran a 40-char lookbehind at every position
    // until a lookahead gated it (500k chars: 407 ms → 3,387 ms → 428 ms).
    chainedWordRun: CHAIN + " '" + 'secret'.repeat(N / 6),
    // 2026-09-28 cut-off key and headerless-body patterns: base64 lines with no END anywhere.
    pemBodyNoEnd: CHAIN + ' -----BEGIN RSA PRIVATE KEY-----\n' + 'MIIEabcdefghijklmnop\n'.repeat(N / 21),
    base64LinesNoEnd: CHAIN + ' ' + 'MIIEabcdefghijklmnop\n'.repeat(N / 21),
    base64ShortLinesNoEnd: CHAIN + ' ' + 'MIIEabcdef\n'.repeat(N / 11),
    // The same lines with JSON-escaped breaks (a literal backslash and n).
    pemEscapedBodyNoEnd:
      CHAIN + ' -----BEGIN RSA PRIVATE KEY-----\\n' + 'MIIEabcdefghijklmnop\\n'.repeat(N / 22),
    // D#168: in escaped text the prefix grammar is looked for past the single quotes before each
    // BEGIN, at most 256 characters back.
    pemEscapedLongCodeBeforeBegin:
      CHAIN +
      ' ' +
      JSON.stringify(('x'.repeat(300) + "'-----BEGIN RSA PRIVATE KEY-----\n-abc\n").repeat(N / 337)),
    // D#614 A3: the walk back to a line's start past single quotes is bounded (LINE_START_SCAN), since
    // walks at different escape depths cross one run, judging each backslash in it. One BEGIN per depth
    // 1-8 after a backslash run: 2.4x under coverage at the bound, 27x without it.
    pemEscapeDepthsAfterBackslashRun:
      CHAIN + ' ' + '\\'.repeat(N - ESCAPE_DEPTH_BEGINS.length - CHAIN.length - 1) + ESCAPE_DEPTH_BEGINS,
    // A bare `>` under a quoted code BEGIN (6.19.4 round-2 F3 read it as blank: 168x benign).
    pemBlankQuoteRun: CHAIN + ' > key = "-----BEGIN RSA PRIVATE KEY-----\n' + '>\n'.repeat(N / 2),
    // The grammar reading takes every line of the run, then refuses it (no 40+ line, no key start),
    // on each pass.
    pemGrammarRunRefused:
      CHAIN +
      " -KEY = '''-----BEGIN RSA PRIVATE KEY-----\n" +
      '-abcdefghijklmnopqrstuvwxyzAB\n'.repeat(N / 30),
    // v6.19.1 delta review P1: a whitespace run inside an RFC 1421 header value, ended by a
    // backslash or a lone CR, backtracked quadratically (48.9 s at 200k).
    pemHeaderSpacesBackslash: '-----BEGIN PGP PRIVATE KEY BLOCK-----\nComment:' + ' '.repeat(N) + '\\x',
    pemHeaderSpacesLoneCr: '-----BEGIN PGP PRIVATE KEY BLOCK-----\nComment:' + ' '.repeat(N) + '\rx',
    pemEscapedHeaderTabs: '-----BEGIN PGP PRIVATE KEY BLOCK-----\\nComment:' + '\t'.repeat(N) + '\\t',
    base64EscapedLinesNoEnd: CHAIN + ' ' + 'MIIEabcdefghijklmnop\\n'.repeat(N / 22),
    base64LinesThenCertEnd:
      CHAIN +
      ' ' +
      ('MIIEabcdefghijklmnop\n'.repeat(20) + 'Ab=\n-----END CERTIFICATE-----\n').repeat(N / 450),
    // D#145 line scanners. A line of backslashes under a key body: a draft of lineCore stripped the
    // line's closing quote with an unanchored `(?:\\+[rn])*["']…$`, which retried every start in
    // the run (40k chars: 540 ms, x3.8 per doubling; never committed).
    pemBodyThenBackslashLine: '-----BEGIN RSA PRIVATE KEY-----\n' + 'MIIEabcdefghijklmnop\n' + '\\'.repeat(N),
    // Many ENDs on one line, each walking back to the one before it.
    pemEndsOneLine: ('x'.repeat(1000) + '-----END RSA PRIVATE KEY-----').repeat(N / 1030),
    pemEndsAfterBackslashRuns: (
      '\\'.repeat(60) + 'nMIIEabcdefghijklmnop-----END RSA PRIVATE KEY-----'
    ).repeat(N / 110),
    // A long line prefix before every BEGIN, and a prefix shape built from it.
    pemBeginLongPrefix: (
      'a'.repeat(5000) + ' -----BEGIN RSA PRIVATE KEY-----\nMIIEabcdefghijklmnop\n'
    ).repeat(N / 5053),
    pemBeginDigitPrefix: (
      '1a'.repeat(120) +
      '-----BEGIN RSA PRIVATE KEY-----\n' +
      '1a'.repeat(120) +
      'MIIEabcdefghijklmnop\n'
    ).repeat(N / 532),
    pemBeginChunksOneLine: '-----BEGIN RSA PRIVATE KEY----- ' + 'MIIEabcdefghijklmnop '.repeat(N / 21),
    // D#168 (D#160 reopened): code or a string opener around the line prefix on every BEGIN line,
    // raw and escaped, so each BEGIN is read again with its prefix grammar on each of the 32 passes.
    pemCodeBeforeBegin: CHAIN + ' ' + "-KEY = '''-----BEGIN RSA PRIVATE KEY-----\n-abc def\n".repeat(N / 52),
    pemOpenerBeforeBegin: CHAIN + ' ' + "'+-----BEGIN RSA PRIVATE KEY-----\n+\n".repeat(N / 37),
    pemEscapedQuotesBeforeBegin:
      CHAIN + ' ' + JSON.stringify("a'a'a'a'a'a'-----BEGIN RSA PRIVATE KEY-----\n-abc def\n".repeat(N / 55)),
    // D#614 A1: a BEGIN on a diff context line over a removed line the reading refuses, read again with
    // a diff mark's shape on each pass (the colon keeps the D#168 skip from applying), raw and escaped.
    // Under coverage that reading costs what the D#168 one does on `-KEY = '''` (v6.30.9, the same
    // units: 6.9x benign over a header, 6.3x without); a context line per unit keeps it near the rest.
    // D#651: units to 0.7 of N, then prose. Over all of N they read 5.5-6.1x on the dev machine under
    // coverage, where CI's runners read 1.65-1.70x as much (headerBeginsBlankRunEscaped, the same code:
    // 6.2x there, 10.20x and 10.56x on CI's Node 24); at 0.7, 3.9-4.3x. With each BEGIN asking for
    // an END from scratch (endFollows' cached positions dropped) they read 10.7-18.4x, plain and under
    // coverage; at half of N the escaped one read 8.6x plain.
    pemContextBeforeBegin: CHAIN + '\n' + thenProse(CONTEXT_UNIT.repeat((N * 0.7) / CONTEXT_UNIT.length)),
    pemContextBeforeBeginEscaped:
      CHAIN + ' ' + JSON.stringify(thenProse(CONTEXT_UNIT.repeat((N * 0.7) / (CONTEXT_UNIT.length + 3)))),
    // D#614 A2: a grep column after a spaced path on each BEGIN line, read again with its shape.
    pemSpacedGrepBeforeBegin: CHAIN + '\n' + SPACED_GREP_UNIT.repeat(N / SPACED_GREP_UNIT.length),
    pemSpacedGrepBeforeBeginEscaped:
      CHAIN + ' ' + JSON.stringify(SPACED_GREP_UNIT.repeat(N / (SPACED_GREP_UNIT.length + 5))),
    // D#607 F1: 16 header lines that each hold a BEGIN, then a run the reading refuses. Each BEGIN's
    // grammar reading read the run again (d0766de4 with a 200k-char run: 33x benign raw, 48x escaped,
    // 186x under coverage); readKeyLines' per-call memos read it once per pass and escape depth. The
    // numbered ones (r2 P2-1): memos keyed by regex object held one per line number (56af7270, 200k
    // chars: 21x Read, 25x `N→`, 15x grep under coverage).
    headerBeginsBlankRun: CHAIN + ' ' + headerBegins('-', '-Comment: ', '-\n'),
    // D#651: an escaped blank line costs more to read than a raw one, and one reading of a run to N/4
    // read 6.2x benign on the dev machine under coverage, 10.20x and 10.56x on CI's Node 24. To N/8:
    // 3.5-3.7x. With the blank-run memo dropped (one reading per header BEGIN), 40x under coverage and
    // 6.1x plain (84x and 11.3x at N/4), so only the coverage run CI makes catches that.
    headerBeginsBlankRunEscaped:
      CHAIN + ' ' + JSON.stringify(headerBegins("-KEY = '''", '-Comment: ', '-\n', 16, 8)),
    headerBeginsQuoteBlankRun: CHAIN + ' ' + headerBegins('> key = "', '> Comment: ', '> \n'),
    headerBeginsReadBlankRun:
      CHAIN +
      ' ' +
      headerBegins(
        (n) => `${col(n)}\tKEY = """`,
        (n) => `${col(n)}\tComment: `,
        (n) => `${col(n)}\t\n`,
      ),
    headerBeginsReadShortRun:
      CHAIN +
      ' ' +
      headerBegins(
        (n) => `${col(n)}\tKEY = """`,
        (n) => `${col(n)}\tComment: `,
        (n) => `${col(n)}\t${'A'.repeat(20)}\n`,
      ),
    headerBeginsArrowBlankRun:
      CHAIN +
      ' ' +
      headerBegins(
        (n) => `${n}→KEY = """`,
        (n) => `${n}→Comment: `,
        (n) => `${n}→\n`,
      ),
    headerBeginsGrepBlankRun:
      CHAIN +
      ' ' +
      headerBegins(
        (n) => `conf.py:${n}:KEY = """`,
        (n) => `conf.py:${n}:Comment: `,
        (n) => `conf.py:${n}:\n`,
      ),
    // r3 F3: a 79-char path over blank lines leaves ~630 lines a quarter of N, too few to tell
    // the trees apart; over 20-char base64 lines it does (56af7270 23.9x under coverage).
    headerBeginsLongPathShortRun:
      CHAIN +
      ' ' +
      headerBegins(LONG_PATH + 'KEY = """', LONG_PATH + 'Comment: ', LONG_PATH + 'A'.repeat(20) + '\n'),
    // r3 F4: empty lines, read by the blank test before lineCore, the memo's other site.
    // D#651: to N/4, 5.0-5.3x on the dev machine under coverage (9.1x at CI's ratio to it); to N/8,
    // 3.1x, and 17.8x with the blank-run memo dropped (35.6x at N/4; plain caught it at neither size).
    headerBeginsEmptyRun: CHAIN + ' ' + headerBegins('-', '-Comment: ', '\n', 16, 8),
    headerBeginsShortRun: CHAIN + ' ' + headerBegins('-', '-Comment: ', '-' + 'A'.repeat(20) + '\n'),
    headerBegins32BlankRun: CHAIN + ' ' + headerBegins('-', '-Comment: ', '-\n', 32),
    // D#614 A1: header BEGINs on context lines between removed ones, each read with a diff mark's shape
    // through the same run; the per-call memos of that shape take it once.
    // D#614 A4: a code BEGIN's re-read key span holding 16 header BEGINs, each read for the union.
    headerBeginsInReadKeyEscaped:
      CHAIN + ' ' + JSON.stringify(HEADER_BEGINS_IN_KEY.repeat(N / (HEADER_BEGINS_IN_KEY.length + 22))),
    headerBeginsContextRun:
      CHAIN + '\n' + headerBegins(" KEY = '''", (n) => (n % 2 ? ' Comment: ' : '-Comment: '), '-\n'),
    // D#614 A2: the same through numbered grep columns after a spaced path.
    headerBeginsSpacedGrepRun:
      CHAIN +
      '\n' +
      headerBegins(
        (n) => `${SPACED_PATH}:${n}:KEY = """`,
        (n) => `${SPACED_PATH}-${n}-Comment: `,
        (n) => `${SPACED_PATH}-${n}-\n`,
      ),
    contextKeyThenRemovedShort: CHAIN + HUNK + OPENSSH_UNIT.repeat(Math.floor(N / OPENSSH_UNIT.length)),
    rotatedKeyShortLast: CHAIN + HUNK + ROTATED_UNIT.repeat(Math.floor(N / ROTATED_UNIT.length)),
    contextHeadersOverContextKey: CHAIN + '\n' + contextHeadersOverContextKey(),
    contextHeadersOverContextKeyEscaped: CHAIN + ' ' + JSON.stringify(contextHeadersOverContextKey()),
    hunkDepthsCycle: CHAIN + ' ' + share(HUNK_DEPTHS, 0.4),
    manySmallHunks: CHAIN + share(SMALL_HUNK, 0.6),
    headerTextInHunkLines: CHAIN + '\n@@ -1,99999 +1,99999 @@\n' + share(HEADER_TEXT_UNIT, 0.75),
    contextHeadersInHunk: CHAIN + '\n@@ -1,99999 +1,99999 @@\n' + contextHeadersOverContextKey(),
    // v6.19.2 pre-tag defect review F1: a quote then a whitespace run after an escaped break; the
    // continuation pattern split the run between two quantifiers (200k: 16-19 s).
    // D#500 (open) was withdrawn from v6.30.1 at its second pre-tag review: a memo of blank-line
    // runs got two shapes slower than v6.30.0's line-by-line reading. These pass here; a next
    // attempt must keep them passing. The first repeats a BEGIN over one blank line; the second resumes
    // a `</`-prefixed reading inside a run of distinct lines that prefix reads as headers.
    beginBlankWordRepeated: CHAIN + ' ' + '-----BEGIN PRIVATE KEY-----\n\nword\n'.repeat(N / 34),
    tagPrefixDistinctHeaders:
      CHAIN +
      '\n</-----BEGIN RSA PRIVATE KEY-----\n' +
      '"\n</X-b:>\n'.repeat(16) +
      '"\n' +
      Array.from({ length: Math.floor(N / 12) }, (_, i) => `</X-b${i}:>\n`).join(''),
    pemEscapedQuoteSpaces: '-----BEGIN RSA PRIVATE KEY-----\\n"' + ' '.repeat(N) + 'x',
    pemEscapedQuoteTabs: '-----BEGIN RSA PRIVATE KEY-----\\n"' + '\t'.repeat(N) + 'x',
    // BEGINs at alternating escape depths. A since-removed walk back to a string's opening quote,
    // cached by one shared entry, went back to the start of the text for each (200k: 1.6 s).
    pemAlternatingDepths:
      '-----BEGIN RSA PRIVATE KEY-----\\nAb\\n-----BEGIN RSA PRIVATE KEY-----\\\\nAb\\\\n'.repeat(N / 76),
    pemConcatLines:
      '"-----BEGIN RSA PRIVATE KEY-----\\n" +\n' + '  "MIIEabcdefghijklmnop\\n" +\n'.repeat(N / 28),
    jwtLongHyphenPrefix: 'a-'.repeat(N / 2) + 'eyJ' + 'A'.repeat(20),
    jwtDotChain: ('eyJ' + 'A'.repeat(12) + '.').repeat(N / 16),
    // Guards for the next attempt at D#679 / D#690 (withdrawn at the v6.30.14 pre-tag review): the
    // drafts' patterns, with their repeats unbounded, took 13 s (a name-first `_key` pattern), 1.9-2.9 s
    // (a name checked behind each key segment) and 2.7-3.2 s (a `name` field rescanning the pairs after
    // it) at 200k on these shapes (2026-11-02).
    keyNameHyphenRun: 'a-'.repeat(N / 2) + '_key=',
    keySegmentRun: 'a-key'.repeat(N / 5),
    nameFieldRun: '{' + '"name":"password",'.repeat(N / 18) + '}',
  };
  // Timed against benign prose of the same length, not a wall-clock bound: a 500 ms bound
  // passed locally (335 ms) and failed on CI under coverage (555 ms). The benign text runs
  // scrubSecrets' 32 passes (the CHAIN prefix), as do pemHeadersNoEnd and chainedWordRun; the
  // other shapes run one, so their budget is ~32x looser than a same-pass comparison, which
  // still separates them (pre-D#130: 55-227x). Measured 2026-09-27 on two machines, crafted /
  // benign: fixed patterns 2.2-3.4x; pre-D#130 pemHeadersNoEnd 20.7-31.7x, chainedWordRun
  // 1,100-1,700x; with the code-label lookaheads removed, chainedWordRun 15.7-16.2x.
  const benign =
    CHAIN + ' ' + 'the quick brown fox jumps over a lazy dog '.repeat(Math.ceil(N / 42)).slice(0, N);
  beforeAll(() => {
    scrubSecrets(benign);
  });
  // D#608: each shape is timed against benign text back to back, three times interleaved, as min
  // crafted / min benign. Interference only adds time, so each minimum approaches its cost from
  // above. Before, one crafted reading was divided by benign's min of 3 taken in beforeAll: in 8
  // full-suite runs under coverage with 3 workers on 2 cores (2026-11-01, D#168 tree) that read up
  // to 10.88x and failed twice, on shapes that read 4.2-4.5x on a quiet machine, while the same
  // samples as min of 3 each read at most 6.46x. Timing benign next to each shape but once left
  // 92% of the inflation: it sits in the single crafted reading. The pre-D#130 scrubber still
  // reads 20.6-1,125x on the six shapes D#130 made linear.
  const ratio = (text) => {
    const benignMs = [];
    const craftedMs = [];
    for (let k = 0; k < 3; k++) {
      benignMs.push(ms(() => scrubSecrets(benign)));
      craftedMs.push(ms(() => scrubSecrets(text)));
    }
    return Math.min(...craftedMs) / Math.max(5, Math.min(...benignMs));
  };
  for (const [name, text] of Object.entries(shapes)) {
    it(`${name}: 200k chars within 10x of benign text of the same length`, () => {
      expect(ratio(text)).toBeLessThan(10);
    });
  }

  it('the re-check shape through a report Done stays inside Stop’s budget', () => {
    const db = new Database(':memory:');
    initSchema(db);
    insertSession(db, { id: 's', project: 'p' });
    const done = CHAIN + ' "' + 'password'.repeat(12_500);
    const took = ms(() =>
      writeStopSummary(db, {
        sessionId: 's',
        project: 'p',
        report: { done, notDone: '', lines: '' },
        source: { request: 'r', completed: '' },
        now: new Date('2026-09-27T00:00:00Z'),
        limits: FAST_SUMMARY_LIMITS.stop,
      }),
    );
    expect(db.prepare('SELECT completed FROM session_summaries').get().completed).toContain('token: ***');
    expect(took).toBeLessThan(1500);
    db.close();
  });
});

describe('the linear rewrites still scrub what the old patterns did', () => {
  const jwt =
    'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'SflKxwRJSMeKKF2QT4fw';
  it.each([
    [
      'JSON vendor-prefixed key',
      '{"aws_secret_access_key": "wJalrXUtnFEMI-K7MDENG"}',
      '{"aws_secret_access_key": "***"}',
    ],
    ['single-quoted dict key', "{'my_password': 'hunter2Zq9x'}", "{'my_password': '***'}"],
    ['mixed quotes', `{"x_api_key": 'abcdef123456'}`, `{"x_api_key": '***'}`],
    ['JWT after a space', `auth ${jwt} ok`, 'auth *** ok'],
    ['JWT after =', `jwt=${jwt}`, 'jwt=***'],
    ['JWT after a quote', `"${jwt}"`, '"***"'],
    // v6.19.0 pre-tag review P3-2: `(?<![\w-])` alone stopped these; `\b` had caught them.
    ['JWT glued to a word by a hyphen', `cookie: sess-${jwt}`, 'cookie: sess-***'],
    ['the same at the start of the text', `auth-${jwt} ok`, 'auth-*** ok'],
    // v6.19.0 pre-tag delta review P3-1: several hyphenated words, as \b allowed.
    ['JWT after two hyphenated words', `cookie: my-sess-${jwt}`, 'cookie: my-sess-***'],
    ['JWT after a header-style name', `X-Auth-Token-${jwt}`, 'X-Auth-Token-***'],
    [
      'PEM block',
      'k: -----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY----- ok',
      'k: ***PEM_KEY*** ok',
    ],
    // A header with no body is not key material: it stays, and the complete block after it goes.
    [
      'a later complete PEM block after a stray header',
      '-----BEGIN EC PRIVATE KEY-----\n-----BEGIN EC PRIVATE KEY-----\nMIIEabc\n-----END EC PRIVATE KEY-----',
      '-----BEGIN EC PRIVATE KEY-----\n***PEM_KEY***',
    ],
    // v6.19.0 pre-tag review P2-1: a body that stopped at the next BEGIN failed to match at
    // all when its own END was missing, so the cut-off key's body was stored. The cut-off body
    // is its whole base64 lines; the text between the two keys stays.
    [
      'a cut-off key body before a later complete block',
      '$ head -c 80 id_rsa\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgO\n$ cat id_rsa\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----',
      '$ head -c 80 id_rsa\n***PEM_KEY***\n$ cat id_rsa\n***PEM_KEY***',
    ],
    [
      'a key body, then a certificate, then another key',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----BEGIN CERTIFICATE-----\nMIIBcert\n-----END CERTIFICATE-----\n-----BEGIN OPENSSH PRIVATE KEY-----\nMIIEabc\n-----END OPENSSH PRIVATE KEY-----',
      '***PEM_KEY***\n-----BEGIN CERTIFICATE-----\nMIIBcert\n-----END CERTIFICATE-----\n***PEM_KEY***',
    ],
    // 2026-09-28: a key with no END and no later key header was stored whole, in v6.18.0 too
    // (`head id_rsa`, a tool output cut mid-key).
    [
      'a cut-off key at the end of the text',
      'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgO\nMOREKEYBODYxyz0123456789\n',
      'before\n***PEM_KEY***\n',
    ],
    [
      'a cut-off key followed by prose',
      '-----BEGIN OPENSSH PRIVATE KEY-----\r\nb3BlbnNzaC1rZXktdjEAAAAA\r\nMOREKEYBODY==\r\ndone.',
      '***PEM_KEY***\r\ndone.',
    ],
    [
      'an encrypted cut-off key keeps no header line either',
      '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,3F2A\n\nMIIEowIBAAKCAQEAu1SU\n',
      '***PEM_KEY***\n',
    ],
    [
      'a cut-off key followed only by a certificate',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU\n-----BEGIN CERTIFICATE-----\nMIIBcert\n-----END CERTIFICATE-----',
      '***PEM_KEY***\n-----BEGIN CERTIFICATE-----\nMIIBcert\n-----END CERTIFICATE-----',
    ],
    // `tail key.pem`: the body and the END with no header.
    [
      'a key body and END with no header',
      'ok\n$ tail -2 key.pem\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgO\nMOREKEYBODY==\n-----END RSA PRIVATE KEY-----\nnext',
      'ok\n$ tail -2 key.pem\n***PEM_KEY***\nnext',
    ],
    [
      'base64 lines that end at no private-key END stay',
      'abc\nMIIBcert\n-----END CERTIFICATE-----\nlines\nof\nwords',
      'abc\nMIIBcert\n-----END CERTIFICATE-----\nlines\nof\nwords',
    ],
    // v6.19.1 pre-tag claims review F1: in text whose line breaks are JSON-escaped (`\n` as two
    // characters: mem_save or import-jsonl of a serialised tool result) the whole-line patterns
    // saw one line, so a cut-off key before a later key, which v6.18.0 and v6.19.0 scrubbed by
    // erasing up to that key, was stored.
    [
      'a JSON-escaped cut-off key before a later complete block',
      '$ head -c 80 id_rsa\\n-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgO\\n$ cat id_rsa\\n-----BEGIN RSA PRIVATE KEY-----\\nMIIEabc\\n-----END RSA PRIVATE KEY-----',
      '$ head -c 80 id_rsa\\n***PEM_KEY***\\n$ cat id_rsa\\n***PEM_KEY***',
    ],
    [
      'a JSON-escaped cut-off key at the end of a string',
      '{"content": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEF\\r\\nAASCBKcwggSjAgEAAoIBAQC7\\nAbc"}',
      '{"content": "***PEM_KEY***"}',
    ],
    [
      'a JSON-escaped encrypted cut-off key keeps the text after it',
      '"-----BEGIN RSA PRIVATE KEY-----\\nProc-Type: 4,ENCRYPTED\\nDEK-Info: AES-128-CBC,3F2A\\n\\nMIIEowIBAAKCAQEAu1SU\\n", "next": "kept"',
      '"***PEM_KEY***\\n", "next": "kept"',
    ],
    [
      'a JSON-escaped key body and END with no header',
      'x\\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgO\\nAbc=\\n-----END RSA PRIVATE KEY-----\\nok',
      'x\\n***PEM_KEY***\\nok',
    ],
    [
      'JSON-escaped one-word lines after a key header stay',
      'is -----BEGIN RSA PRIVATE KEY-----\\nThen\\ncomes\\nthe\\nbody.',
      'is -----BEGIN RSA PRIVATE KEY-----\\nThen\\ncomes\\nthe\\nbody.',
    ],
    // v6.19.1 delta review P2: an armored PGP tail ends in a short data line and a `=XXXX`
    // checksum line, two short lines, so the body never reached its END and was stored.
    [
      'a PGP key tail with a short last line and a checksum',
      'x\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunV\nAbCdEf\n=XyZw\n-----END PGP PRIVATE KEY BLOCK-----\nok',
      'x\n***PEM_KEY***\nok',
    ],
    // delta review P3-1: a header value holding a backslash (a Windows path) ended the body.
    [
      'a cut-off key whose Comment holds a Windows path',
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nComment: C:\\Users\\me\\key.asc\n\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunV\n',
      '***PEM_KEY***\n',
    ],
    // delta review P3-2: a key cut mid-line before a later key kept the cut line.
    [
      'a key cut mid-line keeps no part of the cut line',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunV\nlQdGBGW3xq0BEAC7t6uE1oF2gH3jI5kL0mN9bV8c…\n$ cat id_rsa\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----',
      '***PEM_KEY***…\n$ cat id_rsa\n***PEM_KEY***',
    ],
    // delta review P3-5: blank lines let the one short final line be a word far below the body.
    [
      'a word after blank lines below a cut-off key stays',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunV\n\n\nThanks',
      '***PEM_KEY***\n\n\nThanks',
    ],
    // delta review P3-3: a quote next to the first or last body line.
    [
      'a JSON string holding a key tail',
      '"MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunV\\nAbc=\\n-----END RSA PRIVATE KEY-----"',
      '"***PEM_KEY***"',
    ],
    [
      'a single-quoted cut-off key',
      "'-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunV\\nAbc'",
      "'***PEM_KEY***'",
    ],
    // v6.19.1 pre-tag review F3: a line of one word matched the body class, so prose after a
    // header and words above an END were erased. A body line is 16+ characters; one shorter
    // line may end the body (a key's last line).
    [
      'one-word lines after a key header stay',
      'The header line is -----BEGIN RSA PRIVATE KEY-----\nThen\ncomes\nthe\nbody.',
      'The header line is -----BEGIN RSA PRIVATE KEY-----\nThen\ncomes\nthe\nbody.',
    ],
    [
      'short lines after a header and a blank line stay',
      'Checklist -----BEGIN OPENSSH PRIVATE KEY-----\n\nStep1\nStep2\n\nDone with it',
      'Checklist -----BEGIN OPENSSH PRIVATE KEY-----\n\nStep1\nStep2\n\nDone with it',
    ],
    [
      'words above a key body and END stay',
      'done\nOK\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgO\nAbc=\n-----END RSA PRIVATE KEY-----\nnext',
      'done\nOK\n***PEM_KEY***\nnext',
    ],
    [
      'numbers above a key body and END stay',
      'count\n42\n7\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgO\n-----END RSA PRIVATE KEY-----',
      'count\n42\n7\n***PEM_KEY***',
    ],
    // v6.19.0 round-3 P3-3: ending an unterminated key at the next key header erased the prose
    // between two headers named in one sentence.
    [
      'prose naming two key headers',
      'RSA keys start with -----BEGIN RSA PRIVATE KEY----- and EC keys with -----BEGIN EC PRIVATE KEY----- ok',
      'RSA keys start with -----BEGIN RSA PRIVATE KEY----- and EC keys with -----BEGIN EC PRIVATE KEY----- ok',
    ],
    // v6.19.0 round-3 P3-2: past 40 characters of hyphenated prefix the JWT was stored.
    [
      'JWT after a 44-character hyphenated prefix',
      `cookie: session-3f2a9c1e-8b4d-4e2f-9a1b-7c6d5e4f3a2b-${jwt}`,
      'cookie: session-3f2a9c1e-8b4d-4e2f-9a1b-7c6d5e4f3a2b-***',
    ],
    ['JWT after a long path segment', `/tmp/${'a'.repeat(52)}-${jwt} x`, `/tmp/${'a'.repeat(52)}-*** x`],
    ['JWT glued by an underscore', `tok_${jwt}`, 'tok_***'],
    [
      'a dotless eyJ run stays',
      `eyJ-${'a'.repeat(30)}-eyJ${'b'.repeat(30)} ok`,
      `eyJ-${'a'.repeat(30)}-eyJ${'b'.repeat(30)} ok`,
    ],
    // v6.19.0 pre-tag delta review P3-2: ending an unterminated key at ANY later BEGIN erased
    // prose up to a certificate header.
    [
      'a bare key header in prose before a certificate header',
      'Keys start with -----BEGIN RSA PRIVATE KEY----- and certs with -----BEGIN CERTIFICATE----- ok',
      'Keys start with -----BEGIN RSA PRIVATE KEY----- and certs with -----BEGIN CERTIFICATE----- ok',
    ],
  ])('%s', (_name, input, want) => {
    expect(scrubSecrets(input)).toBe(want);
  });
});

// D#511 guard (D#500's memo, withdrawn from v6.30.1): a memo that carried blank runs to later
// scrubSecrets passes by their offset from the end of the text, without checking that the text after
// them was unchanged, put a reading on another line here and erased a line this scrubber keeps
// (found by an equality fuzz, then minimised). Each pass scrubs one labelled value after the runs,
// so the text there shrinks by a different amount every pass.
describe('a blank run carried to a later pass', () => {
  it('gives the output each pass would give alone', () => {
    const labels =
      'token: abcdefghijklmnop secret: abcdefghijklm token: abcdefghijk secret: abcdefghijklm secret: abcdefghijklmno token: abcdefgh token: abcdefghijklmno token: abcdefghijklmnop secret: abcdefghijk token: abcdefghijklmno token: abcdefghijklm';
    const input = [
      "'X-a: -----BEGIN RSA PRIVATE KEY-----",
      '"',
      '\'n"',
      '"',
      "'Id2sobi9rOJhcjKZ/p8lEQugTKEJmMGtNjVmwHsGIwCyGCb45127WjGZML",
      "'VS554IrB",
      '=8dPf',
      '\\nComment: -----BEGIN RSA PRIVATE KEY-----',
      '</a>',
      ' ',
      '"-----BEGIN PRIVATE KEY-----',
      '""X-c: "-----BEGIN RSA PRIVATE KEY-----',
      "'X-d:-----BEGIN PRIVATE KEY-----",
      '"8W2NwJGwpBzfcLU5/SIQ97yKgx0Oe64',
      labels,
    ].join('\n');
    const want = [
      "'X-a: -----BEGIN RSA PRIVATE KEY-----",
      '"',
      '\'n"',
      '"',
      "'Id2sobi9rOJhcjKZ/p8lEQugTKEJmMGtNjVmwHsGIwCyGCb45127WjGZML",
      "'VS554IrB",
      '=8dPf',
      '\\nComment: -----BEGIN RSA PRIVATE KEY-----',
      '</a>',
      ' ',
      '"***PEM_KEY***',
      labels.replace(/: [a-p]+/g, ': ***'),
    ].join('\n');
    expect(want.split('\n').pop(), 'premise: every label is scrubbed').toBe(
      'token: *** secret: *** token: *** secret: *** secret: *** token: *** token: *** token: *** secret: *** token: *** token: ***',
    );
    expect(scrubSecrets(input)).toBe(want);
  });
});
