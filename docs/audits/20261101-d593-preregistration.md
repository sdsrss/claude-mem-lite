# D#593 测量的事先登记（2026-11-01，写在任何一把尺子跑之前）

> 本文件在测量之前提交，供评审核对"判定规则是先写的"。上一次（D#591）的登记只放在 `tasks/` 下，仓库里没有，
> 读者无法核对（v6.30.9 r1b claims P3-10）。

对象：分支 `feat/d593-page-check`，代码提交 f806b6b4..7d2333f1（基点 93a33a34；从 v6.30.8 = 051dd70f 到基点，
`schema.mjs`、`install.mjs`、`mem-cli.mjs`、`cli/fts-check.mjs`、`server/fts-check.mjs`、`lib/snapshot-probe.mjs`、
`lib/db-unusable.mjs` 没有差异）。
- OLD = v6.30.8（`git archive 051dd70f`）。
- NEW = 测量时分支 HEAD 的代码（`git archive`）；测量期间代码改了 → 全部重跑。
- 人群：D#546 回归集四个总体 `869`、`main:21:800`、`two:22:300`、`log:23:800`，共 2,769 个种植样本
  （`tasks/d546/ruler/plants.mjs`，生成器来自 docs/audits/20261021-v6.31.0-d541-sweep.md 与 -r2-defects.md 附录 A）。

## 资源约束

每把尺子都经 `tasks/d593/capped.sh` 跑（用户级 systemd scope：`MemoryMax`、`MemorySwapMax=0`、`timeout -s KILL`），
探针在没有 cgroup 上限时拒绝启动，循环每轮让出事件循环；一次只跑一个总体。起因：2026-11-01 原型的并发探针单进程
20.6 GiB 物理内存 + 4.1 GiB swap（better-sqlite3 的原生终结器要等事件循环转一轮才释放，同步循环一块都不释放）。

## R1 精确性（`tasks/d593/exact.mjs`，产品代码）

每个样本两个状态（种下状态：日志未检查点、`-shm` 已删；s0：产品打开器跑过一次），只读句柄上：
产品读取器读出的每一页 vs 同一读事务里 `serialize()` 的那一页；产品 `checkStorePages` 的判定 vs 第一次尝试
（22486ace，serialize 版，判定经两个评审视角复测过）；检查前后主文件 + 日志 sha1。
- 通过 = 能 serialize 的样本 0 页不同；判定（state + lines）全部相同；sha1 全部不变。

## R2 并发（`tasks/d593/race.mjs`，产品代码，只跑一次，用户 2026-11-01 同意）

60 秒，`capped.sh 2G 120`。通过 = 0 页不同、0 次 damaged、检查期间有提交（重叠 > 0）、至少 1 次日志重启。

## R3 新旧对比（回归集）

1. 种下状态（损坏可能只在日志里）：NEW 的 `doctor --json` 和 `fts-check rebuild` 各在自己的副本上跑完整命令（沙箱 HOME），
   记主文件 + 日志 sha1、只从主文件能读出的真值行、合起来能读出的真值行。
2. s0 状态四臂（各在 s0 的副本上）：OLD / NEW × doctor 的 FTS 步骤 / `rebuildIndexes`。NEW 的 doctor 步骤 = 只读句柄
   `checkStorePages`，damaged 就停；否则读写句柄 `checkFTSIntegrity`，不健康且不忙就 `rebuildFTS`。OLD = v6.30.8 的同一步。
3. 读噪声（D#593 条件 9）：每次"能读出哪些真值行"（`plants.mjs` 的 `readable()`）都在新的子进程里跑，同一份字节读两次；
   报出两次不一致的臂数。一个臂的丢 / 改只在两次读一致时计入。

判定：
- ① NEW 拒绝（页检查 damaged 或 unchecked）的样本：主文件和日志 sha1 不变（种下状态两个面，s0 两臂）。
- ② OLD 那一步让真值行变少或变值（两次读一致）的样本：NEW 全部拒绝。
- ③ NEW 放行且重建了的样本：真值行和 s0 相比 0 丢 0 改。
- ④ NEW 的判定和 R1 里第一次尝试的判定逐行相同。
- 报出：拒绝数、其中 FTS 本来就坏的数（这一版不修这些库的搜索）、`unchecked` 数。
①②③④ 任一不成立 → 不发这个改动，回到设计。

## R4 代价（`tasks/d593/cost.mjs`）

合成库 200,000 条观察（约 577 MB），每项在新子进程里量三次，热缓存和冷缓存（`posix_fadvise DONTNEED`）都量：
NEW 页检查（只读句柄）、现有 FTS5 自检（读写句柄）。报出时间和峰值 RSS 增量。没有通过线（doctor 每次都跑页检查已由用户拍板）；
数字进 CHANGELOG。

## R5 ≥ 2 GiB

合成库 ≥ 2.1 GiB：NEW 页检查 `ok` 及峰值 RSS；只坏 FTS 时 NEW doctor 重建成功、`fts-check rebuild` 退出 0；
≥ 2 GiB 的 VACUUM INTO 快照 `checkSnapshot` 判 `ok`。通过 = 四项都成立（第一次尝试在这里全部失败：r1b defects P1-2）。

## 评审规则（写在评审之前）

- 发版前 r1：两个盲审（缺陷、说法），范围 = 93a33a34..候选发版提交。
- 新代码里出 P0/P1 → 撤回本条；P2 → 先红后修，一次 delta r2（新子代理）；r2 在同一改动代码里再出 P0–P2 → 撤回。不做 r3。
  例外：评审给出的新旧对比里旧版本在同一情形更差 → 问用户一次。
- 文字 P2 → 删句或收窄；P3 → 列出、一行的顺手改。范围外的旧问题 → 延期项。
