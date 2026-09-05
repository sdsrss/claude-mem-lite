// claude-mem-lite: per-table scrub helper. Applies scrubSecrets to the known
// text fields of a table row. Numeric / JSON-blob / id fields are passed
// through untouched.
//
// Failsafe policy: when the table is unknown, scrub every string field by
// default. Newly added tables stay safe even before TEXT_FIELDS_BY_TABLE is
// updated — over-scrubbing is the safe direction; under-scrubbing leaks.
//
// JSON-stringified array fields (e.g. session_handoffs.key_files,
// session_handoffs.match_keywords-when-array) are NOT listed here — running
// scrubSecrets over the JSON string can rewrite quoted values and break
// downstream JSON.parse. Pre-scrub each element upstream of the
// JSON.stringify call instead.

import { scrubSecrets } from '../secret-scrub.mjs';

export const TEXT_FIELDS_BY_TABLE = {
  observations: [
    'title',
    'subtitle',
    'text',
    'narrative',
    'concepts',
    'facts',
    'lesson_learned',
    'search_aliases',
  ],
  // events: the auto-captured bugfix/lesson/decision path (saveEvent) and the
  // CLI /bug + /lesson commands both land here. title/body carry LLM output and
  // user-pasted repro text verbatim, so they must scrub like observations do —
  // event_type/project/git_sha are enums/identifiers/hash, left untouched.
  events: ['title', 'body'],
  session_summaries: [
    'request',
    'investigated',
    'learned',
    'completed',
    'next_steps',
    'remaining_items',
    'notes',
    'lessons',
    'key_decisions',
  ],
  session_handoffs: [
    'working_on',
    'completed',
    'unfinished',
    // Excluded:
    //   key_files       — JSON.stringify(array); pre-scrub elements at call site
    //   match_keywords  — currently a space-joined plain string; keeping it
    //                     here would scrub safely, but the value is built from
    //                     tokenizeHandoff() output (alphanumeric tokens only),
    //                     so secrets cannot survive the upstream tokenizer.
    //                     Excluded to avoid double-work + future-proof against
    //                     a refactor that switches to JSON.stringify.
    // key_decisions is kept: call site uses '\n'.join (plain string), and
    // decision titles can carry secrets verbatim (LLM output).
    'key_decisions',
  ],
};

/**
 * Scrub the text fields of a record before INSERT.
 * Returns a shallow copy with string text-fields scrubbed; the input object
 * is left untouched. Non-string values (numbers, null, JSON blobs the caller
 * has already stringified) flow through unchanged.
 */
export function scrubRecord(table, row) {
  if (!row || typeof row !== 'object') return row;
  const fields = TEXT_FIELDS_BY_TABLE[table];
  const out = { ...row };
  if (fields) {
    for (const f of fields) {
      if (typeof out[f] === 'string') out[f] = scrubSecrets(out[f]);
    }
  } else {
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'string') out[k] = scrubSecrets(out[k]);
    }
  }
  return out;
}
