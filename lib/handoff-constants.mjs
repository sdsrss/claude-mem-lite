// lib/handoff-constants.mjs — cross-session handoff policy, defined once.
//
// Moved out of `hook-shared.mjs` (audit 2026-09-05 P1-2): `lib/startup-dashboard.mjs`
// imported HANDOFF_EXPIRY_EXIT from the hook layer and thereby loaded the whole hook
// import graph for one number. These are policy values, not hook mechanism.
//
// Zero imports on purpose, the same reason `lib/time-constants.mjs` has none: a
// SessionStart-path module must not pay for a dependency to read a constant. (Units
// live there; the durations below are policy expressed in those units, so they are
// spelled out here rather than folded into that module.)

// Handoff system constants
export const HANDOFF_EXPIRY_CLEAR = 6 * 3600000;                // 6 hours (covers lunch/meeting breaks)
export const HANDOFF_EXPIRY_EXIT = 7 * 24 * 60 * 60 * 1000;   // 7 days
export const HANDOFF_ANCHOR_MAX_AGE = 72 * 3600000;             // 72h cap on git_sha anchor — avoids stale-HEAD false positives
export const HANDOFF_MATCH_THRESHOLD = 3;                       // min weighted score
export const CONTINUE_KEYWORDS = /继续|接着|上次|之前的|前面的|刚才|\bcontinue\b|\bresume\b|\bwhere[\s-]+we[\s-]+left\b|\bpick[\s-]+up\b|\bcarry[\s-]+on\b/i;
