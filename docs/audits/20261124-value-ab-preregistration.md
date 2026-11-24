# 预先登记：当前宿主上，claude-mem-lite 的跨会话接续价值还在不在

- **日期**：2026-11-24（UTC），写于运行任何本轮会话之前（冒烟除外，冒烟只看机制，不看 S2 结果）
- **被测插件**：`main` @ `c8aa7a18`（v6.37.0），`git archive` 副本 + 仓库的 `node_modules`，经 `--plugin-dir` 加载
- **宿主**：Claude Code 2.1.331（09-29 那轮是 2.1.284）

## 1. 要回答的问题

用户的问题："模型越来越强，这个插件现在还有没有用。"

09-29 的沙箱实测（`20260929-sandbox-usage-eval.md`）只在一个场景测出因果收益：需求只在对话里说过、要跨会话接着做（S1 → S2）。其余任务两组没有差别。

但把 Opus 对照组各轮的 S2 结果按配置排开，收益只出现在对照组被配置削弱的轮次：

| 轮次 | 配置 | 对照组 S2 完整接续 |
|---|---|---|
| 第一轮、复测、§8.3 | 加载了维护者的全局规范，带 `--setting-sources project` | 1/4、2/2、1/2 |
| §8.4 | 无祖先 CLAUDE.md，仍带 `--setting-sources project` | 1/4 |
| §8.5 | 真实默认用户：每条轨迹独立 `CLAUDE_CONFIG_DIR`，不带该参数 | **4/4** |

Sonnet 5.5 在真实默认用户配置下（§8.7）是对照 0/4、插件 12/12。

所以本轮问：**在当前宿主、真实默认用户配置下，S2 跨会话接续在 Opus 5.5 和 Sonnet 5.5 上是否仍有插件带来的差别。**

## 2. 设计

| 项 | 内容 |
|---|---|
| 组 | C：不装插件，只有 Claude Code 自带 auto-memory（默认开启）。P：插件默认行为（含 auto-adopt 写 `CLAUDE.local.md`） |
| 模型 | `--model claude-opus-5-5`：每组 8 条轨迹。`--model claude-sonnet-5-5`：每组 4 条轨迹 |
| 会话 | 每条轨迹 S1、S2 两个会话，各是一个新的 `claude -p` 进程；提示词与 09-29 附录 A 原文一致 |
| 会话之间 | 等待 10 s；P 组另外等后台 LLM 调用结束（最多 240 s）。然后懒提交 `git add -A && git commit -m "session N"`，在干净 clone 上跑隐藏验收 |
| 启动参数 | `claude -p "<提示>" --model <m> --permission-mode acceptEdits --output-format json`，P 组加 `--plugin-dir` |
| 隔离 | 项目在 `/run/user/1000/agent-tmp-valueab-20261124/<id>/`（tmpfs，没有祖先 CLAUDE.md）；每条轨迹独立的 `CLAUDE_CONFIG_DIR`（只链入凭据，`settings.json` 只放行 mem-lite 的 MCP 工具，两组相同）、`HOME`、`TMPDIR`；`env -i` 只传 PATH、代理变量、语言和上述目录；不传 `OPENROUTER_API_KEY`，所以 P 组后台 LLM 走默认用户的 `claude -p` 路径 |
| P 组专有 | 每条轨迹独立 `CLAUDE_MEM_DIR`；`CLAUDE_MEM_SKIP_UPDATE=1`；`CLAUDE_CODE_PATH` 指向一个只记录、不改输出的包装器，用来记后台调用的次数和名义费用 |
| 种子与验收 | 按 09-29 附录 B 重建的 `invoicer`（7 条测试，2 个提交）。验收 E1（行折扣）、E2（SAVE10→101.70、FLAT5→107.35、`Logo:1:1200.00:10`→1220.40、无效码非零退出）、`npm test`、无依赖。尺子已在种子上全红、在参考实现上 E2 4/4、在 SAVE10 变异体上 3/4 |
| 启动顺序 | 两组交错，间隔 3 s，最多 12 条并行 |

## 3. 主指标与判定规则（只对 Opus）

**主指标**：S2 之后 E2 四项全过（"完整接续"），每组 x/8。

- **"Opus 上价值仍在"**：P 高于 C，且 Fisher 双侧 p ≤ 0.05（例如 8/8 对 ≤3/8，7/8 对 ≤2/8）。
- **"Opus 上测不出价值"**：C ≥ 7/8，即宿主自己就能接上。
- 其余：**不确定**，报告方向和 p，不下结论。

Sonnet 每组 4 条，只描述，看 09-29 的 0/4 对 12/12 是否复现。

## 4. 次要指标（只描述）

- 每会话名义费用（`total_cost_usd`，Max 订阅不实际扣费）、耗时、轮数；P 组后台 LLM 调用次数与名义费用；
- S1 当期目标 E1、S2 之后的 `npm test` 与无依赖；
- **接续靠的是什么**，按 S2 开始前的快照逐条编码：宿主 auto-memory 里有没有优惠码计划；仓库里有没有写下剩余步骤（TODO、README、测试、注释）；P 组 SessionStart 注入里有没有原话；模型有没有读历史 transcript；有没有调用插件工具。

## 5. 作废与补跑

- 会话 `is_error: true`、`modelUsage` 里不是指定模型、或 P 组 transcript 里没有插件的 SessionStart 注入：该轨迹作废，用新编号补跑一次；全部如实报告。
- 冒烟轨迹（编号 `smoke-*`）只用来确认机制，不计入。

## 6. 局限（事先写明）

- 场景只有一个，任务小，会话短；真实会话（R4：平均 3.5 h、上百次请求、`/clear` 后接着做）的成本占比和这里不同，费用结论不外推。
- 本轮只测"接续"这一个此前测出过收益的场景，不重测 09-29 已经测过无差别的其余 6 类任务。
- n=8 对二元结果的检验力有限：只有差距 ≥5 个才能到 p ≤ 0.05。

## 7. 冒烟之后、主批次之前的修订（2026-11-24 23:27Z，`ff33594e`；主批次 23:29Z 开始）

冒烟两条轨迹（smoke-c、smoke-p，Opus，S1+S2，不计入）暴露了一个环境问题：

- **Claude Code 2.1.331 在 `-p` + `acceptEdits` 下拒绝 `npm test`、`node --test` 和 `node <插件>/cli.mjs …`**（"This command requires approval"），两组都一样。09-29 的 2.1.284 不拒。结果两组的 S1 都没能跑测试，插件组模型想用 CLI 记待办也被拒。
- 真实用户在交互里会批准这些命令，所以**主批次两组的 `settings.json` 都改为放行 `Bash` 和 mem-lite 的 MCP 工具**。判定规则、样本量、提示词都不变。

冒烟里已经看到的（如实记录，不改规则）：

| | smoke-c | smoke-p |
|---|---|---|
| S2 完整接续 | 4/4 | 4/4 |
| 接续靠什么 | 宿主 auto-memory 在 S1 自己写了 `discount-feature-plan.md`（三步计划、第 2/3 步待做） | 宿主 auto-memory 为空；SessionStart 注入的 Last Session（Request 原话 + Remaining） |
| 插件引导送达方式 | — | 注入。种子的 `package.json` 有 `bin`、没有 `private`，插件把它判为可发布的 npm 包根，不写 `CLAUDE.local.md`（已发布行为） |
| 后台 LLM | — | 3 次，Haiku 5.5，合计名义 $0.004 |

## 8. 结果（主批次之后补记）

按 §3 原规则：Opus 完整接续 插件 8/8、对照 1/8，Fisher 双侧 p=0.0014 → **"Opus 上价值仍在"**。Sonnet 4/4 对 0/4（p=0.029），复现 09-29。48 个会话全部有效，没有补跑。分析与判断见 `20261124-plugin-value-assessment.md`。
