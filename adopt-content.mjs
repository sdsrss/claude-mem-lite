// CLAUDE.md-steering plan (v3.13): content generators for the claude-mem-lite
// managed block (written into <cwd>/CLAUDE.md) and its companion
// <cwd>/.claude/plugin_claude_mem_lite.md detail doc. Kept separate from the
// claudemd.mjs primitives so the strings are testable without side effects.
//
// CURRENT_SENTINEL_VERSION tags the managed block as `<!-- claude-mem-lite:begin
// vN -->`. needsRefresh() (claudemd.mjs) compares the version tag AND the block
// body AND the detail-doc content — ANY of the three differing triggers an
// in-place refresh (drift = intended content change, overwritten rather than
// treated as a user edit). So a template edit propagates on the next SessionStart
// even WITHOUT a version bump; the tag need not be monotonic and, in practice,
// need not change at all — we keep `v1` across content edits (see mem #8846).
// We deliberately use `v1` (not `v2`) so the version digit differs from
// the sibling code-graph-mcp plugin's `<!-- code-graph-mcp:begin v2 -->` block in
// the same CLAUDE.md; the slug already scopes the two independently (claudemd.mjs),
// so this is a cosmetic distinguisher, not a functional one. The pre-v3.13 legacy
// memory-dir MEMORY.md sentinel also carried `v1`, but it lives in a different file
// and is migrated away (claudemd.migrateLegacyMemoryDir), so there is no collision.

export const PLUGIN_SLUG = 'claude-mem-lite';
export const CURRENT_SENTINEL_VERSION = 'v1';

// The CLI name as written into the user's project tree — deliberately NOT `CLI_INVOKE`
// (audit R7 P2-1). CLI_INVOKE resolves to an absolute, VERSION-PINNED path
// (`node /home/<user>/.claude/plugins/cache/sdsrss/claude-mem-lite/<version>/cli.mjs`), and
// both generators below write files the user may commit: the managed block lands in
// <cwd>/CLAUDE.md and the detail doc in <cwd>/.claude/, which is the standard home for
// project-scoped settings/commands/agents and is commonly tracked. Embedding the resolved
// path there rewrote the file on every plugin release (needsRefresh sees doc drift) and gave
// teammates a $HOME path that exists on no other machine. This module's output must be
// byte-identical across installs; the resolved path belongs only on runtime-generated
// surfaces that never touch the repo (MCP `instructions`, hook recovery lines).
const CLI = 'claude-mem-lite';

/**
 * The concise managed block injected into <cwd>/CLAUDE.md (between the
 * slug-scoped sentinels — those are added by claudemd.renderBlock, NOT here).
 * Universal: the memory contract is the same for every project, so there is no
 * per-project-type variation. Keep it tight (cheap always-loaded context); the
 * full tables + rules live in the detail doc this block points to.
 */
export function buildClaudeMdBlock() {
  // Intentionally machine-stable: MCP tool names only, NO CLI_INVOKE (that
  // resolves to an absolute path that differs per install — it would make this
  // committed/refreshed block churn across machines). The detail doc holds the
  // full CLI table and, since R7 P2-1, is held to the same standard — see CLI above.
  return `## claude-mem-lite — persistent memory

PreToolUse hooks already run \`mem_recall\` for past lessons before Read/Edit/Write. The calls worth making proactively:

| When | Call |
|------|------|
| Before Edit/Write | hook already recalled; if a \`#NN\` lesson was injected, cite \`#NN\` next time you produce user-visible text (citing = adopting the feedback; uncited lessons decay) |
| After fixing a non-trivial bug | \`mem_save(type="bugfix", lesson_learned="<root cause + fix>", importance=2)\` |
| After a non-obvious architecture decision | \`mem_save(type="decision", lesson_learned="<constraint + tradeoff>")\` |
| Deferring to a future session | \`mem_defer({title, priority:1|2|3, detail})\`; when fixed, add \`closes_deferred=[N]\` to \`mem_save\` |
| Looking up past work / history | \`mem_search "keywords"\` · \`mem_recent\` · \`mem_timeline\` |

Path cost is round-trips, not milliseconds: the PreToolUse hook above already recalls (0 calls) — prefer it. For an explicit query, if these \`mem_*\` tools are deferred behind ToolSearch this session, the Bash CLI \`${CLI}\` is one call vs two (ToolSearch + call); the MCP server instructions carry the absolute path to use when it is not on PATH.

Full tool + CLI tables, citation/decay rules, and save discipline → \`.claude/plugin_claude_mem_lite.md\``;
}

/**
 * Full detail doc rendered into `<cwd>/.claude/plugin_claude_mem_lite.md`.
 * Not auto-loaded by Claude Code — the CLAUDE.md block points to it and Claude
 * reads it on demand. claudemd.writeManaged() prepends the `managed-by` marker;
 * this returns pure content.
 */
export function getDetailDoc() {
  return `# claude-mem-lite 插件契约（完整）

> 由 \`${CLI} adopt\` 生成、随版本自动刷新；卸载用 \`${CLI} unadopt\`。
> 精炼触发表在项目 \`CLAUDE.md\` 的 \`claude-mem-lite\` 托管块里；本文件是其展开。
> 设计背景见 docs/CLAUDE-MD-STEERING-PLAN.md。

> **本文下方所有命令写作 \`${CLI} <cmd>\`。** 该名字只在全局装过
> （\`npm i -g claude-mem-lite\`）时才在 PATH 上；否则用等价的
> \`node <插件根目录>/cli.mjs <cmd>\`，绝对路径见本会话 MCP server 的 instructions。
> 本文件**刻意不写死绝对路径**：它随安装位置与版本变化，而本文件可能被提交进仓库，
> 写死会导致每次升版都改动该文件、且队友拿到的是只在别人机器上存在的路径。

## 被动 recall（hook 已自动跑，你只需采纳）

PreToolUse hook 在你 Read / Edit / Write 文件前已自动 \`mem_recall\` 该文件：
- **Read** 路径：asymmetric-quiet——最多 1 条 lesson、120 字符、要求带 \`lesson_learned\`。
- **Edit / Write** 路径：decision-support——最多 3 条、240 字符、高重要度 bugfix/decision 即使无
  lesson 也注入。
- Read→Edit 同文件共享 cooldown（不重复注入正文），但 Read 注入后的首个 Edit 会把 lesson **ID**
  以一行 ack 指令重新浮出。看到 \`#NN [bugfix] …\` 这类行时：**下次产出用户可见文字时引用 \`#NN\`**
  （\`'#NN applied'\` 或 \`'#NN n/a — <理由>'\`）。纯工具回合不算；把 ID 记在工作记忆里，写回时引用。
- 系统按会话追踪引用：未引用的 lesson 连续 3 个会话后 importance −1（地板 0），被引用的 +1（封顶 3）。
  引用是给系统的反馈，不是合规仪式——注入池据此自调。

## 何时主动调用 MCP 工具

\`tools/list\` 默认暴露 6 个核心工具 + 3 个 defer 工具：
\`mem_search\` / \`mem_recent\` / \`mem_recall\` / \`mem_get\` / \`mem_save\` / \`mem_timeline\` +
\`mem_defer\` / \`mem_defer_list\` / \`mem_defer_drop\`。

### 选 MCP 还是 CLI：按 round-trip,不是执行毫秒

真正的开销是模型往返次数,不是工具执行——暖 MCP 调用 ~25ms、CLI 冷启 ~90ms,在一次推理(秒级)面前都是噪声。按往返次数选路：

1. **被动 hook（0 往返）**：上面的 PreToolUse recall 已自动跑,最快,优先采纳,别重复调。
2. **CLI via Bash（1 往返）**：工具多的会话里 \`mem_*\` 会被 defer 到 ToolSearch 后面——这时一次 MCP 调用 = ToolSearch + call = **2 往返**,而 Bash 跑一条 CLI 只 **1 往返**。派出去的子 agent 通常也拿不到 \`mem_*\` 工具,CLI 是它唯一的 1-往返路径。用下面「CLI 速查」表里的命令。
3. **MCP 直调（已加载时 1 往返）**：\`mem_*\` 已在上下文里(未被 defer)就直接调,暖进程执行最快、省掉 ToolSearch。

一句话：能让 hook 代劳就别调；要显式查,若得先 ToolSearch 才能用 \`mem_*\`,改跑 CLI。

| 时机 | 工具 | 关键参数 |
|------|------|----------|
| Edit / Write 前 | \`mem_recall\` | \`file="<路径>"\`（hook 通常已代劳） |
| Test failure / error | \`mem_search\` | \`query="<错误关键词>", obs_type="bugfix"\` |
| Refactor 前 | \`mem_search\` | \`query="<模块>", obs_type="refactor"\` |
| 新功能起手 | \`mem_search\` | \`query="<功能区域>"\` —— 找 prior art |
| 解决非平凡 bug 后 | \`mem_save\` | \`type="bugfix", lesson_learned="<根因+修法>", importance=2\` |
| 非显然架构决策后 | \`mem_save\` | \`type="decision", lesson_learned="<约束+取舍>"\` |
| 上下文提到 #NN | \`mem_get\` | \`ids=[NN]\` |

## 必做契约（dogfood，本仓库尤其严格）

- **解决非平凡 bug 后**（≠ typo / rename）**必须** \`mem_save(type="bugfix",
  lesson_learned="<一行根因+一行修法>", importance=2)\`。判据：未来改同一文件的会话看到这条能否避坑？能→存。
- **非显然架构决策后**（≠ 改名/挪代码）调 \`mem_save(type="decision",
  lesson_learned="<约束+为何这样选+牺牲了什么>")\`。\`decision\` 命中率显著高于 \`change\`（当前遥测约
  3:1，会漂移——用 \`${CLI} stats\` 实测，别套固定倍数）；方向稳健：一条好 decision 抵数条 change。
  别注水：decision 只留给真权衡，不是风格选择。
- **推迟到未来会话**（≠ 在途 todo、≠ 本 PR 跟进）调
  \`mem_defer({title, priority:1|2|3, detail:"<约束+为何推迟>"})\`。
  触发词：中文「下次/下个会话/不在本轮范围/留给下个会话」；en「next session / defer to next round /
  out of scope for this PR / pick up later」。
- 修掉 deferred 项时 **必须** 给 \`mem_save\` 加 \`closes_deferred=[N]\`（N 是 SessionStart
  \`### Deferred Work\` banner 里的序号，或原始 id \`["D#42"]\`，混用 OK），让 carry-forward 链闭合。
  若该项无需修（flaky/scope shift）改用 \`mem_defer_drop({id, reason})\`，reason 必填、作审计。
- **不要为凑 schema 写 \`lesson_learned: 'none'\`**：写不出能复用的教训就留 NULL，接受低重要度观测。
  Haiku 默认过于激进地填 "none"——手动 save 时覆盖它。

## 维护 / 管理类工具（走 CLI）

以下工具从 \`tools/list\` 隐藏（缩小启动上下文）；仍注册在 MCP 层、按名 \`tools/call\` 可命中，
但对 Claude Code 这类只读 tools/list 的调用方只走 CLI：

| 场景 | CLI |
|------|-----|
| 清理过期记忆 | \`${CLI} maintain scan --ops purge_stale\` → \`maintain execute --ops purge_stale --confirm\`（删行必须 \`--confirm\`） |
| 深度优化（Haiku） | \`${CLI} optimize\`（默认 preview；\`--run\` 执行，\`--task re-enrich,normalize,cluster-merge,smart-compress\`） |
| 压缩旧条目 | \`${CLI} compress\`（默认 preview；\`--execute\` 执行，\`--age-days N\`） |
| FTS5 索引检查 / 重建 | \`${CLI} fts-check <check\\|rebuild>\` |
| tier 分组浏览 | \`${CLI} browse [--tier active]\` |
| 导出 JSON/JSONL | \`${CLI} export [--format jsonl]\` |
| 统计总量 / 健康 | \`${CLI} stats [--days 30]\` |
| 删除 / 更新某条 | \`${CLI} delete <id>[,<id>]\` · \`${CLI} update <id> [--title ...]\` |

## CLI 速查（常用检索）

| 命令 | 用途 |
|------|------|
| \`${CLI} search "query"\` | FTS5 全文搜索（默认排除低信号 \`Modified X\` 等；加 \`--include-noise\` 找文件变更记录） |
| \`${CLI} search "err" --type bugfix\` | 按类型过滤 |
| \`${CLI} recall "file.mjs"\` | 文件相关记忆 |
| \`${CLI} recent 5\` | 最近 5 条 |
| \`${CLI} get 42,43\` | 按 ID 展开 |
| \`${CLI} timeline --anchor 42\` | 时间线上下文 |

## CLI 速查（写入 / 记录）

写入类工具多从 \`tools/list\` 隐藏 → 只能走 CLI。下表带**硬上限**（超限直接报错，别撞了才知道）；完整 flag 见 \`${CLI} help\`。

| 命令 | 签名（含硬约束） |
|------|------------------|
| 存观测 | \`${CLI} save "<text>" --type bugfix\\|decision --lesson "<≤500 字符>" [--importance 1-3] [--closes-deferred N]\` — \`<text>\` **必填定位参数**；\`--lesson\` 超 500 直接 fail |
| 推迟工作 | \`${CLI} defer add "<title ≤200>" [--priority 1\\|2\\|3] [--detail "<约束+为何推迟>"]\` — 标题 >200 挪到 \`--detail\` |
| 改某条 | \`${CLI} update <id> [--lesson "<≤500>"] [--title T] [--type T] [--importance 1-3] [--narrative T] [--concepts "a b c"]\` |
| 事件日志 | \`${CLI} activity save --type <bugfix\\|lesson\\|bug\\|discovery\\|refactor\\|feature\\|observation\\|decision> "<title>" [--body T] [--files f1,f2]\` |

\`maintain\` / \`optimize\` / \`compress\` 见上方「维护 / 管理类工具」；\`maintain --ops\` 取值 \`cleanup,decay,boost,demote_pinned,dedup,purge_stale,rebuild_vectors,vacuum\`，省略时默认 \`cleanup,decay,boost,demote_pinned\`（顺序有意义：demote_pinned 必须在 boost 之后）；\`--retain-days\` ∈ [7,365]。

## 卸载 / 关闭

- \`${CLI} unadopt\`：移除 CLAUDE.md 托管块 + \`.claude/plugin_claude_mem_lite.md\`；
  CLAUDE.md 里你自己的内容（sentinel 之外）不动。
- 本项目永久关闭自动 adopt：\`${CLI} adopt --disable\`（\`--enable\` 重新武装）。
- 全局禁用自动 adopt：环境变量 \`MEM_NO_AUTO_ADOPT=1\`。
- 关闭版本漂移自动刷新（保留你对托管块的手改）：\`CLAUDE_MEM_NO_TEMPLATE_REFRESH=1\`。
`;
}
