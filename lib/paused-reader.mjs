// lib/paused-reader.mjs — read the newest `tasks/<slug>-paused.md` in a project.
//
// A paused note is the one place a session writes down BY HAND what is left and how to
// verify it; the spec governing this repo makes writing one mandatory when a session exits
// mid-task. Nothing read them. Measured 2026-09-21: 27 such files across 7 projects on this
// machine, zero readers — the handoff was reconstructing "what next" from tool history
// while the answer sat in the repo in prose.
//
// It is also why the next step is taken from a FILE rather than from a model summary:
// session_summaries.next_steps is thin, but quote BOTH numbers, because the lifetime
// average hides a trend and a single average was the original justification: 15 of 318 rows
// non-empty over the corpus lifetime (4.7%), and 4 of the newest 20 (20%). So the honest
// form is "unreliable", not "does not work" — the recent regime is four times the average.
// The reason to read a FILE instead is not the rate anyway: a paused note is written by a
// human on purpose and names its own verify command, which is a different kind of signal
// from a field an LLM fills in when it happens to.
//
// The pre-ship claims lens raised this, reporting 4 of the newest 5 non-empty; that specific
// figure did not reproduce (measured 1 of 5, 4 of 20). The caveat stood, its number did not.
//
// A leaf on purpose — `fs`/`path` only, no package imports and no edge back into the hook
// layer, so importing it costs nothing at load time (same reason lib/data-paths.mjs is a
// leaf). Every failure mode (missing dir, unreadable file, binary content, races between
// readdir and stat) yields null or fewer items, never a throw: this runs inside handoff
// construction, which must still persist a row.
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, basename } from 'path';
// The one non-builtin import, and it does not cost the leaf property: format-utils' only
// edge is lib/time-constants.mjs, itself importless. Reused rather than reimplemented
// because a raw slice gets two things wrong that this function already documents — it
// leaves no mark that the text was cut, and it can split a UTF-16 surrogate pair and emit
// a lone surrogate.
import { truncate } from '../format-utils.mjs';
// Also importless — the handoff policy module. One number for "how old is too old" rather
// than a second constant that can drift away from it.
import { HANDOFF_EXPIRY_EXIT } from './handoff-constants.mjs';
import { inferProjectDir } from '../project-utils.mjs';

// Headings whose body is REMAINING WORK, in priority order — the first one present wins,
// regardless of where it sits in the document. "Resume" is last because the generated notes
// use it for a generic instruction, which is worth something but less than an explicit list.
// Deliberately NOT matched: "Last mutation tool call(s)" and the completed sections, whose
// bullets read like work items and are the opposite of work items.
const REMAINING_HEADINGS = [
  /^#{1,6}\s*(?:未完成|待办|剩余(?:工作)?)\s*$/i,
  /^#{1,6}\s*(?:not\s+done|remaining(?:\s+work)?|todo|next\s+steps?)\s*$/i,
  /^#{1,6}\s*(?:resume|恢复)\s*$/i,
];

// "# Paused — X" / "# 暂停 — X" / "# Paused: X" → X. A note whose title is only the word
// keeps the whole line rather than becoming empty.
const TITLE_PREFIX_RE = /^#{1,6}\s*(?:paused|暂停)\s*(?:[—–\-:：]\s*)?/i;
const LIST_MARKER_RE = /^(?:[-*+]|\d+[.)])\s+/;
const MAX_ITEM_CHARS = 200;
// The read is synchronous and sits on the Stop path, once per assistant turn. Output was
// already bounded (5 items x 200 chars) and the INPUT was not — a note is prose a human
// wrote, so anything past this is not a note. Pre-ship defect lens.
const MAX_NOTE_BYTES = 256 * 1024;

/**
 * Default project root, with test containment on the same channel lib/resolve-data-dir.mjs
 * uses (audit 2026-08-22 P2-4).
 *
 * Under vitest the default resolves to the maintainer's real repo, which carries fifteen
 * `tasks/*-paused.md` files of its own — so every suite that builds a handoff would quietly
 * write this repo's paused note into the row under test. That was measured, not imagined:
 * a probe over an unstubbed buildAndSaveHandoff came back carrying
 * `tasks/session-end-b3c0c20d-paused.md`.
 *
 * Per-file `vi.spyOn` stubs fix the same leak but are discipline, not structure — nothing
 * goes red when a new suite forgets one, which is how the sibling readers (readGitState,
 * readProjectTasks) still leak into the files that do not stub them. Neutralising the
 * DEFAULT instead makes the leak impossible while leaving an explicit `projectPath`
 * untouched, so this module's own tests still read their temp dirs.
 *
 * The var is inherited by spawned hooks too, so e2e subprocesses are contained as well.
 *
 * Outside the guard it is the project root (inferProjectDir), not process.cwd(): after a
 * `cd` the two differ, and the handoff would carry another directory's paused note.
 */
function defaultProjectPath() {
  return process.env.CLAUDE_MEM_TEST_GUARD === '1' ? null : inferProjectDir();
}

/**
 * Read the newest paused note for a project.
 *
 * @param {object} [options]
 * @param {string} [options.projectPath] Absolute path to the project root. Defaults to the
 *        current working directory, and to nothing at all under the test guard.
 * @param {number} [options.maxItems=5] Cap on returned items.
 * @param {number} [options.maxAgeMs=HANDOFF_EXPIRY_EXIT] Ignore notes older than this.
 * @returns {{file: string, title: string, items: string[]}|null} null when there is no note,
 *          the newest one is stale, or it has nothing left to do.
 */
export function readPausedNote({
  projectPath = defaultProjectPath(),
  maxItems = 5,
  maxAgeMs = HANDOFF_EXPIRY_EXIT,
} = {}) {
  if (!projectPath) return null;
  const tasksDir = join(projectPath, 'tasks');
  let newest = null;
  try {
    for (const name of readdirSync(tasksDir)) {
      if (!name.endsWith('-paused.md')) continue;
      try {
        const st = statSync(join(tasksDir, name));
        // A FIFO or a device (a repository can commit a link to one) is no note, and must not
        // shadow an older regular one.
        if (!st.isFile() || st.size > MAX_NOTE_BYTES) continue;
        if (!newest || st.mtimeMs > newest.mtime) newest = { name, mtime: st.mtimeMs };
      } catch {
        /* vanished between readdir and stat — skip it */
      }
    }
  } catch {
    return null; // no tasks/ dir
  }
  if (!newest) return null;
  // Staleness bound, on the NEWEST note only — if the freshest thing the project has to say
  // is weeks old, nothing here is a next step. Measured on this repo 2026-09-21: 15 notes,
  // 10 to 16 days old, all of them the generated session-end boilerplate, and the item they
  // contributed quotes `bash tests/run-all.sh`, which this repo does not have. Bound is the
  // exit handoff's own expiry: the note rides in on that row, so outliving it is incoherent.
  if (Date.now() - newest.mtime > maxAgeMs) return null;

  let text;
  try {
    text = readFileSync(join(tasksDir, newest.name), 'utf8');
  } catch {
    return null;
  }

  const lines = text.split('\n');
  let title = '';
  for (const line of lines) {
    if (/^#\s+/.test(line)) {
      title = line.replace(TITLE_PREFIX_RE, '').replace(/^#\s+/, '').trim();
      break;
    }
  }

  const items = [];
  for (const heading of REMAINING_HEADINGS) {
    const start = lines.findIndex((l) => heading.test(l.trim()));
    if (start === -1) continue;
    // A line is not an item. Markdown here comes in two shapes and hard-wrapping makes
    // them look alike: a LIST, where each marker starts a new entry, and a PARAGRAPH,
    // where a single sentence is split across physical lines. Treating every line as an
    // item shreds one generated note's four-line Resume sentence into four fragments, each
    // beginning mid-clause. So a marker opens an entry and everything up to the next marker
    // or blank line is folded into it.
    let current = '';
    const flush = () => {
      const item = current.trim();
      if (item) items.push(truncate(item, MAX_ITEM_CHARS));
      current = '';
    };
    for (let i = start + 1; i < lines.length && items.length < maxItems; i++) {
      const raw = lines[i];
      if (/^#{1,6}\s/.test(raw)) break; // next heading ends the section
      const line = raw.trim();
      if (!line) {
        flush();
        continue;
      }
      if (LIST_MARKER_RE.test(line)) {
        flush();
        current = line.replace(LIST_MARKER_RE, '').trim();
      } else {
        current = current ? `${current} ${line}` : line;
      }
    }
    if (items.length < maxItems) flush();
    if (items.length > 0) break;
  }

  if (items.length === 0) return null; // a note with nothing left to do is not a next step
  return { file: `tasks/${basename(newest.name)}`, title, items };
}
