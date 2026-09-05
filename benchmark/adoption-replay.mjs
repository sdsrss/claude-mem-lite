import { readFileSync } from 'fs';
// One OWNER for the `#NN` caliber (was a hand-copied `{2,7}`). Deliberately the
// unanchored-INJECTED caliber, not `citationIdRe()`: `ids()` below builds `injectedIds`
// from a whole prompt with nothing anchoring it, so a prose `#1` is a false positive by
// construction. See the docblock at the owner — the real fix is to match injected ROWS.
import { unanchoredInjectedIdRe } from '../lib/citation-tracker.mjs';

const ID_RE = unanchoredInjectedIdRe();
// v1 scope: path-A only ([mem] FYI via searchByFts, gated to UserPromptSubmit below). Path-B (<memory-context> / searchRelevantMemories) is intentionally excluded — no ranker-replay seam yet; do not "fix" a path-B miss by adding a memory-context marker here.
const UPS_FTS_MARKER = /\[mem\]/;
const IMP_MARKER = /Memory — a past lesson applies to THIS task\. You must:/;
const SUBAGENT_MARKER = /surfaced by your operator's claude-mem-lite/;

function ids(text) {
  const s = new Set();
  for (const m of String(text || '').matchAll(ID_RE)) s.add(m[1]);
  return [...s];
}
function* jsonl(file) {
  for (const l of readFileSync(file, 'utf8').split('\n'))
    if (l) {
      try {
        yield JSON.parse(l);
      } catch {
        /* skip */
      }
    }
}

function assistantText(content) {
  if (typeof content === 'string') return { prose: content, actions: '' };
  let prose = '',
    actions = '';
  if (Array.isArray(content))
    for (const c of content) {
      if (c?.type === 'text' && c.text) prose += c.text + '\n';
      else if (c?.type === 'tool_use') {
        const i = c.input || {};
        if (c.name === 'Edit') actions += (i.new_string || '') + '\n';
        else if (c.name === 'Write') actions += (i.content || '') + '\n';
        else if (c.name === 'Bash') actions += (i.command || '') + '\n';
      }
    }
  return { prose, actions };
}

// A `type:'user'` entry can be either a real human prompt OR a tool_result
// relay: Claude Code records a tool's RESULT as a user-typed entry whose
// message.content is an array containing `{ type: 'tool_result', ... }`
// (see lib/import-jsonl.mjs:216-238) — the SAME outer shape as a genuine
// human message. Only the former is a real boundary/prompt; a tool_result
// relay must neither end the output window nor clobber lastUserPrompt.
function isRealUserMessage(entry) {
  const role = entry.message?.role || entry.type;
  if (role !== 'user') return false;
  const c = entry.message?.content;
  if (typeof c === 'string') return true;
  if (Array.isArray(c)) return !c.some((p) => p && p.type === 'tool_result');
  return true;
}

export function extractInjectionEvents(transcriptFile, { start, end }) {
  const entries = [...jsonl(transcriptFile)].filter((e) => {
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
    return Number.isFinite(ts) && ts >= start && ts < end;
  });
  const events = [];
  let lastUserPrompt = '';

  // Output window: assistant text/actions from just after entries[i] until the
  // next REAL user message — a tool_result relay is skipped, not a boundary.
  function outputWindowAfter(i) {
    let prose = '',
      actions = '';
    for (let j = i + 1; j < entries.length; j++) {
      const n = entries[j];
      const nRole = n.message?.role || n.type;
      if (nRole === 'user') {
        if (isRealUserMessage(n)) break;
        continue;
      }
      if (nRole === 'assistant') {
        const a = assistantText(n.message?.content);
        prose += a.prose;
        actions += a.actions;
      }
    }
    return { prose, actions };
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const sessionId = e.sessionId || transcriptFile;
    const ts = Date.parse(e.timestamp);
    const role = e.message?.role || e.type;
    if (role === 'user') {
      // Only a real prompt updates the query context — a tool_result relay
      // (Edit/Bash/Read result echoed back as a user-typed entry) must not
      // clobber lastUserPrompt to '' (Fix 1).
      if (isRealUserMessage(e)) {
        const c = e.message?.content;
        lastUserPrompt =
          typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text || '').join(' ') : '';
      }
      continue;
    }
    let windowCache;
    const getWindow = () => (windowCache ??= outputWindowAfter(i));

    let surface = null,
      injected = [];
    const query = lastUserPrompt;
    if (e.attachment) {
      const text = (e.attachment.stdout || '') + '\n' + (e.attachment.content || '');
      // ups-fts is a UserPromptSubmit-only surface — PreToolUse/PostToolUse
      // recall cards also carry a generic `[mem] ... #NNNN` prefix and must
      // not be misattributed to it (Fix 2; mirrors cite-recall.mjs's
      // hook-name guard).
      const hook = e.attachment.hookName || e.attachment.hookEvent || '';
      if (IMP_MARKER.test(text)) {
        surface = 'imperative';
        injected = ids(
          text
            .split('\n')
            .filter((l) => IMP_MARKER.test(l))
            .join('\n'),
        );
      } else if (SUBAGENT_MARKER.test(text)) {
        surface = 'subagent';
        injected = ids(text);
      } else if (UPS_FTS_MARKER.test(text) && hook === 'UserPromptSubmit') {
        surface = 'ups-fts';
        injected = ids(text);
      }
    }
    if (surface && injected.length > 0) {
      events.push({ sessionId, ts, surface, injectedIds: injected, query, outputWindow: getWindow() });
    }

    // subagent injection lives in the Agent/Task tool_input.prompt (mutated by
    // pre-agent-inject). A turn dispatching several subagents in parallel has
    // one tool_use block per subagent — emit one event PER qualifying
    // tool_use (sharing this turn's output window) instead of overwriting
    // shared surface/query/injected and collapsing to the last one (Fix 4).
    //
    // DISCLOSURE: `outputWindow: getWindow()` below is the PARENT transcript's
    // continuation after this tool_use, NOT the child subagent's transcript —
    // the injected lesson is read by the CHILD (it lives in this Agent/Task
    // call's own tool_input.prompt), but the child's transcript is a separate
    // file/session never opened here. So `subagent:*` events measure whatever
    // the PARENT does after dispatching, which is at best a proxy for whether
    // the child adopted the lesson — do not use these buckets for the
    // subagent default-flip decision until a child-transcript join is added
    // (v2; see adoption-overlap.mjs's matching CUTOFF disclosure).
    if (!surface && role === 'assistant' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (
          c?.type === 'tool_use' &&
          (c.name === 'Agent' || c.name === 'Task') &&
          SUBAGENT_MARKER.test(c.input?.prompt || '')
        ) {
          const subQuery = c.input.prompt;
          const subIds = ids(subQuery);
          if (subIds.length > 0) {
            events.push({
              sessionId,
              ts,
              surface: 'subagent',
              injectedIds: subIds,
              query: subQuery,
              outputWindow: getWindow(),
            });
          }
        }
      }
    }
  }
  return events;
}
