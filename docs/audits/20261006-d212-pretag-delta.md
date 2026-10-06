# 发版前增量审查（DELTA）— D#212 两个修复提交（0b75931..fa14dd5）

审查树：`main` @ `fa14dd5`，范围 `git diff 0b75931..HEAD -- . ':!docs/audits'`，即 `d4cb545`
（提示与 `adopt --status`）和 `0d9f5a1`（缺陷审查的修复）。日期 2026-10-06。审查者不是作者。
对照：`tasks/specs/d212-rules-steering.md`（未跟踪，r2）、`CHANGELOG.md` 的 `## Unreleased`、
code.claude.com/docs/en/memory（AGENTS.md 只在会话目录及以上没有 CLAUDE.md / .claude/CLAUDE.md /
CLAUDE.local.md 时读取；`.claude/rules` 不算；指令文件在 SessionStart 钩子之前读取）。

## 证据环境

- 私有副本：`T=$(mktemp -d /var/tmp/d212delta.XXXXXX)`，`git archive HEAD | tar -x`，`node_modules` 软链；
  对照树 `0b75931` 同法放在 `/var/tmp/d212pre.*`。仓库本身没有改动（`git status` 在审查前后都只有本报告）。
- 测试基线（私有副本，`HOME` 指向临时目录）：`npx vitest run tests/local-steering.test.mjs
  tests/adopt-cli.test.mjs tests/claudemd-remove-enoent.test.mjs tests/steering-injection.test.mjs`
  → `Test Files 4 passed (4)`，`Tests 241 passed (241)`。（同时覆盖 `CLAUDE_CONFIG_DIR` 时
  `cmdAdopt --all` 的 4 个用例红，是探针环境造成的，不算发现。）
- 工具：git 2.53.0，npm 11.19.0，node v26.8.1。
- 每个探针都在新的 `mktemp -d /var/tmp/d212*.XXXXXX` 里跑，`HOME`、`CLAUDE_CONFIG_DIR`、`CLAUDE_MEM_DIR`
  都指向它。骨架（下文各条直接用这些函数）：

  ```bash
  export T=<私有副本> S=$(mktemp -d /var/tmp/d212sb.XXXXXX)
  export HOME=$S/home CLAUDE_CONFIG_DIR=$S/home/.claude CLAUDE_MEM_DIR=$S/mem
  G(){ git -c user.name=a -c user.email=a@b "$@"; }
  mkrepo(){ mkdir -p "$1" && (cd "$1" && git init -q . && G commit -q --allow-empty -m init); }
  # sess = 一次 SessionStart 同步：silentAutoAdopt({cwd}) 的返回值（JSON）
  sess(){ node sess.mjs "$1"; }      # sess.mjs: import(`${T}/adopt-cli.mjs`).silentAutoAdopt({cwd, markerDir:$S/rt, markerKey:'p'})
  cli(){ local d=$1; shift; (cd "$d" && CLAUDE_PROJECT_DIR="$d" PWD="$d" node $T/cli.mjs "$@"); }
  # hk = 真正的 SessionStart 钩子：hook.mjs session-start，stdin {"session_id","source":"startup","cwd"}
  hk(){ (cd "$1" && printf '{"session_id":"s%s","source":"startup","cwd":"%s"}' $RANDOM "$1" \
        | CLAUDE_PROJECT_DIR="$1" CLAUDE_PLUGIN_ROOT=$T node $T/hook.mjs session-start); }
  ```

  `injected=true` 表示钩子输出的 `additionalContext` 里有 `## claude-mem-lite — persistent memory`。

## 汇总

| 级别 | 数量 |
|---|---|
| P1 | 0 |
| P2 | 4 |
| P3 | 7 |

两条 P2（D2、D4）的伤害类别本属 P1（提交 / AGENTS.md / npm），因为需要很窄的前提（D2：同时启动且一个
未跟踪的子目录 AGENTS.md；D4：自相矛盾的忽略配置）而降一级，理由写在各条里。

| 声明 | 结论 |
|---|---|
| K1 | FALSIFIED（统一布局下成立，混合布局下不成立，D2） |
| K2 | 部分 FALSIFIED（文件被移除、`git status` 干净；移除它的那个会话加载两份，D6；之后状态行一直说错，D3） |
| K3 | FALSIFIED（D4） |
| K4 | FALSIFIED（根目录经符号链接到达时不再移除，D1；插件移除后留下的状态读成用户删除，D10） |
| K5 | HELD |
| K6 | 前两句 HELD；"写失败后 info/exclude 原样"FALSIFIED（字节级，D7） |
| K7 | FALSIFIED（D3、D11） |
| K8 | 第一句 FALSIFIED（显式 `adopt` 在 `$HOME`，D8）；第二句 HELD |
| K9 | FALSIFIED（CLAUDE.local.md / CLAUDE.md 是目录或不可读时整个同步中止，会话没有任何引导，D9；钩子本身不崩） |

## 发现

### D1 [P2] 根目录经符号链接到达时，`adopt` 和启动同步不再移除本地副本，块加载两份（修复引入的回归）

- 位置：`adopt-cli.mjs:78`
  `if (atRootOnly && resolve(root) !== resolve(cwd)) return { action: 'absent' };`
  `root` 来自 `git rev-parse --show-toplevel`（真实路径），`cwd` 来自 `CLAUDE_PROJECT_DIR || PWD`（可能是逻辑路径）。
  `resolve` 不解符号链接，所以在根目录本身也判成"子目录"。调用点：`adopt-cli.mjs:203`（显式 adopt）、
  `adopt-cli.mjs:359`（启动同步）。
- 状态：真实仓库 `$S/real/proj`，`$S/link -> $S/real`；插件已写 `CLAUDE.local.md`。
  同一模块里 `isSharedAncestor` 已经为 `/home -> /var/home` 这类布局用 `realpathSync` 比较（delta review P2-3），
  这里没有。
- 复现：

  ```bash
  R=$S/real/proj; mkrepo $R; ln -s $S/real $S/link; L=$S/link/proj
  sess $R            # {"action":"local","written":"created","file":"CLAUDE.local.md"}
  cli $L adopt       # [adopt] .../link/proj → created        （没有 "+removed the block"）
  grep -c 'claude-mem-lite:begin' $R/CLAUDE.md $R/CLAUDE.local.md   # 1 和 1
  sess $L            # {"action":"already-adopted"}；CLAUDE.local.md 里块仍在（1）
  ```

  同一步骤在 `0b75931` 上：`[adopt] .../link/proj → created (+removed the block from .../real/proj/CLAUDE.local.md)`，
  `CLAUDE.local.md` 已不在。
- 期望：比较真实路径（`realOrResolved(root) !== realOrResolved(cwd)`）；根目录无论经哪条路径到达，都移除本地副本。

### D2 [P2] 同时启动的会话一部分看得见 AGENTS.md、一部分看不见时，CLAUDE.local.md 被重新建出来且不在 exclude 里（K1）

- 位置：`lib/local-steering.mjs:583`（`const local = readBlockAt(p, slug)`）到 `:622`（`writeBlockAt(p, …)`）之间
  的窗口：看不见 AGENTS.md 的会话 B 在开头读到块存在，走 CLAUDE.local.md 分支；会话 A 在
  `:759`（`removeTarget(root, slug, LOCAL_MD)`）删掉文件并删掉它的 exclude 行；B 的 `writeBlockAt` 再读时文件
  已不在，于是当作新建写回（结果 `written:"created", file:"CLAUDE.local.md"`）。另一种结局来自 info/exclude
  的读改写竞争：`removeExcluded`（`:486` `writeFileSync(p, next)`）覆盖了别的会话刚追加的规则行，那个会话的
  `check-ignore` 失败，走 `:737` 的 exclude-failed 分支，把刚写好的规则文件删掉并忘掉状态，`ensureExcluded`
  的恢复（`:456` `writeFileSync(p, cur)`）又写回旧快照。
- 状态：插件写过的 `CLAUDE.local.md`（块、状态文件、exclude 行）；一个未跟踪的 `sub/AGENTS.md`；
  会话一半从根目录、一半从 `sub/` 同时启动。只有子目录里未跟踪的 AGENTS.md（或不同用户设置）才会让会话之间看法不同。
- 复现（`k1.sh <轮数> <mode> <N>`：每轮新仓库，先 `sess $R` 写出 CLAUDE.local.md，再并发起 N 个 `sess`）：

  ```
  mode=subdir（根/sub 各半，块正文先改一处模拟模板更新） trials=40 N=4 → localLeft=6 both=6 statusDirty=6
    trial 14 status: ?? CLAUDE.local.md
    结果之一 {"action":"local","written":"created","file":"CLAUDE.local.md"}
  mode=subdir（不改模板） trials=40 N=4 → localLeft=2 statusDirty=2
  mode=subdir trials=25 N=8 → localLeft=1 both=1 neither=1   # neither：exclude-failed 删掉了刚写的规则文件
  mode=tracked（AGENTS.md 被跟踪，所有会话看法相同） trials=15 N=6 → localLeft=0；trials=30 N=10 → localLeft=0
  同一 tracked 布局在 0b75931 上 trials=15 N=6 → localLeft=4
  ```

  重叠证据：tracked 30×10 共 44 个会话报告 `created`，比每轮一个多 14 个；每轮最多 10 个进程，所以至少 2 轮里
  有两个以上会话同时处在写入窗口。混合布局的重叠由结果本身证明（B 在 A 删除之后把文件写回）。
  下一个会话会自愈（规则文件有块 → 删掉 CLAUDE.local.md）：对 trial 14 再跑一次 `sess $R` 后 `git status` 只剩
  `?? sub/AGENTS.md`。
- 降级理由：伤害是 `git status` 里出现带插件块的 `CLAUDE.local.md`（`git add -A` 会提交它），以及这期间从
  `sub/` 启动的会话不读 `sub/AGENTS.md`；但只持续到下一次会话启动，且需要同时启动 + 未跟踪的子目录 AGENTS.md。
- 期望：K1 说的"从不留下"。可行的方向：`writeBlockAt` 建文件前再确认文件仍在（CLAUDE.local.md 分支只更新，不新建
  已经读到过的文件），exclude 文件的改写用临时文件 + 只删自己的行再追加，或给整个同步加一把每仓库的锁。

### D3 [P2] `adopt --status` 和 AGENTS.md 提示不预测 exclude-failed：状态行一直说"下一个会话写"，提示推荐的设置得不到文件（K7、K2）

- 位置：`adopt-cli.mjs:560`（`— none yet: the next session writes …`，`planLocalSteering` 不看 exclude，
  `lib/local-steering.mjs` 的文档注释自己写了 "a failing exclude entry is left to … the write"）；
  `adopt-cli.mjs:421` `settingGivesFile: !localMdRefused(root)`，而 `lib/local-steering.mjs:680-681`
  只看 npm 和状态文件。
- 复现 1（K2 自己的场景，`.gitignore` 反选规则文件之后）：

  ```bash
  R=$S/proj; mkrepo $R; echo canary > $R/AGENTS.md; (cd $R && G add AGENTS.md && G commit -qm a)
  hk $R >/dev/null                                   # 写出 .claude/rules/claude-mem-lite.md
  printf '!.claude/rules/claude-mem-lite.md\n' > $R/.gitignore
  hk $R    # injected=true；提示 "That file cannot be written here (git would not ignore it)…"；.claude/ 被删
  cli $R adopt --status | grep local:
  #   local:      — none yet: the next session writes …/proj/.claude/rules/claude-mem-lite.md (…)
  hk $R    # injected=true，文件仍不存在；状态行仍是同一句——之后每个会话都一样
  ```

- 复现 2（`.gitignore` 里有 `!*.md`，或仓库没有 `.git/info/`，例如 `git init --template=`）：

  ```bash
  R=$S/proj; mkrepo $R; echo a > $R/AGENTS.md; printf '/build\n!*.md\n' > $R/.gitignore; (cd $R && G add -A && G commit -qm a)
  hk $R    # 提示含 "With Project instructions set to claude-md-and-agents-md in /config, AGENTS.md also loads
           #  beside CLAUDE.local.md, which is then written from the next session."
  printf '{"pluginConfigs":{"cc-plugin-agents-md@builtin":{"options":{"instructionFiles":"claude-md-and-agents-md"}}}}' \
    > $CLAUDE_CONFIG_DIR/settings.json
  sess $R  # {"action":"inject","reason":"local-exclude-failed"} —— 照提示做了，没有文件
  ```

  `git init --template=` 的仓库：`sess` → 规则文件 `detail:"exclude-failed"`、`settingGivesFile:true`；
  无 AGENTS.md 的同类仓库 → `local-exclude-failed`。
- 期望：状态行和 `settingGivesFile` 在不写文件的前提下也问一次 git（`git check-ignore --no-index` 加一个临时
  `-c core.excludesFile`，或直接判断 .gitignore 里有没有能匹配该路径的反选、info 目录是否存在），
  预测不了时不要说 "the next session writes"。

### D4 [P2] `npmShipsRules` 判"不会打包"而 `npm pack --dry-run` 打包了：子目录忽略文件里的反选、extglob 反选（K3）

- 位置：`lib/local-steering.mjs:223` 只读根目录的 `.npmignore`/`.gitignore`；`:235` `negationCouldMatchRules`
  不认 extglob（`@(...)`、`+(...)`），npm 的 minimatch 默认开着 extglob。
- 复现（`k3.sh`：新仓库写 `package.json {"name":"x","version":"1.0.0"}` 和忽略文件，先取 `rulesRefusal()`，再放入
  规则文件，跑 `npm pack --dry-run --json --ignore-scripts`）：

  ```
  .gitignore ".claude/rules"  + .claude/.npmignore "!rules"   | refusal=null | npm=SHIPS
  .gitignore ".claude"        + "!@(.claude)"                 | refusal=null | npm=SHIPS
  .gitignore ".claude/rules"  + "!+(rules)"                   | refusal=null | npm=SHIPS
  .gitignore ".claude/"       + "!@(.claude)/"                | refusal=null | npm=SHIPS
  ```

  端到端（第 1、2 行的布局，AGENTS.md 已跟踪）：`sess` → `{"action":"local","written":"created",
  "file":".claude/rules/claude-mem-lite.md"}`，`git status` 不显示它（git 不懂 extglob，`.claude/.npmignore`
  git 不读），`npm pack --dry-run` 列出 `".claude/rules/claude-mem-lite.md"`。
  `.claude/.gitignore`/`.claude/rules/.gitignore` 里的反选 npm 也打包，但 git 同样看得见，写入侧 exclude-failed 拒写，
  所以不造成伤害。
  未复现（`refusal` 与 npm 一致）：BOM、行首空白/制表符、CRLF、`!.`、`!/`、`files` 的大小写（`.CLAUDE`）、
  字符串形式的 `files`、`files` 里的 extglob、`.claude` 被整体忽略时的嵌套反选。
- 降级理由：会真的把文件发布到 npm（P1 类），但两种配置都自相矛盾（先忽略再在 `.claude/` 里或用 extglob 反选）。
- 期望：任何嵌套在 `.claude/`、`.claude/rules/` 下的 `.npmignore`/`.gitignore` 存在即按"会打包"；反选里出现
  `(` 也按"会打包"。

### D5 [P3] `removeTarget` 新加的 catch 把"写不了"报成"没有"：只读目录里 `unadopt` 静默成功，块还在（修复引入）

- 位置：`lib/local-steering.mjs:815-819`（`catch { return { action: 'absent' }; }`）。`removeBlockAt` 里的
  `unlinkSync`/`atomicWrite` 失败也落到这里。这与 `claudemd.mjs` `removeManaged` 注释里的"三种结局"规则相反
  （"nothing to do" 与 "could not finish" 不能同一个口气）。
- 复现：

  ```bash
  R=$S/ro; mkrepo $R; sess $R >/dev/null; chmod 555 $R
  cli $R unadopt; echo "exit=$?"     # [unadopt] …/ro → absent   exit=0   （本地文件一行都没有）
  grep -c 'claude-mem-lite:begin' $R/CLAUDE.local.md                     # 1
  cli $R adopt --status | grep local: # ✓ …/ro/CLAUDE.local.md (auto-written, excluded from git)
  ```

  `0b75931` 上同样操作以未捕获异常的 Node 堆栈结束（失败可见）。
- 期望：只把 `EISDIR`/读失败当成 `absent`；写失败返回 `failed`（或抛出），`unadopt` 说明块还在。

### D6 [P3] 规则文件因 `.gitignore` 反选被移除的那个会话，引导加载两份（K2 "nothing loads twice"）

- 位置：`lib/local-steering.mjs:737-745` 删掉已存在的规则文件并返回 `refused`；`hook.mjs:3202-3205` 照常注入。
  同一提交为"移动块"的会话加了 `moved` 以免重复（`hook.mjs:3213`），这里没有对应处理。
- 复现：见 D3 复现 1 的第二次 `hk`：会话启动时规则文件还在（Claude Code 在 SessionStart 钩子之前读指令文件，
  见对照文档），钩子输出 `injected=true`。
- 期望：`rulesPresent` 时被移除的那个会话不注入（与 `moved` 同理），从下一个会话开始注入。

### D7 [P3] 写失败后 info/exclude 不是"原样"（K6 第三句）

- 位置：`lib/local-steering.mjs:755` 用 `removeExcluded`（只删两行）撤销 `ensureExcluded` 的追加；
  `ensureExcluded` 自己的失败路径（`:452-458`）是按快照恢复的。
- 复现（`.claude` 是普通文件，`mkdirSync` 失败）：

  ```bash
  R=$S/b; mkrepo $R; echo x > $R/AGENTS.md; (cd $R && G add -A && G commit -qm a); echo f > $R/.claude
  printf 'no-newline-at-end' > $R/.git/info/exclude; md5sum $R/.git/info/exclude   # 459cdcd9…
  sess $R      # {"action":"inject","reason":"local-agents-md","detail":"write-failed",…}
  md5sum $R/.git/info/exclude   # 9f54dd03…，末尾多了 \n
  # 原先没有 info/exclude（rm 掉再跑）：之后留下一个 0 字节的 exclude 文件
  ```

  之后的会话不再继续改动（文件已以换行结尾），不累积。
- 期望：与 `ensureExcluded` 的失败路径一样按快照恢复（原来不存在就删除）。

### D8 [P3] 显式 `adopt` 在 `$HOME` 仍把 `@AGENTS.md` 加进 `~/CLAUDE.md`（K8 第一句）

- 位置：`adopt-cli.mjs:196-199`（`adoptOne` 调 `addAgentsImports`），没有 `syncAgentsImports` 新加的
  `isSharedAncestor` 判断（`adopt-cli.mjs` `syncAgentsImports` 开头）。
- 复现：

  ```bash
  echo 'home agents' > $HOME/AGENTS.md; cli $HOME adopt
  # [adopt] …/home → created (+imported AGENTS.md: Claude Code stops reading AGENTS.md once a CLAUDE.md exists)
  head -2 $HOME/CLAUDE.md   # <!-- claude-mem-lite adopt: imports AGENTS.md, … -->  /  @AGENTS.md
  ```

  启动同步那一侧成立：把 import 两行删掉后 `sess $HOME` → `already-adopted`，文件第一行仍是块。
- 期望：`adoptOne` 在共享祖先目录不加 import（或至少在输出里说明它会让下面每个项目都要求批准外部导入）。

### D9 [P3] CLAUDE.local.md 或 CLAUDE.md 是目录/不可读时，同步中止，会话拿不到任何引导（K9）

- 位置：`lib/local-steering.mjs:583` 仍用 `readBlockAt`（修复只给规则文件换了 `readBlockSafe`）；
  `adopt-cli.mjs:313` `readBlock(cwd)`。`silentAutoAdopt` 捕获后返回 `skipped`，钩子既不写文件也不注入。
- 复现（每个都在 AGENTS.md 已跟踪的新仓库里，`sess` 后 `hk`）：

  ```
  mkdir CLAUDE.local.md            → {"ok":false,"action":"skipped","reason":"error","err":"Error: EISDIR … readBlockAt"}  hook injected=false
  CLAUDE.local.md chmod 000        → {"ok":false,…"EACCES … readBlockAt"}                                              hook injected=false
  mkdir CLAUDE.md                  → {"ok":false,…"EISDIR … readBlockAt"}                                              hook injected=false
  ```

  钩子进程退出正常、输出可解析（不是崩溃）。规则文件是目录/不可读、`.claude` 是文件、`info/exclude` 是目录、
  状态文件是目录、`.claude` 悬空链接、规则文件自环链接、PATH 里没有 git：都退回注入（`injected=true`）；
  AGENTS.md 是目录：被当作 AGENTS.md，写出规则文件。这九种都没有抛出，成立。
  这条在 `0b75931` 前就存在，修复声明把它包括进去了。
- 期望：CLAUDE.local.md 读不了时按"拒写 + 注入"处理（不是跳过整个同步）。

### D10 [P3] 插件自己移除的块留下状态文件，之后读成"用户删除"（K4 第二句）

- 位置：`adopt-cli.mjs:203`（显式 adopt）与 `:359`（启动同步）经 `dropLocalSteering` 移除本地副本，
  但不调 `forgetLocalSteering`；`.git/claude-mem-lite-local-steering.json` 留着。
- 复现：

  ```bash
  R=$S/proj; mkrepo $R; sess $R; cli $R adopt        # (+removed the block from …/CLAUDE.local.md)
  cat $R/.git/claude-mem-lite-local-steering.json     # {"created":…,"createdFile":true,"file":"CLAUDE.local.md"}
  rm -rf "${R:?}/CLAUDE.md" "${R:?}/.claude"          # 或切到一个没有 CLAUDE.md 的分支
  sess $R                                             # {"action":"inject","reason":"local-removed"}
  cli $R adopt --status | grep local:                 # ✗ removed: deleted by you or unadopt, …
  ```

  `0b75931` 上结果相同（既有行为，不是修复引入）。同类：在子目录运行 `adopt --disable` 会移除根目录的文件
  （`cmdDisable` → `dropLocalSteering(dir)`，无 `atRootOnly`），而禁用只记在子目录的 memdir 下；根目录下一个会话
  → `local-removed`，状态行同上。
- 期望：插件因为 CLAUDE.md 接管而移除本地副本时一并 `forgetLocalSteering`。

### D11 [P3] 其余与下一个会话不符的状态行 / 提示（K7）

- (a) 非 git 目录、CLAUDE.md 带块：`adopt-cli.mjs:543-544` 先于 `:550` 返回
  `— none here: … (steering is injected at session start)`；`hk` 无输出（CLAUDE.md 承载，不注入）。
- (b) 根目录 CLAUDE.md 带块 + 未跟踪的 CLAUDE.local.md 带块：`:546-549` 打印
  `✓ …/CLAUDE.local.md (auto-written, excluded from git)`；下一个会话删除它（`hk` 后只剩 `CLAUDE.md`）。
- (c) `.claude` 是指向另一个目录的链接、那里有带块的规则文件：打印 `✓ …/.claude/rules/claude-mem-lite.md
  (auto-written, excluded from git)`，而 `git status` 显示 `?? .claude`；会话 `already-adopted`。
- (d) 根目录有用户自己的 `CLAUDE.local.md`（无块，未跟踪）+ AGENTS.md + npm 包根：提示（`hook.mjs:2777`，
  `d4cb545` 新写的句子）说 "Claude Code reads …/AGENTS.md as this project's instructions"，状态行说
  "Claude Code stops reading … once a CLAUDE.local.md exists"——那个 CLAUDE.local.md 已经存在，AGENTS.md 本来就没被读。
  根源是 `lib/local-steering.mjs:277-278` `shadowedAgentsMd` 只看根目录的 CLAUDE.md / .claude/CLAUDE.md，
  不看用户的 CLAUDE.local.md 和根目录以上的 CLAUDE.md（`agentsMdForNewClaudeMd` 看）。
- 复现：`k7 <name> <setup>` = 新仓库 + setup + `cli adopt --status` + `hk` + 列文件和 `git status`，输出原文见上各项。

## K1–K9 逐条

- **K1 FALSIFIED。** 统一布局（AGENTS.md 被跟踪）0/15、0/30 留下 CLAUDE.local.md（对照 `0b75931`：4/15），
  ENOENT 修复在这个布局下有效；混合布局 6/40、2/40、1/25 留下且出现在 `git status`（D2）。
- **K2 部分 FALSIFIED。** 移除与注入成立：反选后下一个会话删掉文件、目录和 exclude 行，`git status` 只剩用户的
  `.gitignore`。不成立：移除它的那个会话两份（D6）；状态行此后一直说"下一个会话写"（D3）。
- **K3 FALSIFIED。** D4 的四种配置；另外 27 种配置的判定与 npm 一致（D4 列了其中的类别），两种嵌套 `.gitignore`
  反选 npm 打包但写入侧 exclude-failed 拒写。`"private": true` 时 `npm pack` 仍打包，
  但规格与 CHANGELOG 的口径是 `npm publish`，不计。
- **K4 FALSIFIED。** 子目录不删根目录文件：成立（`atRootOnly`）。根目录"仍然删"：经符号链接到达时不删（D1，回归）。
  "不留下读成用户删除的状态"：不成立（D10，既有）。
- **K5 HELD。** 被跟踪的 `CLAUDE.local.md`（带块，根目录 CLAUDE.md 也带块）：`sess` → `already-adopted`，
  `git diff --stat -- CLAUDE.local.md` 为空，状态行 `✓ … (tracked by git; the plugin leaves it as it is)`；
  `unadopt` → `CLAUDE.local.md | 18 ------------------`。被跟踪的规则文件 + CLAUDE.md：`sess` 后 `git status`
  里它没有变成已修改。`writeLocalSteering` 里 `:605` 的 `removeLocalSteering(root, slug)` 没有 `keepTracked`，但到达那里时
  CLAUDE.local.md 已确认未跟踪、规则文件没有块，不会改动被跟踪文件。
- **K6** 自有 exclude 行：`.gitignore` 是 `.claude/` 时仍追加（计数 1）——HELD。CRLF：转成 CRLF 后
  `sess` 不重复追加（仍 1），`unadopt` 后为 0——HELD。写失败原样：FALSIFIED（D7，字节级）。
- **K7 FALSIFIED。** D3（exclude-failed 不被预测，状态行与设置提示都错）、D11。`/adopt` 提示的条件
  （`imports>0 && elsewhere==0`）与 `adoptOne` 实际导入一致，在我试过的布局里成立。
- **K8** 第一句 FALSIFIED（D8，显式 adopt）；启动同步那一侧成立。第二句 HELD：标记行 + 块（LF、CRLF、
  块在标记前）三种 `unadopt` 后 `CLAUDE.md` 都不存在。
- **K9 FALSIFIED。** D9；其余九种奇怪路径成立（列在 D9）。

## NOT CHECKED

- 真实 Claude Code 会话：所有"会话加载了什么"都由钩子输出 + 对照文档推出，没有在 Claude Code 里看 instructions
  附件（D6 的"启动时已读规则文件"、D1 的"两份都加载"都是这样推出的）。
- Claude Code 设置的 `CLAUDE_PROJECT_DIR` 是真实路径还是逻辑路径：决定 D1 在启动同步一侧是否发生；显式
  `claude-mem-lite adopt` 从 shell 运行时用 `PWD`（逻辑路径），这一侧已复现。
- macOS（大小写不敏感文件系统、`/private` 前缀）：`files: [".CLAUDE"]` 在 Linux 上不打包，APFS 上未试；
  路径大小写不同也会触发 D1 的同一比较。
- Windows、`core.autocrlf`、`.git` 为文件的 linked worktree 下的 D2 竞争。
- git 命令瞬时失败（5 s 超时、负载高）时 `ensureExcluded` 返回 `failed` 并删掉已写的规则文件：从代码推断，未复现。
- 全量测试、eslint、format、knip、覆盖率：只跑了与修复相关的 4 个测试文件。
- A/B 规格里的发版条件与护栏（不属于本次增量）。
- 变异验证：没有对修复的测试做变异。
