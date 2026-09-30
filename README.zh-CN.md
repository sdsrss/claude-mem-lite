[English](README.md) | [中文](README.zh-CN.md)

# claude-mem-lite

`claude-mem-lite` 是 **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)**（Anthropic 官方 CLI 编程代理）的 **持久化记忆系统**（也称 **长期记忆 / 跨会话上下文 / Claude Code 记忆插件**）。它以 **[MCP](https://modelcontextprotocol.io/) 服务器** + Claude Code 钩子（hooks）的形式运行，在编码会话中自动捕获观察记录、决策、bug 修复，并通过 FTS5 全文检索（BM25 + 查询扩展）召回历史上下文。

与 [`mem0`](https://github.com/mem0ai/mem0)、MCP 官方参考实现的 [`memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) 服务器等通用 LLM 记忆框架相比，claude-mem-lite 专为 Claude Code 的钩子生命周期定制：episode 批处理把 LLM 调用量相比原版 [claude-mem](https://github.com/thedotmack/claude-mem) 减少 7-10 倍（综合成本估算下降约 600 倍 —— 见下方成本模型，属架构估算而非实测基准）；FTS5 检索在 30 个查询的基准上达到 **Recall@10 = 0.90 / Precision@10 = 0.85**（复现命令见[搜索质量](#搜索质量)一节）。

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

- **自动捕获** -- 挂载到 Claude Code 生命周期（`hooks/hooks.json` 里的七个事件：SessionStart、PreCompact、PreToolUse、PostToolUse、PostToolUseFailure、Stop、UserPromptSubmit），无需手动操作即可记录观察
- **FTS5 搜索** -- 基于 BM25 排名的全文搜索，覆盖观察、会话摘要和用户提示，支持重要度加权
- **时间线浏览** -- 基于锚点的时间上下文窗口，按时间顺序浏览观察
- **Episode 批处理** -- 将相关文件操作分组为连贯的 episode，再进行 LLM 编码
- **错误触发回忆** -- Bash 出错时自动搜索记忆，浮现相关的历史修复方案
- **主动文件历史** -- 编辑文件时，自动显示该文件相关的历史观察记录
- **会话摘要** -- 每次 Stop 时写入（助手最终回复带 Done / Not done 段落时取其内容，否则——最终回复里没有任何报告段落时——取其前 120 个字符，再否则取首条提示和最近的 observation 标题），会话有 observation 时再由后台模型摘要升级
- **项目作用域上下文** -- 将最近的记忆注入 `CLAUDE.md` 和会话启动上下文
- **观察类型** -- 分类为 `decision`、`bugfix`、`feature`、`refactor`、`discovery` 或 `change`
- **重要度分级** -- LLM 为每条观察分配 1-3 级重要度（日常/关注/关键）
- **观察关联** -- 基于文件重叠自动建立观察之间的双向链接
- **用户提示捕获** -- 通过 UserPromptSubmit 钩子记录用户提示，追踪用户意图
- **Read 文件追踪** -- 追踪会话中读取的文件，丰富 episode 上下文
- **LLM 失败时的降级保存** -- 规则已判定为有价值的 episode（修掉了报错、改了配置或 schema 文件）用推断的元数据保存，而非丢弃；规则判为噪声的日常编辑（`Modified a.js, b.js` 且没有 lesson）会被丢掉——模型成功但没给 lesson 时也一样——所以 LLM 不可用期间这类 episode 会丢失。`claude-mem-lite doctor` 会在要调用的 `claude` CLI 不存在时告警
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
- **领域同义词扩展** -- 搜索查询自动扩展领域同义词（如 "修复" → fix, debug, bugfix, repair, error）
- **多 provider LLM 调用** -- provider 优先级 `ANTHROPIC_API_KEY`（直连 Anthropic API）→ `OPENROUTER_API_KEY`（OpenRouter，OpenAI 兼容，可用 `OPENROUTER_MODEL` 指向任意模型）→ 无 key 时回退 `claude -p` CLI
- **Haiku 熔断器** -- 连续 3 次 LLM 失败后，禁用 Haiku 调度 5 分钟，防止级联延迟
- **否定意图感知** -- 正确处理 "不要测试了，先修 bug" 等复杂提示，排除被否定的意图，支持中英文混合输入
- **可配置 LLM 模型** -- 通过 `CLAUDE_MEM_MODEL` 环境变量在 Haiku（快速/低成本）和 Sonnet（深度分析）之间切换
- **数据库自动恢复** -- 启动时检测并清理损坏的 WAL/SHM 文件；定期 WAL checkpoint 防止无限增长
- **Schema 自动迁移** -- 每次启动运行幂等的 `ALTER TABLE` 迁移，安全地添加新列和索引，不丢失数据
- **LLM 并发控制** -- 基于文件的信号量将后台 worker 限制为 2 个并发 LLM 调用，防止资源争用
- **stdin 溢出保护** -- Hook 输入在 256KB 处截断，对超大工具输出使用正则挽救关键信息
- **跨会话交接** -- 在 `/clear` 或 `/exit` 时捕获会话状态（请求、已完成工作、后续步骤、关键文件），下次会话检测到继续意图时自动注入上下文（支持显式关键词和 FTS5 术语重叠匹配）
  <br>**v6.10.0 变更**：注入块从 2 段变为 6 段。此前它的观测查询按钩子铸造的会话 id 过滤，而每一次 `mem_save` 写的是 `manual-<project>` id，两个命名空间不相交，所以 `completed` 与 `key_decisions` 根本够不到已保存的经验——库里 17 行交接记录这两个字段全是 0 字节。现在还会带 `## Tree state`（分支、短 sha、未提交文件数）和 `## Next steps`（读取项目里最新且未超过 7 天的 `tasks/<slug>-paused.md`）。`session_handoffs` 新增 4 个可空列；schema 版本号**刻意不动**，所以旧版本仍能打开数据库（已实测：v6.9.1 的代码能读写本版本迁移过的库）。回退方式：固定到 `claude-mem-lite@6.9.1`，无需处理数据目录。
- **插件缓存 hook 自愈** -- Claude Code runtime 从 `~/.claude/plugins/cache/<mp>/<plugin>/<ver>/hooks/hooks.json` 读取插件 hook，而非 marketplace 源。当 `install.mjs` 写入 `settings.json` 的 hooks 与残留 cache `hooks.json` 同时存在（例如曾装过 marketplace 版本，或插件被 Claude Code 自动升级重建 cache），runtime 会注册两套 hook → 每次 SessionStart / UserPromptSubmit 都触发两份。`install.mjs` 和 `hook-update.mjs` 现在会清理每个 cache 版本目录下的 `hooks.json`；`hook.mjs session-start` 每次启动自愈（通过 `hasInstallManagedHooks` 门控，不影响纯插件模式用户）；`install.mjs status` 会报告 cache 污染状况（自 v2.31.1 / v2.31.2 起）。
- **Git-SHA 延续锚点**（v2.31.0）-- handoff 记录包含 `git_sha_at_handoff` 字段，任何匹配当前 `HEAD` 的 handoff 都视为延续会话，不受 TTL 限制。代码状态比时钟时间更能反映上下文延续。
- **启动面板**（v2.31.0）-- SessionStart hook 将 `git status` + `~/.claude/tasks/*.json` + `~/.claude/plans/*.md` + 最近 /exit 交接 + 最近事件数聚合为一个结构化块，通过 `hookSpecificOutput.additionalContext` 注入。
- **活动命名空间**（v2.31.0）-- 为非 memdir 类型（`bugfix` / `lesson` / `bug` / `discovery` / `refactor` / `feature` / `observation` / `decision`）启用独立的 `events` 表 + FTS5，与 observations 表的 `WHAT_NOT_TO_SAVE` 语义解耦。CLI：`claude-mem-lite activity save|search|recent|show`。`hook-llm` 通过 `persistHaikuSummary` 路由非 memdir 摘要，observations → events 升级路径是事务原子的。（v3.39：`/lesson`、`/bug` 斜杠命令已从此 events 表重定向到可搜索的 **observations**——`mem_search` 从不读 events 表，显式保存因此搜不到；events 表仍作自动捕获活动日志。）

## 平台支持

| 平台 | 状态 | 说明 |
|------|------|------|
| **Linux** | 支持 | 主要开发和测试平台；整个 CI 矩阵都跑在这里 |
| **macOS** | 支持 | 完全兼容（Intel 和 Apple Silicon） |
| **Windows** | 可安装，但无 CI 覆盖 | MCP server、CLI 和 `node` 类 hook 均可用（`better-sqlite3` 自带 `win32-x64` / `win32-arm64` 预编译产物，无需编译）。**有四个 hook 命令走 `bash`** —— `setup.sh`、`post-tool-use.sh`、`pre-agent-inject.sh`、`pre-tool-recall-bash.sh` —— 需要 PATH 上有 Git for Windows 或 WSL；`bash` 找不到时 `claude-mem-lite doctor` 会报出来。GitHub Actions 没有 Windows runner，所以这一行依据的是用户报告（[#28](https://github.com/sdsrss/claude-mem-lite/issues/28)）而不是绿色流水线 |
| **WSL2** | 未测试 | 底层就是 Linux，预期与 Linux 行一致；但无人报告过实际结果 |

v5.1.0 到 v6.1.0 之间，`package.json` 声明的是 `os: ["darwin", "linux"]`。那是 npm 的**安装**门禁，不是运行时检查：
在 Windows 上它让 `npm install` 以 `EBADPLATFORM` 退出，而插件启动器每次插件更新后的首次 MCP 启动都要跑这条
安装 —— 于是 server 起不来，`/mcp` 报 `CONNECTION_CLOSED`。现在 `win32` 已加入该列表。仍不在列表内的平台会拿到
一条同时点明“声明了什么”和“当前是什么”的消息，而不是一句猜测。

## 环境要求

- **Node.js** >= 22（v4.0.0 起：better-sqlite3 13 要求 >=22，Node 20 已于 2026-04 EOL；`package.json` 的 `engines` 是唯一事实来源）
- **Claude Code** CLI 已安装并配置（`claude` 命令可用）
- **SQLite3** 支持（由 `better-sqlite3` 13 提供，它自带 8 个平台的预编译产物，这些平台上都不需要编译器；没有对应预编译产物的平台才会回退到源码编译）
- **平台**：Linux 或 macOS；Windows 可安装运行，但无 CI 覆盖，且四个 hook 需要 Git Bash 或 WSL（参见[平台支持](#平台支持)）

## 安装

### 方式一：插件市场（推荐）

```bash
/plugin marketplace add sdsrss/claude-mem-lite
/plugin install claude-mem-lite
```

插件模式会管理自己的运行时与钩子。SessionStart 时它现在只会**检查并提示**新版本，不会直接覆盖插件目录中的文件。插件模式请通过 Claude 的插件更新流程完成升级。

> **插件安装本身即完整** —— hooks、MCP 工具、以及捆绑的 slash 命令（`/mem`、`/lesson`、`/bug`、`/adopt`）全部从插件内运行，无需第二步。slash 命令以从插件目录解析出的绝对路径调用捆绑 CLI（`node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" <cmd>`），因此不依赖 `PATH` 上的任何东西。全局 `claude-mem-lite` **shell** 命令（用于你自己在终端里跑查询）是**可选**的 —— `npm i -g claude-mem-lite` —— 且是**独立**的 npm 安装：插件的自动更新**不会**刷新它，想保持同步就重新跑 `npm i -g claude-mem-lite@latest`。插件要完整工作**并不需要**它。

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
2. **注册 MCP 服务器** -- `mem-lite` 服务器定义 19 个工具（10 个核心 + 9 个隐藏但可调；`mem_search_feedback` 仅在启用搜索遥测时注册）。v2.78 前服务器名为通用的 `mem`，现已改名为 `mem-lite` 避免与用户其它 `.mcp.json` 冲突；工具名（`mem_search`/`mem_recall` 等）保持不变。

> **自动 adopt 不再把托管块加进你项目的 `CLAUDE.md`（6.19.4 之后的下一个版本起）。** 每次 SessionStart，插件都会送达引导文本（提升 Claude 主动调用 `mem_recall` / `mem_save` 的触发表）。在还没有托管块的 git 仓库里，它把托管块写进仓库根目录的 `CLAUDE.local.md`（Claude Code 像加载 `CLAUDE.md` 一样加载它，子代理也能看到），并把这个文件加进仓库的 `.git/info/exclude`（你的 ignore 规则已覆盖时不加），所以 git 不列出、也不提交它；第一次写入时你会看到一条**一次性提示**。Claude Code 在插件的启动钩子运行之前就读取了指令文件，所以创建这个文件的那个会话改为在上下文里注入一次引导（该会话的子代理看不到）。不在 git 仓库里、仓库根是 `$HOME`、`CLAUDE.local.md` 已被 git 跟踪或是符号链接，或者仓库根是一个 `npm publish` 会把它带上的 npm 包（没有 `"private": true`，没有把它排除在外的 `files` 列表，没有 `files` 列表时也没有列出它的 `.npmignore`）时，什么都不写，改为每个会话把引导**注入**上下文，并一次性提示可以运行 `/adopt`（在 `$HOME` 下不提示）。托管块指向的详情文件放在插件自己的数据目录，以 `~/` 路径书写。`.git/info/exclude` 只对 git 生效：docker 构建上下文、归档和其他打包工具都可能把 `CLAUDE.local.md` 打进去（可发布的 npm 包根目录不会保留这个文件：目录变成 npm 包之前写入的托管块，会在下一次会话启动时移除）。旧版本会在你打开的每个项目里，未经询问就向项目自己的 `<cwd>/CLAUDE.md`（通常会进 git）写入托管块，外加 `<cwd>/.claude/plugin_claude_mem_lite.md` 详情文件；这些项目保留托管块，本版本的第一个会话会因为文本变化刷新它——想把某个项目迁到本地文件，在那里运行 `claude-mem-lite unadopt` 并提交这次删除。为什么不全部改成注入：沙箱实测中（一个项目，Claude Opus 5.5），8 个会话里模型主动记录的次数，注入时平均 1.5 次，写在 `CLAUDE.local.md` 或 `CLAUDE.md` 时 5.25 次；而且子代理完全看不到注入的文本。**任何安装路径都生效**（npm、npx、`/plugin`、手动）；两条提示都可以用 `MEM_NO_ADOPT_HINT=1` 关闭。
>
> **想把托管块改写进 `CLAUDE.md`**（例如与团队共享）？运行 `claude-mem-lite adopt`：它向 `<cwd>/CLAUDE.md` 写入 slug 限定的托管块和详情文件，块以外的内容逐字保留，并删除 `CLAUDE.local.md` 里的那份。带托管块的项目在**每次 SessionStart** 都会同步，出货模板变了会刷新，且不会再叠加本地副本或注入，从子目录启动的会话也一样。插件创建过、又被你删掉（或被 `claude-mem-lite unadopt` 删掉）的 `CLAUDE.local.md` 托管块不会被写回，改为注入，直到运行 `claude-mem-lite adopt --enable`。关闭方式：项目级 `claude-mem-lite adopt --disable`（同时删除 `CLAUDE.local.md` 托管块；`CLAUDE.md` 托管块保留到 `unadopt`；重新启用用 `--enable`）；全局 `export MEM_NO_AUTO_ADOPT=1`（已写入的托管块保留并继续加载，直到 `unadopt`）；只冻结模板刷新用 `CLAUDE_MEM_NO_TEMPLATE_REFRESH=1`。`claude-mem-lite unadopt` 会移除 `CLAUDE.md` 托管块、详情文件，以及 `CLAUDE.local.md` 托管块和它的 exclude 条目。
3. **配置钩子** -- 全部七个生命周期事件：`SessionStart`、`PreCompact`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`Stop`、`UserPromptSubmit`
4. **创建数据目录** -- `~/.claude-mem-lite/`（隐藏目录），存放数据库与运行时文件
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
  runtime/
    session-<project>    # 活跃会话状态
    ep-<project>.json    # Episode 缓冲区
    ep-flush-*.json      # 已刷新的 episode，等待处理
    reads-<project>.txt  # Read 文件路径（刷新时收集）
  managed/
    repos/               # 浅克隆的源代码仓库
```

## 升级到 6.21.0

**名字不是纯 ASCII 的项目会换一个新标识，它们存下的内容会搬一次。** 没有 schema 版本变更：
本版本打开过的数据库，6.20.0 仍能打开。想避免搬迁，请在**升级之前**固定 `claude-mem-lite@6.20.0`；
升级之后再回退，6.20.0 会按旧标识称呼这些目录，搬走的行只能用 `--project <新标识>` 列出。

- **哪些项目。** 以前 ASCII 字母、数字和 `_.-` 以外的字符都变成 `-`，所以 `~/projects/博客` 和
  `~/projects/商城` 都是 `projects----`，共用一份记忆。现在任何文字的字母、组合符和数字都会保留
  （`projects--博客`）。父目录名和目录名都是纯 ASCII 的，标识逐字节不变；名字里有其他文字的字母、
  组合符或数字，或有基本多文种平面以外的字符（如 `🚀`）时，标识会变。
- **项目第一次启动会话时搬迁数据。** 如果旧标识下没有任何文件路径显示另一个同样使用该旧标识的目录，
  就把旧标识下的全部内容搬过来，包括待办和会话历史。否则只搬文件路径落在本目录里的记忆，其余留在
  旧标识下。会提示一次搬了什么，以及怎么列出留下的内容（`claude-mem-lite recent 50 --project <旧标识>`）。
- **本版本不包含：** 不同仓库里父目录和目录名都相同的目录（`~/a/packages/api` 与 `~/b/packages/api`）
  仍共用一个标识。
- **其他变化：** 同一项目同时开两个会话，各自的交接、摘要和未保存的工具记录不再混在一起；会话里的
  跟进提示不再续上别的会话；维护会先把闲置记忆隐藏 7 天，再排队删除，所有项目一致；你设置的 importance
  不再被读取、访问提升或 re-enrich 改动；`recall` / `mem_recall` 当前项目和完全匹配的路径排在前面
  （`--project` / `project` 只看一个项目）；`<private>` 在未闭合、嵌套或带属性时一律按私密处理。
  完整列表见 CHANGELOG.md。

## 升级到 6.19.0

**搜索输出有变化，没有开关。** 没有 schema 变更、不需要迁移，回退只需固定 `claude-mem-lite@6.18.0`。

- **`search` / `mem_search` 用 `🤖` 标出机器写入的 observation**，`get` / `mem_get` 在标题行注明。
  hook 采集、导入和压缩生成的行带这个标记；显式保存的和 events 不带。只要显示的行里有带标记的，
  结果行就会解释它的含义；`search --json` 的 observation 行多一个 `auto` 字段。
- **`mem_search` 只在摘录比标题多出信息时才显示摘录行。**
- 修复：新的按项目存储里，单条搜索命中不再排在最后；Bash 步骤存下的描述会保留输出的结尾；
  密钥擦除器能识别 markdown 标签后面的值，并且在构造输入下保持线性时间。

## 升级到 6.18.0

**一处默认行为改变，有开关。** 没有 schema 变更、不需要迁移。固定 `claude-mem-lite@6.17.1`
后不再写新的这一行；已经写入的那一行会保留到该会话下一次有 observation 标题时被替换，6.17.1
会把它不认识的标签当作普通文本留在该行的 `notes` 里。

- **没有报告时，Last Session 也能说明上次会话是怎么结束的。** 最终回复里没有 Done / Not done /
  Failed / Uncertain 段落时，`Completed:` 取该回复的前 120 个字符（去掉代码块和行首标记），原先这里
  是 observation 标题，而它通常是空的；/clear 交接里标为 `<session-summary source="last-reply">`。
  有报告或模型摘要时仍以它们为准。之后不足 400 字符的回复（如“不客气！”）不会替换之前那一条。
  设 `CLAUDE_MEM_SUMMARY_TAIL=0` 恢复为 observation 标题，进行中的会话从下一轮起生效。
  回复里只要被密钥擦除器检出任何内容，就不写这一行。

## 升级到 6.17.0

**两处默认行为改变，其中一处有开关。** 没有 schema 变更、不需要迁移，全部回退只需固定
`claude-mem-lite@6.16.0`。

- **编辑前的 lesson 提示只在某条 lesson 改变了这次改动时，才请模型提一次它的 `#NN`。** 不再要求在
  下一条回复里对每条 lesson 逐一表态“采纳 / 不适用”——那会让回复里出现成串的 lesson 编号。恢复旧提示：
  `CLAUDE_MEM_SALIENCE=verdict`（6.17.1 起它会注明自己优先于托管行和详细文档，那两处保持新写法）。
  已接入的项目会在下次 SessionStart 时把 CLAUDE.md 托管行和详细文档换成对应的新写法；想保留旧文本设 `CLAUDE_MEM_NO_TEMPLATE_REFRESH=1`。
- **SessionStart 的 "Deferred Work" 列表（5 行）在还有更多未完成事项时，末尾加一行 "+N more open"。**
  没有开关，回退请固定 6.16.0。

## 升级到 6.16.0

**三处默认行为改变，其中一处有开关。** 没有 schema 变更、不需要迁移，全部回退只需固定
`claude-mem-lite@6.15.0`。

- **文件召回块的第一行，每个会话分到两种写法之一。** 一半会话保留原来的 "system-injected context,
  continue your planned action"，另一半改成说明这些笔记来自哪里的事实陈述（Claude Code 的 hooks
  指南建议这样写）。两种写法先比较引用率，再决定默认用哪个。关闭（全部用旧写法）：
  `CLAUDE_MEM_RECALL_FRAMING=legacy`。
- **超过宿主 1 万字符 hook 上限的记忆文本会按整行裁剪**，末尾一行列出被略去的 id；以前宿主会把它换成
  2,000 字符的预览。没有开关，回退请固定 6.15.0。
- **Bash 命令失败后展示的教训，现在也计入引用衰减**，和其他注入面一致：一直没被引用的会逐渐排到后面。
  没有开关，回退请固定 6.15.0。

## 升级到 6.15.0

**两处默认行为改变，其中一处有开关。** 没有 schema 变更、不需要迁移，全部回退只需固定
`claude-mem-lite@6.14.0`。

- **自动捕获的教训如果复述了工具打印的文字，不再自动注入。** 否则能控制命令输出的一方（仓库里的测试、
  抓取的网页、MCP 服务）就能让自己写的一句话被存成教训，之后的会话都会看到。这样的 event 仍可搜索，
  importance 降为 1；`change` 类 observation 则去掉教训。连续 4 个词相同就算，虚词也算，所以偶尔也会
  误降你自己的教训。关闭：`CLAUDE_MEM_LESSON_OUTPUT_CAP=off`。
- **Last Session 能读到你用 markdown 标题写的 Done / Not done 报告**（`## Done`、`**Not done**`），
  不再退回模型写的摘要。没有开关，回退请固定 6.14.0。

## 升级到 6.14.0

**五个默认行为变化，其中三个有关闭开关。** 没有 schema 变更、没有迁移：旧版本仍能打开数据库，
全部回退就是固定到 `claude-mem-lite@6.13.6`。

- **查看或写入文件的 Bash 命令执行前，也会做文件召回**（`cat`、`sed -n`、`head`；`sed -i`、
  `cat > f`、python 补丁）。新模型的读写大多走 Bash，实测引用率最高的召回面几乎不再触发。
  **第四个 hook 命令走 `bash`**：`pre-tool-recall-bash.sh`；在 Windows 上与另外三个一样需要
  Git Bash 或 WSL。关闭：`CLAUDE_MEM_BASH_RECALL=off`。
- **error recall 不再回应你故意制造的失败**（刚写好或刚改过的测试文件跑红），也不回应只打印数据、
  退出码为 0 的命令。没有开关，回退请固定 6.13.6。从这个版本起 `citation-stats` 里的
  `error_recall` 计数会下降，不要跨版本直接比较。
- **自动捕获的教训必须引用原文。** episode 摘要器忽略变异测试探针、agent 自己失败的内联脚本，以及
  不修改项目的子代理调用；不引用窗口内任何原文的教训会被丢弃（event 保留，importance 降为 1）。
  关闭：`CLAUDE_MEM_EPISODE_INPUT_FILTER=off` / `CLAUDE_MEM_LESSON_GROUNDING=off`。
- **不再注入 `[mem] episode flushed: N entries` 这一行。** 它后面的提示不变。

## 升级到 6.13.0

**只有一个默认行为变化：SessionStart 不再注入 `### Key Events`。** 这一节在每个会话开头列出
`events` 表里最新的 5 条 importance ≥ 2 的记录（后台摘要器记下的活动），按时间挑选，与你当前在做
什么无关。对照 git 历史和会话记录核验其中 30 条：2 条属实、16 条错误。event 仍然会存储、可以用 `mem_search` 检索，当你的提问或正在编辑的文件与之匹配时
仍会注入。想恢复这一节，设置 `CLAUDE_MEM_SESSION_EVENTS=1`。没有 schema 变更、没有迁移：旧版本
仍能打开数据库，回退就是固定到 `claude-mem-lite@6.12.2`。

**引用率读数会从这个版本起下降，这是口径变化。** agent 用 `#NN n/a` 回应的 lesson 不再计为引用，
所以 `citation-stats` 各注入面的引用率从此偏低（`--sidechain` 除外：它把 `n/a` 算作已回应）。不要拿 6.13.0 之前和之后的读数直接比较。

## 升级到 6.11.0

**只有一个默认行为变化：re-enrich 不再让一部分预算空着。** 它为两个回填任务预留每次运行一半的
预算，其余给主范围。以前主范围待处理的行数少于它那一份时，剩下的额度就空着不用；现在转给回填
任务。每日后台任务是**每台机器每天一次、对所有项目合并运行**，所以主池为空时，它现在每天最多
做 6 次这类 LLM 调用，而以前是 3 次。上限 6 没变——这一直是声明的预算；另有一个单独计预算的
「范围分类」任务，本版未改动，最多还会再加 6 次简短调用。手动运行 `claude-mem-lite optimize --run`
或 `mem_optimize` 行为相同。没有 schema 变更、没有迁移：旧版本仍能打开数据库，回退就是固定到
`claude-mem-lite@6.10.3`。

**有一个安全修复不会作用于你已有的数据。** 同一行里两个带标签的凭据，在某些组合下——例如
`token: <v> secret: <v>`，且第一个值以字母结尾——以前的版本会脱敏第一个、把第二个按原样存下来。
分行写的值从未受影响。本版本修的是写入路径；数据库里已有的内容不会被改写。

<!-- normalize-per-project-note:start -->
## 升级到 6.8.0

**升级后有两处变化，都不需要你做什么，也都不是 schema 变更——旧版本仍能打开这个数据库。**

*第一次开库会做一次性回填。* 6.7.2 之前从 transcript 导入的观察，带着「修改过的文件」列表，
却没有在文件召回所 JOIN 的联结表里留下行，所以按文件去问永远找不到它们。原来的修复门是
「这张表完全为空」——任何一次正常的 `mem_save` 都会让它永久为假。现在它按自己的标记每个库跑
一次，失败则下次开库重试。从没跑过 `import-jsonl` 的库匹配不到任何行，代价为零。

这些行会经 `recall` / `mem_recall` 和 UserPromptSubmit 这条路变得可达。两个边界，都是实测的：

- **不会**经 pre-tool 召回钩子变得可达——那条腿只收 `importance >= 2`，而导入的行一律是 `1`。
- **不覆盖 6.7.2 之前导入的 `NotebookEdit` 行**。它们当时存下来的「修改过的文件」列表是空的
  （那时的导入器读 `file_path`，而 `NotebookEdit` 给的是 `notebook_path`），而回填按该列非空
  筛选，于是跳过它们。这一部分要靠重新导入该 transcript 来恢复——6.7.2 把路径写进了去重键所用的
  标题，重导才开始有效。

*`doctor --json` 的输出形状变了。* 带修复命令的检查项现在把命令放在 `details` 数组里——此前
人类界面拿到命令、JSON 界面只拿到诊断。另外四个检查项（dev drift、managed files、hook 脚本的
两条）现在报 `"level": "fail"`，此前报 `"warn"`，并新增 `"glyph": "warn"` 记录它们在屏幕上
仍渲染为 ⚠ 而非 ✗。它们一直都计入 issue 总数和退出码，现在 level 与之一致。如果你按
`level === "fail"` 过滤，会多看到四条此前漏掉的发现。`issues` 计数、摘要行和退出码不变。

## 升级到 6.1.0

**只有一个默认行为改变，且只影响每日后台任务。** 6.1.0 之前，无人值守的 `normalize` 会一次性
读取**所有项目**的概念词表，作为一个列表发给模型，再把答案写回每个项目——于是一个项目存储的内容
可以左右应用到另一个不相干项目行上的同义词分组。现在它按项目逐个跑独立的一趟。

| | 6.1.0 之前 | 6.1.0 |
|---|---|---|
| 无人值守 `normalize` | 一趟扫全部项目的词表 | 每项目一趟，单次运行最多 8 个，轮转 |
| 跨项目同义词统一 | 自动进行 | 不再发生 |
| 不带 `--project` 的 `optimize --run --task normalize` | 一趟跨项目 | 同样扇出 |

**你可能会注意到：** 一个项目里的 `k8s` 和另一个项目里的 `kubernetes` 不再被每日任务合并。
没有任何数据被删除，没有行被移动到别的项目，检索行为也不变——变的只是后台任务会统一哪些词。

**这个修复是单向的。** 早先跨项目运行已经统一过的词不会被还原。被替换掉的原词会作为搜索别名
保留在该行上，所以那些行仍然能用旧写法搜到；但没有任何记录能说明哪一次统一来自别的项目。

**想保留旧行为：** 设置 `CLAUDE_MEM_NORMALIZE_CROSS_PROJECT=1`。它恢复的是跨项目的**作用域**，
而这个作用域正是它交出去的那道防线。本次新增的另外两项检查（概念词的形状门、以及「模型的答案
只能使用语料中本就存在的词」）在该路径上确实仍然生效，但后者此时是拿**全部项目词表的并集**来判定的，
因此它不再能阻止一个项目的词进入另一个项目的行。只有当你确实需要跨项目统一、并且信任库中每个项目
的内容时才设置它。前台的 `optimize` 运行在该标志被设置时会打印警告；`claude-mem-lite doctor`
会把它报成 ⚠——每日任务跑在一个 stderr 已关闭的 worker 里，它自己无法告诉你。
<!-- normalize-per-project-note:end -->

<!-- vector-arm-removal-note:start -->
## 升级到 6.0.0（破坏性变更）

**默认检索路径不变。** 6.0.0 移除了 TF-IDF 向量臂——它自 3.17.0 起就默认关闭，如果你从未设置过
CLAUDE_MEM_VECTORS，升级前后行为完全一致，无需任何操作。

三个面被移除：

| 移除项 | 现在的行为 |
|---|---|
| `CLAUDE_MEM_VECTORS=1` | 失效。设置它不再有任何作用。 |
| `maintain execute --ops rebuild_vectors` | 退出码 1：`Unknown operation(s): rebuild_vectors`。 |
| `observation_vectors`、`vocab_state` 两张表 | 由 schema 迁移 v49 在首次打开时 DROP。 |

**这个迁移是单向的。** 一旦 6.0.0 打开过你的数据库，旧版本就会拒绝它——`schema.mjs` 的
forward-incompat 守卫会抛出 *"DB schema is v49 but this claude-mem-lite binary supports up to
v48"*。想继续用向量臂，请在**升级之前**锁定 `claude-mem-lite@5.6.0`；如果已经升级又需要回退，
只能重新升级、把 `CLAUDE_MEM_DIR` 指向一个新目录，或从升级前的备份恢复
（`claude-mem-lite export` 或数据目录下的快照）。

移除原因：直接对着出货路径实测，该臂在两个基准语料上都是负的——包括「词表不匹配」这个向量臂唯一
的存在理由（Recall@10 0.3407 → 0.3018，P95 延迟约 +88%）。观察记录不会丢失，丢的只是派生的向量索引。
<!-- vector-arm-removal-note:end -->

## 使用方法

### MCP 工具

v2.34.0 起服务端只把一部分工具暴露给 `tools/list`。服务端定义 19 个工具，其中 9 个
**核心** 工具默认出现在列表里，`mem_search_feedback` 仅在启用搜索遥测时加入；另外 9 个 **隐藏** 工具仍然注册在 MCP 层（按名
`tools/call` 仍命中），只是不出现在列表响应里，以避免 Claude Code 会话启动时
多加载 9 份工具 schema。隐藏工具走下面表格的 CLI 入口。

（这里长期写着 17 / 6 / 11，而英文 README 写着 20 / 9 / 11 —— 两个都不对。
`tool-schemas.mjs` 是唯一事实来源，`tests/tool-count-docs.test.mjs` 现在把两份
README 和 `docs/ARCHITECTURE.md` 都钉在它上面。）

**核心（10 个定义；`mem_search_feedback` 需要启用搜索遥测）**

| 工具 | 描述 |
|------|------|
| `mem_search` | 基于 BM25 排名的 FTS5 全文搜索。支持按类型、项目、日期范围、重要度过滤。 |
| `mem_search_feedback` | 为已有 `mem_search` Search ID 的结果记录稀疏相关性标签。 |
| `mem_recent` | 显示最近的观察，按时间排序。快速查看最新活动。 |
| `mem_recall` | 召回与文件相关的观察。编辑文件前使用，回顾过去的修复和上下文。 |
| `mem_timeline` | 围绕锚点按时间顺序浏览观察。 |
| `mem_get` | 获取指定观察 ID 的完整详情（包含重要度和关联 ID）。 |
| `mem_save` | 手动保存记忆/观察。 |
| `mem_defer` | 记录一条跨会话待办（deferred work）。 |
| `mem_defer_list` | 列出当前项目未关闭的待办。 |
| `mem_defer_drop` | 带理由地关闭一条待办。 |

**隐藏但可按名调用（9 个，走 CLI）**

| 工具 | 对应 CLI | 说明 |
|------|----------|------|
| `mem_update` | `claude-mem-lite update <id>` | 原地更新某条观察。 |
| `mem_stats` | `claude-mem-lite stats` | 计数、类型分布、每日活动。 |
| `mem_delete` | `claude-mem-lite delete <id>` | 预览 / 确认流程，FTS5 自动清理。 |
| `mem_compress` | `claude-mem-lite compress` | 压缩旧的低价值观察（默认 preview；`--execute` 执行）。 |
| `mem_maintain` | `claude-mem-lite maintain scan --ops dedup,decay` | 去重 / decay / 清理 / vacuum（`scan` 预览，`execute` 执行）。 |
| `mem_optimize` | `claude-mem-lite optimize` | LLM 深度优化：re-enrich / normalize / cluster-merge（默认 preview；`--run` 执行）。 |
| `mem_export` | `claude-mem-lite export` | JSON / JSONL 导出，支持项目/类型/日期过滤。 |
| `mem_fts_check` | `claude-mem-lite fts-check <check\|rebuild>` | FTS5 完整性检查与重建。 |
| `mem_browse` | `claude-mem-lite browse` | 分层仪表盘（working / active / archive）。 |

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
/verify                    # 对照当前代码核查记忆；你确认后才改正过期的记忆
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
claude-mem-lite adopt --all        # 旧方案清理：在所有项目里删除旧的 memory 目录哨兵
claude-mem-lite adopt --status     # 列出已 adopt / 已禁用项目 + 当前 gate 快照
claude-mem-lite adopt --dry-run    # 只打印不写入
claude-mem-lite adopt --disable    # 当前项目关闭 auto-adopt（写 .mem-no-auto-adopt 哨兵）
claude-mem-lite adopt --enable     # 当前项目重新启用 auto-adopt（删哨兵）
claude-mem-lite unadopt            # 移除 CLAUDE.md 托管块和详情文档，以及 CLAUDE.local.md 托管块（之后不再写回）
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
- 托管块会被重新生成，不保留手改：`adopt` 会把它改写成出货模板，每次 SessionStart
  只要它和模板不同也会改写——手动编辑的内容一样被覆盖。自己的笔记写在
  `claude-mem-lite:begin…end` 标记之外，或设 `CLAUDE_MEM_NO_TEMPLATE_REFRESH=1` 冻结。
- 按 slug 限定、去重：只改写 `claude-mem-lite:begin…end` 这一段，重复或 CRLF 残留的
  副本会合并成一份。旧的 `MEMORY.md` 方案才有行数预算，`CLAUDE.md` 没有截断上限。
- **任何安装路径每次 SessionStart 都自动 adopt，且不再把托管块加进 `CLAUDE.md`（6.19.4
  之后的下一个版本起）。** 没有托管块的 git 项目，引导写进 git 根目录的 `CLAUDE.local.md`
  （经 `.git/info/exclude` 排除在 git 之外），不在 git 里时注入 SessionStart 上下文；带
  `CLAUDE.md` 托管块的项目（显式 adopt 或旧版本写入）保持同步，出货模板变化会刷新（用
  `CLAUDE_MEM_NO_TEMPLATE_REFRESH=1` 冻结），且不会再叠加本地副本或注入，从子目录启动的会话
  也一样。插件创建过、又被你（或 `unadopt`）删掉的 `CLAUDE.local.md` 托管块不会被写回；
  `adopt --enable` 可重新启用。项目级关闭：`claude-mem-lite adopt --disable`（写
  `<memdir>/.mem-no-auto-adopt` 哨兵，存活于 marker 删除 / 插件重装；在仓库根目录运行时，对从子目录启动的
  会话同样生效；并删除本地托管块）。全局关闭：`export MEM_NO_AUTO_ADOPT=1`（已写入的托管块保留，直到 `unadopt`）。
- 保守 hook 层源码永不删——条件瘦身按"引导已送达"（有托管块或注入开启）做 runtime
  判断，关闭了引导的项目仍看完整 verbose 输出。

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

**session_summaries** -- 每个会话的摘要（Stop 时写入，后台模型摘要升级）
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

UserPromptSubmit（两个并行路径）
  -> [user-prompt-search.js] 通过 FTS5 + 活跃文件上下文自动搜索记忆
  -> [user-prompt-search.js] 注入相关历史观察（按时效和重要性加权）
  -> [hook.mjs] 捕获用户提示文本到 user_prompts 表
  -> [hook.mjs] 递增会话提示计数器
  -> [hook.mjs] 交接：检测继续意图 → 注入上一次会话上下文
  -> [hook.mjs] 语义记忆注入（hook-memory.mjs），通过临时文件去重

Stop
  -> 刷新最终 episode 缓冲区
  -> 保存交接快照（/exit 时）
  -> 标记会话为已完成
  -> 写入会话摘要行（同步，不调模型）
  -> 启动 LLM 摘要 worker（轮询等待）
```

### Episode 编码

Episode 是一批相关操作（对同一组文件的编辑），由后台 LLM worker 处理：

```
Episode 缓冲区 -> 刷新为 JSON -> claude -p --model haiku -> 结构化观察 -> SQLite
```

每条观察包含类型、标题、叙述、概念、事实和重要度（1-3），并通过两级机制自动去重：Jaccard 相似度（5 分钟内 >70%）和 MinHash 签名（7 天跨会话 >80%）。LLM 调用失败时，规则判定有价值的 episode 用推断的元数据保存降级记录，规则判为噪声的日常编辑会被丢掉。相关观察通过 FTS5 标题相似度和文件重叠自动建立 `related_ids` 链接。

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
node cli.mjs doctor                   # 诊断问题（用 cli.mjs 而非 install.mjs，见下方说明）
node cli.mjs repair                   # 从最新签名发布恢复损坏的安装
node install.mjs cleanup-hooks        # 只清理 settings.json 中残留的 claude-mem-lite hooks
node install.mjs update               # 强制检查并安装更新（direct install / npx 模式）

# npx 安装：
npx claude-mem-lite                   # 安装 / 重新安装
npx claude-mem-lite uninstall         # 移除（保留数据）
npx claude-mem-lite doctor            # 诊断问题
```

说明：
- `doctor` 与 `repair` 写成 `cli.mjs` 而不是 `install.mjs`，是有意的。这两条恰恰是安装
  已经坏掉时才会用到的命令，而 `install.mjs` 在执行第一行代码之前要解析十几个静态
  import——少一个文件就直接吐一段 Node 栈，而不是告诉你少了哪个文件。`cli.mjs` 没有
  任何本地静态 import，会捕获这种失败并说出缺失的文件和修复命令。列表中其余命令两种
  写法都一样。
- 插件模式只提示可用更新，不会自更新插件文件。
- direct install / npx 模式保留自动更新，并使用 staged replacement；若依赖安装失败会回滚。
- 如果你禁用了插件，但 `~/.claude/settings.json` 里还有旧的 mem hooks，可运行 `node install.mjs cleanup-hooks`。

### doctor

检查 Node.js 版本、依赖、服务器/钩子文件、数据库完整性、FTS5 索引、残留进程、MCP 注册状态，
以及 marketplace clone 是否还能被更新。

它用 `claude mcp list` 回答注册状态那一问，而这会**对你配置的每个 MCP server 做健康检查**——
也就是逐个短暂启动，包括远程 endpoint。`status` 刻意不这么做：插件形态下它从 manifest 回答。

### status

显示 MCP 注册状态、钩子配置、插件禁用状态和数据库统计（观察/会话数量）。

### 故障恢复（安装卡死 / hook 报错）

如果你看到 PreToolUse:Read/Edit hook 报 `ERR_MODULE_NOT_FOUND`，或者 `claude-mem-lite` 命令本身因为 import 错误崩溃，多半是被部分自动更新坑了——更新器复制了新脚本但漏了配套的 `lib/*` 文件，hook 链就此断掉（连下一次本可自愈的自动更新也跑不了）。

**v2.84.0+** 提供 `repair` 子命令，从 GitHub 最新 release 重新同步：

```bash
claude-mem-lite repair
```

**如果 `repair` 自己也跑不起来**（bin 比 v2.84.0 旧，或 bin 也坏了），用这条单行命令——它把最新 tarball 拉到临时目录、跑 *那份* tarball 里的 `install.mjs`，完全不依赖你磁盘上的任何文件：

```bash
T=$(mktemp -d) && U=$(curl -sL https://api.github.com/repos/sdsrss/claude-mem-lite/releases/latest | grep -o '"tarball_url"[^,]*' | cut -d'"' -f4) && curl -sL "$U" | tar xz -C "$T" --strip-components=1 && node "$T/install.mjs" install
```

它会先解析出最新 **release** 的 tag。shell 单行命令无法像 `repair` 那样校验 release 签名，所以跑它等于你自己做了一次信任决定——这也是它排在最后、而不是被优先推荐的原因。

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

**`/plugin uninstall` 不会删 plugin cache。** Claude Code 会把每个版本展开到
`~/.claude/plugins/cache/` 下，各带一份 `node_modules`。插件还装着的时候，这些会被裁剪到最新
三个版本（SessionStart 会做，更新路径也会做），所以这个目录是有上限的——实测 241 MB——而不是无限
增长。但 `/plugin uninstall` 只移除 manifest，插件又没有可挂的卸载生命周期钩子，于是钩子停止触发，
剩下的东西再也没人回收。`claude-mem-lite uninstall` 能回收它，但 `/plugin uninstall` 之后这个命令
可能已经不在 PATH 上了。所以要么**先**跑它，要么自己删：

```bash
rm -rf ~/.claude/plugins/cache/sdsrss/claude-mem-lite
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
  haiku-client.mjs     # 统一 Haiku LLM 封装：直连 API 或 CLI 回退
  # 安装与配置
  install.mjs          # CLI 安装器：设置、卸载、状态、诊断（npx/git clone 模式）
  skill.md             # MCP 技能定义（npx/git clone 模式）
  package.json         # 依赖和元数据
  scripts/
    setup.sh           # Setup 钩子：npm install + 迁移（隐藏目录 + 旧目录）
    post-tool-use.sh   # Bash 预过滤器：~5ms 跳过噪声，追踪 Read 路径
    user-prompt-search.js # UserPromptSubmit 钩子：用户提问时自动搜索记忆
    pre-tool-recall.js   # PreToolUse 钩子：Edit/Write 前文件教训回忆
    post-tool-recall.js  # PostToolUse 钩子：工具失败后的错误召回
    pre-agent-inject.sh  # PreToolUse 钩子：为子代理注入上下文
    prompt-search-utils.mjs # 共享逻辑：跳过模式、意图检测、名称匹配
  # 测试和基准（仅开发）
  tests/               # 单元、属性、集成、契约、E2E、管线测试
  benchmark/           # BM25 搜索质量基准 + CI 门控
```

## 搜索质量

基于 200 条观察和 30 个查询（标准 + 困难负样本类别）的基准测试结果，测量的是
**production-hybrid** 检索路径（真实的 `searchObservationsHybrid`）——也就是 `mem_search` /
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

> **关于测量路径。** 本表测量的始终是 `mem_search` 实际走的那条路径，所以数字变过两次。
> 早期版本报告的是更窄的纯 FTS 测量口径（Precision@10 0.96、P95 0.15ms）；后来一版把
> precision 的下降归因于「TF-IDF 向量臂用 precision 换 recall」。**那个归因是错的，该说法已撤回**
> ——门控的 `hybrid_over_bm25` 差值两个臂都不执行向量路径，根本量不到这笔交换。该臂后来被直接
> A/B 实测，两个语料上都是负的，已移除；此处的数字就是不含向量臂的出货路径。

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
| `CLAUDE_MEM_DIR` | 自定义数据目录。所有数据库与运行时文件均存储在此。 | `~/.claude-mem-lite/` |
| `CLAUDE_MEM_MODEL` | 后台 LLM 调用模型（Episode 提取、会话总结、调度）。可选 `haiku` 或 `sonnet`。 | `haiku` |
| `ANTHROPIC_API_KEY` | Anthropic API key。设置后所有后台 LLM 调用直连 Anthropic Messages API（带 prompt caching），优先级最高。 | _(未设 → CLI)_ |
| `OPENROUTER_API_KEY` | OpenRouter API key（OpenAI 兼容）。当**未设** `ANTHROPIC_API_KEY` 时用于后台 LLM 调用；两者都未设则回退到 `claude -p` CLI。 | _(未设)_ |
| `OPENROUTER_MODEL` | 覆盖**所有**后台调用的 OpenRouter 模型 slug（如 `openai/gpt-4o-mini`、`qwen/qwen-2.5-72b-instruct`）。未设时按 `CLAUDE_MEM_MODEL` 分层映射到 `anthropic/claude-haiku-4.5`（haiku）或 `anthropic/claude-sonnet-4.5`（sonnet）。 | _(分层默认)_ |
| `CLAUDE_MEM_DEBUG` | 启用调试日志（设为 `1` 启用）。 | _(禁用)_ |
| `MEM_QUIET_HOOKS` | 低噪声 hook。设为 `1` 时，SessionStart 注入去掉 `File Lessons` / `Key Context` 两节，`[mem] Related memories` 去掉 lesson 后缀，MCP server instructions 去掉 `WHEN TO USE` / `Decision rules` 两段。ID 与 `Recent` 表仍保留，`mem_get(ids=[…])` 可继续展开细节。适用于启用了 invited-memory adopt 流程或偏好最小化自动注入的用户。**v2.82.0 起此 env 不再阻挡 auto-adopt——如需关闭 auto-adopt 用 `MEM_NO_AUTO_ADOPT=1`。** | _(禁用)_ |
| `CLAUDE_MEM_SESSION_EVENTS` | 设为 `1`/`on` 时恢复 SessionStart 的 `### Key Events` 一节（`events` 表中最近的高重要度条目）。**v6.13.0 起默认关闭**：对 30 条 event 的核验只有 2 条属实、16 条错误。UserPromptSubmit 的 events 块与 PreToolUse 召回按查询匹配，保持开启；`mem_search` 仍可检索全部 event。 | _(关闭)_ |
| `CLAUDE_MEM_EPISODE_INPUT_FILTER` | 决定 episode 摘要器能从哪些输入里学。子代理的工具调用不进入 episode 缓冲（修改项目内文件的除外）；变异探针（改文件 → 跑红 → 还原）和 agent 自己失败的内联脚本（补丁的 `anchor not found`）在保存或摘要前被剔除——在 30 条已核验 event 上重放，这一项直接去掉 16 条错误中的 3 条；配合 `CLAUDE_MEM_LESSON_GROUNDING`，16 条错误教训一条都不会被注入。设为 `off` 恢复未过滤的输入。 | _(开启)_ |
| `CLAUDE_MEM_BASH_RECALL` | 在查看（`cat`、`sed -n`、`head`…）或写入（`sed -i`、`cat > f`、python 补丁…）文件的 Bash 命令执行前做文件召回，与 Read / Edit 召回相同。bash 预过滤让其他命令不启动 Node。设为 `off` 只关闭这一路。 | _(开启)_ |
| `CLAUDE_MEM_LESSON_GROUNDING` | 自动捕获的 event 只有在教训引用了本窗口自己的诊断文字（失败输出行、编辑新增的注释或提交信息）时才保留教训；否则保留这一行但去掉教训，importance 降为 1，低于所有注入面的门槛。设为 `off` 保留未引用原文的教训。 | _(开启)_ |
| `CLAUDE_MEM_LESSON_OUTPUT_CAP` | 自动捕获的教训如果和**工具输出**（命令打印的文字或工具返回的内容，能控制这段输出的人就能写它）有连续 4 个词相同，就不会进入注入面：event 保留这一行和教训、仍可搜索，importance 降为 1；`change` 类 observation 的 importance 之后会被读取次数抬高，所以改为去掉教训，没有教训的这一行随后会像其他同类行一样被丢弃（只有设了 `CLAUDE_MEM_KEEP_LOW_SIGNAL=1` 才保留）。连续 4 个虚词（例如 "is not in the"）也算，所以引用你自己的注释或提交信息的教训，只要碰巧和同一窗口的输出共有这样一串词，也会被降级。这一行的标题不在检查范围内。设为 `off` 恢复模型给出的 importance 和教训。 | _(开启)_ |
| `MEM_NO_AUTO_ADOPT` | auto-adopt 全局关闭开关（v2.82.0+）。设为 `1` 在**所有**项目停止自动 adopt——不注入引导文本、不新建 `CLAUDE.local.md`，也不同步已有的 `CLAUDE.md` 或 `CLAUDE.local.md` 托管块（这些托管块会保留并继续加载，直到 `claude-mem-lite unadopt`）。项目级关闭走 `claude-mem-lite adopt --disable`（写 `<memdir>/.mem-no-auto-adopt` 哨兵，存活于 marker 删除）。 | _(禁用)_ |
| `MEM_NO_ADOPT_HINT` | 静音项目第一次得到 `CLAUDE.local.md`、或第一次以注入方式被引导时给你的一次性提示（后者建议运行 `/adopt`，在 `$HOME` 下除外），以及当前项目未 adopt 时 SessionStart 追加的那一行 "Invited-memory 未启用…" 提示。v2.82.1 起任何安装路径每次 SessionStart 都自动 adopt，所以该提示一般只在你显式 opt out（`MEM_NO_AUTO_ADOPT=1` 或 `claude-mem-lite adopt --disable`）的项目才会出现。 | _(禁用)_ |

## 许可证

MIT
