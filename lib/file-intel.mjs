// lib/file-intel.mjs — pure, zero-dependency builder for the PreToolUse:Read
// "file intelligence" injection (feature ①). Before Claude reads a file, surface
// its approximate token size + a one-line "what's in it" so the agent can decide
// to read fully, read a slice, or grep instead.
//
// Imported by the hot standalone scripts/pre-tool-recall.js, so it MUST stay
// dependency-free and cheap: one bounded file read + regex, no heavy imports.
// (Lesson #8447: fast-path scripts can't pull in utils.mjs, which drags in
// child_process/nlp/scoring-sql.) estimateContentTokens is therefore a hand-
// mirror of utils.estimateTokens; tests/file-intel.test.mjs pins the two so a
// change to the canonical estimator surfaces as a failing mirror test.

import { statSync, openSync, readSync, closeSync } from 'fs';
import { basename as pathBasename } from 'path';

const SUMMARY_MAX = 80;
const DEFAULT_MIN_TOKENS = 800;
const DEFAULT_MAX_READ_BYTES = 24 * 1024;

// Mirror of utils.estimateTokens (ASCII ~4 chars/token, CJK ~1.5). Kept local so
// the standalone hook stays lean — see file header + the mirror test.
export function estimateContentTokens(text) {
  const s = text || '';
  if (!s) return 1;
  let cjkCount = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x3000 && c <= 0x303f) ||
      (c >= 0xff00 && c <= 0xffef) ||
      (c >= 0xac00 && c <= 0xd7af)
    ) {
      cjkCount++;
    }
  }
  const asciiLen = s.length - cjkCount;
  return Math.max(1, Math.ceil(asciiLen / 4) + Math.ceil(cjkCount / 1.5));
}

// 850 → "850", 6100 → "6.1k", 12000 → "12k".
export function humanTokens(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + 'k';
  return Math.round(n / 1000) + 'k';
}

function cap(s) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= SUMMARY_MAX ? t : t.slice(0, SUMMARY_MAX - 1) + '…';
}

function isGenericComment(text) {
  if (/^[-=*_#·]{3,}$/.test(text)) return true;
  const l = text.toLowerCase();
  return (
    l.startsWith('eslint') ||
    l.startsWith('prettier') ||
    l.startsWith('tslint') ||
    l.startsWith('stylelint') ||
    l.startsWith('istanbul') ||
    l.startsWith('c8 ') ||
    l.startsWith('copyright') ||
    l.startsWith('license') ||
    l.startsWith('spdx') ||
    l.startsWith('use strict') ||
    l.startsWith('@') ||
    l.startsWith('global ') ||
    l.startsWith('generated') ||
    l.startsWith('auto-generated') ||
    l.startsWith('nolint')
  );
}

// First meaningful header comment in the first 15 lines, skipping blanks,
// shebangs, and boilerplate (eslint/license/etc). Stops at the first real code
// line so we don't scan deep into the body.
function extractHeaderComment(content) {
  const lines = content.split('\n');
  const limit = Math.min(lines.length, 15);
  for (let i = 0; i < limit; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith('#!')) continue; // shebang
    const m = t.match(/^(?:\/\/\/?|#|--|\/\*\*?|\*)\s*(.+)/);
    if (m) {
      const text = m[1].replace(/\*\/\s*$/, '').trim();
      if (text.length > 4 && !isGenericComment(text)) return text;
      continue;
    }
    break; // real code line — no header comment
  }
  return '';
}

function extractExports(content) {
  const names = [];
  const re =
    /export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+(\w+)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  if (names.length === 0) return '';
  const shown = names.slice(0, 5).join(', ');
  return names.length > 5 ? `Exports ${shown} + ${names.length - 5} more` : `Exports ${shown}`;
}

// Best-effort one-line "what's in it". '' when nothing useful is found.
export function extractFileSummary(content, filename) {
  const src = content || '';
  if (!src.trim()) return '';
  const name = (filename || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot) : '';

  if (ext === '.md' || ext === '.mdx') {
    const m = src.match(/^#{1,6}\s+(.+)$/m);
    if (m) return cap(m[1]);
  }

  if (ext === '.json') {
    try {
      const obj = JSON.parse(src);
      if (obj && typeof obj.description === 'string' && obj.description.trim()) return cap(obj.description);
      if (obj && typeof obj.name === 'string' && obj.name.trim()) return cap(obj.name);
    } catch {
      /* partial / invalid JSON — no summary */
    }
    return '';
  }

  const hdr = extractHeaderComment(src);
  if (hdr) return cap(hdr);

  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) {
    const exp = extractExports(src);
    if (exp) return cap(exp);
  }

  return '';
}

export function formatFileIntelLine({ basename, tokens, summary }) {
  const head = `[mem] 📄 ${basename} ~${humanTokens(tokens)} tok`;
  return summary ? `${head} · ${summary}` : head;
}

// IO wrapper: returns the formatted intel line for filePath, or null when the
// file is unreadable or below the token threshold. Never throws — it runs inside
// a PreToolUse hook that must always exit 0.
export function fileIntelFor(filePath, opts = {}) {
  const minTokens = opts.minTokens ?? DEFAULT_MIN_TOKENS;
  const maxReadBytes = opts.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;

  let size;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null;
  }

  try {
    const fd = openSync(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(Math.min(size, maxReadBytes));
      const n = buf.length > 0 ? readSync(fd, buf, 0, buf.length, 0) : 0;
      const sample = buf.subarray(0, n).toString('utf8');
      // Files within the read window are estimated exactly; larger files estimate
      // from byte size (≈4 ASCII bytes/token). The '~' already signals approximation
      // and we never slurp a multi-MB file inside a hook.
      const tokens = size <= maxReadBytes ? estimateContentTokens(sample) : Math.ceil(size / 4);
      if (tokens < minTokens) return null;
      const summary = extractFileSummary(sample, filePath);
      return formatFileIntelLine({ basename: pathBasename(filePath), tokens, summary });
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
