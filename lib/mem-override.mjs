// User-explicit "ignore memory" override detector. Mirrors CC built-in
// memoryTypes.ts:215 ("If the user says to *ignore* or *not use* memory:
// Do not apply remembered facts"). Tight regexes — must require both an
// "ignore-class" verb AND the memory token, so phrases like "memory leak",
// "记忆中的事件", "MEM-1234" pass through unaffected.
//
// Two parallel patterns:
//   EN — ignore|skip|forget|disable|drop|reject + (optional qualifier)
//        + memor(y|ies) | memory-context | past context | recall;
//        plus the negated form: do not / don't + use|read|inject|apply.
//   CN — 1) ignore-class verbs (无视|忽略|忽视|跳过|拒绝|不再[用|看|读|参考])
//           + (optional qualifier) + 记忆
//        2) 不要|别|不需|不必 + use-class verb (用|看|读|参考|...) + 记忆.
//
// Lives under lib/ (not scripts/) because hook.mjs imports it directly
// for the handleUserPrompt short-circuit. install.mjs/hook-update.mjs
// rename scripts/ as a directory; an individual `scripts/<file>.mjs`
// entry in SOURCE_FILES would collide with that rename.

const MEM_OVERRIDE_EN =
  /\b(?:ignore|skip|forget|disable|drop|reject)\s+(?:(?:any|all|the|past|prior|previous|recalled?|injected|stored)\s+){0,3}(?:memor(?:y|ies)|memory-?context|mem[\s-]context|past\s+context|recall)\b|\b(?:do\s+not|don['’`]?t)\s+(?:use|read|inject|apply)\s+(?:(?:any|all|the|past|prior|previous|recalled?|injected|stored)\s+){0,3}(?:memor(?:y|ies)|memory-?context|mem[\s-]context|past\s+context|recall)\b/i;

const MEM_OVERRIDE_CN =
  /(?:无视|忽略|忽视|跳过|拒绝|不再用|不再看|不再读|不再参考)\s*(?:任何|所有|过去|先前|之前|历史|相关|这次|本次|过往|注入|的){0,3}\s*记忆|(?:不要|别|不需|不必)\s*(?:再)?\s*(?:用|看|读|查|参考|使用|启用|采用|采纳|读取|加载|应用|注入|带上)\s*(?:任何|所有|过去|先前|之前|历史|相关|这次|本次|过往|注入|的){0,3}\s*记忆/;

/**
 * Returns true if the prompt explicitly tells Claude to ignore memory.
 * UPS hook + handleUserPrompt memory injection MUST short-circuit on true.
 */
export function detectMemOverride(text) {
  if (!text || typeof text !== 'string') return false;
  return MEM_OVERRIDE_EN.test(text) || MEM_OVERRIDE_CN.test(text);
}
