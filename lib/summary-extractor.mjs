// Structured summary extractor: reads the tail assistant message from a
// Claude Code transcript and pulls out Done / Not done / Failed / Uncertain
// sections using deterministic markers. This is the non-Haiku path — the
// markers are enforced by CLAUDE.md §10's four-section order rule, so they
// appear in ~every end-of-task message.
//
// Haiku summarization remains the richer best-effort enrichment, but it
// silently fails ~66% of Stop events in practice, leaving session_summaries
// with empty remaining_items. This extractor runs synchronously in
// handleStop and gives a deterministic floor.

import { readTranscriptEntries } from './transcript-scan.mjs';

const ZH_HEADER = /^[\s●*>-]*(剩下的?|剩余|还剩|未完成|下次(?:要做|做|继续)?|待做|未做)\s*[:：]?\s*/m;

// EN section headers, in every form real reports use: `Done: text`, `**Done:** text`,
// `**Not done** — text`, `**Not done**（未开始）：text`, and a heading that IS the whole line —
// `## Done`, `**Not done**`, `**Uncertain.**`, `## Not done（排除项）`. 362 of 440 turn-final
// reports on this machine (2026-09-26) used a heading form the colon-only header missed.
// A whole-line heading opens a BLOCK section, whose body runs through blank lines, paragraphs
// and tables up to the next heading or rule (BLOCK_END), not to the first paragraph break. A
// standalone bold line ends it too, but only once the section has content: reports open a
// section with a bold lead sentence (`## Done` / `**4 rounds, 3 defects fixed.**`) as often as
// they start an unrelated block with a bold title after it.
//
// Parsed as a head match plus small anchored steps over the rest, never as one pattern: the
// one-regex draft chained four optional `\s*` and took 37 s on `## Done` + 1000 spaces + x
// (pre-ship review P3-2), on the Stop hook's 5 s budget.
const SECTION = String.raw`(Done|Not\s+done|Failed|Uncertain)`;
// Every whitespace run is owned by exactly one quantifier (a `* ` bullet, a `#` heading's
// gap, the gap after `**`), so a failing match backtracks in linear time — the first repair's
// `(#…[ \t]+)?(\*\*)?[ \t]*` let two quantifiers share one run (delta review P3-1: 50k
// spaces + x read 1 s, 120k 5.8 s).
const HEAD_RE = new RegExp(
  String.raw`^[\s●>-]*(?:\*[ \t]+)?(?:(#{1,6})[ \t]+)?(?:(\*\*)[ \t]*)?${SECTION}(?![\p{L}\p{N}_])`,
  'iu',
);
const MORE_SECTIONS_RE = new RegExp(String.raw`^(?:[ \t]*[/、,][ \t]*${SECTION})+`, 'i');
const PAREN_RE = /^[ \t]*([（(][^）)\n]{0,120}[）)])/;
const SEP_RE = /^[ \t]*(?:[:：]|[—–]|-(?=\s))/;

/** Index of the first non-blank character of `s` at or after `i`. */
function skipBlank(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}

/** A trailing `**` that closes the header's bold, not bold inside the text (`**v2.1**`). */
function dropUnpairedBold(tail) {
  return (tail.match(/\*\*/g) || []).length % 2 === 1 ? tail.replace(/\*\*[:：]?\s*$/, '').trim() : tail;
}

/**
 * The EN section header `line` opens, or null.
 * @returns {{key: string, tail: string, block: boolean}|null}
 */
function enHeader(line) {
  const m = HEAD_RE.exec(line);
  if (!m) return null;
  const key = EN_KEY[m[3].toLowerCase().replace(/\s+/g, ' ')];
  const heading = Boolean(m[1]);
  const bold = Boolean(m[2]);
  let rest = line.slice(m[0].length);
  // `**Not done / Failed / Uncertain**：…` names several sections; the text goes to the first.
  const more = MORE_SECTIONS_RE.exec(rest);
  if (more) rest = rest.slice(more[0].length);
  let closed = !bold;
  let sep = false;
  const take = (re) => {
    const r = re.exec(rest);
    if (r) rest = rest.slice(r[0].length);
    return r;
  };
  // `**Done:**` / `**Failed.** Nothing.` — a colon or period inside the bold separates the
  // header from its text; alone on the line (`**Uncertain.**`) it is a block heading. Read by
  // index, not by a lookahead that rescans the whitespace run from every start.
  if (bold || heading) {
    const p = skipBlank(rest, 0);
    if ('.:：'.includes(rest[p] ?? '_')) {
      const q = skipBlank(rest, p + 1);
      if (q === rest.length || rest.startsWith('**', q)) {
        rest = rest.slice(p + 1);
        sep = true;
      }
    }
  }
  if (bold && take(/^[ \t]*\*\*/)) closed = true;
  const paren = take(PAREN_RE);
  if (bold && !closed && take(/^[ \t]*\*\*/)) closed = true;
  if (take(SEP_RE)) sep = true;
  if (bold && !closed && take(/^[ \t]*\*\*/)) closed = true;
  const tail = [paren ? paren[1] : '', rest.replace(/^[ \t]*\*\*/, '').trim()].filter(Boolean).join(' ');
  if (sep) return { key, tail: dropUnpairedBold(tail), block: !tail && (bold || heading) };
  if (!rest.trim() && (heading || (bold && closed))) return { key, tail: paren ? paren[1] : '', block: true };
  return null;
}

const BLOCK_END = /^\s*(?:#{1,6}\s|(?:-{3,}|\*{3,}|_{3,})\s*$)/;
const BOLD_LINE = /^\s*\*\*[^*].*\*\*[:：]?\s*$/;

// Recognised section keys, normalised.
const EN_KEY = { done: 'done', 'not done': 'notDone', failed: 'failed', uncertain: 'uncertain' };
const ZH_KEY_IS_NOTDONE = /剩下|剩余|还剩|未完成|下次|待做|未做/;

/**
 * Read the LAST assistant text block from a Claude Code transcript .jsonl.
 * Returns concatenated text of all text blocks in the last `type='assistant'`
 * entry, or null if the file is missing/empty/malformed.
 *
 * @param {string} transcriptPath
 * @returns {string|null}
 */
export function extractTailAssistantText(transcriptPath) {
  let last = null;
  for (const entry of readTranscriptEntries(transcriptPath)) {
    if (entry.type !== 'assistant' || !entry.message) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    const texts = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text);
    if (texts.length === 0) continue;
    last = texts.join('\n');
  }
  return last;
}

/**
 * Extract Done / Not done / Failed / Uncertain sections from a message body.
 * Returns an object with four string fields (empty when the section is absent).
 *
 * Strategy: scan line by line, recognise section headers in EN and 中文,
 * attribute subsequent content to that section until the next header or a
 * hard boundary (blank line followed by a non-bullet line).
 *
 * @param {string} text
 * @returns {{done: string, notDone: string, failed: string, uncertain: string}}
 */
export function extractStructuredSummary(text) {
  const out = { done: '', notDone: '', failed: '', uncertain: '' };
  if (!text || typeof text !== 'string') return out;

  const lines = text.split('\n');
  let current = null;
  let block = false;
  const buffers = { done: [], notDone: [], failed: [], uncertain: [] };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Header detection — EN first (unambiguous), then 中文. Any EN header ends the section
    // before it; an inline one (\`Failed: none\`, \`**Failed:** 无。\`) also ends block mode.
    const h = enHeader(line);
    if (h) {
      current = h.key;
      block = h.block;
      if (h.tail) buffers[current].push(h.tail);
      continue;
    }
    if (block && current) {
      // A question to the user after a blank line (\`要推送并发 v6.13.4 吗？\`) is not section
      // content: the claims review found 21 of 46 closing questions absorbed into Uncertain.
      // Skipped, not a boundary — a paragraph after it can still belong to the section — and
      // only when short: a long paragraph ending in a question carries content too.
      const afterBlank = i > 0 && !lines[i - 1].trim();
      const question = trimmed.length <= 120 && /[?？]\s*$/.test(trimmed);
      if (afterBlank && question && !/^[-*•●\d|>]/.test(trimmed) && !BLOCK_END.test(line)) continue;
      if (BLOCK_END.test(line) || (BOLD_LINE.test(line) && buffers[current].length > 0)) {
        current = null;
        block = false;
      } else if (trimmed) {
        buffers[current].push(trimmed);
        continue;
      } else continue;
    }
    const zhMatch = line.match(ZH_HEADER);
    if (zhMatch && ZH_KEY_IS_NOTDONE.test(zhMatch[1])) {
      current = 'notDone';
      const tail = line.slice(zhMatch[0].length).trim();
      if (tail) buffers.notDone.push(tail);
      continue;
    }

    if (!current) continue;

    // Paragraph-break termination: blank line followed by a non-bullet,
    // non-indented line starts a fresh paragraph unrelated to the section.
    if (!trimmed) {
      const next = (lines[i + 1] || '').trim();
      const nextIsBullet = /^[-*•●\d]+[.)]?\s+/.test(next);
      if (!nextIsBullet && next) {
        current = null;
      }
      continue;
    }

    buffers[current].push(trimmed);
  }

  for (const k of Object.keys(buffers)) {
    out[k] = buffers[k].join('\n').trim();
  }
  return out;
}
