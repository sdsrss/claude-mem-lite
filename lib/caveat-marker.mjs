// lib/caveat-marker.mjs — query-independent pending/caveat detection (2026-09-26 audit).
//
// A search snippet is either the lesson_learned field (a hand-picked summary line) or an
// FTS5 snippet() excerpt centered on wherever the query happened to match — neither is
// guaranteed to include a caveat an entry's narrative carries ("pendiente de revisión",
// "still needs a decision"), because the caveat can sit anywhere in the text, far from
// both the lesson and the query terms. Measured live (cocina 2026-09-26, obs #2): every
// `search` snippet for that entry showed only its lesson_learned line, never the
// "pendiente de revisión" clause a few sentences later in the narrative — a reader
// skimming search results would see a decision as resolved when it explicitly is not.
//
// This is a keyword-marker heuristic, not a schema field: it scans for phrases that
// conventionally flag an open question, in the two languages this store has seen in
// practice (English, Spanish). It will miss a caveat phrased some other way, and a
// structured `caveat` field on mem_save would not — that trade was made deliberately
// (2026-09-26) to ship without a save-schema change; revisit if markers prove too narrow.
const CAVEAT_MARKER_RE =
  /[^.!?\n]*\b(?:pendiente(?:s)?\s+de\s+(?:revisi[oó]n|decidir)|sin\s+decidir(?:\s+a[uú]n)?|por\s+decidir|decisi[oó]n\s+pendiente|pending\s+review|not\s+yet\s+decided|still\s+(?:needs?|to\s+be)\s+(?:decided|reviewed)|open\s+question|\bTODO\b|\bTBD\b)\b[^.!?\n]*[.!?]?/i;

/**
 * First caveat/pending-decision fragment found in `text`, or null. Searches the WHOLE
 * string regardless of where a query matched, so the caveat survives independent of
 * which term the search happened to hit.
 * @param {string} text
 * @param {number} [maxLen=160]
 * @returns {string|null}
 */
export function extractCaveatSnippet(text, maxLen = 160) {
  if (typeof text !== 'string' || !text) return null;
  const m = text.match(CAVEAT_MARKER_RE);
  if (!m) return null;
  const frag = m[0].trim();
  return frag.length > maxLen ? `${frag.slice(0, maxLen - 1)}…` : frag;
}
