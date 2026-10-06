# 发版前审查（第 4 轮）— `aab316c`：AGENTS.md 旁默认改回注入，规则文件改为 opt-in

审查对象：`aab316c`（"change(adopt): beside an AGENTS.md the default is injection again; the rules file is opt-in"），
范围 `git show aab316c`：`lib/local-steering.mjs`、`adopt-cli.mjs`、`hook.mjs`、`tests/local-steering.test.mjs`、
`CHANGELOG.md` 的 `## Unreleased`、`README.md`、`README.zh-CN.md`、`commands/adopt.md`、`commands/unadopt.md`。
日期 2026-10-06。审查者不是作者。仓库本身没有改动（`git status` 审查前后只多出本报告）。

对照的合同：变量 `CLAUDE_MEM_RULES_STEERING` 未设时，在 `shadowedAgentsMd` 成立的 git 仓库里不写文件、改为注入，之前写进
`CLAUDE.local.md` 的块被移除（该会话不再注入）；设为 `1` 时写 `.claude/rules/claude-mem-lite.md`，带全部既有拒写条件；
已带块的规则文件在变量未设时仍是渠道；`adopt --status` 和一次性提示在两种模式下都要说出下一个会话实际做什么；用户文档要正确
描述默认和 opt-in。背景事实（未在本轮用真实 Claude Code 复核，见 NOT CHECKED）：Claude Code 2.1.277+ 只在会话目录及以上没有
`CLAUDE.md` / `.claude/CLAUDE.md` / `CLAUDE.local.md` 时读 `AGENTS.md`；`.claude/rules/*.md` 不算，且作为项目指令加载；
指令文件在 SessionStart 钩子之前读取。

## 证据环境

- 私有副本：`T=/var/tmp/r4.UkTe0t`，内含 `git archive` 出的 `aab316c`、`61a8ae1`、`b9e4fbe`、`v6.21.0`（最后一个用来复现真实
  升级路径），以及 `m61`（`61a8ae1` 代码 + `aab316c` 的测试文件）。每份都软链主仓库的 `node_modules`。
- 每个探针在新的 `mktemp -d /var/tmp/r4sb.XXXXXX` 里跑，`HOME`、`CLAUDE_CONFIG_DIR`、`CLAUDE_MEM_DIR` 都指向它；继承来的
  `CLAUDE*` / `MEM_*` 变量全部清掉，只按探针需要再设；另设 `CLAUDE_MEM_SKIP_UPDATE=1`、`CLAUDE_MEM_SKIP_MAINTAIN=1`。
  探针仓库都在 `/var/tmp` 下，确认过 `/`、`/var`、`/var/tmp` 没有 `AGENTS.md` / `CLAUDE*.md` / `.claude`。
- 会话一律走真实钩子：`printf '{"session_id":…,"source":"startup","cwd":"%s"}' "$R" | CLAUDE_PROJECT_DIR="$R" node <tree>/hook.mjs session-start`，
  `hookSpecificOutput.additionalContext` 里数 `## claude-mem-lite — persistent memory` 出现次数（= 注入），`systemMessage` = 提示。
  每个会话之前先跑一次 `node <tree>/cli.mjs adopt --status` 取 `local:` 行。下文复现用的骨架：

  ```bash
  S=$(mktemp -d /var/tmp/r4sb.XXXXXX)
  export HOME=$S/home CLAUDE_CONFIG_DIR=$S/home/.claude CLAUDE_MEM_DIR=$S/data CLAUDE_MEM_SKIP_UPDATE=1 CLAUDE_MEM_SKIP_MAINTAIN=1
  mkdir -p $CLAUDE_CONFIG_DIR; unset CLAUDE_MEM_RULES_STEERING MEM_NO_AUTO_ADOPT CLAUDE_PROJECT_DIR
  G(){ git -c user.email=t@t -c user.name=t "$@"; }
  mkrepo(){ mkdir -p "$1"; G -C "$1" init -q; echo '# app' > "$1/README.md"; G -C "$1" add -A; G -C "$1" commit -qm init; }
  agents(){ echo '# agents' > "$1/AGENTS.md"; G -C "$1" add AGENTS.md; G -C "$1" commit -qm agents; }
  hk(){ printf '{"session_id":"s%s","source":"startup","cwd":"%s"}' $RANDOM "$R" | env "$@" CLAUDE_PROJECT_DIR="$R" node $T/hook.mjs session-start; }
  st(){ (cd "$1" && CLAUDE_PROJECT_DIR="$1" node $T/cli.mjs adopt --status | grep local:); }
  ```
- 矩阵驱动 `drive.mjs <T> <tree> <on|off>`：28 个仓库状态（A…ZC，见文末附表），每个状态里依次跑若干会话，记录：会话启动时磁盘上
  哪些带块的文件会被加载（会话目录到根逐级的 `CLAUDE.md`、`CLAUDE.local.md`、`.claude/rules/claude-mem-lite.md`）、是否注入、提示、
  会话后的文件状态（`CLAUDE.local.md` / 规则文件 / `.claude` / `.claude/rules` / `info/exclude` 的非注释行 / `git status --porcelain`）。
  每个会话给出判定：`BOTH`（加载了带块的文件又注入）、`NEITHER`（两者都没有）、`ok`。
  - 尺子能说"不"：同一个驱动在 `b9e4fbe` 上判出 9 个 `BOTH`、1 个 `NEITHER`（都是 CHANGELOG 列出的修复点），在 `aab316c` 默认模式下是 0。
  - "之前版本写过 `CLAUDE.local.md`"的状态，用 `b9e4fbe` 在加 `AGENTS.md` 之前跑会话写出（等价于 6.20/6.21 的写法）；另用真实
    `v6.21.0` 树单独复现了一次升级（插件自建文件、用户自己的文件两种）。
- 测试：在 `aab316c` 私有副本里 `npx vitest run tests/local-steering.test.mjs tests/adopt-cli.test.mjs tests/steering-injection.test.mjs`
  → `Test Files 3 passed (3)`，`Tests 290 passed (290)`。把 `aab316c` 的测试文件放进 `61a8ae1` 代码（`m61`）跑
  `-t 'the rules file is opt-in'` → `5 failed | 2 passed`（见"其他观察"）。

## 汇总

| 级别 | 数量 | 其中本提交引入 |
|---|---|---|
| P1 | 0 | 0 |
| P2 | 1 | 1 |
| P3 | 5 | 3 |

| 声明 | 结论 |
|---|---|
| C1 变量未设时任何会话都不写规则文件、不建 `.claude` / `.claude/rules`、不加 exclude 行 | HELD（20 个默认模式状态、43 次 aab316c 会话后观测 + v6.21.0 升级 2 种；只有规则文件本来就带块时才刷新它，属 C3 设计） |
| C2 变量未设、AGENTS.md 被遮蔽时每个会话"加载带块文件"与"注入"恰好其一 | HELD（28 个状态的全部默认模式会话 0 个 `BOTH` / 0 个 `NEITHER`；"加载"按磁盘与背景事实推算，未跑真实 Claude Code） |
| C3 带块的规则文件在变量未设时仍是渠道，刷新，四种拒写照旧 | HELD（7 个状态的文件与注入结果与 `61a8ae1` 逐字一致；刷新后字节相同；冻结时不动） |
| C4 `--status` 与一次性提示在两种模式下与下一个会话一致 | FALSIFIED（F1、F2；变量设为 1 时与 `61a8ae1` 逐字一致） |
| C5 用户文本不说也不暗示规则文件是默认 | HELD（按字面）；但"正确描述 opt-in / 默认"有 F3（本提交引入）和 F5（既有） |
| C6 变量设为 1 时行为与 `61a8ae1` 相同 | HELD（28 个状态的会话结果、67 行 `local:`、全部提示、文件状态逐字节相同） |
| C7 变量未设时 AGENTS.md 仓库的行为与 `b9e4fbe` 相同，CHANGELOG 列出的修复除外 | HELD（会话行为的差别只有已列出的两类修复；`--status` 的 `✗ removed` 属已列出的改动，但它在这里说的不对，归 F2） |

## 发现

### F1 [P2] 变量未设时，`--status` 和一次性提示在规则文件即使开了变量也写不了的状态下，仍告诉用户"设 `CLAUDE_MEM_RULES_STEERING=1` 就写规则文件"（本提交引入）

- 位置：`lib/local-steering.mjs:864`
  `if (!rulesSteeringOn() && readBlockSafe(p, slug).body === null) return 'off';` 排在 symlink / tracked / foreign /
  npm-publishable 之前，而 `planLocalSteering`（`:818`）在拿到 `'off'` 后也不再看 `excludeWouldFail`；`writeRulesSteering`
  的 `removed` 检查（`:911`）同样被它挡在后面。于是这些真实拒写原因都被 `'off'` 盖住，`adopt-cli.mjs:646-650` 的 `rulesWhy('off')`
  （经 `:616`、`:633`）和 `hook.mjs:2780-2781` 的提示都无条件给出这个变量。
- 与合同、文档的冲突：README.md:170 / README.zh-CN.md:157 写的是 AGENTS.md 旁的提示"each only where it works / 只给出在这里行得通的"
  做法；`61a8ae1` 在同样状态下的 `--status` 和提示都说明了真实原因（`cannot be written here: npm publish could ship it…` 等）。
- 受影响状态（`advice.mjs`，每个状态先在变量未设时取 `--status` 和首个会话提示，再设变量跑一个会话，看规则文件是否出现）：

  | 状态 | 未设：`--status` | 未设：提示 | 设为 1 后的会话 | 设为 1 后 `--status` 说的真实原因 |
  |---|---|---|---|---|
  | npm 包根（非 private、无 `files`） | `written only with CLAUDE_MEM_RULES_STEERING=1` | 给出变量 | 注入，规则文件未写 | `npm publish could ship it from this package root` |
  | `.gitignore` 有 `!.claude/rules/claude-mem-lite.md` | 同上 | 给出变量 | 注入，未写 | `git would not ignore it` |
  | `.claude` 是符号链接 | 同上 | 给出变量 | 注入，未写 | `.claude, .claude/rules or the file is a symbolic link` |
  | 用户自己的同名规则文件（无块） | 同上 | 给出变量 | 注入，未写 | `a file of that name, without the block, is already there` |
  | git 跟踪的同名文件（无块） | 同上 | 给出变量 | 注入，未写 | `git tracks a file of that name` |
  | 插件写过的规则文件被用户删掉 | `✗ removed…`（见 F2） | 给出变量 | 注入，未写 | `✗ removed…` |
  | 插件写过的 `CLAUDE.local.md` 被用户删掉，之后加了 AGENTS.md | `✗ removed…` | 给出变量 | 注入，未写 | `✗ removed…` |
  | 对照：普通 AGENTS.md 仓库 | 同上 | 给出变量 | **规则文件已写**，规则文件提示 | `— none yet: the next session writes …/.claude/rules/claude-mem-lite.md` |

- 复现（npm 包根；`T=<aab316c 私有副本>`）：

  ```bash
  S=$(mktemp -d /var/tmp/r4sb.XXXXXX)
  export HOME=$S/home CLAUDE_CONFIG_DIR=$S/home/.claude CLAUDE_MEM_DIR=$S/data CLAUDE_MEM_SKIP_UPDATE=1 CLAUDE_MEM_SKIP_MAINTAIN=1
  mkdir -p $CLAUDE_CONFIG_DIR; unset CLAUDE_MEM_RULES_STEERING MEM_NO_AUTO_ADOPT CLAUDE_PROJECT_DIR
  R=$S/w/app; mkdir -p $R; cd $R; git init -q; echo '# agents' > AGENTS.md
  echo '{"name":"x","version":"1.0.0"}' > package.json; git add -A; git -c user.email=t@t -c user.name=t commit -qm init
  hk(){ printf '{"session_id":"s%s","source":"startup","cwd":"%s"}' $RANDOM "$R" | env "$@" CLAUDE_PROJECT_DIR="$R" node $T/hook.mjs session-start; }
  CLAUDE_PROJECT_DIR=$R node $T/cli.mjs adopt --status | grep local:
  #   local:      ✗ not written: Claude Code stops reading $S/w/app/AGENTS.md once a CLAUDE.local.md exists, and
  #   .claude/rules/claude-mem-lite.md is written only with CLAUDE_MEM_RULES_STEERING=1 (steering is injected at session start;
  #   run `claude-mem-lite adopt`, whose CLAUDE.md imports AGENTS.md)
  hk | jq -r .systemMessage
  #   … so memory guidance is not written to CLAUDE.local.md here: it is injected at session start (…). Injected guidance does
  #   not reach subagents; with CLAUDE_MEM_RULES_STEERING=1 it goes to .claude/rules/claude-mem-lite.md instead, which leaves
  #   AGENTS.md loading. Or run /adopt … Shown once per project.
  hk CLAUDE_MEM_RULES_STEERING=1 | grep -c '## claude-mem-lite — persistent memory'   # 1（仍注入）
  ls -a $R                                                                            # . .. .git AGENTS.md package.json（没有 .claude）
  CLAUDE_MEM_RULES_STEERING=1 CLAUDE_PROJECT_DIR=$R node $T/cli.mjs adopt --status | grep local:
  #   … and .claude/rules/claude-mem-lite.md cannot be written here: npm publish could ship it from this package root (…)
  ```

  设了变量的那个会话没有任何新提示（`.agents-md-noted-` 标记已在前一个会话写下），用户只能靠 `--status` 发现建议不成立。
- 期望：`'off'` 只在"开了变量就会写"时出现。例如先按变量已开的口径算拒写（symlink / tracked / foreign / npm-publishable /
  `excludeWouldFail` / 记住的删除），有真实原因就报真实原因、不提变量；全无时才说"只在 `CLAUDE_MEM_RULES_STEERING=1` 时写"。
  提示同理（`silentAutoAdopt` 把"开了能否写"一并带给 `noteAgentsMdOnce`）。写入路径本身不受影响：变量未设时照样不写。
- 为什么是 P2：两个面（一次性提示无法事后更正）、7 种状态，其中"非 private、无 `files` 的 npm 包根 + AGENTS.md"是常见的开源
  JS 库形态；违反的是前几轮刚确立、README 写明的"只给出在这里行得通的做法"。后果是用户白设一个全局变量，没有文件或数据损失。

### F2 [P3] 默认模式下"记住的删除"状态：`--status` 说 `✗ removed … after adopt --enable the next session may write it again`，但 `--enable` 之后下一个会话什么也不写；同一状态下提示说的是"变量没开"（本提交引入）

- 位置：`adopt-cli.mjs:602-603`，`localSteeringRemembered(root)` 在 `planLocalSteering` 之前判断；写入路径里 `'off'`
  （`lib/local-steering.mjs:864`）先于 `removed`（`:911`）返回。`61a8ae1` 里 `--enable` 后确实会写规则文件，所以那时这句成立；
  `b9e4fbe` 在同一状态下的 `--status` 是 `✗ not written: Claude Code stops reading …AGENTS.md…`（与下一个会话一致）。
- 复现（骨架见"证据环境"，`T=<aab316c 私有副本>`）：

  ```bash
  R=$S/w/app; mkrepo $R; agents $R                       # 已跟踪的 AGENTS.md
  hk CLAUDE_MEM_RULES_STEERING=1 >/dev/null              # 写出规则文件
  rm $R/.claude/rules/claude-mem-lite.md                 # 用户删掉；之后变量不再设
  st $R   # local: ✗ removed: deleted by you or unadopt, so it is not written again (steering is injected at session start);
          #        after `claude-mem-lite adopt --enable` the next session may write it again
  (cd $R && CLAUDE_PROJECT_DIR=$R node $T/cli.mjs adopt --enable)
  st $R   # local: ✗ not written: … .claude/rules/claude-mem-lite.md is written only with CLAUDE_MEM_RULES_STEERING=1 (…)
  hk      # inject=1；规则文件、CLAUDE.local.md 都不存在
  ```

  另一条进入路径：v6.21.0 写过 `CLAUDE.local.md`、用户删掉、之后仓库加了 AGENTS.md——矩阵状态 R 两个会话的 `--status` 都是
  `✗ removed …`，而首个会话的提示是 `'off'` 版本（"…with CLAUDE_MEM_RULES_STEERING=1 it goes to …"），两个面互相矛盾。
- 期望：默认模式下、`shadowedAgentsMd` 成立时，`--status` 说出真实结果（变量没开 → 注入；`--enable` 不改变这一点），或者把
  "may write it again" 限定在变量已开时。CHANGELOG `## Unreleased` 关于 `✗ removed` 的描述（"after … --enable the next session
  may write it again"）也要随之限定。

### F3 [P3] README 两处把 npm 包根的 opt-in 结果说成无条件"移到规则文件"（本提交引入）

- 位置：README.md:170 "(a publishable npm package root does not keep `CLAUDE.local.md`: … in a project whose `AGENTS.md` it would
  switch off, the block comes out and is injected, or moves to the rules file with `CLAUDE_MEM_RULES_STEERING=1`)"；
  README.zh-CN.md:157 "…托管块会被移除、改为注入，设了 `CLAUDE_MEM_RULES_STEERING=1` 时移到 rules 文件"。
  `61a8ae1` 的原文是 "moves to the rules file where that can be written, and is injected otherwise"，本提交改写时丢了限定。
- 实测：矩阵状态 X（v6.21.0 式 `CLAUDE.local.md` 带块 → 加 AGENTS.md → 根变成非 private、无 `files` 的 npm 包），变量设为 1：
  会话后 `local=absent rules=absent .claude=no`，下一个会话注入；`--status` 说 `cannot be written here: npm publish could ship it`。
  只有 `files` 列表或 `.npmignore` 把 `.claude` 排除时规则文件才写得出来。
- 期望：恢复"where that can be written / 写得了时"的限定。

### F4 [P3] 代码注释仍把规则文件写成 AGENTS.md 旁的默认渠道（本提交使其过时；非用户可见）

- `lib/local-steering.mjs:667-668`（writeLocalSteering 文档："or, where that file would switch off an AGENTS.md …, in RULES_MD"）、
  `:704-706`（"or wherever CLAUDE.local.md would switch an AGENTS.md off"）；`adopt-cli.mjs:298-300`（silentAutoAdopt 步骤 4：
  "or in <top-level>/.claude/rules/claude-mem-lite.md where CLAUDE.local.md would switch off an AGENTS.md"）、`:305`；
  `hook.mjs:2739-2741`（"where CLAUDE.local.md would switch off the repository's AGENTS.md, the block goes to
  .claude/rules/claude-mem-lite.md instead"）。
- `lib/local-steering.mjs:873-874` 写 "unless CLAUDE_MEM_RULES_STEERING=1 or the file carries the block already (rulesSteeringOn)"，
  但 `rulesSteeringOn()`（`:849-851`）只看环境变量，"已带块"是 `rulesRefusal` 里另一半条件。
- 期望：注释改为"变量开启时，或规则文件已带块时"。

### F5 [P3] 命令文档和 README 的"`--enable` 让插件重新写本地块""下一个会话写本地文件"在 AGENTS.md 旁的默认模式下不成立（既有，`b9e4fbe` 起；`61a8ae1` 时成立，本提交恢复默认后再次不成立）

- 位置：`commands/adopt.md:54`（"`--enable` also lets the plugin write a removed local block again"）、`:58-61`（"/unadopt … The next
  session writes a local file if the plugin never created one in this repository"）；`commands/unadopt.md:44-48`（"`adopt --enable`
  lets it write the file again … A project whose `CLAUDE.md` block you removed gets a local file on the next session"）；README.md:172 /
  README.zh-CN.md:159（"…is not written back — the text is injected instead — until `claude-mem-lite adopt --enable`"）、README.md:631-632 /
  README.zh-CN.md:515-516（"`adopt --enable` re-arms it / 可重新启用"）。
- 实测：默认模式、AGENTS.md 仓库，手动删除规则文件之后再 `adopt --enable`，下一个会话不写任何文件、继续注入（F2 复现的后半段）；
  状态 A（AGENTS.md 仓库、从未写过本地文件）的会话也不写任何文件。`unadopt` 删掉只有托管块的 `CLAUDE.md` 之后仓库应处于状态 A，
  这一步本轮没有实测；`CLAUDE.md` 里还有用户自己的内容时 `shadowedAgentsMd` 为 null（读代码：`lib/local-steering.mjs:308`），会写 `CLAUDE.local.md`，那句话在那里成立。
- `b9e4fbe` 的同几句（当时写作 `CLAUDE.local.md`）在 AGENTS.md 旁同样不成立，所以算既有；`commands/adopt.md:16-19` 已正确写出例外，
  其余几句没有跟上。
- 期望：加上"在 `CLAUDE.local.md` 会遮蔽 AGENTS.md 的仓库里，变量未设时不写文件"的例外。

### F6 [P3] 用户自己的 `CLAUDE.local.md` 已经遮蔽 AGENTS.md 时，插件仍按"会遮蔽"处理：改为注入，提示里关于 AGENTS.md 的两句都不成立（既有，`b9e4fbe` 起；本提交新提示沿用）

- 位置：`lib/local-steering.mjs:307-312` `shadowedAgentsMd` 只把根目录的用户 `CLAUDE.md` / `.claude/CLAUDE.md` 当作"已经关掉
  AGENTS.md"，不看用户自己的 `CLAUDE.local.md`；`hook.mjs:2776`、`:2781` 的提示。
- 实测：
  - 矩阵状态 C（用户自己的 `CLAUDE.local.md`，无块 + 已跟踪 AGENTS.md），默认模式：每个会话注入。提示说 "Claude Code reads …/AGENTS.md
    as this project's instructions"（按背景事实，用户的 `CLAUDE.local.md` 在，它并没有被读），又说 "with CLAUDE_MEM_RULES_STEERING=1
    it goes to .claude/rules/claude-mem-lite.md instead, which leaves AGENTS.md loading"（开了变量后规则文件会写，但 AGENTS.md 仍被
    用户的文件遮蔽）。
  - 真实升级（`v6.21.0` → `aab316c`，用户自己的 `CLAUDE.local.md`）：v6.21.0 把块写进用户文件（文件渠道）；升级后第 1 个会话移除块
    （`git status` 重新出现 `?? CLAUDE.local.md`，符合 CHANGELOG），第 2 个会话起注入。用户失去文件渠道，AGENTS.md 也没有因此加载。
- `b9e4fbe` 在状态 C 下同样注入（矩阵 `b9e-off` 状态 C），CHANGELOG 也写明了"your `CLAUDE.local.md` itself still stops Claude Code
  reading `AGENTS.md`"，所以这是既有的设计取舍；只是本提交新写的 `'off'` 提示把"which leaves AGENTS.md loading"无条件说了出来。
- 期望（二选一，交作者定）：`shadowedAgentsMd` 把根目录里不止有插件行的 `CLAUDE.local.md` 也当作"已经关掉"（那里写块不会额外遮蔽什么）；
  或至少让提示在这种状态下不说 AGENTS.md 会被读 / 会继续加载。

## 声明逐条证据

### C1 — HELD

- 默认模式 20 个不含"(on)"会话的状态（A、B、C、D、J、K、L、M、N、O、P、Q、R、S、V、W、X、Y、ZA、ZC），共 43 次 aab316c 会话后观测：没有一次
  出现规则文件、新建 `.claude` / `.claude/rules`，或 `info/exclude` 里出现 `.claude/rules/claude-mem-lite.md` 行。M、V 的 `.claude`
  和 W 的用户规则文件是状态本身预置的，会话后 `.claude/rules` 仍不存在（M、V）、exclude 仍为空（W）。
- v6.21.0 升级两种（插件自建 / 用户自己的 `CLAUDE.local.md`）各 2 个会话：`.claude` 均为 no，exclude 为空。
- 代码路径：变量未设时 `writeRulesSteering` 只有 `rulesRefusal` 返回 `null` 才会走到 `ensureExcluded(root, RULES_MD)` / `mkdirSync`
  （`lib/local-steering.mjs:899-929`），而 `:864` 让"无块 + 未开变量"必然返回 `'off'`。`planLocalSteering` 只读不写。
- 按字面，C1 与 C3 冲突：规则文件已带块时会话会刷新它，exclude 行被手工删掉后也会被加回（实测 `grep -c` 从 0 变 1）。这是 C3 要求
  的行为，本报告按"规则文件尚未带块的状态"理解 C1。

### C2 — HELD

- 28 个状态里 `aab316c` 默认模式的全部会话：0 个 `BOTH`、0 个 `NEITHER`。包括：v6.21.0 式 `CLAUDE.local.md` 带块后加 AGENTS.md（移除块的
  那个会话已加载文件、不注入；之后每个会话注入）、用户自己的 `CLAUDE.local.md` 带块、两个 worktree 都带块（共享 exclude 行在第二个
  worktree 移除后才删）、`CLAUDE_MEM_NO_TEMPLATE_REFRESH=1`、子目录会话、根目录上方的 AGENTS.md、`.claude/AGENTS.md`、未跟踪的子目录
  AGENTS.md 来回切换（CHANGELOG"Not covered"所述，每个会话仍恰好其一）、`CLAUDE.local.md` 是目录 / 被跟踪 / 是符号链接、记住的删除、
  npm 包根、设置 `claude-md-and-agents-md`、规则文件已带块后再删掉 AGENTS.md。
- 状态 U（规则文件与 `CLAUDE.local.md` 同时带块）在一个会话里加载两份文件、不注入；这不是"文件 + 注入"，且与 `61a8ae1` 逐字相同。
- 局限：是否"加载"按磁盘上的文件和背景事实推算，没有用真实 Claude Code 验证（见 NOT CHECKED）。

### C3 — HELD

- 状态 E、F、G、H、I、U、ZB（先在变量为 1 时写出规则文件，之后变量未设）：会话结果和文件状态与 `61a8ae1` 逐字一致（`cmp` 只在规则
  文件被取出之后的 `--status` / 提示文本处不同，那时已不再是"带块的规则文件"）。
  - E：变量未设后规则文件继续被加载，不注入。
  - F（`.gitignore` 反选）、G（变成 npm 包根）：该会话移除规则文件、不注入（已加载），下一个会话注入。
  - H（被跟踪）、I（`.claude` 变成符号链接）：保留不动，不注入。
  - ZB（之后删掉 AGENTS.md）：规则文件仍是渠道。
- 刷新：把规则文件里的块正文改成旧文本，变量未设、`CLAUDE_MEM_NO_TEMPLATE_REFRESH=1` 时保持旧文本；去掉冻结后恢复，`sha256` 与
  原文件相同。exclude 行被手工删掉后，下一个会话加回。

### C4 — FALSIFIED

- 变量为 1：与 `61a8ae1` 逐字一致（见 C6）。
- 变量未设：F1（7 种状态里提示和 `--status` 给出一个无效的做法）、F2（记住的删除状态下 `--status` 的承诺不成立，且与提示矛盾）。
- 其余默认模式状态里，`--status` 说的"注入 / 下一个会话移除 / 下一个会话写 `CLAUDE.local.md`"都与下一个会话一致（矩阵逐会话对照）。

### C5 — HELD（按字面）

- 逐句检查了 CHANGELOG `## Unreleased`、两份 README 改动段及环境变量表、`commands/adopt.md`、`commands/unadopt.md`、`hook.mjs` 的
  提示、`adopt-cli.mjs` 的状态行；没有一句说或暗示规则文件是默认渠道。
- 合同里"正确描述 opt-in 和默认"另有 F3（本提交引入）、F5（既有）和 F1 中 README"只给出行得通的做法"与提示不符。
- CHANGELOG 引用的 A/B 数字与 `docs/audits/20261006-d212-ab.md` 一致：1/12 对 0/12、Fisher p=1.00；4 条对 0 条、88 个会话（每组 44）；
  S2–S3 子代理 9/9，inject 组 0/14。

### C6 — HELD

- 28 个状态在 `aab316c`（变量为 1）与 `61a8ae1` 上的完整输出（每个会话的加载 / 注入判定、67 行 `local:`、全部提示、文件状态）
  `cmp` 结果为 0（逐字节相同）。
- 代码：变量为 1 时 `:864` 不触发；`RULES_REFUSAL_TEXT.off`、`rulesWhy` 的非 `'off'` 分支、提示的非 `'off'` 分支文本与 `61a8ae1` 相同。
- `aab316c` 的 D#212 测试在变量为 1 下运行，3 个测试文件 290 个用例通过。

### C7 — HELD

- 默认模式与 `b9e4fbe` 在不含"(on)"会话的状态里，会话后的文件状态完全相同；会话结果只有两类差别，CHANGELOG 都列了：
  - 9 个会话 `BOTH` → 只加载文件（"The session that takes a block out … gets no injected copy on top"）。
  - 1 个会话 `NEITHER` → 注入（`CLAUDE.local.md` 是目录，"Smaller fixes around the local file"）。
- 提示与 `--status` 的文本改动属已列出的 `adopt --status` 改动；其中 `✗ removed` 在 AGENTS.md 旁说得不对，归 F2。

## 其他观察（不计入发现）

- 提交说明写 "7 cases: 4 failed before the switch"。把新测试放到 `61a8ae1` 代码上跑，结果是 5 个失败（注入且不写文件、旧块移除且
  该会话不注入、两条 `--status`、一条提示），2 个通过（无 AGENTS.md 写 `CLAUDE.local.md`、规则文件写后保持）。"before the switch"
  也许指作者工作中的某个中间状态；与 C1–C7 无关。
- `.agents-md-noted-` 标记两种模式共用：先看到 `'off'` 提示、后来开变量但规则文件被拒的用户不会再得到提示（F1 的复现里可以看到）。
  这是"每个项目一次"的既定设计。
- `v6.21.0` 不含 `.agents-md-noted-` 标记（`hook-shared.mjs` 中 0 处），`b9e4fbe` 未发布，所以升级用户的第一次 AGENTS.md 提示就是本提交的
  `'off'` 版本。

## NOT CHECKED

- 真实 Claude Code 的加载行为：C2 的"加载"、F6 中"AGENTS.md 没有被读"、规则文件在子目录会话 / 符号链接后是否加载，都依赖背景事实，
  本轮没有启动 Claude Code 复核。
- 变量来源不一致：钩子读 Claude Code 进程的环境（若用户把变量写在 `settings.json` 的 `env` 里），而在终端里跑的
  `claude-mem-lite adopt --status` 读 shell 的环境，两者可能不同，`--status` 会说出与下一个会话不同的结论。`MEM_NO_AUTO_ADOPT`
  有同样的结构。没有验证 Claude Code 是否把 `settings.json` 的 `env` 传给钩子和 `!` 命令，因此不作为发现。
- 两个会话同时启动（并发）、Windows / macOS、大小写不敏感文件系统、bind mount。
- 全量测试、覆盖率、eslint、knip、`format:check`；只跑了 3 个测试文件。
- `unadopt --all`、`adopt --disable`、`unadopt --dry-run` 在默认模式下的输出文本。
- `MEM_NO_ADOPT_HINT=1`、`CLAUDE_MEM_RULES_STEERING` 取 `1` 以外的值（代码只认 `'1'`，与 README"Booleans accept `1`"一致，未实测）。
- 链接 worktree 中一个带规则文件、另一个没有时的组合（只测了两个都带 `CLAUDE.local.md` 块的情况）。

## 附表：矩阵状态

A 新 AGENTS.md 仓库 · B 旧版本写过 `CLAUDE.local.md` 后加 AGENTS.md · C 用户自己的 `CLAUDE.local.md`（无块）· D 用户自己的
`CLAUDE.local.md` 被旧版本插入块 · E 变量为 1 写规则文件后不再设 · F E + `.gitignore` 反选 · G E + 变成 npm 包根 · H E + 规则文件
被跟踪 · I E + `.claude` 改为符号链接 · J 子目录会话 + 根目录已跟踪 AGENTS.md · K 未跟踪的子目录 AGENTS.md，根 / 子目录交替 ·
L 仓库上层的 AGENTS.md · M `.claude/AGENTS.md` · N 两个 worktree 都有旧块 · O 被跟踪且带块的 `CLAUDE.local.md` · P 指向带块文件
的 `CLAUDE.local.md` 符号链接 · Q `CLAUDE.local.md` 是目录 · R 记住的删除 · S 冻结模板 + 旧块 · U 规则文件与 `CLAUDE.local.md`
都带块 · V 已有被跟踪的 `.claude/settings.json` · W 用户自己的同名规则文件 · X 旧块 + 变成 npm 包根 · Y 根目录旧块 + 子目录会话 ·
Z 规则文件被用户删掉 · ZA 设置为 `claude-md-and-agents-md` · ZB 规则文件写后删掉 AGENTS.md · ZC 无 AGENTS.md 的对照。

## 清理

审查结束时删除了 `/var/tmp/r4.UkTe0t`（全部私有副本）、本轮建的全部 `/var/tmp/r4sb.*` 沙箱，以及本轮 vitest 运行在 `/tmp`
留下的 3 个 SSR 缓存目录（时间戳与本轮三次 vitest 运行一致）。`/tmp/rrev-*` 不是本轮创建的，未动。
