// claude-mem-lite: remove instruction blocks the host prepends to a user prompt.
//
// With Claude in Chrome connected, the Claude Code VS Code extension sends every prompt
// with a `<browser_instruction>…</browser_instruction>` block in front of what the user
// typed: about 4KB of browser-tool instructions (4150 chars observed), identical on every
// turn. In the transcript it is its own text part; the UserPromptSubmit hooks receive it
// joined in front of the typed text. Kept, it became the stored prompt_text and so the
// handoff's "Working On" line, and in scripts/user-prompt-search.js it filled the whole
// capped FTS query (lib/ups-query.mjs: 2000 chars / 64 tokens), so none of the typed terms
// reached the search.
//
// Applied at every boundary that reads a prompt in, before the <task-notification> sentinel
// they share: hook.mjs handleUserPrompt, scripts/user-prompt-search.js and
// lib/import-jsonl.mjs importPrompt.
//
// Case-sensitive on purpose: the host emits the tag in lowercase, and a case-folded copy
// of the text can differ in length from the original, which would misplace every index.
//
// Only well-formed pairs are removed. An opener with no close is left alone: unlike
// <private> (which fails closed), this block carries nothing sensitive, and a prompt that
// merely mentions the tag should not lose the rest of its text.

const HOST_BLOCK_TAGS = ['browser_instruction'];

/**
 * Remove each well-formed host instruction block and trim the result.
 * Returns the input unchanged when it holds no such block.
 *
 * indexOf scanning rather than a lazy `[\s\S]*?` regex: the regex form walks to the end of
 * the input once per unclosed opener, and this runs on the synchronous prompt path
 * (see the measurements in lib/private-strip.mjs).
 *
 * @param {unknown} text Prompt text (non-string passes through)
 * @returns {string|unknown}
 */
export function stripHostBlocks(text) {
  if (typeof text !== 'string' || !text.includes('<')) return text;
  let out = text;
  let changed = false;
  for (const tag of HOST_BLOCK_TAGS) {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    if (!out.includes(open)) continue;
    let result = '';
    let cursor = 0;
    for (;;) {
      const start = out.indexOf(open, cursor);
      if (start === -1) break;
      const end = out.indexOf(close, start + open.length);
      if (end === -1) break;
      result += out.slice(cursor, start);
      cursor = end + close.length;
      changed = true;
    }
    out = result + out.slice(cursor);
  }
  return changed ? out.trim() : text;
}
