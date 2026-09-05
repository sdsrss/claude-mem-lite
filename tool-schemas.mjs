// Shared Zod schemas for MCP tool inputs
// Single source of truth — used by server.mjs (runtime) and contract.test.mjs (validation tests)

import { z } from 'zod';
import { CLI_INVOKE } from './cli-path.mjs';
import { OBS_TYPES } from './lib/obs-types.mjs';

export const OBS_TYPE_ENUM = z.enum([...OBS_TYPES]);

// LLM-friendly coercion: accept string numbers and normalize to proper types
const coerceInt = z.preprocess(
  (v) => (typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? parseInt(v.trim(), 10) : v),
  z.number().int(),
);

// LLM-friendly coercion: accept "true"/"false"/"True"/"TRUE" strings as boolean
const coerceBool = z.preprocess(
  (v) => (typeof v === 'string' ? ({ true: true, false: false }[v.toLowerCase()] ?? v) : v),
  z.boolean(),
);

// Coerce ids: accept single number, string "123", comma-separated "1,2,3", or array
const coerceIntArray = z.preprocess((v) => {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? parseInt(x, 10) : x));
  if (typeof v === 'number') return [v];
  if (typeof v === 'string')
    return v
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));
  return v;
}, z.array(z.number().int()));

// Coerce string arrays: accept array, comma-separated string, JSON-array string, or bare string.
// MCP bridges sometimes JSON-stringify complex args — bare `z.array(z.string())` rejects those
// with "expected array, received string" and the caller loses the field silently. Parity with
// coerceIntArray: tolerate the same shapes so files/fields survive client serialization quirks.
const coerceStringArray = z.preprocess((v) => {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String(x)));
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('[') && s.endsWith(']')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed.map((x) => (typeof x === 'string' ? x : String(x)));
      } catch {
        /* fall through to comma-split */
      }
    }
    return s
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  }
  return v;
}, z.array(z.string()));

// Coerce mixed ID tokens (#N / P#N / S#N / D#N / bare N) for mem_get. Accepts:
//   - native arrays: [1, "P#2", "#3"]
//   - single number: 1
//   - single/comma string: "1,P#2,S#3"
//   - JSON-array string: '[1,"P#2"]' (MCP bridges that stringify complex args)
// Piped to a regex-validated string[] so each token stays parseable by lib/id-routing.parseIdToken
// at the handler. Closes the CLI↔MCP gap noted in #8127.
const coerceMixedIdTokens = z.preprocess(
  (v) => {
    const norm = (x) => (typeof x === 'string' ? x.trim() : String(x));
    if (Array.isArray(v)) return v.map(norm).filter((s) => s.length > 0);
    if (typeof v === 'number') return [String(v)];
    if (typeof v === 'string') {
      const s = v.trim();
      if (s.startsWith('[') && s.endsWith(']')) {
        try {
          const parsed = JSON.parse(s);
          if (Array.isArray(parsed)) return parsed.map(norm).filter((x) => x.length > 0);
        } catch {
          /* fall through to comma-split */
        }
      }
      return s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    }
    return v;
  },
  // D#N (deferred_work) requires the `#` — bare "D92" is prose, not a token.
  // Round-trip rule: `defer list` renders "(D#92)", so mem_get must accept it
  // back (tests/schema-roundtrip.test.mjs). Delete/timeline keep rejecting D#.
  z
    .array(z.string().regex(/^(?:[Dd]#|[EePpSs]?#?)\d+$/, 'Expected N, #N, P#N, S#N, E#N, or D#N'))
    .min(1)
    .max(20),
);

export const memSearchSchema = {
  query: z.string().optional().describe('Search query (FTS5 syntax supported)'),
  type: z
    .enum(['observations', 'sessions', 'prompts', 'events'])
    .optional()
    .describe(
      'Limit to one source table (default: all). events = the canonical bugfix/feature/decision/lesson history (auto-captured event-typed memories)',
    ),
  obs_type: OBS_TYPE_ENUM.optional().describe('Filter observation type'),
  project: z.string().optional().describe('Filter by project name'),
  date_from: z.string().optional().describe('Start date (ISO 8601 or YYYY-MM-DD)'),
  date_to: z
    .string()
    .optional()
    .describe('End date (ISO 8601 or YYYY-MM-DD). Date-only format is inclusive (covers full day)'),
  date_since: z
    .string()
    .optional()
    .describe(
      'Relative lower bound from now: 7d/24h/90m/2w/30s. Use for "recent" queries instead of computing a date_from; ignored when date_from is set',
    ),
  importance: coerceInt
    .pipe(z.number().int().min(1).max(3))
    .optional()
    .describe('Minimum importance (1=routine, 2=notable, 3=critical)'),
  branch: z.string().optional().describe('Filter by git branch name'),
  tier: z
    .enum(['working', 'active', 'archive'])
    .optional()
    .describe(
      'Filter by memory tier (working=current session, active=within decay window, archive=old/compressed)',
    ),
  limit: coerceInt.pipe(z.number().int().min(1).max(100)).optional().describe('Max results (default 20)'),
  offset: coerceInt.pipe(z.number().int().min(0)).optional().describe('Offset for pagination'),
  sort: z
    .enum(['relevance', 'time', 'importance'])
    .optional()
    .describe('Sort order: relevance (default, BM25), time (newest first), importance (highest first)'),
  include_noise: coerceBool
    .optional()
    .describe(
      'Include hook-llm fallback titles ("Modified X", "Worked on X", raw error logs) — hidden by default as they have ~3% access rate',
    ),
  or: coerceBool
    .optional()
    .describe(
      'Force OR semantics between query terms from the start (default: AND with automatic OR-fallback when AND returns 0). Aligns with CLI --or.',
    ),
  deep: coerceBool
    .optional()
    .describe(
      'Tri-state LLM multi-query/HyDE deep search (observations-only). true=force; false=never; omit=AUTO (default ON for mem_search): a normal search that returns weak/few results auto-escalates with ONE Haiku call (query rewritten to keyword/concept/HyDE variants, RRF-fused). Set CLAUDE_MEM_AUTO_DEEP=0 to disable AUTO. Passive recall stays single-query.',
    ),
  rerank: coerceBool
    .optional()
    .describe(
      'Opt-in: LLM-rerank the deep-search candidates for ranking precision (one extra Haiku call, ~1.4s). Requires deep=true (no effect on AUTO/normal). Reserve for hard, ranking-sensitive queries where the right memory is likely retrieved but mis-ranked — skip for routine search. Default off.',
    ),
  // ── CLI-flag aliases (v3.61.0) ──────────────────────────────────────────────
  // A property the schema doesn't declare is STRIPPED by the validator, so a caller
  // using the CLI vocabulary (`--source` / `--from` / `--to` / `--since`) previously
  // got the UNFILTERED answer with nothing marking the filter as dropped — a wider
  // result set that reads as filtered. Declaring the aliases makes the filter apply;
  // the canonical name wins when both are supplied. Mirror of v3.59.0, which taught
  // the CLI to accept MCP field names.
  source: z
    .enum(['observations', 'sessions', 'prompts', 'events'])
    .optional()
    .describe(
      'Alias for `type` (CLI `search --source`). Note: CLI `--type` is the OBSERVATION type — that is `obs_type` here.',
    ),
  from: z.string().optional().describe('Alias for `date_from` (CLI `search --from`)'),
  to: z.string().optional().describe('Alias for `date_to` (CLI `search --to`)'),
  since: z.string().optional().describe('Alias for `date_since` (CLI `search --since`)'),
};

export const memRecentSchema = {
  limit: coerceInt.pipe(z.number().int().min(1).max(100)).optional().describe('Max results (default 10)'),
  project: z.string().optional().describe('Filter by project (default: inferred from CWD)'),
  obs_type: OBS_TYPE_ENUM.optional().describe(
    'Filter observation type (e.g. bugfix, decision) — CLI `recent --type` parity',
  ),
  date_since: z
    .string()
    .optional()
    .describe(
      'Relative lower bound from now: 7d/24h/90m/2w/30s. Only items newer than the window (pair with a high limit for "everything since X")',
    ),
  // CLI-flag aliases — see the note on memSearchSchema. `recent --type` IS the
  // observation type here (unlike `search --type`, which the CLI spells `--source`),
  // so `type` maps to obs_type on this tool.
  type: OBS_TYPE_ENUM.optional().describe('Alias for `obs_type` (CLI `recent --type`)'),
  since: z.string().optional().describe('Alias for `date_since` (CLI `recent --since`)'),
};

// Anchor accepts plain int, "123" string-int, or prefixed token from search output:
// "#123" / "P#123" (prompt) / "S#123" (session). Prompt/session anchors resolve to
// the nearest-in-time observation so timeline semantics still apply. CLI --anchor
// parity per #8050 (CLI has supported prefixed tokens since v2.39.0).
const coerceAnchor = z.preprocess(
  (v) => {
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^-?\d+$/.test(s)) return parseInt(s, 10);
      return s;
    }
    return v;
  },
  z.union([z.number().int(), z.string().regex(/^[EePpSs]?#?\d+$/, 'Expected N, #N, P#N, S#N, or E#N')]),
);

export const memTimelineSchema = {
  anchor: coerceAnchor
    .optional()
    .describe(
      'Anchor as observation ID (int) or prefixed token string: "#123", "P#123" (prompt → nearest obs), "S#123" (session → nearest obs), "E#123" (event → nearest obs). Takes precedence over query.',
    ),
  query: z
    .string()
    .optional()
    .describe('FTS5 query to auto-find anchor. Ignored when anchor is also given; use one or the other.'),
  before: coerceInt
    .pipe(z.number().int().min(0).max(50))
    .optional()
    .describe('Items before anchor (default 5)'),
  after: coerceInt
    .pipe(z.number().int().min(0).max(50))
    .optional()
    .describe('Items after anchor (default 5)'),
  project: z.string().optional().describe('Filter by project'),
};

export const memGetSchema = {
  // Accepts mixed tokens so pasted search results work verbatim: [1], [1, "P#2"], "1,P#2,S#3",
  // or the JSON-stringified form ["1","P#2"]. Each token's prefix routes to its source bucket
  // in server.mjs via lib/id-routing.bucketIdTokens. An explicit `source` override still wins.
  ids: coerceMixedIdTokens.describe(
    'Mixed observation/prompt/session/event/deferred IDs — accepts N, #N, P#N, S#N, E#N, D#N; comma-strings and JSON arrays also coerced. D#N reads a deferred_work item with FULL detail (defer list is title-only)',
  ),
  source: z
    .enum(['obs', 'session', 'prompt', 'event'])
    .optional()
    .describe(
      'Force all IDs to this source (overrides per-token prefixes). Omit to let P#/S#/E#/# prefixes route individually. D#N tokens are exempt — they always read deferred_work.',
    ),
  fields: coerceStringArray
    .optional()
    .describe(
      'Specific fields to return (default: all; validated against obs schema — session/prompt sources ignore this filter)',
    ),
};

export const memDeleteSchema = {
  ids: coerceIntArray.pipe(z.array(z.number().int()).min(1).max(50)).describe('Observation IDs to delete'),
  confirm: coerceBool.describe('false=preview what will be deleted, true=execute deletion'),
};

// Coerce closes_deferred input — accepts mixed array of integers (ordinals) and
// "D#<n>" strings (raw ids). Numeric strings are coerced to numbers (so MCP
// bridges that JSON-stringify ints don't drop them); D#-prefixed strings stay
// strings for the resolver. Other string shapes reject early at schema layer.
const coerceDeferredTokens = z.preprocess(
  (v) => {
    if (Array.isArray(v)) {
      return v.map((x) => {
        if (typeof x === 'number') return x;
        if (typeof x === 'string') {
          const s = x.trim();
          if (/^-?\d+$/.test(s)) return parseInt(s, 10);
          return s;
        }
        return x;
      });
    }
    return v;
  },
  z
    .array(
      z.union([
        z.number().int().positive(),
        z.string().regex(/^D#\d+$/, 'expected D#N (raw id) or positive integer (ordinal)'),
      ]),
    )
    .min(1)
    .max(20),
);

// Coerce supersedes input — positive observation ids, plus `E#<n>` for an EVENT row
// (D#205), which is the prefix those rows are rendered with in the injected lessons
// block. Numeric strings are accepted because some MCP bridges JSON-stringify ints;
// `E#<n>` is kept as a STRING and split by `splitSupersedeTokens`, since coercing it to
// a number here would lose the only thing that says which table it names.
// Empty/other shapes reject.
const coerceSupersedes = z.preprocess(
  (v) =>
    Array.isArray(v)
      ? v.map((x) => (typeof x === 'string' && /^\d+$/.test(x.trim()) ? parseInt(x.trim(), 10) : x))
      : v,
  z
    .array(
      z.union([
        z.number().int().positive(),
        z.string().regex(/^[Ee]#?\d+$/, 'expected a positive observation id or E#<n> for an event'),
      ]),
    )
    .min(1)
    .max(20),
);

export const memSaveSchema = {
  content: z.string().min(1).max(50000).describe('Memory content to save'),
  title: z.string().optional().describe('Short title'),
  type: OBS_TYPE_ENUM.optional().describe('Observation type (default: discovery)'),
  // Alias, same treatment memRecentSchema gives `type`. mem_search/mem_recall/mem_recent
  // all name this field `obs_type`, mem_save named it only `type`, and the schema is
  // non-strict — so `mem_save(obs_type: "bugfix")` (the shape a caller reaches for right
  // after a search) dropped the unknown key and saved a `discovery` row with no error.
  // A silently-wrong type changes type_quality ranking AND makes the row invisible to
  // every `--type bugfix` filter, so it must not be a silent coercion.
  obs_type: OBS_TYPE_ENUM.optional().describe('Alias for `type` (parity with mem_search/mem_recent)'),
  project: z.string().optional().describe('Project name (default: inferred from CWD)'),
  importance: coerceInt
    .pipe(z.number().int().min(1).max(3))
    .optional()
    .describe('Importance level: 1=routine, 2=notable, 3=critical (default: 2 for explicit saves)'),
  files: coerceStringArray
    .optional()
    .describe(
      'File paths associated with this observation. Stored in the `files_modified` column and rendered as `files` — passing a path here does not assert the file was edited; a file you only read belongs here too',
    ),
  lesson_learned: z
    .string()
    .max(500)
    .optional()
    .describe('Key lesson or takeaway, ≤500 chars (for bugfix: root cause & fix; for decision: rationale)'),
  closes_deferred: coerceDeferredTokens
    .optional()
    .describe(
      'Close one or more deferred_work items in the same project. Mixed array: bare integer = ordinal-within-project, "D#<n>" string = raw id. Transactional with the obs insert — a single invalid id rolls back the whole save.',
    ),
  supersedes: coerceSupersedes
    .optional()
    .describe(
      'Ids (same project) that this save overturns: a bare number for an observation, or E#<n> for an event — the same prefix events are shown with in the injected lessons block, so you can retire one by typing back what you read. They are marked superseded (dropped from live search); observations are also linked to the new row via superseded_by, events are not, because that column can only reference another event. Use ONLY when this genuinely replaces a prior conclusion; do NOT use for merely-related or updated-but-still-valid memories.',
    ),
};

export const memStatsSchema = {
  project: z.string().optional().describe('Filter by project'),
  days: coerceInt.pipe(z.number().int().min(1).max(365)).optional().describe('Look back N days (default 30)'),
  quality: coerceBool
    .optional()
    .describe(
      'Return quality dashboard (lesson rate, LOW_SIGNAL rate, per-type hit/lesson %, top-accessed lessons, R-2 watchdog) instead of default stats. Aligns with CLI --quality.',
    ),
};

export const memCompressSchema = {
  preview: coerceBool.optional().describe('true=count candidates, false=execute compression (default: true)'),
  age_days: coerceInt
    .pipe(z.number().int().min(30).max(365))
    .optional()
    .describe('Min age in days (default: 30, minimum: 30)'),
  project: z.string().optional().describe('Filter by project'),
};

export const memOptimizeSchema = {
  action: z
    .enum(['preview', 'run', 'run_all'])
    .optional()
    .default('preview')
    .describe('preview=scan candidates, run=execute with limits, run_all=bypass gates'),
  tasks: z
    .array(z.enum(['re-enrich', 'normalize', 'cluster-merge', 'smart-compress']))
    .optional()
    .describe('Which optimization tasks to run (default: all)'),
  max_items: coerceInt
    .pipe(z.number().int().min(1).max(100))
    .optional()
    .default(15)
    .describe('Maximum LLM calls across all tasks (default: 15)'),
  scope: z
    .enum(['narrow', 'wide'])
    .optional()
    .default('narrow')
    .describe(
      "Re-enrich scope: narrow=narrative-only candidates (default); wide=R-7 backfill (bugfix/refactor/feature/decision with narrative but lesson_learned='none'). CLI parity: --scope wide.",
    ),
  project: z
    .string()
    .optional()
    .describe('Filter all 4 tasks to a single project. Default: scan all projects.'),
  detail: coerceBool
    .optional()
    .describe(
      'preview action only — include cluster contents + re-enrich/compress sample arrays alongside aggregate counts.',
    ),
};

export const memMaintainSchema = {
  action: z.enum(['scan', 'execute']).describe('scan=analyze candidates, execute=apply changes'),
  operations: z
    .array(
      z.enum([
        'dedup',
        'decay',
        'cleanup',
        'boost',
        'demote_pinned',
        'purge_stale',
        'rebuild_vectors',
        'vacuum',
      ]),
    )
    .optional()
    .describe(
      'Operations: dedup=find/merge duplicate observations, decay=reduce importance of old low-value obs, cleanup=remove orphaned records, boost=promote frequently-accessed obs, demote_pinned=floor importance for obs injected>=8 times but never cited — to 1 with no lesson_learned, to 2 with one (v3.76.1: a lesson-bearing row keeps eligibility on every importance>=2 injection face) (clears pinned noise the decay op cannot reach; in the default set since v3.76.0 and ordered after boost, since boost would otherwise raise the row straight back — set CLAUDE_MEM_SKIP_DEMOTE_PINNED=1 to drop it from the DEFAULT set only), purge_stale=DELETE pending-purge obs older than retain_days (requires confirm=true; first call previews), rebuild_vectors=rebuild TF-IDF vocabulary and all observation vectors, vacuum=reclaim freelist dead space (whole-DB)',
    ),
  merge_ids: z
    .preprocess(
      (v) =>
        Array.isArray(v)
          ? v.map((g) => (Array.isArray(g) ? g.map((x) => (typeof x === 'string' ? parseInt(x, 10) : x)) : g))
          : v,
      z.array(z.array(z.number().int()).min(2)),
    )
    .optional()
    .describe('For dedup: [[keepId, removeId1, removeId2], ...] — first ID in each group is kept'),
  retain_days: coerceInt
    .pipe(z.number().int().min(7).max(365))
    .optional()
    .describe('For purge_stale: keep observations newer than N days (default 30)'),
  confirm: coerceBool
    .optional()
    .describe(
      'Required for destructive ops in `execute` mode (currently: purge_stale). Omit/false → dry-run preview; true → actually delete.',
    ),
  project: z.string().optional().describe('Filter by project'),
};

export const memUpdateSchema = {
  id: coerceInt.pipe(z.number().int().positive()).describe('Observation ID to update'),
  // CLI parity (cmdUpdate): empty/whitespace title would render as `(untitled)`
  // in every listing — reject here like the CLI does, instead of persisting it.
  title: z
    .string()
    .refine((s) => s.trim() !== '', 'title cannot be empty')
    .optional()
    .describe('New title'),
  // Reject empty content fields (parity with `title` above + cmdUpdate): an explicit
  // '' would blank narrative/lesson/concepts irrecoverably (mem_update takes no snapshot).
  narrative: z
    .string()
    .refine((s) => s.trim() !== '', 'narrative cannot be empty')
    .optional()
    .describe('New narrative/content'),
  type: OBS_TYPE_ENUM.optional().describe('New observation type'),
  // Same alias as memSaveSchema, for the same reason and found by the same review: without
  // it `mem_update({id, importance: 3, obs_type: 'bugfix'})` reported
  // "Updated observation #N: importance" and dropped the type silently. (obs_type alone
  // errored loudly with "No fields to update", so only the mixed call was dangerous.)
  obs_type: OBS_TYPE_ENUM.optional().describe('Alias for `type` (parity with mem_search/mem_recent)'),
  importance: coerceInt.pipe(z.number().int().min(1).max(3)).optional().describe('New importance (1-3)'),
  // 500-char cap mirrors memSaveSchema + cmdUpdate — update was the one path
  // that let overlong lessons leak into the DB via MCP.
  lesson_learned: z
    .string()
    .max(500)
    .refine((s) => s.trim() !== '', 'lesson_learned cannot be empty')
    .optional()
    .describe('Add or update lesson learned'),
  concepts: z
    .string()
    .refine((s) => s.trim() !== '', 'concepts cannot be empty')
    .optional()
    .describe('Space-separated concept tags'),
};

export const memExportSchema = {
  project: z.string().optional().describe('Filter by project'),
  type: OBS_TYPE_ENUM.optional().describe('Filter by observation type'),
  format: z.enum(['json', 'jsonl']).optional().describe('Output format (default: json)'),
  date_from: z.string().optional().describe('Start date (ISO 8601 or YYYY-MM-DD)'),
  date_to: z.string().optional().describe('End date (ISO 8601 or YYYY-MM-DD)'),
  // CLI-flag aliases — `export` reads flags.from / flags.to (mem-cli.mjs). Same
  // silent-drop defect the search/recent aliases fix, and the widest blast radius of
  // the three: an ignored bound exports the whole DB instead of a date slice.
  from: z.string().optional().describe('Alias for `date_from` (CLI `export --from`)'),
  to: z.string().optional().describe('Alias for `date_to` (CLI `export --to`)'),
  include_compressed: coerceBool.optional().describe('Include compressed observations (default: false)'),
  // No upper bound: this is the BACKUP tool ("USE when: Backing up memory before a
  // migration or reinstall"), and a 1000-row ceiling made a complete backup of a bigger
  // store impossible over MCP while the CLI twin exported everything (audit 2026-08-14 A2).
  // The default stays 200 because an MCP result is model context — a bare exploratory call
  // must not dump a whole store into the transcript — but a capped result now announces
  // itself as PARTIAL and names the limit that would return all of it.
  limit: coerceInt
    .pipe(z.number().int().min(1))
    .optional()
    .describe(
      'Max observations to export (default: 200 — a capped result is flagged PARTIAL and names the total; pass that total for a complete backup, no upper bound)',
    ),
};

export const memRecallSchema = {
  file: z.string().min(1).describe('File path or filename to recall observations for'),
  limit: coerceInt.pipe(z.number().int().min(1).max(50)).optional().describe('Max results (default 10)'),
  include_noise: coerceBool
    .optional()
    .describe(
      'Include hook-llm fallback titles ("Modified X", "Worked on X", raw error logs) — hidden by default for parity with mem_search',
    ),
};

export const memFtsCheckSchema = {
  action: z.enum(['check', 'rebuild']).describe('check=verify FTS integrity, rebuild=rebuild FTS indexes'),
};

export const memRegistrySchema = {
  action: z
    .enum(['list', 'stats', 'search', 'import', 'remove', 'reindex', 'import_url', 'enrich'])
    .describe('Registry operation'),
  query: z.string().optional().describe('Search query — keywords describing what you need (for search)'),
  type: z.enum(['skill', 'agent']).optional().describe('Filter by resource type (for list/search)'),
  name: z.string().optional().describe('Resource name (for import/remove)'),
  resource_type: z.enum(['skill', 'agent']).optional().describe('Resource type (for import/remove)'),
  source: z
    .enum(['preinstalled', 'user', 'github'])
    .optional()
    .describe('Source (for import, default: user)'),
  repo_url: z.string().optional().describe('GitHub repository URL (for import)'),
  local_path: z.string().optional().describe('Local file path (for import)'),
  invocation_name: z.string().optional().describe('Invocation name like "plugin:skill" (for import)'),
  intent_tags: z.string().optional().describe('Comma-separated intent tags (for import)'),
  domain_tags: z.string().optional().describe('Comma-separated domain/tech tags (for import)'),
  trigger_patterns: z.string().optional().describe('When to recommend this tool (for import)'),
  capability_summary: z.string().optional().describe('What this tool does (for import)'),
  keywords: z.string().optional().describe('Search keywords (for import)'),
  tech_stack: z.string().optional().describe('Technology stack tags (for import)'),
  use_cases: z.string().optional().describe('Usage scenarios (for import)'),
  url: z.string().optional().describe('GitHub repository URL (for import_url action)'),
  enrich: coerceBool.optional().describe('Auto-enrich imported resources (for import_url action)'),
  category: z
    .string()
    .optional()
    .describe("Filter by category (e.g., 'testing', 'code-quality', 'debugging')"),
  quality: z
    .enum(['installed', 'verified', 'community'])
    .optional()
    .describe('Filter by quality tier (default: all)'),
};

export const memUseSchema = {
  name: z.string().min(1).describe('Skill or agent name to load (exact name or search query)'),
  type: z.enum(['skill', 'agent']).optional().describe('Resource type (default: skill)'),
};

export const memBrowseSchema = {
  project: z.string().optional().describe('Filter by project (default: inferred from CWD)'),
  tier: z.enum(['working', 'active', 'archive']).optional().describe('Show only this tier'),
  limit: coerceInt
    .pipe(z.number().int().min(1).max(100))
    .optional()
    .describe('Max entries per tier (default 5, or 20 when filtering by tier)'),
};

export const memDeferSchema = {
  title: z.string().min(1).max(200).describe('One-line subject of the deferred item'),
  priority: coerceInt
    .pipe(z.number().int().min(1).max(3))
    .optional()
    .describe('1=low, 2=normal, 3=urgent (default: 2)'),
  detail: z.string().max(2000).optional().describe('Optional longer description / constraint / why deferred'),
  files: coerceStringArray.optional().describe('Optional file paths this deferred item concerns'),
  project: z.string().optional().describe('Project name (default: inferred from CWD)'),
};

export const memDeferListSchema = {
  project: z.string().optional().describe('Project name (default: inferred from CWD)'),
  limit: coerceInt.pipe(z.number().int().min(1).max(50)).optional().describe('Max results (default 10)'),
};

export const memDeferDropSchema = {
  id: z
    .union([
      coerceInt.pipe(z.number().int().positive()),
      z.string().regex(/^D#\d+$/, 'expected D#N or positive integer'),
    ])
    .describe('Deferred item id — accepts D#N (raw id) or positive integer (ordinal-within-project)'),
  reason: z.string().min(1).max(500).describe('Why this item is being dropped (required for audit trail)'),
  project: z.string().optional().describe('Project name (default: inferred from CWD)'),
};

// ────────────────────────────────────────────────────────────────────────────
// Tool descriptions — discouragement style (Task 5, v2.31)
//
// Every entry follows a fixed template so Claude can skim quickly:
//   <one-line purpose>
//   DO NOT use when: ... (most common misuse / redundant-with-builtin)
//   USE when: ......... (high-value triggers)
//   Equivalent CLI: .... (or "MCP only" if no CLI handler exists)
//
// Research note: discouragement-style descriptions reduce over-invocation by
// 40-60% vs. encouragement-style ("use this to..."). See tests/tool-schemas.test.mjs
// for the invariants this list must satisfy.
//
// Core vs hidden (v2.34.0, expanded v2.70.0): only 9 tools are exposed via MCP
// `tools/list` (the original 6 + mem_defer/mem_defer_list/mem_defer_drop). The
// remaining 11 stay registered — and are still callable by name at the MCP
// protocol level (`tools/call` by exact name) — but are omitted from the list
// response so they don't bloat every agent's startup context. The core set
// covers the hot paths the invited-memory contract promises (recall before
// Edit, save after bugfix, search/recent/timeline/get for retrieval, defer
// for cross-session carry-forward). Hidden tools are either maintenance
// (compress/maintain/optimize/fts_check), admin/infra
// (stats/export/update/delete), or specialized browsers
// (browse/registry/use) — all of which have CLI equivalents documented in
// `adopt-content.mjs`.
// ────────────────────────────────────────────────────────────────────────────

export const tools = [
  {
    name: 'mem_search',
    description:
      'Full-text search across observations, sessions, prompts, and events — the canonical\n' +
      'bugfix/feature/decision/lesson history (FTS5, BM25-ranked).\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - The SessionStart context or hook-injected memory already shows #NN entries that answer the question\n' +
      '  - You only need recent items (use mem_recent)\n' +
      '  - You want everything about a specific file (use mem_recall — cheaper and file-scoped)\n' +
      '\n' +
      'USE when:\n' +
      '  - Investigating an error keyword with obs_type="bugfix" (matches observations AND events)\n' +
      '  - Looking for prior art on a module/feature before refactoring\n' +
      '  - A normal search missed — weak results auto-escalate to deep (set deep=false to opt out)\n' +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' search "<query>" [--type bugfix] [--deep]',
    inputSchema: memSearchSchema,
  },
  {
    name: 'mem_recent',
    description:
      'List the most recent observations for the current project, newest first.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - You are searching for a topic (use mem_search — this tool does no filtering)\n' +
      '  - SessionStart already printed a recent-activity block (it is the same data)\n' +
      '  - You need details for a specific ID (use mem_get)\n' +
      '\n' +
      'USE when:\n' +
      '  - Resuming after a long gap and the injected context is stale\n' +
      '  - User asks "what did we do yesterday / last" with no topic keyword\n' +
      '  - Verifying that a just-made change was captured as an observation\n' +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' recent [N]',
    inputSchema: memRecentSchema,
  },
  {
    name: 'mem_timeline',
    description:
      'Show observations before and after an anchor point (by ID or by FTS query).\n' +
      'Query-anchor ranks by BM25 × time-decay → BEST topical match, not most recent.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - You only want one record (use mem_get)\n' +
      '  - You have no anchor in mind and are just browsing (use mem_recent or mem_browse)\n' +
      '  - The sequence is obvious from commit history (use git log)\n' +
      '  - You want "recent activity around X" (use mem_recent or mem_search sort="time")\n' +
      '\n' +
      'USE when:\n' +
      '  - Reconstructing what led up to / followed a specific bug or decision\n' +
      '  - A search hit is interesting and you want its chronological neighbours\n' +
      '  - Replaying a session narrative around a known observation ID\n' +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' timeline --anchor <ID> [--before N --after N]',
    inputSchema: memTimelineSchema,
  },
  {
    name: 'mem_get',
    description:
      'Fetch full records (narrative, lesson_learned, files, concepts) by ID.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - You have not seen the ID referenced anywhere (use mem_search first)\n' +
      '  - You only need title/type — that is already in the search result line\n' +
      '  - You are speculatively paging through IDs (use mem_recent / mem_browse)\n' +
      '\n' +
      'USE when:\n' +
      '  - Hook-injected context shows #NN and you need the full narrative/lesson\n' +
      '  - A mem_search hit looks relevant and you need the supporting detail\n' +
      '  - For session (S#) or prompt (P#) hits, pass source="session" or "prompt"\n' +
      '\n' +
      'On miss, response includes "Try: …" hint listing other sources the ID lives in.\n' +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' get <id>[,<id>,...] — accepts P#/S#/# prefix.',
    inputSchema: memGetSchema,
  },
  {
    name: 'mem_delete',
    description:
      'Delete observations by ID. Destructive — always preview with confirm=false first.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - The goal is to lower relevance, not erase (use mem_update or let decay handle it)\n' +
      '  - You suspect duplicates (use mem_maintain action="scan" operations=["dedup"])\n' +
      '  - User has not explicitly asked to forget / delete something\n' +
      '\n' +
      'USE when:\n' +
      '  - User says "delete #42" or "remove that note about X"\n' +
      '  - Cleaning up an observation saved from a test run or incorrect save\n' +
      '  - Always run once with confirm=false, then again with confirm=true\n' +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' delete <id>[,<id>,...] [--confirm]',
    inputSchema: memDeleteSchema,
    hidden: true,
  },
  {
    name: 'mem_save',
    description:
      'Persist a memory with optional lesson_learned. Prefer type="bugfix" or "decision" — other types have ~16% retrieval rate.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - The content is trivial (renames, style, formatting — hook episode batching handles these)\n' +
      '  - lesson_learned would be "none" or restate the title — save only actionable insight\n' +
      '  - It duplicates an existing observation (search first if unsure)\n' +
      '\n' +
      'USE when:\n' +
      '  - After fixing a non-trivial bug — set type="bugfix", lesson_learned="<root cause + fix>"\n' +
      '  - After a non-obvious architecture/tradeoff decision — set type="decision", lesson_learned="<constraint + why>"\n' +
      '  - User explicitly asks "remember this" or "save a note that ..."\n' +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' save --type bugfix --lesson "..." "<content>"',
    inputSchema: memSaveSchema,
  },
  {
    name: 'mem_stats',
    description:
      'Memory-system statistics: counts, types, projects, daily activity, data health.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - During active coding — stats are for maintenance/diagnosis, not code work\n' +
      '  - You need actual content (use mem_search / mem_recent / mem_browse)\n' +
      '  - Triaging one bad result — run mem_fts_check instead\n' +
      '\n' +
      'USE when:\n' +
      '  - User asks "how much memory do we have" / "is the DB healthy"\n' +
      '  - Diagnosing why search feels sparse or noisy at a macro level\n' +
      '  - Auditing a project before major compression/maintenance\n' +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' stats [--project X] [--days 30]',
    inputSchema: memStatsSchema,
    hidden: true,
  },
  {
    name: 'mem_compress',
    description:
      'Roll up old low-value observations into weekly summaries. Destructive in execute mode.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - DB is small (<1000 observations) — compression overhead outweighs benefit\n' +
      '  - Observations are <30 days old (the tool rejects age_days<30 anyway)\n' +
      '  - Unsure — always run with preview=true first\n' +
      '\n' +
      'USE when:\n' +
      '  - User says "clean up old memories" / "compress history"\n' +
      '  - After a major project phase completes and old per-file observations are noise\n' +
      '  - Stats show thousands of low-importance rows dragging search quality\n' +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' compress [--execute] [--age-days 90]  (preview is default)',
    inputSchema: memCompressSchema,
    hidden: true,
  },
  {
    name: 'mem_maintain',
    description:
      'Two-phase maintenance: scan (safe) then execute (mutating). Handles dedup / decay / cleanup / boost / purge_stale / rebuild_vectors.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - Search quality is fine — this is scheduled maintenance, not per-query tuning\n' +
      '  - You want to delete a specific ID (use mem_delete)\n' +
      '  - Calling execute without first running scan and reviewing candidates\n' +
      '\n' +
      'USE when:\n' +
      '  - Search results show obvious duplicates or stale entries\n' +
      '  - After bulk imports or a long offline period\n' +
      '  - User asks for periodic maintenance / cleanup\n' +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' maintain scan --ops dedup,decay',
    inputSchema: memMaintainSchema,
    hidden: true,
  },
  {
    name: 'mem_optimize',
    description:
      'LLM-powered deep optimization: re-enrich, normalize, cluster-merge, smart-compress. Costs Haiku tokens per candidate.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - You have not run mem_maintain first — optimize is the expensive last resort\n' +
      '  - Cost matters this session (each candidate is one LLM call)\n' +
      '  - action="run_all" without a preview — bypasses safety gates\n' +
      '\n' +
      'USE when:\n' +
      '  - Periodic deep maintenance (weekly/monthly) with budget available\n' +
      '  - stats show many degraded (title-only, no lesson) observations\n' +
      '  - Start with action="preview" to see candidates before spending tokens\n' +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' optimize [--run|--run-all] [--task re-enrich,normalize,cluster-merge,smart-compress] [--max N]  (preview is default)',
    inputSchema: memOptimizeSchema,
    hidden: true,
  },
  {
    name: 'mem_registry',
    description:
      'Manage the skill/agent resource registry (list, stats, search, import, remove, reindex, enrich).\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - Searching project memory (use mem_search — registry is tool resources, not observations)\n' +
      '  - You already know the skill name and just want to load it (use mem_use)\n' +
      '  - Importing from a random URL user has not explicitly trusted\n' +
      '\n' +
      'USE when:\n' +
      '  - User asks "what skills/agents are installed" → action="list"\n' +
      '  - Looking for a tool by capability → action="search" with keywords\n' +
      '  - User explicitly asks to import a GitHub repo → action="import_url"\n' +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' registry <list|search|import|...> [args]',
    inputSchema: memRegistrySchema,
    hidden: true,
  },
  {
    name: 'mem_use',
    description:
      'Load and activate a skill or agent from the registry by EXACT name or invocation_name.\n' +
      "A name that matches nothing returns closest-match names to pick from — never another resource's content.\n" +
      '\n' +
      'DO NOT use when:\n' +
      '  - You have not confirmed the skill exists (run mem_registry action="list" first)\n' +
      '  - The user only asked about a skill, not to invoke it\n' +
      '  - A built-in Claude Code Skill is a better fit than a managed one\n' +
      '\n' +
      'USE when:\n' +
      '  - mem_registry search surfaced a promising skill and you want its full content\n' +
      '  - You know the invocation_name (e.g. "plugin:foo") and need its instructions\n' +
      '  - User says "run the <X> skill" where X is a registered resource\n' +
      '\n' +
      'Equivalent CLI: MCP only (no CLI handler — use mem_registry to inspect)',
    inputSchema: memUseSchema,
    hidden: true,
  },
  {
    name: 'mem_update',
    description:
      'Edit an existing observation in place (title, narrative, type, importance, lesson_learned, concepts).\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - The record should be erased (use mem_delete)\n' +
      '  - You want to save a brand-new insight (use mem_save — preserves audit trail)\n' +
      '  - Bulk-adjusting importance across many rows (use mem_maintain decay/boost)\n' +
      '\n' +
      'USE when:\n' +
      '  - A specific observation has a wrong title/type and user points it out\n' +
      '  - You later discover additional context worth appending to lesson_learned\n' +
      '  - Reclassifying an observation after its true type becomes clear\n' +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' update <id> [--title ...] [--lesson ...]',
    inputSchema: memUpdateSchema,
    hidden: true,
  },
  {
    name: 'mem_export',
    description:
      'Dump observations as JSON or JSONL for backup / sharing / inspection.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - You want to read a few records (use mem_get / mem_recent — export is bulk)\n' +
      '  - Searching — JSON dump is not a substitute for FTS (use mem_search)\n' +
      '  - Size is unbounded — always pass `limit` and optional `date_from`/`date_to`\n' +
      '\n' +
      'USE when:\n' +
      '  - Backing up memory before a migration or reinstall\n' +
      '  - Moving observations between machines or projects\n' +
      "  - User asks for a JSON snapshot of a project's memories\n" +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' export [--format jsonl] [--project X] [--limit 500]',
    inputSchema: memExportSchema,
    hidden: true,
  },
  {
    name: 'mem_recall',
    description:
      'Recall past observations tied to a specific file path (fast, file-scoped alternative to mem_search).\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - The PreToolUse hook has already injected #NN lines for this file (reuse them — do not re-fetch)\n' +
      '  - You need current file contents (use Read)\n' +
      '  - The file is new or has never been edited — no memories will match\n' +
      '\n' +
      'USE when:\n' +
      '  - About to Edit/Write a file whose history you do not know\n' +
      '  - User asks "what do we know about <file>"\n' +
      '  - Investigating a recurring issue in a file you have not touched recently\n' +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' recall "<file>" [--limit 10]',
    inputSchema: memRecallSchema,
  },
  {
    name: 'mem_fts_check',
    description:
      'Check FTS5 index integrity or rebuild indexes. Rebuild is expensive and holds the DB lock.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - Search merely returned an unexpected (but valid) result — that is a ranking issue, not corruption\n' +
      '  - The DB is actively being written to by another process\n' +
      '  - Running "rebuild" without first running "check" and seeing real corruption\n' +
      '\n' +
      'USE when:\n' +
      '  - Search throws FTS5 errors or returns impossible empty results for known keywords\n' +
      '  - After a crash, power loss, or manual DB edit\n' +
      '  - doctor / stats flags FTS integrity problems\n' +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' fts-check <check|rebuild>',
    inputSchema: memFtsCheckSchema,
    hidden: true,
  },
  {
    name: 'mem_browse',
    description:
      'Tier-grouped dashboard (working / active / archive) of recent observations per project.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - SessionStart context already rendered a recent-activity block\n' +
      '  - You have a search query or file in mind (use mem_search / mem_recall)\n' +
      '  - You need detail — browse is an index, not a content view (follow up with mem_get)\n' +
      '\n' +
      'USE when:\n' +
      '  - User asks for an overview / dashboard of project memory\n' +
      '  - Triaging what to compress or clean up before running maintenance\n' +
      '  - Scanning for interesting anchors to follow up with mem_timeline\n' +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' browse [--tier active] [--project X]',
    inputSchema: memBrowseSchema,
    hidden: true,
  },
  {
    name: 'mem_defer',
    description:
      'Save a future-session TODO to the project carry-forward list. Surfaces in the next SessionStart `### Deferred Work` banner with an ordinal (e.g. "1") so user can say "处理1" / "handle item 1".\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - Work is in-flight this session (just do it; do not defer mid-task)\n' +
      '  - This-PR follow-up cleanup (file in tasks/, not deferred_work)\n' +
      '  - Already saved a bugfix obs for it (use mem_save closes_deferred instead)\n' +
      '\n' +
      'USE when:\n' +
      '  - User says "下次/next session/留给下个会话/defer to next round"\n' +
      '  - Wrap-up phase enumerates follow-up items for the next session\n' +
      "  - Bug surfaces but root cause is out of this session's scope\n" +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' defer add "<title>" [--priority 1|2|3] [--detail "..."] [--files a.mjs,b.mjs]',
    inputSchema: memDeferSchema,
  },
  {
    name: 'mem_defer_list',
    description:
      'List open deferred_work items for a project, ordered by priority DESC then age. Each item carries a per-project ordinal (1, 2, 3...) for "处理1"-style reference.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - The SessionStart `### Deferred Work` block already shows the items (reuse that — same data)\n' +
      '  - You only need one item by id (use mem_get on the obs that closed it, or look up the row directly)\n' +
      '\n' +
      'USE when:\n' +
      '  - User asks "what was on the deferred list" / "what did I leave for next time"\n' +
      '  - About to refer to "item N" and need to confirm what N points to\n' +
      '  - Auditing carry-forward state across multiple sessions\n' +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' defer list [--project X] [--limit 10]',
    inputSchema: memDeferListSchema,
  },
  {
    name: 'mem_defer_drop',
    description:
      'Mark a deferred_work item as dropped (no fix, no longer relevant) with a required reason. For real fixes, prefer mem_save({type:"bugfix", closes_deferred:[N]}) — establishes audit trail.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - The item was actually fixed (use mem_save closes_deferred — audit linkage)\n' +
      '  - You want to delete the row (drops are soft — status flips, row stays)\n' +
      '  - The reason is trivial — drop reason is the only audit trail for "why no fix"\n' +
      '\n' +
      'USE when:\n' +
      '  - Originally-deferred item turns out to be a flaky test, not a real bug\n' +
      '  - Scope changed and the work is no longer needed\n' +
      '  - User explicitly says "drop the deferred X, never mind"\n' +
      '\n' +
      'Equivalent CLI: ' +
      CLI_INVOKE +
      ' defer drop <D#N|ordinal> --reason "..."',
    inputSchema: memDeferDropSchema,
  },
];
