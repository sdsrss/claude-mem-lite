# D27（D#844）：没有观察记录的多轮会话 —— 0 次调用的逐轮臂 D 对模型臂 M —— 事先登记

写于 2026-11-12，早于新样本里任何一个会话被生成摘要、被调用模型或被判官看到。写之前只看过人群计数（§2）。提交时间就是「早于数据」的凭据。运行时若要改动这里的任何规则，另起一节写明改动和理由，原文不改。

## 1. 问题

没有观察记录的会话，摘要进程不调用模型（`no-obs`），留下的是 Stop 写的确定性行：带报告的回复的 Done，否则回复开头 120 字符（后一轮回复不足 400 字符时不替换前一轮的开头）。

D23（`docs/audits/20261112-d23-reading.md`）在 30 个这样的多轮会话上量过：

- 完整字段漏掉主要完成事项（`missed_done`）：Stop 写的行（S）26/30，加一次模型调用（M，6.34.0 提示）5/30。
- 但 M 的 `false_open` 从 5 升到 7，超过登记的 +1，判为「不改」。
- D#838（`docs/audits/20261112-d838-call-cost.md`）量了代价：每次 Stop 都调用，本机 46.4 天多出至少 446 次调用，是现有 1,356 次的 +32.9%；按静默间隔省调用不可取。
- D#838 §3 的推断：M 的收益来自读到每一轮的回复。不调用模型也能让 Stop 写的行带上每一轮。这个推断没有量过。

本轮的问题：

1. **D（0 次调用）**：Stop 写的行保留每一轮单独会写下的 Done。完整字段里漏掉主要完成事项的次数，是否比 S 至少少 3 次，且别的计数不变差？
2. **M（每个会话多一次调用）**：用发布的 6.35.0 提示（D#845 起带 `SUMMARY_COMPLETED_ORDER`）。它是否比 0 次调用的 D 好出足够多，值得付那笔调用？

## 2. 人群

**条件**（`collectNoObsSessions`，与 D23 相同，另加两条）：

- 摘要行在窗口内（`--days 45`）；
- 过了低信号标题过滤的观察记录为 0；
- transcript 在盘上；
- `stopReplies` 重建出至少 2 条回复；
- **新增**：会话的第一条提示或观察记录不早于 **2026-11-12T14:09:05Z**（D23 运行结束的时刻，`--since`）。所以与 D23 的 30 个会话不重叠，D23 用来提出 D 的数据不进本轮。
- **新增**：transcript 里不含 `summary-events-ab.mjs run`（`--exclude-text`）。运行尺子的那个会话的观察记录可能还没写入，会被误收进来。

**已量**（2026-11-12T19:26:17Z，树 8544caea，`run --arms S,D,M --since 2026-11-12T14:09:05Z --days 45 --count-only`）：窗口内 328 个会话，有观察 193、无起点 12、早于起点 123，人群 **0**。

## 3. 尺子

`benchmark/summary-events-ab.mjs` 的 `run --arms S,D,M`。每个会话五项：

| 臂 | 内容 | 模型调用 |
|---|---|---|
| **S** | 6.35.0 的 Stop 逐次重放后留下的行（`replayStopRow`，与 D23 相同；6.35.0 的 Stop 代码与 6.34.0 相同） | 0 |
| **D** | S 的行，只把 `completed` 换成 `armDCompleted`（下文） | 0 |
| **M** | 发布的 `buildSessionSummaryPrompt`（无观察、全部已记录回复）调用一次，经 `modelSummaryFields` 清洗，用 `mergeModelSummary` 合并到 S 的行上 | 1 |
| **M2** | M 再调用一次，合并到另一份 S 的重放上 | 1 |
| **S2** | S 原样复制 | 0 |

**D 的 `completed`**（`armDCompleted(S.completed, turnDones(...))`）：

1. 先放 S 自己的 `completed`。
2. 再按时间先后，放每一轮单独会写下的 Done：把这一轮的最后回复喂给发布的 `writeStopSummary`，写进一个空库，取它写下的 `completed`（`turnDones`）。也就是这一轮回复的报告 Done，没有报告就是回复开头（≤ 120 字符）；只有 Failed / Uncertain 段的回复写不出 Done。
3. 空的、与前面某一项完全相同的（去掉首尾空白后）跳过。
4. 用 `; ` 连接。一项一项整条放入，第一个放不下的就停。上限 600 字符，即 Stop 路径的发布上限（`FAST_SUMMARY_LIMITS.stop.completed`），不改。

所以新会话看到的 `Completed:` 那一行以 S 的文字开头。S 的 Done 不足 120 字符时，行尾会多出下一项的开头，所以那一行不一定与 S 相同：两种视图都要判 D。

**判官**（与 D26 相同的做法）：

| 视图 | 判官看到 | 问题 | 简报（原样） | 种子 |
|---|---|---|---|---|
| line | `buildSummaryLines` 渲染的 `Completed:` / `Remaining:` / `Next:` 行，每行截到 120 字符 | `main`、`line_misses_main`、`false_open`、`unsupported` | `tasks/d24/judge-brief.md` | 20261120 |
| fields | 完整的 `completed` / `remaining_items` / `next_steps` | `missed_done`、`false_open`、`unsupported` | `tasks/converge-r34/d21-ab/judge-brief.md` | 20261121 |

- 每种视图 6 位新判官：3 批 × 2 种顺序（`prepare --batches 3`）。任何判官只看一种视图、一批。
- 一个会话的 S、D、M 在同一批；S2、M2 在另一批（`COPY_ARMS`）。所以 D 对 S、M 对 D 都由同一组判官判；两个 A/A 由另一组判。
- 回复由 `judgeReplies` 得出，与 D21–D26 相同。两位判官都答 YES 才算一次。

**尺子能说 NO**（先于任何调用）：新代码逐站点变异 37 处（`tasks/d27/mut27.mjs`，每处断言已落地），36 处让 `tests/summary-events-ab.test.mjs` 失败。存活的 1 处去掉了 `passes` 里跳过 `missed_done` 的那一行：它只给判定多加一条重复的理由，判定结果不变。

## 4. 判定（`gateD27`）

计数都是两位判官都答 YES 的项数，满分 n。六个计数：line 的 `line_misses_main`、`false_open`、`unsupported`；fields 的 `missed_done`、`false_open`、`unsupported`。主要计数是 `line_misses_main` 与 `missed_done`。

**有效性**（任一不成立 → `none`，不判定，只报告）：

1. n ≥ 20；
2. 两种视图里 S、D、M、M2、S2 都判完 n 项；
3. 五个臂的 usable 都 ≥ n − 2（S、D：有行；M、M2：过了摘要进程的写入闸门 `summaryUsable`）；
4. 两种视图里每个问题的原始一致率 ≥ 0.70；
5. 判官 A/A：|S2 − S| 在 `line_misses_main` 与 `missed_done` 上都 ≤ 2；
6. 模型 A/A：|M2 − M| 在 `line_misses_main` 上 ≤ 8，在 `missed_done` 上 ≤ 6。

**三个比较**：

- **D 过关**：`missed_done`(D) ≤ `missed_done`(S) − 3，且其余五个计数 D ≤ S + 1。
- **M 过关**：同一条规则，M 与 M2 各自都要满足。
- **M 胜过 D**：至少一个主要计数上，M 与 M2 各自都比 D 少至少 3；并且六个计数里，M 与 M2 各自都 ≤ D + 1。

**判定**：

| 条件 | 判定 |
|---|---|
| M 胜过 D，且 D 或 M 过关 | `M` |
| D 过关，M 没有胜过 D | `D` |
| D 不过关，M 过关 | `M` |
| 其余 | `no` |

**调用数怎么进判定**：M 的额外调用是固定代价（D#838），所以 M 要被采用，必须胜过 0 次调用的 D，只比 S 好不够；只有 D 不过关时，M 才单凭比 S 好被采用。

**动作**：

- `D` 或 `M`：改的是已发布插件的摘要默认行为。写 L3 spec，先问维护者，得到确认再实现；下次发版写明默认行为的变化，回退方式是钉住上一版本。`M` 的 spec 写明 D#838 的调用代价。
- `no`：读数写进本文的读数文件与 rulers.md；D#844 按读数关闭或降级。
- `none`：记录读数，不改动。

**阈值从哪来**：

- 效应 −3、其余 +1（满分 30）：与 D21–D25 相同。
- 判官 A/A 2：D24 的逐字复制 A/A 容差（line），fields 取同值。D23 的逐字复制 A/A 用 1，读到 0。
- 模型 A/A：
  - line 8，与 D26 相同（约为 p = 0.45 时两次独立调用之差的 2 个标准差）；
  - fields 6：D23 中 M 的 `missed_done` 为 5/30，p ≈ 0.17，两次独立调用之差的二项标准差 √(2·30·0.17·0.83) ≈ 2.9，取约 2 个标准差。D26 的 2 是按 0–1/30 定的，用在这里会让噪声本身就判为无效。

## 5. 运行时机与冻结

- **之前只看人群计数**：`run --arms S,D,M --since 2026-11-12T14:09:05Z --count-only`，只打印计数，不调用模型。
- **运行**：计数第一次 ≥ 30 的那天，n = 30（`pickEvenly`）。
- **冻结**：transcript 在 30 天后被清理，最早的样本 2026-12-12 起就会消失。按 D23 的速度（约每天 0.82 个），不冻结的话，任何时刻盘上都凑不满 30 个。
  - 2026-12-09 若还没运行，把 `~/.claude/projects/*/` 下 2026-11-12T14:09:05Z 之后改动过的每个 `*.jsonl`，按原来的 `<项目>/<文件>` 结构复制到 `benchmark/results/d27-corpus/`（已被 gitignore）。
  - 之后每次计数和运行前，先用 `cp -u -p` 再同步一次，然后加 `--projects-dir benchmark/results/d27-corpus`。
- **截止**：2026-12-23 仍不足 30 个时，人群 ≥ 20 就以 n = 人群全部运行；不足 20 个只报计数，D#844 保持开放。
- **树**：在本登记提交时的尺子上运行（尺子提交 8544caea）。若 HEAD 之后改过 `benchmark/summary-events-ab.mjs`、`lib/fast-summary.mjs`、`lib/summary-extractor.mjs`、`hook-llm.mjs` 中的摘要提示，用 `git worktree add --detach` 回到本登记的提交运行。
- 调用走 CLI（`claude -p`），与 D21–D26 相同；共 2n 次。

## 6. 只报告，不参与判定

- 各臂 `completed` 的平均长度；D 的那一行与 S 逐字相同的会话数（`dLineSameAsS`）；M2 与 M 三字段逐字相同的会话数（`m2SameAsM`）；本次调用数（`calls`）。
- 按 S 的 Done 来源（report / tail / titles）与单轮多轮分开的计数（`splitBothYes`）。
- **(b)**：S 的 Done 来源是 report、而最后一条回复没有报告的会话数，即报告来自更早一轮。这些会话上 `mergeModelSummary` 保留报告，不用模型的 `completed`。只描述，不进判定；要改它另起登记。
- 生产调用代价引用 D#838，不重量。

## 7. 不声称

- 一台机器、一个维护者，回复多为中文；摘要模型与判官都是 Claude。
- 窗口内本机插件可能从 6.31.0 升到 6.35.0。尺子从 transcript 与库重建所有输入，版本只影响哪些会话有观察记录。不按版本分层。
- 五个不劣计数各有 +1 的容差。真实无差别时，D 被判官噪声判为不过关的概率没有算。
- 「主要完成事项」由判官挑选。
- D 只在离线重放里构造。生产实现（Stop 逐轮累积）要在 L3 spec 里另行说明，并用测试断言它写出的行与 D 相同。
- D22 审查 F7（两条系统规则在「后来重开」时冲突）不在本轮。
