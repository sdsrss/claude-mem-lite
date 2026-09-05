// Single source of truth for tools skipped in post-tool-use processing.
// Used by hook.mjs (Node) and validated against scripts/post-tool-use.sh (bash).

/** Exact tool names to skip — low-value tools that don't need memory processing */
export const SKIP_TOOLS = new Set([
  'Read',
  'Glob', // noise — just opening/finding files
  'TodoRead',
  'TodoWrite',
  'TaskList',
  'TaskGet',
  'TaskCreate',
  'TaskUpdate',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'mcp__claude-in-chrome__screenshot',
  'mcp__claude-in-chrome__read_page',
  'mcp__claude-in-chrome__tabs_context_mcp',
  'mcp__claude-in-chrome__computer',
  'mcp__claude-in-chrome__find',
  'mcp__claude-in-chrome__navigate',
]);

/** Prefix patterns — tools starting with these are also skipped */
export const SKIP_PREFIXES = [
  'mem_',
  'mcp__mem__', // legacy global MCP name (pre-rename)
  'mcp__mem-lite__', // current global MCP name (post-rename v2.78+)
  'mcp__plugin_claude-mem-lite',
  'mcp__sequential',
  'mcp__plugin_context7',
];
