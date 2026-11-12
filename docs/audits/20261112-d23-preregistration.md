# D23（D#831）：没有观察记录的多轮会话也交给摘要模型 —— 事先登记

写于 2026-11-12，早于生成任何候选摘要、早于看任何判决。提交时间就是「早于数据」的凭据。

- 写这份登记之前，只看过人群计数（§2）。
- 运行时若要改动这里的任何规则，另起一节写明改动和理由，原文不改。

## 1. 问题

6.34.0（D#825）起，摘要模型会读每一轮的最后回复。但有两条路径仍然只反映最后一轮。

**(a) 会话没有观察记录**（经过低信号标题过滤后为 0 条）。

- 摘要进程不调用模型，返回 `no-obs`（`hook-llm.mjs`）。
- 留下的是 Stop 写的确定性行：
  - `hook.mjs` 的 `writeFastSummaryBaseline`；
  - `lib/summary-extractor.mjs` 的 `extractStructuredSummary` 从最后一条回复里取 Done / Not done；
  - `lib/fast-summary.mjs` 的 `writeStopSummary` 写入：报告、回复开头，或观察标题。

**(b) 存下的行带 Done / Not done 报告**：`mergeModelSummary` 保留报告，不用模型给出的 `completed`。

**候选改动（只针对 (a)）**：没有观察记录、但至少有两条已记录回复的会话，也调用摘要模型。

- 提示词：6.34.0 的 `buildSessionSummaryPrompt`，`observations` 为空，`turnReplies` 为全部已记录回复。
- 结果：按 6.34.0 的 `mergeModelSummary` 合并到 Stop 写的那一行上。

## 2. 人群（已量；本机库，只读）

2026-11-12 量，范围是 2026-10-13 以来开始的 324 个会话，脚本见附录。

| | 0 个提示 | 1 个 | 2–3 个 | 4–9 个 | 10+ |
|---|---|---|---|---|---|
| 没有观察记录 | 29 | 75 | 23 | 10 | 0 |
| 有观察记录 | 22 | 86 | 55 | 23 | 1 |

- 没有观察记录的多轮会话（≥ 2 个提示）共 33 个，占全部会话的 10%。
- 按项目：claudemd 12、claude-mem-lite 9、daagu 8、code-graph-mcp 3、sgc 1。
- (b) 在 reading 5 的 30 个会话里出现 2 次（`docs/measurement/rulers.md`）。只描述，不进判定。

## 3. 尺子

在 `benchmark/summary-events-ab.mjs` 上新增一组臂。实现时写进 `rulers.md` 的条目。

### 总体

- 摘要行在窗口内（`--days 45`）；
- 过滤后的观察记录为 0；
- transcript 在盘上；
- `stopReplies` 重建出至少 2 条回复；
- 不要求代理事件。

### 两个臂

**S 臂（6.34.0 的行为）**：按会话的每次 Stop 重放 6.34.0 的代码，得到 6.34.0 会写下的那一行。

- 重放内容：
  1. `extractStructuredSummary`（输入是该 Stop 的回复）；
  2. `readFastSummarySource`，只取该 Stop 之前写入的观察与提示；
  3. 用 `writeStopSummary` 写进一个同 schema 的内存库。
- 不用库里存的行：窗口内的行由不同版本写下。

**M 臂（候选）**：在 S 臂的行上加一次模型调用。

- 构造提示：`buildSessionSummaryPrompt({ observations: [], userPrompts, finalReply: replies.at(-1), turnReplies: replies })`。
- 调用与解析：走 6.34.0 的 `callLLM` → `parseJsonFromLLM`。
- 合并：经摘要进程同样的清洗，再用 `mergeModelSummary` 合并到 S 臂那一行上。

### 判官

与 reading 5 相同：

- **给判官看的回复**：
  - 每轮的最后回复，经过脱敏；
  - 每条只看开头 700 加结尾 300 字符；
  - 最多取前 4 轮和后 8 轮。
- **给判官看的摘要**：各臂合并后的 `completed`、`remaining_items`、`next_steps`。
- **问题**：`missed_done`、`false_open`、`unsupported`。两位判官都答 YES 才算一次。
- **人数与顺序**：4 位新判官，2 批 × 2 种顺序，种子在运行前写进 spec。

### 尺子能说 NO（先于读数）

- 新增的重放和合并代码逐站点变异，每个变异都断言已落地，并且都要让尺子的单元测试失败。
- A/A：把 M 臂换成 S 臂的行原样，在同一批会话上跑同样的判官，两臂的 `missed_done` 差 ≤ 1。不成立 → 尺子噪声太大，不判定。

### 样本量

- 取总体全部；超过 30 个时均匀取 30 个。
- 少于 20 个 → 不判定。只报告描述性读数，D#831 保持开放，等人群长大。

## 4. 判定

与 gateD21 同一形式，S 臂代替 A，M 臂代替 B。以下全部成立，才写 L3 spec 并请求授权实现：

1. 两臂都判完全部 n 个；可用数 ≥ n − 2；
2. 每个问题上，判官的原始一致率 ≥ 0.70；
3. `missed_done(M)` ≤ `missed_done(S)` − 3；
4. `false_open(M)` ≤ `false_open(S)` + 1；
5. `unsupported(M)` ≤ `unsupported(S)` + 1。

任一不成立 → 不改代码，读数记入 D#831，按读数决定关闭还是降级。

## 5. 只报告，不参与判定

- 额外的模型调用次数（本机每 30 天约 33 次）、平均提示长度；
- (b) 的会话数，以及报告的 Done 与模型的 `completed` 冲突的实例；
- D22 审查 F7 的系统规则冲突（同一事项早先完成、后来又被重新打开）在 M 臂里出现的实例。

## 6. 不声称

- 总体是一台机器、一个维护者的会话，回复多为中文，判官是 Claude。
- 没有观察记录的会话多是讨论与问答。这里的 `missed_done` 衡量的是：回复里说做完了的事，摘要有没有漏掉。不衡量代码改动。

## 附录：人群计数

脚本（只读打开库）：对每个 `sdk_sessions` 行，统计三项。

- 过了 `notLowSignalTitleClause` 的观察数（`memory_session_id` = `content_session_id`）；
- 提示数（`user_prompts.content_session_id`）；
- 摘要行数。

按「有无观察 × 提示数」分桶。
