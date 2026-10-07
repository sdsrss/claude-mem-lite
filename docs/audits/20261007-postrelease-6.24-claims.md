# Post-release review — v6.24.0 batch D#266–D#270, claims lens (blind)

- Range: `f09a9419..a41d9963`. 7 commits. Reviewer: fresh `reviewer` subagent, blind brief. Delivered 2026-10-07 by heredoc file.
- Disposition: P2-1 (SKIP_UPDATE "no lookup runs at all") reworded in CHANGELOG, install.mjs and the test comment in 0d1ae7b5, 888bad9b message left in history; P3-4 (wrote no state) in 0d1ae7b5; P3-6 (D#268 headline) and P3-9 (hook-optimize test comment) and P3-10 (race premises assert the write landed) in 9f91f846; P3-2 (setup.sh arms; its posix-premise sub-point in 6ea6f1f4) and P3-5 (per path text) and P3-7 (data-paths "then") and P3-9 (setup.sh, hook-shared comments) in a21669cc; P3-8 (57 MB read as the -g/npx figure) in README and CHANGELOG with this archive. History only: P3-1 (71741063: 2 cases red, not 1), P3-3 (no shipped writer can store a person-set importance 0, so that CASE is observable only through direct SQL), P3-11. docs/audits/20261007-pretag-6.24-delta.md:4 left as archived.
- Archived verbatim below.

---

# 盲审（声明视角）：f09a9419..a41d9963（main，未推送）

- 范围：`git log f09a9419..HEAD` 共 **7** 个提交，不是 8 个（`git status -sb` 显示 `main...origin/main [ahead 7]`）：888bad9b、0d86fe96、a250d56c、71741063、2914930c、ae1b4252、a41d9963。
- 方法：在 `$HOME/.cache/tmp/wt-claims` 建 worktree，对每个提交 X 检出 `X~1` 的代码，叠加 X 的新测试，统计哪些用例变红；变异都在各提交自己的代码树上做，每次都用 `git diff` 确认变异确实落地（有两次 sed 没生效，已改用 perl 重跑）。TMPDIR 未设置（即 /tmp），用户环境变量 `CLAUDE_MEM_SKIP_UPDATE` 已 unset。worktree 已删除，主工作树干净。
- HEAD 新鲜证据：worktree 中 `npx vitest run` 在 a41d9963 上结果为 **485 files / 8299 tests 全部通过**，exit 0。
- 计数：**P1 0 · P2 1 · P3 11**

---

## P2

### P2-1 "With `CLAUDE_MEM_SKIP_UPDATE` set no lookup runs at all" —— 不成立：`repair` 仍会联网查询
- 位置：CHANGELOG.md:10-11（Unreleased，D#266 条目）。同一说法另有三处副本：install.mjs:2519-2520 注释 "No lookup runs while checks are off, so a failure recorded before they were turned off is never cleared and no state file ever appears"；tests/doctor-update-pending.test.mjs:105 "no lookup runs while CLAUDE_MEM_SKIP_UPDATE is set"；以及 888bad9b 的提交信息 "With CLAUDE_MEM_SKIP_UPDATE set (or on a development install) no lookup runs"。
- 实际情况：`repair()`（install.mjs:3329）在 install.mjs:3360 无条件调用 `fetchLatestRelease()`，而 `fetchLatestRelease`（hook-update.mjs:320-324）不调用 `updateCheckDisabledReason()`。hook-launcher 的自动修复也会在 scripts/hook-launcher.mjs:364 启动 `install.mjs repair`，没有任何 SKIP_UPDATE 门控。在 install.mjs / cli.mjs / lib / hook*.mjs 中 grep `SKIP_UPDATE|updateCheckDisabledReason`，只命中 checkForUpdate 的三个早退出口（hook-update.mjs:82,182,215）、self-update（install.mjs:3282）以及新的 doctor 代码，repair 中没有。
- 与仓库自身文档冲突：README.md:1222 写的是 "A `repair` triggered by a missing module or dependency still runs."
- 本批提交让副本更不准确：在 888bad9b 之后，SKIP_UPDATE 下的一次成功 repair 查询**会**清除已记录的失败（清除逻辑写在 `fetchLatestRelease` 里，没有门控）。因此 "never cleared" 不成立；被限流的 repair 查询还会通过 fetchJson 写入 `rateLimited: true`（hook-update.mjs:428），所以 "no state file ever appears" 也不成立。
- 用户为什么会被误导：设置 SKIP_UPDATE 想要完全不联网的用户（比如隔离网络环境）会读到"没有任何查询"，但每次 SessionStart 由缺失模块触发的自动修复仍然会请求 api.github.com。
- 修复建议：措辞改为"后台检查和 self-update 不再执行查询；repair（手动或自动修复）仍会查询"，并同步修改三处副本。

## P3

### P3-1 71741063 "1 new case red before (the second profile's dedup)" —— 实际有 2 个新用例在修复前为红
- 证据：在 a250d56c 的代码上叠加 71741063 的测试后：`Tests 3 failed | 28 passed (31)`。两个新用例都红了：
  - "a second profile gets its own MCP dedup and residue warning"（install-lifecycle.test.mjs:958，dedup 断言）
  - "CLAUDE_CONFIG_DIR=~/.claude: … .claude.json is a new file"（install-lifecycle.test.mjs:993："~/.claude/.claude.json was skipped on the marker of ~/.claude.json"）
  - 另外，修改过的守卫 "no shipped bash script reads $HOME/.claude outside its config-home case" 也红了（新的允许列表指向的行在修复前还不存在）。
- 原因：父提交的代码对所有 profile 只用一个裸 `.mcp-dedup-v2.78`。第二个用例预先创建了这个文件，所以 dedup 被跳过。"MCP unkeyed" 变异同样让这两个用例变红，结果一致。

### P3-2 2914930c "Each arm of the rule mutated alone in either script reds a behavioural case, not only the text check" —— 对 setup.sh 的盘符分支不成立
- 证据（2914930c 代码树，变异已用 `git diff` 确认落地）：
  - setup.sh：去掉 msys 分支里的 `| [A-Za-z]:[\\/]*` 后，**全量套件 485 files，1 failed / 8297 passed**，唯一失败的是文本检查 "setup.sh carries the same _mem_is_abs body"。原因是 install-lifecycle 里 D#269 的 setup 用例只测了 `msys + \\srv\cfg` 和 `linux-gnu + C:/cfg`，没有 `msys + C:/cfg`。
  - 两个脚本中把 `msys* | cygwin*` 改成 `msys*`：相关的 6 个测试文件里也只有这条文本检查变红。如果两个脚本同时改，就没有任何用例会发现。
  - 其余变异属实：`/*` 分支（两个脚本）、反斜杠分支（两个脚本）、OS 门控放宽为 `*)`（两个脚本）、post-tool-use.sh 的盘符分支，都至少让一个行为用例变红。
- 相关措辞 "hold bash to path.win32 / path.posix over six values"：posix 分支（"elsewhere (OSTYPE=linux-gnu) follows path.posix.isAbsolute"）的 6 个值在 posix 下全部是相对路径，这个分支没有"两种结果都出现"的前提断言（msys 分支有）。所以 `/*` 分支被删掉时，这个用例看不出来；实测 post-tool-use.sh 删除 `/*` 后，变红的是其他用例，不是这一条。

### P3-3 a250d56c "The importance_set_at CASE in the new branch is observable only for an imported person-set importance of 0" —— 没有任何发布出去的写入路径能产生这种行
- 证据：唯一从备份复制 `importance_set_at` 的写入者是 `cmdRestore`（mem-cli.mjs:2324），它会把 importance 钳到 1..3（mem-cli.mjs:2445 `importance: imp >= 1 && imp <= 3 ? imp : 1`）。另外两个写 importance_set_at 的路径都校验 1..3：MCP mem_update（tool-schemas.mjs:498 `min(1).max(3)`）和 CLI update（mem-cli.mjs:2115）。所以"导入的、由人设定的 importance 0"无法通过 restore 产生；这个 CASE 只有直接改 SQL 才能观察到。保留它是为了与主 UPDATE 保持一致，这个理由仍然成立。
- 同一提交还有一处小问题："writes … what hiding would have written bar the hide: the stamp and the importance floor"。隐藏写的是 `compressed_into` 和 `optimized_at`（hook-optimize.mjs:509），并不写 importance 下限。代码注释（"the stamp … plus the importance floor below"）的写法是对的。

### P3-4 888bad9b 提交信息和 tests/hook-update.test.mjs:817 "fetchLatestRelease, which wrote no state" —— 被限流时会写状态
- fetchJson 遇到 403/429 时会持久化 `rateLimited: true`（hook-update.mjs:428）。准确的说法是"成功时不写任何状态"。

### P3-5 CHANGELOG.md D#270 条目 "Each record is now kept per file it checks; the default `~/.claude.json` and `~/.claude/settings.json` keep the records existing installs already have" —— 实际是按路径的写法区分，不是按文件
- `marker_suffix` 比较的是原始字符串（scripts/setup.sh:67-69），所以同一个文件的不同写法会得到不同的标记。
- 沙箱探针（HOME 指向沙箱，预先放好裸标记，settings.json 里带旧 hooks，运行 HEAD 的 scripts/setup.sh）：
  - `CLAUDE_CONFIG_DIR="$HOME/.claude"`：residue 警告出现 0 次
  - `CLAUDE_CONFIG_DIR="$HOME/.claude/"`：警告出现 **1** 次，同一个默认 settings.json 被重复警告；同时还为写作 `…/.claude//.claude.json` 的同一文件生成了第二个 dedup 标记 `.mcp-dedup-v2.78-3398047757`。
- 提交信息里 "Each marker now carries a cksum of the path it gates" 也是同样的情况：residue 标记的 cksum 取自配置目录（scripts/setup.sh:422 `"$CC_CONFIG_DIR"`），不是取自 settings.json。目录和文件一一对应，所以只是措辞问题。

### P3-6 CHANGELOG.md D#268 标题 "a re-enrich reply that scores a protected row 0 no longer writes into it" —— 标题比正文说得更强
- narrow 作用域下仍会写 `optimized_at` 和 importance 下限（hook-optimize.mjs:529-545）；wide 作用域下，被保护的行收到 0 分仍走正常写入路径，会写入 type/lesson/concepts 等字段（由 premise 用例 "a 0 reply in wide scope still fills the lesson" 固定）。正文已经限定了范围，但只看标题的读者会以为两种作用域都不再写入。建议标题写成 "narrow re-enrich … writes nothing from the reply"。

### P3-7 lib/data-paths.mjs:48-50 "Claude Code resolves such a value against the directory it starts in (2.1.293), so the two then use different config homes" —— "then" 说得过满
- 按这句话自己陈述的规则，当 Claude Code 在 $HOME 启动且值为 `.claude` 时，两边得到的都是 `~/.claude`。doctor 发出警告是对的，但"不同的配置目录"只是可能，不是必然。宿主的行为本身在这里无法验证（见 NOT CHECKED）。

### P3-8 CHANGELOG 6.24.0 一节（CHANGELOG.md:51-52）以及 README.md 的 "96 packages / 57 MB" 被理解为 `npm -g` / `npx` 的数字
- 新句子 "the same size to within 0.1%" 紧跟在 57 MB 后面，读者会推断 npm -g/npx 也是 57 MB。但 a41d9963 自己的提交信息说，在唯一一次实测这两种安装方式的运行中，三种方式按 `du -sm` 都是 59 MiB。0.1% 的比较对象是同一次运行里的依赖安装（字节数 48,508,780 对 48,554,342，算得 0.094%，算术成立），不是 57 MB。
- README.md:255-256 中 "Also in this release: `npm install -g claude-mem-lite` and `npx` … (96 packages / 57 MB instead of 298 / 541 MB)" 没有更新，它把本地 registry 的依赖安装数字说成了 -g/npx 的数字。
- 另外 CHANGELOG.md:52 的修改让这一行变成了未换行的长行（排版小问题）。

### P3-9 本批提交造成的过时副本注释
- scripts/setup.sh:459-460 "the warning above is one-shot per data-dir"：现在是每个配置目录一次（同一文件 :421 已改成 "one warning per config home"）。
- scripts/setup.sh:415 第 9 步标题 "hooks remain in ~/.claude/settings.json"：应为配置目录下的 settings.json。
- hook-shared.mjs:283-284 "removes mcpServers.mem / mcpServers["mem-lite"] from the user's ~/.claude.json"：现在每个配置目录有自己的 .claude.json，并且每个文件各有一个标记。
- tests/hook-optimize.test.mjs:1359-1361 "(the guard at the session-id rewrite is keepStoredText, not !isWide)"：a250d56c 之后 `keepStoredText = isWide`（hook-optimize.mjs:587），narrow 下的 0 分回复在走到 session-id 改写之前就已经从新分支返回。这个用例仍然通过，但注释里解释的机制已经不存在。
- 仅供参考：docs/audits/20261007-pretag-6.24-delta.md:4 的处置记录写着 "P3-2 … stays covered only by the end-to-end install from the packed tarball"，ae1b4252 之后已过时。这是归档的审计报告，不改也说得过去。

### P3-10 0d86fe96 "asserting the write landed"
- 两个用例的前提断言是 `reads === 1`，也就是 afterRead 回调执行了一次，并没有断言写入生效（UPDATE 的 changes 或成员行是否存在）。写入确实生效这一点由变异结果间接证明：每删掉一个谓词，对应用例就变红。措辞比测试本身断言的内容强一些。

### P3-11 关于 "8 commits" 的范围说明（lead 的说法，不是作者的）
- 实际是 7 个提交（见文首）。

---

## Checked, holds (with evidence)

**888bad9b (D#266)**
- "3 new cases red before, 3 premise/guard green"：在 f09a9419 上叠加新测试，结果 `3 failed | 99 passed (102)`。红的是 "a successful lookup through fetchLatestRelease clears…"、"says the checks are off…" 和 "with no state file, says the checks are off…"；绿的是 premise、control 和 "writes no state file"。
- "each of the three sites mutated alone turns at least one case red"：去掉清除调用 1 红；去掉 no-op 早返回 1 红；doctor 的 `checksOff = null` 2 红。
- "24 h, 6 h when rate-limited"：见 hook-update.mjs:62 和 :67。"clears lookupError, lookupFailingSince and rateLimited, and leaves lastCheck and latestVersion"：与 hook-update.mjs:330-334 及测试断言一致。

**0d86fe96 (D#267)**
- "Deleting `importance_set_at IS NULL` left the whole suite green"：在 888bad9b 上删除 hook-optimize.mjs:511 的谓词后跑全量，`485 passed / 8283 passed`。
- "deleting NOT_COMPRESSION_KEEPER_SQL was caught only by a text scan"：全量 `1 failed | 8282 passed`，唯一失败是 tests/compression-keeper-writers.test.mjs 的 "every one carries NOT_COMPRESSION_KEEPER_SQL"。
- "89 cases, 1 red" 并且每个谓词对应各自的用例：在 0d86fe96 上基线 89 全过；删除 importance_set_at 谓词 1 红（person-set 竞态用例）；删除 keeper 谓词 1 红（keeper 竞态用例）。
- "no await in between"：最后一个 await 在 hook-optimize.mjs:470（`callModelJSONAsync`），之后 :489 的 isKeeper、:494 的 humanSet、:509 的 UPDATE 都是同步的 better-sqlite3 调用。

**a250d56c (D#268)**
- "2 new cases red before (all six fields written), 1 premise green"：`2 failed | 90 passed (92)`。差异显示 type/lesson_learned/concepts/facts/search_aliases/scope 六个字段全部被写入。
- "branch off reds 5, stamp nulled reds 3, floor removed reds 1"：实测 5、3、1，完全一致。
- "keepStoredText is now isWide alone"：见 hook-optimize.mjs:587。"A lesson-bearing row is what pre-tool recall injects"：见 scripts/pre-tool-recall.js:655-674。
- 触达数据：20:26:38Z 在本机 DB 上只读查询：288 live、person-set 0、live keepers 0、9 个项目。这与作者 19:37Z 的 286 / 0 / 0 一致（DB 在增长，按规则 2 这只能算佐证，不算同一时间的复测）。narrow/wide 候选池的数量没有重新计算。

**71741063 (D#270)**
- 最终代码树上的变异：MCP 标记去掉 key 2 红；residue 标记去掉 key 1 红；去掉默认路径豁免 3 红；dedup 改为按目录 key 1 红；`~/.claude.json` 出现第二种写法 1 红（单一写法守卫）。都成立。
- "marker prefixes unchanged, so GC_PRESERVED_MARKER_PREFIXES and sentinelPrefixesFromShell still cover them"：对 HEAD 脚本运行 `sentinelPrefixesFromShell` 得到 `['.mcp-dedup-', '.residue-warned-']`；保留判断在 hook-shared.mjs:360 用的是 `startsWith`，`.mcp-dedup-v2.78-1234567890` 和 `.residue-warned-v2.55-42` 都返回 true。
- CHANGELOG 中 "only the first profile to start was checked"：上面"第二个 profile"用例在修复前为红，证实了这一点。

**2914930c (D#269)**
- 列出的 "Red before" 项：在 71741063 上 `8 failed | 55 passed (63)`。盘符一致性用例、两个平台分支、setup.sh 用例、helper 用例、"doctor warns" 用例都红（另有两条文本检查也红）；"doctor says nothing" 是守卫用例，修复前为绿。
- "Bash keeps an inherited OSTYPE"：bash 5.3.9 上 `OSTYPE=msys bash -c 'echo $OSTYPE'` 输出 `msys`。
- 两个 `_mem_is_abs` 函数体完全相同（文本检查在 HEAD 通过）。只有两个 bash 脚本读取 CLAUDE_CONFIG_DIR（grep scripts/*.sh）。Node 侧所有读取点都用 `isAbsolute`（lib/data-paths.mjs:43-44、54-55、74-75，lib/bash-file-targets.mjs:42-43），所以 "followed only as an absolute path, on every face" 成立。
- 单一写法守卫现在会标记裸 `$HOME/.claude`，post-tool-use.sh 的默认行在允许列表中：见测试和 HEAD 全量通过。
- post-tool-use.sh 耗时：我的测法（bash 循环、`env -i`、沙箱 HOME、Glob 工具、每轮 200 次、3 轮交替）旧版 2901/2915/2947 µs，新版 2915/2662/2722 µs，看不出额外开销，与 "no cost" 的结论一致。绝对值和作者的 4.4 ms 不同，因为测量方式不同。
- 本机安装的 Claude Code 版本是 2.1.293（`~/.local/share/claude/versions/2.1.293`，也是 `claude` 链接的目标），与 "checked on 2.1.293" 一致。

**ae1b4252**
- 在 ae1b4252 上执行 `npm pack --dry-run --json --ignore-scripts`（沙箱 HOME）：187 个文件，不含 package-lock.json，也不含 npm-shrinkwrap.json，所以确实需要额外放一个探针 shrinkwrap 文件。
- 删除 install.mjs 的 `deployLockfile(PROJECT_DIR, DATA_DIR);` 后变红，报错 `ENOENT … .claude-mem-lite/package-lock.json`。耗时：用例 436 ms，文件 645 ms（作者写的是 "0.7 s"）。
- 提交信息里 "187 … asserted"：测试只断言了不含 package-lock.json 和含有 install.mjs，没有断言 187 这个数字。若把 "asserted" 理解为只修饰 "no package-lock.json"，则成立。

**a41d9963**
- 0.1% 的算术：(48,554,342 − 48,508,780) / 48,508,780 = 0.094%。
- 引用的审查条目存在：docs/audits/20261007-pretag-6.24-claims.md:80（P3-5）、docs/audits/20261007-pretag-6.24-delta.md:76（P3-2）。
- v6.24.0 tag 存在，f09a9419 已在 origin/main 上。

## NOT CHECKED
- Claude Code 对相对路径和空 `CLAUDE_CONFIG_DIR` 的处理（"wrote <cwd>/relcfg/.claude.json"、"empty → ~/.claude.json"）：按规则没有运行 claude CLI，此处无法验证。
- 公共 registry 上的 npm -g / npx 测量（96 个包，48.5 MB，59 MiB）以及 6.24.0 是否已发布到 npm：需要联网，此处无法验证。
- 真实的 Windows/MSYS/Cygwin shell、macOS 的 bash 3.2（OSTYPE 继承行为、MSYS 路径转换）。
- narrow/wide 候选池的触达数量（只重新统计了 live、keeper、person-set 行）。
- 历史类说法："a first draft keyed on the dir skipped that file's dedup"、"only a one-off install from the packed tarball had exercised it"；4c174fa6 的描述只通过父提交代码（`keepStoredText = isWide || scoredZero`）核对过。
- 没有跑 eslint、prettier、shellcheck，也没有跑覆盖率（不属于声明视角）。
- 副作用说明：为检查 GC 前缀，我在真实 HOME 下导入过一次 `hook-shared.mjs`。它在模块顶层会把已存在的 `~/.claude-mem-lite/runtime` chmod 为 0700；事后确认该目录仍是 700，过去 6 分钟内没有新文件。
