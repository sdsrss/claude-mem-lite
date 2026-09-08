// Dedup / merge similarity thresholds — single source of truth (P10).
//
// All values are Jaccard-space (word-set overlap, 0..1) unless noted. They were
// scattered as bare literals and duplicate local consts across save-observation,
// maintain-core, hook-llm, hook-optimize, mem-cli, server, and hook; converging
// them here removes the drift risk and gives the P7 benchmark named knobs.
// This file was never coupled to the TF-IDF vector arm and is unaffected by its Phase-2
// removal: MinHash/Jaccard dedup runs on every write, and all 26 live rows carry a signature.
// It used to note that VOCAB_DIM / MIN_COSINE_SIMILARITY / RRF_K deliberately stayed in
// tfidf.mjs; the first two are deleted and RRF_K now lives in lib/rrf.mjs.
//
// Pure constants only — no imports, so nothing can import-cycle through this.

// 0.7: near-duplicate cutoff for save-time dedup (5-min window, lib/save-observation)
// and the hook-llm tier-1 title dedup. Catches "Modified X" / "Fixed X" restatements
// (~70% word overlap) without collapsing distinct-but-related observations.
export const DEDUP_JACCARD_THRESHOLD = 0.7;

// 0.85: high-confidence auto-merge cutoff (maintain + optimize cluster-merge, CLI/MCP
// dedup preview). Pairs at or above this merge without an LLM merge-decision call.
export const AUTO_MERGE_THRESHOLD = 0.85;

// 0.4: low bound of the LLM-review merge band [0.4, 0.85) in hook-optimize. Below it,
// a pair is too dissimilar to be worth a merge-decision call.
export const MERGE_JACCARD_LOW = 0.4;

// 0.5: MinHash estimated-Jaccard pre-filter for the maintain O(n²) scan — skip the
// exact-Jaccard compare when the cheap signature estimate is already below this.
export const MINHASH_PRE_THRESHOLD = 0.5;

// 0.7: MinHash pre-filter for the hook post-inject fuzzy-dedup pass. Stricter than
// maintain's 0.5 to keep the inline inject path cheap (it runs in the hot Stop path).
export const MINHASH_PREFILTER = 0.7;

// 0.95: strict title-Jaccard cutoff for the hook post-inject fuzzy-dedup pass — only
// collapse near-identical titles inline; anything softer waits for the maintain sweep.
export const FUZZY_DEDUP_THRESHOLD = 0.95;

// 0.5: companion BODY-Jaccard floor for the hook fuzzy-dedup pass (audit #8). Titles
// alone are a word-SET metric, so two distinct observations sharing a title token-set
// ("Fix auth bug in login.mjs" vs "Fix login.mjs auth bug") would collapse and hide
// one body. Requiring the narratives to also overlap means only a genuine re-save of
// the same event (near-identical body) supersedes; distinct bodies are kept.
export const FUZZY_BODY_THRESHOLD = 0.5;
