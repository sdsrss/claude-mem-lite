# 历史会话复盘：claude-mem-lite 在 Claude Code 编程过程中的问题、阻碍、缺陷与指标

- **日期**：2026-09-25（UTC）
- **代码树**：`main` @ `2ecaa1d`（v6.12.2），工作区干净
- **性质**：只读分析。没有修改任何源码，也没有写入真实 DB（DB 用 `sqlite3 backup` 做了只读快照再查询）
- **结论分级**：**已证实**（本轮有工具输出或复现）/ **待验证**（只有推理或样本不足）

---

## 0. 摘要

**先说结论。** 这 20 天产出很高：45 个发版、298 个提交、测试用例从约 5.8k 增长到 6.6k。代价与风险集中在三处：

1. **产品自身的三个缺陷，恰好都落在"记忆有没有用"的测量链路上**（已证实）：
   - **B1**：error-recall 的"只读命令豁免"被 `cd <dir> && …` 前缀绕过。本机 55% 的 Bash 命令带这个前缀，所以只读命令的输出一旦出现 `TypeError:` 这类字样就会注入"Related memories found for this error"。本次分析会话里就误触发了 6 次以上。
   - **B2**：引用追踪把 `#NN n/a`（agent 明确表示"该记忆与本次无关"）计为一次"引用"，从而重置衰减、清空 `demoted_at`，并累加 `access_count`。约 26% 的 `#NN` 提及属于这种否定语境。
   - **B3**：shipped 的 adopt 文案（`adopt-content.mjs:92`）仍告诉模型"连续 3 个会话未引用则 importance −1、被引用则 +1"，但代码早已不在衰减路径上改 importance。这是一条对模型可见、但已经过期的行为声明。
2. **Key Events（events 表）注入量大、从未被读取，且抽样准确率低**：
   - 本项目会话里注入了 662 行 Key Event，而 3776 行 events 的 `accessed_count` **全部为 0**。
   - 随机抽 30 条核验：**只有 2 条属实，16 条是错的**（事情没发生，或技术断言错误），11 条部分属实（§4.4.1）。另外已确认 E#3771、E#3769 两条是编造的"教训"（例如声称"禁用了一个 flaky 测试"，实际该测试一直在跑）。
3. **会话过程的主要成本在上下文和等待，而不在模型能力**：
   - 请求上下文中位数 29.6 万 token，49% 的请求超过 30 万；
   - 等 CI（4.8h）、每次提交跑的 pre-commit 全量测试（提交命令合计 4.35h），加上重复的全量 vitest（4.5h），合计超过 13 小时的墙钟时间；
   - 语言漂移：最终回复用英文的占 11.7%。换 Opus 5.5 后升到 35%，用户不得不 7 次手动输入"中文输出"。

**最高收益的 5 条建议**（详见 §6）：修 B1、修 B2、给 Key Events 做准确率闸门（或暂停注入）、pre-commit 按 tree-hash 复用最近一次绿灯、会话上下文约 30 万 token 时主动 `/clear` 并交接。

---

## 1. 数据来源与方法

| 来源 | 范围 | 用法 |
|---|---|---|
| 主会话 transcript | `~/.claude/projects/-home-ai-dev-claude-mem-lite/*.jsonl`：55 个（不含本会话；其中 5 个为空会话），2026-09-05 → 09-25，约 250 MB | 流式解析：工具调用/结果、hook 附件、token usage、用户消息 |
| 子代理 transcript | `<session>/subagents/*.jsonl`：88 个，约 96 MB | 同上，单独统计 |
| 记忆 DB | `~/.claude-mem-lite/claude-mem-lite.db` 的只读快照（2026-09-25 20:0x） | SQL 统计；另对快照副本运行 `cli.mjs citation-stats` |
| git / CI | `git log`、`git tag`、`gh run list --limit 200` | 发版、提交、CI 结论 |
| 源码 | 按需 Read/grep，并对 `bash-utils.mjs` 做了进程内探针 | 确认缺陷机理 |

**口径说明**（遵循 findings.md 的测量原则）：
- 所有数字都是 2026-09-25 对上表总体的一次性快照。**不要和其他时间点的读数做差。**
- "引用"在本文中分两种口径，§4.2 会逐一注明：(a) transcript 口径：注入之后助手文本中出现 `#ID`；(b) 产品口径：`citation-stats` 的读数。两者总体不同（项目范围、主线程/子代理、去重方式），**不能直接对比**。
- "exit 0"指工具结果 `is_error=false`。`cmd | tail` 会吞掉真实退出码，因此它 ≠ "命令成功"。§4.1 单独处理了这个混淆。
- 覆盖的日期：09-09 到 09-10、09-12、09-15 到 09-20 没有会话，所以没有数据。

---

## 2. 全局画像

| 指标 | 数值 | 备注 |
|---|---|---|
| 主会话活跃时长 | 84.9 h | 相邻事件间隔 <30 min 的累计 |
| 主会话 API 请求 | 11,528 | 按 requestId 去重 |
| 输出 token（主 / 子代理） | 10.71 M / 0.48 M | |
| cache read（主 / 子代理） | 3.60 B / 0.84 B | 缓存命中率 99.3%（主） |
| 请求上下文大小 | 中位数 296k；P90 526k；最大 692k | 49.1% 的请求 >300k，12.5% >500k |
| 会话峰值上下文 | 中位数 443k | 55 个会话中 33 个峰值 >400k |
| 会话起始上下文（首个请求） | 50k（09-05）→ 126k（09-08）→ 62k（09-08 精简 CLAUDE.md 后）→ 76k（09-25） | 见 §3.1 |
| 工具调用（主） | Bash 9,096 · Edit 1,798 · Read 907 · Write 273 · Agent 85 · AskUserQuestion 40 · SendMessage 35 · Grep 1（调用失败，本会话未提供该工具） | harness 的 bash-first 策略，决定了几乎所有检索都走 Bash |
| 工具报错率（主 / 子代理） | 2.2%（275）/ 3.8%（233） | 构成见 §3.4 |
| 提交（`git log --since=09-05`） | 298：fix 126 · docs 47 · release 42 · converge 27 · test 24 · feat 12 | fix 占 42% |
| 发版（tag） | 45 个，v3.95.1 → v6.12.2，其中 09-06 一天发了 10 个 | 3 次 major |
| 测试规模（全量 run 中的最大值） | 357 文件 / 5,906 用例（09-05）→ 429 / 6,645（09-25） | 测试代码 128k 行，非测试 JS 73k 行 |
| 全量 vitest 耗时中位数 | 27.5 s（09-05）→ 37.1 s（09-22）；09-25 为 51.2 s | 09-25 有并行子代理，可能存在争用（待验证） |
| CI（最近 200 run 中 09-05 之后的） | CI 74 success / 1 action_required；Release 44 / 1 failure；Sandbox 2 / 1 failure | rerun 会覆盖结论，所以 flake 在此处不可见（例如 09-07 Node 22 的 hookTimeout，见 §3.6） |

**用户的工作流模式**（从 231 条去重后的用户消息归纳）：
- "剩余还有哪些有价值工作" 15 次 → "按你的建议执行" 7 次 → "提交 推送 合并 发版" 11 次，形成一个闭环。
- 另有 `/clear` 37 次、`/exit` 19 次、"继续" 12 次、"中文输出" 7 次。
- 用户几乎把所有决策都委托给 agent，并通过独立评审子代理（defect-lens / claims-lens）把关。这个模式本身有效，但也放大了下面几个问题。

---

## 3. 编程过程中的问题与阻碍

### 3.1 上下文膨胀（已证实，影响最大）

- 请求上下文中位数 **296k**，一半的请求在 30 万以上。4 次压缩全部是手动 `/compact`，压缩前分别为 574k、617k、652k、691k，每次耗时 66–135 s。
- **起始上下文**（开工前的固定开销）：09-05 为 50k；09-08 涨到 126k，当时项目 CLAUDE.md 过大，用户要求压到 20 KB 以内；之后降到 62k，现已回升到 **72–76k**。当前三大常驻文件：

  | 文件 | 字节 |
  |---|---|
  | 自动记忆索引 `MEMORY.md` | **28,635**（61 行，多条索引行超过 1 KB） |
  | `~/.claude/CLAUDE.md` | 24,484 |
  | 项目 `CLAUDE.md` | 20,404 |

- **hook 注入的上下文**（主会话累计字符数 / 次数）：

  | 来源 | 累计字符 | 次数 | 平均 |
  |---|---|---|---|
  | code-graph PreToolUse 模块概览 | 404k | 411 | 983 |
  | mem SessionStart | 298k | 50 | 5,966 |
  | mem PreToolUse | 251k | 744 | — |
  | `[mem] episode flushed: N entries` 簿记行 | — | **864** | — |

  最后一项对模型没有决策价值。
- **影响**：长上下文和下面的语言漂移、规则违反（§3.3）在时间上是共存的，但本文没有做因果隔离，**因果关系待验证**。成本方面是确定的：cache read 36 亿 token。

### 3.2 语言漂移（已证实）

- 在"用户下一条消息之前的最后一段 >200 字符的助手文本"中，英文占 **26/223（11.7%）**：
  - 按模型：Opus 5 为 12/179（6.7%），**Opus 5.5 为 14/40（35%）**，后者集中在 09-25；
  - 按前一条用户消息：**是子代理（teammate）消息的，英文占 16/65（24.6%）**；其他情况为 10/158（6.3%）。
- 用户为此手动输入"中文输出"7 次。机理是：子代理报告几乎全是英文，主线程读完后沿用了英文。

### 3.3 其他插件 hook 的拦截摩擦（已证实）

- **claudemd §8 拦截 `rm -rf $VAR`**：主会话与子代理合计 134 次（`rm -rf` 114 次、`rm -f` 19 次），**20 天里没有下降趋势**（09-14 仍有 12+4 次，09-25 有 2+7 次）。子代理贡献 62 次，因为它们的 brief 里没有沙箱清理模板。
- **code-graph 拦截原生 grep**：106 次，而全部 Bash 中出现 grep/rg 的调用有 6,210 次，拦截率 1.7%。
- **两个导向相互冲突**：harness 声明"没有 Grep 工具，用 Bash grep"，code-graph hook 又会拒绝部分 Bash grep。
- 每次拦截都多一个来回。

### 3.4 工具报错构成（主会话 275 次）

| 类别 | 次数 |
|---|---|
| Bash 非零退出（多数是有意的 RED / 变异探针） | 218 |
| hook 拦截（§8 为主，另有 code-graph，以及 claudemd §10-V / §11 各 1–6 次） | 约 57（主会话部分） |
| Edit "String to replace not found" | 15 |
| 子代理 Write 被 harness 拒绝（"Subagents should return findings as text"） | 7 |
| API 连接中断 | 3 |

### 3.5 等待与重复验证的墙钟成本（已证实）

| 项目 | 次数 | 中位数 | 合计 |
|---|---|---|---|
| AskUserQuestion（等用户） | 40 | 28.6 s（P90 1,443 s） | 13.9 h |
| `gh`（主要是 `gh run watch/list` 等 CI） | 387 | 5.3 s（P90 203 s） | 4.8 h |
| **`git commit`（pre-commit 跑 eslint + format:check + `npm test` 全量）** | 395 | **44.2 s** | **4.35 h** |
| 全量 `npx vitest run` | 404 | 35.8 s | 4.5 h |
| 部分 vitest | 1,454 | 1.5 s | 2.6 h |
| `sleep` 轮询 | 81 | 29 s | 1.4 h |

- agent 的惯例是"先跑全量 → 再 commit"，而 pre-commit 又把同一棵树跑一遍，所以**每次提交大约重复跑一次全量套件**。
- 相对"等 CI"而言，`sleep` 轮询是可以改成后台监视的。

### 3.6 多代理 / 跨会话协作事故（已证实，来自用户消息和评审回报原文）

- **09-07**：用 `git checkout --` 回退变异探针，把尚未提交的实现一并擦掉（"REVERT FAILED"），只能重打。教训已存为记忆。
- **09-11**：claims-lens-3 报告 "SHIP BLOCKER"。`install.mjs` 被残留的变异探针（`const last = null;`）污染，来源不是该评审者；打 tag 前险些发出去。
- **09-06**：评审报告超过 16,000 字符被截断（"[result truncated]"），共 4 个主会话出现过这种情况。子代理想写报告文件又被 harness 拒绝（7 次）。
- **09-25**：工作越界到 claudemd 仓库（用户问"怎么会提交落到了另一个会话的分支"），在另一个项目留下未合并分支 `docs/withdrawn-rotation-rates`。
- **SendMessage 按裸名寻址时撞名**：已有记忆记录。
- 结论：并发子代理与主工作树共享同一个 git 工作区，是这些事故的共同前提。

### 3.7 环境问题（已证实）

- **09-05**：新系统上 hook 报 `node: command not found`，共 22 次（v3.95.0 的 `post-tool-use.sh:144`，以及 UserPromptSubmit/Stop），之后没有再出现。
- **09-08**：插件缓存停在 3.95.0，而 DB 已是 v48，导致 CLI 报 "schema is v48 but this binary supports up to v47"。这一事件催生了 schema-skew 自愈功能。
- **09-22**：vitest 的 `/tmp/<id>/ssr` 残留把 12G tmpfs 写满（627 个目录 / 8.2 GB），Bash 全部静默 exit 1。`npm test` 已改成 `TMPDIR=$HOME/.cache/tmp`，**但 agent 主要走的 `npx vitest run` 路径没有覆盖**：今天 `/tmp` 下又新增 60 个 ssr 目录（156 MB，全部是 09-25 创建的）。
- **09-21**：新写的凭据脱敏测试夹具是一条完整字面量，触发 GitHub push protection（GH013），拒绝了 main 和 tag 的推送。

---

## 4. 产品缺陷与数据指标问题

### 4.1 B1 —— error-recall 的只读豁免被 `cd` 前缀绕过（已证实，P1）

**位置**：`bash-utils.mjs:65-74` 的 `isReadOnlyCommand`。它只取**第一个管道段的第一个 token** 来判断，`cd` 不在跳过列表里；`SEARCH_VERBS`（`bash-utils.mjs:15`）也不含 `sed`/`awk`/`ls`/`jq`。

**复现**（进程内探针，输出含 `TypeError:` 字样的 grep 结果）：

```
"grep -n x f"                  isError=false isHardError=false
"cd /repo; grep -n x f"        isError=true  isHardError=true
"cd /repo && sed -n 1,5p f"    isError=true  isHardError=true
"git log --oneline"            isError=false isHardError=false
"python3 - <<EOF ..."          isError=true  isHardError=true
```

**规模**：
- 主会话 9,096 条 Bash 命令中有 **5,009 条（55.1%）以 `cd ` 开头**，因为 harness 每次调用后都会重置 cwd。
- error-recall 在 PostToolUse（`is_error=false`）上一共触发 215 次，其中 133 次是 `cd` 前缀命令。
- 抽 45 条人工看：约 38 条是真实的测试失败（`| tail` 吞掉了退出码），约 5 条是纯误报（提交信息、import 报告里的 "failed"、`code-graph-mcp grep` 结果）。
- 本分析会话本身：在只读分析命令上误触发 **6 次以上**。

**为什么要修**：
- 误报会注入 3 条与当前任务无关的 lesson，同时拉低该 face 的真实采纳率（B2 的另一面）。
- 真实失败中大量是**有意的 RED / 变异**（TDD 流程），这些场景下"相关记忆"同样没有价值。transcript 口径下，本项目主线程 error-recall 的引用率是：最近 7 天 7/115 = 6.1%，全程 28/245 = 11.4%（按去重后的 (session, id) 对）。

**最小修复**：`isReadOnlyCommand` 先剥掉开头的 `cd <path> (&&|;)` 段，再判定首个命令；把 `sed -n`、`awk`、`ls`、`jq`、`code-graph-mcp` 加入只读动词。验收：用 `benchmark/error-recall-live-replay.mjs` 重放，只读命令上的触发次数降到 0，真实失败上的触发集合不变（按名集比对）。

### 4.2 B2 —— `#NN n/a` 被计为引用（已证实机理，P1）

- **约定**：`.claude/plugin_claude_mem_lite.md:22`（由 `adopt-content.mjs` 生成）要求 agent 写 `'#NN applied'` 或 `'#NN n/a — <理由>'`。
- **追踪器**：`lib/citation-tracker.mjs:63` 的 `citationIdRe` 只匹配 `#NN`，不看后面的 `n/a`。命中后 `updatePromote`（`:1589-1602`）会做四件事：
  - `cited_count+1`
  - `uncited_streak=0`
  - `demoted_at=NULL`
  - 同时 `bumpCitationAccess` 累加 `access_count`；`access_count > 3` 之后会经 boost 维护路径让 importance +1（代码注释 `:1473` 自己承认这是第二条路径）
- **测量**（主会话助手文本中全部 `#NN` 提及，排除紧跟 PR/issue 的 24 次）：**否定语境（n/a / 无关 / not relevant 等，前后 80 字符内）116 次，普通语境 329 次，否定占 26.1%**。
- 例子：`#260 / #518 / #137 / #54 n/a——本轮无 hook 生命周期状态迁移…`。其中 **#54 正是 `citation-stats` 里"被引用最多（9x）"的那一条**。
- `citation-tracker.mjs:1464-1466` 的注释写的是"没有可用信号区分'用了这条教训'和'写到了这条教训'"。但产品自己规定的 `n/a` 标记**恰好就是这个信号**，只是没有解析。
- **影响**：`citeFactorClause` 排序乘数、衰减队列和 boost 都被"被明确否决的记忆"推高；"引用率"读数偏高，无法作为采纳率使用。
- **最小修复**：在 `#NN` 之后约 40 字符内识别 `n/a|不适用|无关`，作为"已看到、未采用"单独计数：不 promote，也不计入 streak 的"未引用"。验收：用 `citation-live-replay.mjs` 输出 applied / n/a / bare 三栏，并保证 #54 这类行不再因为 n/a 被 promote。

### 4.3 B3 —— shipped adopt 文案的行为声明已过期（已证实，P2，改动属于 L3：LLM 可见元数据）

- `adopt-content.mjs:92`（会写进每个已 adopt 项目的 `.claude/plugin_claude_mem_lite.md`）写的是："未引用的 lesson 连续 3 个会话后 importance −1（地板 0），被引用的 +1（封顶 3）"。
- 而 `lib/citation-tracker.mjs:1610-1616` 的 D#179/D#198 注释（另见 `:963`、`:1054`、`:1360`）明确说明：rollover "no longer touches `importance`"，现在只写 `demoted_at` 和 streak。
- `schema.mjs:61`、`:366` 的注释是同一句过期说法。
- 这是 findings.md 里"撤回必须扫全部拷贝"这类问题的又一个实例：面向模型的那份拷贝没有扫到。

### 4.4 B4 —— Key Events：注入多、从未被读、准确率低

- `events` 表共 3,776 行，**`accessed_count` 全部为 0**。唯一的写者是 `lib/activity.mjs:101` 的 `getEvent`，也就是 agent 从来没有按 id 取过任何一条 event。
- importance ≥2 的占 74%（2,801 行）。本项目主会话共注入 Key Event 行 662 次。
- **已证实的错误样例**：
  - **E#3771**："Disabled flaky secret-leakage test; vitest runner error — vitest runner can fail with cryptic 'tool input straddling' errors…"。实际情况是：`tests/import-jsonl-dedup-scrub.test.mjs:162` 的用例 `'tool input straddling 4000'` 一直在运行，它测试的是"凭据横跨 4000 字符截断点"；该会话 transcript 中 `it.skip` 出现 0 次，git 历史里也没有禁用记录。摘要器把用例名误读成了错误信息。
  - **E#3769**："git hook runner does not follow symlinks"。我查看的该会话里 6 处 symlink 上下文，都是"测试夹具用 symlink 铺根目录"或 install 形态说明，这是一条凭空泛化出来的技术断言。
  - 这两条都会在下一次 SessionStart 作为 "Key Events" 注入给模型。
- **30 条随机样本的核验结果**：ACCURATE 2 / PARTLY 11 / WRONG 16 / GENERIC 1，详见 §4.4.1。

#### 4.4.1 events 抽样核验

总体与方法：从本项目 933 条未被 supersede 的 events 中随机抽 30 条（seed 20260925）。由一个独立子代理只读核验，依据是 event 创建时间前后的 git 提交和会话 transcript（必要时读子代理 transcript）。标签含义：ACCURATE = 属实；PARTLY = 标题属实但教训夸大或机理错误；WRONG = 事情没发生或技术断言错误；GENERIC = 空泛的套话。我复核了其中 3 条的证据，#1106 / #3088 / #1726 与 `git show 1bf34c3`、`git show eac4fb0` 一致。

| 标签 | 条数 | 占比（Wilson 95% CI） |
|---|---|---|
| ACCURATE | **2** | 6.7%（1.8%–21%） |
| PARTLY | 11 | 36.7% |
| WRONG | **16** | 53.3%（36%–70%） |
| GENERIC | 1 | 3.3% |

分类型：bugfix 21 条中 WRONG 12 条；refactor 5 条中 WRONG 2 条、PARTLY 3 条，这些 refactor 都声称"无行为变化"，实际上是行为修复。

**失败形状**（同一形状会反复出现，按出现频率排列）：
1. **把测试探针和变异的词汇读成产品缺陷**（6 条）："M1"/"G1" 变异臂名、md5/sha256 校验行、先变异再还原的步骤，被写成 bug、"corruption"、"hash-based errors"。本仓库对每个守卫都做变异验证，所以这个形状会持续产生错误记录。
2. **把子代理或沙箱里的活动记到产品头上**（3 条）：主线程空闲等评审时，评审者在解压树里写的探针、夹具 typo 被写成"Fixed X in search-scoring"；夹具路径 `/repo/alpha.mjs` 还泄漏进了 `file_paths`。
3. **把 agent 自己的工具失误当成教训**（3 条）：python 补丁 "anchor not found"、Edit 工具的 "String to replace not found" 被写成 schema 接线、格式化缓存方面的"教训"。
4. **把历史注释当成当前工作**（1 条）：event 称 MEM_QUIET_HOOKS 被移除，但它至今仍在代码里。
5. **refactor 类型声称"无行为变化"，其实是行为修复**（4 条）。
6. **教训过度泛化，并编造机理**（6 条，其中 #1106 与事实完全相反：cap 是从 3 **调高**到 6 以挽回召回，event 却说"加上限防性能退化"）。只有当窗口里 agent 用文字写出了诊断时，教训才准确（#579、#644）。

**结论**（已证实，样本量 30）：Key Events 的错误率约为一半，而且它们以"Key Events"的权威口吻，在每次 SessionStart 注入给模型。这条注入通道的净效果很可能是负的。结合 `accessed_count` 全部为 0，建议优先处理（§6）。

完整逐条证据见附录 A。

### 4.5 数据指标本身的问题

| # | 指标 | 现象 | 判断 |
|---|---|---|---|
| M1 | `importance` 分布 | 151 条 observation 中 imp3 72、imp2 76、**imp1 仅 3** | 已证实：量表饱和，作为排序信号几乎没有区分度。`mem_save` 的默认值和 bugfix 惯例都偏高 |
| M2 | `cited_count / injection_count` | 31/151 行 cited > injection（如 #91 注入 0 次、引用 4 次），按项目算"比率"可达 1.03–1.5 | 这是设计使然：`injection_count` 只统计 query-conditioned face（`hook-memory.mjs:533-541` 注释）。但**任何人直接相除都会得到大于 1 的"引用率"**。建议对外只展示 `citation_surface_log` 口径，或给列改名 |
| M3 | 分 face 引用率 | `citation-stats` 的 per-face 表列出了 error-recall / PreToolUse / FYI / UPS 四个 face，**没有 SessionStart（Key Context + Key Events）**，而后者是注入量最大的 face（平均约 6k 字符/会话） | 已证实：体积最大的 face 没有采纳率读数。transcript 口径下 SessionStart 的 (session, id) 引用率为 36/339 = 10.6%，最近 7 天 9/114 = 7.9% |
| M4 | 各 face 采纳率（transcript 口径，本项目主线程，去重 (session, id)） | PreToolUse 75/107 = **70.1%**；FYI 7/46 = 15.2%；error-recall 28/245 = 11.4%；SessionStart 36/339 = 10.6% | PreToolUse 最有效；另外三个 face 大部分注入没有被用上。**注意**：PreToolUse 的读数同样被 B2 的 n/a 抬高，真实采纳率更低（待验证） |
| M5 | 产品口径 vs transcript 口径 | 产品 7 天 error-recall 19.2%（46/239，全部项目）；transcript 本项目 7 天 6.1% | 总体不同，不可比。但两者都说明 error-recall 是低效 face |
| M6 | 语料规模 | 活跃 observation 共 134 条（8 个项目），本项目 57 条；D#14 的重开门槛是约 500 条且对比对 ≥200 | 已证实：多项评测被"语料太小"卡住。与此同时 events 有 3,776 行，却没有质量闸门，不能直接当语料用 |
| M7 | bugfix-shape 保存提示 | 注入 114 次，之后 30 次工具调用内出现 save 的只有 21 次（18%） | 待验证：这些 save 里也有与提示无关的例行保存，所以提示的真实转化率 ≤18% |
| M8 | 评审回报的"声明"准确率 | 12 次 claims-lens 评审共核查 556 条声明，**FALSE 71 条（12.8%）**；单次在 7%–26% 之间，没有下降趋势 | 已证实：commit body、CHANGELOG 和注释里的计数、因果说法持续漂移。这不是代码缺陷，但每次发版都要多一轮修正（按提交标题关键词粗分："retract/correct" 类 22 个，评审驱动的 37 个） |

---

## 5. 做得好的部分（避免矫枉过正）

- **发版链路稳定**：CI 74/75 绿，Release 44/45 绿；schema-skew、native binding 自愈等从 dogfood 中发现的问题都有闭环。
- **独立评审（defect-lens + claims-lens）确实有效**：几乎每轮都能抓到 P1/P2，包括修复本身引入的缺陷（例如 P3-21 连续三轮）。在发版节奏这么快的情况下，它是主要的安全网。
- **PreToolUse 注入的采纳率约 70%**，证明"与当前文件绑定"的召回是有价值的。
- 缓存命中率 99.3%。长上下文的主要成本是 cache read，而不是重复写缓存。

---

## 6. 优化建议（按收益 / 成本排序）

| 优先级 | 建议 | 收益依据 | 验收 / 测量方式 | 改动级别 |
|---|---|---|---|---|
| **P1** | 修 B1：`isReadOnlyCommand` 剥掉开头的 `cd … &&/;` 段，并补全只读动词 | 55% 的 Bash 命令受影响；本会话误报 6 次以上 | `error-recall-live-replay.mjs` 前后两臂背靠背跑，只读命令触发数 → 0，真实失败触发的名集不变 | L1–L2 |
| **P1** | 修 B2：解析 `#NN n/a`，不 promote、不 boost，单独计数 | 26% 的提及属于否定语境；最常"被引用"的行里就有 n/a | `citation-live-replay.mjs` 输出 applied / n/a / bare 三栏；构造一个 n/a 夹具，变异后必须变红 | L2 |
| **P1** | Key Events：暂停在 SessionStart 注入 events（或只注入人工 / `mem_save` 来源的条目）；同时修摘要器的输入，排除变异探针窗口、子代理空闲窗口和工具失误，并要求教训引用窗口内 agent 的原文诊断 | 30 条样本中 2 条属实、16 条错误；662 次注入、0 次读取 | 修复后重抽 30 条，用同一套标签复核（ACCURATE 占比应显著高于 6.7% 的下界）；开关两臂比较 SessionStart 的引用率（先补 M3 的读数） | **L3**（改变 SessionStart 注入 = LLM 可见行为） |
| **P1** | pre-commit 按 `git write-tree` 复用绿灯：agent 刚在同一棵树上跑过全量并通过，就跳过 `npm test` | 提交命令中位数 44 s、合计 4.35 h，与 agent 自己的全量 run 重复 | 记录 tree-hash → 结果，只有完全相同的 tree 才跳过；变异一个文件后 hash 变化，必须重跑 | L2（改 `scripts/pre-commit.sh`） |
| **P2** | 修 B3：更新 `adopt-content.mjs:92` 与 `schema.mjs:61/366`，并按实体扫一遍所有拷贝 | 面向模型的过期行为声明 | `git grep "importance −1"` 等实体扫描为 0；adopt 渲染快照测试 | **L3**（adoption 文案） |
| **P2** | 给 `citation-stats` 补 SessionStart face 的读数（M3），并停止对外展示 cited/injection 比率（M2） | 最大的注入 face 当前没有采纳率 | per-face 表新增一行；构造已知答案的夹具断言 | L2 |
| **P2** | 上下文预算：约 30 万 token 时主动 `/clear`，依靠 v6.10 的结构化交接续上，不再等到 60 万+ 再手动 compact | 49% 的请求 >300k；compact 每次 66–135 s | 统计每个会话的峰值上下文和 compact 次数 | 流程 |
| **P2** | 压缩常驻文件：`MEMORY.md` 索引行改成一句话 hook（目标 ≤10 KB，细节回到各自文件）；`[mem] episode flushed` 簿记行不再注入给模型（仍写 activity） | 起始上下文 76k 中常驻文件占约 73 KB 字节；flush 簿记注入 864 次 | 首个请求的上下文 token 数，前后对比 | L1（记忆文件）/ L3（flush 行：LLM 可见） |
| **P2** | 子代理 brief 模板加三条：①最终报告用中文（或"由主线程转述成中文"）；②报告 >6 KB 时用 heredoc 写到 scratchpad；③沙箱模板 `SBX=$(mktemp -d …); … rm -rf "${SBX:?}"` | 英文回复中 24.6% 出现在子代理消息之后；§8 拦截里 62 次来自子代理 | 英文回复率、§8 拦截数，按周统计 | 流程 |
| **P3** | `vitest.config` 设置 `cacheDir` / `TMPDIR`，或让 agent 统一用 `npm test`，覆盖 `npx vitest run` 路径 | 今天仍新增 60 个 ssr 目录 | 跑一次全量后 `ls -d /tmp/*/ssr` 数量不变 | L1 |
| **P3** | 等 CI 改成后台 `gh run watch`（`run_in_background`），不再用 `sleep` 轮询 | sleep 81 次、1.4 h | sleep 调用数 | 流程 |
| **P3** | commit body 和 CHANGELOG 不写可推导的计数（测试数、文件数），改写"判据 + 推导命令"（与记忆 #210 的结论一致） | 声明 FALSE 率 12.8%，其中计数类占多数 | claims-lens 的 FALSE 率 | 流程 |
| **P3** | 发版节奏：同一天的多个修复合并成一个发版（09-06 一天 10 个） | 每次发版都要付出两个评审子代理 + CI + Release 的成本，并增加用户侧 schema-skew 的暴露面 | 发版数 / 周 | 流程（需要你拍板） |

---

## 7. 局限与待验证

- **因果未隔离**：长上下文与语言漂移、规则违反之间只证实了共现；Opus 5.5 与漂移的关系只有 1 天 40 个样本。
- **B1 的误报率**：45 条样本是人工粗标，只用于说明误报存在；准确比例需要用 replay 尺子测。
- **B2 的否定语境识别**：用的是关键词窗口（±80 字符），会漏掉部分否定表述，也可能误伤少量"n/a 以外"的用法。26.1% 是近似值。
- **引用率**的两种口径总体不同（§1），所以本文不给"真实采纳率"的单一数字。
- **测试耗时**：09-25 的 51 s 可能受并行子代理影响，没有做背靠背测量。
- **transcript 中的计数**会被注入文本污染（例如 MEMORY.md 里就写着 "push protection"），所以 §3.6、§3.7 只引用了用户消息或评审回报原文中的事件，没有用 grep 次数。

---

## 附录 A —— events 抽样逐条证据（30 条）

| id | type | label | evidence |
|----|------|-------|----------|
| 9 | feature | PARTLY | The test was created (b3b07d8, 17:52:43 Write). The lesson says it "exposed that source metadata entries are incomplete or malformed / prevents silent data corruption". That is inverted: the 4 empty `domain_tags` were deliberate, and the TEST was relaxed (b3b07d8:tests/install-metadata.test.mjs:14-20). The file was deleted the next day in 944f216, so the event is also stale. |
| 10 | bugfix | GENERIC | The title matches the 17:53:21 Edit that added the `domain_tags` comment. The lesson ("keep fixture comments synchronized with validation logic") is boilerplate about a comment written in that same edit. The file has been gone since 944f216. |
| 188 | refactor | PARTLY | The real work was v4.0.4 (2a3cbb2): it rejected an audit finding and kept the `compressed_into`-only filter in fast-summary on purpose ('completed' is the session's own history, F4), and added a scope guard. The event calls this a clarity refactor and reports a "corrected scrub-record import path". The actual import edit REMOVED `liveObsFilterSql` (14:15:43), and the key decision is not mentioned. |
| 263 | refactor | PARTLY | Real: aa91357/32f6b9d prune settings.json hook entries that point at deleted scripts; `isMemHook` moved to lib/hook-prune.mjs. The lesson calls `isMemHook` a "stale registry entry" and says the harm was reviewer confusion and dead code. The actual harm was every Skill() call printing errors and arming the broken-install marker. |
| 308 | bugfix | WRONG | MEM_QUIET_HOOKS was not touched: it is still in hook.mjs, lib/quiet-scope.mjs and scripts/user-prompt-search.js. The event came from a historical comment the agent read at 17:51:16 ("Note v2.82.0: removed MEM_QUIET_HOOKS gate"). The real work was 6905493: install honours MEM_NO_AUTO_ADOPT, and the suite no longer rewrites this repo. |
| 579 | bugfix | ACCURATE | tests/sandbox/phaseB-npm.mjs 02:09:26 edit: the breakage check now counts only NEW hook-errors, because the pre-existing entry came from the probe's own empty-stdin fire (02:08:56 TEXT). The lesson holds. It misses the bigger finding in the same window (0/400 overlap, the probe did not overlap). |
| 644 | bugfix | ACCURATE | 05:22:51 TEXT: the coverage-scope guard modelled vitest-4 semantics (absolute path + contains), while vitest 5 matches relative paths (node_modules/vitest/dist/chunks/index.B89dZ0-N.js:14911-14925). Fix fb6a8b9. The lesson is right, but it leaves out that the cause was the version change and not "non-obvious semantics". |
| 646 | bugfix | WRONG | "Mutation test baseline corruption manifests as md5 hash mismatches" never happened. The md5 check was the restore check and printed "restored ok" (05:25:13). "M1 mode" is really mutation arm M1 (revert to the old allowlist). There was no corruption. |
| 725 | bugfix | PARTLY | Real: a backtick in a SQL comment ended the template literal (08:31:07 `node --check` SyntaxError hook-optimize.mjs:219). The lesson says it "causes silent failures". Wrong: it is a loud SyntaxError that went unseen only because tests ran before the edit (memory: feedback-evidence-predates-last-edit). The backtick-in-comment mechanism is missing. |
| 818 | bugfix | WRONG | Nothing broke the suite and there were no non-ASCII characters. At 19:05:50 the agent deliberately mutated scripts/hook-launcher.mjs to check the new manual-fallback-sync guard, saw it go RED, and restored it byte-identical (md5 1577347f... both). "`bash -n script.mjs`" makes no sense for a .mjs file. |
| 868 | bugfix | PARTLY | Real fix: in 582f1f8 (lib/timeline-core.mjs SOURCE_ROW_SQL) a P#/S#/E# anchor resolved globally and moved the timeline into another project, and user_prompts reaches its project through sdk_sessions. The lesson is only a style note ("extract SQL to a constant, single branch with OR logic") and does not mention project scoping. |
| 892 | bugfix | WRONG | No schema wiring error existed. At 21:17-21:20 the agent ADDED `force` through saveObservation, mem-cli, server.mjs and tool-schemas.mjs. The only failures were its own python patch anchor ("supersedes anchor not found") and a text-scan guard matching a new comment (tests/save-observation-supersedes.test.mjs D#201). |
| 1020 | bugfix | WRONG | "HANDLED_TOOLS gains tool lacking in matcher" is the name of mutation arm G1 (15:10:36), not a fix. The real fix, 50d3ded: NotebookEdit carries `notebook_path`, not `file_path`, plus a JSON-then-LIKE escape for win32 paths. The guard was restated because the refactor replaced the inline literal it scanned for. |
| 1106 | bugfix | WRONG | Inverted. FILE_PROBE_CAP already existed and was RAISED from 3 to 6, and candidates were re-ranked (1bf34c3), because the cap cut recall (28.0% of prompts lost every reachable file, down to 4.0% after the fix). There was no uncapped loop and no performance issue. |
| 1217 | discovery | WRONG | The activity was a defect-lens reviewer subagent mutation-probing import-jsonl. "Hash-based errors (359cf74...)" is a sha256sum it printed for mutants mutC/mutD, not an error. /repo/alpha.mjs, x.mjs and nb.ipynb are test-fixture strings (tests/import-jsonl.test.mjs:412) that leaked into file_paths. |
| 1254 | bugfix | WRONG | Nothing about async waits. At 07:16:28 the agent ADDED a NotebookEdit twin case to tests/integration-scenarios.test.mjs as a wiring guard for 179766a (extractFilePaths ignored NotebookEdit's path). It passed on the first run and was then mutation-verified. |
| 1278 | bugfix | PARTLY | Real bug 65c26b8: pre-tool-recall writes spent the UPS face's per-session budget (the `count` was shared, not partitioned by writer), so the fix added `upsCount` and moved the cap after the freshness check. The lesson says "double-increment when code paths converge" and prescribes a "counter was 0" assertion, which is the wrong mechanism and the wrong fix. "M1 test" is a mutation arm from the unrelated A2 work (07:34). |
| 1380 | bugfix | WRONG | There was no formatter error about "removed blocks". The 10:41:58 failure was the Edit tool's "String to replace not found", because prettier had already made the import multi-line. 'removed' is an action value in claudemd.mjs. The advice to clear prettier/node_modules caches is invented. |
| 1381 | refactor | WRONG | The event says "No behavioral changes; comments only". False: 10:43:02-10:43:23 were fixes (P2-1 removed-action reporting; P2-3 `unadopt --all` entering never-adopted projects and rmdir'ing `.claude/`, a regression), shipped as be8588a. The tmp dirs were a probe sandbox. |
| 1692 | bugfix | PARTLY | The switch happened (5f876a6). The real reason (tests/get-deferred-miss-once.test.mjs:25-27) is that execFileSync returns stderr only when it throws, so the exit-0 case dropped the stderr note under test. The lesson swaps in a vague "streams / intermediate state / streaming I/O". |
| 1725 | refactor | PARTLY | benchmark/hook-latency.mjs was a NEW ruler created at 17:04:19 (54fce6f), not a refactor for readability. The `buildArms().map` change (17:05:14) moved the premise check to where it is true: the session-start arm had deleted the buffer the earlier arm wrote. |
| 1726 | discovery | WRONG | The transcript (17:11:37 memory edit) says concurrency was NOT the cause: "串行也救不了" (serializing would not have helped). A ruler's own later arm ate the earlier arm's evidence, and the fix was to sample the premise where it holds. The event tells readers to isolate "at the mutation boundary" against concurrent mutation, which is the opposite. |
| 1827 | bugfix | WRONG | Nothing was fixed in search-scoring.mjs. At 21:03-21:06 the defect-lens subagent confirmed its extracted tree matched HEAD (cli/install/search-scoring) and wrote docs/audits/20260914-preship-defect.md. "Pinning logic / token-reduction patches" is invented. |
| 3088 | refactor | WRONG | This was a behaviour change, not column reordering. 18:31:00-18:32:12 added the `UNCONSUMED_HANDOFF_SQL` predicate to 8+ session_handoffs queries and replaced DELETE with consume-marking (eac4fb0). Preceded by 0633227 (handoff was always empty). "No behavioral change" is false. |
| 3123 | bugfix | PARTLY | Real, 85ce15c: replayed prompt text carrying `#`/`##` could forge section headers, so `safeText` now defangs headings, and only a marker followed by whitespace at a token boundary counts as one (keeps `#42`, `C#`, `D#216`). The lesson claims "greedy stripping breaks downstream parsing". The defect was missing neutralisation, not over-stripping. |
| 3259 | bugfix | WRONG | There was no product schema mismatch. At 22:03:47 the claims-lens subagent's throwaway probe test (tests/zz-atx-population.test.mjs in an extracted tree) used the wrong table name `deferred_items` and a nonexistent `created_at` column, and fixed its own fixture. |
| 3396 | bugfix | PARTLY | Real, D#53: doctor's stale-temp scanner had no age gate and warned about in-flight episode files that cleanup refused to delete (13:27:53 repro), fixed with the shared classifier lib/doctor-stale-temp.mjs. "Anchors" were the agent's python patch script ("all 5 anchors applied"), and nothing failed silently. Only the fresh+stale fixture advice is real. |
| 3470 | discovery | PARTLY | This was recovery after a deliberate reset and a /compact. Pre-reset commits were recovered from the object store and repaired files came from scratchpad/repaired/ (16:42:28-16:44:02). There was no git "corruption". The lesson is a generic checklist. The vitest-timeout part is real (e12564b). |
| 3604 | bugfix | WRONG | The ESLint error was `preserve-caught-error` (no `cause` on the rethrow) at lib/verify-apply-core.mjs:425 (10:26:51). There was no malformed JSON.stringify, bracket or trailing-comma problem. The "source-files.mjs" edit was a /mem:verify to /verify comment rename. |
| 3756 | bugfix | WRONG | No logic was fixed. ee384f5 is test-only: it adds a `bare.mjs` vs `foo.mjs/` case so the trailing-separator guard can go red (mutation at 19:01:41). The real rule (lib/file-edge-match.mjs:141-145) strips TRAILING separators, then asks for an internal one. "Multiple distinct separators" is false. |

---

## 8. 修复进展（2026-09-25，分支 `fix/readonly-cd-prefix-and-na-cites`）

| 项 | 状态 | 提交 | 证据 |
|---|---|---|---|
| B1 只读豁免被 `cd` 前缀绕过 | **已修** | `68b44cd` | 在本机 26,406 条未被标记失败的 Bash 结果上做新旧背靠背重放：isHardError 893 → 765，静默 151 条（逐条确认都只读），新增 23 条（都是首个动词为读取、后面跟着真实运行的复合命令）；6 个变异全部被杀 |
| B2 `#NN n/a` 被计为引用 | **已修** | `00effdc` | 本机 1,877 次 `#NN` 提及中 313 次是否决，抽样 30/30 属实；`citation-live-replay` 前后两臂：pretool 65.8% → 46.0%，error_recall 19.1% → 15.3%，fyi 19.8% → 14.2%，ups 10.3% → 9.0%（这是**口径断点**，不要跨它做差）；6 个变异全部被杀 |
| B3 adopt 文案过期 | 待授权（L3：LLM 可见文案） | — | — |
| B4 Key Events 注入 | 待授权（L3：SessionStart 注入行为） | — | — |
| pre-commit 复用绿灯 | 待授权（改提交门禁） | — | — |

**修复过程中新发现的相邻问题（未修）**：PreToolUse 注入的是 `E#116`（event），随后 ack 指令却要求引用 "#116"，而裸 `#NN` 属于 observation 命名空间，两者是不同的记忆。模型照做就会把引用记到另一条 observation 上。已证实于本会话的注入原文。
