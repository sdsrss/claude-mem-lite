# 同类开源项目调研与优化建议（2026-09-27）

- **树**：`main` @ `7272c56`（v6.15.0）。**语料**：本机 `~/.claude-mem-lite/claude-mem-lite.db`，只读，2026-09-27 读取。
- **性质**：建议书，不是实现记录。文中每条建议都写了**先要跑哪把尺子、什么结果就停手**。按本仓测量教条，没过尺子的建议就只是假设。
- **方法**：
  - 4 路并行调研：Claude Code 同类插件、通用 agent 记忆框架与论文、上下文工程与检索技术、本仓已有能力与已否决方案的盘点。
  - 调研原稿（约 200 KB）只放在本地 scratchpad，没有入库。
  - 本文引用的关键外部断言都由主线程二次核对过原文，核对方式写在 §8。
  - 本仓现状都给出 `file:line`，读取时间是本次。

---

## 0. 结论先行

**定位判断**：Claude Code 现在自带 auto memory（原生记忆）。它负责偏好、反馈、项目状态和外部引用这四类，索引是 `MEMORY.md`，每次会话开始加载前 200 行或 25 KB。官方文档明确说它**不存**这些东西：

> "Claude skips anything it can derive from the codebase, such as architecture, file paths, or debugging fixes."
> — code.claude.com/docs/en/memory

它不存的，正是本插件做得最好的部分：
- 编辑前按文件召回教训：PreToolUse 面，近 7 天引用率 56.2%，是所有注入面里最高的；
- 失败时召回过去的修法；
- bugfix / decision 教训；
- 跨会话交接。

所以，**差异化方向是"在动手的那一刻，给出正确的教训"，不是做一个通用记忆库**。下面的建议都围绕这条主线挑选：不追求多，只选有证据、和现有架构贴合、能补上已知短板的。

| # | 建议 | 补哪块短板 | 证据强度 | 成本 | 先跑的尺子 |
|---|---|---|---|---|---|
| A1 | 注入文本改成事实陈述，并给每个注入面加 10,000 字符上限的守卫 | 注入可能被当成提示注入；超长时会静默截断 | 强（官方文档原文） | 小 | 各注入面按会话随机分两组测引用率；上限守卫测试 |
| A2 | 子代理记忆改由 SubagentStart 注入；功能开关迁到 `userConfig` | 子代理目前没有任何记忆（原生记忆也不加载进子代理） | 强（官方文档） | 小–中 | 按调度派发量统计覆盖面；子代理面引用率 |
| B1 | 代码感知子词索引：拆 camelCase，并修 `events_fts` 的 `tokenchars` | 标识符查询召回不到 | 中（本仓探针 + 一篇预印本） | 中 | 先建一套标识符夹具（必须能先测出失败），再跑 `denoise-ab` 和 `error-recall-suite` |
| B2 | 教训改成结构化记录：必填"修法"槽、代码锚点、验证结果 | 自动教训准确率只有 2/30（D#69） | 中–强（多篇编码记忆基准） | 小（只改 prompt） | D#69 的 30 条重标注流程；**排在 D#101 之后** |
| B3 | 文件级教训的 60 天硬截断，改成按"最近一次被验证使用"计时 | 2026-11-04 起会开始静默驱逐教训 | 中（机制和多个同类项目一致） | 小 | 截断触发前的到达率探针 |
| C1 | 采纳信号不再依赖模型配合：错误是否复发、教训里的标识符是否出现在后续编辑中 | 引用率更多反映模型是否守规矩；D#98（回复里出现 `#NN`） | 中 | 中 | **先数分母**；和 `#NN` 信号做同批次对照 |
| C2 | 锚点存在性校验（Copilot 的即时校验做法） | 记忆过期 | 待定：v6.12.0 已否决过相近的信号 | 小 | **先拿已有的 118 条人工标注集判定区分度，过不了就不做** |
| D1 | 捕获 PostCompact 的 `compact_summary` | D#95（模型摘要输入不足） | 强（API 确实存在），但覆盖面小 | 小 | 已实测：只覆盖 12/209 = 5.7% 的会话 |

**明确不采纳**（§5 有证据）：
- 向量 / embedding 检索分支；
- 知识图谱存储；
- 让 LLM 原地改写或删除记录；
- 直接拒绝 Read（claude-mem 的做法）；
- 在 hook 注入面上做 PRF（伪相关反馈扩展）或 cross-encoder 重排；
- 用 trigram 分词代替中文 bigram；
- 默认开启遥测；
- 按"矛盾"自动 supersede（把旧记录标为已取代）；
- 拿 LoCoMo 分数选方案。

---

## 1. 我们现在在哪里（现状基线，均注明读取时间）

### 1.1 语料与注入面

| 量 | 值 | 来源 |
|---|---|---|
| 活跃 observation（`liveObsFilterSql` 口径） | **166** 条，分布在 8 个项目；表内共 181 行 | sqlite3 只读，2026-09-27 |
| events / user_prompts / session_summaries | 4,293 / 819 / 343 | 同上 |
| importance 分布（活跃行） | 1 级 3 条 · 2 级 95 条 · 3 级 68 条（基本饱和，区分不出重要性） | 同上 |
| 最老的 observation | 2026-09-05 19:28 UTC（库在那天重建过） | 同上 |
| 各注入面引用率（近 7 天） | PreToolUse **56.2%**（68/121）· FYI 15.3%（22/144）· error-recall **13.1%**（54/412）· UPS 6.7%（1/15） | `citation-stats`，2026-09-27 |
| PreToolUse 的"命中"里只在正文里提了一下、没有实际采纳的比例 | 76.4%（420/550） | `rulers.md` 第 24 行 |
| 回复里带 `#NN` 引用的比例 | 7.9% 的最终回复（137/1741），平均每条 4.5 个 id | D#98 |
| SessionStart 注入平均长度 | 5,966 字符/次（50 次） | `docs/audits/20260925-200912-session-history-analysis.md` 第 91 行 |
| hook 冷启动 | pre-tool-recall 32.8 ms · user-prompt-search 46.5 ms · session-start 99.1 ms | `rulers.md` 第 64 行（2026-09-14） |

最大的一个面是 error-recall（412 次注入），引用率却只有 13.1%。质量最好的是 PreToolUse。LLM 自动写的教训在 30 条随机抽样中只有 2 条准确（D#69，v6.14.0 已修，等 D#101 复核）。

### 1.2 已测量并否决、本文不再推荐的方案

完整清单 35 条，已按来源核对。这里只列和外部调研直接冲突的几条。如果要重提，按本仓规则必须在**两组**上重跑对应的尺子。

| 方案 | 结论 | 出处 |
|---|---|---|
| TF-IDF 向量分支 + RRF 融合 | v6.0.0 删除：词汇不匹配套件 R@10 0.3407 → 0.3018（−11.4%），P95 延迟 +72% | CHANGELOG v6.0.0；`findings.md` 1076–1094 |
| 本地神经 embedding | 安装包 +137 MB，超过 50 MB 上限，已回退 | CHANGELOG（agentmemory 对比那一轮） |
| 在 FTS 索引上做 Porter 词干 | P@10 −0.054，净负 | `findings.md` 1581–1621 |
| 给 deep search 的 OR 回退加三种闸门 | 都否决：抑制改写后的 OR 回退，R@10 从 0.7383 掉到 0.3962 | `findings.md` 1030–1053 |
| 自动的"过期记忆"信号（文件变了 / 后续提交碰过这个文件） | 和随机猜差不多；单次模型判定只有 36% 对 | CHANGELOG v6.12.0 |
| 标识符优先的词截断（D#169） | 只命中命令词的首位结果比例从 21.3% 升到 33.4%（差了 13 个点） | CHANGELOG；`rulers.md` 第 34 行 |
| 把会话摘要挪到 SessionEnd | 不做：覆盖率受限于输入，不受限于触发时机 | `findings.md` 1648–1671 |

---

## 2. 同类项目全景（每个只保留值得学的那一点）

Star 数和版本号由调研代理在 2026-09-27 通过 `api.github.com` 读取。

| 项目 | 核心做法 | 值得学的一点 | 对本项目 |
|---|---|---|---|
| **Claude Code 原生 auto memory** | 由主模型写入带类型的 md 文件；`MEMORY.md` 是索引，先看索引再按需取正文 | 边界清楚：不存调试修复；不加载进子代理 | 定位依据（§0）；A2 |
| **thedotmack/claude-mem**（94,754★，v13.28.0） | Bun worker + SQLite FTS5 + 可选 Chroma；每次工具调用都走 LLM | 按文件召回时算"具体度"（改过的文件加分，只涉及少量文件的记录加分）；索引行上标注取回成本 | B3 的排序参考；它的 Read 拒绝做法不采纳（§5） |
| **jpcarranza94/tool-engrams**（alpha） | 教训绑定到工具调用模式；热路径上没有 LLM；后台根据 transcript 判定 有用 / 没用上 / 噪声 | ① 一条教训不在产生它的那个会话里回显；② 平滑质量分 q=(u+1)/(u+n+2)，至少判 3 次且 q<0.5 才静默；③ **不因为很久没触发就降权**（"Punishing rarity is backwards"） | C1、B3 |
| **codenamev/claude_memory** | FTS5 + sqlite-vec；让主模型自己当"观察者"，不额外调 API | 出现 ≥2 次才升级为事实（防止一次性误记固化）；decision 类必须带"because"；预览下次会注入什么 | B2 的门槛思路 |
| **obra/episodic-memory** | 归档原始对话；通过子代理检索 | 检索结果留在子代理里，只把结论带回主上下文；超大的单条消息整条丢弃，而不是截断 | §5 的备选（deep search 误报过多的问题） |
| **mem0**（2026 版） | **去掉了 ADD/UPDATE/DELETE 调和步骤，改成只追加**，理由是那一步"慢，而且是上下文被毁掉的地方" | 只追加 + 用排序处理过时 | 印证本仓 `superseded_at` 不做破坏性修改的路线（§5） |
| **Zep / Graphiti** | 双时间轴知识图谱；让旧边失效而不删除 | 失效而不删除 | 已有对应物；图谱不采纳 |
| **ACE（ICLR 2026）** | 生成 → 反思 → 策展；LLM 只提出增量，由确定性代码合并；有 helpful/harmful 计数 | 整份重写一次，上下文从 18,282 token 塌到 122 token | C1；给无人值守的 LLM 路径提个醒 |
| **GitHub Copilot Memory** | 记忆带代码位置引用；使用时即时校验，有效就刷新，冲突就改写 | 厂商自己的 A/B：PR 合并率 83% → 90% | C2（需要先判定） |
| **Codex CLI memories** | 后台两阶段抽取 + 合并 | 用户剩余的 rate limit 低于阈值时跳过记忆任务 | 可参考（每天无人值守的 optimize） |

**与编码直接相关的评测证据**（通用对话记忆基准不能直接拿来做决定，见 §5）：

- **VibeMemBench**（arXiv 2609.23570，2026-09-20，未经同行评审）。已按 HTML 原文核对：
  - 四个现成记忆系统，在 12 组"求解器 × 系统"组合里有 11 组**没能超过不用记忆的基线**。
  - 231 组失败里，**69.3%（160 组）是"记录形式退化"**：指令污染 40.0%、修法写得过于泛化 18.1%、混入工具或 shell 噪声 10.0%、记录格式里没有修法字段 8.8%。
  - 效果最好的参考记录约 5 行，字段是"bug 类别 / 根因 / 修法模式 / 可复用教训"。
  - 同一条记录，在基线为 0 的目标上让 55.2% 的组合变好且没有损失，在基线已经满分的目标上让 25.7% 的组合变差。
  - 五个求解器的增益在 +1.1 到 +4.5 pp 之间，但**置信区间全部跨过 0**。
- **SWE-ContextBench**（arXiv 2602.08316）：约 217 token 的摘要，效果好于约 25.6K token 的完整轨迹（解决率 34.34% vs 27.27%）。
- **DreamBench-SWE**（arXiv 2608.20664）：确定性的逐字事件记忆 89/180，和最好的混合方案 95/180 **没有显著差别**（p=0.518）。这支持本仓"词法检索 + 少用 LLM"的路线。

读法：在编码场景里，**记录写成什么样、注入多少，比用什么检索算法更决定成败**。这和本仓 D#69 的发现（自动教训 2/30 准确）是同一个问题。

---

## 3. 建议详述

每条统一写：问题 → 证据 → 本仓现状 → 设计 → 尺子与停手条件 → 风险与实施级别。
按全局规范，改到注入文本、shipped prompt 或工具描述的，属于 **LLM 可见元数据**，一律 L3。

### A1 · 注入文本改成事实陈述，并给每个注入面加 10,000 字符上限守卫

- **问题**：宿主会把命令式、自称"系统"的注入文本当作可疑内容。另外单个字段超过 1 万字符时，宿主会静默降级。
- **证据**（官方 hooks 文档原文，本次 curl 核对）：
  - "Write the text as factual statements rather than imperative system instructions … Text framed as out-of-band system commands can trigger Claude's prompt-injection defenses, which causes Claude to surface the text to you instead of treating it as context."
  - "A hook's `additionalContext`, `systemMessage`, and `initialUserMessage` strings, and its plain stdout, are capped at 10,000 characters"。超过后，宿主把正文写进文件，只给模型路径和前 2,000 字符预览，并且"Claude Code doesn't ask it to"去读那个文件。
- **本仓现状**：
  - `scripts/pre-tool-recall.js:528/543/834` 和 `scripts/post-tool-recall.js:98` 的前缀是 `[mem] PreToolUse recall — system-injected context, continue your planned action:`。这正好是"自称系统、带祈使句"的写法。
  - 仓库里**没有任何针对 1 万字符输出上限的守卫**。全仓 grep `10000` 只找到 `hook.mjs:3016` 对入库 prompt 的截断。
  - SessionStart 平均 5,966 字符，最大值没测过。
- **设计**：
  1. 前缀改成来源标签加事实陈述，例如 `Past lessons recorded for utils.mjs (claude-mem-lite #230, 2026-09-21):`，去掉 "system-injected" 和 "continue your planned action"。
  2. `lib/hook-stdout.mjs` 已经是"每个进程只输出一份 JSON"的唯一出口，在这里统一加字段长度预算：超出时按行裁剪，并在末尾写明被裁掉的 id。不交给宿主去落文件。
  3. 加一个测试：为每个注入面渲染最坏情况的输入，断言长度 < 10,000。
- **尺子与停手条件**：
  - 前缀措辞会影响引用率，不能拿前后两个时间段比（教条 2）。做法是在同一时间段内**按会话随机分成两组**（用已有的 `{ counterfactual: true }` 管线），用 `citation-live-replay.mjs` 按注入面比较。
  - 新写法的 PreToolUse 引用率不低于旧写法（两组置信区间重叠也算通过），就发布。
  - 上限守卫不涉及取舍，直接做，但要做变异验证：删掉裁剪，测试必须变红。
- **风险与级别**：改 PreToolUse 前缀，动的是全仓引用率最高的注入面，所以必须走 A/B。属于 **L3**（LLM 可见文本）。

### A2 · 子代理记忆改由 SubagentStart 注入；功能开关迁到 `userConfig`

- **问题**：子代理目前拿不到任何记忆。
- **证据**（官方文档原文）：
  - "The main conversation's auto memory isn't loaded into subagents"（memory 文档第 527 行）。
  - SubagentStart 的 `additionalContext` 是 "String added to the subagent's context at the start of its conversation, before its first prompt"。宿主会去重、保留子代理的 prompt cache。
  - 插件的 `userConfig` 会以 `CLAUDE_PLUGIN_OPTION_<KEY>` 形式导出到 hook 进程，并出现在 `/config` 界面里。
- **本仓现状**：`scripts/pre-agent-inject.js:5-16` 用 PreToolUse(`Agent|Task`) 的 `updatedInput` 改写整段子代理 prompt，默认关闭（`CLAUDE_MEM_SUBAGENT_INJECT`）。因为要原样回写宿主传来的整段 prompt，风险大，所以一直没开。
  - 子代理面冻结语料的引用率：24.5%（12/49，`rulers.md` 第 24 行）。
  - 原生记忆和插件记忆现在都够不到子代理，所以这是**空白，不是重复**。
- **设计**：
  - 新增一个 SubagentStart hook（matcher 为空，覆盖所有类型的代理），内容沿用 `buildSubagentInjection()`（`hook-memory.mjs`），输出改走 `additionalContext`。`updatedInput` 路径保留一个版本作为回退，然后删除。
  - 默认值：在引用率被证明不低于旧路径之前，保持关闭。开关通过 `userConfig` 暴露（如 `subagent_inject`），环境变量继续作为覆盖手段。
  - 其他默认关闭的开关也逐步迁移，先迁用户最常问的那几个。
- **尺子**：
  - 覆盖面：`pre-agent-inject` 已经有遥测，先数近 30 天的派发量。
  - 效果：子代理面的引用率，由已有的子代理衰减链路统计。
- **风险与级别**：
  - `hooks/hooks.json` 和 `install.mjs` 里 `settings.json` 的那一份必须同步改（`tests/audit-silent-20260814.test.mjs` 会比对）。
  - `userConfig` 的键是严格校验的，写错一个键整个插件就加载失败，所以必须跑 `npm run validate:manifests`。
  - 属于 **L3**（新增注入面，并改动 manifest）。

### B1 · 代码感知子词索引：拆 camelCase，并修 `events_fts` 的 `tokenchars`

- **问题**：标识符查询搜不到对应的记录。
- **证据**：
  - 本次用本仓 better-sqlite3 做的探针，行文本是 `fixed preToolRecall in scripts/pre_tool-recall.js`：

    | 查询 | `observations_fts`（默认 unicode61） | `events_fts`（`tokenchars '_-'`） |
    |---|---|---|
    | `tool` | 1 | **0** |
    | `recall` | 1 | **0** |
    | `toolrecall`（camelCase 的一部分） | **0** | **0** |

  - 外部证据：同时索引整词和拆开的子词，在 CoIR-Go 上 BM25 从 0.309 升到 0.563（arXiv 2605.18561，预印本，中等可信）。
- **本仓现状**：
  - 写入端已经有同构的先例：`lib/observation-write.mjs:157` 把 CJK bigram 追加进 FTS 文本。camelCase 没有对应处理。
  - `lib/lesson-idents.mjs` 能抽出标识符，但**没有把它拆开的部分拿去建索引**。
  - `schema.mjs:814/1607` 把 `events_fts` 的分词规则定成 `tokenchars '_-'`。结果是占多数的自动事件（4,293 行）在路径片段上完全搜不到。
- **设计**：
  - 写入端：仿照 `cjkBigrams`，把 camelCase / PascalCase / 字母数字边界拆出的子词追加进已索引的文本，整词保留。
  - 查询端：`sanitizeFtsQuery` 做同样的拆分，并按 OR 组合。
  - events：不改分词器（改分词器要重建 FTS 表，属于 schema 变更），改为同样追加拆开的子词。
  - 已有的行靠一次 `fts-check rebuild` 回填。
  - 不拆 URL、疑似密钥或哈希串：拆分放在 scrub 之后，并且只处理 `lesson-idents` 认定为标识符的 token。
- **尺子与停手条件**：
  1. **先红**：在 vocab-mismatch 套件里新增一组"用标识符的一部分去查"的夹具，旧代码必须先测出失败（教条 5：一把尺子必须能说"不"）。
  2. 用 `denoise-ab.mjs` 看精度（`precision_hard_negatives`），用 `error-recall-suite.mjs` 看命令词污染。
  3. 停手条件：精度的下降超过该套件的分辨率 1/n；或者 error-recall 中"只命中命令词"的首位结果比例上升。D#169 就是因为把罕见 token 推到前面，这个比例从 21.3% 升到了 33.4%，子词拆分有同样的风险。
- **风险与级别**：多出来的子词会稀释 BM25 的 IDF。**L2**：需要做一次 FTS 重建，但 DDL 不变。

### B2 · 教训改成结构化记录：必填"修法"槽、代码锚点、验证结果

- **问题**：LLM 自动写的教训准确率很低。D#69 抽样 30 条：2 条准确、11 条部分正确、16 条错误。
- **证据**：
  - VibeMemBench：69.3% 的失败来自记录形式；有效的记录约 5 行，有固定字段；"记录格式里没有修法字段"单独就占了 8.8%。
  - SWE-ContextBench：约 217 token 的摘要，效果好于约 25.6K token 的完整轨迹。
  - Letta Skill Learning：给反思过程加上验证器反馈，比只看轨迹多 +6.7 pp。这个数只有厂商自己报告过。
  - MemGuard / Voyager：只收录经过验证的经验。
- **本仓现状**：
  - `hook-llm.mjs:997` 的 prompt 要求 `lesson_learned` 从 DIAGNOSIS 行里原样引用至少 4 个词（D#69 加的"接地"规则），除此之外是自由文本。
  - `tool-schemas.mjs:363` 只写了 "≤500 chars (for bugfix: root cause & fix …)"。
  - 没有修法槽，没有锚点，没有验证结果。
- **设计**：
  - `lesson_learned` 仍然是一个 TEXT 列，不改 schema，但固定为四行模板：`症状 / 根因 / 修法 / 下次先查`。
  - 确定性校验：
    - "修法"一行必须含有至少一个标识符、路径或命令，用 `lesson-idents` 判定。否则整条教训丢弃；这条规则同时拦住"修法写得过于泛化"。
    - 注入时每条教训不超过 ~400 字符。
  - 验证结果：由确定性代码从本段 episode 窗口里摘出最后一次测试 / lint / 构建命令的退出码，写成一个标签 `pass | fail | none`，不经过 LLM。`none` 的教训给一个较低的先验分。
  - `mem_save` 手动保存也提示同一个模板，但不强制。人写的记录不做拦截。
- **尺子与停手条件**：
  - 沿用 D#69 报告里的 30 条重标注流程（ACCURATE 比例）。要超过 D#101 复核得到的基线，才算有效。
  - 顺序：**必须等 D#101 复核完成后再改 prompt**。否则两次改动的效果叠在一起，分不清各自贡献。
- **风险与级别**：可能丢掉一些真实但格式不合规的教训。停手线：召回损失要可测，可复用 D#69 报告里"接地规则同时丢掉了 2 条 ACCURATE"的那种统计方法。属于 **L3**（shipped prompt 模板）。

### B3 · 文件级教训的 60 天硬截断，改成按"最近一次被验证使用"计时

- **问题**：老的文件级教训会被一刀切掉，不管它是否仍然有用。
- **证据**：
  - tool-engrams："a memory's last-surfaced time is old precisely when its trigger hasn't fired … Punishing rarity is backwards"。
  - Generative Agents：recency 从**最后一次被检索**开始计算。
  - Copilot Memory：校验通过并被使用时刷新时间戳。
  - 这几家的机制方向一致。
- **本仓现状**：
  - `scripts/pre-tool-recall.js:617` 写的是 `const cutoff = Date.now() - 60 * DAY_MS; // 60-day lookback to avoid surfacing ancient observations`，按 `created_at_epoch` 硬截断。observations 和 events 两条查询都用它（第 699 和 746 行）。
  - 这个 60 天**没有测量依据**。
  - 本仓已经有更细的门槛：每一条"观察 × 文件"都有 `miss_streak` 衰减（D#78，`observation_files`）。反复注入却从不被用上的边会自己退场。
  - 最老一条 observation 创建于 2026-09-05，所以**这道截断从 2026-11-04 起才会第一次触发**，目前影响为 0。
- **设计**：计时改为 `COALESCE(最近一次被引用或被验证使用的时间, created_at_epoch)`，过期由 `miss_streak` 负责，60 天只作为"从来没用上过"的上界。
- **尺子与停手条件**：
  - 做一个到达率探针：统计"只因为截断被排除、但 `miss_streak = 0` 的边"有多少（教条 3：必须写明统计的是哪些行）。
  - 在 2026-11-04 之前把探针准备好；截断第一次触发后的一周内读数。
  - 数量为 0 就关掉这条建议。
- **风险与级别**：
  - 召回池变大。上游的 `LIMIT` 限定的是能不能被取到，不是排序（本仓不变量）。新进来的老行怎么排序必须写清楚，见记忆 `feedback-reachability-without-ranking`。
  - 属于 **L1–L2**。

### C1 · 采纳信号不再依赖模型配合

- **问题**：
  - 现在的反馈闭环完全靠模型在回复里写 `#NN`。所以引用率有一半在衡量"模型是否服从要求它引用的那条指令"。
  - PreToolUse 的命中里，76.4% 只是在正文里提到了一下，没有实际采纳。
  - 这还带来一个副作用：7.9% 的用户可见回复里夹着 `#NN`（D#98）。
- **证据**：
  - tool-engrams 的做法：不以工具调用成功作为采纳，因为"Most calls succeed, so crediting on success would reinforce any memory that happened to surface"。它把没用上和噪声分开计。
  - 其他参考：ACE 的 helpful/harmful 计数；Memory Worth 双计数器，在合成数据上 ρ=0.89，静态 importance 是 0.00。
  - RoMeRL 提出的"memory-reward trap"：只能记功给真正被用上的那一条，不能记给同批注入的所有条。
- **本仓现状**：
  - `lib/citation-tracker.mjs` 扫描 `#NN`。
  - `lib/lesson-idents.mjs` 已经有 `extractIdents()` / `presentIdents()`，但只用在默认关闭的 SALIENCE=bind 路径上。
  - `scripts/prompt-search-utils.mjs` 已经有 `extractErrorSignature()`。
  - 也就是说，两种不依赖模型配合的信号，**原料都已经在仓库里**。
- **设计**：新增两种可以确定性判定的"采纳"。
  1. **error-recall 面**：注入修法 #N 之后，同一会话接下来 N 次 Bash 调用里，同样的错误签名没有再出现，并且同一条命令后来退出码为 0。
  2. **PreToolUse 面**：注入教训 #N 之后，同一文件的下一次 Edit / Write，其 `new_string` 里出现了这条教训的标识符。
  - 只记功给这一条 id。两个计数器按 Laplace 平滑，得到一个**有上下界**的排序系数，和现有的引用系数并列进 `MULT_EXPR`。不写 `importance`（D#179/D#198）。
  - 等新信号和 `#NN` 信号的一致性被测出来之后，再去掉 adoption steering 里"要求模型写 `#NN`"那一句（关闭 D#98）。
- **尺子与停手条件**：
  1. **先数分母**：近 30 天里，"注入之后同一会话内有后续可判定动作"的次数，error-recall 面和 PreToolUse 面分开数。任何一个面不到约 200 对，这个面就先不做。
  2. 在同一批 transcript 上同时算新信号和 `#NN` 信号，列出列联表：两者都有 / 只有其中一个 / 都没有，并**逐条列出名单**（教条 4：计数只是警报，名单才是证据）。
  3. 用 `multiplier-discrimination.mjs` 证明新系数确实生效，并且量级正确。不能用 `benchmark:gate`，它看不到这些系数。
- **风险与级别**：
  - 这是相关性，不是因果。模型可能不看教训也能自己修好。
  - 所以新信号只调排序，不驱逐任何行。
  - Stop 每次都会重扫整份 transcript，所以每个会话要有自己的幂等键（本仓不变量）。
  - 属于 **L2**（新增排序系数；去掉 `#NN` 指令那一步属于 L3）。

### C2 · 锚点存在性校验（先判定，后决定）

- **问题**：记忆会过期。
- **证据**：
  - GitHub Copilot Memory 已按官方博客原文核对：记忆带着代码位置引用，模型用之前 "verifies the citations in real-time"；发现冲突就重写这条记忆；校验通过并使用后，重新存一次以刷新时间戳。
  - A/B：PR 合并率 83% → 90%，p<0.00001。这只是厂商自己的数据，没有第三方复现。
- **和本仓已否决方案的区别**：
  - v6.12.0 否决的是"**变更类**信号"（文件改过、后来有提交碰过它），结论是和随机猜差不多。
  - Copilot 用的是"**存在类**信号"：教训里写的那个标识符或字符串，现在还在不在文件里。这两个信号不一样，但都属于"代码锚点"一类，**不能想当然地认为这次会有效**。
- **设计（只有判定通过才做）**：
  - B2 落地后，教训里自带锚点（修法行里的标识符）。
  - PreToolUse 注入时，文件内容反正已经读进来了，顺手查一下锚点是否还在。
  - 不在，就打上 `(anchor gone — verify)` 标签，不降权、不删除。
- **尺子与停手条件**：
  - 先在 v6.12.0 已有的 118 条人工标注集上离线测：12 条过期、16 条部分过期，过期基础率约 10%。看"锚点消失"这个信号能不能区分出过期记忆。
  - **精度要达到基础率的 2 倍以上才实施，否则关闭这条建议。**
  - 标注集还显示：10 条有日期的过期记忆，全部在保存后 1 天内就过期了。所以如果信号有效，它最该在"刚保存后的几次注入"时起作用。
- **风险与级别**：
  - 读文件会增加 hook 延迟。PreToolUse 预算 3 秒，目前实测约 33 ms。
  - 属于 **L3**（改变注入文本）。

### D1 · PostCompact 的 `compact_summary`：成本为零，覆盖面也小

- **证据**：官方文档写明 "PostCompact hooks receive `trigger` and `compact_summary`"，内容就是宿主自己生成的对话摘要。
- **分母（本次实测）**：本机全部项目 **209 份 transcript 里只有 12 份发生过 compaction（5.7%）**，本项目 4/64。
  - 在 1M 上下文的模型下，用户大多用 `/clear` 结束会话，而不是等 compaction。
  - 所以它对 D#95 的贡献只有这个量级。**外部调研把它列为"高优先"，本文据此降级。**
- **设计**：新增 PostCompact hook，把 `compact_summary` 存成独立的摘要来源。优先级：助手自己的四段式报告 > compact_summary > 模型摘要 > 标题。不调任何 LLM。
- **级别**：**L2**（新增 hook，并需要和 `settings.json` 那一份同步）。

---

## 4. 实施顺序与依赖

```
现在即可（和其他改动无关）  A1 的上限守卫 · §6 的小修
        │
等 D#101 复核完成           B2（改 prompt）──→ C2 的离线判定（依赖 B2 带来的锚点）
        │
可以并行                    A1 的措辞 A/B · A2 · B1（先建出能测出失败的夹具）
        │
先数分母                    C1（按注入面，分母 <200 就不做）
        │
有日期的                    B3：2026-11-04 之前准备好探针，触发后一周内读数
        │
零成本、随时                D1
```

和现有 deferred work 的关系：
- B2 → D#69 / D#101；
- C1 → D#98，并对 D#14 有帮助（给排序系数补上真实的用户信号）；
- D1 → D#95（部分）；
- C2 → D#59（为那条"未验证"提示提供一个机器可判定的前置条件）。

**实施前按本仓发布规则**：每条单独提交；`benchmark:gate` 看不到这些排序系数，所以系数类改动一律用 `multiplier-discrimination.mjs` 验证；用两个时间段的数据做差来归因，视为无效证据。

---

## 5. 明确不采纳

| 方案 | 谁在用 | 不采纳的理由 |
|---|---|---|
| 向量 / embedding 检索分支（包括 sqlite-vec + model2vec / EmbeddingGemma） | claude-mem、episodic-memory、claude_memory、mem0、Hindsight | 本仓已经做过 A/B 并删除（R@10 −11.4%，P95 +72%）；本地模型会让安装包大 137 MB。外部证据：没有任何编码记忆基准做过 BM25 对比向量的消融；在 LongMemEval_M 上，纯 FTS5 的 NDCG@5 是 0.692，已经超过它文中列出的所有已发表基线（SelRoute，预印本）。只有出现一个专门测"改写 / 同义表达"的留出集、并且能证明 FTS 召回不到时，才重新评估，而且只能做成按查询类型路由的可选分支。 |
| 知识图谱存储、PPR、社区检测 | Zep/Graphiti、cognee、HippoRAG 2、Mem0g | 每次写入都要 LLM 抽取实体；在编码场景里没有证据。Mem0 自己的论文里，图谱版本总分只多 1.6，p95 延迟却从 1.44 s 升到 2.59 s。 |
| 让 LLM 原地改写或删除记录 | 早期 Mem0、A-MEM 的"记忆演化"、Dynamic Cheatsheet | Mem0 在 2026 年自己去掉了这一步；ACE 记录过一次整份重写，从 18,282 token 塌到 122 token。本仓已经在走"只追加 + `superseded_at`"的路线，应继续坚持。无人值守的合并或压缩路径，最好改成"生成新版本 → 审核 → 替换"（Anthropic Managed Agents 的 Dreams 就是这样："The input store is never modified"）。 |
| 直接拒绝 Read，改为返回时间线 | claude-mem 的 File Read Gate | 改变了宿主热路径上的行为，而且可能让模型带着过期记忆去理解当前文件。本仓已经有不阻塞的 file-intel 提示，效果和风险两头都更稳。 |
| 在 hook 注入面上做 PRF / RM3 扩展、cross-encoder 重排 | 若干通用框架 | 2026 年的两篇论文都测出约 0 或负收益（AgentIR：PRF 让 Hit@5 −0.012）；小而主题集中的语料正是 PRF 最容易跑偏的场景。本仓的 PRF 只在 `mem_search` 管线里使用（surface-form 形式），不上 hook 注入面，维持这个边界。 |
| 用 trigram 分词代替中文 bigram | am-memory | FTS5 trigram 匹配不了 2 个字的中文词（官方文档："fewer than 3 unicode characters do not match"）。本仓用户最近 400 条 prompt 中，中文占 88%（352/400，CHANGELOG 第 8563 行，D#137）。 |
| 按"矛盾"自动 supersede | mcp-memory-service | 它的 PR #1320 报告：一个库里被隐藏的 615 条里有 574 条是被误伤的，抽查 10 对里有 9 对其实互不相关（这条信息来自搜索摘要，可信度低）。本仓的 supersede 需要显式的 token 或者 LLM 判定，维持现状。 |
| 默认开启遥测；worker 不做鉴权 | claude-mem | 对一个主打"轻量"的替代品来说是声誉风险。本仓没有常驻进程，应继续保持。 |
| 用 LoCoMo 选方案 | 多数厂商 | 已被审计出答案键 6.4% 有错；它的评判模型会把 62.81% 故意答错的回答判对；同一个系统（Zep）先后出现过四个不同分数。本仓继续以 LongMemEval 词法基线加仓内自己的尺子为准。 |
| 在 SessionEnd 里跑 LLM 任务 | — | 官方文档：默认预算 1.5 s，并且 "Timeouts set on plugin-provided hooks don't raise the budget"。 |

---

## 6. 顺手可做的小修（不单列建议）

- `.claude-plugin/plugin.json` 第 4 行的 `description` 还写着 "Hybrid FTS5 + TF-IDF search"，但向量和 TF-IDF 引擎在 v6.0.0 已经删了。这段文字对市场页面和 LLM 都可见，属于 **L3**，按发布流程随下一个版本一起改。
- 注入预览：`claude-mem-lite context` 已经用和 SessionStart 相同的构建函数（`mem-cli.mjs:1782`），但不能区分 `startup|clear|compact`，也不输出长度。可以加 `--source` 参数和字符数，参考 claude_memory 的 `show --source`；这也是 A1 上限守卫的人工入口。
- 预算感知：每天无人值守的 `optimize` 可以学 Codex 的 `min_rate_limit_remaining_percent`。检测到当前只能走 `claude -p` 这条通路、并且最近有限流报错时，当天跳过。需要先确认 haiku-client 能不能读到限流信号，确认之前只作为观察项。

---

## 7. 这份建议书自己的局限

- **语料小**：166 条活跃记忆，离 D#14 设定的重开门槛（约 500 条 + 约 200 对对照）还差三倍左右。凡是改排序的建议（B3、C1），在本机上都**只能证明"系数确实生效"，证明不了"对用户有用"**。
- **外部证据的时效**：VibeMemBench、DreamBench-SWE、MemGuard、REALM 都是发布不到一个月的预印本；VibeMemBench 自己的置信区间都跨过 0。本文用它们来支持"记录形式重要"这个**方向**，没有拿它们的具体增益数字做决定。
- **厂商数字**：Copilot 的 +7 pp、Letta 的 +6.7 pp、claude-mem 声称的"75–97% 节省"，都没有第三方复现，文中都已标注。
- **本文没有做的事**：没有改任何代码，也没有跑任何 A/B。每条建议的"尺子"一节，就是实施前要做的第一步。

---

## 8. 来源与核对

**主线程二次核对的原文**（2026-09-27）：
- 用 curl 取 `https://code.claude.com/docs/en/hooks.md`，grep 到以下原文：factual-statements 与 prompt-injection 那段（第 1035 行）、10,000 字符上限（第 939 行）、PostCompact 的 `compact_summary`（第 3101 行）、SubagentStart 的 `additionalContext`（第 2382 行）、SessionEnd 1.5 s 预算且插件超时不抬高预算（第 3356–3358 行）。
- 用 curl 取 `https://code.claude.com/docs/en/memory.md`，核对了"skips … debugging fixes"（第 467 行）、auto memory 不加载进子代理（第 527 行）、200 行 / 25 KB（第 519 行）。
- 用 curl 取 `https://code.claude.com/docs/en/plugins-reference.md`，核对了 `CLAUDE_PLUGIN_OPTION_<KEY>`（第 444 行）。
- 用 WebFetch 取 `https://arxiv.org/html/2609.23570`（VibeMemBench），核对了 160/231 = 69.3%、各子类比例、5 行四字段、55.2% / 25.7%、置信区间跨 0。
- 用 WebFetch 取 GitHub 博客 "Building an agentic memory system for GitHub Copilot"，核对了 citations、即时校验、83% → 90%、p<0.00001。
- 用 curl 取 `https://platform.claude.com/docs/en/managed-agents/dreams.md`，核对了 "The input store is never modified"（第 15 行）。
- 用 curl 取 `https://docs.mem0.ai/migration/platform-v2-to-v3.md`，核对了 "Single-pass ADD-only"（第 19 行）；在 mem0 博客 "the token-efficient memory algorithm" 中核对了 "That reconciliation step was slow, and it was where context got destroyed"。
- 本仓：FTS5 分词探针（better-sqlite3，`:memory:`），以及上文所有 `file:line`。

**其余来源**（由调研代理读取；可信度已在正文中标注）：

- Claude Code / Anthropic：https://code.claude.com/docs/en/sub-agents · https://code.claude.com/docs/en/context-window · https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool · https://platform.claude.com/docs/en/managed-agents/dreams · https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents · https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents · https://www.anthropic.com/engineering/writing-tools-for-agents
- 同类插件：https://github.com/thedotmack/claude-mem · https://docs.claude-mem.ai/file-read-gate.md · https://github.com/jpcarranza94/tool-engrams · https://github.com/codenamev/claude_memory · https://github.com/obra/episodic-memory · https://github.com/mem0ai/mem0 （含 `integrations/claude-code-plugin`）· https://docs.mem0.ai/migration/platform-v2-to-v3 · https://github.com/supermemoryai/claude-supermemory · https://github.com/basicmachines-co/basic-memory · https://github.com/doobidoo/mcp-memory-service · https://developers.openai.com/codex/memories.md
- 论文：ACE https://arxiv.org/abs/2510.04618 · ReasoningBank https://arxiv.org/abs/2509.25140 · Zep https://arxiv.org/abs/2501.13956 · Nemori https://arxiv.org/html/2508.03341v1 · SWE-ContextBench https://arxiv.org/html/2602.08316v3 · DreamBench-SWE https://arxiv.org/html/2608.20664 · Subtask-level memory https://arxiv.org/html/2602.21611v1 · MemGuard https://arxiv.org/abs/2608.21867 · Memory Worth https://arxiv.org/abs/2604.12007 · RoMeRL https://arxiv.org/abs/2608.02508 · LongMemEval https://arxiv.org/abs/2410.10813 · SelRoute https://arxiv.org/html/2604.02431 · BM25 代码分词 https://arxiv.org/abs/2605.18561 · Doc2Query-- https://arxiv.org/abs/2301.03266 · AgentIR https://arxiv.org/pdf/2605.25092 · Generative Agents https://arxiv.org/abs/2304.03442
- 评测可靠性：LoCoMo 审计 https://dev.to/penfieldlabs/we-audited-locomo-64-of-the-answer-key-is-wrong-and-the-judge-accepts-up-to-63-of-intentionally-33lg
