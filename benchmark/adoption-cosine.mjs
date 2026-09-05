import { tokenize } from '../tfidf.mjs';

export function textToBag(text) {
  const bag = new Map();
  for (const t of tokenize(text || '')) bag.set(t, (bag.get(t) || 0) + 1);
  return bag;
}

export function buildIdf(corpusTexts) {
  const N = corpusTexts.length || 1;
  const df = new Map();
  for (const text of corpusTexts) {
    for (const term of new Set(tokenize(text || ''))) df.set(term, (df.get(term) || 0) + 1);
  }
  const idf = new Map();
  for (const [term, d] of df) idf.set(term, Math.log(1 + N / (1 + d)));
  idf.__default = Math.log(1 + N / 1); // unseen term: df=0
  return idf;
}

export function cosine(bagA, bagB, idf) {
  const w = (term, tf) => tf * (idf.get(term) ?? idf.__default ?? 0);
  let dot = 0,
    na = 0,
    nb = 0;
  for (const [t, tf] of bagA) {
    const x = w(t, tf);
    na += x * x;
    if (bagB.has(t)) dot += x * w(t, bagB.get(t));
  }
  for (const [t, tf] of bagB) {
    const y = w(t, tf);
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export function dualChannelBags({ prose, actions }) {
  return { proseBag: textToBag(prose), actionBag: textToBag(actions) };
}
