# D#212 发版前缺陷评审（v6.21.0..HEAD）

- 评审对象：`git diff v6.21.0..HEAD`（HEAD = `0b75931`），重点 `lib/local-steering.mjs`、`adopt-cli.mjs`、`claudemd.mjs`、`hook.mjs`（SessionStart 自动 adopt 分派与一次性提示）、`hook-shared.mjs`、`lib/quiet-scope.mjs` 及三份测试。
- 契约：`tasks/specs/d212-rules-steering.md` r2、CHANGELOG `## Unreleased`、code.claude.com/docs/en/memory（2026-10-06 抓取）。
- 评审者不是作者。只报缺陷。
- 探针环境（2026-10-06）：`git archive HEAD` 与 `git archive v6.21.0` 两份私有副本（`node_modules` 符号链接到仓库），`/tmp/d212rev.*` 下的临时仓库，`HOME`、`CLAUDE_CONFIG_DIR`、`CLAUDE_MEM_DIR` 均指向临时目录。node v26.8.1，git 2.53.0，npm 11.19.0。
  "旧版本会话" = v6.21.0 副本的 `silentAutoAdopt`；"会话" = HEAD 副本的 `silentAutoAdopt`；"真实钩子" = `node hook.mjs session-start`（stdin JSON，不设 `MEM_NO_AUTO_ADOPT`）。
- 评审期间工作树出现了别人未提交的改动（`git diff --stat`：8 个文件，+238/−67，包括 `lib/local-steering.mjs` 新增的 `planLocalSteering`、`localMdRefused`，`adopt-cli.mjs`、`hook.mjs`、`CHANGELOG.md`）。本报告的所有结论都针对已提交的 `0b75931`，没有在这些改动上重跑。P2-1、P3-3 可能已部分处理，需要在新树上复核。
- 基线：HEAD 副本中 `tests/local-steering.test.mjs`、`tests/adopt-cli.test.mjs`、`tests/steering-injection.test.mjs` 共 214 个用例全部通过；以下缺陷都不在这些用例里。

## 汇总

| 级别 | 数量 |
|------|------|
| P1 | 3 |
| P2 | 5 |
| P3 | 13 |

| 编号 | 一句话 | 位置 |
|------|--------|------|
| P1-1 | 迁移时两个会话同时启动，留下永久的 0 字节 CLAUDE.local.md（6/40），其中 3/40 出现在 `git status` | `claudemd.mjs:514-519`，由 `lib/local-steering.mjs:661`/`:627` 触发 |
| P1-2 | rules 文件已存在后 `.gitignore` 加了匹配它的否定行：文件留在磁盘、进 `git status`、每次会话再注入一遍 | `lib/local-steering.mjs:651` |
| P1-3 | `npmShipsRules` 对不含 `.claude` 字样的否定行判"不打包"，`npm pack` 实际打包 | `lib/local-steering.mjs:223` |
| P2-1 | `adopt --status` 的 `local:` 行在 `/adopt`、`adopt --disable`、禁用项目、被跟踪文件这些状态下说错 | `adopt-cli.mjs:501-514`、`:459` |
| P2-2 | 在子目录执行 `adopt` 会删掉根目录的 rules 文件，之后根目录会话把它当成用户删除 | `adopt-cli.mjs:68-75` + `lib/local-steering.mjs:646` |
| P2-3 | CLAUDE.md 带块时，每次 SessionStart 都删除被 git 跟踪的 rules 文件 | `adopt-cli.mjs:338` → `lib/local-steering.mjs:690-711` |
| P2-4 | 创建时 `.claude/` 已被忽略（未写 exclude 行），之后放宽 `.gitignore`，插件文件进 `git status` 直到下一次 SessionStart | `lib/local-steering.mjs:394` |
| P2-5 | （早于本次改动）祖先目录里只有插件块的 CLAUDE.md 让其下所有仓库的 AGENTS.md 失效，且引导加载两遍；本次同步不覆盖 | `adopt-cli.mjs:303-330`、`:371-384`、`lib/local-steering.mjs:262` |

P3 见文末各节。

---

## P1-1 迁移会话并发：残留空 CLAUDE.local.md，AGENTS.md 持续被关掉

- 位置：`claudemd.mjs:514-519`

  ```js
  if (raw.trim() === '' && !isLink) {
    try {
      unlinkSync(p);
    } catch {
      atomicWrite(p, raw);   // raw === ''
    }
  ```
  由 `writeRulesSteering` 在 SessionStart 调用：`lib/local-steering.mjs:661`（`if (localPresent) removeTarget(root, slug, LOCAL_MD)`），拒写路径 `:627` 同理。
- 输入/状态：仓库有 AGENTS.md，6.20/6.21 已写过 CLAUDE.local.md（插件创建，只有块）。升级后两个 Claude Code 会话几乎同时启动（例如 tmux 恢复多个窗格、脚本并行 `claude -p`）。
- 机制：两个会话都在对方删除前读到带块的 CLAUDE.local.md；先删的一方 `unlinkSync` 成功并（因为文件已不存在）删掉 exclude 行；后删的一方 `unlinkSync` 抛 ENOENT，进入 catch，用 `atomicWrite(p, '')` 把文件重新建成 0 字节。
- 复现（两会话并发，40 个新仓库，每个仓库先跑一次旧版本会话）：

  ```
  2-session move race: leftover CLAUDE.local.md in 6/40 repos, visible in git status in 3/40
  sample: size=0 status=[?? CLAUDE.local.md]
  after next session: exists=yes size=0
  [unadopt] .../.claude/rules/claude-mem-lite.md → removed
  after unadopt: exists=yes
  ```
  4 会话并发时 20 个仓库中 3 个残留（其中 1 个可见于 `git status`）。
- 后果：
  1. 之后的会话不再看这个文件（`localPresent` 为假，rules 已是粘性渠道），`unadopt` 也不删它（没有块）。文件永久留下。
  2. 文档："An `AGENTS.md` and a `CLAUDE.md` or `CLAUDE.local.md` in your working directory or above it → Your `CLAUDE.md` files only"。判定按"存在"表述，所以这个空文件会继续关掉 AGENTS.md，这正是 D#212 要修的缺陷。空文件是否计入未在 Claude Code 上实测（见 NOT CHECKED）。
  3. 一半的残留出现在 `git status`（`?? CLAUDE.local.md`），会被 `git add -A` 提交。
  4. 同时也推翻 C5：rules 块已经存在后，另一个会话写出了 CLAUDE.local.md。
- 期望：删除路径上 `unlinkSync` 遇到 ENOENT 视为已完成，不要重建文件；只在 EPERM/EBUSY 这类"删不掉"时才退回清空写入。

## P1-2 rules 文件已存在时 exclude 失效：文件进 git，引导加载两遍

- 位置：`lib/local-steering.mjs:651`

  ```js
  if (ensureExcluded(root, RULES_MD) === 'failed') return refuse('exclude-failed');
  ```
  `refuse()` 只拿掉 CLAUDE.local.md 的块，不动已存在的 rules 文件，并返回 `present: false`，所以 `silentAutoAdopt` 返回 `inject`。
- 输入/状态：rules 文件已由插件创建；之后 `.gitignore` 加了一条匹配它的否定规则。`.gitignore` 的优先级高于 `info/exclude`，exclude 行就此失效。以下真实的写法都会触发（团队共享 `.claude/rules/` 的常见写法）：

  ```
  .claude/* !.claude/rules/ !.claude/rules/**   → inject, detail exclude-failed | status: ?? .claude/
  !.claude/rules/*.md                           → inject, detail exclude-failed | status: ?? .claude/
  .claude/* !.claude/rules !.claude/rules/*.md  → inject, detail exclude-failed | status: ?? .claude/
  !*.md                                         → inject, detail exclude-failed | status: ?? .claude/
  ```
  `git add -A --dry-run` 输出 `add '.claude/rules/claude-mem-lite.md'`；下一次会话结果相同。
- 后果：插件文件出现在 `git status`、会被 `git add -A` 提交（Q2）；每个会话 Claude Code 在启动时加载了这个文件，钩子又注入一份（Q3：文件 + 注入，每次会话都发生）。规格写着"同一时刻只有一个渠道带块"。
- 对照：`npm-publishable` 分支（`:635-643`）在同一情形下会先删掉已有的 rules 块。现有测试 "a negated ignore rule makes the exclude entry useless" 只覆盖文件尚不存在的情形。
- 期望：exclude 失效时按 npm 分支处理（删掉块、忘掉状态、注入），或者至少不在文件仍带块时再注入。

## P1-3 `npmShipsRules` 漏判否定行（C3 被推翻）

- 位置：`lib/local-steering.mjs:223`

  ```js
  if (lines.some((l) => l.startsWith('!') && l.includes('.claude'))) return true;
  ```
  只有文字里含 `.claude` 的否定行才算"会打包"。npm 的 ignore-walk 不遵守 git"父目录被排除就不能再包含"的规则（规格自己测到 `.claude/` + `!.claude/rules/claude-mem-lite.md` 会打包），所以任何能匹配到这个文件的否定行都会把它带进包里。
- 复现（每行一个新仓库，`rulesRefusal()` 与 `npm pack --dry-run --json` 的文件列表对照，npm 11.19.0）：

  | `.npmignore` / `.gitignore`（无 .npmignore） | 判定 | npm |
  |---|---|---|
  | `.npmignore`: `.claude` + `!**/claude-mem-lite.md` | null（写） | **SHIPS** |
  | `.npmignore`: `.claude` + `!**/*.md` | null | **SHIPS** |
  | `.npmignore`: `.claude/` + `!**` | null | **SHIPS** |
  | `.npmignore`: `.claude` + `!**/rules/**` | null | **SHIPS** |
  | `.npmignore`: `.claude/` + `!/**/*.md` | null | **SHIPS** |
  | `.npmignore`: `.claude/rules` + `!**/*.md` | null | **SHIPS** |
  | `.npmignore`: `.claude/rules/claude-mem-lite.md` + `!*.md` | null | **SHIPS** |
  | `.npmignore`: `.claude` + `!.Claude/rules/claude-mem-lite.md`（npm 不区分大小写） | null | **SHIPS** |
  | `.gitignore`: `.claude/` + `!**/*.md` | null | **SHIPS** |
  | `.gitignore`: `.claude` + `!**/claude-mem-lite.md` | null | **SHIPS** |

  对照组（判定正确）：`.claude`+`!*.md`、`.claude`+`!claude-mem-lite.md`、`.claude`+`!rules/`、`.gitignore` `.claude/`+`!*.md` 都不打包。
- 额外：`.gitignore` 那两行的情形里，git 仍把文件视为忽略（父目录被排除），`ensureExcluded` 返回 `already`，所以 `git status` 干净、提示说"不会提交"，而 `npm publish` 会把它发出去。
- 期望：规格写明"看不懂的一律按会被打包处理（保守）"。否定行的效果无法用字面匹配判断，任何 `!` 行都应判"会打包"。

---

## P2-1 `adopt --status` 的 `local:` 行在常见状态下说错

- 位置：`adopt-cli.mjs:501-514`（`localSteeringStatus`），`adopt-cli.mjs:459`（`--enable` 输出）。
- 状态与实际输出：
  1. 自动写过 rules 文件后执行 `/adopt`（`adopt` 通过 `dropLocalSteering` 删掉 rules 文件，状态文件保留）：

     ```
     CLAUDE.md:  ✓ adopted (v1)
     local:      ✗ removed: deleted by you or unadopt, so it is not written again (steering is injected at session start); `claude-mem-lite adopt --enable` writes it back
     ```
     三处都不对：删除者是 `adopt`；会话返回 `already-adopted`，引导来自 CLAUDE.md，没有注入；执行 `adopt --enable` 会打印 `the local steering file will be written again`，但下一次会话仍是 `{"action":"already-adopted"}`，rules 目录不存在。
  2. `adopt --disable` 之后：同样打印 "✗ removed … (steering is injected at session start)"，实际会话返回 `disabled`，既无文件也无注入。
  3. 项目已禁用、还没写过文件：打印 `— none yet: the next session writes …/.claude/rules/claude-mem-lite.md`，实际会话返回 `{"action":"disabled","reason":"disabled-by-sentinel"}`。
  4. rules 文件被 git 跟踪（`git add -f` 后提交）：打印 `✓ … (auto-written, excluded from git)`，实际被跟踪。
- 期望：`localSteeringStatus` 先看 CLAUDE.md 块与禁用开关；"removed" 只在状态确实来自用户或 `unadopt` 时出现；`--enable` 在 CLAUDE.md 带块时不说"will be written again"。CHANGELOG 中 "`✗ removed` says the block was deleted (by you or `unadopt`)" 在情形 1、2 下不成立。

## P2-2 插件自己的移除被当成用户删除（C4 被推翻）

- 位置：`adopt-cli.mjs:68-75`（`dropLocalSteering(cwd)` 把 `cwd` 解析到 git 根目录）+ `lib/local-steering.mjs:646`（`!rulesPresent && !localPresent && readState(root)` → `removed`）。
- 输入：monorepo，根目录有 AGENTS.md，根目录会话已写出 rules 文件；然后在 `pkg/` 里执行 `claude-mem-lite adopt`（或 `/adopt`）。
- 复现：

  ```
  == root session        {"action":"local","written":"created","file":".claude/rules/claude-mem-lite.md"}
  == explicit adopt in pkg/
  [adopt] …/pkg → created (+removed the block from …/.claude/rules/claude-mem-lite.md)
  == root session after  {"action":"inject","reason":"local-agents-md","detail":"removed"}
  == status at root      local: ✗ removed: deleted by you or unadopt, …
  ```
- 后果：`pkg/CLAUDE.md` 只作用于 `pkg/` 及其下的会话，根目录会话却失去文件渠道（子代理看不到引导），并被提示"你或 unadopt 删了它"。同样的机制：一个分支提交了带块的 CLAUDE.md，在该分支启动会话会删掉 rules 文件，切回别的分支后被当成用户删除。CLAUDE.local.md 在 6.21.0 已有同样行为，D#212 原样沿用到 rules 文件。
- 期望：只在 `cwd` 就是根目录时才删根目录的本地引导；插件因 CLAUDE.md 带块而做的删除要么不留"已创建"状态，要么记成插件的移动。

## P2-3 SessionStart 删除被 git 跟踪的 rules 文件

- 位置：`adopt-cli.mjs:338`（`hasBlock` 分支每次调用 `dropLocalSteering(cwd)`）→ `lib/local-steering.mjs:690-711`（`removeTarget` 只检查符号链接，不检查是否被跟踪）。
- 输入：`.claude/rules/claude-mem-lite.md` 带块且已提交（`git add -f`，或 P2-4 的窗口期提交），同时 `cwd` 的 CLAUDE.md 带块（例如团队提交了 `/adopt` 生成的 CLAUDE.md）。
- 复现：

  ```
  restored: [?? .claude/.plugin_claude_mem_lite_state.json]
  {"ok":true,"action":"already-adopted"}
  after a SessionStart: [ D .claude/rules/claude-mem-lite.md ?? .claude/.plugin_claude_mem_lite_state.json ]
  ```
  每次 `git checkout` 恢复之后，下一次会话都会再删一次。
- 后果：SessionStart 改动用户仓库里被跟踪的文件，`git add -A` 会把删除提交。写入端因为同样的原因拒写被跟踪的文件（`rulesRefusal` → `tracked`），删除端没有这层检查。
- 期望：SessionStart 的同步删除跳过被跟踪的文件（与写入端对称）；显式 `unadopt`/`adopt` 可以照旧。

## P2-4 创建时 `.claude/` 已被忽略，之后放宽 `.gitignore`，插件文件进入 `git status`

- 位置：`lib/local-steering.mjs:394`

  ```js
  if (gitOk(root, ['check-ignore', '-q', '--', rel])) return 'already';
  ```
  文件已被用户规则忽略时不写 exclude 行。
- 复现：`.gitignore` 为 `.claude/` 时会话创建 rules 文件，`info/exclude` 里没有对应行；把 `.gitignore` 改成 `.claude/settings.local.json`（准备共享 `.claude/` 里其他内容）后：

  ```
  status after relax:
   M .gitignore
  ?? .claude/
  add '.claude/rules/claude-mem-lite.md'
  next session: {"action":"local","written":"unchanged"} → status 只剩 M .gitignore
  ```
- 后果：从改 `.gitignore` 到下一次 SessionStart 之间，插件文件可见，也会被 `git add -A`、`git add .claude` 暂存。用户改这一行通常就是为了马上提交 `.claude/`。一旦提交，后续会话判为 `tracked`，文件就留在仓库里（并触发 P2-3）。
- 期望：rules 文件的 exclude 行无论如何都写（幂等），不依赖创建时用户规则的状态。

## P2-5 （早于本次改动）祖先目录中只含插件块的 CLAUDE.md

- 级别依据：这是 AGENTS.md 失效这一类问题（按评级标准属 P1），但 6.21.0 已有同样表现，本次改动没有让它变差，只是没有覆盖到。因此评 P2。
- 来源：6.19.x 及更早的 `silentAutoAdopt` 不检查目录，会在任何启动目录（包括 `~`、`~/dev` 这类放仓库的上级目录）写入只含块的 CLAUDE.md（`git show v6.19.4:adopt-cli.mjs`，没有 HOME 检查）。6.20+ 在该目录启动会话时会继续刷新它。
- 位置：`adopt-cli.mjs:303-330` 只检查 `root` 的 CLAUDE.md；`lib/local-steering.mjs:262` 也只看 `root`；`syncAgentsImports`（`adopt-cli.mjs:371-384`）只在会话从该目录本身启动时才运行。
- 复现（`dev/CLAUDE.md` 只含插件块，`dev/proj` 是带 AGENTS.md 的仓库）：

  ```
  session in proj: {"action":"local","written":"created","file":".claude/rules/claude-mem-lite.md"}
  status: CLAUDE.md: ✗ not adopted  local: ✓ …/proj/.claude/rules/claude-mem-lite.md
  session in dev/: {"action":"already-adopted"}        （dev/ 旁没有 AGENTS.md，不加导入）
  hook (2nd session in proj): systemMessage "…not in CLAUDE.local.md: Claude Code stops reading your AGENTS.md once a CLAUDE.local.md exists, and a rules file leaves it loading…"
  ```
- 后果：
  1. 按文档规则，祖先目录的 CLAUDE.md 让 `proj/AGENTS.md` 失效，rules 文件改变不了这一点。
  2. 引导加载两遍：祖先 CLAUDE.md 一份，rules 文件（或 CLAUDE.local.md）一份。
  3. rules 提示说"a rules file leaves it loading"，与事实不符。
  4. 在 `$HOME` 启动会话、且 `~/CLAUDE.md` 只含插件块、`~/AGENTS.md` 存在时，同步会把 `@AGENTS.md` 加进 `~/CLAUDE.md`（已复现：`{"agents":{"imported":["AGENTS.md"]}}`）。之后 `~` 下的每个项目都会遇到一个解析到工作目录之外的导入，按文档需要审批外部导入。
- 期望：自动 adopt 能识别根目录以上只含插件内容的 CLAUDE.md，至少在 `adopt --status`/提示里点名它，并在那里避免重复加载；`syncAgentsImports` 不在 `$HOME` 运行（与 `offerAdoptOnce` 的 HOME 检查一致）。

---

## P3

### P3-1 迁移那一次会话加载两遍引导

`writeRulesSteering` 迁移时 rules 文件是新建的，返回 `written: 'created'`，`hook.mjs:3193` 因此注入一份；可本会话启动时 Claude Code 已经加载了旧的 CLAUDE.local.md（带块）。真实钩子复现：旧版本会话写出 CLAUDE.local.md 后，HEAD 钩子输出含 1 份注入的引导，同时显示 rules 提示。每个从 6.20/6.21 升级、带 AGENTS.md 的仓库发生一次。期望：迁移（`localPresent` 为真）时不补注入。

### P3-2 首个会话并发：一方没有引导，或收到错误提示

- 新仓库两会话同时启动：30 对中 19 对出现一方返回 `written: 'unchanged'`。这一方启动时文件还不存在，钩子又只在 `created` 时注入，所以这一方整个会话没有引导。
- 4 会话同时启动：100 个会话中 11 个返回 `detail: 'removed'`。它们读 `rulesPresent` 时文件还没写，读状态时另一方已写完状态，于是收到 agents-md 提示 "That file cannot be written here (you or unadopt removed it…)"，一次性提示的标记也就此用掉。
- 位置：`lib/local-steering.mjs:552`、`:646`、`hook.mjs:3193`。CLAUDE.local.md 在 6.20+ 已有同样的竞态。

### P3-3 agents-md 提示与状态行的承诺不成立

`hook.mjs:2776`："set Project instructions to claude-md-and-agents-md in /config (CLAUDE.local.md is then written from the next session)"。复现：用户删掉 rules 文件后照提示改设置，之后两次会话都是 `{"action":"inject","reason":"local-removed"}`，CLAUDE.local.md 没写。`detail` 为 `npm-publishable` 时，常见包根（无 `files`、无 `.npmignore`）的 `npmPublishable` 也为真，同样不会写。"run /adopt …, which then imports AGENTS.md"在 AGENTS.md 位于上级目录或只在子目录被跟踪时也不成立（`adopt` 只警告，不导入）。`adopt-cli.mjs:514` 状态行用的是同样的措辞。

### P3-4 每次 SessionStart 多一次 `git ls-files` 全索引扫描

没有用户 CLAUDE.md 的 git 仓库，每次会话都要跑 `shadowedAgentsMd` → `git ls-files -z -- ':(glob)**/AGENTS.md'`（`lib/local-steering.mjs:289`）；只含插件块的 CLAUDE.md 项目经 `syncAgentsImports` 也要跑。实测 `silentAutoAdopt` 进程内耗时，两版交替各跑 6 次（同一时刻、同一仓库）：
- 小仓库：v6.21.0 为 7.1–8.8 ms，HEAD 为 8.6–9.8 ms；
- 40 万条目索引的合成仓库：v6.21.0 为 75.5–92.1 ms，HEAD 为 129.1–138.6 ms（每次会话多约 54 ms）。

### P3-5 符号链接的 rules 带块时判 `already-adopted`，但宿主可能不加载

`lib/local-steering.mjs:645` 把 `symlink` 拒写且带块视为 `present`，于是 `silentAutoAdopt` 不注入。文档原文："Claude Code treats a symlink whose target is outside your working directory like an external import. The linked rules don't load until you approve external imports for the project… asks for that approval only when a project memory file imports a file outside the working directory with `@path`, not for symlinks alone." 文档本身推荐用符号链接跨项目共享 `.claude/rules/`（链到另一个已由插件写过 rules 的仓库）。未审批的项目里，会话既没有文件也没有注入。

### P3-6 CRLF 的 `info/exclude` 删不掉我们的行

`lib/local-steering.mjs:439` 按 `\n` 精确切分。复现：把 exclude 改成 CRLF 后执行 `unadopt`，文件被删，exclude 里仍有 2 行；之后用户自建的同名文件不出现在 `git status`。CLAUDE.local.md 的行同理（早于本次改动）。

### P3-7 写入失败后 exclude 行留下

`ensureExcluded`（`:651`）在 `mkdirSync`/写入（`:655-658`）之前运行，`write-failed` 不回滚。复现：`.claude` 是普通文件时返回 `detail: 'write-failed'`，`info/exclude` 多出 `.claude/rules/claude-mem-lite.md` 一对行，此后每次会话都返回 `write-failed`。

### P3-8 rules 路径不可读或是目录时，会话没有引导

`readBlockAt(rulesMdPath(root))`（`:552`）抛错，被 `silentAutoAdopt` 捕获，返回 `skipped`，钩子不注入。复现：路径是目录 → `{"ok":false,"action":"skipped"}`，真实钩子 exit 0，`steering=0`；`chmod 000` 结果相同。异常没有冒出 SessionStart（C7 成立），但会话没有引导。

### P3-9 用户只删 `@AGENTS.md` 行时，`unadopt` 留下只有插件注释的 CLAUDE.md

`claudemd.mjs:132` 要求至少 2 行（标记行 + 导入行）。复现：删掉 `@AGENTS.md` 行后 `unadopt` → CLAUDE.md 仍在，内容只剩插件的标记注释。这个文件继续关掉 AGENTS.md，而且是插件留下的残余。

### P3-10 CLAUDE.md 同时含本插件与 code-graph-mcp 两个块时不加导入

两个插件的旧版自动 adopt 都会写 CLAUDE.md。`holdsOnlyOwnLines`（`claudemd.mjs:145-149`）把另一个插件的块当作用户内容，结果 `{"action":"already-adopted"}`、不加导入，AGENTS.md 继续失效。

### P3-11 C2 在多工作树下不成立

`info/exclude` 由所有工作树共享。复现：W1 有用户自己的 CLAUDE.local.md（旧版本已追加块），W2 有插件创建的 CLAUDE.local.md 块；W1 迁移到 rules 后，`git status` 只显示 `?? AGENTS.md`，用户的 CLAUDE.local.md（内容 `mine`）仍被隐藏，因为 `removeExcluded` 看到 W2 还有块，返回 `shared`。这是共享 exclude 的固有限制，但 C2 的表述没有写这个例外。

### P3-12 `"private": true` 与反斜杠 `files` 条目

- `"private": true`：`npmShipsRules` 返回 false（`:212`），但 `npm pack --dry-run` 照样打包（复现 `private pred=null npm=SHIPS`）。规格按 `npm publish` 的语义判定，而作者的 C3 用的是 `npm pack --dry-run`，字面上不成立。
- `files: ["\\.claude"]`（JSON 中写作 `"\\.claude"`）：`filesEntryCouldShipRules`（`:230-237`）不把 `\` 当通配，判"不打包"，npm 实际打包（复现 `files-escaped2 pred=null npm=SHIPS`）。

### P3-13 设置只读 `~/.claude/settings.json`；`managed-only` 下没有引导

`userInstructionFiles`（`:334-345`）只读用户设置。文档："Claude Code reads the entry from `~/.claude/settings.json`, a `--settings` file, or managed settings"，组织下发的值读不到。更直接的问题：`AGENTS_MD_UNAFFECTED`（`:247`）把 `managed-only` 当成"不受影响"，照常写 CLAUDE.local.md。可文档对 `managed-only` 的说明是 "Your project, local, and user `CLAUDE.md` files, your `.claude/rules/` files, and every `AGENTS.md` are left out"，文件渠道加载不了，钩子又因为返回 `local` 而不注入，会话没有引导。

---

## 作者声明逐条判定

| 声明 | 判定 | 证据 / 做过的尝试 |
|------|------|------|
| C1 删除不经符号链接写 | **HELD** | 四种链接（`.claude`、`.claude/rules`、rules 文件、`CLAUDE.local.md`，目标都带块）× 会话、`unadopt`、`adopt --disable`、`adopt`、`unadopt --all`：目标文件 md5 不变，链接都在，`unadopt` 输出 `skipped-symlink`。范围外的旁注：显式 `adopt` 会经符号链接的 `.claude` 把详情文档写到链接目标（`writeManaged`，早于本次改动）。 |
| C2 迁移让用户文件回到 `git status` | **FALSIFIED**（P3-11） | 单工作树成立（`?? CLAUDE.local.md` 回来了，内容未动）；另一个工作树带块时不成立。 |
| C3 npm 判定不会漏判 | **FALSIFIED**（P1-3、P3-12） | 32 种配置与 `npm pack --dry-run` 对照，12 种漏判。 |
| C4 删除后不重写；插件自己的移动不算用户删除 | **FALSIFIED**（P2-2、P3-2） | 用户删除后不重写：成立（直到 `--enable`）。子目录 `adopt` 删掉根目录文件后被判为 `removed`；并发首个会话里有 11/100 被判为 `removed`。 |
| C5 rules 块存在后不再写 CLAUDE.local.md | **FALSIFIED**（P1-1） | 粘性在不同 cwd、工作树、设置变化下都成立；但迁移并发时，另一个会话在 rules 块已存在后重建了 0 字节的 CLAUDE.local.md（6/40）。 |
| C6 只在 AGENTS.md 就在旁边、且用户没有别的文件已关掉它时才加导入 | **HELD** | 用户 CLAUDE.local.md、`.claude/CLAUDE.md`、祖先目录的用户 CLAUDE.md、另一个插件的块 → 都不加；只含插件块 + 旁边有 AGENTS.md → 加。`$HOME` 的情形（P2-5 第 4 点）符合"旁边"的字面条件，但影响 `~` 下所有项目。 |
| C7 SessionStart 不抛异常 | **HELD** | rules 路径是目录、不可读、`.claude` 是普通文件、`package.json` 无效：真实钩子都 exit 0；新的提示函数都包了 try/catch。被吞掉的异常会让会话没有引导（P3-8）。 |

## NOT CHECKED

- 没有运行真实的 Claude Code 会话，以下几点按文档推断：0 字节 CLAUDE.local.md 是否计入"存在"（P1-1 中 AGENTS.md 失效那一半）；指向外部的 rules 符号链接在未审批时是否加载（P3-5）；`/clear`、`compact`、`resume` 之后是否重新读取指令文件（若不重读，创建 rules 文件的会话 `/clear` 后会没有引导）；子代理是否加载 rules 文件。
- macOS 大小写不敏感文件系统（如 `files: [".Claude"]` 在 Linux 上不打包，macOS 未知）；Windows 实机（只在 Linux 上模拟了 CRLF exclude）。
- 只测了 `npm pack --dry-run`，没测 `npm publish`、pnpm/yarn pack、docker 构建上下文。
- 不同插件版本的 Claude Code 进程并存，以及装了 D#212 之后降级到 6.21.0：只读了代码（6.21.0 读到状态文件会判 `removed`；降级后 rules 文件会留下，6.21.0 不认识它）。
- 作者测试的变异验证、覆盖率、全量测试、eslint/format：本次只跑了三份测试（214 个用例全过）。
- 规格里的 A/B 实验及其护栏。
- `inferProject` 以子目录区分项目时，一次性提示是否按子目录重复出现（早于本次改动）。
