# 预先登记：隔了很久再"继续"，插件的接续还在不在

- **日期**：2026-11-25（UTC），写于本轮任何会话之前（冒烟也在本文提交之后）
- **被测**：`main` @ `deabaf33`（发布代码与 v6.37.0 相同），Claude Code 2.1.331
- **尺子**：`benchmark/value-ab/`（`docs/measurement/rulers.md` 的 "value A/B"），本轮用新加的 `--gap-days 8`

## 1. 为什么测

11-24 的 A/B（`20261124-plugin-value-assessment.md`）里，S2 在 S1 之后约 19 秒开始。插件组 S2 拿到完整需求，靠的是 UserPromptSubmit 的会话交接（`<session-handoff>` 的 Working On 是上一轮原话全文）。11-24 的 12 条插件轨迹，S2 全部收到了这段交接。

但这段交接有时间窗口：退出后 7 天、`/clear` 后 6 小时（`lib/handoff-constants.mjs`）。过了窗口，模型只剩两样东西：

- SessionStart 里 4 行截到 120 字符的摘要（`hook-context.mjs:992-995`）；
- 模型自己记下的待办，标题同样截到 120 字符。

11-24 有一条 Sonnet 插件轨迹，SessionStart 里收到的是"…2. 支持整单优惠码 coupon：SAVE10…"，后面被截掉了。

所以要问：**S1 发生在 8 天前时，插件组还能不能接上？**

## 2. 设计

| 组 | 模型 | 轨迹数 | 处理 |
|---|---|---|---|
| P-gap | Opus 5.5 | 8 | 插件；S1 之后，私有库和 runtime 文件挪回 8 天，宿主 transcript 的修改时间也挪回 8 天 |
| C-gap | Opus 5.5 | 4 | 不装插件；宿主 transcript 的修改时间挪回 8 天（宿主自带记忆没有过期机制，这组用来看同一轮里的模型漂移） |
| P-gap-sonnet | Sonnet 5.5 | 4 | 同 P-gap。Sonnet 不主动记待办，这一组只看被动通道 |

- 其余与 11-24 相同：真实默认用户隔离、两组都放行 Bash、提示词原文、隐藏验收。
- 启动命令：`launch.sh <dir> --opus 8 --control-opus 4 --sonnet 4 --control-sonnet 0 --gap-days 8`。
- 冒烟：1 条 Opus 插件轨迹（`--opus 1 --control-opus 0 --sonnet 0 --control-sonnet 0 --gap-days 8`），单独一个工作目录，只核对机制，不计入结果。

## 3. 前提检查（任何一条不满足，本轮作废并报告）

- P-gap 与 P-gap-sonnet 的每个 S2 都**没有**收到 `<session-handoff>`（`analyze.mjs` 的 `s2Handoff` = 0）。否则说明没有模拟出过期。
- P 组每个 S2 都有 SessionStart 注入。
- 没有会话 `is_error`，`modelUsage` 与指定模型一致，没有 `requires approval`。

## 4. 主指标与判定（只对 P-gap，Opus）

**主指标**：S2 之后 E2 四项全过，记为 x/8。

| 读数 | 判定 |
|---|---|
| ≥ 7/8 | 长间隔下接续仍成立，不需要改动 |
| ≤ 4/8 | 长间隔下核心价值大部分丢失。我会写一份 L3 提案：放宽 SessionStart 交接行的截断，或延长退出交接的窗口，先用 `injection-budget` 定价，再请用户授权 |
| 5/8 或 6/8 | 不确定，报告方向，不下结论 |

## 5. 次要读数（只描述）

- C-gap 的完整接续数（与 11-24 对照组 1/8 是不同轮次，不做差）；
- P-gap-sonnet 的完整接续数；
- P 组 S2 靠的是哪条通道：SessionStart 的 Last Session、待办列表、模型自己调用 `defer list` / `get`，按 transcript 逐条编码；
- 名义费用。

## 6. 局限（事先写明）

- 只模拟了"插件这边的时间"。宿主那边，自带记忆本来就不会过期，transcript 只改了修改时间，所以宿主行为与真实的 8 天后不完全相同。
- 提示词带"继续/上次"。所以本轮测的是"关键词命中、但交接已过期"这一种情况，不测"不说继续"的情况。
- 样本量：Opus 8 条，Sonnet 4 条。
