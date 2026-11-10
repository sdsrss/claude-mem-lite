# D#593 第 3 次尝试：规格、事先登记、读数与撤回（2026-11-10）

> 归档：`tasks/specs/d593-attempt3.md`（gitignore 内）在撤回时的全文，原样保留，供核对"判定规则写在读数之前"。代码在标签 `archive/d593-checked-rebuild`（a7dd0def），未合入 main。两份 r1 报告见同日期的 `-r1-defects.md`、`-r1-claims.md`。


用户 2026-11-10："剩余的工作按你的建议和选择执行，授权。" 授权范围：D#632 的 L3 实现（上一轮唯一待批项）。
不打 tag、不发版；合入 main 之前过事先登记的验收和盲审。基点 main @ e215aba4（CI 42827772669 success）。
脚本：`tasks/d593c/`（gitignore）。前两次的规格：`tasks/d593/contract.md`；条件全文：`get D#593`、`get D#632`。

## 问题

doctor 的 FTS 步骤、`fts-check rebuild`（CLI、MCP）、打开器的 SQLITE_CORRUPT_VTAB 分支、快照检查、MCP 空闲 optimize（D#761）
都会重建索引。重建从 freelist 分配页；freelist 列着一个在用页时，新索引的页会覆盖那一页上的行（D#591：300 行 → 287 完好 + 263 垃圾；
D#595：optimize 一次 12/300）。目标：这些写在页级损坏的库上不留下任何已提交的改动。

## 前两次为什么撤回（要点，全文见延期项）

- 第 1 次（2d4739b6）：`serialize()` 有 2 GiB 上限；用读写句柄查页，关闭时检查点把日志里的损坏写进主文件；复制命令只复制符号链接。
- 第 2 次（archive/d593-page-check，约 2,100 行）：自己从主文件和日志帧读 freelist。P0：在持有连接的进程里打开再关闭库文件，
  fcntl 锁按"进程 × inode"计，`closeSync` 丢掉了本进程的 SHARED 和 DMS 锁（服务器之后的提交丢失；检查中途 -shm 读锁丢失）。
  另有：doctor 先跑 `claude mcp list`（启动服务器、读写打开）；符号链接库文件的 -wal/-shm 没复制；打开器 VTAB 分支的裸读写句柄；
  归因（两次读一致不够）；若干 P3。

## 设计分叉（本次的核心决定，由下面的探针决定）

- **A：把第 2 次的读页器挪进子进程。** 子进程自己的只读连接，ROLLBACK 之后才关 fd（评审的副本 36,226 次跨进程检查 0 损坏）。
  保留第 2 次的全部复杂度（日志帧解析、nBackfill、读事务钉住、2 GiB、锁字节页、64 KiB 页、保留字节、指针映射页），再加一层进程。
- **B：事务里重建，提交前检查。** 读写连接上 `BEGIN IMMEDIATE` → 重建 → 同一事务里 `PRAGMA quick_check` → 结果是 `ok` 才
  `COMMIT`，否则 `ROLLBACK`。重建复用了交叉链接页时，那一页同时挂在两棵树上，事务内的检查读到的是未提交的页面。
  回滚丢弃全部改动（WAL 模式下溢出的页只是未提交帧）。读写连接关闭前先开一个只读连接并保持到读写连接关闭之后：不是最后一个
  连接就不检查点；只读连接关闭不检查点。整个过程只经过 SQLite，不自己读文件 → 第 2 次的 P0 不存在。
  - 未知（要测）：u1 VACUUM 过的库（检查是部分的，跳过 freelist）上，复用的交叉链接页能否被发现；u2 回滚后真值行不变、
    只读连接在场时关闭不检查点（inLog 形态主文件不变）；u3 检查期间持有写锁的时长（代价）；u4 检查本身报出与重建无关的旧损坏
    → 拒绝（与 A 拒绝所有页损坏库的行为相同，计数报出）。

## 事先登记 —— 探针 P（写于运行之前）

夹具：第 2 次分支的 `writeCrossLinkedStore`（`git show archive/d593-page-check:tests/test-helpers.mjs`），300 条观察，
FTS 先损坏（让 doctor 走到重建）。8 个形态：vacuum {否, 是} × inLog {否, 是} × links {1, 3}。每个形态各自的副本上两臂：
- OLD：当前 main 的 `rebuildIndexes`（`rebuildFTS` 四张表 + `REINDEX`），读写连接，直接写。
- B：同样的语句包在 `BEGIN IMMEDIATE … quick_check … COMMIT/ROLLBACK` 里，只读连接在读写连接关闭后才关。
读数：`intactObservations`（带日志、只主文件两种）对真值 300 行；B 是否回滚；主文件 sha1 前后。
判定：
- 前提：OLD 至少在 1 个形态上让完好行变少（否则夹具是瞎的，探针作废）。
- P 通过 = B 在全部 8 个形态上带日志完好行 = 300，且 OLD 丢行的每个形态上 B 都回滚了；inLog 形态上 B 回滚后主文件 sha1 不变。
- P 不通过 → B 否决，记录原因；转 A，A 另起规格（本轮停在报告，不实现 A）。

## 事先登记 —— 回归集 R（P 通过后才跑，写于 P 运行之前）

D#546 回归集四个总体（`869`、`main:21:800`、`two:22:300`、`log:23:800`，2,769 个样本），沿用第 2 次 r3 的做法：s0 状态
（当前打开器跑过一次）上四臂 OLD / B × doctor 的 FTS 步骤 / rebuildIndexes；每次"读出哪些真值行"在新子进程里读两遍，两次一致才计入。
另加 VACUUM 形态：每个总体前 100 个样本在 VACUUM 过的模板上重种一遍（VACUUM 之后 quick_check 是部分检查）。
判定（任一不成立 → B 否决）：
- R1 B 两臂在每个样本上真值行 0 丢 0 改（两次读一致）。
- R2 OLD 让真值行变少或变值的每个样本，B 都回滚了。
- R3 报出：B 回滚数、其中 OLD 本来不丢的数（多拒）、检查抛错（unchecked）数。

## 实现范围（R 通过后）

一个包装 `verifiedRebuild(db, fn)`（事务 + 检查 + 回滚 + 结果），五个写入点 + 空闲 optimize 都经过它；再按第 2 次条件处理：
doctor 先查后跑 `claude mcp list`（或损坏时跳过）、复制命令复制解析后的文件及其 -wal/-shm、打开器 VTAB 分支不再裸开读写句柄、
拒绝时的措辞、代价数字进 CHANGELOG。验收和评审规则在实现前补写到本文件。

## 撤回规则（写于实现前）

- 盲审两视角（缺陷、说法），各一个新子代理，`git archive` 出的树。真实形态 P0/P1 → 撤回该提交；真实形态 P2 修一次，r2 只审修复增量，
  r2 在同一改动上再出真实形态 P1/P2 → 撤回。只在构造形态出现的 P2/P3 → 延期，不挡合入。轮数上限 2。

## 进度

- [x] 探针 P（通过）
- [ ] 回归集 R（运行中：`tasks/d593c/out/*.jsonl`，汇总 `node tasks/d593c/sum.mjs tasks/d593c/out/*.jsonl`；R 跑完前不许改 schema.mjs 及其 import 链——R 的子进程每个样本都重新 import 它）
- [ ] 实现：S1 完成 b9706a55（分支 feat/d593-checked-rebuild）；S2 schema.mjs 等 R；S3 七个调用方
- [ ] 评审 r1 / r2
- [ ] 合入 main

## 决定记录

（按序）
- 2026-11-10 探针 P（`tasks/d593c/probeP.mjs`，夹具抽自 archive/d593-page-check 的 test-helpers）：**通过**。前提：OLD 在 8/8 形态丢行
  （links 1 → 288/300，links 3 → 276/300，带日志与只主文件相同）。B：8/8 回滚，带日志 300/300、只主文件 300/300，主文件 sha1 8/8 不变
  （含 4 个 inLog 形态）。u1：VACUUM 形态写前 quick_check 只报 FTS 损坏（看不到交叉链接），事务内重建后报 "2nd reference to page 65"
  → 回滚。links 3 时 `REINDEX` 自己抛 SQLITE_CORRUPT（B 记为重建错误 → 回滚）。
- 2026-11-10 R 的修订（写于 R 运行之前）：VACUUM 形态只做 `main:21`、`two:22` 两个总体各前 100 个——`log` 的损坏种在日志帧里、`869`
  依赖固定页表，VACUUM 后的模板上无法按原参数重种。种法：与 `richPlants` 同一随机序列、同一偏移表，模板换成 VACUUM 过的副本
  （页表取自 VACUUM 后的模板）。另外：R 只跑 s0 状态（第 2 次 r3 的"种下状态"两个面是完整的 doctor / fts-check 命令，B 还没有接进命令）。
- 2026-11-10 烟测发现（main21-0）：B 里第一张 FTS 表的 rebuild 抛 SQLITE_CORRUPT 后事务仍开着（inTransaction=true），之后三张表也都报
  CORRUPT（事务进入错误状态），什么都没提交——失败即关闭。**设计要求**：SQLite 文档列出 SQLITE_FULL / IOERR / BUSY / NOMEM 可能自动回滚
  整个事务，之后的语句就在自动提交模式下直接写；实现必须每条语句后查 `inTransaction`、在第一个错误处停下并回滚。尺子在重建后记录
  `txnLost`（事务被 SQLite 自己回滚）。

## 实现方案与验收（写于 R 结果出来之前；R 不通过则整段作废）

分支 `feat/d593-checked-rebuild`（基点 e215aba4）。

- S1 `lib/checked-write.mjs`（叶子模块，不 import 任何东西；登记进 `source-files.mjs` 和 `package.json#files`）：
  `checkedWrite(db, steps)`：已在事务里 → 不写，`unchecked`；`BEGIN IMMEDIATE`（忙 → 不写，`unchecked`/busy）；逐条执行，
  第一个异常就停；每条之后 `inTransaction` 为假 → 停（`txnLost`）；全部跑完 → 同一事务 `PRAGMA quick_check`，`ok` 才 `COMMIT`，
  否则 `ROLLBACK`。返回 `{ committed, check: 'ok'|'damaged'|'unchecked', lines, error, code }`。
- S2 `rebuildFTS` / `rebuildIndexes` 经 `checkedWrite`：缺表照旧记 `not found` 不中止；回滚时 `rebuilt` 为空，新增 `check` / `lines`。
- S3 调用方逐个处理"拒绝"分支（§9 并行路径，七处全列）：打开器 VTAB 分支（只读 holder 包住裸句柄；拒绝时不说 recovered，
  错误带 `ftsRebuildRefused`）、doctor（holder；拒绝 → 一条 ✗ + 不写任何东西的说明 + 补救）、`fts-check rebuild` CLI（holder；
  拒绝 → 非 0 退出）、MCP `mem_fts_check rebuild`、快照检查（damaged → bad，unchecked → unchecked）、空闲 optimize、maintain 的 optimize。
- 不在本批：doctor 先跑 `claude mcp list`（条件 2）、复制命令的符号链接（条件 3）——先查 main 上这两处现状，另记；
  普通 hook 写入与 migration 的 rebuild（同第 2 次范围）。
- 验收（任一不成立 → 不合入）：
  - A1 `checkedWrite` 单测先红：健全库提交；交叉链接夹具（fresh / VACUUM / inLog × links 1/3）回滚且 300/300；第一条错误即停；
    `txnLost`（以一条 `ROLLBACK` 步骤模拟）即停；已在事务里 / 忙 → 不写；去掉 holder 时 inLog 形态主文件变化（holder 的变异必须红）。
  - A2 七个调用方各有一条拒绝分支的测试，逐个变异（删掉该分支）各自变红，并断言变异已落地。
  - A3 用产品代码（不是原型）重跑 R 全集：R1、R2 通过。
  - A4 代价：577 MB 合成库热缓存三次，doctor FTS 步骤与 `fts-check rebuild` 新旧耗时；空闲 optimize 加检查的耗时（真实库副本）。
  - A5 全量测试、lint、format、knip 名单、覆盖率门槛。
  - A6 盲审 r1 两视角，按上面的撤回规则。
- 现状核对（2026-11-10，main）：doctor 在 `install.mjs:3044` 跑 `claude mcp list`，早于库检查（约 3150 行）→ 条件 2 仍在。第 2 次 r1 的
  300 → 288 是 mcp list 启动的服务器在打开器 VTAB 分支里重建 FTS（夹具先坏 FTS）造成的；S3 把该分支纳入 checkedWrite。加验收 A7：
  inLog 交叉链接夹具上跑完整 doctor，`claude` 桩真的启动 MCP 服务器，真值行 300/300。复制命令：main 上没有打印复制命令的地方
  （第 2 次加的已随撤回删除）；本批补救文字不新增复制命令 → 条件 3 不涉及。
- 2026-11-10 S1 b9706a55：`lib/checked-write.mjs`（checkedWrite + holdOpen）+ 18 条测试；逐点变异 M1/M2/M3/M5/M6/M7 各红一条具名测试，
  M4（事务内前置判断）存活 → 冗余（BEGIN 本身会抛）已删。之后 format 改了文件 → 合入前在最终代码上重跑变异。pre-commit 555 / 9,988。
- S3 拒绝时的措辞（待定稿）：damaged → "Not rebuilt: the store has page-level damage (<首行>). Nothing was written." + 指向 doctor 的快照补救；
  unchecked → "Not rebuilt: <原因>. Nothing was written." + busy 时"稍后再跑"。CLI 退出 1；MCP 文本同义。
- 2026-11-10 **回归集 R 结果**（`tasks/d593c/r3b.mjs`，树 e215aba4，2,969 个样本，2,953 个能打开；汇总 `sum.mjs`）：
  - **R2 通过**：OLD 让真值行变少或变值的臂（doctor：log 11、main 21、vac:main 1；reindex：log 11、main 21、two 1、vac:main 1），B 全部回滚。
  - txnLost 0（没有一次事务被 SQLite 自己回滚）。
  - **R1 按字面不通过：1 / 5,906 个 B 臂**——two22-165 b-reindex，B 已回滚，读数报"稳定丢失 1 行"（noisy）。归因（`why165.mjs`、
    `read10.mjs`）：B 前后主文件 sha1 相同（2f425cee0e9d），前后日志都为空；`cmp` 证明 B 臂与 s0 主文件逐字节相同；同一份字节在 10 个新
    子进程里读出 3848/3850 行（s0）、3848/3851 行（B）。所以这是读取器在损坏库上的不确定性（第 2 次条件 5 的同一现象：两次读一致不够），
    B 一个字节没写。判定：按实质通过，按字面记为失败并在汇报里说明；不改登记规则，只加这条归因。
  - R3 报出（多拒 = B 回滚而 OLD 什么也没丢）：doctor 869 91、log 273、main 326、two 176、vac:main 42、vac:two 57；reindex 869 164、
    log 403、main 417、two 246、vac:main 46、vac:two 81。检查抛错（unchecked，产品里按 CORRUPT 码判 damaged）：见 sum 输出。
    代价含义：页损坏的库上 B 拒绝重建，搜索保持坏的状态直到恢复快照；OLD 在这些库上不丢行、可能修好搜索。与第 2 次"页损坏就拒绝"同一取舍。
  - 结论：按 R1 实质 + R2 通过，进入实现（S2/S3）。
- 2026-11-10 S2+S3 实现（未提交时的记录）：`rebuildFTS`/`rebuildIndexes` 经 `checkedRebuild`（一个检查过的事务，全有或全无）；
  七个面：打开器（holder + 拒绝不说 recovered + `ftsRebuildRefused`）、doctor（holder + 一条 ✗ + damaged 时复用 `dbCheckRemedy` 的快照补救）、
  CLI（holder 挂 exit + 退出 1）、MCP、快照（`rebuildCheck` 状态判定）、maintain 与空闲 optimize（共用 `optimizeFts`）。
  分类修正：只有环境码（BUSY/LOCKED/FULL/IOERR/NOMEM/CANTOPEN/READONLY/INTERRUPT/PERM 或无码）为 unchecked，其余（含 fts-config 的
  SQLITE_ERROR、REINDEX 的 UNIQUE）为 damaged——否则 fts-config 快照从 bad 退成 unchecked（snapshot-check 测试抓到）。
  旧形态测试改写 5 条（snapshot-check 4、wal-recovery 1，期望文字改为 `not rebuilt: …` 前缀 / 新的 warn 文字；判定不变）。
  逐点变异（format 之后、最终代码）：checkedWrite M1/M2/M3/M5/M6/M6b/M6c/M7 全红；调用方 MO1–MO12 全红，各对应一条具名测试。
- A3 运行中：`r3c.mjs`（NEW = 产品函数 + holder，OLD = `git archive e215aba4` 于 ~/.cache/tmp/agent-tmp-d593c-old），输出 `out3/`，
  汇总 `sum3.mjs`（加了 bytesSame：未提交的臂主文件与已提交日志是否与 s0 逐字节相同）。R 跑完前不改 schema.mjs / checked-write。
- 2026-11-10 提交：S1 b9706a55；S2+S3 5b772004（pre-commit 557 / 10,006）；doctor 只读预检 52f4979c（557 / 10,008）。覆盖率（5b772004 上）
  87.85 / 82.92 / 92.52 / 89.14，门槛通过。knip 未用导出 36、未登记二进制 7（数量同基线；新名字不在名单里）。
- A7（`a7.mjs` → 测试）：第一次跑**不通过**：doctor 的 FTS 步骤正确拒绝，但真值行 300 → 288。`a7b.mjs` 归因：只启动 MCP 服务器再停（SIGTERM 或
  SIGKILL）就丢 12 行，SIGKILL 时只主文件仍 300 → 是服务器启动时提交的普通写入复用了交叉链接页。修：doctor 在 `claude mcp list` 前用只读句柄
  `quick_check(1)`，读出损坏就不启动服务器（52f4979c）。之后 A7 300/300。初稿在进程内加载 better-sqlite3，被 doctor-install-shape-e2e 抓到
  （截断的插件 SIGBUS，D#312）→ 改为与库检查同一道门（dataDirUnreadable / bindingBrokenHere）。MA7 变异（去掉预检）红。
  未关闭：VACUUM 过的库上这次只读读取看不到 freelist（#1051），每个会话的 hook 也同样会写这种库。
- A4 代价（`cost.mjs`，577 MiB 合成库，热缓存，中位数 / 3 次，与 A3 同时跑，有 CPU 争用噪声）：doctor 新增只读 quick_check 2,056 ms；
  rebuildFTS 4,539 → 6,696 ms；rebuildIndexes 4,948 → 7,072 ms；FTS optimize 1,039 → 3,226 ms（空闲 optimize 持写锁约 1 s → 约 3.2 s，
  这期间 hook 的写入要等）。真实库 25 MB 量级时增量约几十 ms（#1051：20.8 MB 上 quick_check 52–57 ms）。数字发版时进 CHANGELOG。
- 2026-11-10 r1 已派（A6）：两个新子代理，缺陷视角 /home/ai/.cache/tmp/rv-d593c-defects、说法视角 /home/ai/.cache/tmp/rv-d593c-claims，
  各自 `git archive 52f4979c` + 复制的 node_modules；只给代码与设计意图，不给本文件的读数。报告各写在目录下 report.md。处理按"撤回规则"一节。
  等待中：A3（r3c，后台）与两份 r1 报告。合入 main 要等 A3 + r1 处理完。
- 2026-11-10 **A3 通过**（`r3c.mjs`，产品代码 5b772004 的 rebuildFTS / rebuildIndexes + holder，OLD = git archive e215aba4；2,969 样本，2,953 能打开）：
  R1 PASS（NEW 臂 0 个稳定丢 / 改），R2 PASS，txnLost 0，**未提交的臂与 s0 主文件 + 已提交日志逐字节不同：0**（直接证明拒绝时一个字节没写）。
  回滚 / 提交计数与原型 R 逐项相同（如 main reindex 回滚 438、提交 352）。s0Noisy 97（读取器噪声，同第 2 次条件 5）。
- 2026-11-10 r1 说法视角（报告 /home/ai/.cache/tmp/rv-d593c-claims/report.md，12 条）。处理（按撤回规则：说法证伪 → 删或收窄；空转测试 → 补强）：
  - 判级：第 4 条（doctor 在无快照、行都读得出的库上建议 set aside 开新库）——相对 e215aba4 数据上更安全（旧版会重建写坏），文字错误、
    mv 不删数据 → 判为真实形态 P2，修一次（restoreOnly），r2 只审修复增量。第 3 条（"Nothing was written" 对命令不成立：未被本版本打开过的库，
    fts-check rebuild 的打开器先写，288/300）→ 收窄为 "The rebuild wrote nothing."；打开器的写属"普通写入"，预先存在，范围外。
  - 修复提交 a7dd0def（pre-commit 557 / 10,011）：文字收窄、doctor restoreOnly、optimize 测试换 FTS 完好夹具 + 直写丢行前提、新增"写前检查读 ok
    的 VACUUM + FTS 完好"测试（V2c 只写前检查变异 → 红）、doctor 比对含日志、doctor 有 / 无快照两条、钉住 IMMEDIATE、若干文档。
    变异：V1（optimize 不检查）红 3、V2b 红 11、V2c 红 2（含新设计守卫）、V3（忽略 restoreOnly）红、V4（删恢复行）红。
  - 早先提交说明里的三处不准确不改写，在 a7dd0def 正文更正（67 个有害臂 / 2,322 次无害拒绝已按 sum 输出核对：doctor 33+965，reindex 34+1,357）。
  - 剩余：空闲 optimize 的 WARN 分支（只是 debug 日志）与源码文本守卫可被刻意绕过 → 不再声称；预登记在 gitignore 的 tasks/ → 合入前把本 spec 与读数归档进 docs/audits。
- 2026-11-10 r1 缺陷视角（报告 /home/ai/.cache/tmp/rv-d593c-defects/report.md；评审自述读过本 spec，非完全盲审，数字均自测）：无 P0；
  P1 ×1、P2 ×3、P3 ×3。**F1 P1 真实形态**：判定标准"quick_check 不是 ok 即损坏"把碰不到任何行的问题（FTS 影子表损坏、泄漏页 "never used"、
  碎片计数）也当损坏 → doctor 拒绝重建并给出恢复 / 挪开补救；在行全部完好的样本上 25/96（main:21 前 200）、25/123（log:23），其中 8 个
  e215aba4 能 ✓ 重建。**在 a7dd0def 上复核仍成立**（`pR-restore-a7dd.mjs`）：main21-15（1,195 行全读得出，问题只是 "Page 408: never used"），
  e215aba4 ✓ 重建，新代码拒绝并建议恢复只有 1,095 行的快照。P2：CLI/MCP 拒绝旧版能完成的修复；doctor 预检把 FTS-only 损坏说成"库读出损坏"；
  大库上事务内 quick_check 持写锁超过 hook 3.5 s（363 MiB：optimize 1,726 → 4,325 ms，另一进程 3.5 s 超时写入 BUSY 3 次 / 旧版 0）。
- **决定：按事先登记的撤回规则（r1 真实形态 P1 → 撤回），撤回第 3 次尝试**。P1 的根因是 S1 的判定标准，四个提交（b9706a55、5b772004、
  52f4979c、a7dd0def）都依赖它（52f4979c 的 P2 同根），不做 fix-on-fix。分支不合入 main，打标签 archive/d593-checked-rebuild 保存；
  证据归档 docs/audits；第 4 次的条件写进延期项（取代 D#632）。成立的部分（写入第 4 次）：2,969 个样本上没有一次有损提交、拒绝时逐字节不写、
  holder 机制、跨进程竞态 9,031 次 0 误判（评审）、14 个交叉链接形态含 64 KiB 页与 1.1 GiB 库（评审）。
