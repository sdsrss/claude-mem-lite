// Stop's transcript questions, answered from the bytes appended since the previous Stop.
//
// Issue #53. Stop fires once per assistant turn, and it answered its citation questions by
// parsing the whole transcript: lib/transcript-scan.mjs shares one parse within a process,
// and above its heap budget (256 MB at most) every scanner parsed for itself. A transcript
// only grows, so each Stop paid again for every byte the session had written.
//
// Here each question is an accumulator folded over records with the scanner's own rule for
// one record (addCitationsOf, addInjectedBySurfaceOf, ...: one implementation, two callers),
// and the accumulators are kept in the runtime dir with the byte offset they cover. A Stop
// parses only what was appended since. It stops taking new lines once those it has taken reach
// `maxBytes` over all files (a line is taken whole, and reads go in 4 MiB chunks), so a
// transcript first seen larger than that is caught up over several Stops; until it is,
// `complete` is false and the caller writes nothing, because a cited set read from part of
// the session would decide "uncited" for ids the rest of it cites. Catching up needs the next
// call to resume from this one's state. A call whose state cannot be saved still stops at the
// budget, which is what keeps Stop inside its hook timeout.
//
// The saved state is used only when it still describes the file: same inode, not longer than
// the file, the same first and last 4 KiB before its offset, written by this release of the
// code (a release that changes a scanner's rule invalidates every saved state), and holding
// accumulators of the shapes this code builds. Otherwise the file is read again from its first
// byte. Each release keeps its state under its own name, so two installed releases running
// Stop on one session (a plugin registered twice during an update) do not reset each other.

import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from 'fs';
import { createHash } from 'crypto';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { atomicWriteFileSync } from './atomic-write.mjs';
import {
  addCitationsOf,
  addCiteRecallOf,
  addInjectedBySurfaceOf,
  addSubagentPromptIdsOf,
  addUserTypedIdsOf,
  emptySurfaceSets,
  findSubagentTranscripts,
  isMainThreadAssistantText,
} from './citation-tracker.mjs';
import { addBugfixShapeOf, addCiteBackSignalsOf } from './cite-back-hint.mjs';
import { deliberatePersistenceIn } from './persist-reminder.mjs';

export const DIGEST_FILE_PREFIX = 'transcript-digest-';

// Bytes of new lines one Stop takes, over the transcript and its subagent files together. The
// issue's reporter measured 1.6 s to parse 475 MB, so this is ~0.2 s of parsing there.
export const DIGEST_BYTES_PER_STOP = 64 * 1024 * 1024;

const DIGEST_FORMAT = 1;
const READ_CHUNK = 4 * 1024 * 1024;
const PROBE_BYTES = 4096;

/** The main transcript's questions: one accumulator each, named for what hook.mjs asks. */
const MAIN_KINDS = {
  // extractCitationsFromTranscript(path)
  cited: { init: () => new Set(), step: (s, e) => addCitationsOf(s, e) },
  // extractCitationsFromTranscript(path, { mainOnly: true })
  citedMain: { init: () => new Set(), step: (s, e) => addCitationsOf(s, e, { mainOnly: true }) },
  // extractCitationsFromTranscript(path, { mainOnly: true, includeDismissed: true })
  citedMainAnswered: {
    init: () => new Set(),
    step: (s, e) => addCitationsOf(s, e, { mainOnly: true, includeDismissed: true }),
  },
  // extractInjectedBySurface(path)
  injected: { init: emptySurfaceSets, step: (s, e) => addInjectedBySurfaceOf(s, e) },
  // extractInjectedBySurface(path, { mainOnly: true })
  injectedMain: { init: emptySurfaceSets, step: (s, e) => addInjectedBySurfaceOf(s, e, { mainOnly: true }) },
  // extractUserTypedIds(path)
  userTyped: { init: () => new Set(), step: (s, e) => addUserTypedIdsOf(s, e) },
  // extractCiteBackSignals(path)
  citeBack: { init: () => new Set(), step: (s, e) => addCiteBackSignalsOf(s, e) },
  // computeCiteRecall(path), before citeRecallStats
  citeRecall: {
    init: () => ({ injected: new Set(), cited: new Set() }),
    step: (s, e) => addCiteRecallOf(s, e),
  },
  // countUnsavedBugfixShape(path), before bugfixShapeStats
  bugfixShape: { init: () => ({ nudged: 0, saved: 0 }), step: (s, e) => addBugfixShapeOf(s, e) },
  // hasMainThreadAssistantText(path)
  mainText: {
    init: () => ({ seen: false }),
    step: (s, e) => {
      if (!s.seen && isMainThreadAssistantText(e)) s.seen = true;
    },
  },
  // countDeliberatePersistence(path)
  persistence: {
    init: () => ({ count: 0 }),
    step: (s, e) => {
      s.count += deliberatePersistenceIn(e);
    },
  },
};

/** Each subagent file's questions, as collectSubagentSurface asks them. */
const SUBAGENT_KINDS = {
  // extractInjectedFromSubagentPrompt(file)
  seen: { init: () => new Set(), step: (s, e) => addSubagentPromptIdsOf(s, e) },
  // extractCitationsFromTranscript(file)
  said: { init: () => new Set(), step: (s, e) => addCitationsOf(s, e) },
};

/**
 * The transcript's answers to Stop's questions, reading only the bytes appended since the state
 * saved in `runtimeDir` (all of them when there is none).
 *
 * @param {string} transcriptPath main transcript (.jsonl); its subagent files are found from it
 * @param {object} [opts]
 * @param {string} [opts.runtimeDir] where the state is kept; without it every call reads from
 *   the first byte
 * @param {number} [opts.maxBytes] bytes of new lines this call may take. A test seam; Stop passes nothing.
 * @returns {{complete: boolean, main: object, subagents: Array<{seen: Set<number>, said: Set<number>}>}}
 *   `main` has one entry per MAIN_KINDS key. `complete` is false when the budget ran out before
 *   every file was read to its end.
 */
export function digestTranscript(transcriptPath, { runtimeDir, maxBytes = DIGEST_BYTES_PER_STOP } = {}) {
  const code = digestCodeIdentity();
  const statePath = runtimeDir && code ? join(runtimeDir, digestFileName(transcriptPath, code)) : null;
  const saved = statePath ? loadState(statePath, code, transcriptPath) : null;
  const buf = Buffer.allocUnsafe(READ_CHUNK);
  const pass = digestPass(transcriptPath, saved?.files, { left: maxBytes }, buf);
  saveState(statePath, code, transcriptPath, pass.files);
  return { complete: pass.complete, main: pass.files.main.acc, subagents: pass.subagents };
}

/**
 * One read over the transcript and its subagent files, resuming each from its record in `prev`.
 * @returns {{complete: boolean, files: object, subagents: object[]}}
 */
function digestPass(transcriptPath, prev, budget, buf) {
  const main = advance(transcriptPath, prev?.main, MAIN_KINDS, budget, buf);
  const files = { main: main.rec };
  let complete = main.done;
  const subagents = [];
  for (const p of findSubagentTranscripts(transcriptPath)) {
    const key = `subagents/${basename(p)}`;
    let r;
    try {
      r = advance(p, prev?.[key], SUBAGENT_KINDS, budget, buf);
    } catch {
      // D#854 F10: a record one of the subagent rules cannot read. The file adds nothing and
      // keeps no record, and the main results are still written. v6.35.0 did the same for the
      // whole subagent face.
      continue;
    }
    files[key] = r.rec;
    if (!r.done) complete = false;
    subagents.push(r.rec.acc);
  }
  return { complete, files, subagents };
}

/** Keep `files` for the next call; a state that cannot be written is skipped. */
function saveState(statePath, code, transcriptPath, files) {
  if (!statePath) return;
  try {
    atomicWriteFileSync(
      statePath,
      JSON.stringify({ v: DIGEST_FORMAT, code, path: transcriptPath, files }, toJson),
      { mode: 0o600 },
    );
  } catch {
    /* this call's progress is not kept */
  }
}

/** The state file's name for one transcript path, as kept by one release of the code (in the runtime dir). */
export function digestFileName(transcriptPath, code = digestCodeIdentity()) {
  const key = `${code}\n${transcriptPath}`;
  return `${DIGEST_FILE_PREFIX}${createHash('sha256').update(key).digest('hex').slice(0, 16)}.json`;
}

let codeIdentity;
/** Which code wrote a state: the package version, or null when it cannot be read (then no state is kept). */
function digestCodeIdentity() {
  if (codeIdentity !== undefined) return codeIdentity;
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    codeIdentity = typeof version === 'string' && version ? `${DIGEST_FORMAT}:${version}` : null;
  } catch {
    codeIdentity = null;
  }
  return codeIdentity;
}

function loadState(statePath, code, transcriptPath) {
  let fd;
  try {
    // As for the transcript in advance(): a FIFO at this path would block a plain open (D#854
    // F9). Opened this way it reads as empty, or throws EAGAIN while a writer holds it open.
    fd = openSync(statePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const s = JSON.parse(readFileSync(fd, 'utf8'), fromJson);
    if (s?.v !== DIGEST_FORMAT || s.code !== code || s.path !== transcriptPath) return null;
    return s && typeof s.files === 'object' ? s : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Sets are kept as {"$set": [...]}: no accumulator holds an object with that one key otherwise.
function toJson(_k, v) {
  return v instanceof Set ? { $set: [...v] } : v;
}
function fromJson(_k, v) {
  return v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.$set) ? new Set(v.$set) : v;
}

function freshRecord(kinds, ino) {
  const acc = {};
  for (const k of Object.keys(kinds)) acc[k] = kinds[k].init();
  return { ino, offset: 0, head: '', tail: '', acc };
}

/**
 * Fold the records appended to `path` since `saved` into its accumulators.
 * @returns {{rec: object, done: boolean}} done = every complete line up to the end of the
 *   file has been read (a partly written last line is left for the next call)
 */
function advance(path, saved, kinds, budget, buf) {
  let fd;
  try {
    // O_NONBLOCK: a FIFO at this path would otherwise block the open. It has no effect on a
    // regular file, and a non-file is treated as an empty transcript below.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    return { rec: freshRecord(kinds, null), done: true }; // missing: no records, as readTranscriptEntries
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { rec: freshRecord(kinds, null), done: true };
    const rec = continues(fd, st, saved, kinds) ? saved : freshRecord(kinds, st.ino);
    rec.ino = st.ino;
    const done = readAppended(fd, st.size, rec, kinds, budget, buf);
    rec.head = hashRange(fd, 0, Math.min(PROBE_BYTES, rec.offset));
    rec.tail = hashRange(fd, Math.max(0, rec.offset - PROBE_BYTES), rec.offset);
    return { rec, done };
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether `saved` still describes the first `saved.offset` bytes of the open file. A file now
 * shorter than the offset fails the tail probe: it reads fewer bytes than were hashed.
 */
function continues(fd, st, saved, kinds) {
  if (!saved || typeof saved !== 'object' || !saved.acc || typeof saved.acc !== 'object') return false;
  if (!Object.keys(kinds).every((k) => sameShape(kinds[k].init(), saved.acc[k]))) return false;
  if (saved.ino !== st.ino || !Number.isInteger(saved.offset) || saved.offset < 0) return false;
  return (
    hashRange(fd, 0, Math.min(PROBE_BYTES, saved.offset)) === saved.head &&
    hashRange(fd, Math.max(0, saved.offset - PROBE_BYTES), saved.offset) === saved.tail
  );
}

/**
 * Whether `v` has the shape of `model`, an accumulator's init(): a Set where it has a Set, an
 * object with its keys where it has an object, its primitive type otherwise. The version check
 * passes a state whose accumulators changed shape under one version string (D#854 F9), and a
 * rule folded into one of those throws on every Stop until the state is collected.
 */
function sameShape(model, v) {
  if (model instanceof Set) return v instanceof Set;
  if (model !== null && typeof model === 'object') {
    return (
      v !== null &&
      typeof v === 'object' &&
      !(v instanceof Set) &&
      Object.keys(model).every((k) => sameShape(model[k], v[k]))
    );
  }
  return typeof v === typeof model;
}

function hashRange(fd, start, end) {
  const len = end - start;
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, b, got, len - got, start + got);
    if (n <= 0) break;
    got += n;
  }
  return createHash('sha256').update(b.subarray(0, got)).digest('hex');
}

/**
 * Read whole lines from `rec.offset` up to `size`, feeding each record to every accumulator,
 * and move `rec.offset` past each line it consumes. Lines are split on the byte 0x0A, which
 * UTF-8 never uses inside a character, and decoded one at a time.
 * @returns {boolean} whether it reached `size`
 */
function readAppended(fd, size, rec, kinds, budget, buf) {
  let readPos = rec.offset;
  let pending = []; // pieces of a line that started in an earlier chunk
  let pendingLen = 0;
  while (readPos < size) {
    if (budget.left <= 0) return false;
    const n = readSync(fd, buf, 0, Math.min(buf.length, size - readPos), readPos);
    if (n <= 0) break;
    const view = buf.subarray(0, n);
    let i = 0;
    while (i < n) {
      const nl = view.indexOf(0x0a, i);
      if (nl === -1) {
        pending.push(Buffer.from(view.subarray(i))); // copied: `buf` is reused for the next chunk
        pendingLen += n - i;
        break;
      }
      const line = pendingLen > 0 ? Buffer.concat([...pending, view.subarray(i, nl)]) : view.subarray(i, nl);
      pending = [];
      pendingLen = 0;
      feed(line, kinds, rec.acc);
      const lineEnd = readPos + nl + 1;
      budget.left -= lineEnd - rec.offset;
      rec.offset = lineEnd;
      i = nl + 1;
      if (budget.left <= 0 && rec.offset < size) return false;
    }
    readPos += n;
  }
  // A last line without its newline: a record still being written, or one that is complete.
  // readTranscriptEntries keeps it when it parses and drops it when it does not; the same here,
  // except that a line that does not parse yet is left in place to be read whole next time.
  if (pendingLen > 0 && feed(Buffer.concat(pending), kinds, rec.acc)) {
    budget.left -= size - rec.offset;
    rec.offset = size;
  }
  return true;
}

/**
 * Parse one line and fold the record into every accumulator.
 * @returns {boolean} whether the line held a record
 */
function feed(line, kinds, acc) {
  let entry;
  try {
    entry = JSON.parse(line.toString('utf8'));
  } catch {
    return false; // blank, or a partly written line: readTranscriptEntries drops these too
  }
  if (!entry || typeof entry !== 'object') return false;
  for (const k of Object.keys(kinds)) kinds[k].step(acc[k], entry);
  return true;
}
