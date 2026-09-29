# 历史会话复盘（第二轮）：问题、阻碍、缺陷、指标与优化建议

- **日期**：2026-09-26T15:49Z（UTC）
- **代码树**：`main` @ `042aea0`（v6.13.6），工作区干净。本机运行中的插件为 **6.13.5**（`~/.claude/plugins/cache/sdsrss/claude-mem-lite/6.13.5`，2026-09-26T13:51:03Z 装入）
- **性质**：只读分析。没有改源码；记忆库用 `sqlite3 -readonly … .backup` 拷到 scratchpad 后再查询
- **与上一轮的关系**：上一轮是 `docs/audits/20260925-200912-session-history-analysis.md`（下称 **R1**，覆盖 09-05 → 09-25T20:09）。本轮**不重复** R1 已证实、已修复的内容，重点在三件事：
  - (a) R1 建议的落实情况，以及实测效果
  - (b) R1 之后 19 小时（09-25T20:09 → 09-26T15:38，下称**后段**）新暴露的问题
  - (c) 全期数据里 R1 没有覆盖到的维度
- **结论分级**：**已证实**（本轮有工具输出、探针或复现）/ **待验证**（只有推理，或样本不足以下结论）

---

## 0. 摘要

**先说结论。**

R1 提出的 4 个 P1，已经在 19 小时内修复、发版并部署到本机：
- B1：error-recall 的 `cd` 前缀绕过
- B2：`#NN n/a` 被计为引用
- B4：SessionStart 的 Key Events
- pre-commit 复用绿灯

实测效果与预期一致（§3）。B4 的后半（修正摘要器的输入）和几条 P2 流程建议仍未落实。

本轮新发现、按影响排序：

1. **N1（P1，已证实）：模型改用 Bash 读写文件，产品采纳率最高的召回面被"饿死"。**
   - Opus 5.5 会话里，只有 **18.0%** 的文件修改走 Edit/Write 工具（114 次，另有 520 次走 Bash），读取只有 **14.7%** 走 Read 工具（67 次，另有 389 次走 Bash）。Opus 5 的对应比例是 60.8% 和 50.3%。
   - PreToolUse recall 只挂在 `Edit|Write|NotebookEdit|Read` 上。在 citation 全项目 replay 里，这个 face 的 (session, id) 对数：分界点前 168 对（51 个会话），之后只有 **5 对（4 个会话）**。两个窗口长度不同（约 13.8 天对 19.5 小时），按同一臂里 error_recall 的对数归一化后，pretool 与 error_recall 的对数比从 0.44 降到 0.048，约为原来的 1/9。
   - 同时 `extractFilePaths` 对 6 种常见 Bash 改文件写法，有 **5 种**提取不到目标文件。09-25/26 两天新写入的 events 里有 **53.5%** 没有真实的文件边（无文件，或者所有路径都只是仓库根）；09-21/22 是 20.6%。
   - 两头都坏了：召回时触发不了，捕获时也建不出文件边。
2. **N2（P2，已证实）：error-recall 的"是不是失败"已经判对了，但"给的记忆有没有用"仍然很差。**
   - 修复部署后，5 次触发全部是真实失败，`cd` 前缀误报为 0。
   - 但其中 4 次是 TDD 刻意制造的 RED，另 1 次是探针脚本自身报错；注入的记忆与这些失败都无关。全项目 replay 的引用率只有 12.5% [9.8, 15.7]%，后段臂为 2.9% [1.0, 8.1]%（n=105）。
   - 本分析会话里，它又对 exit 0 的只读分析输出（`node -e` 打印 transcript、`gh run view --log-failed | grep`）触发了 3 次。
3. **N3（P2，已证实）：同一类缺陷被逐站点、逐版本地修。**
   - `created_at_epoch` 平局这一类缺陷，连着修了 v6.13.2、v6.13.3、v6.13.4 三个版本。
   - 单行文本扫描显示，仍有约 **24 处生产站点**写的是 `ORDER BY … created_at_epoch DESC` 且没有 id 兜底。它们是否会产生平局，CLAUDE.md 自己也写着"unjudged, not cleared"。
4. **N4（P2，已证实）：发版节奏带来可测量的返工。**
   - 09-26 一天发了 7 个版本。**v6.13.0 的 CI 和 Release 都是红的**，只能烧掉一个版本号，由 v6.13.1 补发。
   - 原因：新写的测试在 CI 的彩色输出下断言失败（ANSI 转义码），本地跑不出来。
   - 后段 45 个提交中，有 19 个标题含 review/correct。
5. **N5（P3，已证实）：events 的 `file_paths` 里混入大量会话级临时路径。**
   - 本项目 1,045 条 events 中，107 条（10.2%）引用了 scratchpad 路径，43 条（4.1%）引用了 `node_modules`。

**最高收益的 3 条建议**（详见 §7）：
- 让 PreToolUse recall 和 `extractFilePaths` 覆盖 Bash 的读写（N1）；
- 对 `created_at_epoch` 平局做一次总体裁定，并加一个真正的结构守卫（N3）；
- 发版前在本地用 CI 的环境变量（至少 `FORCE_COLOR`）跑一臂，并把同一天的修复合并成一次发版（N4）。

---

## 1. 数据来源与口径

| 来源 | 范围 | 用法 |
|---|---|---|
| 主会话 transcript | `~/.claude/projects/-home-ai-dev-claude-mem-lite/*.jsonl`：61 个文件，**排除本分析会话 `a14ae020` 后 60 个，其中 55 个非空**。时间 2026-09-05 → 09-26T15:38 | 流式解析：工具调用/结果、hook 附件（含 `durationMs`）、`stop_hook_summary`、`cost-state`、token usage、用户消息 |
| 子代理 transcript | `<session>/subagents/*.jsonl`：108 个 | 单独统计：类型、token、报错、最终报告的长度和语言 |
| 记忆 DB | `~/.claude-mem-lite/claude-mem-lite.db` 的只读快照（2026-09-26T15:43Z） | events / observations 的文件边、deferred_work |
| 尺子 | `benchmark/citation-live-replay.mjs --since 2026-09-12 --split 2026-09-25T20:09:12Z`（HEAD 上发布的提取器） | 各 face 的引用率。**这把尺子走的是全部项目的 transcript**，不只本项目 |
| 源码探针 | 进程内调用 HEAD 的 `extractFilePaths`、`detectBashSignificance` | 确认 N1、N2 的机理 |
| git / CI | `git log`、`git tag`、`gh run list`、`gh run view --log-failed` | 发版、返工、CI 结论 |

**口径说明**（遵循 `docs/measurement/findings.md` 的测量原则）：
- **分界点**：R1 的时间戳 2026-09-25T20:09:12Z。之前叫"前段"，之后叫"后段"。分界按每条事件的时间戳切，而不是按会话切。
- **修复部署点**：2026-09-26T13:51:03Z，即 6.13.5 装入插件缓存的时刻。**hook 行为的修复效果只能在这个时刻之后观察**，因为 hook 跑的是插件缓存里的代码，不是仓库里的代码。这段窗口只有 2 个会话（`8b475d66` 和本会话），样本很小，下文凡是用到它都会注明。
- **不要和 R1 的数字做差**。本轮是对同一批 transcript 的重新解析，会话文件在 R1 之后还在增长（例如 `c3c64219` 跨越了分界点），所以前段的读数与 R1 略有不同（例如 Bash 9,158 对 9,096）。本文所有"前后"对比，都来自**同一次遍历的两个臂**。
- **"Bash 改文件 / 读文件"是正则启发式**：
  - 改：`sed -i`、`perl -i`、`python3 - <<`、`python3 -c`、`cat >`/`>>` 写源码后缀、`tee`、`> x.mjs|md|json|sh`、`writeFileSync`、`git apply`。路径在 `/tmp/` 或 scratchpad 下的不计。
  - 读：命令以 `cat`、`sed -n`、`head`、`tail`、`nl`、`awk` 开头（允许 `cd … &&` 前缀）。
  - 两者都会有漏有误，只用来比较量级。
- **成本**：`cost-state.totalCostUSD` 是 Claude Code 按标价算出的会话累计值，包含该会话的子代理以及会话内的 haiku 调用。它**不等于实际账单**，只用来比较相对量级。

---

## 2. 全局画像

### 2.1 总量（主会话，排除本分析会话）

| 指标 | 前段（09-05 → 09-25T20:09） | 后段（→ 09-26T15:38） |
|---|---|---|
| 活跃时长（相邻事件间隔 <30 min 的累计） | 85.0 h | 11.4 h |
| API 请求（按 message.id 去重） | 11,594 | 991 |
| 工具调用 | Bash 9,158 · Edit 1,798 · Read 909 · Write 273 · Agent 86 · AskUserQuestion 40 · SendMessage 35 | **Bash 922** · Agent 19 · **Edit 19 · Read 17** · Write 5 · AskUserQuestion 3 |
| 工具报错 | 275（Bash 255、Edit 17） | 12（全部是 Bash） |
| 请求上下文 P50 / P90 / 最大 | 295k / 525k / 692k | 272k / 397k / 500k |
| 请求上下文 >300k 的占比 | 48.8% | 41.2% |
| 手动 compact | 4 次 | 1 次（`c3c64219`，420k） |

- **全期合计**：输出 11.65M token，cache read 3.88B token。
- **子代理合计**（108 个）：cache read 1.02B，输出 0.58M。
- **55 个会话的 `cost-state` 合计 $3,048.32**：单会话中位数 $42.72，最高 $192.62（`4894b5a2`，5.4 h，峰值上下文 690k）。
- **后段 5 个会话合计 $176.5**，期间发了 7 个版本（v6.13.0–v6.13.6）。

### 2.2 发版与返工

| 日期 | 发版数 | 说明 |
|---|---|---|
| 09-06 | 10 | 全期最高 |
| 09-26 | **7** | v6.13.0（**CI 与 Release 均失败**）→ v6.13.1 补发 → v6.13.2 … v6.13.6 |

- 后段共 45 个提交，其中标题含 `review` 或 `correct` 的有 **19 个**。典型节奏：功能提交 → "repair the vX pre-ship review findings" → "repair the vX delta review findings" → release。
- 后段共派出 19 个评审子代理，并行执行，各自运行时长的中位数约 14–17 分钟。分布：
  - v6.13.0、v6.13.2、v6.13.3、v6.13.4、v6.13.6 各 3 个（defect / claims / delta lens）；
  - v6.13.5 是 4 个 general-purpose；
  - v6.13.1 没有评审。
- claims-lens 的 FALSE 率（摘自各报告的 Tally 行）：

  | 版本 | FALSE / 总数 | 备注 |
  |---|---|---|
  | v6.12.2 | 6/53 | |
  | v6.13.0 | 9/52 | |
  | v6.13.2 | 3/25 | |
  | v6.13.3 | 0 | |
  | v6.13.4 | 1/20 | 另有 3 条 TRUE-BUT-MISLEADING |

- **v6.13.5 和 v6.13.6 的评审报告没有落进 `docs/audits/`**（`ls docs/audits | grep v6.13.6` 结果为 0）。
- 报告落盘本来就不一致：v6.12.0、v6.12.1、v6.13.1 也没有报告；v6.13.3、v6.13.4 的报告夹在 "fix: repair" 提交里一起落盘。审计轨迹没有固定的规则。

### 2.3 用户交互模式

- 去掉 teammate 空闲通知和 API 报错回显后，用户消息共 214 条。按关键词：
  - "继续"：50
  - 提交/推送/发版：56
  - 剩余/有价值：43
  - 按建议：18
  - **直接把 agent 的 "Not done" 段粘回来作为下一条指令**：10
  - 中文：7
- 后段 14 条用户消息，几乎全是"继续完成剩余工作""推送 发版"，以及粘回来的 Not done。
- 用户实际上在充当调度器：每一轮的 Not done 由用户手动搬运到下一轮。§7 建议 R9 针对这一点。

---

## 3. R1 建议的落实情况与实测效果

| R1 建议 | 状态 | 证据（本轮） |
|---|---|---|
| **B1** error-recall 的 `cd` 前缀绕过 | **已修、已部署、有效** | `68b44cd`，后续补丁 `c25e376`（heredoc、注释、写动词）。修复部署后 error-recall 触发 5 次，其中 `cd` 前缀命令 **0 次**（前段是 167/262）；逐条读输出，5/5 都是真实失败：4 次测试失败，1 次探针脚本报错（§4.2） |
| **B2** `#NN n/a` 计为引用 | **已修**，但为收口又补了 3 个提交 | `00effdc`，之后 `e7c064e`、`7c0d6f7`、`a04f292` 继续修否定语境的边界（"dismissal + applied"、"形容词 + 名词"）。这是 N4 返工的一部分 |
| **B4** Key Events 默认注入 | **前半已部署；后半未做** | 后段 5 次 SessionStart 中，修复部署之前的 4 次仍含 `### Key Events`；6.13.5 上的 `8b475d66` 不含，本会话的 SessionStart 也不含。修摘要器输入（D#69）**仍然 open** |
| **B3** adopt 文案过期 | 已修 | `a6a28c0` |
| pre-commit 复用绿灯 | **已做；命中率 32%** | `8d374b1`，另有 `65a77bb`、`4a6015c` 补漏。`8d374b1` 之后共 42 次 `git commit`（含 1 次报错），能从输出读到判定的 25 次：**REUSE 8**、"tree differs" 8、"no green stamp" 8、"unstaged changes" 1；另外 16 次输出被管道截掉，看不到判定。复用一次耗时约 12 s，完整跑约 50–72 s。提交耗时中位数仍是 52.2 s（n=50），原因是多数提交确实需要跑一次（"no stamp" 本来就不是重复跑）。真正仍在重复跑的是 "tree differs" 这 8 次，见 §5.4 |
| M3 citation-stats 补 SessionStart 读数；M2 停止展示 cited/injection 比率 | **未做** | 后段没有相关提交 |
| 常驻文件瘦身（`MEMORY.md` ≤10 KB） | **未做** | `MEMORY.md` 为 **28,753 B**（R1 时 28,635 B）；后段会话首个请求的上下文仍是 75–77k |
| `[mem] episode flushed` 簿记行不再注入模型 | **未做** | 修复部署后仍注入 7 次；本会话中也出现了（`[mem] episode flushed: 10 entries (Bash×10)`） |
| 上下文约 30 万时主动 `/clear` | **部分改善** | 后段上下文 P90 从 525k 降到 397k、最大值从 692k 降到 500k。这个变化混杂了"会话变短"（后段会话的跨度为 1.3–10.2 h，活跃时长为 1.3–3.7 h），不能归因于某一条建议 |
| vitest ssr 缓存不落 `/tmp` | **已见效** | `b631522`；本轮检查时 `ls -d /tmp/*/ssr` 为 0 个（R1 时为 60 个 / 156 MB） |
| 等 CI 改为后台监视 | **未落实** | 后段仍有 15 次前台 `sleep`（20–200 s，大多是轮询 CI 或 npm；我最初的正则漏掉了 `; sleep` 这种写法，统计成了 2 次，已由评审更正）。发版时也还在前台 `gh run watch`，例如 `8b475d66` 在 15:29:57 → 15:34:21 前台阻塞了 4.4 分钟 |
| 子代理 brief 模板（中文、heredoc、沙箱清理） | **部分改善，因果未证实** | §8 `rm -rf` 拦截：主会话前段 72 次、后段 2 次；code-graph 拦截：前段 53 次、后段 0 次。子代理最终报告仍有 96/108 是英文 |
| 同日修复合并发版 | **未采纳** | 09-26 发了 7 个版本 |

---

## 4. 新发现：产品缺陷与盲区

### 4.1 N1 —— Bash 读写文件让 PreToolUse 召回和文件边同时失明（已证实，P1）

**现象：按主模型分组**（全期主会话，启发式口径见 §1）：

| 主模型 | Edit/Write 工具 | Bash 改文件 | 工具占比 | Read 工具 | Bash 读文件 | 工具占比 |
|---|---|---|---|---|---|---|
| claude-opus-5 | 1,970 | 1,271 | **60.8%** | 852 | 842 | **50.3%** |
| claude-opus-5-5 | 114 | 520 | **18.0%** | 67 | 389 | **14.7%** |

- 后段 5 个会话全是 Opus 5.5：`72b4504d` 只有 1 次 Edit，却有 69 次 Bash 改文件；`a28e223e` 和 `e30aad1b` 的 Edit/Write 都是 0。
- **成因**（待验证其权重）：本会话的 harness 系统提示明确写着 "While bypass permissions mode is active: You can do much of your work through the Bash tool … make small, mechanical file changes with sed, heredocs, or short scripts"。模型换代与这条提示同时发生，本轮无法把两者的作用分开。无论哪个是主因，产品都需要适配。

**影响 1：召回触发不了。**
- `hooks/hooks.json` 的 PreToolUse 只匹配 `Edit|Write|NotebookEdit|Read` 和 `Agent|Task`，不匹配 Bash。
- 主会话里 `[mem] PreToolUse recall` 的注入：前段 745 次 / 85.0 h（**8.8 次/h**），后段 20 次 / 11.4 h（**1.75 次/h**）。
- citation 全项目 replay 的 pretool face：分界点前 **168 对 / 51 个会话**，之后 **5 对 / 4 个会话**。同一后段臂里，error_recall 有 105 对 / 13 个会话，说明后段会话本身并不少，是 pretool 这一面几乎停了。
- 这个 face 在前段的引用率是 41.7% [34.5, 49.2]%，是本次 replay 四个 face 中最高的（其余三个在 9.1%–15.5% 之间）。

**影响 2：捕获建不出文件边。**
- 进程内探针，用 HEAD 的 `bash-utils.mjs:895 extractFilePaths` 喂入本项目 transcript 里真实出现过的写法：

  ```
  python3 - <<'EOF' p="/home/…/hook.mjs" …          → []
  python3 - <<'EOF' p='/home/…/hook.mjs' …          → []
  sed -i "s/a/b/" lib/fast-summary.mjs              → []
  cat >> tests/fast-summary.test.mjs <<'EOF' …      → []
  cd /home/ai/dev/claude-mem-lite && sed -i … hook-llm.mjs → ["/home/ai/dev/claude-mem-lite"]（只有仓库根）
  perl -0pi -e "s/x/y/" /home/…/cli.mjs             → ["/home/…/cli.mjs"]（唯一正确）
  ```

  机理：命令分支只认"前面是行首或空白的绝对路径"（正则 `(?:^|\s)(\/[\w./-]+\w)`）。所以带引号的绝对路径和相对路径都拿不到，`cd <repo> &&` 前缀只能贡献一个仓库根目录。
- DB 快照中本项目 events 的文件边质量：

  | 日期 | events | 无文件 | 所有路径都只是仓库根 | 合计无真实文件边 |
  |---|---|---|---|---|
  | 09-21 | 74 | 3 | 8 | |
  | 09-22 | 81 | 6 | 15 | 09-21/22 合计 32/155 = **20.6%** |
  | 09-25 | 117 | 5 | 49 | |
  | 09-26 | 85 | 27 | 27 | 09-25/26 合计 108/202 = **53.5%** |

  口径：`file_paths` 解析后的每一项都等于 `/home/ai/dev/claude-mem-lite`，按 UTC 日期分组。初稿用的是更宽的口径（"最后一项是仓库根"），读数为 31.0% → 62.4%，经评审改为这里的严格口径；两种口径下的趋势相同。

- 没有文件边的记录，以后就不会被"与当前文件绑定"的召回找到。影响 1 让召回不触发，影响 2 让被召回的对象越来越少，两者叠加。

**为什么是 P1**：
- 在本次 replay 的四个 face 里，它是唯一一个引用率超过 40% 的。
- 它随模型和 harness 的默认行为漂移而失效，而且**不报错**：hook 只是不再被调用。现有测试全是 Edit/Read 形状的夹具，结构性地看不到这个问题。
- 这是 findings.md 里"总体只到你刚修的那一半"那一类问题的又一实例：守卫的总体是工具名，而真实行为已经换成了 Bash。

**修复方向**（L3：改 hooks.json 等于改变 LLM 可见的注入行为；而且 hooks.json 与 `install.mjs` 的 settings 双胞胎必须一起改）：
1. `extractFilePaths`：
   - 解析 `cd <dir> (&&|;)` 前缀得到 cwd，用它解析相对路径；
   - 识别带引号的绝对路径；
   - 识别写动词的目标：`sed -i … <f>`、`perl -i … <f>`、`cat >/>> <f>`、`tee [-a] <f>`、`> <f>`；
   - 从 python heredoc 里提取 `open('<f>')` 和 `p='<f>'` 字面量；
   - 解析出的路径仍要走 `isExcludedPath`。
2. PreToolUse 增加 Bash 匹配。先用 bash 预过滤（仿照 `post-tool-use.sh` 约 5 ms 的做法），只有命令确实是"读/写某个仓库内文件"时才进 node。延迟预算参考 §6：现有 pre-tool-recall 的 P50 为 55–61 ms。
3. **验收**：
   - 用本机 transcript 做前后两臂重放：Bash 改/读文件中能提取出真实文件的比例（基线就是上面这张表），以及每个会话的 pretool 注入对数（基线：后段 5 对 / 4 个会话）；
   - 对每一种新识别的写法，变异后必须变红；
   - 另做一次"正确用法普查"（见记忆 `feedback-new-warning-needs-correct-usage-sweep`）：只读的 `grep` 类命令不应该触发 pretool 注入。

### 4.2 N2 —— error-recall：判定"失败"已经准了，但"相关"仍然不准（已证实，P2）

**修复部署后，5 次触发都是真实失败**（`8b475d66`，13:54–15:02）：
- 1 次（13:54:26）是写 scratchpad 探针脚本后运行出错，exit 1，走的是 PostToolUseFailure。
- 4 次是 `npx vitest run …` 接管道到 `grep`（其中 2 次带 `-t 'P3-6'`），输出里有 `× …` 和 `AssertionError`，退出码被 `grep` 吞掉，所以被判为 exit 0。这 4 次都是**刚写好测试、故意先看到 RED** 的 TDD 步骤。注入的记忆是 `#64 flush-wait poll ticks`、`#246 child vitest summary`、`#45 test metrics` 等，与当下的 RED 无关。

**本分析会话在 exit 0 的只读分析上又触发了 3 次**（另有 1 次是真实失败：尺子自检抛错，退出码被 `| tail` 吞掉）：
- 两次是 `node -e` 从 transcript 里打印出 `AssertionError`、`is_error=true` 等文本；
- 一次是 `gh run view --log-failed | grep`，输出里是 CI 日志中的 `AssertionError`；
- 注入的 `#239/#112/#109`、`#109/#66/#228`、`#234/#225/#219` 都与当时的操作无关。
- 这正是 R1 的 B1 只修了一半的地方：B1 修的是"命令动词"，而"输出里含有别处的错误文本"这一类没有修。它的形状与 `hook.mjs:715` 注释记录的那条自递归问题（hint 字符串本身含 error）相同。

**读数**（citation 全项目 replay，HEAD 的提取器）：
- error_recall 全期（09-12 之后）为 **12.5% [9.8, 15.7]%**（61/489）；
- 后段臂为 **2.9% [1.0, 8.1]%**（3/105）；
- 置信区间不重叠，但后段臂只有 13 个会话，而且大部分时间跑的是修复前的 6.12.2。所以**下降的原因待验证**，不能直接当作修复的效果。

**建议**：
1. **抑制 TDD RED**：失败输出里点名的测试文件，如果本 episode 的最近 N 次工具调用里刚编辑过，就不注入。这正是 N1 要补的文件提取能力，两者可以共用。
2. **抑制"打印数据"**：`node -e`、`python3 -c` 等内联脚本以及 `gh … --log` 这一类，只有当输出里的错误指纹带着本仓库的路径和行号时才认定为失败。
3. **验收**：先用 `benchmark/error-recall-live-replay.mjs` 得到触发集合的名集差，再用 citation replay 的 `--split` 读前后两臂的引用率。**先数有多少 case 能到达新的门**（见记忆 `feedback-count-the-cases-that-reach-the-threshold`）。

### 4.3 N3 —— `created_at_epoch` 平局：同一个缺陷类被逐站点、逐版本地修（已证实，P2）

- **经过**：
  - v6.13.2 修 handoff key_files 与三处 observation 读取（`d06dc32`，D#67）；
  - v6.13.3 修 handoff 的 `<session-summary>` 追加（`8876cc4`，发版标题为"the resume summary picks the newest row"）；
  - v6.13.4 修"六处 summary/observation 读取"（`43571e3`，D#75）；
  - 每个提交所属的版本用 `git tag --contains` 确认过。
- **现状**：
  - CLAUDE.md 自己写着"26 sites fixed; the rest unjudged, not cleared"。
  - 本轮做了单行文本扫描：生产代码里 `ORDER BY … created_at_epoch DESC` 后面没有紧跟 `, …id` 的非注释行约 **24 处**，分布是：
    - `hook-handoff.mjs` 8
    - `timeline-core`、`activity`、`hook-context` 各 2
    - `server`、`mem-cli`、`startup-dashboard`、`recent-core`、`maintain-core`、`events-injection`、`browse-core`、`hook`、`cli/doctor`、`scripts/user-prompt-search.js` 各 1
  - 这个扫描**有漏有误**：多行 SQL 里 id 写在下一行的会被误报；`WHERE` 已经保证唯一的查询（例如按 session id 取 `LIMIT 1`）本来就不会有平局。所以 24 是"需要裁定的数量"，不是缺陷数。
- **问题**：
  - 现有守卫是逐站点的：`tests/search-order-tiebreak.test.mjs` 钉住 2 处（它自己的注释："Seventeen sites gained `, id DESC` this round. TWO are pinned below"），另有 `pre-tool-recall-tiebreak.test.mjs` 等个别用例。按"读源码文本 + 遍历文件 + `id DESC`"去检索测试，**没有找到**覆盖全部 `prepare(` 的总体守卫；
  - 剩下的站点靠每一轮评审偶然撞见，于是每撞见一次就多一次"pre-ship → delta → release"的周期。
- **建议**：
  1. 做一次总体裁定：列出每个站点"平局是否可能 / 平局的后果 / 结论"，写进 findings.md；
  2. 写一个**针对 SQL 字符串的结构守卫**，扫描所有 `prepare(` 实参，并附白名单和白名单理由；
  3. 用记忆 `feedback-guard-counterexample-from-real-revert` 的方法做变异：从 `git show 8876cc4^` 取真实的反例。

  这比每个版本修 2–6 处便宜。

### 4.4 N4 —— 摘要链路：Stop 的基数变了，缺陷跟着连锁出现（已证实，P2，属设计层）

- **经过**：
  - v6.13.5 修了"一个会话一行 summary"（`c12cf88`）；
  - 同一版本内又经过 3 轮评审修补（`9ee49d3`、`d4b3d73`、`4106601`）；
  - v6.13.6 修"晚到的后台摘要覆盖较新的摘要"（`ee731ea`，外加 `f92a656`、`eee0304`）。
- **根源**：Stop 从"每会话一次"变成了"每轮一次"。记忆 #270 已经记录了这一点："writers built for one Stop per session"。
- **仍然 open 的**：D#95（llm-summary 读的 observations 被 episode 升级删除清空了：7 天内 157 个 hook 会话里只有 4 个还持有 observation）。
- **已 drop 的**：D#92（每轮调用一次模型、约 91% 的结果被覆盖）。drop 理由是"前提夸大，worker 几乎总是 no-obs 退出"。这个理由恰好说明，模型摘要这条路径的实际产出很低。
- **建议**：别再逐个修写者，把"摘要在什么时点、以什么基数产生"作为**一个**设计决定来处理。
  - 候选方案：SessionEnd 事件，或 debounce。两者都是 L3，因为 SessionStart 的 Last Session 字段是用户和模型都能看到的。
  - 决定之前，先按 D#95 的口径测"模型摘要实际覆盖了多少会话"，作为基线。

### 4.5 N5 —— events 的 `file_paths` 混入临时路径（已证实，P3）

- 本项目 1,045 条 events 中：
  - 107 条（10.2%）的 `file_paths` 含 scratchpad 路径（例如 `/tmp/claude-1000/…/scratchpad/review-third.md`）；
  - 43 条（4.1%）含 `node_modules`（例如 `.claude/worktrees/agent-…/node_modules`）；
  - 8 条含 `.claude/worktrees`。
- **机理**：`extractFilePaths` 对工具的**直接字段**（Edit/Write 的 `file_path`）"unconditionally" 保留，理由是用户对 `/tmp` 的显式编辑是真实工作（`bash-utils.mjs:897-899` 的注释）。但 agent 写 scratchpad 属于会话内的临时产物，下个会话里不会再出现同一路径，这类边既召回不到任何东西，又会污染展示。
- **建议**：直接字段也要排除三类路径：harness 的 scratchpad 路径（`/tmp/claude-<uid>/<project>/<session>/`）、`tool-results/`，以及 `node_modules/`。验收：DB 快照中新增 events 的这三类比例 → 0。

### 4.6 附带发现：claudemd 的 session-end 检查点误报（已证实；属于别的插件，本仓库不修）

- `tasks/session-end-8b475d66-paused.md` 声称 v6.13.6 会话"最后一次修改之后没有 VALIDATE"，并列出 `package-lock.json`、`CHANGELOG.md`、runbook 记忆。
- 实际经过：
  - 15:27:54 做了 release 提交；
  - 之后 CI 和 Release 都是 success（`gh run list` 已确认）；
  - 15:37:20 `git status` 干净、HEAD 等于 origin、HEAD 恰好打着 tag；
  - release 提交之后唯一的修改是一个记忆文件。
- 列出的三条（15:26:13、15:26:42、15:37:13）是按时间顺序的。误报的真正原因是：release 提交之后又编辑了一个记忆文件，这次编辑被当成了"未验证的修改"。
- **该文件可以删除**（由你决定）。要修的是 claudemd：把 `~/.claude/projects/*/memory/` 下的编辑排除在 mutation 之外，或者对它降级处理。

---

## 5. 过程问题与阻碍

### 5.1 发版失败与环境差异（已证实）

- **v6.13.0 失败**：
  - 失败用例是 `tests/green-stamp.test.mjs > green-stamp reporter under a real vitest run > a full run stamps; an --exclude run does not`；
  - 断言信息：`expected '\n\u001b[1m\u001b[30m\u001b[46m RUN …' to match /Test Files\s+1 passed \(1\)/`；
  - 也就是说，CI 下子进程 vitest 输出了彩色文本，而本地是非 TTY、无色的，所以本地全绿；
  - 修复是 `57c5b08`（05:27，"read the child vitest's output without colour"），05:30 以 v6.13.1 重新发版。
- **同一个新功能**另有一个与时序相关的测试，在 `2de4849` 中修掉（"interrupt the SIGINT case once the test body runs, not after 4 s"）。
- **教训**：新写的、解析子进程输出的测试，本地一臂必须带上 CI 的环境变量（至少 `FORCE_COLOR=1`，以及 `CI=true`）。否则 tag 推上去以后才发现红了，只能烧掉一个版本号。

### 5.2 上下文与常驻文件（已证实）

- 后段会话首个请求的上下文为 75–77k，与 R1 时相同。当前三大常驻文件：

  | 文件 | 字节 |
  |---|---|
  | `MEMORY.md` | 28,753 |
  | `~/.claude/CLAUDE.md` | 24,994 |
  | 项目 `CLAUDE.md` | 20,404 |

- `MEMORY.md` 的索引行里，有多条超过 1 KB，内容是"第 N 轴"式的长叙述（例如 retraction 那一行）。它们本应放在各自的文件里，索引只需要一句话作为钩子。

### 5.3 语言漂移（已证实）

- "用户下一条消息之前最后一段 >200 字符的助手文本"中英文的占比：
  - claude-opus-5 为 12/179（6.7%）
  - **claude-opus-5-5 为 13/51（25.5%）**
- 后段最终回复全是中文（12/12），但这是因为 claudemd 的 `reply-language-check.sh` Stop hook 在 `72b4504d` 里拦截了 **5 次**，每次让模型用中文重述一遍。漂移仍在发生，只是被兜底了，代价是 5 个额外的回合。
- 子代理最终报告 96/108 是英文。按全局规范，子代理的 prompt 本来就应该用英文，所以主线程在转述时必须切回中文。R1 已经给出机理：teammate 消息之后英文占 24.6%。

### 5.4 等待与重复验证（已证实）

后段 Bash 耗时：

| 类别 | 次数 | 中位数 | P90 | 合计 |
|---|---|---|---|---|
| `git commit`（含 pre-commit） | 50 | 52.2 s | 71.8 s | 0.67 h |
| 全量 vitest | 33 | 28.1 s | 65.7 s | 0.26 h |
| `gh` | 30 | 21.4 s | 262.9 s | 0.61 h |
| lint/format | 21 | 21.7 s | | |

- pre-commit 中仍在重复跑的是 **"tree differs" 这 8 次**：agent 先跑了全量，之后又改了文件（例如 findings.md、CHANGELOG，或者 `npm run format`），然后才提交。
- 对策是调整流程顺序，不需要改代码：**编辑 → `npm run format`（两次）→ 全量 → 提交**；如果全量之后还要改文档，就不必事先手动跑全量，让 pre-commit 跑那唯一的一次。
- 不建议把 `*.md` 排除在 tree key 之外：多个测试会读 CLAUDE.md、findings.md 的文本（例如 CLAUDE.md 的版本守卫和 baseline stamp 同步）。

### 5.5 其他摩擦

- **worktree 隔离的子代理被拒绝 15 次**：它们执行了 `cd` 到共享检出目录再跑 git，或者执行了无法静态验证的复合命令。报错原文："a worktree-isolated agent's git operations must target its own worktree"。这是 `isolation: "worktree"` 之后新出现的摩擦。子代理 brief 里应该写明：只用相对路径，不要 `cd` 到主检出目录。
- **API 中断**：前段 3 次，后段 1 次。后段那次，用户手动输入"前面api出错了，继续"来恢复。
- **code-graph 的 PreToolUse:Bash hook 输出了非法 JSON**，共 4 次（前段 3 次，后段 1 次，报错为 "Hook output looks like a JSON object but is not valid JSON"）。这是另一个插件的缺陷，应该移交给 code-graph-mcp 项目，而不是在本仓库修。
- **Edit 的 `old_string not found`**：前段 13 次，后段 0 次。后段几乎不用 Edit 工具，所以这个数字不能说明情况有改善。

---

## 6. 做得好的部分（避免矫枉过正）

- **R1 → 修复的闭环很快**：4 个 P1 在 19 小时内完成修复、评审、发版、部署，而且修复后的读数（§3）与验收设计一致。
- **CI 抓住了发版问题**：v6.13.0 的红灯在 Release 阶段拦下了有问题的产物。除 v6.13.0 外，后段其余 6 次发版 CI 与 Release 全部 success。
- **拦截摩擦下降**（主会话）：
  - §8 `rm -rf` 拦截从前段 72 次降到后段 2 次，按每活跃小时算是 0.85 → 0.18 次；
  - code-graph 拦截从 53 次降到 0 次，即 0.62 → 0 次/h。
- **hook 延迟不是瓶颈**：

  | hook（本项目） | n | P50 | P90 | 最大 |
  |---|---|---|---|---|
  | Stop `hook.mjs stop` | 326 | 155 ms | 215 ms | 763 ms（P99 399 ms） |
  | PreToolUse:Read `pre-tool-recall` | 493 | 61 ms | 77 ms | |
  | PreToolUse:Edit `pre-tool-recall` | 272 | 55 ms | 67 ms | |
  | UserPromptSubmit `user-prompt-search` | 119 | 82 ms | | |
  | UserPromptSubmit `hook.mjs user-prompt` | 74 | 129 ms | | |
  | SessionStart:startup `hook.mjs` | 19 | 211 ms | | |

  - 每轮所有 Stop hook（含其他插件）各自 P50 相加约 0.44 s。
  - 注意（推断）：`hook_success` 看起来只记录**有输出**的 hook 调用。依据是 PostToolUse:Bash 的 838 条记录里只有 4 条输出为空，而 Bash 调用总数超过 1 万。所以 PostToolUse:Bash 的 114 ms 是"通过了预过滤、真正进了 node"的那部分，不是全部 Bash 的平均值。

- **/tmp 泄漏已止住**：ssr 目录从 60 个降到 0 个。

---

## 7. 优化建议（按收益 / 成本排序）

| 编号 | 优先级 | 建议 | 依据 | 验收 / 测量 | 级别 |
|---|---|---|---|---|---|
| R1 | **P1** | `extractFilePaths` 支持 cwd 前缀、相对路径、带引号的路径、写动词目标、python heredoc 字面量 | N1：6 种写法中 5 种提取不到；无真实文件边的 events 从 20.6% 升到 53.5% | 用本机 transcript 做前后两臂重放，比较 Bash 改/读文件的真实文件提取率；每种写法做变异 | L2 |
| R2 | **P1** | PreToolUse 增加 Bash 匹配（bash 预过滤 + 复用 pre-tool-recall），并同步 `install.mjs` 的 settings 双胞胎 | N1：pretool 对数从 168 降到 5（按 error_recall 归一化后约降到 1/9）；这个 face 的引用率最高（41.7%） | citation replay `--split` 读 pretool 的对数和引用率；正确用法普查：只读的 grep 不注入；延迟 P50 ≤ 现有 pre-tool-recall 的 1.5 倍 | **L3**（注入行为 + hooks.json） |
| R3 | P2 | 对 `created_at_epoch` 平局做一次总体裁定，并加一个 SQL 字符串结构守卫 | N3：连续 3 个版本在修同一类；约 24 处未裁定 | 裁定表写入 findings.md；守卫的反例取自 `git show 8876cc4^` | L2 |
| R4 | P2 | 发版前本地加一臂 `CI=true FORCE_COLOR=1 npm test`；同一天的修复合并成一次发版 | N4 / §5.1：v6.13.0 烧掉一个版本号；09-26 一天 7 个版本、19/45 个提交由评审驱动 | 每周发版数；红色 Release 数 → 0 | 流程（发版节奏需要你拍板） |
| R5 | P2 | error-recall 抑制 TDD RED（失败的测试文件本 episode 内刚编辑过）和内联脚本打印的数据 | N2：修复后 4/5 是刻意 RED；本会话 3 次误报；引用率 12.5% | 先数到达率，再看 `error-recall-live-replay` 的名集差和 citation `--split` | L2 |
| R6 | P2 | 摘要链路按一个设计决定处理（SessionEnd 或 debounce），先测 D#95 口径的基线 | N4：v6.13.5/6 两个版本共 7 个修补提交 | 模型摘要覆盖的会话数 / hook 会话数 | **L3** |
| R7 | P2 | `MEMORY.md` 索引行压到一句话（目标 ≤10 KB）；`[mem] episode flushed` 不再注入模型 | R1 已提出、至今未做；首请求上下文仍是 75–77k | 首个请求的上下文 token 数，前后对比 | L1 / **L3**（flush 行） |
| R8 | P3 | events 的直接字段也排除 scratchpad、`tool-results/`、`node_modules/` | N5：10.2% + 4.1% | 新增 events 中这三类的比例 → 0 | L1 |
| R9 | P3 | Not done 直接写入 `mem_defer`；下一轮开场由 SessionStart 列出队首 1–3 项，用户只需回复"继续 #N" | §2.3：用户手动粘贴 Not done 10 次，"继续"50 次 | 粘贴 Not done 的次数 | 流程 |
| R10 | P3 | 子代理 brief 补两条：只用相对路径、不 `cd` 到主检出目录；报告末尾附一段"给主线程的中文要点" | §5.3、§5.5：worktree 拒绝 15 次；英文报告 96/108 | 拒绝次数；主线程英文回复率 | 流程 |
| R11 | P3 | 恢复 v6.13.5/6 的评审报告落盘（`docs/audits/`）；在 release 检查清单中加一条"评审报告已落盘" | §2.2：审计轨迹中断 | `ls docs/audits \| grep <version>` 非空 | 流程 |
| R12 | P3 | 把 code-graph hook 输出非法 JSON（4 次）、claudemd 检查点误报两件事，分别移交给对应项目 | §5.5、§4.6 | 对方项目的 defer 条目 | 移交（**不在本仓库改**，见记忆 `feedback-shared-worktree-branch-switch`） |

---

## 8. 局限与待验证

- **N1 的成因**：模型换代（Opus 5 → 5.5）与 harness 在 bypass 模式下的"用 Bash 干活"提示同时发生，本轮没有分离两者。结论"产品需要覆盖 Bash"不依赖于成因。
- **Bash 读写的启发式正则**有漏有误。它只用来比较量级（60.8% 对 18.0%），不是精确计数。
- **后段样本小**：修复部署后只有 2 个会话。error-recall 后段臂的 2.9% 大部分落在修复前的 6.12.2 上，所以"下降"待验证。
- **citation replay 是全项目口径**，不只 claude-mem-lite。pretool 从 168 对降到 5 对的现象跨了 7 个项目，这反而支持 N1 与项目无关。
- **24 处平局站点**来自单行文本扫描，是"待裁定数"，不是缺陷数。
- **成本**是 `cost-state` 按标价计算的估值，不是账单。
- **语言漂移**只比较了两个模型的比例，没有控制上下文长度、是否紧跟 teammate 消息等混杂因素。

---

## 附录 A —— 复现方法

本轮的解析脚本放在会话 scratchpad（不入库），逻辑如下，可以照此重写。

§4.1 中"Bash 改文件 / 读文件"用的正则按原样列在这里，方便复现：

```
MUT = /(\bsed -i|\bperl -[a-z]*i|python3? - <<|python3? -c|\bcat (>>?|<<[^\n]*>>?) ?[^ |]*\.(m?js|md|json|sh)|\btee (-a )?[^ |]*\.(m?js|md|json)|> ?[A-Za-z0-9_./-]+\.(m?js|md|json|sh)\b|writeFileSync|git apply|apply_patch)/
    （命中的片段含 /tmp/ 或 scratchpad 时不计）
RD  = /^(\s*cd [^;&]+(&&|;)\s*)?(cat|sed -n|head|tail|nl|less|awk)\s/
    （按每条 assistant 消息里 message.model 的值，把调用归到对应模型）
```

步骤：

1. 遍历 `~/.claude/projects/-home-ai-dev-claude-mem-lite/*.jsonl`，排除当前会话。
2. 对 `assistant` 记录按 `message.id` 去重后累计 `usage`；上下文 = `input + cache_read + cache_creation`。
3. `tool_use` 与 `tool_result` 按 id 配对，用两者时间戳之差作为耗时，并按命令正则分类（`git commit`、全量/部分 vitest、`gh`、`sleep`、lint/format）。
4. `attachment.hook_additional_context` 按行首前缀归到 face；`hook_success.durationMs` 按 `hookName + command` 分组；`stop_hook_summary.hookInfos[].durationMs` 按 command 分组。
5. 对 `git commit` 的输出匹配 `[pre-commit] (Tests: reusing green run|Running tests (<reason>))`，得到复用判定。
6. DB 快照：`sqlite3 -readonly ~/.claude-mem-lite/claude-mem-lite.db ".backup <scratch>/snap.db"`，然后按日期统计 `events.file_paths` 的类别。
7. 尺子：

   ```
   node benchmark/citation-live-replay.mjs --since 2026-09-12T00:00:00Z --split 2026-09-25T20:09:12Z
   ```

   **注意**：加 `--project dev--claude-mem-lite` 会因为"no injections in scope"而自检失败，这把尺子的项目参数口径与 DB 里的项目名不同。本轮最终使用的是全项目口径。
