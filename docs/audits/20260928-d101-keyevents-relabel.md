# D#101 — Key Events 部署后 30 条重标（D#69 + a3dbf2d 之后）

> 测量日期 2026-09-28（DB 备份取于 2026-09-28T11:07:49Z）。只读：未改动任何源码或线上 DB，未提交。
> 程序依据：`docs/audits/20260926-v6.14.0-d69-keyevents-report.md` 的 "Owed: post-deploy 30-event relabel (procedure)" 及其 Addendum；标签定义依据 `docs/audits/20260925-200912-session-history-analysis.md` §4.4.1。
> 标注者：一个只读子代理（本报告作者），不是写 D#69 / a3dbf2d 的那个代理。

## 1. T0 的推导

- 采用 `T0 = 2026-09-27T06:12:24Z`（epoch ms `1790489544000`），即 `~/.claude/plugins/cache/sdsrss/claude-mem-lite/6.15.0/package.json` 的 mtime（`2026-09-27 06:12:24.384 +0000`）。这是 6.15.0 在本机装入插件缓存的时间。
- 6.15.0 包含 `a3dbf2d`：`git merge-base --is-ancestor a3dbf2d v6.15.0` 成立，`v6.14.0` 不包含。
- 交叉核对"新版本上的第一个 SessionStart"：
  - 会话 `5c215fa5` 的最后一条记录在 06:12:42Z。它的 transcript 只出现 `claude-mem-lite/6.13.5` 路径（15 处）。
  - 会话 `92bf5b69` 的第一条记录在 06:12:51.841Z，出现 `claude-mem-lite/6.15.0` 路径 18 处，没有旧版本路径。
  - 因此 install 时间和第一个 SessionStart 相差约 27 s。两者之间没有任何 event：总体中最早的是 E#4298，写于 06:27:55Z。所以取哪一个作 T0，总体不变。
- 总体覆盖两个插件版本。本机插件缓存里只有 6.13.5、6.15.0、6.18.0 三个版本，6.16.x / 6.17.x 从未装入。
  - 6.15.0：会话 `92bf5b69` … `7862a70f`，截至 19:19Z。
  - 6.18.0：`installed_plugins.json` 记录的 `lastUpdated` 为 2026-09-27T19:18:38Z；会话 `1de9c0ff` 起用它。
  - 两个版本之间，`git diff v6.15.0 v6.18.0 -- hook-llm.mjs lib/episode-input-filter.mjs utils.mjs hook-episode.mjs` 为空。`hook.mjs` 的差异只在 Stop / SessionStart / UPS 路径，改动行里没有 `episode|diag|desc|agent_id`。所以样本内的摘要器和采集路径是同一份代码。

## 2. 总体（population）

对 DB 备份执行：
`SELECT id FROM events WHERE project='dev--claude-mem-lite' AND superseded_at_epoch IS NULL AND created_at_epoch > 1790489544000`

| 口径（2026-09-28 备份） | 行数 |
|---|---|
| 总体 | **124**（id 4298–4649，最晚一条写于 2026-09-28T03:07:03Z） |
| 其中 importance ≥ 2 | **78**（imp2 75 + imp3 3） |
| importance 1 | 46 |
| T0 之后被 supersede 的 | 0 |

这与 team-lead 在 2026-09-28 测得的 124 / 78 一致。

## 3. 抽样方法

- 脚本：`<scratchpad>/d101/draw.mjs`。它逐字复制了 `benchmark/key-events-input-replay.mjs` 的 `rng()`（mulberry32，第 275–285 行）和抽样循环（第 381–391 行）。
- 做法：
  1. pool 取上面的 SQL 结果，按 `id` 升序排列（与 ruler 的 `ORDER BY id` 相同）。
  2. 用 `draw = rng(20261001)`，循环执行 `i = floor(draw()*pool.length); picked.push(pool.splice(i,1)[0])`，直到取满 30 条。
  3. 结果按 id 升序排列。
- 抽到的 30 个 id：4300 4301 4350 4351 4355 4358 4359 4368 4375 4385 4401 4411 4413 4418 4453 4487 4491 4493 4503 4546 4556 4558 4562 4602 4608 4610 4613 4615 4641 4649。
- 样本里 importance ≥ 2 的 20 条，importance 1 的 10 条。抽样没有分层；imp ≥ 2 子集就是这 30 条里自然落入的 20 条。

## 4. 取证方法

1. **窗口重建**（`<scratchpad>/d101/tree/d101-replay2.mjs`，运行在 `git archive HEAD`（1d9aa50）解出的树上，而不是正在被他人编辑的工作区）：
   - 用 ruler 的 `collectStream` 读取 T0 之后 7 个会话的主线程和子代理 transcript。
   - 按已发布的规则切窗口：主线程调用全部保留；子代理调用只保留编辑了项目目录下文件的那些（ea8b61d）。`hook.mjs` 的 `extractFileTargets` 取文件，`extractDiagnosis` 区分作者行和输出行（`diagOut`）。
   - 按时间（flush 后 −5…600 s）加文件集合 Jaccard 匹配每条 event。
   - 30 条中 26 条 Jaccard ≥ 0.92（25 条为 1.00，dt 11–33 s）。E#4401（0.13）、E#4411、E#4418、E#4610（0）这 4 条没有匹配到，改为按 event 时间直接读 transcript 定位。
   - ruler 自带的旧批处理（`key-events-input-replay.mjs` 的 `replayWindows`）在这个总体上只有 2/30 文件集合完全相同，所以没有采用。
2. **标注证据**：对每条 event，读窗口时间段内的 transcript（`<scratchpad>/d101/view.py`，含 assistant 文字、工具输入、工具输出），再读对应提交（`git show`）。每条的证据见第 5 节的表。
3. **lesson / narrative**：`body = lesson_learned || narrative`。判断依据有三条：
   - body 是否与窗口的某条诊断行共享 4 词串（`quotedLines`，即 D#69 的 grounding 规则）；
   - 是否具有 narrative 的形态（"Investigated… No code changes made"）；
   - 与 importance 是否一致：没有 lesson 的非 decision 行会被压到 importance 1。
4. **输出引用（Addendum 要求的列）**：给出两种读法。
   - **机制**：`quotedLines(body, episodeOutputDiagnosis(window), 1, {anyWord:true})`，也就是 a3dbf2d 的规则；
   - **人工**：lesson 引用的那句话，在本窗口中是否**只**以工具输出的形式出现过。
5. **标签的操作化**（§4.4.1 的定义只有一行，这里写明我的判定线，方便以后复核）：
   - ACCURATE：标题和 body 的每条实质断言都有证据支持。
   - PARTLY：标题属实，但 body 至少有一条实质断言错误、夸大或机理不对；refactor/"Clarify" 类标题实际对应新增行为的，也归这里（沿用 §4.4.1 形状 5）。
   - WRONG：标题的核心断言是假的（没发生，或方向相反）。
   - GENERIC：没有可核验的具体内容，只是套话或复述目录列表。
   - 仅 event_type 与实际不符（例如把 bench 写成 bugfix）、而标题本身没有声称修复的，不单独改变标签，在证据列注明。

## 5. 逐条结果

列说明："形态"为 L = lesson、N = narrative 回退；"输出引用"为 机制 / 人工；"—" 表示不适用（没有 lesson）。

| event | type | imp | 形态 | 输出引用 | 标签 | 证据（一行） |
|---|---|---|---|---|---|---|
| 4300 | discovery | 1 | N | — | PARTLY | 会话 92bf5b69 06:28:48–06:28:57：从 code.claude.com hooks.md 读到 "SessionEnd hooks have a default timeout of 1.5 seconds"，标题属实。但 body 说"examining temporary build artifacts""session focused on understanding existing hook behavior"，实际是在为 OSS 调研文档核对第 3 份报告的断言 |
| 4301 | discovery | 1 | N | — | PARTLY | 窗口写的是 209a8bd 的 OSS 提案文档。文档说原生记忆不存"architecture, file paths, or debugging fixes"；body 列的"session history, tool recalls, observation chains, context budgets"是编造的类别 |
| 4350 | feature | 2 | L | 否 / 否 | ACCURATE | worktree 子代理 agent-a6cc29ff 08:14:53 写入 identifier_parts fixture，并接入 denoise-ab。提交 64687af → main 04a3088，提交说明写 recall arm 与 precision 作为 cost arm 分开 |
| 4351 | feature | 2 | L | 否 / 否 | ACCURATE | 同一子代理 08:16:14 写入 tests/identifier-subwords.test.mjs，RED 11 failed。"unicode61 indexes preToolRecall as the single token" 与 06:29:05 的 FTS 探针（`toolrecall 0`）一致。该 B1 实现后来被回退（e831b51），但这不影响这条的真实性 |
| 4355 | refactor | 2 | L | 否 / 否 | PARTLY | lesson 引自新增的 B1 注释，属实。但窗口是新增 `identifierParts`/`identifierSubwords`，并删掉一条启发式规则（新行为），标题却写成 "Clarify … scope & heuristics"，类型是 refactor |
| 4358 | bugfix | 2 | L | 否 / 否 | WRONG | 标题 "Fix sed command syntax error"，但窗口 08:24:14–08:24:16 没有 sed 语法错误：sed 改的是 import 行，随后的 RangeError 来自测试误用 `insertObs` 的返回值。body "build the corpus through the real save path" 只是引用了一段注释碎片 |
| 4359 | discovery | 1 | N | — | PARTLY | 主线程 08:24:19–08:24:23 grep 遍历型测试和 vitest exclude，目的是找出 worktree 让 pre-commit 变红的原因（随后 AskUserQuestion，d01833c）。列出的行号属实，但"Verified CLI path reference"说错了意图 |
| 4368 | bugfix | 1 | L | 是 / 是 | WRONG | 08:31:38 的失败是 A1 分组改了 framing 文字，`/system-injected/` 断言失配，修法是测试接受两种 arm（5bd66e4）。lesson 把测试名 "injects size + summary on first Read of a large file with no lessons" 反读成"只有 lesson 存在时才注入" |
| 4375 | discovery | 1 | N | — | PARTLY | `buildSubagentInjection` 在 hook-memory.mjs:718，属实。`formatSubagentContext` 在 lib/task-imperative.mjs:42，不是 "around line 89"。窗口内提交了 5bd66e4（08:35:13–08:36:21），body 却说 "No code changes made" |
| 4385 | bugfix | 2 | L | 否 / 否 | ACCURATE | 4ce4cb0：cutoff-reach-probe，测试注释 "A probe that cannot say NO is not a probe… the fresh-row case below must read zero"。lesson 忠实于注释和变异验证（08:56:07 两条变红）。类型应为 bench/feature |
| 4401 | bugfix | 2 | L | 否 / 否 | ACCURATE | 3baace6 P3-8：09:29:34 让 `classifyRecallFraming` 只看 framing 行，注释 "Only the framing line itself counts… must not relabel the session" 与 body 一致。窗口未匹配（Jaccard 0.13），按时间直接读取 |
| 4411 | discovery | 1 | N | — | PARTLY | 会话 503b48c0 10:05–10:13：发布 v6.16.0。Release 绿、npm 200 属实。但 caa0966 上 CI test(26) 红，原因是 1 ms 时钟 tick，由 0d858d8 修复；body 把这段写成"examined release history"，漏掉 CI 变红，还说 "13 direct commits"（实际 v6.15.0..caa0966^ 为 14）。窗口未匹配 |
| 4413 | decision | 2 | L | 否 / 否 | ACCURATE | 会话 c195ff9b 10:30:10 起草 issue #31 回复："Counterfactual flag — agreed, defer it… a guard test that fails if `recordSearch` is referenced outside `server.mjs` (a text scan… is enough)"。lesson 加了一句 "rather than runtime checks" 的泛化（边界判定，见 §7） |
| 4418 | discovery | 1 | N | — | PARTLY | 10:44:20 写入 memory feedback-no-global-no-auto-adopt.md，标题属实。body 末句 "if a full run shows only this failure, the per-test pattern is working as designed" 与文件原意（"check the shell env before treating it as a regression"）不同。窗口未匹配 |
| 4453 | bugfix | 2 | L | 否 / 否 | ACCURATE | 3c60192："every surface still booked what it RENDERED…"，修为只登记 cap 保留下来的行。与 body 一致 |
| 4487 | bugfix | 1 | L | 是 / 是 | PARTLY | 13f822c P3-2（allowlist 按形状放行，回退后仍然绿）和 P3-7（source 标签写死）都是真的。lesson 把两者揉成"hardcoded source attributes become stale guards that silently pass wrong data"。被引用的测试名是上一个窗口 12:36:46 写的，本窗口只在 12:38:26 变异运行的输出里见到 |
| 4491 | decision | 2 | L | 否 / 否 | ACCURATE | ea4d795："Its premise … holds only when the assistant's final reply carries Done / Not done sections"，于是回退 D#95，`CLAUDE_MEM_SKIP_SUMMARY` 保留 |
| 4493 | bugfix | 2 | L | 否 / 否 | GENERIC | 标题（v6.17.0 tag 前回退 D#95）属实（ea4d795）。lesson 是流程套话（"orthogonal audit perspectives … revert-before-tag is safer"），没有写出回退的真实原因（前提只对维护者自己的报告格式成立） |
| 4503 | bugfix | 2 | L | 否 / 否 | PARTLY | 67afcfd：修法是第一个 item 按 head 行登记、后面的 item 必须完整显示才登记，是不对称的。lesson 说 "booking logic must apply consistently to all items, not just the first"，机理说反了 |
| 4546 | bugfix | 2 | L | 否 / 否 | WRONG | 窗口 15:18:12 只改了注释（4135cad），把"未闭合标签尾巴会跨行"记为**仍未修**的缺口，正则没动，随后发布 v6.17.1。event 却写 "Fix…" 并给出 "constrain regex to newline boundary" 的修法 |
| 4556 | feature | 2 | L | 否 / 否 | ACCURATE | 10a4408（D#121）："a later reply under 400 chars does not replace an existing floor"，`TAIL_MIN_REPLACE = 400` |
| 4558 | discovery | 2 | L | 否 / 否 | ACCURATE | 10a4408 / dded768："closing replies ran 15–187 chars, task replies 801+"，所以阈值取 400 |
| 4562 | bugfix | 1 | L | 是 / **否** | ACCURATE | cdde46e：先对原始回复做 scrub，再做 flatten（此前 flatten 改动了 secret 内部的字符）。被引用的短语 "the final reply as a Done floor" 是本窗口 python patch 写入的注释（作者行），同时出现在该命令输出的 desc 片段里。机制按输出行把它压到 imp 1，人工判定不是"只见于输出" |
| 4602 | bugfix | 3 | L | 否 / 否 | ACCURATE | 36a4dbe：D#130 的 4 个模式对构造输入呈二次复杂度，"Every stored field goes through scrubSecrets on a synchronous hook path, and Stop's timeout is 5 s"。测试注释写的是 "40 alternating labelled values drive scrubSecrets to its 32-pass cap" |
| 4608 | bugfix | 2 | L | 否 / 否 | PARTLY | 2de57e0：标签可以穿过行内 markdown 被识别。前半句忠实于 fast-summary.mjs 的注释。后半句"must distinguish config syntax (table rows…) from prose"不对：表格行是注释里写明的"accepted gap"（831k 行里只有 1 行，无法测误报率） |
| 4610 | discovery | 2 | L | 否 / 否 | ACCURATE | 19:17:26 写入 memory feedback-growth-probe-blind-to-constant.md（407→3,387 ms；8.3 s / 500k），lesson 是它的忠实摘要。窗口未匹配 |
| 4613 | bugfix | 2 | L | 否 / 否 | WRONG | c8c2cfc（#36）：IDF 被 clamp 后，孤立 obs 命中得 −0.25，排在所有行**之后**（排名过低）。标题 "rank too high" 和 body "inflates single-hit relevance" 都把方向说反了 |
| 4615 | bugfix | 2 | L | 否 / 否 | PARTLY | c8c2cfc：修法是低于 1e-3 的孤立行直接记 −1，也就是**绕开**按原始量级分档（band）的规则。"no magnitude signal" 属实，但 "must be scored by band rule, not raw score magnitude" 把 band 当成了解法 |
| 4641 | discovery | 1 | N | — | GENERIC | 20:56:40 执行了 `ls docs/audits`。body 只复述文件命名规律（属实），外加一句 "reveals the project maintains parallel audit records"。窗口里实际做的事（归档两份审查报告、登记 D#138/D#139、派出 delta-lens-6190）都没有写 |
| 4649 | bugfix | 2 | L | 否 / 否 | PARTLY | eed5fda：每个 desc 字段在未闭合的 `<private>` 前**截断**。代理对 surrogate 的保护在 c3833d9 就已存在，不是本窗口修的。"close any opened redaction tags" 与实际机制（截断而不是闭合）不符 |

## 6. 汇总（样本 30 条，seed 20261001，总体为 T0 之后 124 行；2026-09-28 标注）

| 口径 | n | ACCURATE | PARTLY | WRONG | GENERIC |
|---|---|---|---|---|---|
| **importance ≥ 2（成功判据所用子集）** | 20 | **11 = 55.0%（Wilson 34.2–74.2%）** | 5 = 25.0%（11.2–46.9%） | 3 = 15.0%（5.2–36.0%） | 1 = 5.0%（0.9–23.6%） |
| 全部行 | 30 | **12 = 40.0%（Wilson 24.6–57.7%）** | 12 = 40.0%（24.6–57.7%） | 4 = 13.3%（5.3–29.7%） | 2 = 6.7%（1.8–21.3%） |
| importance 1 | 10 | 1 = 10.0%（1.8–40.4%） | 7 | 1 | 1 |
| 输出引用行（人工：只见于输出） | 2 | **0（Wilson 0–65.8%）** | 1（4487） | 1（4368） | 0 |
| 输出引用行（机制：a3dbf2d 规则命中） | 3 | 1（4562）= 33.3%（6.1–79.2%） | 1 | 1 | 0 |
| 基线（2026-09-25，seed 20260925，933 行总体） | 30 | 2 = 6.7%（1.8–21.3%） | 11 | 16 = 53.3%（36.1–69.8%） | 1 |

- **Addendum 的排除**：imp ≥ 2 的 20 行中，按机制和按人工读法都有 0 行引用了只见于输出的行（3 个机制命中都是 importance 1）。所以"排除输出引用行后的 imp ≥ 2 子集"仍是这 20 行，11/20 不变。
- **成功判据**：imp ≥ 2 子集 ACCURATE 的 Wilson 下界为 34.2%，高于 21%。
- **判据对边界判定的敏感度**：imp ≥ 2 中有 4 条 ACCURATE 属于边界判定（4351、4385、4413、4610，见 §7）。
  - 翻 1 条：10/20；
  - 翻 2 条：9/20，下界 25.8%；
  - 翻 3 条：8/20，下界 21.9%；
  - 4 条全翻：7/20，下界 18.1%，低于 21%。
  - 所以结论成立的余量是"最多有 3 条边界判定判错"。
- **保留 lesson 的行**：23/30（76.7%，Wilson 59.1–88.2%）的 body 是 lesson。其中 20 行 imp ≥ 2，3 行因输出引用被压到 imp 1。另外 7/30 是 narrative 回退，全部 imp 1。23 远高于程序里"低于约 5/30 说明引用提示没起作用"的阈值。
- **按窗口形态看**：7 行 narrative 中 ACCURATE 为 0（PARTLY 6、GENERIC 1），它们都在注入阈值以下。
- **子代理来源**：4 行（4350/4351/4355/4358）来自一个 `isolation: worktree` 子代理的编辑窗口，按 ea8b61d 的规则（编辑了项目内文件）被保留。标签为 ACCURATE 2、PARTLY 1、WRONG 1。

这些数字支持什么（不对 `CLAUDE_MEM_SESSION_EVENTS` 下结论）：

- 在会进入注入面的 imp ≥ 2 行上，程序第 6 步定义的判据成立：下界 34.2% > 21%。WRONG 从基线的 16/30 降到 3/20。
- 仍然 WRONG 的 3 行 imp ≥ 2（4358、4546、4613）都**通过了** grounding。它们引用的是窗口里真实存在的作者行（一段注释碎片、一段描述"仍未修"缺口的注释、一个事实正确但方向被读反的注释），错在结论。这与 D#69 报告 "Not done / uncertain" 里的预测一致："grounding 验证的是出处，不是正确性"。
- 输出引用这一类只有 2–3 行，样本太小，无法支撑"放宽 a3dbf2d 的 cap"这一决定：人工读法下 0/2 ACCURATE，Wilson 上界 65.8%。

## 7. 未核验 / 不确定

- **边界判定**（imp ≥ 2 中的 4 条 ACCURATE，决定了上面的敏感度）：
  - 4351："comprehensive"，以及"require custom tokenizer or post-tokenization phrase matching"。实际采用的是写入侧加索引附加文本、查询侧加短语；我判为同一类做法。
  - 4385：类型写成 bugfix，实际是新增 bench 探针；标题没有声称修复，所以不降级。
  - 4413：lesson 多了一句 "rather than runtime checks"，原文没有这层对比。
  - 4610：窗口未匹配，以写入的 memory 文件为证据；没有核实摘要器实际看到的 DIAGNOSIS 行。
- **两处与 §4.4.1 的口径差异**：
  1. 基线由另一个标注者完成，我只拿到一行定义，所以在 §4 第 5 条写明了自己的判定线。两次标注之间可能存在标注者差异，本报告无法量化。
  2. 基线总体（933 行，D#69 之前）与本总体（124 行，D#69 + a3dbf2d 之后，约 21 小时，同一仓库）的工作内容不同。本期多为 review 修复和发版，很多窗口带有提交说明或注释块，可供引用。这可能抬高 ACCURATE 率，与 D#69 的机制无关。本测量没有对照臂，分不开这两者。
- **4 条未匹配窗口**（4401、4411、4418、4610）：按 event 时间直接读 transcript 标注。它们的"输出引用"列是人工读法，没有机制读数。
- **4562 的 cap 过度触发**：被引用的短语在本窗口里既是作者写的注释，又出现在同一命令输出的 desc 片段中。`episodeOutputDiagnosis` 按整行精确匹配来排除作者行，desc 片段与作者行不是同一个字符串，于是被当成输出行。这是单例观察，没有扫总体看有多少行受影响。
- **4487 的变异运行**：被引用行来自 12:38:26 的一次"apply mutation → run → restore"。我的重放给它的标签只有 `test-run`，没有 `probe`，也就是说 D#69 的 probe 过滤没有丢掉它。没有核实这是过滤规则漏判，还是我的重放与线上不同（线上的 entry 标签不落盘）。
- **重放与线上窗口的差异**：
  - 重放用 transcript 的时间戳，不用 hook 的 `Date.now()`；
  - Read 调用不进入重放（沿用 ruler 的约定）；
  - 并发会话共用 episode 缓冲的情况没有建模；
  - 26/30 的文件集合 Jaccard ≥ 0.92，其余 4 条见上。
- **没有做**：LLM 重放；未抽样的 94 行；按 event_type 分层。样本只有 30 行，imp ≥ 2 只有 20 行，各比例区间较宽，见 §6。

## 8. 复现

脚本位于 scratchpad（`/tmp/claude-1000/-home-ai-dev-claude-mem-lite/5d059c59-2d2a-406b-af3b-69358b4508d4/scratchpad/d101/`），不在仓库内：

- `db.sqlite`：`sqlite3 -readonly ~/.claude-mem-lite/claude-mem-lite.db ".backup …"`，取于 2026-09-28T11:07:49Z。
- `draw.mjs`：`node draw.mjs db.sqlite`，输出 `population: 124` 和上面的 30 个 id。
- `tree/`：`git archive 1d9aa50` 解出的树，`node_modules` 为符号链接。
- `tree/d101-replay2.mjs`：`node d101-replay2.mjs <tx 目录> db.sqlite <输出目录>`，输出匹配窗口、诊断行、grounding 和输出引用。
- `view.py`：transcript 切片查看器。
