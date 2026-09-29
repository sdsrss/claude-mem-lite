// lib/episode-input-filter.mjs — what the episode summarizer is allowed to learn from (D#69).
//
// The llm-episode worker turns a window of tool calls into an `events` row with a lesson.
// A 30-row audit of this repo's events (docs/audits/20260925-200912-session-history-analysis.md
// §4.4.1) read 2 ACCURATE / 11 PARTLY / 16 WRONG / 1 GENERIC, and the failures had names:
//   1. mutation-probe vocabulary (arm names, md5/sha256 lines, mutate-then-restore steps)
//      read as product bugs;
//   2. subagent / sandbox activity (a reviewer probing an extracted tree) attributed to
//      the product;
//   3. the agent's own tool slips (a patch script's "anchor not found") turned into lessons;
//   6. lessons generalised past their evidence, with invented mechanisms.
// 1-3 are INPUT defects: the window handed to the model contained things that were never
// product behaviour. 6 is an OUTPUT defect: the model wrote a mechanism the window never
// stated. This module holds one deterministic answer to each, and nothing else — a leaf
// (no imports), so hook.mjs, hook-llm.mjs and the replay ruler all share one copy.
//
// Subagent calls (2) are not handled here: hook.mjs keeps them out of the episode buffer
// at capture time, keyed on the host's `agent_id` field, because a subagent's entries
// sharing the main thread's buffer also split the main thread's episodes — except a
// subagent call that edits a file inside the project, which is the session's work.

// ─── Per-entry tags, computed at capture time ───────────────────────────────
//
// Classification needs the FULL command and output; the episode entry only keeps a
// 50/60-char `desc`. So PostToolUse computes the tags once and the flush reads them.

const MUT_VOCAB_RE = /\bmutat(?:e|ed|es|ing|ion|ions)\b|\bmutants?\b/i;
// Output a probe prints about itself. Each alternative was read off real probe runs.
const PROBE_OUTPUT_RE =
  /\bmutations?\b[^\n]{0,40}\b(?:landed|applied)\b|\bmutant\b|\bmutation applied\b|\bRED ARM\b|\bM-APPLIED\b|\b(?:sha\w*|md5)\s+(?:before|after)\b|^\s*mutated\b/im;
const CHECKSUM_CMD_RE = /\b(?:md5sum|sha1sum|sha256sum|shasum|cksum)\b|\bcreateHash\(/;
// Backup copies are named for what they are: `x.bak`, `x.orig`, `x.keep`, `x.mut…`,
// `$BAK`, `$ORIG`, `…backup…`. Matched anywhere in a path token, because the copy usually
// lives in a quoted scratch dir (`cp hook.mjs "$SCR/hs.bak"`).
// A backup copy's name, in the three forms real probes use: a SUFFIX ending its token
// (`a.mjs.bak`, `a.mjs.mutated`, `dir-backup`), a shell variable named for it (`"$BAK"`),
// or a /tmp path carrying the mark anywhere (`/tmp/sp/hu-backup.mjs`). A mark INSIDE a
// project file name is product naming — `user.mutation.ts`, `lib/db-backup.mjs` — and an
// unanchored `\.mut\w*` / `backup` read those as backup copies (pre-ship delta review P3-5).
const BACKUP_MARK = String.raw`(?:(?:\.bak\d*|\.orig|\.keep|\.mut(?:ated|ant)?\d*|\.BAK|\.ORIG|[._-]backup\d*)(?=["']?(?:[\s;|&()]|$))|\$\{?\w*(?:BAK|ORIG|BACKUP|bak|orig|backup)\w*\}?|(?<=^|["'\s=])\/tmp\/(?=[^\s"';|&()]*(?:bak|orig|backup|\.mut))[^\s"';|&()]*)`;
const PATH_TOKEN = String.raw`["']?[^\s"';|&()]+["']?`;
// A backup copy (the DESTINATION is a backup): the first half of a probe's mechanism.
const BACKUP_CMD_RE = new RegExp(
  String.raw`\bcp\s+(?:-\w+\s+)*${PATH_TOKEN}\s+["']?[^\s"';|&()]*${BACKUP_MARK}`,
);
// An in-place write or a backup copy: how a probe changes a tracked file.
const INPLACE_CMD_RE = new RegExp(
  `\\b(?:perl|sed)\\s+(?:-[\\w]+\\s+)*-\\w*i\\b|\\bwriteFileSync\\b|\\.write_text\\(|\\bopen\\([^)\\n]*,\\s*['"]w['"]|${BACKUP_CMD_RE.source}`,
);
// Putting the original back: a copy/move whose SOURCE is a backup, `git checkout -- f`,
// `git stash pop`, a copyFileSync from a backup, or a saved original printed back in place
// (`printf '%s' "$ORIG" > $F`). The source-side reading is what the unrestored-write rule
// in filterSummaryInput leans on, so it must see the quoted scratch paths probes use: the
// first draft matched only `$BAK` / `x.bak ` and let 43 of this repo's real probes through.
const RESTORE_CMD_RE = new RegExp(
  [
    String.raw`\b(?:cp|mv)\s+(?:-\w+\s+)*["']?[^\s"';|&()]*${BACKUP_MARK}[^\s"';|&()]*["']?\s+(?!["']?[^\s"';|&()]*${BACKUP_MARK})\S`,
    String.raw`\bgit\s+checkout\s+--\s`,
    String.raw`\bgit\s+stash\s+pop\b`,
    String.raw`\bcopyFileSync\([^)\n]*(?:bak|orig|keep|backup)`,
    String.raw`\bprintf\s+['"]%s['"]\s+"?\$\{?\w*(?:ORIG|orig|BAK|bak)\w*\}?"?\s*>`,
  ].join('|'),
);
const RESTORE_OUTPUT_RE = /\b(?:restored|reverted)\b/i;
// A commit, a memory save or a note appended to a markdown file DESCRIBES a probe
// ("6 mutations killed"); it is the agent's written diagnosis, the most useful text in
// the window, and never a probe itself.
const NARRATION_CMD_RE =
  /\bgit\s+(?:commit|tag)\b|\b(?:cli\.mjs|claude-mem-lite)\s+save\b|>>?\s*["']?[^\s"'|;&]*\.md\b/;
// Heredoc bodies are text the shell hands to a program, not command words: a python
// patch whose inserted test comment says "kills the mutation X" is test authoring.
const HEREDOC_BODY_RE = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\b/g;
const HEREDOC_CAPTURE_RE = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\b/g;

// The agent's own throwaway script failing: an inline python program whose LAST frame is
// `<stdin>`/`<string>` (a product module raising under it would be the last frame
// instead), a node `-e` program whose error Node locates in `[eval1]`/`[stdin]`, or a
// patch step reporting its anchor missing. Line-anchored: a document that QUOTES one of
// these (the D#69 audit itself does) is not a slip.
const SLIP_OUTPUT_RE =
  /^\s*File "<(?:stdin|string)>", line \d+[^\n]*\n(?:[ \t]+(?!File ")\S[^\n]*\n){0,2}\w*(?:Error|Exception)\b|^(?:file:\/\/\S*)?\[(?:eval\d*|stdin)\]:\d+\s*$|^(?:AssertionError: )?[\w .:=-]{0,60}\banchors? not found\b|^\s*(?:<tool_use_error>)?(?:String to replace|old_string) not found\b/im;

// A command that runs a test or a syntax check: the only kind of call a probe's red arm is.
const TEST_RUN_RE =
  /\b(?:vitest|jest|mocha|pytest|node\s+--test|node\s+--check|bash\s+-n)\b|\bnpm\s+(?:run\s+)?test\b|\bnode\s+\S*\.test\.m?js\b/;

/**
 * Tags for one captured tool call. Only `Bash` carries any: a probe or a patch script
 * runs through the shell, and Edit/Write failures never reach PostToolUse (the host
 * routes a failed call to PostToolUseFailure, which does not feed the buffer).
 *
 * A probe needs BOTH a vocabulary signal and a mechanism, because each alone misfires on
 * this repo's own history: the word "mutation" is in commit bodies, memory notes and docs
 * (441 main-thread calls carried it, most of them narration), and a checksum or an
 * in-place write is ordinary tooling. The strong signal is what a probe PRINTS about
 * itself ("mutation landed", "mutant"); the weak one is the word in the command, which
 * then needs a checksum, a backup copy or a restore beside it — an in-place write alone
 * is how docs get edited, and a test run alone is how a GraphQL project tests its
 * mutations. Measured precision (2026-09-26, 30 evenly spaced tagged calls
 * from this repo's history, labelled by reading each): 27/30 before the heredoc and
 * markdown-append exclusions; the three misses were a MEMORY.md append and two python
 * heredocs adding a test case whose comment named the mutation it kills.
 *
 * P2-2 re-measure (2026-09-26T17:58Z, this repo's 62 main transcripts, old rule vs this
 * one back to back): 210 main-thread calls tagged either way — 3 untagged (a test-case
 * authoring heredoc, a post-restore full-suite run, a `defer add`; none a probe) and 3
 * newly tagged (`.keep` backups, a `mutated:` line), 30/30 probes on a hand-read draw of
 * the new set. Calls dropped: 232 -> 217; the gap is the unrestored-write rule keeping 11
 * probe calls whose restore the recognizer cannot see (a `mutate()` shell function, a
 * computed path) plus the test runs after them. That is the intended direction: a kept
 * probe costs one noisy entry, a dropped fix costs the whole window.
 *
 * @param {string} tool
 * @param {object} input tool_input
 * @param {string} resp normalized tool response
 * @returns {string[]} subset of 'probe' | 'opens-probe' | 'closes-probe' | 'slip' | 'test-run'
 */
// The tag regexes run on every PostToolUse Bash call; a command past this length is judged
// on its head (a probe's mechanism is in its first lines, not in a heredoc's tail).
const TAG_CMD_MAX = 16384;

export function entryInputTags(tool, input, resp) {
  if (tool !== 'Bash') return [];
  const rawCmd = typeof input?.command === 'string' ? input.command : '';
  const cmd = rawCmd.length > TAG_CMD_MAX ? rawCmd.slice(0, TAG_CMD_MAX) : rawCmd;
  const out = typeof resp === 'string' ? resp : '';
  const tags = [];
  if (SLIP_OUTPUT_RE.test(out)) tags.push('slip');
  if (NARRATION_CMD_RE.test(cmd)) return tags;
  const testRun = TEST_RUN_RE.test(cmd);
  if (testRun) tags.push('test-run');
  const restoreCmd = RESTORE_CMD_RE.test(cmd);
  const checksum = CHECKSUM_CMD_RE.test(cmd);
  const inplace = INPLACE_CMD_RE.test(cmd);
  const restores = restoreCmd || (RESTORE_OUTPUT_RE.test(out) && checksum);
  const strong = PROBE_OUTPUT_RE.test(out) && (inplace || checksum || restoreCmd || testRun);
  // The word counts in the command's own words, or inside a heredoc only when the output
  // then reports a restore (a mutation SCRIPT written by heredoc and run: `mut5.mjs`).
  // Either way it needs a probe MECHANISM beside it — a checksum, a backup copy or a
  // restore. A test run does NOT confirm the word: "mutation" is product vocabulary in
  // GraphQL, Vuex/Pinia and Redux code, and `npx vitest run src/graphql/mutations/…`
  // once deleted a real fix window whole (pre-ship defect review P2-2).
  const words = cmd.replace(HEREDOC_BODY_RE, '');
  const weak =
    (MUT_VOCAB_RE.test(words) &&
      (CHECKSUM_CMD_RE.test(words) || RESTORE_CMD_RE.test(words) || BACKUP_CMD_RE.test(words))) ||
    (MUT_VOCAB_RE.test(cmd) && RESTORE_OUTPUT_RE.test(out) && (inplace || checksum || restoreCmd));
  if (strong || weak) {
    tags.push('probe');
    if (restores) tags.push('closes-probe');
    else if (inplace) tags.push('opens-probe');
  } else if (restoreCmd) {
    tags.push('closes-probe');
  }
  return tags;
}

/** How far an unclosed probe may reach: the mutate → run → restore shape is 3 calls. */
export const PROBE_SPAN_MAX = 4;

/**
 * Does a restore put this entry's writes back? True when the entry restores in the same
 * call, or a `closes-probe` call follows within PROBE_SPAN_MAX calls.
 */
function writesRestored(entries, i) {
  const tagsOf = (e) => (Array.isArray(e?.inputTags) ? e.inputTags : []);
  if (tagsOf(entries[i]).includes('closes-probe')) return true;
  for (let j = i + 1; j <= i + PROBE_SPAN_MAX && j < entries.length; j++) {
    if (tagsOf(entries[j]).includes('closes-probe')) return true;
  }
  return false;
}

/**
 * Drop mutation-probe and tool-slip entries from one sub-episode before it is saved or
 * summarized. A probe that mutates in one call and restores in a later one takes the
 * TEST RUNS in between with it (the run that goes RED is the probe's red arm, not a
 * product failure), bounded by PROBE_SPAN_MAX. Any other call ends the span and is kept:
 * an earlier draft swallowed the next four calls of any kind and took commits with it.
 *
 * A call that WROTE files (`bashWrites`) is dropped only when a restore follows inside the
 * span: a mutation that nothing puts back is an edit that stayed in the tree, i.e. the
 * session's work, whatever its output said (pre-ship defect review P2-2).
 *
 * @param {object} episode sub-episode as planEpisodeFlush returns it
 * @returns {{episode: object, dropped: {probe: number, slip: number}}} `episode` is the
 *   SAME object when nothing was dropped; otherwise a shallow copy with `entries` and
 *   `files` recomputed.
 * @param {{projectDir?: string|null}} [opts] the project root: only writes under it are
 *   protected by the unrestored-write rule (a probe's copy into a scratch dir is not work).
 */
export function filterSummaryInput(episode, { projectDir = null } = {}) {
  const root = typeof projectDir === 'string' && projectDir ? projectDir.replace(/\/+$/, '') + '/' : null;
  const entries = Array.isArray(episode?.entries) ? episode.entries : [];
  const dropped = { probe: 0, slip: 0 };
  const kept = [];
  let open = 0; // remaining calls an unclosed probe still owns
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const tags = Array.isArray(e?.inputTags) ? e.inputTags : [];
    // Without a projectDir every write counts as the project's — the conservative reading.
    const wrote =
      Array.isArray(e?.bashWrites) && e.bashWrites.some((p) => !root || String(p).startsWith(root));
    if (
      (tags.includes('probe') ||
        (open > 0 && (tags.includes('test-run') || tags.includes('closes-probe')))) &&
      (!wrote || writesRestored(entries, i))
    ) {
      dropped.probe++;
      if (tags.includes('closes-probe')) open = 0;
      else if (tags.includes('opens-probe')) open = PROBE_SPAN_MAX;
      else if (open > 0) open--;
      continue;
    }
    open = 0;
    if (tags.includes('slip')) {
      dropped.slip++;
      continue;
    }
    kept.push(e);
  }
  if (kept.length === entries.length) return { episode, dropped };
  return {
    episode: { ...episode, entries: kept, files: [...new Set(kept.flatMap((e) => e.files || []))] },
    dropped,
  };
}

/** `CLAUDE_MEM_EPISODE_INPUT_FILTER=off` restores the unfiltered input (subagent capture too). */
export function episodeInputFilterEnabled(env = process.env) {
  return !['0', 'off', 'false', 'no'].includes(
    String(env.CLAUDE_MEM_EPISODE_INPUT_FILTER ?? '').toLowerCase(),
  );
}

// ─── The window's own diagnosis ─────────────────────────────────────────────
//
// What the agent or the program SAID went wrong, verbatim: failing output lines, the
// comment lines an edit adds (this repo explains every fix in a comment), and a commit
// message. Lessons must quote it (isLessonGrounded). Captured per entry because the
// `desc` the model otherwise sees is a 40-60 char prefix that almost never reaches the
// line that names the cause.

const DIAG_LINE_MAX = 300;
const DIAG_PER_ENTRY = 3;
const COMMIT_LINES = 4;
// Failure lines, most specific first: a named exception or errno says what broke, a
// runner's per-case mark says which case, a bare "failed" says only that something did.
const ERROR_LINE_TIERS = [
  /\b[A-Z]\w*(?:Error|Exception)\b|\bE(?:NOENT|ACCES|PERM|EXIST)\b|\bpanicked\b|\bTraceback\b/,
  /^\s*(?:FAIL\b|×|✗|not ok\b)/,
  /\bError:|\bfailed\b|\bexpected\b/,
];
// A runner's count line ("Tests 1 failed | 20 passed") names nothing.
const SUMMARY_LINE_RE = /^\s*(?:Test Files|Tests|Test Suites)\s+\d/;
// A command that only SHOWS text: its output quotes source, whose "Error" lines are not
// this call failing. `cd <dir> &&` / `;` prefixes are stripped first (55% of Bash calls
// carry one — the B1 lesson from lib/../bash-utils.mjs isReadOnlyCommand).
const VIEWER_CMD_RE =
  /^(?:cat|sed\s+-n|grep|rg|egrep|head|tail|less|wc|ls|find|awk|nl|git\s+(?:log|show|diff|grep|status|blame)|code-graph-mcp)\b/;
const COMMENT_RE = /^\s*(?:\/\/+|#+|\/?\*+|<!--)\s?(.*?)\s*(?:\*\/|-->)?\s*$/;

function clip(line, scrub) {
  const s = scrub(line.replace(/\s+/g, ' ').trim());
  return s.length > DIAG_LINE_MAX ? s.slice(0, DIAG_LINE_MAX) : s;
}

function isViewerCommand(cmd) {
  const first = cmd.replace(/^\s*(?:cd\s+\S+\s*(?:&&|;|\n)\s*)+/, '').trim();
  return VIEWER_CMD_RE.test(first);
}

function commitMessageLines(cmd) {
  const heredoc = cmd.match(/\bgit\s+commit\b[^\n]*<<-?\s*'?"?(\w+)'?"?\n([\s\S]*?)\n\1\b/);
  let body = heredoc ? heredoc[2] : null;
  if (!body) {
    const m = cmd.match(/\bgit\s+commit\b[^\n]*?\s-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/);
    body = m ? (m[1] ?? m[2]) : null;
  }
  if (!body) return [];
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(?:Co-Authored-By|Signed-off-by):/i.test(l))
    .slice(0, COMMIT_LINES);
}

function failureLines(resp) {
  const picked = [];
  for (const tier of ERROR_LINE_TIERS) {
    for (const l of resp.split('\n')) {
      if (picked.length >= DIAG_PER_ENTRY) return picked;
      if (l.trim().length < 12 || SUMMARY_LINE_RE.test(l) || picked.includes(l)) continue;
      if (tier.test(l)) picked.push(l);
    }
  }
  return picked;
}

/**
 * Comment BLOCKS an edit adds: consecutive added comment lines joined into one string,
 * because a diagnosis is a sentence and a sentence wraps. Per-line extraction split
 * "the first version of this check counted the whole directory and / went red on …"
 * across two lines, and a quote spanning the break could never match.
 */
function addedCommentBlocks(newText, oldText) {
  const before = new Set(
    String(oldText || '')
      .split('\n')
      .map((l) => l.trim()),
  );
  const blocks = [];
  let cur = [];
  const close = () => {
    const text = cur.join(' ').trim();
    // Short comments are section rules and labels, not a diagnosis.
    if (text.length >= 20 && /\p{L}/u.test(text)) blocks.push(text);
    cur = [];
  };
  for (const raw of String(newText || '').split('\n')) {
    const m = before.has(raw.trim()) ? null : raw.match(COMMENT_RE);
    if (m && m[1].trim()) cur.push(m[1].trim());
    else if (cur.length) close();
    if (blocks.length >= DIAG_PER_ENTRY) return blocks;
  }
  if (cur.length) close();
  return blocks.slice(0, DIAG_PER_ENTRY);
}

/**
 * The diagnosis lines one tool call contributes.
 *
 * @param {string} tool
 * @param {object} input tool_input
 * @param {string} resp normalized tool response
 * @param {{isError?: boolean, writesFiles?: boolean, scrub?: (s: string) => string}} [opts]
 *   `isError` is the caller's bashSig verdict; output lines are also read when it is
 *   false, unless the command only displays text (its "Error" lines are quoted source).
 *   `writesFiles` is true when the Bash command writes a file (the hook's `bashWrites`):
 *   the comment blocks inside its heredocs are then read like an Edit's — most edits on
 *   current models are `python3 - <<PY` patches and `cat >> f <<EOF`, not the Edit tool
 *   (18.0% of edits went through Edit/Write, R2 audit N1). `scrub` runs on each line
 *   BEFORE it is clipped, so a secret cannot straddle the cut (SEC-3).
 * @returns {string[]}
 */
export function extractDiagnosisLines(tool, input, resp, opts) {
  return extractDiagnosis(tool, input, resp, opts).lines;
}

/**
 * extractDiagnosisLines plus provenance: \`output\` ⊆ \`lines\` are the lines read from the
 * tool's OUTPUT, which anyone able to make a command print can write; the rest (comment
 * blocks an edit adds, commit messages) the agent authored (D#100(3)).
 * @returns {{lines: string[], output: string[]}}
 */
export function extractDiagnosis(
  tool,
  input,
  resp,
  { isError = false, writesFiles = false, scrub = (s) => s } = {},
) {
  const lines = [];
  let output = [];
  if (tool === 'Bash') {
    const cmd = typeof input?.command === 'string' ? input.command : '';
    lines.push(...commitMessageLines(cmd));
    if (writesFiles && !NARRATION_CMD_RE.test(cmd)) {
      const blocks = [];
      // A python patch opens its replacement text mid-line (`b = """// why …`), so
      // triple quotes are turned into line breaks before comment lines are looked for.
      for (const m of cmd.matchAll(HEREDOC_CAPTURE_RE)) {
        blocks.push(...addedCommentBlocks(m[3].replace(/'''|"""/g, '\n'), ''));
      }
      lines.push(...blocks.slice(0, DIAG_PER_ENTRY));
    }
    if (typeof resp === 'string' && (isError || !isViewerCommand(cmd))) output = failureLines(resp);
  } else if (tool === 'Edit') {
    lines.push(...addedCommentBlocks(input?.new_string, input?.old_string));
  } else if (tool === 'MultiEdit' && Array.isArray(input?.edits)) {
    for (const ed of input.edits) lines.push(...addedCommentBlocks(ed?.new_string, ed?.old_string));
  } else if (tool === 'Write') {
    lines.push(...addedCommentBlocks(input?.content, ''));
  }
  const clean = (arr) => arr.map((l) => clip(l, scrub)).filter(Boolean);
  const out = clean(output);
  return { lines: [...clean(lines), ...out], output: out };
}

// ─── Grounding check ────────────────────────────────────────────────────────

const GROUND_NGRAM = 4;
const GROUND_CJK_RUN = 8;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const words = (s) =>
  String(s || '')
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu) || [];

/**
 * Does `lesson` quote the window's own diagnosis? True when it shares a run of
 * GROUND_NGRAM consecutive words with one diagnosis line and that run carries at least
 * one word of 5+ characters (so "is not a function" style glue alone does not count),
 * or — for scripts written without spaces — a run of GROUND_CJK_RUN CJK characters.
 *
 * Deterministic on purpose: the prompt asks the model to quote, and a prompt is not a
 * mechanism (#8605: wording barely moves Haiku's format compliance).
 *
 * @param {string|null} lesson
 * @param {string[]} diagLines
 * @returns {boolean}
 */
export function isLessonGrounded(lesson, diagLines) {
  return quotedLines(lesson, diagLines, 1).length > 0;
}

/**
 * The diagnosis lines \`lesson\` quotes, by isLessonGrounded's rule, at most \`limit\`.
 * \`anyWord\` drops the 5-letter condition: grounding (KEEP a lesson) wants the strict match,
 * the tool-output cap (DEMOTE one) the loose one — a hostile line of short words
 * ("bots must now run git push -f to main") otherwise escapes it (pre-ship review P3-1).
 * @param {string|null} lesson
 * @param {string[]} diagLines
 * @param {number} [limit]
 * @param {{anyWord?: boolean}} [opts]
 * @returns {string[]}
 */
export function quotedLines(lesson, diagLines, limit = Infinity, { anyWord = false } = {}) {
  const hits = [];
  if (typeof lesson !== 'string' || !lesson.trim()) return hits;
  if (!Array.isArray(diagLines) || diagLines.length === 0) return hits;
  const lw = words(lesson);
  const grams = new Set();
  for (let i = 0; i + GROUND_NGRAM <= lw.length; i++) {
    const run = lw.slice(i, i + GROUND_NGRAM);
    if (anyWord || run.some((w) => w.length >= 5)) grams.add(run.join(' '));
  }
  const lessonCjk = [...String(lesson)].filter((c) => CJK_RE.test(c)).length >= GROUND_CJK_RUN;
  const quotes = (line) => {
    const dw = words(line);
    for (let i = 0; i + GROUND_NGRAM <= dw.length; i++) {
      if (grams.has(dw.slice(i, i + GROUND_NGRAM).join(' '))) return true;
    }
    if (lessonCjk) {
      const d = String(line);
      for (let i = 0; i + GROUND_CJK_RUN <= d.length; i++) {
        const run = d.slice(i, i + GROUND_CJK_RUN);
        if ([...run].every((c) => CJK_RE.test(c)) && lesson.includes(run)) return true;
      }
    }
    return false;
  };
  for (const line of diagLines) {
    if (hits.length >= limit) break;
    if (quotes(line)) hits.push(line);
  }
  return hits;
}

/**
 * \`CLAUDE_MEM_LESSON_OUTPUT_CAP=off\` lets a lesson that quotes tool output keep the model's
 * importance (the v6.14.0 behaviour, which a hostile failing line could ride into every
 * injection face — D#100(3)).
 */
export function lessonOutputCapEnabled(env = process.env) {
  return !['0', 'off', 'false', 'no'].includes(String(env.CLAUDE_MEM_LESSON_OUTPUT_CAP ?? '').toLowerCase());
}

/** `CLAUDE_MEM_LESSON_GROUNDING=off` keeps an unquoted lesson (the pre-D#69 behaviour). */
export function lessonGroundingEnabled(env = process.env) {
  return !['0', 'off', 'false', 'no'].includes(String(env.CLAUDE_MEM_LESSON_GROUNDING ?? '').toLowerCase());
}
