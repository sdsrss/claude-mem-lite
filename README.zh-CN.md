[English](README.md) | [中文](README.zh-CN.md)

# claude-mem-lite

`claude-mem-lite` 是 **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)**（Anthropic 官方 CLI 编程代理）的 **持久化记忆系统**（也称 **长期记忆 / 跨会话上下文 / Claude Code 记忆插件**）。它以 **[MCP](https://modelcontextprotocol.io/) 服务器** + Claude Code 钩子（hooks）的形式运行，在编码会话中自动捕获观察记录、决策、bug 修复，并通过 FTS5 全文检索 + TF-IDF 向量的混合检索召回历史上下文。

与 [`mem0`](https://github.com/mem0ai/mem0)、MCP 官方参考实现的 [`memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) 服务器等通用 LLM 记忆框架相比，claude-mem-lite 专为 Claude Code 的钩子生命周期定制：episode 批处理把 LLM 调用量相比原版 [claude-mem](https://github.com/thedotmack/claude-mem) 减少 7-10 倍（综合成本估算下降约 600 倍 —— 见下方成本模型，属架构估算而非实测基准）；FTS5 + TF-IDF 混合检索在 30 个查询的基准上达到 **Recall@10 = 0.90 / Precision@10 = 0.85**（复现命令见[搜索质量](#搜索质量)一节）。

无需外部服务。单一 SQLite 数据库。开销极低。

## 为什么选择 claude-mem-lite？

对 [claude-mem](https://github.com/thedotmack/claude-mem) 的重新设计，用更智能、更精简的架构替代其重量级方案。

### 架构对比

| | claude-mem（原版） | claude-mem-lite |
|---|---|---|
| **LLM 调用** | 每次工具使用都触发 Sonnet 调用 | 仅在 episode 刷新时调用（5-10 次操作批处理） |
| **LLM 输入** | 原始 `tool_input` + `tool_output` JSON | 预处理后的动作摘要 |
| **对话模式** | 多轮对话，累积完整历史 | 无状态单轮提取 |
| **噪声过滤** | LLM 通过 "WHEN TO SKIP" 提示词判断 | 确定性的代码级 Tier 1 过滤器 |
| **运行方式** | 长驻后台 worker 进程（1.8MB .cjs） | 按需启动，立即退出 |
| **依赖** | Bun + Python/uv + Chroma 向量数据库 | 仅 Node.js（3 个 npm 包） |
| **源码大小** | ~2.3MB 编译后的打包文件 | ~50KB 可读源码 |
| **数据目录** | `~/.claude-mem/` | `~/.claude-mem-lite/`（隐藏目录，自动迁移） |

### Token 与成本效率

以典型的 50 次工具调用的会话为例（成本模型示意 —— 下列比率由批大小、token 量与模型定价**估算**得出，并非端到端实测）：

| | claude-mem | claude-mem-lite | 比率（估算） |
|---|---|---|---|
| LLM 调用次数 | ~50（每次工具使用） | ~5-8（按 episode） | **约减少 7-10 倍** |
| 每次调用 token | 1,000-5,000（原始 JSON + 历史） | 200-500（仅摘要） | **约减少 5-10 倍** |
| 总 token 量 | ~100K-250K | ~1K-4K | **约减少 50-100 倍** |
| 模型成本 | Sonnet ($3/$15 每百万) | Haiku ($0.25/$1.25 每百万) | **约便宜 12 倍** |
| 综合节省 | | | **成本降低约 600 倍（估算）** |

### 质量对比

| 维度 | 胜出方 | 原因 |
|---|---|---|
| **分类准确性** | 持平 | 两者都能正确生成 type/title/narrative |
| **噪声过滤** | **lite** | 代码级过滤是确定性的；LLM 的 "WHEN TO SKIP" 不可靠 |
| **观察连贯性** | **lite** | Episode 批处理将相关编辑组合为一条连贯的观察 |
| **代码级细节** | 原版 | 能看到完整 diff，但在记忆搜索中很少用到 |
| **搜索召回率** | 持平 | 用户搜索语义概念（"auth bug"），而非代码行 |
| **Hook 延迟** | **lite** | 异步后台 worker；原版每次 hook 阻塞 2-5 秒 |

### 设计理念

原版把**所有数据扔给 LLM，期望它自行过滤**。claude-mem-lite **先用代码过滤，再把真正重要的内容**发送给更小的模型。这不是降级，而是更智能的架构——以极低的成本产出同等的搜索质量。

## 功能特性

- **自动捕获** -- 挂载到 Claude Code 生命周期（PostToolUse、PreToolUse、SessionStart、Stop、UserPromptSubmit），无需手动操作即可记录观察
- **FTS5 搜索** -- 基于 BM25 排名的全文搜索，覆盖观察、会话摘要和用户提示，支持重要度加权
- **时间线浏览** -- 基于锚点的时间上下文窗口，按时间顺序浏览观察
- **Episode 批处理** -- 将相关文件操作分组为连贯的 episode，再进行 LLM 编码
- **错误触发回忆** -- Bash 出错时自动搜索记忆，浮现相关的历史修复方案
- **主动文件历史** -- 编辑文件时，自动显示该文件相关的历史观察记录
- **会话摘要** -- 会话结束时通过后台 worker（使用 `claude -p`）生成 LLM 摘要
- **项目作用域上下文** -- 将最近的记忆注入 `CLAUDE.md` 和会话启动上下文
- **观察类型** -- 分类为 `decision`、`bugfix`、`feature`、`refactor`、`discovery` 或 `change`
- **重要度分级** -- LLM 为每条观察分配 1-3 级重要度（日常/关注/关键）
- **观察关联** -- 基于文件重叠自动建立观察之间的双向链接
- **用户提示捕获** -- 通过 UserPromptSubmit 钩子记录用户提示，追踪用户意图
- **Read 文件追踪** -- 追踪会话中读取的文件，丰富 episode 上下文
- **零数据丢失** -- LLM 失败时，使用推断的元数据保存降级记录，而非丢弃
- **两级去重** -- Jaccard 相似度（5 分钟窗口）+ MinHash 签名（7 天跨会话窗口）双重防重
- **同义词扩展** -- 缩写如 `K8s`、`DB`、`auth` 在 FTS5 搜索时自动扩展为全称（48+ 对）
- **伪相关反馈（PRF）** -- 首轮结果作为种子扩展查询，提升召回率
- **概念共现** -- 观察间的共享概念自动扩展搜索到相关主题
- **上下文感知重排** -- 活跃文件重叠提升相关性（精确匹配 + 目录级半权重）
- **过时检测** -- 当更新的观察覆盖相同文件且重要度更高时，标记旧观察为已取代
- **自适应时间窗口** -- 会话启动回忆使用基于速率的时间窗口（高/中/低活跃度分级）
- **Token 预算上下文** -- 贪心背包算法在 2,000 token 预算内选择会话启动上下文，按时效性和重要度优先
- **观察压缩** -- 可将旧的低价值观察压缩为每周摘要，减少噪声
- **秘密擦除** -- 自动编辑 API 密钥、token、PEM 块、数据库连接字符串等 15+ 种凭证模式
- **原子写入** -- 所有文件写入（episode、CLAUDE.md）使用 write-to-tmp + rename 防止崩溃时损坏
- **健壮锁机制** -- PID 感知的锁文件，自动清理过期（>30s）或孤儿（PID 已死）锁
- **过期会话清理** -- 活跃超过 24 小时的会话在下次启动时自动标记为 abandoned
- **智能调用** -- 三层调用系统：L1 自动加载（UserPromptSubmit 匹配 skill 名注入内容 + `Read()` 路径），L2 Bridge（PreToolUse 拦截 `Skill()` 误调），L3 显式调用（`mem_use` MCP 工具）。managed 资源用 `Read("~/.claude-mem-lite/managed/.../SKILL.md")`，原生插件用 `Skill("full:name")`
- **资源注册表** -- 对已安装的 skill 和 agent 建立 FTS5 索引，支持复合评分和调用追踪。搜索结果区分 managed（Read 路径）vs native（Skill 全名）调用方式
- **统一资源发现** -- 共享文件系统遍历层（`resource-discovery.mjs`），运行时扫描器和离线索引器共用，支持扁平目录、插件嵌套和松散 `.md` 文件
- **领域同义词扩展** -- 注册表搜索查询自动扩展领域同义词（如 "修复" → fix, debug, bugfix, repair, error）
- **持久化冷却机制** -- 5 分钟跨会话冷却 + 同会话去重，避免重复推荐 skill 自动加载
- **多 provider LLM 调用** -- provider 优先级 `ANTHROPIC_API_KEY`（直连 Anthropic API）→ `OPENROUTER_API_KEY`（OpenRouter，OpenAI 兼容，可用 `OPENROUTER_MODEL` 指向任意模型）→ 无 key 时回退 `claude -p` CLI
- **Haiku 熔断器** -- 连续 3 次 LLM 失败后，禁用 Haiku 调度 5 分钟，防止级联延迟
- **否定意图感知** -- 正确处理 "不要测试了，先修 bug" 等复杂提示，排除被否定的意图，支持中英文混合输入
- **可配置 LLM 模型** -- 通过 `CLAUDE_MEM_MODEL` 环境变量在 Haiku（快速/低成本）和 Sonnet（深度分析）之间切换
- **数据库自动恢复** -- 启动时检测并清理损坏的 WAL/SHM 文件；定期 WAL checkpoint 防止无限增长
- **Schema 自动迁移** -- 每次启动运行幂等的 `ALTER TABLE` 迁移，安全地添加新列和索引，不丢失数据
- **探索奖励** -- 注册表中的新资源在复合排名中获得公平机会；高推荐零采纳的"僵尸"资源被惩罚
- **LLM 并发控制** -- 基于文件的信号量将后台 worker 限制为 2 个并发 LLM 调用，防止资源争用
- **stdin 溢出保护** -- Hook 输入在 256KB 处截断，对超大工具输出使用正则挽救关键信息
- **跨会话交接** -- 在 `/clear` 或 `/exit` 时捕获会话状态（请求、已完成工作、后续步骤、关键文件），下次会话检测到继续意图时自动注入上下文（支持显式关键词和 FTS5 术语重叠匹配）
- **插件缓存 hook 自愈** -- Claude Code runtime 从 `~/.claude/plugins/cache/<mp>/<plugin>/<ver>/hooks/hooks.json` 读取插件 hook，而非 marketplace 源。当 `install.mjs` 写入 `settings.json` 的 hooks 与残留 cache `hooks.json` 同时存在（例如曾装过 marketplace 版本，或插件被 Claude Code 自动升级重建 cache），runtime 会注册两套 hook → 每次 SessionStart / UserPromptSubmit 都触发两份。`install.mjs` 和 `hook-update.mjs` 现在会清理每个 cache 版本目录下的 `hooks.json`；`hook.mjs session-start` 每次启动自愈（通过 `hasInstallManagedHooks` 门控，不影响纯插件模式用户）；`install.mjs status` 会报告 cache 污染状况（自 v2.31.1 / v2.31.2 起）。
- **Git-SHA 延续锚点**（v2.31.0）-- handoff 记录包含 `git_sha_at_handoff` 字段，任何匹配当前 `HEAD` 的 handoff 都视为延续会话，不受 TTL 限制。代码状态比时钟时间更能反映上下文延续。
- **启动面板**（v2.31.0）-- SessionStart hook 将 `git status` + `~/.claude/tasks/*.json` + `~/.claude/plans/*.md` + 最近 /exit 交接 + 最近事件数聚合为一个结构化块，通过 `hookSpecificOutput.additionalContext` 注入。
- **活动命名空间**（v2.31.0）-- 为非 memdir 类型（`bugfix` / `lesson` / `bug` / `discovery` / `refactor` / `feature` / `observation` / `decision`）启用独立的 `events` 表 + FTS5，与 observations 表的 `WHAT_NOT_TO_SAVE` 语义解耦。CLI：`claude-mem-lite activity save|search|recent|show`。`hook-llm` 通过 `persistHaikuSummary` 路由非 memdir 摘要，observations → events 升级路径是事务原子的。（v3.39：`/lesson`、`/bug` 斜杠命令已从此 events 表重定向到可搜索的 **observations**——`mem_search` 从不读 events 表，显式保存因此搜不到；events 表仍作自动捕获活动日志。）

## 平台支持

| 平台 | 状态 | 说明 |
|------|------|------|
| **Linux** | 支持 | 主要开发和测试平台 |
| **macOS** | 支持 | 完全兼容（Intel 和 Apple Silicon） |
| **Windows** | 暂不支持 | 使用 POSIX shell 脚本（`post-tool-use.sh`、`setup.sh`）和 Unix 文件锁；WSL2 可能可用但未经测试 |

## 环境要求

- **Node.js** >= 18
- **Claude Code** CLI 已安装并配置（`claude` 命令可用）
- **SQLite3** 支持（由 `better-sqlite3` 提供，安装时编译）
- **平台**：Linux 或 macOS（参见[平台支持](#平台支持)）

## 安装

### 方式一：插件市场（推荐）

```bash
/plugin marketplace add sdsrss/claude-mem-lite
/plugin install claude-mem-lite
```

插件模式会管理自己的运行时与钩子。SessionStart 时它现在只会**检查并提示**新版本，不会直接覆盖插件目录中的文件。插件模式请通过 Claude 的插件更新流程完成升级。

> **插件安装本身即完整** —— hooks、MCP 工具、以及捆绑的 slash 命令（`/mem`、`/lesson`、`/bug`、`/adopt`）全部从插件内运行，无需第二步。slash 命令以从插件目录解析出的绝对路径调用捆绑 CLI（`${CLAUDE_PLUGIN_ROOT}/cli.mjs <cmd>`），因此不依赖 `PATH` 上的任何东西。全局 `claude-mem-lite` **shell** 命令（用于你自己在终端里跑查询）是**可选**的 —— `npm i -g claude-mem-lite` —— 且是**独立**的 npm 安装：插件的自动更新**不会**刷新它，想保持同步就重新跑 `npm i -g claude-mem-lite@latest`。插件要完整工作**并不需要**它。

### 方式二：npx（一行命令）

```bash
npx github:sdsrss/claude-mem-lite
```

源文件会自动复制到 `~/.claude-mem-lite/` 以持久化保存。

### 方式三：git clone

```bash
git clone https://github.com/sdsrss/claude-mem-lite.git
cd claude-mem-lite
node install.mjs install
```

源文件保留在克隆的仓库中。通过 `git pull && node install.mjs install` 更新。

### 安装过程

1. **安装依赖** -- `npm install --omit=dev`（编译原生 `better-sqlite3`）
2. **注册 MCP 服务器** -- `mem-lite` 服务器，包含 20 个工具（9 个核心通过 `tools/list` 暴露 + 11 个隐藏但可调；完整表见 Usage 段）。v2.78 前服务器名为通用的 `mem`，现已改名为 `mem-lite` 避免与用户其它 `.mcp.json` 冲突；工具名（`mem_search`/`mem_recall` 等）保持不变。

> **自动 adopt 会写进你的项目，且每次 SessionStart 都跑（v3.13+）。** 插件向**项目自己的 `<cwd>/CLAUDE.md`**（通常是会进 git 的文件）写入一个 slug 限定的**托管块**，外加 `<cwd>/.claude/plugin_claude_mem_lite.md` 详情文件。该块是一条提升 Claude 主动调用 `mem_recall` / `mem_save` 的 system-authority 指针；块以外的内容逐字保留，也能与其它插件的块共存于同一文件。这是**每次** SessionStart 都做的幂等同步，不只是第一次——块被删掉会重新写回，出货模板变了会刷新。**任何安装路径都生效**（npm、npx、`/plugin`、手动），**无需再手动跑 `/adopt`**。
>
> 关闭方式：项目级 `claude-mem-lite adopt --disable`（重新启用用 `--enable`）；全局 `export MEM_NO_AUTO_ADOPT=1`；只冻结模板刷新用 `CLAUDE_MEM_NO_TEMPLATE_REFRESH=1`。`claude-mem-lite unadopt` 可移除托管块与详情文件。手动 `/adopt` 仍保留用于编辑后重写或 `--all` 批量场景。
3. **配置钩子** -- `PostToolUse`、`PreToolUse`、`SessionStart`、`Stop`、`UserPromptSubmit` 生命周期钩子
4. **创建数据目录** -- `~/.claude-mem-lite/`（隐藏目录），存放数据库、运行时和托管资源文件
5. **自动迁移** -- 自动检测 `~/.claude-mem/`（原版 claude-mem）或 `~/claude-mem-lite/`（v0.5 前的非隐藏目录），将数据库和运行时文件迁移到 `~/.claude-mem-lite/`，原目录保持不变
6. **初始化数据库** -- SQLite WAL 模式，FTS5 索引在服务器首次启动时创建

安装后重启 Claude Code 以激活。

### 迁移

所有安装方式自动检测并从旧版本迁移：

**从 claude-mem 原版（`~/.claude-mem/`）：**
- 复制 `claude-mem.db` → `~/.claude-mem-lite/claude-mem-lite.db`（重命名）
- 复制 `runtime/` 目录
- **原 `~/.claude-mem/` 保持不变**（不删除、不覆盖）

**从 v0.5 前的非隐藏目录（`~/claude-mem-lite/`）：**
- 整个目录移动到 `~/.claude-mem-lite/`（隐藏目录）

**就地重命名：**
- 已有的 `~/.claude-mem-lite/claude-mem.db` 会自动重命名为 `claude-mem-lite.db`

确认一切正常后手动删除旧目录：
```bash
rm -rf ~/.claude-mem/       # 原版 claude-mem
rm -rf ~/claude-mem-lite/   # v0.5 前的非隐藏目录（如未自动迁移）
```

### 目录结构

```
~/.claude-mem-lite/
  claude-mem-lite.db       # SQLite 数据库 — 记忆（WAL 模式）
  resource-registry.db     # SQLite 数据库 — skill/agent 注册表
  runtime/
    session-<project>    # 活跃会话状态
    ep-<project>.json    # Episode 缓冲区
    ep-flush-*.json      # 已刷新的 episode，等待处理
    reads-<project>.txt  # Read 文件路径（刷新时收集）
  managed/
    skills/              # 独立 skill：{name}/SKILL.md
    agents/              # Agent 插件：{group}/agents/{name}.md + skills/*/SKILL.md
    repos/               # 浅克隆的源代码仓库
```

## 使用方法

### MCP 工具

v2.34.0 起服务端注册 17 个工具，但 `tools/list` 只暴露 6 个 **核心** 工具；其余
11 个 **隐藏** 工具仍然注册在 MCP 层（按名 `tools/call` 仍命中），只是不会出现
在列表响应里，以避免 Claude Code 会话启动时加载 11 份额外的工具 schema。隐藏
工具走下面表格的 CLI 入口。

**核心（6 个，暴露给 Claude Code）**

| 工具 | 描述 |
|------|------|
| `mem_search` | 基于 BM25 排名的 FTS5 全文搜索。支持按类型、项目、日期范围、重要度过滤。 |
| `mem_recent` | 显示最近的观察，按时间排序。快速查看最新活动。 |
| `mem_recall` | 召回与文件相关的观察。编辑文件前使用，回顾过去的修复和上下文。 |
| `mem_timeline` | 围绕锚点按时间顺序浏览观察。 |
| `mem_get` | 获取指定观察 ID 的完整详情（包含重要度和关联 ID）。 |
| `mem_save` | 手动保存记忆/观察。 |

**隐藏但可按名调用（11 个，走 CLI）**

| 工具 | 对应 CLI | 说明 |
|------|----------|------|
| `mem_update` | `claude-mem-lite update <id>` | 原地更新某条观察。 |
| `mem_stats` | `claude-mem-lite stats` | 计数、类型分布、每日活动。 |
| `mem_delete` | `claude-mem-lite delete <id>` | 预览 / 确认流程，FTS5 自动清理。 |
| `mem_compress` | `claude-mem-lite compress` | 压缩旧的低价值观察（默认 preview；`--execute` 执行）。 |
| `mem_maintain` | `claude-mem-lite maintain scan --ops dedup,decay` | 去重 / decay / 清理 / 向量重建（`scan` 预览，`execute` 执行）。 |
| `mem_optimize` | `claude-mem-lite optimize` | LLM 深度优化：re-enrich / normalize / cluster-merge（默认 preview；`--run` 执行）。 |
| `mem_export` | `claude-mem-lite export` | JSON / JSONL 导出，支持项目/类型/日期过滤。 |
| `mem_fts_check` | `claude-mem-lite fts-check <check\|rebuild>` | FTS5 完整性检查与重建。 |
| `mem_browse` | `claude-mem-lite browse` | 分层仪表盘（working / active / archive）。 |
| `mem_registry` | `claude-mem-lite registry <action>` | 列 / 搜索 / 导入 / 移除 skill / agent。 |
| `mem_use` | _MCP only_ | 从 registry 按名载入 skill / agent。 |

### 技能命令（在 Claude Code 聊天中使用）

```
/mem search <query>        # 全文搜索所有记忆
/mem recent [n]            # 显示最近 N 条观察（默认 10）
/mem recall <file>         # 显示文件相关的历史观察
/mem save <text>           # 保存手动记忆/笔记
/mem stats                 # 显示记忆统计
/mem timeline <query>      # 围绕匹配结果浏览时间线
/mem browse                # 分层记忆仪表盘
/mem <query>               # search 的简写
/lesson <text>             # 保存非显而易见的经验到 events 表（v2.31.0）
/bug <text>                # 记录已知 bug + 复现步骤到 events 表（v2.31.0）
```

### 高效搜索工作流

```
1. mem_search(query="auth bug")     -> 紧凑的 ID 索引
2. mem_timeline(anchor=12345)       -> 周边上下文
3. mem_get(ids=[12345, 12346])      -> 完整详情
```

### Invited Memory（邀请式记忆，v2.32+）

Opt-in 机制——向项目 memdir（`~/.claude/projects/<encoded>/memory/MEMORY.md`）
注入单行 sentinel 包围的插件契约，Claude Code 会把它作为 **user-memory** 加载
到系统提示——比 MCP server instructions（被框定为 tool metadata）具有更高的
instruction-following 权威。

```bash
claude-mem-lite adopt              # 当前项目注入
claude-mem-lite adopt --all        # 扫描 ~/.claude/projects/* 全部注入
claude-mem-lite adopt --status     # 列出已 adopt / 已禁用项目 + 当前 gate 快照
claude-mem-lite adopt --dry-run    # 只打印不写入
claude-mem-lite adopt --disable    # 当前项目关闭 auto-adopt（写 .mem-no-auto-adopt 哨兵）
claude-mem-lite adopt --enable     # 当前项目重新启用 auto-adopt（删哨兵）
claude-mem-lite unadopt            # 精确移除 sentinel + 详情文档（runtime marker 保留以尊重显式撤销）
```

Slash 命令 `/adopt` 和 `/unadopt` 是上述 CLI 的包装。

**Adopt 后会发生什么：**
- `MEMORY.md` 新增一段 `<!-- claude-mem-lite:begin v1 -->…<!-- claude-mem-lite:end -->`
  包裹的 `## 插件契约`，含一行 ≤150 字符、指向 `mem_recall` / `mem_save` 关键参数
  的动作锚条目。
- 生成 `plugin_claude_mem_lite.md` 详情文件（按需读取，不自动加载）。
- 保守 hook 层自动瘦身：MCP server instructions 去掉 `WHEN TO USE` 段，
  SessionStart 注入去掉 `File Lessons` / `Key Context`。`#ID` 引用与 `Recent`
  表保留，`mem_get` 仍可随时展开。

**什么时候生效？**
- MEMORY.md sentinel 和 hook 层瘦身（`File Lessons` / `Key Context` / lesson
  后缀）**下一次 SessionStart** 生效（adopt 的项目下任一新会话）。
- MCP server instructions 是**服务启动时构建一次**，MCP 协议无 "push" 机制，
  所以 `WHEN TO USE` / `Decision rules` 两段的瘦身**只在 Claude Code 重启后**
  才生效（mem-lite MCP 服务被重新 spawn）。`/exit` 一次再开新会话即可。`unadopt`
  同理。

**安全性：**
- Hash 守护：你手动改了 sentinel 段 → 下一次 adopt 报 `UserEditedError`，
  除非显式 `--force`。
- 预算门：MEMORY.md 已 >180 行时拒绝新增（避开 Claude Code 200 行截断）。
- **任何安装路径每次 SessionStart 都自动 adopt（v2.82.1+；v3.13 起写入目标由
  memdir 改为 `<cwd>/CLAUDE.md`）。** 同步是幂等的——托管块被删会写回，出货模板
  变化会刷新（用 `CLAUDE_MEM_NO_TEMPLATE_REFRESH=1` 冻结）。项目级关闭：
  `claude-mem-lite adopt --disable`（写 `<memdir>/.mem-no-auto-adopt` 哨兵，
  存活于 marker 删除 / 插件重装）。全局关闭：`export MEM_NO_AUTO_ADOPT=1`。
  v2.82.1 前因 `CLAUDE_PLUGIN_ROOT` gate 与 `install.mjs` 写出的 hook 命令
  不匹配，auto-adopt 实质 5 周零触发——见 CHANGELOG v2.82.1。
- 保守 hook 层源码永不删——条件瘦身仅基于 sentinel 存在性做 runtime 判断，
  未 adopt 的项目仍看完整 verbose 输出。

完整设计见 `docs/plans/2026-04-16-invited-memory-pattern.md`（含其它插件
可复用的模板）。

## 数据库结构

五张核心表 + FTS5 虚拟表用于搜索：

**observations** -- 单条编码观察（决策、bug修复、功能等）
```
id, memory_session_id, project, type, title, subtitle,
text, narrative, concepts, facts, files_read, files_modified,
importance, related_ids, created_at, created_at_epoch
```

**session_summaries** -- LLM 生成的会话摘要
```
id, memory_session_id, project, request, investigated,
learned, completed, next_steps, files_read, files_edited, notes
```

**sdk_sessions** -- 会话追踪
```
id, content_session_id, memory_session_id, project,
started_at, completed_at, status, prompt_counter
```

**user_prompts** -- 通过 UserPromptSubmit 钩子捕获的用户提示
```
id, content_session_id, prompt_text, prompt_number
```

**session_handoffs** -- 跨会话交接快照（UPSERT，每个项目最多 2 行）
```
project, type, session_id, working_on, completed, unfinished,
key_files, key_decisions, match_keywords, created_at_epoch
```

FTS5 索引：`observations_fts`、`session_summaries_fts`、`user_prompts_fts`

## 工作原理

### Hook 管线

```
SessionStart
  -> 生成会话 ID（/clear 时保存交接快照）
  -> 标记过期会话（活跃 >24h）为 abandoned
  -> 清理孤儿/过期锁文件
  -> 查询最近观察（24 小时内）
  -> 注入上下文到 CLAUDE.md + 标准输出

PostToolUse（每次工具执行）
  -> Bash 预过滤器 ~5ms 跳过噪声（Read 路径追踪到 reads 文件）
  -> 检测 Bash 重要性（错误、测试、构建、git、部署）
  -> 累积到 episode 缓冲区
  -> 主动文件历史：为编辑的文件显示过往观察
  -> 刷新条件：缓冲区满（10 条） | 5 分钟间隔 | 上下文切换
  -> 刷新时收集 Read 文件路径到 episode
  -> 为有意义的 episode 启动 LLM episode worker
  -> 错误触发回忆：搜索记忆中相关的历史修复

PreToolUse（工具执行前）
  -> L2 Skill Bridge：拦截对 managed 资源的 Skill() 调用
     -> 匹配 managed 路径 → 输出内容 + mem_use() 提示
     -> 未匹配 → 静默放行到原生 handler

UserPromptSubmit（两个并行路径）
  -> [user-prompt-search.js] 通过 FTS5 + 活跃文件上下文自动搜索记忆
  -> [user-prompt-search.js] 注入相关历史观察（按时效和重要性加权）
  -> [user-prompt-search.js] L1 Skill 自动加载：匹配 prompt 中的 managed skill 名
     -> 加载内容 + 便携 ~ 路径 + Read() 调用指引
     -> source="managed-skill|managed-agent", path="~/.claude-mem-lite/managed/..."
  -> [hook.mjs] 捕获用户提示文本到 user_prompts 表
  -> [hook.mjs] 递增会话提示计数器
  -> [hook.mjs] 交接：检测继续意图 → 注入上一次会话上下文
  -> [hook.mjs] 语义记忆注入（hook-memory.mjs），通过临时文件去重

Stop
  -> 刷新最终 episode 缓冲区
  -> 保存交接快照（/exit 时）
  -> 标记会话为已完成
  -> 启动 LLM 摘要 worker（轮询等待）
```

### 智能调用系统

三层调用系统确保 managed 资源（`~/.claude-mem-lite/managed/` 中的 skill 和 agent）能被正确调用：

```
L1 自动加载（UserPromptSubmit，<50ms）
  -> 匹配 prompt 中的 managed skill/agent 名称
  -> 加载 SKILL.md / {name}.md 内容
  -> 输出：Read("~/.claude-mem-lite/managed/.../path.md") 调用指引
  -> 截断时提供 mem_use(name="...") 备选

L2 Bridge（PreToolUse Skill hook，<30ms）
  -> 拦截 Skill("name") 调用，查询 managed 注册表
  -> 匹配到 → 输出内容 + mem_use() 提示（防止原生 handler 报错）
  -> 未匹配 → 放行到原生 Skill handler

L3 显式调用（mem_use MCP 工具）
  -> 按名称精确匹配 + FTS5 模糊回退
  -> 返回完整内容 + 便携路径供 Read() 重载
```

**调用方式区分：**

| 资源类型 | 位置 | 调用方式 |
|---------|------|---------|
| Managed skill | `~/.claude-mem-lite/managed/skills/` | `Read("~/.../SKILL.md")` 或 `mem_use(name="...")` |
| Managed agent | `~/.claude-mem-lite/managed/agents/` | `Read("~/.../{name}.md")` 或 `mem_use(name="...", type="agent")` |
| 原生插件 skill | `~/.claude/plugins/cache/` | `Skill("plugin:skill-name")` |
| 用户自建 skill | `~/.claude/skills/` | `Skill("name")` |

### Episode 编码

Episode 是一批相关操作（对同一组文件的编辑），由后台 LLM worker 处理：

```
Episode 缓冲区 -> 刷新为 JSON -> claude -p --model haiku -> 结构化观察 -> SQLite
```

每条观察包含类型、标题、叙述、概念、事实和重要度（1-3），并通过两级机制自动去重：Jaccard 相似度（5 分钟内 >70%）和 MinHash 签名（7 天跨会话 >80%）。LLM 调用失败时，使用推断的元数据保存降级记录（零数据丢失）。相关观察通过 FTS5 标题相似度和文件重叠自动建立 `related_ids` 链接。

## 管理命令

```bash
# 插件安装：
/plugin install claude-mem-lite       # 安装 / 更新
/plugin uninstall claude-mem-lite     # 卸载

# git clone 安装：
node install.mjs install              # 安装并配置
node install.mjs uninstall            # 移除（保留数据）
node install.mjs uninstall --purge    # 移除并删除所有数据
node install.mjs status               # 显示当前状态
node install.mjs doctor               # 诊断问题
node install.mjs cleanup-hooks        # 只清理 settings.json 中残留的 claude-mem-lite hooks
node install.mjs update               # 强制检查并安装更新（direct install / npx 模式）

# npx 安装：
npx claude-mem-lite                   # 安装 / 重新安装
npx claude-mem-lite uninstall         # 移除（保留数据）
npx claude-mem-lite doctor            # 诊断问题
```

说明：
- 插件模式只提示可用更新，不会自更新插件文件。
- direct install / npx 模式保留自动更新，并使用 staged replacement；若依赖安装失败会回滚。
- 如果你禁用了插件，但 `~/.claude/settings.json` 里还有旧的 mem hooks，可运行 `node install.mjs cleanup-hooks`。

### doctor

检查 Node.js 版本、依赖、服务器/钩子文件、数据库完整性、FTS5 索引和残留进程。

### status

显示 MCP 注册状态、钩子配置、插件禁用状态和数据库统计（观察/会话数量）。

### 故障恢复（安装卡死 / hook 报错）

如果你看到 PreToolUse:Read/Edit/Skill hook 报 `ERR_MODULE_NOT_FOUND`，或者 `claude-mem-lite` 命令本身因为 import 错误崩溃，多半是被部分自动更新坑了——更新器复制了新脚本但漏了配套的 `lib/*` 文件，hook 链就此断掉（连下一次本可自愈的自动更新也跑不了）。

**v2.84.0+** 提供 `repair` 子命令，从 GitHub 最新 release 重新同步：

```bash
claude-mem-lite repair
```

**如果 `repair` 自己也跑不起来**（bin 比 v2.84.0 旧，或 bin 也坏了），用这条单行命令——它把最新 tarball 拉到临时目录、跑 *那份* tarball 里的 `install.mjs`，完全不依赖你磁盘上的任何文件：

```bash
T=$(mktemp -d) && curl -sL https://api.github.com/repos/sdsrss/claude-mem-lite/tarball | tar xz -C "$T" --strip-components=1 && node "$T/install.mjs" install
```

跑完之后，`~/.claude-mem-lite/` 就和最新 release 对齐，`claude-mem-lite repair` 下次再遇到类似问题也能直接用了。

## 卸载

```bash
# 插件：
/plugin uninstall claude-mem-lite

# git clone：
cd claude-mem-lite
node install.mjs uninstall            # 保留 ~/.claude-mem-lite/ 数据
node install.mjs uninstall --purge    # 删除 ~/.claude-mem-lite/ 及所有数据

# npx：
npx claude-mem-lite uninstall
npx claude-mem-lite uninstall --purge
```

数据默认保留在 `~/.claude-mem-lite/` 中。如需删除：
```bash
rm -rf ~/.claude-mem-lite/
```

### 混装残留（用过多种安装方式的话务必看一下）

`/plugin uninstall` 只删 plugin manifest，**不会动 `~/.claude/settings.json`**。如果你曾经跑过 `claude-mem-lite install`（npx 或 git-clone 路径），指向 `~/.claude-mem-lite/hook.mjs` 的 hook 条目就被写进了你的 user-global settings；`/plugin uninstall` 之后它们还在每会话触发。如果 `~/.claude-mem-lite/hook.mjs` 还在 → 与 plugin 双触发；如果你又 `rm -rf ~/.claude-mem-lite/` → 每次会话报错。

**正确顺序**：先 `claude-mem-lite uninstall`（清 settings.json 的 hook + 全局 MCP 注册），再 `/plugin uninstall claude-mem-lite`，最后可选 `rm -rf ~/.claude-mem-lite/`。

顺序搞错了的话，`claude-mem-lite doctor` 会在 `Orphan hooks:` 一节标出残留并给清理命令。

## 项目结构

```
claude-mem-lite/
  .claude-plugin/
    plugin.json      # 插件清单
    marketplace.json # 市场目录
  .mcp.json          # MCP 服务器定义（插件根目录）
  hooks/
    hooks.json       # 钩子定义（插件模式）
  commands/
    mem.md           # /mem 命令定义
  server.mjs           # MCP 服务器：工具定义、FTS5 搜索、数据库初始化
  search-scoring.mjs # 搜索辅助模块：重排序、PRF、概念扩展
  hook.mjs             # Claude Code 钩子：episode 捕获、错误回忆、会话管理
  hook-llm.mjs         # 后台 LLM worker：episode 提取、会话摘要
  hook-shared.mjs      # 共享钩子基础设施：会话管理、数据库访问、LLM 调用
  hook-handoff.mjs     # 跨会话交接：状态提取、意图检测、上下文注入
  hook-context.mjs     # CLAUDE.md 上下文注入与 token 预算
  hook-episode.mjs     # Episode 缓冲区管理：原子写入、待处理条目合并
  hook-semaphore.mjs   # LLM 并发控制：基于文件的信号量
  schema.mjs           # 数据库 schema：表、迁移、FTS5 的单一事实来源
  tool-schemas.mjs     # 共享 Zod schema，用于 MCP 工具校验
  utils.mjs            # 重导出中心：所有工具模块的向后兼容入口
  nlp.mjs              # FTS5 查询构建：同义词扩展、CJK 二元组、查询清洗
  scoring-sql.mjs      # BM25 权重常量和类型差异化衰减半衰期
  stop-words.mjs       # 共享基础停用词集
  synonyms.mjs         # 统一同义词源：SYNONYM_MAP（双向）+ DISPATCH_SYNONYMS
  project-utils.mjs    # 共享项目名解析（含进程内缓存）
  secret-scrub.mjs     # API 密钥、令牌、PEM 证书等凭据模式擦除
  format-utils.mjs     # 字符串格式化：截断、类型图标、日期/时间格式化
  hash-utils.mjs       # MinHash 签名、Jaccard 相似度（去重用）
  bash-utils.mjs       # Bash 输出显著性检测：错误、测试、构建、部署
  # 智能调度
  dispatch.mjs         # 三级调度编排：快速过滤、上下文信号、FTS5、Haiku
  dispatch-inject.mjs  # 注入模板渲染：skill/agent 推荐
  registry.mjs         # 资源注册表 DB：schema、CRUD、FTS5、调用追踪
  registry-retriever.mjs # FTS5 检索：同义词扩展与复合评分
  registry-scanner.mjs # 文件系统扫描器：读取内容 + 哈希，委托发现层
  resource-discovery.mjs # 共享发现层：扁平目录、插件嵌套、松散 .md 文件
  haiku-client.mjs     # 统一 Haiku LLM 封装：直连 API 或 CLI 回退
  # 安装与配置
  install.mjs          # CLI 安装器：设置、卸载、状态、诊断（npx/git clone 模式）
  skill.md             # MCP 技能定义（npx/git clone 模式）
  package.json         # 依赖和元数据
  scripts/
    setup.sh           # Setup 钩子：npm install + 迁移（隐藏目录 + 旧目录）
    post-tool-use.sh   # Bash 预过滤器：~5ms 跳过噪声，追踪 Read 路径
    user-prompt-search.js # UserPromptSubmit 钩子：自动搜索记忆 + L1 skill 自动加载
    pre-skill-bridge.js  # PreToolUse 钩子：L2 managed skill 桥接
    pre-tool-recall.js   # PreToolUse 钩子：Edit/Write 前文件教训回忆
    prompt-search-utils.mjs # 共享逻辑：跳过模式、意图检测、名称匹配
    convert-commands.mjs # 将 command .md 转换为托管插件中的 SKILL.md
    index-managed.mjs  # 托管资源离线索引器
  # 测试和基准（仅开发）
  tests/               # 单元、属性、集成、契约、E2E、管线测试
  benchmark/           # BM25 搜索质量基准 + CI 门控
```

## 搜索质量

基于 200 条观察和 30 个查询（标准 + 困难负样本类别）的基准测试结果，测量的是
**production-hybrid** 检索路径（FTS5 BM25 + TF-IDF 向量 + RRF）——也就是 `mem_search` /
`recall` 实际走的那条路径：

| 指标 | 得分（production-hybrid） |
|------|------|
| Recall@10 | 0.90 |
| Precision@10 | 0.85 |
| nDCG@10 | 0.97 |
| MRR@10 | 0.96 |
| P95 搜索延迟 | ~1.8ms |

> **数据来源。** 复现命令：`node benchmark/benchmark.mjs --production-hybrid`（确定性输出——
> 固定语料、固定查询集、无采样）。CI 参考快照是 `benchmark/baseline.json`，
> `npm run benchmark:gate` 在偏离超过 5% 时让构建失败。本 README 中所有检索指标都以此为唯一来源。

> **关于测量路径。** 本表早期版本报告的是 *lexical* 纯 FTS 路径（Precision@10 0.96、
> P95 0.15ms）。混合向量臂用 precision@10 换取更高的 recall / nDCG / MRR——它会召回超出字面
> 匹配的语义相关候选；门控现在测量混合路径，所以这些数字反映的是 `mem_search` 的真实行为。

## 开发

```bash
npm run lint              # ESLint 静态分析
npm test                  # 运行完整测试套件（vitest）
npm run test:smoke        # 运行 5 个核心冒烟测试
npm run test:coverage     # 运行测试并生成 V8 覆盖率（≥75% 行/函数，≥65% 分支）
npm run benchmark         # 运行完整搜索质量基准测试
npm run benchmark:gate    # CI 门控：指标回退超过 5% 容差时失败
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CLAUDE_MEM_DIR` | 自定义数据目录。所有数据库、运行时文件和托管资源均存储在此。 | `~/.claude-mem-lite/` |
| `CLAUDE_MEM_MODEL` | 后台 LLM 调用模型（Episode 提取、会话总结、调度）。可选 `haiku` 或 `sonnet`。 | `haiku` |
| `ANTHROPIC_API_KEY` | Anthropic API key。设置后所有后台 LLM 调用直连 Anthropic Messages API（带 prompt caching），优先级最高。 | _(未设 → CLI)_ |
| `OPENROUTER_API_KEY` | OpenRouter API key（OpenAI 兼容）。当**未设** `ANTHROPIC_API_KEY` 时用于后台 LLM 调用；两者都未设则回退到 `claude -p` CLI。 | _(未设)_ |
| `OPENROUTER_MODEL` | 覆盖**所有**后台调用的 OpenRouter 模型 slug（如 `openai/gpt-4o-mini`、`qwen/qwen-2.5-72b-instruct`）。未设时按 `CLAUDE_MEM_MODEL` 分层映射到 `anthropic/claude-haiku-4.5`（haiku）或 `anthropic/claude-sonnet-4.5`（sonnet）。 | _(分层默认)_ |
| `CLAUDE_MEM_DEBUG` | 启用调试日志（设为 `1` 启用）。 | _(禁用)_ |
| `MEM_QUIET_HOOKS` | 低噪声 hook。设为 `1` 时，SessionStart 注入去掉 `File Lessons` / `Key Context` 两节，`[mem] Related memories` 去掉 lesson 后缀，MCP server instructions 去掉 `WHEN TO USE` / `Decision rules` 两段。ID 与 `Recent` 表仍保留，`mem_get(ids=[…])` 可继续展开细节。适用于启用了 invited-memory adopt 流程或偏好最小化自动注入的用户。**v2.82.0 起此 env 不再阻挡 auto-adopt——如需关闭 auto-adopt 用 `MEM_NO_AUTO_ADOPT=1`。** | _(禁用)_ |
| `MEM_NO_AUTO_ADOPT` | auto-adopt 全局关闭开关（v2.82.0+）。设为 `1` 阻止每次 SessionStart 在**所有**项目自动写入 `CLAUDE.md` 托管块。项目级关闭走 `claude-mem-lite adopt --disable`（写 `<memdir>/.mem-no-auto-adopt` 哨兵，存活于 marker 删除）。 | _(禁用)_ |
| `MEM_NO_ADOPT_HINT` | 静音当前项目未 adopt 时 SessionStart 追加的那一行 "Invited-memory 未启用…" 提示。v2.82.1 起任何安装路径每次 SessionStart 都自动 adopt，所以该提示一般只在你显式 opt out（`MEM_NO_AUTO_ADOPT=1` 或 `claude-mem-lite adopt --disable`）的项目才会出现。 | _(禁用)_ |

## 许可证

MIT
