# R3 优化方案：让注入更准，而不是更多

状态：进行中

- **依据**：`docs/audits/20261103-124956-session-history-analysis-r3.md`（下称**报告**）
- **起点**：`main` @ `d7e05747`（v6.30.15）
- **分支**：`feat/r3-injection-precision`
- **授权**：用户在 2026-11-03 指示"按文档的建议进行优化"。这条指示被当作本文所列 L3 项的授权。推送和发版不在范围内。实施中如果碰到其他需要单独授权的事（依赖、CI 配置、数据库 schema），再单独询问。
- **文档位置**：按用户要求放在 `docs/`。它同时充当本任务的 spec，所以没有另建 `tasks/specs/` 文件。

---

## 1. 背景与目标

报告的结论：
- 插件的价值主要在"显式写、跨会话读"。
- 自动注入的块约 1/9 切题（盲评 7/60），0 误导，但占插件注入字节的约 56%。
- 剩下约 88% 不切题的块，有几类是**结构上可以识别**的：
  - 文件名撞车：同名但不同路径的文件拿到了别人的教训；
  - 报错只来自模型自己临时写的脚本；
  - 同一会话内重复注入同一条记忆；
  - 没人照做的提示行。

**目标**：只去掉这些"按结构就能判定不切题"的注入，而且不损失切题的那部分。每一项都要先量出能命中多少（到达率），再按预先登记的规则决定保留还是回滚。

**非目标**：
- 不追求引用率上升；
- 不改检索排序；
- 不动数据库 schema。

---

## 2. 建议与取舍

先对照报告 §9 的十条建议，逐条说明这次做不做、为什么。

| 报告编号 | 结论 | 理由（新量到的证据） |
|---|---|---|
| S1 error-recall 加相关性门 | **改为 O2 + O3 + O4 实施** | 读代码发现，"至少命中一个错误词"的门已经存在（`lib/error-recall-core.mjs` 的 error-first 重排，D#167）；"必须命中错误词"的形式也测过，否决理由写在那里。真正还没被处理的一类是：**报错只来自模型自己临时写的脚本**（`<stdin>` 里的 python heredoc、`[stdin]`/`[eval]`、scratchpad 里的脚本）。原型命中 95/622（15.3%）。另外两项是重复注入，以及没人照做的提示行 |
| S2 收窄 PreToolUse | **只做 (c)，改为 O1** | 在 4,037 个注入行中，307 行的文件边是"同名、不同路径"。其中 210 行确实是不同的文件，例如 `src/snapshot/mod.rs` 拿到了 `src/mcp/server/mod.rs` 的教训；另外 97 行是 worktree 或临时副本里的同一个文件。(a) 设上限、(b) 按类型过滤，都没有证据说明被去掉的块更不切题，所以不做 |
| S3 `change` 类不进注入池 | **撤回** | 盲评 7 个切题块里，有 3 个注入的就是 `change` 类（#396、#659、#873）。按块统计，含 change 行的块中切题的有 5 个 |
| S4 标出引用了不在 main 上的提交的记录 | **做 O5**（verify 技能加一条核对步骤） | 本项目 380 条活跃记录中，177 条引用了能解析的 sha；其中 20 条引用的提交后来被回滚 / 撤回（17），或不在 HEAD 上（3） |
| S5 删掉 `→ Use mem_get(…)` 提示行 | **做，归入 O4** | 622 个块，窗口内 MCP `mem_get` 被调用 3 次 |
| S6 CLI 参数写进 MCP instructions | **做 O6** | 非本项目会话里 54 次 help；完整 help 输出 15,743 字节；指令长度预算有余量（BASE 1,478/2,200，full 2,954/3,500） |
| S7 发版节奏 | 流程 | 本批改动只提交、不发版；发版时合成一个版本 |
| S8 worktree 的项目 id | **暂缓**（记为待办） | 两个月里只有 4 条记录。命名规则在 `project-utils.mjs` 和 `scripts/post-tool-use.sh` 中各有一份实现，改动会碰到所有入口 |
| S9 开发树 CLI 打开真实库时拦截 | **暂缓**（记为待办） | 测试里有大量 `cli.mjs` 调用没设 `CLAUDE_MEM_DIR`（它们改的是 HOME）。而且 dev install 本身就是"git checkout 当安装"，拦截会对它误报。需要先设计"这个 checkout 是不是本机安装"的判定 |
| S10 重盖 Baselines | **做 O7**，放在最后 | 测试数在 9909 基础上会变 |

---

## 3. 方案

### O1 PreToolUse：同名不同路径的文件边不再算命中

- **现状**：`lib/file-edge-match.mjs:fileMatchClause` 有四条匹配规则：全路径相等、裸文件名相等，以及 `%/<文件名>`、`%\<文件名>` 两条后缀规则。后两条让任何同名的、带目录的边都算命中。
- **改法**：
  - 在 `scripts/pre-tool-recall.js` 的 observations 这一路上，取回候选行之后，再读这些行在 `observation_files` 里的同名边。
  - 用新的纯函数 `lib/file-edge-match.mjs:edgeIsOtherFile()` 判定：
    - 把存储的边和目标都换算成**相对于项目根目录**的路径。worktree 路径 `<根>/.claude/worktrees/<名>/x` 视为 `<根>/x`。
    - 两边都能换算、而且不相等时，判为"别的文件"。
    - 裸文件名、根目录之外的路径，**判定不了，一律保留**。
  - 一行的同名边**全部**是"别的文件"时，才丢掉这一行。
  - 为了不让丢掉的行空出名额（D#172 那种"去重变成缩容"的形状），SQL 多取 `PATH_PRECISION_SLACK` 行，过滤之后再截到原来的上限。
- **不改** SQL 子句本身：Stop 侧的边归因与它逐字节共享。
- events 这一路不改：307 行撞车里 events 是 0 行。
- **关闭开关**：`CLAUDE_MEM_PRETOOL_PATH_PRECISION=off`。

### O2 error-recall：报错只来自模型自己临时写的脚本时不注入

- **改法**：`lib/error-recall-gate.mjs` 新增第三个原因 `own-script`。
- **判定**：输出里每一个异常块的栈帧都在以下位置之一：
  - python 的 `File "<stdin>"` / `File "<string>"`；
  - node 的 `[stdin]:N` / `[eval]:N`；
  - session scratchpad 或 `/tmp` 下的脚本文件；
  - `node:internal`。

  **并且**把这些异常块去掉之后，剩下的输出不再被 `detectBashSignificance` 判为 hard error。
- 两条路径都适用：退出码为 0 的 PostToolUse，和 PostToolUseFailure。
- **关闭开关**：`CLAUDE_MEM_ERROR_RECALL_OWN_SCRIPT=off`。

### O3 error-recall：同一会话已经给过的记忆，在 compact 之前不再给

- **现状**：`lib/recall-shown.mjs:ERROR_RECALL_REPEAT_MS` 为 30 分钟，过了 30 分钟同一条可以再给一次。PreToolUse 那一面是"每个会话每个文件一次"。
- **改法**：默认改为整个线程。compact 时 SessionStart 已经会清掉这个记录，所以 compact 之后仍可再给。
- **开关**：`CLAUDE_MEM_ERROR_RECALL_REPEAT_MIN=<分钟>` 可以恢复按时间窗口；设成 30 就是旧行为。

### O4 error-recall：去掉 `→ Use mem_get(ids=[…]) for details.` 提示行

- 改 `format-utils.mjs:formatErrorRecallHints`。第一行仍内联教训正文，其余行仍带 `#id`。
- 纯文本改动，不设开关。

### O5 verify 技能：核对记录引用的提交

- 在 `commands/verify.md` 的 Step 2 里加一条：记录里有 7–12 位 sha 时，用以下两条命令核对：

  ```
  git merge-base --is-ancestor <sha> HEAD
  git log --oneline --grep=<sha 前 8 位>
  ```

- 判定：
  - 提交不在当前分支上，或者被后来的 revert / withdraw 提交点名，而记录本身又没写到这次回滚 → **STALE**；
  - 记录写的就是这次回滚 → 仍是 VALID。

### O6 MCP instructions：加上 `defer add` 与 `save` 的 CLI 参数

- 在 `search-scoring.mjs` 的 `INSTRUCTIONS_BASE`（quiet 模式也带）里加两行：
  - `defer add "<title>" --priority 1|2|3 --detail "<why>"`
  - `save "<text>" --type bugfix --lesson "<root cause + fix>"`
- 长度预算由 `tests/cli-path-invocation.test.mjs` 守住。

### O7 重盖 CLAUDE.md 的 Baselines 表

- 最后一个提交做：测试数、knip、覆盖率，三项都写明来自同一棵树。

---

## 4. 验收标准

- [ ] **AC1（O1）**：
  - 单测覆盖三种情况：不同目录的同名文件不注入；worktree 副本里的同一个文件仍注入；裸文件名的边仍注入。
  - 被去掉的行空出的名额由下一条候选补上。
  - 每条新规则做变异验证，必须变红。
- [ ] **AC2（O2）**：单测覆盖以下情况：
  - python heredoc 断言失败 → 不注入；
  - node `[stdin]` 抛错 → 不注入；
  - scratchpad 里的脚本 `ERR_MODULE_NOT_FOUND` → 不注入；
  - 同一输出里另有 vitest 失败，或仓库源码里的栈帧 → 仍注入；
  - 开关为 off → 仍注入。
- [ ] **AC3（O3）**：单测验证 31 分钟后同一条不再给、compact 之后可以再给、开关恢复按时间窗口。
- [ ] **AC4（O4、O5、O6）**：文本断言；长度预算测试通过。
- [ ] **AC5**：`npx vitest run` 全部通过（基线 551 个文件 / 9909 个用例）；`npx eslint .` 0 错；`npm run format:check` 通过；`npm run test:ci-env` 通过；`npm run benchmark:gate -- --strict` 通过。
- [ ] **AC6**：用改动后的发布函数在同一份 transcript 语料上做投影，报出各规则去掉的行 / 块 / 字节。
- [ ] **AC7（预先登记，见 §5）**：O1、O2 各自通过盲评判定，否则回滚该项。
- [ ] **AC8**：由一个独立的子代理做发布前评审，确认的问题都已修复，或记为待办。

---

## 5. 预先登记的判定规则（写于跑盲评之前）

**样本**：投影之后，按 sha1 确定性抽取以下四组，每组 30 个：
- O1 去掉的行；
- O1 保留的 pretool 行（对照）；
- O2 去掉的块；
- O2 保留的 error-recall 块（对照）。

如果某一组不足 30 个，就全取。

**评审**：
- 打乱顺序，去掉分组标签，交给不知道假设的子代理，用报告 §4.3 的同一套五档标签；
- 每个子代理评 60 个。

**规则**：一项规则**保留**的条件是，在它"去掉"的那组里：
- APPLICABLE ≤ 2/30；
- **并且**不高于它对照组的 APPLICABLE 数。

不满足就回滚该项，并在本文记下读数。

**已知局限**：每组 30 个，功效有限。如果去掉的那组真实适用率是 10%，有约 41% 的概率仍会出现 ≤2/30。所以这条规则的作用是挡住"成片去掉切题内容"，不是证明去掉的部分毫无价值。O1 和 O2 的主要依据是机理：被去掉的是别的文件，或者是模型自己脚本的报错，盲评只是第二道检查。

---

## 6. 计划

- [ ] P1：在分支上实施 O4 + O3（error-recall 的格式与重复），先 RED 后 GREEN，单独提交 — 覆盖 AC3、AC4
- [ ] P2：O2，单独提交 — 覆盖 AC2
- [ ] P3：O1，单独提交 — 覆盖 AC1
- [ ] P4：O6 + O5 文本，单独提交 — 覆盖 AC4
- [ ] P5：投影与盲评，按 §5 判定 — 覆盖 AC6、AC7
- [ ] P6：全量校验；CHANGELOG `## Unreleased`；独立评审并修复 — 覆盖 AC5、AC8
- [ ] P7：O7 重盖基线；合并回 main 并删除分支；回填本文 — 覆盖 AC5

---

## 7. 决策与进展

- 2026-11-03：方案落盘。S3 撤回，S8、S9 暂缓，理由见 §2。
- **O2 的判定口径收紧**：原型用"去掉异常块后剩余部分不是 hard error"。实现时改成了"剩余部分不是 error"（`isError`）。理由：一行 `Tests 1 failed` 的摘要单独不会触发注入，但它就在补丁脚本的 traceback 旁边时，仍应保留这次注入。代价是到达率略降。可逆：改回 `isHardError` 是一行改动。
- **投影发现 O2 的一个缺陷，已修**（`57633fe4`）：失败路径的文本统一以宿主加的 `Error: Exit code N` 开头（208/208）。规则把这一行当成"另一个失败"，所以失败路径上 0 次生效。单测没发现，是因为夹具里没有这一行。修复后单测加上了这个前缀。
- **O1 的变异验证发现一个冗余分支，已删**（`bf5c71f5`）："裸文件名 → 无法定位"这条分支被后缀规则完全覆盖：裸文件名必然是同名目标的后缀。删掉它，行为不变。
- **两个旧守卫按原意重述**：`tests/pre-tool-recall.test.mjs` 里 D#78 的两个正向对照，原来编辑的是 `<根>/utils.mjs`，夹具里的边却是 `scripts/utils.mjs` 和 `lib\utils.mjs`，也就是另一个文件，恰好是 O1 要排除的形状。这两个对照的意图是"相对路径的边仍能召回它指向的那个文件"，现在改为编辑边所指的那个文件，意图不变。
- **实施过程中的现场证据**：
  - 本会话里，error-recall（已安装的 6.30.15）在我自己的 python 补丁脚本锚点失败、变异脚本解包失败时触发了 4 次，注入的都是无关记忆。这正是 O2 针对的形状。
  - 另外在 3 次**成功**的 `git commit` / `git log` 上也触发了，原因是提交标题里有 "fires"、"traceback" 这样的词。这类误报不在本批范围内，记为遗留。

## 8. 验证记录

### 8.1 投影（改动后的发布函数，作用在同一份语料：194 个 transcript、记忆库只读副本）

| 规则 | 作用面 | 去掉的量 | 字节 |
|---|---|---|---|
| O1 | PreToolUse，4,325 个块 / 4,037 行（其中 2,421 行是 observations） | **200 行**（observations 行的 8.3%），**158 个块**整块消失 | 整块消失的部分 54.0 KB |
| O2 | error-recall，622 个块 | **92 个块**（14.8%）：PostToolUse 52、PostToolUseFailure 40 | 47.7 KB |
| O3 | O2 之后剩下的 error-recall，1,484 行 | **220 行**（14.8%）是线程内的重复，32 个块整块消失 | — |
| O4 | 622 个块的提示行 | 全部 | 30.7 KB（占 error-recall 字节 324.3 KB 的 9.5%） |

- 投影只数"去掉了什么"。O1 去掉一行后由下一条候选补位的效果，从 transcript 里投影不出来，所以没有计入。
- 按字节算，四项合计至少 132 KB / 195 个会话 ≈ **0.68 KB/会话**，约占插件 15.44 KB/会话的 4%。本批的目标是精度，不是字节；字节的大头仍是 pretool 那些同主题、不切题的行（报告 §4.3），而本批没有动它们。

### 8.2 测试与变异

- O3、O4：`tests/recall-shown.test.mjs`、`tests/error-recall-format.test.mjs`。实施前 3 个用例失败，实施后通过。
- O2：`tests/error-recall-suppression.test.mjs` 新增 10 个用例，`tests/error-recall-gate.test.mjs` 新增 1 个 hook 层用例（带"开关关闭时同一输入会触发"的前提断言）。在旧代码上 5 个失败（当时共 8 个用例；带宿主前缀的用例和截断栈帧的用例是后来补的）。
  - 变异 9 条全部被杀死。其中 M2b"空栈帧也算自己的代码"一开始存活，补了"栈帧被截掉的 traceback 照常注入"这个用例后被杀死。
- O1：`tests/file-edge-other-file.test.mjs`（7 个），`tests/pre-tool-recall.test.mjs` 新增 3 个。在旧代码上 9 个失败。
  - 变异 10 条：9 条被杀死；M5 存活，原因是那条分支冗余，已删除。
- O5、O6：`tests/instructions-cli-write-lines.test.mjs`，把说明里的两行命令照原样在沙箱库上跑一遍：实施前 3 个失败。verify 技能那条只断言文本，而且是和改动一起写的，没有先看到它失败。

### 8.3 盲评（§5 预先登记的规则）

（等待结果）

### 8.4 全量校验

（等待结果）
