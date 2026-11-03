# 历史会话复盘（第三轮）：claude-mem-lite 对 Claude 编程的帮助、阻碍、功能、数据与准确性

- **日期**：2026-11-03T12:49Z（UTC）
- **代码树**：`main` @ `f9b81c6f`（v6.30.15），工作区干净。本机运行的插件也是 **6.30.15**（`~/.claude/plugins/cache/sdsrss/claude-mem-lite/6.30.15`）
- **性质**：只读分析。没有改源码；记忆库先用 `sqlite3 -readonly … ".backup"` 拷到会话 scratchpad（12:42:43Z），再在副本上查询
- **与上一轮的关系**：上一轮是 `docs/audits/20260926-154904-session-history-analysis-r2.md`（下称 **R2**）。本轮：
  - 核对 R2 的 12 条建议落实了多少（§3）
  - 用 R2 之后的会话重新回答五个问题：有没有帮助（§4）、有没有阻碍（§5）、功能（§6）、数据（§7）、准确性（§8）
- **结论分级**：**已证实**（本轮有工具输出、探针或复现）/ **待验证**（只有推理，或样本不足以下结论）
- **同日更新**：§9 的建议已按 `docs/audits/20261103-r3-optimization-plan.md` 实施。实施前和实施中量到的新证据，推翻了其中两条：
  - **S3 撤回**：盲评中 7 个切题块里，有 3 个注入的就是 `change` 类记录。
  - **S1 的实施形式 O2（报错只来自模型自己的脚本时不注入）撤回**：它去掉的块盲评 4/30 切题，高于对照组的 2/30。
  - S2 只做了 (c)（同名不同路径），通过了盲评；S4、S5、S6 已做；S8、S9 暂缓。

---

## 0. 摘要

**一句话：插件真正有用的是"显式写、跨会话读"，即待办账本和会话接续。自动注入这一半，盲评约 1/9 的块切题，没发现误导，但模型几乎从不确认用上；而仅 pretool 和 error-recall 两面，就占插件注入字节的约 56%（8.68 / 15.44 KB/会话）。**

1. **有帮助的部分（已证实）**
   - **待办账本（defer）是被用得最实的功能**。窗口内模型主动调用 `mem_defer` 108 次、CLI `defer` 约 140 次。库里 709 条待办中 393 条已完成，其中 392 条关联到了完成它的那条记录。
   - 在非本项目的 138 个会话里，模型主动**写**记忆 301 次，主动**读**只有 55 次（其中 `search` 11 次）。
   - 跨会话接续的效果在 09-29 沙箱 A/B 中已证实：插件组 26/28，对照组 5/12，p≈0.003。本轮没有重测。
2. **自动注入：模型几乎从不确认，盲评约 1/9 切题（已证实）**
   - 测量脚本 `citation-live-replay.mjs` 走产品自己的提取器。窗口内各注入面的引用率：

     | 注入面 | 引用 / 注入对 | 引用率 |
     |---|---|---|
     | PreToolUse | 12/1943 | 0.6% |
     | error-recall | 10/1380 | 0.7%（10-20 之后 0/745） |
     | FYI | 4/438 | 0.9% |
     | UserPromptSubmit | 1/51 | 2.0% |

   - 引用率不是"有没有用"的尺子（`rulers.md` 已写明），所以本轮另做了一次盲评（§4.3）：60 个真实注入块中，**适用 7 个（11.7% [5.8, 22.2]）**、同主题但对当下无影响 31 个、无关 22 个、**误导 0 个**。自动注入有少量真实价值，没有发现危害，信噪比约 1:7.6。
3. **阻碍：开销小，但大部分花在不适用的内容上（已证实）**
   - 插件平均每个会话注入 **15.44 KB**，占所有 hook 注入字节的 **79.1%**。按估算，这些内容在后续请求中被反复读入，约占全部 cache-read token 的 1% 左右。
   - hook 没有一次阻断报错，只有 7 次被取消。Bash 预过滤在不输出时耗时约 4.6 ms/次。
   - 主要成本是注意力，不是时延：每个会话平均收到约 35 个注入块，盲评中 88%（53/60）对当下的操作不适用（§4.3）。
4. **功能问题**
   - **error-recall 的"是不是失败"仍然判错不少（已证实）**：622 个块中 414 个（66.6%）是在命令退出码为 0 时触发的。抽样 42 个，其中 11 个的输出根本不是失败（列表、日志、数据表格）。
   - **CLI 参数不在常驻上下文里（已证实，P3）**：参数只写在详情文档里，所以非本项目会话中有 54 次 `help` / `--help` 调用，对应 115 次 CLI 写入。
5. **数据问题**
   - 库本身健康：`integrity_check` ok，活跃记录标题无重复。R2 提出的事件文件边问题已修好：10-06 之后的 3,744 条事件中，99.3% 带真实文件路径，临时路径 0 条。
   - **但自动写入的 `change` 类记录占活跃库 47%（505/1077），只被注入过 43 条、引用过 2 条（已证实）。**
   - 9,135 条事件的 `accessed_count` 全是 0。
   - 8 条记录落在 `worktrees--agent-*`、`daagu--frontend` 这类非项目 id 下。
6. **准确性**
   - 检索基准 `benchmark:gate --strict` 通过（R@10 0.900，nDCG 0.971），但语料已饱和：混合排序相对只用 BM25，nDCG 只高 0.0055。
   - 同义改写套件 R@10 只有 0.341；标识符片段套件为 0.000（已记录的已知缺口）。
   - 记忆内容本身的准确性（§8.2，20 条对照仓库核对）：
     - 正确 15、过时 3、部分错 1、错 1；
     - **5/20 描述的代码不在 main 上**：被回滚的提交，或只存在于 archive tag / 未合并分支的尝试；
     - 4 条没有可执行内容的全是 `change` 类。

**最高收益的三条建议**（§9）：
- 把 error-recall 从"默认注入"改为"只在高置信时注入"；
- 收窄 PreToolUse:Bash 召回；
- 停止注入（或停止生成）`change` 类自动记录。

三条都属于 L3（改的是已发布插件的默认注入行为），需要你拍板。先在冻结语料上做预先登记的盲评，再决定。

---

## 1. 数据来源与口径

| 来源 | 范围 | 用法 |
|---|---|---|
| 主会话 transcript | `~/.claude/projects/*/*.jsonl`，**排除本分析会话后 194 个**。首条时间 2026-10-06T16:20Z → 11-03T12:33Z（Claude Code 只保留 30 天，所以 R2 之后到 10-06 之间的会话已被删除） | 解析脚本（scratch，不是产品自带的遍历）：工具调用和结果、hook 附件（`hook_additional_context` / `hook_success.durationMs` / `hook_*_error` / `hook_cancelled`）、usage、用户消息 |
| 产品自带的测量脚本 | `benchmark/citation-live-replay.mjs --since 2026-10-06 --split 2026-10-20`（及 `--by-project`）；`benchmark/injection-budget.mjs --since 2026-10-06` | 各注入面的引用率、注入字节。这两把尺子遍历时包含当时正在写的本会话（195 个 transcript） |
| 记忆 DB | `~/.claude-mem-lite/claude-mem-lite.db` 的只读副本（12:42:43Z） | observations / events / deferred_work 的数量、类型、计数器、文件边 |
| 测试与基准 | `npx vitest run`；`npm run benchmark:gate -- --strict`；`node benchmark/denoise-ab.mjs`；`npm run benchmark:multipliers:gate` | 功能与检索准确性 |
| 独立评审 | 两个子代理：一个对 60 个注入块做盲评，一个对 20 条近期记忆对照仓库核对 | 有没有用、准不准 |
| git / CI | `git log`、`git tag`、`gh run list` | 发版与返工 |

**口径说明**（遵循 `docs/measurement/findings.md` 的测量原则）：
- 窗口内所有带模型字段的主会话都是 `claude-opus-5-5`（177 个；另 17 个会话没有 assistant 模型字段），Claude Code 版本 2.1.291–2.1.317。**不存在换模型的混杂**，但也因此**不能和 R2 或 10-07 / 10-16 报告的引用率做差**：语料不同，而且 09-22 前后跨模型。
- 引用率、注入字节一律引用产品自带测量脚本的输出。本文自写脚本得到的数字（块数、触发命令分类、延迟）标为 scratch。
- "非本项目"指 claudemd、code-graph-mcp、daagu、gsd-lite、sgc、sec 六个项目（138 个会话）。claude-mem-lite 自身的 56 个会话在开发插件本身，CLI 调用里混有测试，所以"主动使用"的统计以非本项目为准。
- hook 延迟来自 transcript 里的 `hook_success.durationMs`。transcript 只为 40,612 次 Bash 调用中的 4,349 次记录了 Bash 预过滤；没被记录的那些次的耗时，用 §5.2 的单独计时补上。

---

## 2. 全局画像

| 项目 | 会话 | 活跃时长（相邻事件 <30 min 累计） | API 请求 | 人类消息 | Bash | Edit | Write | Read | Agent |
|---|---|---|---|---|---|---|---|---|---|
| claude-mem-lite | 56 | 161.2 h | 15,581 | 326 | 14,316 | 893 | 268 | 419 | 218 |
| claudemd | 48 | 129.5 h | 9,890 | 289 | 8,919 | 784 | 249 | 299 | 117 |
| code-graph-mcp | 45 | 150.4 h | 10,265 | 197 | 9,042 | 953 | 131 | 404 | 116 |
| daagu | 29 | 48.2 h | 4,989 | 160 | 4,535 | 338 | 125 | 140 | 68 |
| gsd-lite | 11 | 38.8 h | 3,411 | 49 | 3,052 | 337 | 68 | 122 | 52 |
| sgc / sec | 5 | 13.1 h | 841 | 27 | 748 | 134 | 33 | 25 | 15 |
| **合计** | **194** | **541.2 h** | **44,977** | **1,048** | **40,612** | 3,439 | 874 | 1,409 | 586 |

- 人类消息 1,048 条中，291 条是 slash 命令。
- 请求上下文：首个请求的中位数为 62.0k；各会话上下文中位数的中位数为 278k；各会话峰值的 P90 为 715k。共发生 47 次 compact。
- 输出 47.3M token，cache read 14.9B token。

---

## 3. R2 建议的落实情况

| R2 建议 | 状态 | 本轮证据 |
|---|---|---|
| R1 `extractFilePaths` 支持 Bash 写法 | **已做、有效** | 10-06 之后的事件：A 段（10-06..10-19）1,904/1,915、B 段（10-20..11-03）1,816/1,829 带真实文件路径（合计 99.3%）；只有仓库根的 0 条（R2 时是 53.5%） |
| R2 PreToolUse 增加 Bash | **已做** | `hooks/hooks.json` 有 `Bash` matcher → `scripts/pre-tool-recall-bash.sh`。PreToolUse 块 4,303 个中 3,753 个（87.2%）来自 Bash。**但引用率只有 0.6%**，见 §4.2 |
| R3 `created_at_epoch` 平局结构守卫 | **已做** | `tests/order-by-created-at-guard.test.mjs` 存在，且在 9,909 个用例中通过 |
| R4 本地 CI 环境一臂；同日合并发版 | 前半已做，后半**未做** | `npm run test:ci-env` 存在。但 10-06 以来 28 天发了 36 个版本：10-07 一天 7 个，11-02 一天 4 个。其中 **v6.23.0 和 v6.28.0 的 Release 失败**，烧掉了两个版本号（§6.4） |
| R5 error-recall 抑制 TDD RED 与打印数据的命令 | **已做，仍不够** | `5f1bb948`、`f40871e5`、`6f3f5df2`（v6.14.0），以及 `6ab371c7`（30 分钟内同一组记忆只给一次）。本轮仍有 66.6% 在退出码为 0 时触发，引用 0/745（§6.1） |
| R6 摘要链路作为一个设计决定处理 | 已关闭 | D#95 done（D#92–94 dropped） |
| R7 `MEMORY.md` ≤10 KB；`episode flushed` 不再注入 | **部分完成** | `MEMORY.md` 28,753 → **19,483 B**，未到 10 KB；`injection-budget` 的分类里已没有 flush 行 |
| R8 直接字段排除 scratchpad 等路径 | **已做、有效** | 10-06 之后的事件中，scratchpad、`tool-results/`、`node_modules/` 路径为 0 条 |
| R9 Not done 自动写进 `mem_defer` | **未采纳** | 用户仍有 **52 条**消息是把 "Not done" 段粘回来（长度中位数 1,131 字符），分布：本项目 15、code-graph-mcp 9、claudemd 8、daagu 7 |
| R10 子代理 brief 补两条 | 不在本仓库 | — |
| R11 评审报告落盘 | **已做** | 10-06 以来 `docs/audits/` 新增 164 个文件 |
| R12 移交其他插件的问题 | 仍存在 | claudemd 的 `reply-language-check.sh` 在窗口内阻断 **171 次**，是所有 hook 阻断的全部 |

---

## 4. 有没有帮助

### 4.1 有帮助的部分：显式写入、跨会话读取（已证实）

非本项目 138 个会话中，模型主动调用插件的次数（scratch；CLI 次数用 `…/claude-mem-lite/<ver>/cli.mjs <verb>` 识别）：

| 方向 | 调用 | 次数 |
|---|---|---|
| 写 | MCP `mem_save` 102 · MCP `mem_defer` 84 · CLI `defer` 76 · CLI `save` 39 | **301** |
| 读 | CLI `get` 27 · MCP `mem_get` 3 · CLI `search` 10 · MCP `mem_search` 1 · `recent` 2 · `defer list` 12 | **55** |
| 查用法 | CLI `help` 40 · `--help` 14 | 54 |

- **待办账本被持续使用，而且能闭环**：
  - `deferred_work` 共 709 条：open 142、done 393、dropped 174；done 中有 392 条带 `closed_by_obs_id`。
  - 按项目看：本项目 430 条（open 86）、code-graph-mcp 160 条（open 48）、claudemd 96 条（open 3）。
  - SessionStart 的待办段平均每个会话 0.70 KB（`injection-budget`）。
- **会话接续**：09-29 沙箱 A/B（`docs/audits/20260929-sandbox-usage-eval.md` §8.3）的结论是"需求只在对话里说过、又要跨会话接着做"时，插件组完成 26/28，对照组 5/12，p≈0.003。本轮的真实会话没有对照组，无法复测；但上面的待办闭环与它一致。
- **本会话的现场样本**（只作佐证）：本会话共收到 8 个注入块，2 个切题。
  - 切题：`#465` 提醒"跨 09-22 的引用率按日期切会测到换模型"，让我把窗口定在 10-06 之后；`E#4403` 说明 `identifier_parts` 套件为 0 是已知缺口。
  - 无关：其余 6 个。

### 4.2 自动注入的引用率（已证实）

`citation-live-replay.mjs`（产品提取器，单位为（会话, id）对；176 个带注入的会话，6 个项目）：

| 注入面 | 全窗口 | 10-06..10-19 | 10-20..11-03 |
|---|---|---|---|
| pretool | 12/1943 = **0.6%** [0.4, 1.1] | 5/795 = 0.6% | 7/1148 = 0.6% |
| error_recall | 10/1380 = **0.7%** [0.4, 1.3] | 10/635 = 1.6% | **0/745 = 0.0%** [0.0, 0.5] |
| fyi | 4/438 = 0.9% | 3/184 | 1/254 |
| ups | 1/51 = 2.0% | 1/15 | 0/36 |

- 分项目看：code-graph-mcp 的 pretool 0/415、error_recall 0/291、fyi 0/102；其余项目都在 0.4%–2.0%，只有 daagu 的 ups 是 1/13。
- 被注入的 id 在一个会话里重复出现的情况（scratch）：
  - error-recall：1,739 次 id 注入对应 1,377 个（会话, id）对，其中 71 对在同一会话里出现 ≥3 次，最多 11 次；
  - pretool：85 对 ≥3 次，最多 11 次。
- **读法**：引用率不是"有没有用"的尺子。10-07 的盲评显示，被引用的对里适用的是 0/11（`rulers.md` "What a cite rate cannot decide"）。所以 0.6% 本身不证明"没用"，它只说明模型几乎从不按引导去确认这些记忆。真正的"有没有用"见 §4.3 的盲评。

### 4.3 盲评：注入的内容在那一刻有没有用（已证实，n=60）

**做法**：
- 样本：按 sha1 确定性抽取 60 个注入块，来自 6 个项目；其中 pretool-Bash 30、pretool-Read/Edit/Write 15、error-recall 15。
- 每个样本附带：最近一条用户消息、触发调用、注入原文、之前 2 步和之后 6 步的操作。
- 去掉注入面标签、打乱顺序后，交给一个不知道假设的子代理评审。
- 标签五选一：
  - APPLICABLE：至少一行会改变、阻止或确认后续可见的某一步；
  - TOPICAL：同文件或同主题，但不影响后续操作；
  - IRRELEVANT：无关；
  - MISLEADING：会推向错误的一步；
  - UNCLEAR：信息不足以判断。
- 原始结果在会话 scratchpad 的 `judge-results.jsonl`。

| 注入面 | APPLICABLE | TOPICAL | IRRELEVANT | MISLEADING | 适用率 [Wilson 95%] |
|---|---|---|---|---|---|
| pretool-Bash | 3 | 19 | 8 | 0 | 3/30 = 10.0% [3.5, 25.6] |
| pretool-Read/Edit/Write | 2 | 9 | 4 | 0 | 2/15 = 13.3% [3.7, 37.9] |
| error-recall | 2 | 3 | 10 | 0 | 2/15 = 13.3% [3.7, 37.9] |
| **合计** | **7** | **31** | **22** | **0** | **7/60 = 11.7% [5.8, 22.2]** |

- **适用的 7 个**都是具体的流程坑，例如：
  - C08："提交前在 `ADDING-NEW-HOOK.md` 加测试行"，代理随后正是这么做的；
  - C19："改 spec 会打断 hash pin，先读 diff 再同步"；
  - C48："changelog 的 awk 抽取会跨 fenced block"。
- **从不误导**：MISLEADING 为 0/60。
- **最大的一类是 TOPICAL**（31/60）：教训属于同一文件或同一子系统，但与模型正在做的那一步无关。IRRELEVANT 里有 5 个是**文件名撞车**：不同仓库的 `mod.rs`、`review.md`、`README.md`、`MEMORY.md`。
- error-recall 的 15 个里，评审判定"输出确实是失败"的 11 个、不是失败的 3 个、不确定 1 个。这与 §6.1 抽样的 31/42 一致。
- **换算到每个会话**（估算）：pretool 与 error-recall 合计约 31 块/会话（(5,466 + 622) / 195），按 11.7% 算，每个会话约有 4 块适用、约 27 块不适用。这些适用的块是否真的改变了模型的行为，从 transcript 看不出来：模型几乎不引用它们（§4.2），而 C08 那一类"代理随后照做了"的情况，也可能是它本来就会这么做。
- **结论**：自动注入**有少量真实价值，没有发现危害**。但信噪比约 1:7.6（7 个适用对 53 个不适用）。注入字节的大头花在不适用的内容上。

---

## 5. 有没有阻碍

### 5.1 上下文与 token（已证实；token 换算是估算）

`injection-budget.mjs --since 2026-10-06`（195 个会话）：

| 注入面 | 触发 | KB / 会话 | 主要内容 |
|---|---|---|---|
| pretool | 5,466 | **7.06** | 教训行 3.23，Read→Edit 提示 1.60，块头 0.86 |
| session_start | 242 | 3.23 | Last Session 1.13，Recent 0.77，待办 0.70 |
| ups_search（`user-prompt-search.js`） | 334 | 1.77 | 待办引用 1.22，FYI 0.37 |
| ups_context（`hook.mjs user-prompt`） | 130 | 1.65 | handoff 1.52 |
| posttool（error-recall 等） | 513 | 1.18 | error_recall 1.08 |
| posttool_failure | 208 | 0.54 | error_recall 0.54 |
| **claude-mem-lite 合计** | | **15.44**（占全部 hook 注入的 79.1%） | |

- **按 token 估算**：注入内容在被注入之后的每次请求里都会被重新读入（直到 compact）。scratch 统计按每 token 3–4 字节换算，约为全部 14.9B cache-read token 的 0.55%–0.73%。这个统计只认出了约 2/3 的注入字节（2,030 KB，测量脚本是 3,010 KB），按比例放大约为 0.8%–1.1%。
- **结论**：token 成本约 1%，不大。按盲评，其中约 88% 花在对当下不适用的内容上（§4.3）。
- 用户此前定的目标是"每会话 <8 KB 且引用率不降"（v6.27.0 的 12.66 KB 是冻结语料上的读数，**不能和这里的 15.44 做差**：语料不同）。

### 5.2 时延（已证实）

transcript 里有记录的 claude-mem-lite hook（scratch）：

| hook | n | P50 | P90 | P99 | 最大 |
|---|---|---|---|---|---|
| `pre-tool-recall-bash.sh`（被记录的） | 4,349 | 71 ms | 116 | 249 | 5,493 |
| `pre-tool-recall.js` | 1,115 | 50 ms | 78 | 182 | 449 |
| `post-tool-use.sh` | 512 | 109 ms | 165 | 320 | 954 |
| `user-prompt-search.js` | 333 | 96 ms | 173 | 485 | 547 |
| `hook.mjs session-start` | 241 | 199 ms | 353 | 586 | 625 |
| `hook.mjs user-prompt` | 130 | 186 ms | 449 | 1,360 | 1,387 |
| `hook.mjs post-tool-failure` | 208 | 87 ms | 144 | 227 | 347 |

- 被记录的调用合计约 660 s，分摊到 541.2 活跃小时，约每小时 1.2 s。
- 没被记录的 Bash 预过滤，我单独计时：一条不涉及文件的命令（`git status && npx vitest … | tail`），A/B/A/B 四轮各 200 次，耗时 4,512–4,645 µs/次。按 40,612 次 Bash 估算，全窗口约 3 分钟。
- **结论**：时延不是阻碍。

### 5.3 报错与阻断（已证实）

- claude-mem-lite 的 hook 在窗口内**没有一次 `hook_blocking_error` 或 `hook_non_blocking_error`**。
- 只有 7 次 `hook_cancelled`：`pre-tool-recall-bash.sh` 5 次、`user-prompt-search.js` 1 次、`hook.mjs user-prompt` 1 次。
- 所有 171 次阻断都来自 claudemd 的 `reply-language-check.sh`（不在本仓库）。

### 5.4 注意力与多余的往返（已证实）

- 每个会话平均收到约 35 个 claude-mem-lite 注入块：5,466 + 242 + 334 + 130 + 513 + 208 = 6,893 次触发，除以测量脚本口径的 195 个会话。注意 242 是 SessionStart 的触发次数（含 `/clear` 和 compact），不是会话数。
- error-recall 块的末尾带 `→ Use mem_get(ids=[…]) for details`。窗口内 MCP `mem_get` 只被调用 3 次，所以这行提示基本没人照做。
- 查 CLI 用法要多一次往返：非本项目会话中 54 次 `help` / `--help`，对应 115 次 CLI 写入。模型要用 `defer add` / `save`，又看不到参数格式，于是先跑一次 help。

---

## 6. 功能问题

### 6.1 error-recall 仍在对"不是失败"的输出触发（已证实，P1）

- 622 个 error-recall 块中，**414 个（66.6%）走的是 PostToolUse**，也就是宿主认定的退出码 0；208 个走的是 PostToolUseFailure。
- 退出码为 0 的那 414 个，按触发命令的首个命令分类（scratch）：
  - `python3` 65、`npx vitest … | head` 29、`cat` 17、`for` 13、`sed` 10、`git add` 8、`node --test … | head` 8；
  - 其余大多是以 `SP=…/scratchpad` 开头的探针脚本。
- **确定性抽样**（每 10 个取 1 个，共 42 个），逐条读输出：
  - **11 个的输出不是失败**：`npm pack --dry-run` 的文件列表、`grep` 的匹配列表、`gh run view` 的 job 列表（全部 success）、`ps`、`npm help`、探针打印的数据表、`cli get` 打印的待办正文，等等；
  - 31 个确实是失败，其中大部分是两类：
    - python 改文件脚本里的 `assert s.count(old)==1`，也就是"锚点没对上"；
    - 刚写好的测试故意先看到 RED。
  - 这两类失败在库里没有对应的教训：抽样中给它们注入的，都是无关条目。
- **注入的内容与失败相关的**：42 个里只有 2–3 个。
  - 相关：npm EBADENGINE 警告 → `#1236`（同一主题）；NoneType 报错 → `#529`。
  - 典型的无关：python 锚点失败 → `#325`（cap-trimmed rows），出现 4 次；`bc: command not found` → `#68`（plugin CLI 名称），出现 3 次。
- **本会话现场**：我 `cat` 几份记忆文件（退出码 0，只读），因为文件内容里有 "malformed / segfaults"，触发了 error-recall，注入 `#1037 / #109 / #1015`，全部无关。
- **机理**：
  - v6.14.0 的门已经挡住了"刚编辑过的测试文件"和 `gh --json` 这类打印数据的命令；
  - 但 Opus 5.5 改文件的主要方式是 python heredoc，读文件和跑探针也常用复合命令。所以"刚写的东西失败了"和"打印出来的文本里有错误词"这两类，仍从门的缝里大量进入。
- 测量脚本给出的引用：10-20 之后 0/745。

### 6.2 PreToolUse:Bash 召回：覆盖面上去了，适用率与 Read/Edit 面相当，约 1/10（已证实，P1）

- R2 的 N1 已修：PreToolUse 块里 87.2% 来自 Bash。
- 触发它的 Bash 命令首个命令（scratch）：
  - `sed -n` 2,247（60%）、`cat` 302、`grep` 294、`python3` 293、`git` 106、`wc` 67、`ls` 59、`head` 44、`sed -i` 44。
  - 也就是说，绝大多数是**读文件的片段**，而不是写文件。
- **量来自"读的文件多"，不是"同一文件重复注入"**：
  - Bash 触发的块里共 3,179 个"Lessons for <文件>"段，对应 2,891 个不同的（会话, 文件）对，平均 1.10 段/对；
  - 同一会话同一文件出现 ≥3 次的只有 43 对。现有的每会话去重是起作用的。
- 问题在于：教训只按文件名匹配，与读的那一段、当下的任务无关。09-29 沙箱的读数是：文件关联的教训只有 6.3% 同时和当前文件、当前任务都相关。
- 引用：pretool 全窗口 0.6%。scratch 统计里"块里的 id 之后被提及"：Bash 触发 3,753 块中 14 块，Read / Edit / Write 触发 550 块中 2 块。
- 盲评按触发方式分开（§4.3）：Bash 触发的适用率 3/30 = 10.0%，Read/Edit/Write 触发的 2/15 = 13.3%，两者区间重叠。Bash 这一面的问题不是"比工具调用那一面更差"，而是触发次数多了 6.8 倍（3,753 对 550），"同文件不同事"的块被成倍放大。

### 6.3 CLI 参数不在常驻上下文（已证实，P3）

见 §5.4。
- `defer add` 的完整参数（`--priority`、`--detail`）写在各项目的详情文档 `.claude/plugin_claude_mem_lite.md` 里（本仓库第 118 行；claudemd、code-graph-mcp、daagu、gsd-lite 四个项目都有这个文件）。
- 但每次都加载的托管块和 MCP instructions 里只有 MCP 形式（`mem_defer({title, priority, detail})`），没有 CLI 形式。
- 所以模型走 CLI 时，要么先读详情文档，要么先跑 help。实测是跑 help：54 次。两者都是一次往返，代价不大。
- 改这里属于 **L3**：MCP instructions 和托管块是 LLM 可见的元数据。

### 6.4 发版质量（已证实，P2，属流程）

- 10-06 以来：727 个提交中，标题含 review / repair / correct / withdraw / revert / retract 的有 160 个（22.0%）；36 个版本；`docs/audits/` 新增 164 份评审与测量报告。
- **Release 失败 2 次，各烧掉一个版本号**：v6.23.0（10-07）、v6.28.0（10-17，记忆 `feedback-ci-runner-has-no-claude` 记录了原因）。
- CI 失败 12/88 次。其中 1 次在 `main` 上的 v6.30.14 release 提交：`secret-scrub` 线性时间用例在 CI 的 Node 26 job 上超出预算。v6.30.15 修了它。
- 同日多发：10-07 7 个版本（v6.22.1–v6.25.0），11-02 4 个（v6.30.11–v6.30.14）。记忆 `feedback-batch-same-day-releases` 记录了"同一天的修复合并发版"这条规则。

---

## 7. 数据问题

### 7.1 健康的部分（已证实）

- 副本 `PRAGMA integrity_check` 为 `ok`。
- 规模：observations 1,119（活跃 1,077）、events 9,135、deferred_work 709、session_summaries 632、user_prompts 1,421。
- 活跃记录按（项目, 小写标题）分组，重复 0 组。
- 事件文件边见 §3 R1 / R8：99.3% 带真实路径，临时路径 0 条。

### 7.2 `change` 类记录：占一半，几乎从不被用（已证实，P2）

| 类型（活跃） | 条数 | 被注入过 | 被引用过 | 被显式读取过 | 无 lesson |
|---|---|---|---|---|---|
| change | **505** | 43 | **2** | 10 | 12 |
| bugfix | 396 | 204 | 65 | 103 | 0 |
| decision | 126 | 64 | 27 | 42 | 0 |
| discovery | 48 | 17 | 6 | 16 | 15 |
| refactor | 2 | 2 | 1 | 1 | 0 |

- `change` 占活跃库的 46.9%，其中 326 条是 importance 2。
- 它们大多是自动摘要写入的"做了哪些改动"。被注入过的只有 8.5%（43/505），被引用过 2 条。
- 同样的对比：bugfix 被注入过 51.5%，被引用过 16.4%。
- 后果（推断，本轮未测）：
  - 占据 FTS 召回与 Recent 表的候选位；
  - 在需要 importance ≥2 的池子里与真正的教训竞争。

  可以用 S3 验收里的池子 replay 来测。
- §8.2 的抽查：change 类 6 条中，actionable 2 条、WRONG 1 条；bugfix 与 decision 14 条全部 actionable。

### 7.3 `events.accessed_count` 全为 0（已证实，P3）

- 9,135 条事件，`accessed_count > 0` 的为 0 条。
- 唯一的写入点是 `lib/activity.mjs:105` 的 `getEvent`，也就是 `activity get` 显式取一条。
- pretool 注入 `E#NNNN` 不会计数。所以这一列对"事件有没有用"没有任何信息量。
- 计数全为 0，说明从这一列加上之后，没有任何人调用过 `activity get`。而事件每天写入约 147 条（10-06 以来 21 个写入日的中位数）。

### 7.4 非项目 id 下的记录（已证实，P3）

- observations 有 8 条落在 7 个非项目 id 下：`worktrees--agent-*` 4 个、`scratchpad--loop-smoke`、`daagu--frontend`、`daagu--backend`；events 有 2 条在 `scratchpad--loop-smoke`。
- 按项目过滤的注入面（SessionStart、pretool 的项目范围）不会选到它们（推断：这些面按 `project` 列过滤）。
- 成因（待验证）：会话或子代理的 cwd 是 worktree 或子目录时，项目 id 取了 cwd 而不是 git 根目录。

### 7.5 引用信号失效后的消费者（已证实，P3）

- 10-06 之后写入的活跃记录：`cited_count` 合计 13，`decay_seen_count` 合计 2,143，即每次判定被引用的比例 0.6%。
- 9-22 之后写入的行中，38%（373/974）有 `demoted_at`。按 `lib/citation-tracker.mjs:1795-1806` 的注释，这只是 streak 翻转的记账，不改 importance（D#179/D#198），所以不会造成丢行。
- 但 pretool 的每文件排序键 `citeFactor` 仍在消费这个信号。引用率 0.6% 时，它基本等于噪声加写入时期。
- `benchmark:gate` 的 `drop cite` 消融为 Δ=0；这把尺子在乘子上是盲的（CLAUDE.md），所以这个读数不能用来下结论。

### 7.6 开发树的 CLI 仍在打开真实记忆库（已证实，P3）

- 记忆 `project-repo-cli-opens-real-store`（10-17）记录了：仓库里的 `cli.mjs` 在没设 `CLAUDE_MEM_DIR` 时打开的是 `~/.claude-mem-lite/claude-mem-lite.db`，并会用开发树的代码跑迁移和一次性的 pass。
- 本项目会话里用仓库 `cli.mjs` 的调用：

  | 时段 | 没设 `CLAUDE_MEM_DIR` | 设了 |
  |---|---|---|
  | 10-18 之前 | 111 | 16 |
  | 10-18 之后 | 19 | 4 |

  10-18 之后那 19 次中，打开数据库的至少 8 次（`defer list` 6 次、`get` 2 次）；其余是 `help` 和一次无效命令。
- `cli.mjs` 里只有判断"是不是 git checkout"的 `gitCheckout()`（`cli.mjs:60`），而且只用在安装损坏时的提示上。**没有**"开发树 + 真实库"的拦截。
- 这条也说明：**教训写进了记忆，并没有阻止复发**。本会话里 pretool 还把相关的 `E#7161` 注入给了我。要防住它，需要一个机制，而不是又一条记忆。

---

## 8. 准确性

### 8.1 检索（已证实）

| 测量 | 结果 |
|---|---|
| `benchmark:gate --strict`（基线 2026-11-01T07:15:31Z，12-01 过期） | 全部 PASS：R@10 0.8998、P@10 0.8497、nDCG 0.9712、MRR 0.9611、P95 1.92 ms |
| 同一矩阵：混合排序相对只用 BM25 | R +0.0002、nDCG +0.0055；逐查询有 2 个变好、3 个变差 |
| `denoise-ab` precision_hard_negatives | R@10 0.887、P@10 0.811 |
| `denoise-ab` vocab_mismatch_paraphrase | **R@10 0.341、P@10 0.155** |
| `denoise-ab` cjk_mixed | R@10 1.000、P@10 0.940 |
| `denoise-ab` identifier_parts | **R@10 0.000**（已记录的已知缺口：B1 尝试于 09-27 回滚） |
| 行为探针 | 多文字 8/8、跨源 13/13、待办 10/10、事件流水线 9/9 |
| `benchmark:multipliers:gate` | 自检 32/32 通过 |

- **读法**：用词与记忆一致时，检索是准的；换个说法问就只能召回约三分之一；问的是标识符片段则召回为 0。
- 模型很少主动 `search`（§4.1：非本项目 11 次）。它和这里的召回率之间有没有因果关系，本轮没有证据。所以改进召回能覆盖到的调用量，目前只有这么多（见 §9.3）。

### 8.2 记忆内容的准确性：对照仓库核对 20 条近期记录（已证实，n=20）

**做法**：
- 样本：本项目 10-20 之后写入的活跃记录，按 id 散列确定性抽取 bugfix 8、decision 6、change 6，共 20 条。
- 交给一个只读子代理，逐条读 HEAD 的文件、`git show` / `git log -S`、CHANGELOG，按以下标签判定：
  - CORRECT：正确；
  - PARTLY：主旨对，但有具体说法错误或夸大；
  - WRONG：主旨被代码或历史否定；
  - STALE：写入时正确，HEAD 已不是这样；
  - UNVERIFIABLE：无法从仓库核对。
- 另判它是否 actionable（对以后的开发者有具体、真实、可执行的内容）。
- 原始结果在会话 scratchpad 的 `mem-verify.jsonl`。我复核了其中两条：`667151ac` 确实回滚了 D#580；`CHANGELOG.md:52` 确实把"命令里 JSON 的 `token` / `session_id` 值被擦除"列为 6.30.14 的新行为。

| 类型 | CORRECT | STALE | PARTLY | WRONG | actionable |
|---|---|---|---|---|---|
| bugfix (8) | 6 | 1 | 1 | 0 | 8/8 |
| decision (6) | 5 | 1 | 0 | 0 | 6/6 |
| change (6) | 4 | 1 | 0 | **1** | **2/6** |
| **合计** | **15/20 = 75% [53.1, 88.8]** | 3 | 1 | 1 | 16/20 |

- **准确性总体可以**：写入时就错的只有 1 条（#1280，change 类，把 6.30.14 新引入的行为说成"两棵树都有的缺口"）；主旨对、细节错的 1 条（#786）。
- **最主要的问题是"描述了不在 main 上的代码"**：20 条里有 5 条。
  - 2 条描述的提交后来在树内被回滚：#1025 → `667151ac` 回滚 D#580；#887 → `e5541105` 撤回 `a58f552f`。
  - 3 条描述的代码只在 `archive/d541-repair-db`、`archive/d546-repair-db` 这两个 tag 或未合并分支 `feat/d593-page-check` 上：#949、#941、#1154。HEAD 上没有 `lib/store-pages.mjs`，CLI 也没有 `repair-db`。
  - 其中 3 条被评审判为 CORRECT，因为它们如实记录了当时的尝试。但被注入到以后的会话时，读者会以为那套机制在树里。
- **change 类最弱**：
  - 4 条非 actionable 全是 change 类：lesson 为 "None"，或写着"没有教训"，或是一段截断的测试注释；
  - 唯一一条 WRONG 也在 change 类。
  - 与 §7.2 合起来看：change 类占活跃库 47%，注入后几乎不被引用，抽查中 4/6 没有可执行内容。

### 8.3 失败判定的准确性

见 §6.1：在退出码为 0 的触发中，抽样有 26%（11/42）的输出根本不是失败。

---

## 9. 优化建议

### 9.1 建议表（按收益 / 风险排序）

| 编号 | 优先级 | 建议 | 依据 | 验收 / 测量 | 级别 |
|---|---|---|---|---|---|
| S1 | **P1** | **error-recall 加相关性门**：只有当记忆正文与本次错误指纹至少共享一个稀有词（错误码、异常类名、出错文件名、报错行里的标识符）时才注入；同一个 id 每个会话只给一次（现在是 30 分钟一次）。**不要**直接关掉退出码为 0 的那条路径：盲评里 2 个适用的块，有 1 个（C19）就走的这条路径 | §6.1：66.6% 在退出码为 0 时触发，抽样 26% 不是失败；盲评 2/15 适用；引用 0/745；1.62 KB/会话；71 个（会话, id）对重复 ≥3 次 | ① 先冻结语料（`injection-budget --freeze`）；② 预先登记：在同一批块上，新门保留的适用块 ≥ 旧门的 80%，块数降 ≥60%；③ 两臂用同一评审方法盲评；④ `error-recall-live-replay` 读名集差；⑤ 字节用 `injection-budget --project` | **L3**（已发布插件的默认注入行为） |
| S2 | **P1** | **收窄 PreToolUse 召回的量，而不是去掉 Bash 这一面**。可选的杠杆（按风险从低到高）：<br>(a) 每个会话 pretool 块设上限（同一文件已基本只给一次，平均 1.10 段，所以上限要按"文件数"设）；<br>(b) 只给 `lesson_learned` 非空、importance ≥2 的 bugfix / decision；<br>(c) 文件名不唯一时（`README.md`、`mod.rs`、`review.md`）要求目录也匹配 | §4.3：Bash 3/30、Read/Edit 2/15，两者区间重叠，问题出在量；Bash 触发是 Read/Edit 的 6.8 倍；pretool 7.06 KB/会话，是最大的一面；IRRELEVANT 里有 5 个是文件名撞车 | 同 S1 的预先登记盲评；验收标准：适用块保留 ≥80%，字节降 ≥50%；另做"正确用法普查"：任务明确涉及的文件仍能拿到它的 bugfix 教训 | **L3** |
| S3 | ~~P2~~ **已撤回** | ~~`change` 类自动记录不进注入池（检索仍可查到），或者干脆停止生成~~。撤回原因：盲评中 7 个切题块里有 3 个注入的就是 change 类（见同日的优化方案 §2） | §7.2：占活跃库 47%，注入过 8.5%，引用 2 条；§8.2：actionable 2/6，唯一一条 WRONG 在此类 | 用 `keyctx-pool-replay` / `rerank-pool-replay` 读池子的名集差；Recent 表与 pretool 的块数前后对比 | **L3**（改注入内容） |
| S4 | P2 | **记录引用的提交已被回滚，或不在 main 上时，标出来**：记录正文里的 8 位 sha 不是 HEAD 的祖先（`git merge-base --is-ancestor`），或者已被某个 `revert(...)` 提交点名时，在注入时加上"(not on main)"，或者先只在 `doctor` / `/claude-mem-lite:verify` 里列出 | §8.2：20 条中 5 条描述的代码不在 main 上（2 条被回滚，3 条只在 archive tag 或未合并分支上） | 对活跃库全量扫一次，数出这类记录有多少；变异验证：拿真实的回滚对（`dc080719` → `667151ac`）做反例 | 只做报告时为 L2；改注入内容为 **L3** |
| S5 | P2 | 删掉 error-recall 块末尾的 `→ Use mem_get(ids=[…])` 提示行 | §5.4：MCP `mem_get` 3 次，对应 622 个 error-recall 块 | `injection-budget` 的字节；`mem_get` 调用数 | L3（LLM 可见文本），改动约 1 行 |
| S6 | P3 | 把 `defer add` / `save` 的 CLI 参数写进 MCP instructions 或托管块（各一行） | §6.3：参数只在详情文档里；非本项目 54 次 help 往返对 115 次 CLI 写入 | 发版后读 transcript：help 次数 / CLI 写入次数，目标 <0.1 | **L3**（LLM 可见元数据） |
| S7 | P2 | 发版节奏：同一天的修复合并成一次发版，tag 前跑完 `npm run test:ci-env` 和"CI runner 上没有 claude"这一臂 | §6.4：28 天 36 个版本；同日 7 个和 4 个；Release 失败 2 次、烧掉 2 个版本号；22.0% 的提交由评审驱动 | 每周发版数；Release 失败数 → 0 | 流程（你定） |
| S8 | P3 | 子代理或 worktree 会话的项目 id 归到 git 主仓库根 | §7.4：8 条 observations、2 条 events 落在非项目 id 下 | 先复现成因：在 worktree 里起一个会话写一条记录；修完后新增的非项目 id 记录数 → 0 | L2 |
| S9 | P3 | 仓库 `cli.mjs` 从 git checkout 运行、又没设 `CLAUDE_MEM_DIR` 时，打印一行警告；对会写库的动词直接拒绝 | §7.6：记下教训之后，仍有 ≥8 次用开发树打开真实库 | 单测加 sandbox HOME 复现；之后读 transcript：这类调用数 → 0 | L2（开发者路径，不影响已安装插件） |
| S10 | P3 | 重盖 CLAUDE.md 的 Baselines 表 | 表中写的是 428 文件 / 6628（`c8cfab5`，09-25）；本轮 HEAD `f9b81c6f` 实测 **551 文件 / 9909** | `npx vitest run` 的读数写回，并带 sha 与日期 | L0（文件带发版守卫，单独提交） |

### 9.2 本轮建议执行的前三项

S1、S2、S3。三项都有冻结语料加预先登记盲评这一条现成的验收路径，而且互不冲突：它们分别作用于 error-recall、pretool 和写入侧。三项都是 L3，需要你授权；S7 是流程，需要你决定。

S4 有一个不需要 L3 的前半：只在 `doctor` 或 `/claude-mem-lite:verify` 里列出这类记录（L2），可以先做，先数出全库有多少条。

### 9.3 明确不建议做

- **不要再为提高引用率去改引导语或阈值**。引用率不是有用性的尺子：verdict 时期引用率高，适用是 0/11。本轮引用率 0.6%，盲评适用率却是 11.7%，两者并不同向。
- **不要撤掉 PreToolUse:Bash**。它的适用率和 Read/Edit 那一面一样（§4.3），撤掉等于退回 R2 的 N1。
- **不要扩大 error-recall 的失败判定正则**（`HARD_ERROR_RE`）。CLAUDE.md 记录过：每个新增锚点实测收益为 0。本轮的问题在"相关性"，不在"判定"。
- **暂不优化检索召回**（同义改写 0.341、标识符片段 0）。窗口内模型主动 `search` 只有 11 次。改进检索能覆盖到的情况太少，先数一数会有多少次调用经过这条路径，再决定（见记忆 `feedback-count-the-cases-that-reach-the-threshold`）。
- **不要为混合排序的乘子继续调参**。`benchmark:gate` 对它们是盲的：语料已饱和，Δ≈0。

---

## 10. 局限与待验证

- **没有对照组**：真实会话里没有"关掉插件"的一臂，所以"有没有帮助"的正面证据一半来自 09-29 的沙箱 A/B，一半来自使用痕迹（待办闭环、主动写入）。效率提升无法在本窗口内量化。
- **盲评只有一个评审、60 个样本**，而且评审只看到前后各几步的操作，看不到模型的思考。它能区分"切题"和"无关"，区分不了"切题但模型本来就知道"。
- **scratch 统计**（块数、命令分类、延迟、主动调用）是自写脚本得到的，不是产品自带的遍历。引用率和注入字节用的是测量脚本。CLI 调用的正则会把正文里出现的 `claude-mem-lite <词>` 误认成调用，所以"主动使用"只统计了带版本路径的已安装 CLI 和 MCP。
- **token 换算**按每 token 3–4 字节估算，并按测量脚本的字节数做了比例放大，是量级，不是精确值。
- **transcript 只保留 30 天**：R2 之后到 10-06 之间的会话已被删除，所以本轮无法给出 R2 建议上线前后同一语料的对比。
- **§7.4 的成因**没有复现。

---

## 附录 A —— 复现方法

解析脚本放在会话 scratchpad（不入库）。逻辑如下：

1. 遍历 `~/.claude/projects/*/*.jsonl`（只到会话这一层），排除当前会话；只看 `isSidechain !== true` 的条目。
2. `assistant` 按 `message.id` 去重后累计 usage；`tool_use` 与 `tool_result` 按 id 配对。
3. `attachment.hook_additional_context` 按文本前缀归到注入面：
   - `<claude-mem-context>` → SessionStart；
   - `[mem] PreToolUse recall` / `[mem] Lessons for` → pretool，再按 `hookName` 区分 Bash / Read / Edit；
   - `[claude-mem-lite] Related memories found for this error` → error-recall。

   然后用 `toolUseID` 找到触发它的调用及其 `is_error`。
4. `hook_success` 按 `command` 分组取 `durationMs`；`hook_blocking_error` / `hook_non_blocking_error` / `hook_cancelled` 按 command 计数。
5. 尺子：

   ```
   node benchmark/citation-live-replay.mjs --since 2026-10-06T00:00:00Z --split 2026-10-20T00:00:00Z
   node benchmark/citation-live-replay.mjs --since 2026-10-06T00:00:00Z --by-project
   node benchmark/injection-budget.mjs --since 2026-10-06T00:00:00Z
   npm run benchmark:gate -- --strict
   node benchmark/denoise-ab.mjs --save <scratch>/denoise-now.json
   npm run benchmark:multipliers:gate
   ```

6. DB：`sqlite3 -readonly ~/.claude-mem-lite/claude-mem-lite.db ".backup <scratch>/snap.db"`，之后只查询副本。
7. Bash 预过滤计时：

   ```
   IN='{"tool_name":"Bash","tool_input":{"command":"git status --short && npx vitest run tests/foo.test.mjs | tail -5"}}'
   # A/B/A/B 四轮，每轮 200 次：
   printf '%s' "$IN" | bash scripts/pre-tool-recall-bash.sh
   ```

8. 盲评样本：
   - 从 pretool（Bash 30 个、Read/Edit/Write 15 个）和 error-recall（15 个）中按 sha1 确定性抽取；
   - 每个样本附带最近一条用户消息、触发调用、注入原文、之前 2 步和之后 6 步的操作；
   - 打乱顺序，去掉注入面标签后交给评审子代理。
