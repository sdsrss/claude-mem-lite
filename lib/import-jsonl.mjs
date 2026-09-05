// claude-mem-lite: import a Claude Code JSONL transcript file into the
// memory DB. One transcript ≈ one Claude Code session; we map:
//   user line       -> user_prompts row
//   tool_use+result -> observations row (matched by tool_use_id)
//   anything else   -> ignored
//
// Idempotent: re-running on the same file does not duplicate. Dedup keys
// are derived from full SHA-256 of the joined components. \x1f (ASCII unit
// separator) as join glue so adjacent components can't collide via inputs
// containing the separator. Truncating prompt_text would collapse rapid
// same-session "yes / next / 继续" replies into one observation.
//
// Orphan tool_use (truncated transcript: tool_use without matching
// tool_result) gets a fallback observation marked '[tool_use without
// result — transcript truncated]' so retrieval surfaces the truncation.

import { readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { scrubSecrets } from '../secret-scrub.mjs';
import { scrubRecord } from './scrub-record.mjs';

const TOOL_TO_TYPE = {
  Edit: 'change', Write: 'change', NotebookEdit: 'change',
  Read: 'discovery', Grep: 'discovery', Glob: 'discovery',
  Bash: 'change', Task: 'discovery', Agent: 'discovery',
  Skill: 'discovery', WebFetch: 'discovery', WebSearch: 'discovery',
};

function dedupKey(parts) {
  return createHash('sha256').update(parts.join('\x1f')).digest('hex');
}

function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// Distinct mem-internal id derived from the CC session UUID. The schema
// trigger `sdk_sessions_id_mix_check_*` aborts when memory_session_id ==
// content_session_id and both look like a CC UUID (length 36 + hyphen
// pattern); writing the raw UUID into both columns would reproduce the
// v2.33.1 mix bug. The `import-` prefix makes the origin obvious in audits.
function memId(sessionId) {
  return `import-${sessionId}`;
}

function ensureSession(db, sessionId, project, ts) {
  db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions
      (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'completed')
  `).run(sessionId, memId(sessionId), project, ts, Date.parse(ts) || Date.now());
}

function importPrompt(db, ev, project, seenPrompts) {
  const text = typeof ev?.message?.content === 'string'
    ? ev.message.content
    : (Array.isArray(ev?.message?.content)
        ? ev.message.content.filter(c => c?.type === 'text').map(c => c.text).join('\n')
        : '');
  if (!text) return false;
  // Same sentinel the two LIVE writers refuse on (hook.mjs handleUserPrompt,
  // scripts/user-prompt-search.js): <task-notification> is Claude Code protocol, not user
  // input. Backfill is the third input boundary into user_prompts and was the only one
  // persisting them — so a cold-start import seeded rows the live path would never write,
  // which every reader then has to filter back out (`prompt_text NOT LIKE
  // '<task-notification>%'` in search-core, search-engine and the UPS fallback). A reader
  // that forgets the filter — `get P#N` and the timeline P# anchor do not have it — hands
  // the agent protocol chatter as recalled context. Counted as `skipped`, which is what it
  // is; the import stays idempotent because a skipped row was never inserted to re-match.
  if (text.startsWith('<task-notification>')) return false;
  const sessionId = ev.sessionId || 'imported';
  const ts = ev.timestamp || new Date().toISOString();
  const safe = scrubSecrets(text.slice(0, 10000));
  // Dedup key uses the scrubbed text so a re-run computes the same key as the
  // first run (which persisted the scrubbed text). Keying on raw input would
  // make idempotency fragile if the scrub policy changes.
  const key = dedupKey([sessionId, ts, safe]);
  if (seenPrompts.has(key)) return false;
  seenPrompts.add(key);

  ensureSession(db, sessionId, project, ts);
  const bumped = db.prepare(
    'UPDATE sdk_sessions SET prompt_counter = COALESCE(prompt_counter, 0) + 1 WHERE content_session_id = ? RETURNING prompt_counter'
  ).get(sessionId);
  const promptNumber = bumped?.prompt_counter || 1;

  db.prepare(`
    INSERT OR IGNORE INTO user_prompts
      (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, safe, promptNumber, ts, Date.parse(ts) || Date.now());
  return true;
}

function importToolPair(db, toolUse, toolResult, project) {
  const sessionId = toolUse.sessionId || 'imported';
  const ts = toolUse.timestamp || new Date().toISOString();
  ensureSession(db, sessionId, project, ts);

  const toolName = toolUse.name || 'unknown';
  const type = TOOL_TO_TYPE[toolName] || 'change';
  const inputJson = typeof toolUse.input === 'object'
    ? JSON.stringify(toolUse.input).slice(0, 4000)
    : String(toolUse.input ?? '').slice(0, 4000);
  const resultText = typeof toolResult?.content === 'string'
    ? toolResult.content
    : JSON.stringify(toolResult?.content ?? '').slice(0, 4000);

  const filesModified = (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit')
    && toolUse.input?.file_path
      ? [toolUse.input.file_path] : [];
  const filesRead = toolName === 'Read' && toolUse.input?.file_path
      ? [toolUse.input.file_path] : [];

  // `narrative` carries the body and `text` is the derived search blob
  // (lib/observation-write.mjs rebuildObservationDerived). Writing the payload to `text`
  // ONLY left every imported row outside that invariant, so a later `update` rebuilt
  // `text` from a narrative that was empty and dropped the payload. Store the body in
  // both: `narrative` as the durable home, `text` as the index copy the ingest paths
  // write directly.
  const body = `${inputJson}\n---\n${resultText}`;
  const safe = scrubRecord('observations', {
    title: `${toolName}: ${(toolUse.input?.command || toolUse.input?.file_path || '').slice(0, 80)}`,
    subtitle: '',
    text: body,
    narrative: body,
    concepts: '',
    facts: '',
    lesson_learned: null,
    search_aliases: null,
  });

  db.prepare(`
    INSERT INTO observations
      (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memId(sessionId), project, safe.text, type, safe.title, safe.subtitle,
    safe.narrative, safe.concepts, safe.facts,
    JSON.stringify(filesRead), JSON.stringify(filesModified),
    1, ts, Date.parse(ts) || Date.now(),
  );
  return true;
}

/**
 * Import a single Claude Code JSONL transcript into the DB.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} path  Absolute path to the .jsonl file
 * @param {{project: string}} opts
 * @returns {Promise<{prompts:number, observations:number, skipped:number, orphans:number}>}
 */
// Cold-start backfill reads the whole transcript into one JS string (the dedup
// state + the better-sqlite3 transaction below are synchronous, so a drop-in async
// stream isn't available). V8 caps a single string near 512MB, so a larger file
// throws a cryptic "Cannot create a string longer than…" mid-read. Fail early with
// an actionable message instead — well under that hard limit.
export const MAX_IMPORT_BYTES = 450 * 1024 * 1024;

export async function importJsonl(db, path, { project }) {
  const st = statSync(path);
  if (st.size > MAX_IMPORT_BYTES) {
    const mb = (n) => Math.round(n / (1024 * 1024));
    throw new Error(`transcript too large (${mb(st.size)}MB > ${mb(MAX_IMPORT_BYTES)}MB cap); split it (e.g. split -l 50000 into parts) and import the parts`);
  }
  // Strip a leading UTF-8 BOM — Node's utf8 read leaves it on, so line 1 would become
  // a U+FEFF-prefixed "{...}" and fail JSON.parse (silently dropped as "skipped"). Real CC
  // are BOM-less, but an editor-touched or re-encoded file can carry one.
  const rawText = readFileSync(path, 'utf8');
  const lines = (rawText.charCodeAt(0) === 0xFEFF ? rawText.slice(1) : rawText).split('\n');
  const seenPrompts = new Set();
  const seenObs = new Set();
  // Pre-seed dedup sets from existing rows so a second run on the same file
  // is a no-op even when the in-memory `seen*` Sets start empty.
  for (const r of db.prepare('SELECT content_session_id, prompt_text, created_at FROM user_prompts').all()) {
    seenPrompts.add(dedupKey([r.content_session_id, r.created_at, r.prompt_text]));
  }
  // Observations carry no tool_use_id column, so the only durable dedup
  // signal we have is the per-process `seenObs` Set inside one importJsonl
  // call. Across calls we rely on the second importToolPair attempting an
  // INSERT that would land — we guard re-runs by also checking for an
  // existing (memory_session_id, created_at, title) match below.
  //
  // Dual-key layering: `seenObs` tracks the `existing:<title>:<ts>` form
  // (cross-call idempotency, seeded from the DB). Per-call dedup uses
  // `seenToolUseIds` keyed on `(sessionId, tool_use_id)` at the gate. The
  // two key shapes never share a value — both checks must run.
  for (const r of db.prepare('SELECT memory_session_id, title, created_at FROM observations').all()) {
    // Use the stored title as a stand-in for tool_use_id when the prior run
    // came from this importer. Title format `${toolName}: ${command|path}` is
    // stable across re-runs of the same fixture.
    seenObs.add(dedupKey([r.memory_session_id, `existing:${r.title}:${r.created_at}`]));
  }

  const pendingToolUse = new Map();
  let prompts = 0, observations = 0, skipped = 0;
  // Count lines that ARE Claude Code transcript events (user/assistant/tool_result),
  // independent of whether they produced a new row. Lets the caller tell apart a
  // genuine wrong-shape file (export output / garbage → recognized 0) from a valid
  // transcript that was simply already imported (recognized > 0, all deduped) — the
  // "0 imported, N skipped" warning must not cry "wrong shape" at an idempotent re-run.
  let recognized = 0;

  // Snapshot importToolPair so we can wrap it with a per-run uniqueness
  // check that hits both in-call and cross-call dedup. (Inline because we
  // only need it in this function.)
  const seenToolUseIds = new Set();
  const tryImportToolPair = (useEv, resultEv) => {
    const sessionId = useEv.sessionId || 'imported';
    const useId = useEv.tool_use_id || useEv.id || '';
    const callKey = dedupKey([sessionId, useId]);
    if (seenToolUseIds.has(callKey)) return false;
    seenToolUseIds.add(callKey);

    // Cross-call dedup: synthesize the title the previous run would have
    // written and check the seenObs set seeded from the DB.
    const toolName = useEv.name || 'unknown';
    const titlePreview = `${toolName}: ${(useEv.input?.command || useEv.input?.file_path || '').slice(0, 80)}`;
    const ts = useEv.timestamp || new Date().toISOString();
    // Match the storage convention from importToolPair (memId-prefixed) so
    // the seenObs entries seeded from the DB can be matched on a re-run.
    const crossKey = dedupKey([memId(sessionId), `existing:${titlePreview}:${ts}`]);
    if (seenObs.has(crossKey)) return false;

    return importToolPair(db, useEv, resultEv, project);
  };

  const tx = db.transaction(() => {
    for (const line of lines) {
      if (!line.trim()) continue;
      const ev = parseLine(line);
      if (!ev) { skipped++; continue; }
      // Transcript-shape signal (incl. embedded + top-level tool_result, #8413).
      if (ev.type === 'user' || ev.type === 'assistant' || ev.type === 'tool_result') recognized++;
      if (ev.type === 'user') {
        // Real Claude Code transcripts wrap tool_result inside a user-typed
        // event's message.content array (alongside the rare text part). The
        // top-level {"type":"tool_result"} shape only appears in our test
        // fixtures. Consume any embedded tool_result parts here; only fall
        // through to importPrompt when the event is an actual user prompt.
        const content = ev?.message?.content;
        let consumedAsToolResult = false;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part?.type === 'tool_result' && part.tool_use_id) {
              consumedAsToolResult = true;
              const useEv = pendingToolUse.get(part.tool_use_id);
              if (useEv) {
                const synth = { content: part.content, tool_use_id: part.tool_use_id, timestamp: ev.timestamp };
                if (tryImportToolPair(useEv, synth)) observations++;
                pendingToolUse.delete(part.tool_use_id);
              } else {
                skipped++;
              }
            }
          }
        }
        if (!consumedAsToolResult) {
          if (importPrompt(db, ev, project, seenPrompts)) prompts++; else skipped++;
        }
      } else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const part of ev.message.content) {
          if (part.type === 'tool_use') {
            pendingToolUse.set(part.id, { ...ev, ...part });
          }
        }
      } else if (ev.type === 'tool_result') {
        const useEv = pendingToolUse.get(ev.tool_use_id);
        if (useEv) {
          if (tryImportToolPair(useEv, ev)) observations++;
          pendingToolUse.delete(ev.tool_use_id);
        } else {
          skipped++;
        }
      } else {
        skipped++;
      }
    }
  });
  tx();

  // Orphan tool_use fallback: persist tool_use events that never paired with
  // a tool_result (truncated transcript / killed Claude Code session).
  //
  // `orphans` is a SUBSET counter, not a sibling of `observations`: each one writes a
  // real observation row via the same importToolPair path. Counting it only under
  // `orphans` made the summary say "+0 observations" for an import that had just
  // written rows — a user backfilling a truncated transcript (the common shape, since
  // the newest session is usually still open) read that as "nothing imported" and had
  // no reason to run `recent`. The caller renders the subset relation explicitly.
  let orphans = 0;
  if (pendingToolUse.size > 0) {
    const tx2 = db.transaction(() => {
      for (const [, useEv] of pendingToolUse) {
        const fauxResult = {
          content: '[tool_use without result — transcript truncated]',
          timestamp: useEv.timestamp,
        };
        if (tryImportToolPair(useEv, fauxResult)) { orphans++; observations++; }
      }
    });
    tx2();
  }

  return { prompts, observations, skipped, orphans, recognized };
}
