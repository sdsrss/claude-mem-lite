# D25：让 `completed` 以会话最重要的结果开头 —— 事先登记

写于 2026-11-12，早于任何判决和登记用的模型调用（§3 的试跑除外，它不在登记用的会话上）。提交时间就是「早于判决」的凭据。运行时若要改动这里的规则，另起一节写明改动和理由，原文不改。

## 1. 为什么要量

D24（`docs/audits/20261112-d24-reading.md`）的判定 2 成立：

- 新会话看到的那一行 `Completed:`，在 30 个会话里有 13 个没说出上个会话最重要的完成事项；多轮会话里是 10/16。
- 同一批行在完整字段上的 `missed_done` 是 C 0/30。

由此开出 D#842。

### 前提：漏在顺序上，不在截断长度上

- 数据：reading 5 C 臂的 30 行（`tasks/d825/ab5/rows.json`；脚本 `tasks/d842/premise.mjs`）。
- **`completed` 长度**：30 行全部超过 120 字符，中位 655，p90 968，最长 1001。
- **主要完成事项在字段里的位置**：
  - 取两位判官都答 YES 的 13 项，按判官写的 `main` 在字段里找那件事。
  - 能用一个关键词定位的 12 项，起点在第 124、188、203、210、245、256、287、337、461、515、537、717 个字符。
  - 另 1 项（item 12）的 `main` 是几件评审修复的合称，定位不到一处。
  - 这些位置是我读的，不是盲判，只用来选候选。
- 由此推出两点：
  - 把这一行放宽到 240 字符，12 项里只到得了 4 项；放宽到 300，也只有 7 项。并且每次 SessionStart 都要多注入这些字节。所以渲染长度这条路不登记，也不量。
  - 字段里多数时候写了那件事，只是按时间顺序排在细节后面，例如先列各处修复的提交号，最后才写「已发布」。所以要改的是顺序，由提示词来改。

## 2. 问题

在提示词末尾加一句，要求 `completed` 先用一个短句写出会话最重要的完成结果。新会话看到的 `Completed:` 这一行，是不是因此更少漏掉这件事？完整字段有没有因此变差？

## 3. 尺子

### 候选（臂 P）

6.34.0 的提示（臂 C）不变，在 system 部分末尾、也就是讲回复的那一段末尾，加上这一句（`benchmark/summary-events-ab.mjs` 的 `COMPLETED_LEAD`，300 字符）：

> completed starts with the session's most important finished outcome, the one a person picking this work up next most needs to know (such as a release published, a deploy live, a fix merged or a measurement's verdict), in one short clause of at most 100 characters; the other finished items follow it.

- 「at most 100 characters」：这一行在 120 处截断，开头的短句要整句留在这一行里。
- 用词与 D24 判官简报里 `main` 的定义相近，那条定义就是要的产品行为（见 §6）。

### 试跑（登记之前，不在登记的会话上）

- 在 reading 5 的 3 个会话上（item 4、6、22，都是 D24 中 C 臂漏掉的多轮会话），C、P 各调用一次（`tasks/d842/pilot.out`）。
- 只检查这句话有没有让开头变成结果：
  - 3 个 P 都以 D24 判官写的那件事开头（D#357 的修复已提交、v6.29.2 已发布、部署 19 上线）；
  - C 有两个以细节开头；另一个以「B1-B5 全部修复并提交到 main」开头，没有提已发布的 v6.29.2。
- P 的 `completed` 在其中 2 个会话里更短（368 对 791，425 对 828）。这正是完整字段那一视图要守的风险。
- 试跑之后没有改这句话。

### 数据

- 总体：`collectSessions`，`--days 45`，与 reading 5 相同的条件。
- **留出**：去掉 reading 5 抽到的 30 个会话（`run --exclude tasks/d825/ab5/rows.json`）。上面的假设、候选的写法和试跑都来自那 30 个会话。
- 从剩下的会话里用 `pickEvenly` 均匀取 30 个。
- 三个臂，每个会话各调用一次模型，调用顺序按会话轮转：
  - **C**：6.34.0 的提示，带每一轮的最后回复；
  - **C2**：同一个提示再调用一次，作 A/A，量模型加判官的噪声；
  - **P**：C 的提示加上 `COMPLETED_LEAD`。
- 模型：与 reading 5 相同，走 CLI（`claude -p`）。
- 共 90 次调用。

C2 若大多与 C 逐字相同，A/A 就只量到判官噪声。运行时记录 `c2SameAsC`，读数里写明。

### 判官

两种视图，各用 4 位新判官，2 批 × 2 种顺序：

| 视图 | 判官看到的摘要 | 问题 | 简报 | 种子 |
|---|---|---|---|---|
| line | `buildSummaryLines` 渲染的 `Completed:` / `Remaining:` / `Next:` 行，每行截到 120 字符 | `main`、`line_misses_main`、`false_open`、`unsupported` | `tasks/d24/judge-brief.md`，原样 | 20261116 |
| fields | 完整的 `completed` / `remaining_items` / `next_steps` | `missed_done`、`false_open`、`unsupported` | `tasks/converge-r34/d21-ab/judge-brief.md`，原样 | 20261117 |

- 回复都由 `judgeReplies` 得出，与 D21–D24 相同。
- C2 的行放进与本会话 C、P 不同的批次。
- 两位判官都答 YES 才算一次。
- 两种视图的判官互不相同，任何判官都只看一种视图。

### 尺子能说 NO（先于判决）

- 新代码逐站点变异 29 处（`tasks/d842/mut.mjs`），每处都断言已落地，29/29 让 `tests/summary-events-ab.test.mjs` 失败（`tasks/d842/mut.out`）。
- 测试断言：
  - P 的提示就是 C 的提示加上这一句，user 部分逐字不变；
  - C2 的提示与 C 逐字相同。

## 4. 判定（`gateD25`）

**有效性**（任一不成立 → `none`，不判定，只报告）：

1. 两种视图里 C、C2、P 都判完（每臂 30 项）；
2. usable(C)、usable(P) ≥ 28；
3. 两种视图里每个问题的原始一致率 ≥ 0.70；
4. A/A：|`line_misses_main`(C2) − `line_misses_main`(C)| ≤ 2，且 |`missed_done`(C2) − `missed_done`(C)| ≤ 1。

**发布条件**（全部成立 → `ship`，否则 `no`）：

- line：`line_misses_main`(P) ≤ `line_misses_main`(C) − 3；
- line：`false_open`(P) ≤ `false_open`(C) + 1，`unsupported`(P) ≤ `unsupported`(C) + 1；
- fields：`missed_done`(P) ≤ `missed_done`(C) + 1，`false_open`(P) ≤ `false_open`(C) + 1，`unsupported`(P) ≤ `unsupported`(C) + 1。

**动作**：

- `ship`：
  - 改的是发布出去的提示词。动手前先问维护者，得到确认再实现。
  - 实现方式：`hook-llm.mjs` `buildSessionSummaryPrompt` 两个带回复的分支，末尾都加这一句；不带回复的分支逐字不变。
  - 用测试断言发布的提示与臂 P 逐字相同。
  - 下次发版写明这一默认行为的变化，回退方式是钉住上一版本。
- `no`：记录读数；D#842 保留，附上读数。下一个候选要重新登记，并用新的留出会话。
- `none`：记录读数，不改动。

## 5. 只报告，不参与判定

- 多轮与单轮分开的读数。
- 各臂 `completed` 的平均长度，以及提示增加的字符数。
- `c2SameAsC`。
- P 的开头短句是否在 120 字符以内：我数，不盲判，只作描述。

## 6. 不声称

- 一台机器、一个维护者，回复多为中文；摘要模型与判官都是 Claude。
- 候选的用词贴近判官简报里 `main` 的定义。所以 P 是冲着被量的那个性质写的。这是有意的：那个定义就是要的行为。
  - 它可能付出的代价，由完整字段视图和两个 `false_open` / `unsupported` 问题来守。
- 「最重要的一件事」由判官挑选。
- 来源为报告的会话：生产上显示的是报告的 Done，这里显示的是模型的。不模拟（与 D24 相同）。
- 不带回复的提示分支不量，也不改。

## 与 D#840 的关系

D#840（没有观察记录的会话）的下一轮登记，要在本读数之后写，并加上 line 视图。

- 本读数若为 `ship` 且得到确认，D#840 的 M 臂用改后的提示。
- 否则 D#840 的 M 臂用 6.34.0 的提示。
