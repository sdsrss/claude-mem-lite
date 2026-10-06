# 发版前声明审查（CLAIMS）— D#212 与 AGENTS.md 修复（v6.21.0..0b75931）

审查树：`main` @ `0b75931`，范围 `v6.21.0..HEAD`（7 个提交）。日期 2026-10-06。审查者不是作者。

审查对象：`CHANGELOG.md` 的 `## Unreleased`；`README.md` / `README.zh-CN.md` 中关于 auto-adopt、
`CLAUDE.local.md`、`.claude/rules/claude-mem-lite.md`、`AGENTS.md`、`/adopt`、`/unadopt`、
`MEM_NO_ADOPT_HINT` 的段落（含未改动的相邻句）；`commands/adopt.md`、`commands/unadopt.md` 全文；
`hook.mjs` 的五条一次性提示、`adopt-cli.mjs` 的 `adopt --status` `local:` 行和其他日志行、
`lib/local-steering.mjs` 的 `RULES_REFUSAL_TEXT`。

## 证据环境

- 代码：`git diff v6.21.0..HEAD`；`tasks/specs/d212-rules-steering.md`（未跟踪，r2）。
- 测试：`npx vitest run tests/local-steering.test.mjs tests/adopt-cli.test.mjs tests/steering-injection.test.mjs`
  → `Test Files 3 passed (3)`，`Tests 214 passed (214)`；运行前后 `git status --porcelain` 都为空。
- Claude Code 文档（2026-10-06 抓取）：code.claude.com/docs/en/memory（`#agents-md`、
  "When Claude Code reads AGENTS.md"、"Choose which instruction files load"、HTML 注释、
  `.claude/rules/`、external imports），code.claude.com/docs/en/sub-agents（"What loads at startup"）。
  Claude Code 官方 CHANGELOG：`## 2.0.64` "Added support for .claude/rules/"，`## 2.1.277`
  "Added AGENTS.md support"——两个版本号都对得上。
- 探针：每个都在新的 `mktemp -d` 目录里跑，`HOME`、`CLAUDE_MEM_DIR` 指向临时目录，
  `CLAUDE_PROJECT_DIR` 指向临时仓库。脚本骨架：

  ```bash
  ss() { (cd "$c" && env -i PATH="$PATH" HOME="$b/home" CLAUDE_MEM_DIR="$b/data" CLAUDE_PROJECT_DIR="$c" \
      CLAUDE_MEM_SKIP_UPDATE=1 CLAUDE_MEM_SKIP_MAINTAIN=1 node hook.mjs session-start <<< '{"session_id":"…","source":"startup","cwd":"…"}'); }
  cli() { (cd "$c" && env -i PATH="$PATH" HOME="$b/home" CLAUDE_MEM_DIR="$b/data" CLAUDE_PROJECT_DIR="$c" \
      MEM_NO_AUTO_ADOPT=1 node cli.mjs "$@"); }
  # “设置”= $b/home/.claude/settings.json 里写
  # {"pluginConfigs":{"cc-plugin-agents-md@builtin":{"options":{"instructionFiles":"claude-md-and-agents-md"}}}}
  ```

  输出里 `steering-in-context` 表示 additionalContext 中有 `## claude-mem-lite — persistent memory`，
  `systemMessage` 是给人看的一次性提示。所有临时目录已在结束时删除。

## 汇总

| 级别 | 数量 |
|---|---|
| P1 | 1 |
| P2 | 3 |
| P3 | 9 |

同一句话出现在多个文件里算一条，列出所有位置。EN 与 zh-CN README 在这次改动涉及的段落里内容一致，
没有发现两者说法不同的地方；下面的错误两边都有。

---

## P1

### P1-1 "运行 /adopt，它写的 CLAUDE.md 会导入 AGENTS.md"——AGENTS.md 在上层目录或只在子目录里时，按这个建议做反而让 AGENTS.md 失效

位置（同一建议，四处）：
- `hook.mjs:2776`（noteAgentsMdOnce）："or run /adopt to put the guidance in CLAUDE.md, which then imports AGENTS.md."
- `adopt-cli.mjs:514`（`adopt --status` 的 `✗ not written` 行）："or run \`claude-mem-lite adopt\`, whose CLAUDE.md imports AGENTS.md"
- `README.md:170`："then the notice names `AGENTS.md`, why, and two ways to a file that keep it loading: … or `/adopt`, whose `CLAUDE.md` imports `AGENTS.md`."
- `README.zh-CN.md:157`："并给出两种保留 `AGENTS.md` 又能写文件的做法：……或者运行 `/adopt`，它写的 `CLAUDE.md` 会导入 `AGENTS.md`。"

这条提示只在 rules 文件写不了时出现，而触发条件 `shadowedAgentsMd` 认的 AGENTS.md 有三种来源：
会话目录、会话目录以上（可以在仓库根之外）、git 跟踪的任意子目录（`lib/local-steering.mjs:261-266`）。
`/adopt` 只导入"它所在目录里"的 `AGENTS.md` / `.claude/AGENTS.md`（`agentsMdForNewClaudeMd`，
`lib/local-steering.mjs:314`）；上层的和子目录里的进 `elsewhere`，不导入，只在输出里打一行 ⚠
（`adopt-cli.mjs:166-171`）。另外，从子目录启动的会话里运行 `/adopt`，CLAUDE.md 写在子目录，
仓库根的 AGENTS.md 也属于"上层"。这些情况下新建的 CLAUDE.md 让 Claude Code 不再读 AGENTS.md
（文档 memory#agents-md："Count, so Claude reads them instead of `AGENTS.md`: a `CLAUDE.md` … in your working directory or any directory above it"）。

探针 3a（可发布的 npm 包根，只有 `packages/web/AGENTS.md` 被跟踪）和 3b（AGENTS.md 在仓库外的上层目录，
用户删掉了 rules 文件）：

```
== 3a session 1 at root
  systemMessage: claude-mem-lite: this project has an AGENTS.md, … That file cannot be written here (npm publish would ship it from this package root), … or run /adopt to put the guidance in CLAUDE.md, which then imports AGENTS.md. Shown once per project.
== 3a follow the advice: claude-mem-lite adopt at the root
[adopt] …/home/work/mono → created
  ⚠ …/home/work/mono/packages/web/AGENTS.md stops loading in sessions here once CLAUDE.md exists; set Project instructions to claude-md-and-agents-md in /config to keep it
--- CLAUDE.md head:
<!-- claude-mem-lite:begin v1 -->
== 3b session 2 (rules file deleted)
  systemMessage: … That file cannot be written here (you or unadopt removed it, …) … or run /adopt to put the guidance in CLAUDE.md, which then imports AGENTS.md. …
== 3b follow the advice: adopt
[adopt] …/home/work2/svc → created
  ⚠ …/home/work2/AGENTS.md stops loading in sessions here once CLAUDE.md exists; …
```

结果：提示说"两种保留 AGENTS.md 的做法"之一，照做后得到一个不导入 AGENTS.md 的 CLAUDE.md，
AGENTS.md 在这些会话里失效（3b 是仓库里所有会话；3a 至少是从 `packages/web` 启动的会话）。
adopt 事后打 ⚠ 是唯一的补救，CLAUDE.md 已经写下。按本次分级定义（让用户失去 AGENTS.md）定为 P1。
3b 那种 AGENTS.md 在仓库外上层目录的情况，提示开头说 "this project has an AGENTS.md" 也不准确。

建议改写（提示）：
> or, if the AGENTS.md is in the directory you start sessions in, run /adopt there: the CLAUDE.md it writes imports it. An AGENTS.md above that directory or in a subdirectory cannot be imported this way; /adopt would stop it loading.

更稳妥的做法：只有当 `shadowedAgentsMd` 找到的文件就是 `<cwd>/AGENTS.md` 或 `<cwd>/.claude/AGENTS.md` 时才提 `/adopt`；
否则只给设置那一条。`adopt-cli.mjs:514` 和两份 README 同步改。

---

## P2

### P2-1 "改设置后就会写 CLAUDE.local.md"——在最常见的拒写原因（npm 包根）和 `removed` 下都不成立

位置：
- `hook.mjs:2776`："set Project instructions to claude-md-and-agents-md in /config (CLAUDE.local.md is then written from the next session)"
- `adopt-cli.mjs:514`："set Project instructions to claude-md-and-agents-md in /config to have a file"
- `README.md:170`："Project instructions = `claude-md-and-agents-md` in `/config`, after which `CLAUDE.local.md` is written"
- `README.zh-CN.md:157`："在 `/config` 里把 Project instructions 设为 `claude-md-and-agents-md`，之后就会写 `CLAUDE.local.md`"

改设置后 `shadowedAgentsMd` 返回 null，流程走 CLAUDE.local.md 分支，但这个分支有自己的拒写：
`npmPublishable`（`lib/local-steering.mjs:555-564`，只看 `.npmignore`，比 rules 的判定更严）和
`!present && readState(root)` → `removed`（`:565`）。rules 文件因 `npm-publishable` 被拒时，
CLAUDE.local.md 几乎一定也被拒；因 `removed` 被拒时，状态文件还在，CLAUDE.local.md 也被拒。

探针 1（npm 包根，跟踪 AGENTS.md，无 `files`、无忽略文件）：

```
== session 1 (default setting)
  systemMessage: … That file cannot be written here (npm publish would ship it from this package root) … (CLAUDE.local.md is then written from the next session) …
== session 2 (Project instructions = claude-md-and-agents-md)
  steering-in-context: true
  systemMessage: claude-mem-lite: memory guidance for this project is injected at session start, and nothing is written to your repository. Run /adopt …
.  ..  .git  AGENTS.md  package.json          ← 没有 CLAUDE.local.md
--- status:   local:      ✗ none
```

探针 2（用户删掉 rules 文件 → 改设置）：session 3 后仍然没有 `CLAUDE.local.md`，
`adopt --status` 仍是 `✗ removed: …`。

建议改写（提示）：
> To keep AGENTS.md loading and have a file, set Project instructions to claude-md-and-agents-md in /config; CLAUDE.local.md is then written from the next session unless the same reason applies to it (an npm package root, or a file you removed — `claude-mem-lite adopt --enable`).

或者按 `detail` 分支：`npm-publishable` 和 `removed` 时不提"写 CLAUDE.local.md"，只说设置能让 AGENTS.md 与注入并存。

### P2-2 `adopt --status` 新的 `local:` 行在四种常见状态下说错

声明：`CHANGELOG.md:81-86` "**`adopt --status` names the local file and says why there is none.** … `— none yet` says the next session writes the rules file beside an `AGENTS.md`; … `✗ removed` says the block was deleted (by you or `unadopt`) and that `claude-mem-lite adopt --enable` writes it back."
代码：`adopt-cli.mjs:501-515`（`localSteeringStatus`）。它只看状态文件、`shadowedAgentsMd`、`rulesRefusal`，
不看 CLAUDE.md 是否已 adopt、项目是否 `--disable`、CLAUDE.local.md 是否被跟踪/是链接、exclude 能否生效。

探针 4：

```
== 4a 自动写了 CLAUDE.local.md，再显式 adopt：
  CLAUDE.md:  ✓ adopted (v1)
  local:      ✗ removed: deleted by you or unadopt, so it is not written again (steering is injected at session start); `claude-mem-lite adopt --enable` writes it back
== 4a next session:  [stdout empty]          ← 没有注入（CLAUDE.md 承载），--enable 之后也不会写本地文件
== 4b adopt --disable 之后：
  local:      ✗ removed: … (steering is injected at session start) …
== 4b next session:  steering-in-context: false   ← 已关闭，没有注入
== 4c AGENTS.md 仓库，先 --disable：
  local:      — none yet: the next session writes …/.claude/rules/claude-mem-lite.md (…)
== 4c next session:  steering-in-context: false；目录里没有 .claude
== 4d 用户自己跟踪的 CLAUDE.local.md + AGENTS.md：
  local:      — none yet: the next session writes …/.claude/rules/claude-mem-lite.md (…)
== 4d next session:  steering-in-context: true；没有 .claude（CLAUDE.local.md 被跟踪 → 拒写 → 注入）
```

另外 `exclude-failed`（例如 `.gitignore` 里有 `!.claude/rules/claude-mem-lite.md`）不在 `rulesRefusal`
里，状态同样会显示 `— none yet`。没有 AGENTS.md 的 npm 包根仍显示 `✗ none`，标题里的 "says why there is none" 不成立。
`✗ removed` 里的 "`adopt --enable` writes it back" 也不准：`--enable` 只是忘掉状态，是下一次会话写，而且只在不被其他条件拒写时。

建议：`localSteeringStatus` 先判断 CLAUDE.md 已 adopt（"none: CLAUDE.md carries the block"）和项目已关闭
（"none: auto-adopt is disabled for this project"），`— none yet` 前再判断 CLAUDE.local.md 被跟踪/是链接。
CHANGELOG 改为：
> `adopt --status` names the local file, and in more cases says why there is none: …; `✗ removed` says the block was deleted and that after `claude-mem-lite adopt --enable` the next session may write it again.

### P2-3 导入提示说"运行 unadopt 后改为注入"——实际下一次会话写 rules 文件，和 `commands/unadopt.md` 矛盾

位置：`hook.mjs:2797`（noteAgentsImportOnce）："to drop CLAUDE.md instead, run \`claude-mem-lite unadopt\` (the guidance is then injected at session start)."
矛盾处：`commands/unadopt.md:46-47` "A project whose `CLAUDE.md` block you removed gets a local file on the next session, unless the plugin created one there before."

这条提示的对象正是 6.20.0 之前自动写入的、只有托管块的 CLAUDE.md。这种项目里插件从没写过本地文件，
unadopt 删掉 CLAUDE.md 后，下一次会话 `shadowedAgentsMd` 为真 → 写 rules 文件（不在 git 里时才是注入）。

探针 5：

```
== session 1
  systemMessage: … to drop CLAUDE.md instead, run `claude-mem-lite unadopt` (the guidance is then injected at session start). …
== follow the note: claude-mem-lite unadopt
[unadopt] …/home/work/old → removed
== next session
  systemMessage: claude-mem-lite: memory guidance for this project is in .claude/rules/claude-mem-lite.md at the repository root, …
…/.claude/rules:  claude-mem-lite.md
```

建议改写：
> to drop CLAUDE.md instead, run \`claude-mem-lite unadopt\` (the guidance then goes to a git-ignored local file from the next session, or is injected where none can be written).

---

## P3

### P3-1 rules 文件"子代理也加载"没带 Explore/Plan 的例外（CLAUDE.local.md 那句带了）

位置：`CHANGELOG.md:23-24` "Claude Code loads it as project instructions, also in subagents and in sessions started in a subdirectory"；
`README.md:170` "loaded by Claude Code as project instructions, also in subagents"；`README.zh-CN.md:157` "（子代理也能看到）"。
同一段里 CLAUDE.local.md 写的是 "also in subagents that load project instructions; the built-in Explore and Plan agents load none"。
文档 sub-agents "What loads at startup"：CLAUDE.md files … "including … project rules, `CLAUDE.local.md` … The built-in Explore and Plan agents skip this."
建议：两处都改成 "also in subagents that load project instructions (not the built-in Explore and Plan agents)"。

### P3-2 npm 判定被描述成"npm publish 会把它带上"，实际是一个更宽的拒写集合

位置：`CHANGELOG.md:32-36`（"the root is an npm package that `npm publish` would ship it with: … Checked against `npm pack --dry-run`, npm 11.19.0."）；
`lib/local-steering.mjs:590` `RULES_REFUSAL_TEXT['npm-publishable']` = "npm publish would ship it from this package root"（提示和 `--status` 都用）。
探针 7（npm 11.19.0，`npm pack --dry-run`，每种配置先建好 `.claude/rules/claude-mem-lite.md`）：

```
no-ignore              npm-ships=1 plugin=npm-publishable
npmignore-claude       npm-ships=0 plugin=writes
npmignore-neg          npm-ships=1 plugin=npm-publishable
gitignore-claude       npm-ships=0 plugin=writes
npmignore-star         npm-ships=0 plugin=npm-publishable     (.claude/*)
npmignore-rules-glob   npm-ships=0 plugin=npm-publishable     (.claude/rules/*.md)
files-star-md          npm-ships=0 plugin=npm-publishable     (files: ["*.md"])
files-dstar-md         npm-ships=1 plugin=npm-publishable
files-empty            npm-ships=0 plugin=writes
files-dist             npm-ships=0 plugin=writes
files-dotclaude        npm-ships=1 plugin=npm-publishable
private                npm-ships=1 plugin=writes              (npm pack 打包，npm publish 拒绝发布)
npmignore-anch-rules   npm-ships=0 plugin=writes
npmignore-dstar-claude npm-ships=0 plugin=npm-publishable     (**/.claude)
```

14 种配置里没有"插件写、npm publish 会带上"的情况（安全方向成立）；有 4 种是 npm 不带、插件仍拒写，
这时提示告诉用户 "npm publish would ship it"，不对。CHANGELOG 列出的条件和代码一致，问题在于把它们说成了 npm 的行为。
建议：CHANGELOG 写 "or the root is an npm package that could ship it, judged conservatively: …"；
`RULES_REFUSAL_TEXT` 写 "npm publish could ship it from this package root (only a `files` list without a wildcard or `.claude` entry, or a literal `.claude` line in .npmignore/.gitignore, rules that out)"。

### P3-3 "rules 文件写不了 → 注入并给一次性提示说明原因"：两种情况不注入也不提示

位置：`CHANGELOG.md:30-31` "The rules file is not written, and the guidance is injected instead with a one-time notice saying why, where … git tracks the file …"
代码：被跟踪或在链接后面的 rules 文件里已有托管块 → `refuse(why, rulesPresent)` 返回 `present: true`
（`lib/local-steering.mjs:644-645`）→ `already-adopted`（`adopt-cli.mjs:331`），不注入、不提示。
另外 rules 文件"一旦写过就一直用"，之后 AGENTS.md 不再可见时再被拒，`reason` 不是 `local-agents-md`，
`hook.mjs:3186-3187` 给的是 `/adopt` 邀请，不说原因。
探针 9（被 `git add -f` 跟踪、带块的 rules 文件）：下一次会话 `[stdout empty]`。
行为本身合理（宿主已加载该文件），只是句子需要条件。建议：在列举后加 "(a tracked or linked file that already carries the block is left as it is and loads)"。

### P3-4 迁移说明没提：用户原有的 CLAUDE.local.md 会回到 `git status`，而且仍然让 AGENTS.md 失效

位置：`CHANGELOG.md:27-28` "A block an earlier version wrote into `CLAUDE.local.md` moves there at the next session start"。
代码：迁移时 `removeTarget(root, slug, LOCAL_MD)`（`lib/local-steering.mjs:661`），文件是用户原有的
（状态 `createdFile: false`）→ 删掉块后同时删掉 exclude 行（`:711`）。`shadowedAgentsMd` 不看用户自己的
CLAUDE.local.md（`:262` 只看根目录的 `CLAUDE.md` / `.claude/CLAUDE.md`），所以照样迁移。
探针 6：

```
before plugin:                 ?? CLAUDE.local.md
after session 1 (6.21 行为):   （git status 为空；exclude 里有 CLAUDE.local.md）
== session 2 (AGENTS.md now tracked)
git status:                    ?? CLAUDE.local.md        ← 又出现，内容 "my private notes"
exclude:                       .claude/rules/claude-mem-lite.md
```

这是回到插件写入之前的状态，不算新的数据风险，但几个月来文件一直被隐藏，`git add -A` 现在会把它带上；
而 AGENTS.md 仍被用户这个文件关掉。建议加一句：
> If the block was in a `CLAUDE.local.md` you already had, the block leaves it and git sees that file again as it did before; your `CLAUDE.local.md` still stops Claude Code reading `AGENTS.md`.

### P3-5 README 的打包器括号句：rules 文件不一定能"接过"块，打包器风险也只点名了 CLAUDE.local.md

位置：`README.md:170` "(a publishable npm package root does not keep it: a block written before is taken out at the next session start; in a project whose `AGENTS.md` it would switch off, the block moves to the rules file)"；`README.zh-CN.md:157` 同义。
在一个会把 rules 文件也带上的 npm 包根里，CLAUDE.local.md 的块被拿掉后不会"移到 rules 文件"，而是注入（`refuse` 先删本地块，`lib/local-steering.mjs:625-633`）。
探针 9（先有 6.21 写的 CLAUDE.local.md，之后仓库加了 AGENTS.md 并成为可发布 npm 包）：下一次会话 `CLAUDE.local.md` 被删、`.claude` 不存在、`steering-in-context: true`，提示 "That file cannot be written here (npm publish would ship it …)"。
同一句前半 "docker build contexts, archives and other packagers can pick `CLAUDE.local.md` up" 没提 rules 文件同样如此（CHANGELOG `:39-40` 提了）。
建议："…can pick `CLAUDE.local.md` or the rules file up (…; where `AGENTS.md` would be switched off, the block moves to the rules file when that can be written, and is injected otherwise)"。

### P3-6 只点名 CLAUDE.local.md 的旧句子，这次改动后不完整

- `README.md:580` / `README.zh-CN.md:480`：`claude-mem-lite unadopt  # remove the CLAUDE.md block + doc, and the CLAUDE.local.md block (not written again)` → 也移除 rules 文件里的块（探针 8：`[unadopt] …/.claude/rules/claude-mem-lite.md → removed`，`.claude/` 一并删掉）。
- `README.md:630-631` / `README.zh-CN.md:514`："A `CLAUDE.local.md` block the plugin created and you (or `unadopt`) removed is not written back" → rules 文件同样（探针 2、8）。同一 README 的 `:172` 已写成 "A local block (`CLAUDE.local.md` or the rules file)"。
- `README.md:1062` / `README.zh-CN.md:815`（`MEM_NO_AUTO_ADOPT`）："no new `CLAUDE.local.md`, and no sync of an existing `CLAUDE.md` or `CLAUDE.local.md` block" → 也不新建/同步 rules 文件，也不给块单一的 CLAUDE.md 补导入。
- `README.md:170` "silence both notices with `MEM_NO_ADOPT_HINT=1`" / `README.zh-CN.md:157` "两条提示都可以用 `MEM_NO_ADOPT_HINT=1` 关闭" → 现在是五条（`hook.mjs:2699,2725,2744,2767,2788`），同一 README 的 `MEM_NO_ADOPT_HINT` 表格行已列出全部。改成 "silence these notices"。

### P3-7 "auto-adopt 只同步已有的块"已不完整；"只有托管块的 CLAUDE.md 也会得到导入"缺条件

- `commands/adopt.md:3`（给模型做路由的 description）："Auto-adopt never adds the block to CLAUDE.md itself; it only keeps an existing one in sync." → 现在 SessionStart 还会给只有托管块的 CLAUDE.md 加 `@AGENTS.md` 导入（`adopt-cli.mjs:350`，`syncAgentsImports`），改的是用户可能已提交的文件（探针 5：` M CLAUDE.md`）。建议："…; it only keeps an existing one in sync, and adds an `@AGENTS.md` import to a CLAUDE.md holding nothing but the block."
- `README.md:629-630` "a `CLAUDE.md` holding only the block also gets adopt's `AGENTS.md` import" / `README.zh-CN.md:514` → 缺 "next to an `AGENTS.md`"（且不在 `CLAUDE_MEM_NO_TEMPLATE_REFRESH=1` 下）。

### P3-8 `adopt --enable` 日志 "the local steering file will be written again"

位置：`adopt-cli.mjs:459`。只要状态文件存在就打印。CLAUDE.md 已 adopt（探针 4a 的状态）、npm 包根、
被跟踪的 CLAUDE.local.md 等情况下下一次会话不会写。建议："… the local steering file may be written again from the next session"。

### P3-9 `managed-only` 被列为"照旧写 CLAUDE.local.md"的例外，但这个值下 CLAUDE.local.md 本身不加载

位置：`CHANGELOG.md:16-20` "or your user settings set **Project instructions** to a value that reads `AGENTS.md` … or never (`claude-md`, `managed-only`)"（"where `CLAUDE.local.md` is written as before"）。
文档 memory "Choose which instruction files load"：`managed-only` — "Your project, local, and user `CLAUDE.md` files, your `.claude/rules/` files, and every `AGENTS.md` are left out."
代码现在会读这个设置（`lib/local-steering.mjs:334-345`），但 `managed-only` 下仍写 CLAUDE.local.md、不注入，
所以引导不会送达。句子本身（"written as before"）为真，这是 6.20.0 起就有的行为；
但列在这里读起来像这个值下一切正常。建议加："(with `managed-only`, Claude Code loads neither file, so the guidance does not reach the session)"，或代码在该值下改为注入。

---

## 核实为真的主要声明（摘要）

- AGENTS.md 读取规则、`.claude/CLAUDE.md` 也算、`.claude/rules/` 不算、`~/.claude/CLAUDE.md` 不算：与文档 memory#agents-md 一致。
- 版本号：rules 2.0.64、AGENTS.md 2.1.277、设置 ID 2.1.285 前为 `agents-md@builtin`：与官方 CHANGELOG / 文档一致。
- 设置值 `claude-md-and-agents-md` / `claude-md` / `managed-only`、`/config` 里的 "Project instructions"、只读用户设置：与文档一致（文档还列了 `--settings` 和 managed settings，代码不读，CHANGELOG 只说 "user settings"，不矛盾）。
- 块级 HTML 注释被剥离：文档 memory "Block-level HTML comments … are stripped before the content is injected"。
- 外部导入审批：文档 "An import … is external when its path resolves outside your working directory … shows an approval dialog"。
- 6.20.0 起写 CLAUDE.local.md、6.20.0 前写 CLAUDE.md：`git show v6.19.4:adopt-cli.mjs` 中 `CLAUDE.local` 0 次；`lib/local-steering.mjs` 首见于 v6.20.0。
- 探针确认：AGENTS.md 仓库写 rules 文件并加 exclude、`git status` 为空、首个会话注入一次（探针 2）；删除后不再写、`adopt --enable` 后再写；`unadopt` 删文件、空目录和 exclude 行（探针 8）；冻结时手改文本原样迁移（探针 8：`rules carries hand edit: 1`，CLAUDE.local.md 被删）；重跑 adopt 给只有块的 CLAUDE.md 加导入（探针 8）；SessionStart 给 6.20 前的块单一 CLAUDE.md 加导入、`git status` 出现 ` M CLAUDE.md`、`unadopt` 删除只剩导入行和块的 CLAUDE.md（探针 5）；rules 文件的一次性提示文本（探针 2）。

## NOT CHECKED

- 所有 "checked on Claude Code 2.1.291" 的实机行为：canary 在 auto-adopt 前后的应答、rules 文件在主会话/委派子代理/子目录会话中加载、会话中新建的 rules 文件下一次会话才加载、Claude Code 给 rules 文件标 "project instructions, checked into the codebase"、AGENTS.md 删除后导入被静默跳过、`claude -p` 在批准前不加载外部导入。仓库里只有测试注释记录这些结果（`tests/local-steering.test.mjs:998`、`tests/adopt-cli.test.mjs:417`），没有可复查的记录；本次没有跑 Claude Code。
- 根目录的 CLAUDE.md / CLAUDE.local.md 是否也关掉"子目录里按需加载"的 AGENTS.md：文档 memory#agents-md 一处说 "only when you have no `CLAUDE.md` in your working directory or above it"，另一处说子目录 AGENTS.md 在 "that subdirectory has none of the three `CLAUDE.md` files of its own" 时加载，两处读法不一致。`trackedAgentsMd` 和 adopt 的 ⚠ 行（"stops loading in sessions here"）都按"会关掉"处理；对从根目录启动的会话是否成立未验证（对从该子目录启动的会话成立）。
- npm 11.19.0 以外的 npm 版本，yarn / pnpm 的 publish。
- Windows / macOS 路径，多 worktree 共用 exclude 的场景（测试覆盖，未另做探针）。
- 沙箱评估数字（1.5 vs 5.25、12/12、0/12）：不在本次改动范围。
- `tasks/specs/d212-rules-steering.md` 里预先登记的 A/B：不是面向用户的声明，未核。
- 仓库自己的 `CLAUDE.md` 在本次范围内的改动。
