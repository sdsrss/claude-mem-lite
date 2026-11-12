# D26：只规定 `completed` 的顺序，每个臂调用两次 —— 事先登记

写于 2026-11-12，早于任何判决和登记用的模型调用。§3 的试跑只用了已经看过的会话，不在登记的会话上。提交时间就是「早于判决」的凭据。运行时若要改动这里的规则，另起一节写明改动和理由，原文不改。

## 1. 为什么再量一次

D25（`docs/audits/20261112-d25-reading.md`）判为 `none`：同一个 6.34.0 提示调用两次，这一行的漏判是 11 和 16，A/A 差 5，超过登记的 2。描述性读数里有两件事：

- **候选 P 规定了顺序，这一行的漏判只有 2/30。**
- **P 也带来了代价：**
  - 它把 `completed` 平均从 721 字符压到 397；
  - 把已完成写成未完成的项升高：完整字段 5/30 对 1/30，这一行 2/30 对 0/30；
  - 核对过的 item 18 上，P 没有按最晚的回复记状态。

P 的那句话里有「in one short clause of at most 100 characters」。我的假设是，这个长度上限让模型把整个字段一起压缩了。这个假设没有单独量过。

D25 还说明了一件事：重新调用的噪声本身就是这个缺陷。提示不规定顺序，所以每次调用排在这一行最前面的细节都不同。所以这一轮：

- 候选只规定顺序，不给长度上限；
- 每个臂都调用两次，判定用两次合并的计数，阈值按重新调用的噪声来定。

## 2. 问题

在提示词末尾加一句，只要求 `completed` 按重要性排序、其余不变。与 6.34.0 相比，新会话看到的 `Completed:` 这一行，是不是更少漏掉会话最重要的完成事项？同时完整字段不变差，已完成也不会更多地被写成未完成？

## 3. 尺子

### 候选（臂 Q）

6.34.0 的提示（臂 C）不变，在 system 部分末尾、也就是讲回复的那一段末尾，加上这一句（`benchmark/summary-events-ab.mjs` 的 `COMPLETED_ORDER`，440 字符）：

> Order completed by importance: begin with the session's most important finished outcome, the one a person picking this work up next most needs to know (such as a release published, a deploy live, a fix merged or a measurement's verdict), then list every other finished item. This changes only the order: keep every item and detail you would otherwise include, and an item's state is still the one given by the latest reply that mentions it.

与 D25 的 P 相比：

- 去掉了「一个不超过 100 字符的短句」；
- 明确写出其余每一项都保留；
- 重申状态以最晚提到它的回复为准。

### 试跑（登记之前，只在已看过的会话上）

3 个会话，Q 各调用一次（`tasks/d842/pilot26.out`）：

- D25 的 item 18、item 4：都在 P 把已完成写成未完成的 5 项里。
- reading 5 的 item 6。

结果：

- 3 个 Q 都以 D24 / D25 判官写的那件事开头：v1.38.5 发布并核对、v6.29.1 已发布、v6.29.2 已发布。
- 长度与 C 相当：984 对 C 的 980；644 对 791；1200 对 reading 5 中 C 的 821。
- item 18 上，Q 的 `remaining_items` 写的是 Publishing access「用户已选」。P 曾把它写成要用户去选。

试跑之后没有改这句话。

### 数据

- **总体**：`collectSessions`，`--days 45`，与 reading 5、D25 相同的条件。
- **留出**：去掉 reading 5 和 D25 抽过的 60 个会话（`run --exclude tasks/d825/ab5/rows.json,tasks/d842/ab1/rows.json`）。从剩下的会话里用 `pickEvenly` 均匀取 30 个。
- **四个臂**，每个会话各调用一次模型，调用顺序按会话轮转：
  - **C**：6.34.0 的提示，带每一轮的最后回复；
  - **C2**：C 再调用一次；
  - **Q**：C 的提示加上 `COMPLETED_ORDER`；
  - **Q2**：Q 再调用一次。
- 模型：走 CLI（`claude -p`），与 reading 5、D25 相同。共 120 次调用。
- 运行时记录 `c2SameAsC`、`q2SameAsQ`：重复调用里与第一次逐字相同的行数。

### 判官

两种视图，每种视图 6 位新判官，3 批 × 2 种顺序，共 12 位：

| 视图 | 判官看到的摘要 | 问题 | 简报 | 种子 |
|---|---|---|---|---|
| line | `buildSummaryLines` 渲染的 `Completed:` / `Remaining:` / `Next:` 行，每行截到 120 字符 | `main`、`line_misses_main`、`false_open`、`unsupported` | `tasks/d24/judge-brief.md`，原样 | 20261118 |
| fields | 完整的 `completed` / `remaining_items` / `next_steps` | `missed_done`、`false_open`、`unsupported` | `tasks/converge-r34/d21-ab/judge-brief.md`，原样 | 20261119 |

- 一个会话的 C 与 Q 在同一批；C2 与 Q2 在另一批。所以每一次调用的对比，都由同一组判官判。
- 回复由 `judgeReplies` 得出，与 D21–D25 相同。
- 两位判官都答 YES 才算一次。
- 任何判官都只看一种视图、一批。

### 噪声模型（阈值从哪来）

- **重新调用的 A/A**：
  - D25 中 C 的这一行漏判约 0.45。两次独立调用之差的二项标准差约为 √(2·30·0.45·0.55) ≈ 3.9。
  - A/A 容差取 8（约 2 个标准差）。它只用来发现坏掉的仪器，例如两批判官尺度不一，不是用来要求提示稳定。
  - 完整字段的 `missed_done` 在 reading 5、D25 中为 0–1/30。标准差约 1.1，容差取 2。
- **合并后的效应**：
  - 按 C+C2 约 0.45、Q+Q2 约 0.10 估算，60 对 60 之差的标准差约 4.5。阈值取 10（约 2.2 个标准差）。
  - 另要求两次调用各自都显示效应：Q 比 C 少至少 3，Q2 比 C2 少至少 3。
- **不劣**：每个其他计数在 60 上最多 +2，相当于 D21–D25 的「30 上 +1」。

### 尺子能说 NO（先于判决）

- 新代码逐站点变异 30 处（`tasks/d842/mut26.mjs`），每处都断言已落地，30/30 让 `tests/summary-events-ab.test.mjs` 失败（`tasks/d842/mut26.out`）。
- 测试断言：
  - Q、Q2 的提示就是 C 的提示加上这一句，user 部分逐字不变；
  - Q2 与 Q 相同；
  - P 与 Q 不同；
  - C2、Q2 与 C、Q 不在同一批。

## 4. 判定（`gateD26`）

计数都是两位判官都答 YES 的项数。C+C2、Q+Q2 是两次调用合并，满分 60。

**有效性**（任一不成立 → `none`，不判定，只报告）：

1. 两种视图里 C、C2、Q、Q2 都判完（每臂 30 项）；
2. 四个臂的 usable 都 ≥ 28；
3. 两种视图里每个问题的原始一致率 ≥ 0.70；
4. A/A：|C2 − C| 与 |Q2 − Q| 在 `line_misses_main` 上都 ≤ 8，在 `missed_done` 上都 ≤ 2。

**发布条件**（全部成立 → `ship`，否则 `no`）：

- line：`line_misses_main`(Q+Q2) ≤ `line_misses_main`(C+C2) − 10；
- line：`line_misses_main`(Q) ≤ `line_misses_main`(C) − 3，且 `line_misses_main`(Q2) ≤ `line_misses_main`(C2) − 3；
- 下面 5 个计数，Q+Q2 都 ≤ C+C2 + 2：
  - line 的 `false_open`、`unsupported`；
  - fields 的 `missed_done`、`false_open`、`unsupported`。

**动作**：

- `ship`：
  - 改的是发布出去的提示词。动手前先问维护者，得到确认再实现。
  - 实现方式：`hook-llm.mjs` `buildSessionSummaryPrompt` 两个带回复的分支，末尾都加这一句；不带回复的分支逐字不变。
  - 用测试断言发布的提示与臂 Q 逐字相同。
  - 下次发版写明这一默认行为的变化，回退方式是钉住上一版本。
- `no`：记录读数；D#843 保留，附上读数。
- `none`：记录读数，不改动。

## 5. 只报告，不参与判定

- 各次调用（C、C2、Q、Q2）分开的计数；多轮与单轮分开的读数。
- 各臂 `completed` 的平均长度，以及提示增加的字符数（440 + 1）。
- `c2SameAsC`、`q2SameAsQ`。

## 6. 不声称

- 一台机器、一个维护者，回复多为中文；摘要模型与判官都是 Claude。
- 候选的用词贴近判官简报里 `main` 的定义，与 D25 相同：那个定义就是要的行为。代价由完整字段视图和 `false_open` / `unsupported` 守。
- 噪声模型按二项分布估算，没有把同一会话两次调用之间的相关性算进去。
- 「最重要的一件事」由判官挑选。
- 来源为报告的会话：生产上显示的是报告的 Done，这里显示的是模型的。不模拟。
- 不带回复的提示分支不量，也不改。
