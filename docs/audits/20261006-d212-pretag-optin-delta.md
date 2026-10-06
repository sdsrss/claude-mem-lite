# D#212 rules 文件 opt-in：pre-tag 修复提交的增量审查（219abd5）

- 审查对象：`219abd5`（"fix(adopt): repairs from the pre-tag review of the rules-file opt-in"），对照树 `aab316c`。
- 审查人：未参与该提交的编写。日期：2026-10-06。
- 方法：两棵树分别 `git archive` 到 `/var/tmp/r5.*`（`node_modules` 软链），每个探针用全新的
  `HOME` / `CLAUDE_CONFIG_DIR` / `CLAUDE_MEM_DIR`（`/var/tmp/r5sb.*` 下），unset 掉继承的
  `CLAUDE_MEM_RULES_STEERING` / `MEM_NO_AUTO_ADOPT` / `CLAUDE_PROJECT_DIR`。会话一律走真实 hook：
  `printf '{"session_id":"s1","source":"startup","cwd":"%s"}' "$R" | CLAUDE_PROJECT_DIR="$R" node <tree>/hook.mjs session-start`，
  "注入" = stdout 的 `hookSpecificOutput.additionalContext` 含引导块，"提示" = `systemMessage`；
  `adopt --status` / `adopt --enable` 走 `node <tree>/cli.mjs`。仓库本身未改动（本文件除外）。
- 该提交自带的 `tests/local-steering.test.mjs` 在 219abd5 树上：229 passed（1 file）。

## 结论一览

| 级别 | 数量 |
|------|------|
| P1 | 0 |
| P2 | 0 |
| P3 | 5（其中 2 条由 219abd5 引入，3 条在 aab316c 已存在） |

| 声明 | 判定 |
|------|------|
| D1 | **FALSIFIED**（F-1、F-2、F-3）。F1 修复本身对非 removed 状态成立：symlink / tracked / foreign / npm / negation 5 个状态里两个面都不再提开关 |
| D2 | **HELD**（17 个状态，开关 unset，0 处新建）；两条范围说明见 D2 一节 |
| D3 | **HELD**（14 种 CLAUDE.local.md 形态 × 2 树 × 2 模式 × 3 会话 = 168 次观测，新规则 0 次"两份"/"一份都没有"）；另有一条与新规则无关的既有"两份"（F-5） |
| D4 | **FALSIFIED**（F-4：用户自己的、还没有托管块的 `CLAUDE.local.md` 旁边有 `AGENTS.md` 时，开关打开也写进这个文件而不是 rules 文件，CHANGELOG 没写） |
| D5 | **部分 FALSIFIED**（F-4 的 CHANGELOG 例外清单；F-1 的 `--status` 文本）。其余改动的文本（README 两份、`commands/adopt.md`、`commands/unadopt.md`、两种模式下的提示）与观测一致 |

## Findings

### F-1（P3，219abd5 引入）`--status` 的 `✗ removed` 行在 rules 文件开了开关也写不了的状态下仍然提 `CLAUDE_MEM_RULES_STEERING=1` + `adopt --enable`

- 位置：`adopt-cli.mjs:605-611`。`offHere = !rulesSteeringOn() && planLocalSteering(...).file === RULES_MD`
  只看 `plan.file`，不看 `plan.refusal`。`plan.file === RULES_MD` 在 `.claude` 是链接、文件被跟踪、
  同名外来文件、npm 会打包、`.gitignore` 反向规则这些状态下同样成立。
- 复现（219abd5，开关 unset）：

```
R=$SB/repos/f1; mkdir -p $R; cd $R; git init -q; echo x > README.md; git add -A; git commit -qm i
ss $R >/dev/null                         # 写出 CLAUDE.local.md，并记住"创建过"
rm CLAUDE.local.md                       # 用户删掉
echo A > AGENTS.md; git add AGENTS.md; git commit -qm a
mkdir -p $SB/dot; ln -s $SB/dot .claude  # dotfiles 链接的 .claude
node $T/new/cli.mjs adopt --status | grep local:
#   local: ✗ removed: deleted by you or unadopt, so it is not written again (steering is injected at
#   session start); beside this AGENTS.md a file comes back only with CLAUDE_MEM_RULES_STEERING=1 and
#   then `claude-mem-lite adopt --enable`
export CLAUDE_MEM_RULES_STEERING=1; node $T/new/cli.mjs adopt --enable   # 照做
ss $R                                    # INJECT=1，.claude/rules/claude-mem-lite.md 不存在
node $T/new/cli.mjs adopt --status | grep local:
#   local: ✗ not written: ... .claude/rules/claude-mem-lite.md cannot be written here: .claude,
#   .claude/rules or the file is a symbolic link ...
```

  （`ss` = 上面方法里的 hook 调用。）同一状态下开关 unset 的会话提示**不**提开关（`detail` 是
  `symlink`），两个面说法不一致。
- 矩阵：照 `--status` 做之后仍不写文件的状态 —— `rm-symlink`、`rm-npm`（`.npmignore` 只列
  `CLAUDE.local.md`、`package.json` 非 private）、`rm-negation`（见 F-2）。tracked / foreign 走同一
  分支，未单独跑。`rm-plain` 照做后写出（WRITTEN），符合预期。
- aab316c 同状态：`--status` 是 "after `claude-mem-lite adopt --enable` the next session may write it
  again"（同样写不出来，但没有提开关）。提开关的文本是 F2 修复新加的。
- 文本小问题：同一行写 "beside this AGENTS.md"，但这一行没有说出是哪个 `AGENTS.md`
  （子目录里被跟踪的、上层目录里的都会走到这里）。
- 期望：只在 `plan.refusal === 'off'` 时提开关 + `--enable`；其他 refusal 说出原因（`rulesWhy`），
  不提开关。

### F-2（P3，aab316c 已有同类，219abd5 换了措辞但没修到）removed 状态先于"exclude 会失败"的预测，提示提开关 + `--enable`

- 位置：`lib/local-steering.mjs:922`（`readState` → `refuse('removed')`）排在 `:927-928`
  （开关关时 `excludeWouldFail ? 'exclude-failed' : 'off'`）之前；`hook.mjs:2794-2797` 对
  `detail === 'removed'` 提 "With CLAUDE_MEM_RULES_STEERING=1 and then `claude-mem-lite adopt --enable`"。
- 复现（219abd5，开关 unset）：同 F-1 的前四行（不建链接），再加

```
printf '.claude/*\n!.claude/rules/\n!.claude/rules/**\n' > .gitignore; git add -A; git commit -qm g
ss $R
#   NOTICE: ... Injected guidance does not reach subagents. With CLAUDE_MEM_RULES_STEERING=1 and then
#   `claude-mem-lite adopt --enable` it goes to .claude/rules/claude-mem-lite.md, which leaves AGENTS.md
#   loading (a local file you or unadopt removed is not written back until then). ...
export CLAUDE_MEM_RULES_STEERING=1; node $T/new/cli.mjs adopt --enable
ss $R                                    # INJECT=1，rules 文件不存在
node $T/new/cli.mjs adopt --status | grep local:
#   ... cannot be written here: git would not ignore it ...
```

  同状态 `--status` 也提开关（F-1）。
- aab316c 同状态：提示是 "with CLAUDE_MEM_RULES_STEERING=1 it goes to .claude/rules/claude-mem-lite.md
  instead"，照做同样写不出 —— 所以不是 219abd5 引入的，但提交说明里 F1 "'off' is now the last reason"
  在 removed 这条路径上不成立：removed 仍然遮住 exclude 失败。
- 期望：开关关时，`removed` 之前（或在 `removed` 分支里）先做 `excludeWouldFail` 预测；会失败就给
  `exclude-failed`，不提开关。

### F-3（P3，aab316c 已有，非 219abd5 引入）写入时才发生的失败没有被预测，两个面都提开关

- 位置：`planLocalSteering`（`lib/local-steering.mjs:826-831`）和 `writeRulesSteering` 开关关时的
  分支（`:927-928`）只预测 `rulesRefusal` 和 `excludeWouldFail`；`mkdirSync` / `appendFileSync`
  失败要到开关打开后的写入才出现（`write-failed` / `exclude-failed`）。
- 复现（两棵树结果相同，开关 unset 时 `--status` 和提示都提开关；`export CLAUDE_MEM_RULES_STEERING=1`
  后下一会话 INJECT=1、rules 文件不存在）：
  - `.claude` 是普通文件：`echo x > .claude`
  - `.claude` 目录不可写：`mkdir .claude; chmod 555 .claude`
  - `.git/info/exclude` 不可写：`chmod 444 .git/info/exclude`
- 影响：照提示做之后，开关打开时 `--status` 对三种都说 "— none yet: the next session writes
  …/.claude/rules/claude-mem-lite.md"，会话失败（INJECT=1、无文件）之后再查还是这一句，用户要靠
  "一直没出现文件"自己发现。三种都是少见的仓库状态。
- 期望：要么在预测里加上可写性检查（`.claude`、`.claude/rules` 是目录或不存在，且最近的已存在祖先
  可写；info/exclude 可写），要么提示里不把开关说成充分条件。

### F-4（P3，219abd5 引入）用户自己的、还没有托管块的 `CLAUDE.local.md` 旁边有 `AGENTS.md`：两种模式都把块写进这个文件，CHANGELOG 只说"块留在里面"

- 位置：`lib/local-steering.mjs:314-315`（新规则：`CLAUDE.local.md` 存在且不只有插件的行 → `null`），
  于是 `writeLocalSteering` 走普通的 `CLAUDE.local.md` 写入分支（`:716` 之后）。
  CHANGELOG `## Unreleased`：`:16` "Two exceptions, where `CLAUDE.local.md` is written as before"
  只列了用户的 `CLAUDE.md` / `.claude/CLAUDE.md` 和设置项；`:22` "There auto-adopt writes no file"；
  `:27` "there the block stays, as in 6.21.0"；`:48` "A `CLAUDE.local.md` with lines of your own keeps
  the block"。描述的都是**已有**块的情形。
- 复现（`echo "my own notes" > CLAUDE.local.md`，`AGENTS.md` 已提交，跑两次会话）：

```
[aab316c, unset] s1 INJECT=1  s2 INJECT=1  CLAUDE.local.md 无块；exclude 无条目；git status: ?? CLAUDE.local.md
[aab316c, =1]    s1 INJECT=1  s2 INJECT=0  rules 文件写出；CLAUDE.local.md 原样；git status: ?? CLAUDE.local.md
[219abd5, unset] s1 INJECT=1  s2 INJECT=0  CLAUDE.local.md 被追加托管块；exclude 加 CLAUDE.local.md；git status 变空
[219abd5, =1]    s1 INJECT=1  s2 INJECT=0  同上，rules 文件不写
```

  `@AGENTS.md` 一行的用户文件（U6）结果相同。
- 判断：行为本身与 F6 的理由一致（`AGENTS.md` 已经因为这个文件不被读取，写进它不会让任何东西失效，
  且与 6.21.0 对同一状态的做法相同），新加的测试 `tests/local-steering.test.mjs:2535`
  就断言了这个写入（测试名却叫 "keeps the block"）。问题在于：(1) CHANGELOG 的例外清单和
  "writes no file" 对这个状态不成立；(2) 开关打开时，与 aab316c 相比的差别不止 CHANGELOG 写的
  "keeps the block"——用户明确选了 rules 文件，得到的是自己的 `CLAUDE.local.md` 被改写、并从
  `git status` 里消失（D4）。README 里 "Where Claude Code reads an `AGENTS.md` … nothing is written"
  在这个状态下不算错（这里 Claude Code 本来就不读 `AGENTS.md`）。
- 期望：CHANGELOG 把"根目录有你自己的 `CLAUDE.local.md`"列为第三个例外（写进它，加 exclude，
  开关打开也一样），或者改代码让这个状态不写；测试名与断言对齐。

### F-5（P3，aab316c 已有，非 219abd5 引入）刷新失败时 `write-failed` 报 `present: false`，会话既加载了旧块又被注入

- 位置：`lib/local-steering.mjs:951`（`return refuse('write-failed')`，`present` 默认 false）和
  `:754`（`CLAUDE.local.md` 分支同样不带 `present`）。
- 复现（两棵树相同，开关 unset）：rules 文件（先用 `=1` 写出）或 `CLAUDE.local.md` 里的块被改动过
  （模拟模板漂移：`sed -i 's/mem_recall/mem_recall_EDITED/'`），再 `chmod 555` 它所在目录 → 会话开始时
  文件带块（已加载），hook 输出 INJECT=1。四种组合（old/new × rules/local）都是 INJECT=1。
- 影响：插件升级改了模板之后，所在目录不可写的项目每个会话都加载两份引导。与 F6 的新规则无关，
  但落在 D3 想排除的"两份"上，所以记在这里。
- 期望：刷新失败而文件里已有块时报 `present: true`（不再注入）。

## 各声明的证据

### D1

开关 unset，`--status` 与提示是否提开关，照做（`=1`，提到 `--enable` 的再跑 `adopt --enable`）后
下一会话是否写出 rules 文件（219abd5）：

| 状态 | `--status` 提 | 提示提 | 照做后 |
|------|------|------|------|
| plain（只有 `AGENTS.md`） | 是 | 是 | WRITTEN |
| subdir（未跟踪的 `pkg/AGENTS.md`，会话在 `pkg/`） | 是 | 是 | WRITTEN |
| upgrade（6.21.0 写的 `CLAUDE.local.md` + 新 `AGENTS.md`） | 是（⚠ 行） | 否（该会话 present，无提示） | WRITTEN |
| rm-plain（删过 + `AGENTS.md`） | 是（+enable） | 是（+enable） | WRITTEN |
| symlink / tracked / foreign / npm / negation | 否 | 否 | — |
| rm-symlink | **是**（+enable） | 否 | NOT-WRITTEN（F-1） |
| rm-npm | **是**（+enable） | 否 | NOT-WRITTEN（F-1） |
| rm-negation | **是**（+enable） | **是**（+enable） | NOT-WRITTEN（F-1、F-2） |
| `.claude` 是文件 / `.claude` 只读 / exclude 只读 | **是** | **是** | NOT-WRITTEN（F-3） |

aab316c 同一矩阵：symlink / npm / negation / 三种写入失败两个面都提开关；四种 rm-* 只有提示提开关
（`--status` 只提 `--enable`）；以上照做全部 NOT-WRITTEN（rm-plain 在 aab316c 只提开关不提
`--enable`，照做也 NOT-WRITTEN —— 即原 F2）。

### D2

开关 unset，每个状态跑：会话（cwd）×2、会话（根）×1、`adopt --status`、`adopt --enable`、再一次会话；
前后比较 `.claude` / `.claude/rules` / rules 文件是否存在、info/exclude 里 rules 条目数。
17 个状态全部前后一致：plain、`.claude/AGENTS.md`、子目录被跟踪的 `AGENTS.md`、子目录未跟踪的
`AGENTS.md`（会话在子目录）、仓库上层目录的 `AGENTS.md`、已有 `.claude/settings.json`、已有
`.claude/rules/team.md`、upgrade、upgrade + `CLAUDE_MEM_NO_TEMPLATE_REFRESH=1`、upgrade + 用户行、
removed、`.gitignore` 反向规则（新的 exclude-failed 预测路径；info/exclude 字节不变）、反向规则 +
upgrade、`git init --template=`（无 `.git/info/`）、`CLAUDE.local.md` 是目录、用户自己的
`CLAUDE.local.md`、linked worktree（主 worktree 已用 `=1` 写过 rules 文件）。

范围说明（不计为 finding）：
1. rules 文件已带块、其 exclude 条目被手动删掉时，开关 unset 的会话会把 rules 条目加回去
   （两棵树相同：`git status` 从 `?? .claude/` 变空）。这是"带块的 rules 文件在开关 unset 时仍是渠道"
   的一部分，但字面上是"开关 unset 时新增了 rules 条目"。
2. 显式 `adopt` 过的项目（`CLAUDE.md` 带块），删掉 `.claude/` 后，开关 unset 的会话会重建
   `.claude/`（`plugin_claude_mem_lite.md` + `.plugin_claude_mem_lite_state.json`）。v3.13 以来的
   既有行为，与 rules 渠道无关。

### D3

"已加载" 以文件状态近似：会话开始时根目录可读的 `CLAUDE.local.md` 或 rules 文件里有块。
每个状态 × {aab316c, 219abd5} × {unset, =1} × 3 次会话：

U12 只有插件块；U1 用户行 + 块（6.21.0 写进已有文件）；U2 插件创建后用户追加行；U3 用户行无块；
U4 用户行、块被 `unadopt` 删过；U5 空文件；U6 只有 `@AGENTS.md`；U7r 插件的 import 标记 +
`@AGENTS.md` + 块；U7b 只有插件 import 标记 + `@AGENTS.md`；U8 目录；U8b 目录 + 已带块的 rules
文件；U9 `chmod 000`；U10 指向用户文件的链接；U11 被跟踪的用户文件。

168 次观测里 0 次"已加载且注入"、0 次"未加载且未注入"。新规则改变的只有 U1/U2（块留在
`CLAUDE.local.md`，每次会话 L1/I0）和 U3/U6（第一次会话注入、写进文件，之后 L1/I0；见 F-4）。
U8/U9/U10/U11 在 `writeLocalSteering` 里先于 `shadowedAgentsMd` 被拒（`:702-711`），两棵树行为
相同；新规则在这些形态下只改了 `refuse()` 的 `reason` 标签（目录/链接/不可读的 `CLAUDE.local.md` 让
`holdsOnlyOwnLines` 返回 false → `shadowedAgentsMd` 返回 null），且只在 rules 文件已带块的路径上。

观察（不计为 finding，两棵树相同）：U5 空的用户 `CLAUDE.local.md` 被 `holdsOnlyOwnLines` 当成插件的
（剩余内容为空）。开关打开时写出 rules 文件，空的 `CLAUDE.local.md` 还在；按 Claude Code 文档的
"exists" 规则，`AGENTS.md` 仍不被读取，而 rules 提示说 "a rules file leaves it loading"。Claude Code
对空文件的实际处理未核对。

### D4

开关打开时 219abd5 相对 aab316c 的差别，逐处对代码：`rulesRefusal` 去掉的 `'off'` 行、
`writeRulesSteering` 新加的开关关分支、`planLocalSteering` 末尾的 `'off'`、`localSteeringStatus` 的
`offHere`、`noteAgentsMdOnce` 的开关关分支 —— 开关打开时都不生效，提示文本与 aab316c 的非 `off`
分支逐字相同。剩下的只有 `shadowedAgentsMd` 的用户行规则：U1/U2（CHANGELOG 已写）和 U3/U6
（CHANGELOG 未写，F-4）。

### D5

逐段读了 219abd5 改动的 CHANGELOG `## Unreleased`、`README.md`（:170、:172、:620-633、:1079）、
`README.zh-CN.md`（:157、:159、:505-516、:818）、`commands/adopt.md`、`commands/unadopt.md`，以及两种
模式下实际输出的提示和 `--status` 行。不符之处只有 F-4（CHANGELOG 例外清单、"writes no file"）和
F-1（`✗ removed` 行在拒绝状态下的建议、"this AGENTS.md" 未点名）。READMEs 与 commands 的新句子
（"beside an `AGENTS.md` that `CLAUDE.local.md` would switch off, … only with
`CLAUDE_MEM_RULES_STEERING=1`"）是必要条件的说法，与观测一致。

## NOT CHECKED

- 没有跑真实的 Claude Code 会话：哪些文件"被加载"、空的 / 目录形态的 / 不可读的 `CLAUDE.local.md`
  是否让 Claude Code 停读 `AGENTS.md`，都以文件状态近似，未用 canary 核对。
- 全量测试、eslint、`format:check` 没跑；只跑了 `tests/local-steering.test.mjs`（229 passed）。
- tracked / foreign 两种 rules 拒绝与 removed 的组合没有单独跑（代码路径与 rm-symlink 相同）。
- 用户设置 `instructionFiles`（`claude-md-and-agents-md` / `claude-md` / `managed-only`）与新规则的组合。
- 多 worktree 下一个 worktree 是用户行 `CLAUDE.local.md`、另一个是插件块时的共享 exclude。
- 两个会话并发、大小写不敏感文件系统、Windows。
- `unadopt` / `adopt --disable` / `adopt --enable --all` 作用在用户行 `CLAUDE.local.md` + `AGENTS.md` 上的
  完整流程（只在 U4 的构造里跑过一次 `unadopt`）。
- 按要求未读 `docs/audits/20261006-d212-pretag-optin.md`。
