// Shared runtime source-file manifest — imported by install.mjs and hook-update.mjs
// so the two code paths never drift. Adding a new .mjs that any entry point
// (cli.mjs / hook.mjs / server.mjs / mem-cli.mjs / install.mjs) imports requires
// adding the path here AND to package.json's files array;
// tests/source-files-sync.test.mjs enforces both.

export const SOURCE_FILES = [
  // Entry points and top-level modules
  'cli.mjs', 'cli-path.mjs', 'server.mjs', 'search-scoring.mjs', 'search-engine.mjs', 'deep-search.mjs', 'rerank.mjs', 'tool-schemas.mjs',
  'hook.mjs', 'hook-shared.mjs', 'hook-llm.mjs', 'hook-memory.mjs', 'skip-tools.mjs',
  'hook-semaphore.mjs', 'hook-episode.mjs', 'hook-context.mjs', 'hook-handoff.mjs',
  'hook-update.mjs', 'hook-optimize.mjs', 'hook-precompact.mjs',
  'plugin-cache-guard.mjs',
  'haiku-client.mjs', 'utils.mjs', 'schema.mjs',
  'package.json', 'package-lock.json', 'skill.md',
  'registry.mjs', 'registry-scanner.mjs',
  'registry-retriever.mjs', 'resource-discovery.mjs',
  // registry-recommend.mjs: statically imported by hook.mjs (PostToolUse adoption probe)
  // and scripts/user-prompt-search.js (UserPromptSubmit shadow recommendation).
  'registry-recommend.mjs',
  // registry-enricher/-github/-importer are dynamically imported by server.mjs
  // (mem_registry tool) and mem-cli.mjs (registry CLI subcommands). Missing
  // them from SOURCE_FILES silently broke those code paths prior to this fix.
  'registry-enricher.mjs', 'registry-github.mjs', 'registry-importer.mjs',
  // Shared SOURCE_FILES manifest — self-reference so `~/.claude-mem-lite/` can
  // re-run install.mjs (which imports this module) after an auto-update.
  'source-files.mjs',
  'install.mjs', 'install-metadata.mjs', 'mem-cli.mjs',
  'tier.mjs', 'tfidf.mjs',
  'nlp.mjs', 'synonyms.mjs', 'scoring-sql.mjs', 'stop-words.mjs', 'project-utils.mjs',
  'secret-scrub.mjs', 'format-utils.mjs', 'hash-utils.mjs', 'bash-utils.mjs',
  // Single source of truth for the CLAUDE_MEM_DIR → data-dir resolver (rejects a
  // stringified "undefined"/"null"/relative env instead of creating a stray dir).
  // Statically imported by schema.mjs / cli.mjs / install.mjs / registry-recommend.mjs
  // AND hook scripts (pre-tool-recall / post-tool-recall / pre-skill-bridge) — ship it
  // or auto-update leaves schema + every hook with ERR_MODULE_NOT_FOUND on each fire.
  'lib/resolve-data-dir.mjs',
  // lib/ — statically imported by hook-llm.mjs (activity) + hook-handoff.mjs (git-state, task-reader);
  // dynamically imported by hook.mjs (startup-dashboard) + mem-cli.mjs (doctor-benchmark, plan-reader).
  'lib/activity.mjs',
  'lib/cli-flags.mjs',
  'lib/task-reader.mjs',
  'lib/plan-reader.mjs',
  'lib/git-state.mjs',
  'lib/startup-dashboard.mjs',
  'lib/doctor-benchmark.mjs',
  'lib/doctor-drift.mjs',
  // DB-aware project pick for terminal-invoked CLI commands. Statically imported by
  // mem-cli.mjs, cli/activity.mjs and cli/doctor.mjs — ship it or every CLI command
  // throws ERR_MODULE_NOT_FOUND in installed/tarball runtimes.
  'lib/cli-project.mjs',
  'lib/stats-quality.mjs',
  'lib/low-signal-patterns.mjs',
  'lib/private-strip.mjs',
  'lib/citation-tracker.mjs',
  // v3.47 (D#78 P1): per-(obs,file) edge attribution. Imported by hook.mjs
  // (handleStop edge resolution). Missing from manifest → tarball hook.mjs
  // ERR_MODULE_NOT_FOUND on every Stop.
  'lib/edge-attribution.mjs',
  // v3.47 (D#78 P0): shared trigger-edge match predicate. Imported by BOTH
  // scripts/pre-tool-recall.js (hook fast-path) and lib/edge-attribution.mjs.
  'lib/file-edge-match.mjs',
  'lib/cite-back-hint.mjs',
  // The one definition of the pre-recall cooldown path — shared by its writer
  // (scripts/pre-tool-recall.js) and both readers (cite-back-hint, edge-attribution).
  'lib/cite-recall-path.mjs',
  'lib/frontmatter.mjs',
  'lib/cooldown-path.mjs',
  // v2.85: stale test-fixture sweeper. Imported by install.mjs (cleanup) + cli.mjs.
  // Missing from manifest → tarball ships install.mjs that ERR_MODULE_NOT_FOUND on cleanup.
  'lib/tmp-fixture-sweep.mjs',
  'lib/summary-extractor.mjs',
  'lib/id-routing.mjs',
  'lib/err-sampler.mjs',
  // v2.76.x: unsampled hook-script failure log. Imported by
  // scripts/pre-tool-recall.js + scripts/pre-skill-bridge.js (recorder)
  // and mem-cli.mjs (countRecentHookErrors for `stats`). Missing from
  // manifest → tarball ships hooks that ERR_MODULE_NOT_FOUND on every fire.
  'lib/hook-telemetry.mjs',
  // v3.0: read-time file-intelligence (①) + repeated-read guard (②). Imported
  // ONLY by scripts/pre-tool-recall.js (reread-guard also imports file-intel) —
  // NOT reachable from the 5 ENTRY_MODULES, so the hook-script coverage test in
  // source-files-sync.test.mjs is what keeps these from being dropped on bump.
  'lib/file-intel.mjs',
  'lib/reread-guard.mjs',
  'lib/handoff-constants.mjs',
  'lib/llm-call.mjs',
  'lib/metrics.mjs',
  'lib/quiet-scope.mjs',
  'lib/shard-gc.mjs',
  // v3.6.x: bind-salience producer — extracts identifiers a lesson names that
  // are present in the pre-edit file (component 2). Imported ONLY by
  // scripts/pre-tool-recall.js; kept here for the same reason as file-intel.mjs.
  'lib/lesson-idents.mjs',
  // Phase-2 task-imperative framing helper (2026-06-29): formatTaskImperative, the single
  // source of the imperative line. Statically imported by hook.mjs (live emitter, gated by
  // CLAUDE_MEM_TASK_IMPERATIVE) — must ship even with the flag off.
  'lib/task-imperative.mjs',
  // comprehension-bridge forcing-function (CLAUDE_MEM_SALIENCE=bridge): rewrites
  // a recalled lesson into a check bound to the change hunk. Dynamic-imported by
  // scripts/pre-tool-recall.js ONLY under the flag, but must still ship so the
  // hook can resolve it at runtime when a user opts in.
  'lib/lesson-bridge.mjs',
  // v2.71.x: better-sqlite3 ABI probe + auto-rebuild. Shared by install.mjs
  // (post-`npm install` verify) and scripts/launch.mjs (pre-server-launch
  // self-heal after Node ABI changes). Missing from manifest → auto-update
  // ships a stale install that FATALs on first DB open after Node upgrade.
  'lib/binding-probe.mjs',
  // Which code homes this machine runs (plugin cache / ~/.claude-mem-lite /
  // npm-global) — imported by install.mjs for doctor, status and rebuild-binding.
  // Missing from the manifest → an updated install ships a doctor that throws
  // ERR_MODULE_NOT_FOUND on the command users run when something is already wrong.
  'lib/install-shape.mjs',
  // Single-envelope stdout for hook processes — imported by hook.mjs. Claude Code
  // parses hook stdout as ONE JSON document; missing from the manifest → an updated
  // install throws ERR_MODULE_NOT_FOUND on every hook fire.
  'lib/hook-stdin.mjs',
  'lib/plugin-key.mjs',
  'lib/hook-stdout.mjs',
  // audit P0/P1: inter-process install lock + atomic config writes — imported by
  // install.mjs (settings.json + install lock) and hook-update.mjs (.claude.json
  // + auto-update lock). Must ship or a partial install/update skips them.
  'lib/proc-lock.mjs',
  'lib/atomic-write.mjs',
  'lib/proxy-fetch.mjs',
  'lib/llm-provider-probe.mjs',
  // P1 supply-chain: shared release-signing core (sha256 manifest + Ed25519
  // verify). Imported by hook-update.mjs (verify) + scripts/sign-release.mjs (CI
  // sign). Must ship or auto-update can't verify release signatures.
  'lib/release-digest.mjs',
  // v2.41 god-module split — mem-cli.mjs router + per-cmd handlers under cli/
  'cli/common.mjs',
  'cli/fts-check.mjs',
  'cli/doctor.mjs',
  'cli/activity.mjs',
  'server/fts-check.mjs',
  // v2.32 invited-memory: memdir primitives + adopt/unadopt CLI
  // v3.13 CLAUDE.md-steering: claudemd.mjs project-tree managed block + migration
  'memdir.mjs',
  'claudemd.mjs',
  'adopt-content.mjs',
  'adopt-cli.mjs',
  // P0 (v2.59.x): user-explicit "ignore memory" override detector. Lives
  // under lib/ (not scripts/) so hook.mjs can statically import it without
  // colliding with the scripts/ directory rename in installExtractedRelease
  // — see the SWITCHABLE_PATHS loop in hook-update.mjs.
  'lib/mem-override.mjs',
  // D#120: injected-ids marker file-name derivation, shared by hook.mjs +
  // scripts/user-prompt-search.js + scripts/pre-tool-recall.js. Under lib/ for
  // the same scripts-dir-rename reason as mem-override.mjs above.
  'lib/injected-ids.mjs',
  'lib/patha-exclude-meter.mjs',
  // P2-13 (narrowed): millisecond time units, single-sourced from the four
  // modules that each declared their own DAY_MS. Leaf module, zero imports.
  'lib/time-constants.mjs',
  // D#124: Key Context marker write + injection_count bump, shared by
  // handleSessionStart and handlePreCompact. Statically imported by hook.mjs.
  'lib/keyctx-marker.mjs',
  // P2-11: injection-side shared SQL core (live-row filter / clamped decay /
  // injection relevance chain). Statically imported by hook.mjs, hook-memory.mjs,
  // search-engine.mjs AND the standalone hook scripts — missing it from the
  // manifest kills every retrieval surface on auto-update.
  'lib/inject-search-core.mjs',
  // Error-triggered recall selection. Statically imported by hook.mjs (PostToolUse
  // injection) and by benchmark/error-recall-suite.mjs (offline calibration) — the
  // hook is the one that breaks on a missing manifest entry.
  'lib/error-recall-core.mjs',
  // D#170: the PostToolUseFailure gate. hook.mjs imports it on the failure path and
  // benchmark/error-recall-live-replay.mjs scores the SAME predicate, so a missing
  // registration would ship a hook that cannot load its own filter.
  'lib/tool-refusal.mjs',
  // Corpus-size ramp for absolute relevance floors. Imported by BOTH floor-bearing
  // injection faces: scripts/user-prompt-search.js (standalone hook) and
  // lib/error-recall-core.mjs. Missing here = UserPromptSubmit dies on auto-update.
  'lib/relevance-floor.mjs',
  // Shared UserPromptSubmit query caps — imported by BOTH hooks that event fires
  // (scripts/user-prompt-search.js and hook.mjs user-prompt via hook-memory.mjs).
  'lib/ups-query.mjs',
  // P2-12 twin cores: get/browse shared data collection for the CLI/MCP pairs
  // (update lives in observation-write, delete-preview in delete-core, registry
  // stats/list in registry.mjs — all already listed).
  'lib/get-core.mjs',
  'lib/browse-core.mjs',
  // v2.61 dedup refactor: shared "save one observation" pipeline used by both
  // mem-cli.mjs::cmdSave and server.mjs::mem_save. Statically imported from both
  // entry points; missing it from the manifest broke MCP saves on auto-update.
  'lib/save-observation.mjs',
  // Single-source observations-table write primitives (insertObservationRow/Files/
  // Vector). Statically imported by lib/save-observation.mjs and hook-llm.mjs (both
  // entry-point-reachable); missing it from the manifest would break ALL saves on
  // auto-update. Same single-source-of-truth pattern (see #8217).
  'lib/observation-write.mjs',
  'lib/recall-core.mjs',
  // Shared registry write core (import/remove/reindex + the 'installed' tier grant).
  // Statically imported by mem-cli.mjs AND server.mjs — missing it from the manifest
  // would break `registry import|remove|reindex` and mem_registry on auto-update.
  'lib/registry-core.mjs',
  // Shared timeline core (anchor resolution + before/after window) and shared
  // cross-source search core (sessions/prompts FTS, CJK fallback, normalization,
  // pagination math). Statically imported by mem-cli.mjs AND server.mjs — same
  // single-source-of-truth pattern; missing either from the manifest would break
  // `timeline`/`search` and mem_timeline/mem_search on auto-update.
  'lib/timeline-core.mjs',
  'lib/search-core.mjs',
  // Shared `recent` core (live-row filter + ORDER BY created_at DESC LIMIT).
  // Statically imported by mem-cli.mjs AND server.mjs — same single-source pattern;
  // missing it from the manifest would break `recent` and mem_recent on auto-update.
  'lib/recent-core.mjs',
  // Reciprocal Rank Fusion core (D#42 single source-of-truth); transitively
  // reached via tfidf.mjs (rrfMerge) and deep-search.mjs (rrfFuseN).
  'lib/rrf.mjs',
  // Shared "compress old low-value observations into weekly summaries" core.
  // Statically imported by mem-cli.mjs (cmdCompress), server.mjs (mem_compress),
  // and hook.mjs (handleAutoCompress) — same single-source-of-truth pattern as
  // save-observation.mjs; missing it from the manifest would break compress on auto-update.
  'lib/compress-core.mjs',
  // Shared maintenance ops (decay/cleanup/boost/demote/dedup/purge/vacuum/rebuild).
  // Statically imported by mem-cli.mjs (cmdMaintain), server.mjs (mem_maintain),
  // and hook.mjs (handleAutoMaintain) — missing it would break maintain on auto-update.
  'lib/maintain-core.mjs',
  'lib/fast-summary.mjs',
  'lib/transcript-scan.mjs',
  // Pre-maintenance VACUUM INTO snapshot (MED-2). Statically imported by mem-cli.mjs,
  // server.mjs, and hook.mjs before their destructive purge/cleanup — missing it
  // would crash maintain on auto-update with an unresolved import.
  'lib/db-backup.mjs',
  // HIGH-1 events-injection: surfaces the `events` canonical store into the passive
  // injection surfaces. Statically imported by hook.mjs (UserPromptSubmit) and
  // hook-context.mjs (SessionStart) — missing it from the manifest would break both
  // hooks on auto-update.
  'lib/events-injection.mjs',
  // Shared delete orchestration (snapshot + related_ids cleanup + child recovery
  // + delete txn). Statically imported by server.mjs (mem_delete) and mem-cli.mjs
  // (cmdDelete) — extracted to kill the byte-duplicated twin. Missing it from the
  // manifest would leave both delete surfaces unsigned/broken on auto-update.
  'lib/delete-core.mjs',
  // Shared primary stats feed (audit 2026-07-17 MED-4) — statically imported by
  // server.mjs (mem_stats) and mem-cli.mjs (cmdStats); killed the ~80-line
  // byte-duplicated twin. Missing it breaks both stats surfaces on auto-update.
  'lib/stats-core.mjs',
  // Observation `type` vocabulary single source (audit 2026-07-17 MED-3) —
  // statically imported by tool-schemas.mjs, mem-cli.mjs, hook-llm.mjs,
  // hook-optimize.mjs, lib/activity.mjs. Missing it breaks every save/validate
  // path on auto-update.
  'lib/obs-types.mjs',
  // Save-time lesson nudge (audit 2026-07-17 P4) — statically imported by server.mjs
  // (mem_save) and mem-cli.mjs (cmdSave). Missing it breaks both save surfaces on
  // auto-update.
  'lib/save-nudge.mjs',
  'lib/save-enrich.mjs',
  'lib/persist-reminder.mjs',
  // P10 dedup/merge threshold constants — single source of truth for the Jaccard
  // dedup/merge cutoffs. Statically imported by hook.mjs, hook-llm.mjs,
  // hook-optimize.mjs, mem-cli.mjs, server.mjs, and the save/maintain cores;
  // missing it from the manifest would break those paths on auto-update.
  'lib/dedup-constants.mjs',
  // Numeric env-override parsing with an explicit failure mode. Statically imported
  // by scripts/user-prompt-search.js (a HOOK entry point — a missing manifest entry
  // kills the UserPromptSubmit face outright on auto-update), lib/relevance-floor.mjs
  // and lib/cite-back-hint.mjs.
  'lib/env-number.mjs',
  // v2.70 deferred-work: carry-forward TODO primitives. Statically imported by
  // server.mjs (mem_defer family) and mem-cli.mjs (defer subcommand).
  'lib/deferred-work.mjs',
  // v2.70 one-shot upgrade banner. Split out of hook.mjs because hook.mjs has
  // module-level `process.exit(0)` side effects that abort vitest workers on
  // direct import. Statically imported by hook.mjs SessionStart handler.
  'lib/upgrade-banner.mjs',
  // Per-table scrub helper for defense-in-depth at text-write INSERT paths.
  // Statically imported by hook-llm, hook-handoff, hook-optimize, hook,
  // mem-cli; reached transitively from server.mjs and cli.mjs.
  'lib/scrub-record.mjs',
  // Rate-limited friendly hint for an unloadable native DB binding
  // (ERR_DLOPEN_FAILED). Statically imported by hook.mjs; ship it so the
  // dispatch catch path resolves in installed/tarball runtimes.
  'lib/native-binding-hint.mjs',
  // Cold-start backfill: parses ~/.claude/projects/<encoded>/<uuid>.jsonl
  // transcripts into user_prompts + observations. Dynamic-imported by
  // mem-cli.mjs::cmdImportJsonl; listed here so source-files-sync.test.mjs
  // and the npm tarball ship it on every release.
  'lib/import-jsonl.mjs',
  // v3.42 HIGH-2: single source of truth for the export/restore round-trippable column
  // set. Statically imported by server.mjs (mem_export) and mem-cli.mjs (cmdExport) so the
  // two export surfaces can't drift. Must ship or auto-update breaks export on either.
  'lib/export-columns.mjs',
];

/**
 * Hook scripts that direct-install (non-plugin) mode must materialize under
 * ~/.claude-mem-lite/scripts/ — settings.json hook commands resolve to these
 * absolute paths. Plugin mode does not consume this directory (it runs scripts
 * from ${CLAUDE_PLUGIN_ROOT} instead).
 *
 * Single source of truth for both install.mjs (initial install) and
 * hook-update.mjs (auto-update): pre-v2.55 hook-update copied the entire
 * scripts/ tree from the GitHub Releases tarball, which silently shipped
 * dev-only files (mock-claude.mjs, extract-repos.mjs, p0-forward-probe.mjs…)
 * to every user's data dir on the first auto-update.
 */
export const HOOK_SCRIPT_FILES = [
  'post-tool-use.sh',
  'user-prompt-search.js',
  'prompt-search-utils.mjs',
  'pre-tool-recall.js',
  'post-tool-recall.js',
  'pre-skill-bridge.js',
  // The Agent|Task hook command in BOTH registration sites is now the .sh prefilter,
  // which execs the .js only when CLAUDE_MEM_SUBAGENT_INJECT is on (audit P2-5). Both
  // must be materialized: shipping the prefilter without its target turns every
  // opt-in dispatch into a silent no-op, and shipping the target without the
  // prefilter leaves the registered hook command pointing at a file that is not there.
  'pre-agent-inject.sh',
  'pre-agent-inject.js',
  // v2.84: self-heal wrapper that detects ERR_MODULE_NOT_FOUND under the
  // install dir and runs install.mjs repair before retrying the entry.
  // hooks.json + install.mjs settings template invoke node hook entries
  // through this wrapper so any partial-install drift heals automatically.
  'hook-launcher.mjs',
];

// Executable scripts that are NOT direct-install hook scripts (so they don't belong in
// HOOK_SCRIPT_FILES, which install.mjs materializes into ~/.claude-mem-lite/scripts/) but
// ARE run at runtime and MUST be signed:
//   - launch.mjs / launch-preflight.mjs: the plugin MCP server (.mcp.json runs
//     ${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs; launch.mjs imports launch-preflight.mjs).
//     install.mjs::dedupePluginCacheAndHooks copies BOTH from the tarball into every plugin
//     cache version dir during repair() — an unsigned launcher let a release published
//     without the signing key (reusing the real manifest+sig) swap launch.mjs and gain RCE
//     as the MCP server. v3.42 audit HIGH-1.
//   - setup.sh: run on plugin SessionStart via hooks.json. Signed for defense-in-depth
//     (no tarball→executed-path propagation today, but it ships in files[] and is executed).
//   - binding-probe-cli.mjs: setup.sh spawns it on every SessionStart that misses the ABI
//     marker, and it runs `npm rebuild` — an unsigned copy would be arbitrary code executed
//     at session start with a build step attached. Same class as setup.sh itself.
// These ship via package.json files[] directly, not via HOOK_SCRIPT_FILES' copy path, so
// listing them here changes ONLY what is signed/verified, not what install materializes.
// Module-internal (spread into RELEASE_SIGNED_FILES below); not exported — no external
// consumer, and the signing test asserts coverage via the built manifest, not this list.
const LAUNCHER_SCRIPT_FILES = [
  'launch.mjs',
  'launch-preflight.mjs',
  'setup.sh',
  'binding-probe-cli.mjs',
];

// Plugin/marketplace DECLARATION files (audit 2026-08-14 P-2). Not executable
// themselves, but they NAME what gets executed: hooks/hooks.json declares the
// command lines Claude Code runs on every hook fire, .mcp.json declares the MCP
// server launch command, plugin.json/marketplace.json steer the install source,
// commands/*.md are model-visible skill bodies, registry/preinstalled.json seeds
// the resource registry. All ship in the tarball; none were signed — the same
// shape as the two closed RCE gaps (hook scripts v3.40, launch.mjs v3.42): a
// release published without the signing key could swap hooks.json to point a
// hook event at an arbitrary command while every signed hash still matched.
// Additive: buildReleaseManifest skips entries absent at sign time, and
// verifyReleaseFiles needs no change to enforce whatever the manifest carries.
const PLUGIN_DECLARATION_FILES = [
  'hooks/hooks.json',
  '.mcp.json',
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  'registry/preinstalled.json',
  'commands/mem.md',
  'commands/memory.md',
  'commands/update.md',
  'commands/tools.md',
  'commands/adopt.md',
  'commands/unadopt.md',
  'commands/lesson.md',
  'commands/bug.md',
];

// The complete set of files the release signature MUST cover: every runtime .mjs
// (SOURCE_FILES) PLUS the executable hook scripts (copyReleaseIntoStaging installs these
// into the live dir and they run on every hook fire) PLUS the launcher/setup scripts
// PLUS the plugin declaration files above.
// HOOK_SCRIPT_FILES were historically NOT in the signed manifest, so an attacker able to
// PUBLISH a release — but without the signing key — could swap a hook script (e.g.
// post-tool-use.sh / hook-launcher.mjs) while every SOURCE_FILES hash still matched, and
// fail-closed verification would still pass → RCE on the next hook fire. The MCP launcher
// (LAUNCHER_SCRIPT_FILES) was the same gap reopened for the plugin+repair path (v3.42
// HIGH-1). Keys are ROOT-relative, matching the extracted-tarball layout that
// verifyReleaseFiles hashes against.
export const RELEASE_SIGNED_FILES = [
  ...SOURCE_FILES,
  ...HOOK_SCRIPT_FILES.map(name => `scripts/${name}`),
  ...LAUNCHER_SCRIPT_FILES.map(name => `scripts/${name}`),
  ...PLUGIN_DECLARATION_FILES,
];
