// Contract tests: validate Zod schemas and output formats
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  memSearchSchema,
  memRecentSchema,
  memTimelineSchema,
  memGetSchema,
  memDeleteSchema,
  memSaveSchema,
  memStatsSchema,
  memCompressSchema,
  memMaintainSchema,
  memOptimizeSchema,
  memRecallSchema,
  memBrowseSchema,
} from '../tool-schemas.mjs';

// Helper: parse object against schema (Zod object from flat dict)
function parseSchema(schemaDef, data) {
  const schema = z.object(schemaDef);
  return schema.safeParse(data);
}

// ─── mem_search schema ──────────────────────────────────────────────────────

describe('mem_search schema', () => {
  it('accepts valid search with all fields', () => {
    const result = parseSchema(memSearchSchema, {
      query: 'authentication',
      type: 'observations',
      obs_type: 'bugfix',
      project: 'myproject',
      date_from: '2026-01-01',
      date_to: '2026-12-31',
      date_since: '7d',
      importance: 2,
      limit: 50,
      offset: 10,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an optional date_since string and rejects a non-string', () => {
    expect(parseSchema(memSearchSchema, { date_since: '24h' }).success).toBe(true);
    expect(parseSchema(memSearchSchema, {}).success).toBe(true); // omitted is fine (optional)
    expect(parseSchema(memSearchSchema, { date_since: 7 }).success).toBe(false);
  });

  it('accepts empty object (all optional)', () => {
    const result = parseSchema(memSearchSchema, {});
    expect(result.success).toBe(true);
  });

  it('rejects invalid type enum', () => {
    const result = parseSchema(memSearchSchema, { type: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('rejects importance out of range', () => {
    const low = parseSchema(memSearchSchema, { importance: 0 });
    expect(low.success).toBe(false);
    const high = parseSchema(memSearchSchema, { importance: 4 });
    expect(high.success).toBe(false);
  });

  it('rejects limit out of range', () => {
    const zero = parseSchema(memSearchSchema, { limit: 0 });
    expect(zero.success).toBe(false);
    const tooHigh = parseSchema(memSearchSchema, { limit: 101 });
    expect(tooHigh.success).toBe(false);
  });

  it('accepts boundary values', () => {
    expect(parseSchema(memSearchSchema, { importance: 1 }).success).toBe(true);
    expect(parseSchema(memSearchSchema, { importance: 3 }).success).toBe(true);
    expect(parseSchema(memSearchSchema, { limit: 1 }).success).toBe(true);
    expect(parseSchema(memSearchSchema, { limit: 100 }).success).toBe(true);
    expect(parseSchema(memSearchSchema, { offset: 0 }).success).toBe(true);
  });

  // Batch A: CLI ↔ MCP alignment — CLI has --or, MCP must accept `or` too.
  // Zod strips unknown keys silently, so success alone isn't enough — the
  // field must survive parse (data.or === true) to prove it's in the schema.
  it('accepts or:true and retains it in parsed output (aligns with CLI --or)', () => {
    const r1 = parseSchema(memSearchSchema, { query: 'foo bar', or: true });
    expect(r1.success).toBe(true);
    expect(r1.data.or).toBe(true);

    const r2 = parseSchema(memSearchSchema, { query: 'foo', or: 'true' });
    expect(r2.success).toBe(true);
    expect(r2.data.or).toBe(true);
  });

  // D#43: CLI ↔ MCP alignment — CLI has `search --deep --rerank`, MCP must accept
  // `rerank` too. Like `or`, prove it survives parse (not silently stripped).
  it('accepts rerank:true and retains it in parsed output (aligns with CLI --rerank)', () => {
    const r1 = parseSchema(memSearchSchema, { query: 'foo', deep: true, rerank: true });
    expect(r1.success).toBe(true);
    expect(r1.data.rerank).toBe(true);

    const r2 = parseSchema(memSearchSchema, { query: 'foo', deep: true, rerank: 'true' });
    expect(r2.success).toBe(true);
    expect(r2.data.rerank).toBe(true);
  });

  // Regression: include_noise was bare z.boolean() (not coerceBool) on BOTH memSearchSchema
  // and memRecallSchema, so a stringified "true" from a JSON-scalar MCP bridge hard-failed the
  // whole call while every sibling bool (or/deep/rerank) accepted it. CLI↔MCP parity (#8703 class).
  it('accepts include_noise as a stringified bool on both search and recall (coerceBool parity)', () => {
    for (const val of ['true', true]) {
      const s = parseSchema(memSearchSchema, { query: 'foo', include_noise: val });
      expect(s.success).toBe(true);
      expect(s.data.include_noise).toBe(true);
      const r = parseSchema(memRecallSchema, { file: 'a.mjs', include_noise: val });
      expect(r.success).toBe(true);
      expect(r.data.include_noise).toBe(true);
    }
    // 'false' string coerces to false — not rejected, not truthy
    expect(parseSchema(memSearchSchema, { query: 'foo', include_noise: 'false' }).data.include_noise).toBe(
      false,
    );
  });
});

// ─── mem_recent schema ──────────────────────────────────────────────────────

describe('mem_recent schema', () => {
  it('accepts empty args (all optional)', () => {
    expect(parseSchema(memRecentSchema, {}).success).toBe(true);
  });

  it('accepts limit and project', () => {
    const result = parseSchema(memRecentSchema, { limit: 10, project: 'mem' });
    expect(result.success).toBe(true);
    expect(result.data.limit).toBe(10);
  });

  it('rejects limit out of range', () => {
    expect(parseSchema(memRecentSchema, { limit: 0 }).success).toBe(false);
    expect(parseSchema(memRecentSchema, { limit: 101 }).success).toBe(false);
  });

  it('coerces string limit', () => {
    const result = parseSchema(memRecentSchema, { limit: '5' });
    expect(result.success).toBe(true);
    expect(result.data.limit).toBe(5);
  });

  it('accepts an optional date_since string and rejects a non-string', () => {
    expect(parseSchema(memRecentSchema, { date_since: '7d' }).success).toBe(true);
    expect(parseSchema(memRecentSchema, { date_since: 7 }).success).toBe(false);
  });

  it('accepts a valid obs_type and rejects an unknown one', () => {
    expect(parseSchema(memRecentSchema, { obs_type: 'bugfix' }).success).toBe(true);
    expect(parseSchema(memRecentSchema, { obs_type: 'notatype' }).success).toBe(false);
  });
});

// ─── mem_timeline schema ────────────────────────────────────────────────────

describe('mem_timeline schema', () => {
  it('accepts valid timeline with anchor', () => {
    const result = parseSchema(memTimelineSchema, { anchor: 42, before: 5, after: 5 });
    expect(result.success).toBe(true);
  });

  it('accepts query-based timeline', () => {
    const result = parseSchema(memTimelineSchema, { query: 'auth bug', project: 'myproj' });
    expect(result.success).toBe(true);
  });

  it('rejects before/after out of range', () => {
    expect(parseSchema(memTimelineSchema, { before: -1 }).success).toBe(false);
    expect(parseSchema(memTimelineSchema, { after: 51 }).success).toBe(false);
  });

  // Parity with CLI `timeline --anchor`: accept prefixed-token strings from search output.
  it('accepts prefixed anchor strings: "#123", "P#456", "S#789"', () => {
    expect(parseSchema(memTimelineSchema, { anchor: '#123' }).success).toBe(true);
    expect(parseSchema(memTimelineSchema, { anchor: 'P#456' }).success).toBe(true);
    expect(parseSchema(memTimelineSchema, { anchor: 'S#789' }).success).toBe(true);
    expect(parseSchema(memTimelineSchema, { anchor: 'p123' }).success).toBe(true); // lowercase
  });

  it('rejects anchor strings with garbage', () => {
    expect(parseSchema(memTimelineSchema, { anchor: 'X#42' }).success).toBe(false);
    expect(parseSchema(memTimelineSchema, { anchor: '#abc' }).success).toBe(false);
    expect(parseSchema(memTimelineSchema, { anchor: '' }).success).toBe(false);
  });

  it('coerces plain-int strings to number (unchanged legacy path)', () => {
    const r = parseSchema(memTimelineSchema, { anchor: '42' });
    expect(r.success).toBe(true);
    expect(r.data.anchor).toBe(42);
  });
});

// ─── mem_get schema ─────────────────────────────────────────────────────────

describe('mem_get schema', () => {
  it('accepts valid get with ids', () => {
    const result = parseSchema(memGetSchema, { ids: [1, 2, 3] });
    expect(result.success).toBe(true);
  });

  it('accepts source and fields', () => {
    const result = parseSchema(memGetSchema, {
      ids: [1],
      source: 'session',
      fields: ['request', 'completed'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty ids array', () => {
    const result = parseSchema(memGetSchema, { ids: [] });
    expect(result.success).toBe(false);
  });

  it('rejects too many ids (>20)', () => {
    const ids = Array.from({ length: 21 }, (_, i) => i + 1);
    const result = parseSchema(memGetSchema, { ids });
    expect(result.success).toBe(false);
  });

  it('rejects missing ids', () => {
    const result = parseSchema(memGetSchema, {});
    expect(result.success).toBe(false);
  });

  // Same coerceStringArray parity as memSave.files — MCP clients that JSON-stringify
  // complex args must not silently lose the `fields` selector.
  it('coerces fields as JSON-array string', () => {
    const r = parseSchema(memGetSchema, { ids: [1], fields: '["title","lesson_learned"]' });
    expect(r.success).toBe(true);
    expect(r.data.fields).toEqual(['title', 'lesson_learned']);
  });

  it('coerces fields as comma-separated string', () => {
    const r = parseSchema(memGetSchema, { ids: [1], fields: 'title,type' });
    expect(r.success).toBe(true);
    expect(r.data.fields).toEqual(['title', 'type']);
  });
});

// ─── mem_recall schema ─────────────────────────────────────────────────────

describe('mem_recall schema', () => {
  it('accepts file path', () => {
    const result = parseSchema(memRecallSchema, { file: 'server.mjs' });
    expect(result.success).toBe(true);
  });

  it('accepts file with limit', () => {
    const result = parseSchema(memRecallSchema, { file: 'utils.mjs', limit: 5 });
    expect(result.success).toBe(true);
  });

  it('rejects empty file', () => {
    const result = parseSchema(memRecallSchema, { file: '' });
    expect(result.success).toBe(false);
  });

  it('rejects missing file', () => {
    const result = parseSchema(memRecallSchema, {});
    expect(result.success).toBe(false);
  });

  it('coerces string limit', () => {
    const result = parseSchema(memRecallSchema, { file: 'test.mjs', limit: '10' });
    expect(result.success).toBe(true);
    expect(result.data.limit).toBe(10);
  });

  it('accepts include_noise flag (parity with mem_search)', () => {
    const result = parseSchema(memRecallSchema, { file: 'test.mjs', include_noise: true });
    expect(result.success).toBe(true);
    expect(result.data.include_noise).toBe(true);
  });
});

// ─── mem_delete schema ──────────────────────────────────────────────────────

describe('mem_delete schema', () => {
  it('accepts preview mode', () => {
    const result = parseSchema(memDeleteSchema, { ids: [1, 2], confirm: false });
    expect(result.success).toBe(true);
  });

  it('accepts execute mode', () => {
    const result = parseSchema(memDeleteSchema, { ids: [1], confirm: true });
    expect(result.success).toBe(true);
  });

  it('rejects empty ids', () => {
    const result = parseSchema(memDeleteSchema, { ids: [], confirm: true });
    expect(result.success).toBe(false);
  });

  it('rejects too many ids (>50)', () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1);
    const result = parseSchema(memDeleteSchema, { ids, confirm: true });
    expect(result.success).toBe(false);
  });

  it('rejects missing confirm', () => {
    const result = parseSchema(memDeleteSchema, { ids: [1] });
    expect(result.success).toBe(false);
  });
});

// ─── mem_save schema ────────────────────────────────────────────────────────

describe('mem_save schema', () => {
  it('accepts minimal save', () => {
    const result = parseSchema(memSaveSchema, { content: 'some content' });
    expect(result.success).toBe(true);
  });

  it('accepts full save with all fields', () => {
    const result = parseSchema(memSaveSchema, {
      content: 'detailed content',
      title: 'My Title',
      type: 'decision',
      project: 'myproject',
      importance: 3,
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty content', () => {
    const result = parseSchema(memSaveSchema, { content: '' });
    expect(result.success).toBe(false);
  });

  it('rejects missing content', () => {
    const result = parseSchema(memSaveSchema, { title: 'no content' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid type', () => {
    const result = parseSchema(memSaveSchema, { content: 'x', type: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('rejects importance out of range', () => {
    expect(parseSchema(memSaveSchema, { content: 'x', importance: 0 }).success).toBe(false);
    expect(parseSchema(memSaveSchema, { content: 'x', importance: 4 }).success).toBe(false);
  });

  // Regression: MCP bridges sometimes JSON-stringify array args. Bare z.array(z.string())
  // would reject with "expected array, received string" and the caller would silently lose
  // the files association. coerceStringArray tolerates array | JSON-string | comma-string.
  it('coerces files as JSON-array string', () => {
    const r = parseSchema(memSaveSchema, { content: 'x', files: '["a.mjs","b.mjs"]' });
    expect(r.success).toBe(true);
    expect(r.data.files).toEqual(['a.mjs', 'b.mjs']);
  });

  it('coerces files as comma-separated string', () => {
    const r = parseSchema(memSaveSchema, { content: 'x', files: 'a.mjs, b.mjs ,c.mjs' });
    expect(r.success).toBe(true);
    expect(r.data.files).toEqual(['a.mjs', 'b.mjs', 'c.mjs']);
  });

  it('accepts files as native array', () => {
    const r = parseSchema(memSaveSchema, { content: 'x', files: ['a.mjs', 'b.mjs'] });
    expect(r.success).toBe(true);
    expect(r.data.files).toEqual(['a.mjs', 'b.mjs']);
  });
});

// ─── mem_stats schema ───────────────────────────────────────────────────────

describe('mem_stats schema', () => {
  it('accepts empty (all optional)', () => {
    expect(parseSchema(memStatsSchema, {}).success).toBe(true);
  });

  it('accepts project and days', () => {
    expect(parseSchema(memStatsSchema, { project: 'test', days: 90 }).success).toBe(true);
  });

  it('rejects days out of range', () => {
    expect(parseSchema(memStatsSchema, { days: 0 }).success).toBe(false);
    expect(parseSchema(memStatsSchema, { days: 366 }).success).toBe(false);
  });

  // Batch A: CLI ↔ MCP alignment — CLI has --quality dashboard, MCP must too.
  it('accepts quality:true and retains it in parsed output (aligns with CLI --quality)', () => {
    const r1 = parseSchema(memStatsSchema, { quality: true });
    expect(r1.success).toBe(true);
    expect(r1.data.quality).toBe(true);

    const r2 = parseSchema(memStatsSchema, { quality: 'true' });
    expect(r2.success).toBe(true);
    expect(r2.data.quality).toBe(true);
  });
});

// ─── mem_compress schema ────────────────────────────────────────────────────

describe('mem_compress schema', () => {
  it('accepts preview mode', () => {
    expect(parseSchema(memCompressSchema, { preview: true }).success).toBe(true);
  });

  it('accepts execute with age_days', () => {
    expect(parseSchema(memCompressSchema, { preview: false, age_days: 90 }).success).toBe(true);
  });

  it('rejects age_days below minimum', () => {
    expect(parseSchema(memCompressSchema, { age_days: 29 }).success).toBe(false);
  });

  it('rejects age_days above maximum', () => {
    expect(parseSchema(memCompressSchema, { age_days: 366 }).success).toBe(false);
  });
});

// ─── mem_maintain schema ─────────────────────────────────────────────────────

describe('mem_maintain schema', () => {
  it('accepts scan action', () => {
    expect(parseSchema(memMaintainSchema, { action: 'scan' }).success).toBe(true);
  });

  it('accepts scan with project filter', () => {
    expect(parseSchema(memMaintainSchema, { action: 'scan', project: 'my-project' }).success).toBe(true);
  });

  it('accepts execute with operations', () => {
    expect(
      parseSchema(memMaintainSchema, { action: 'execute', operations: ['cleanup', 'decay', 'boost'] })
        .success,
    ).toBe(true);
  });

  it('accepts execute with dedup and merge_ids', () => {
    expect(
      parseSchema(memMaintainSchema, {
        action: 'execute',
        operations: ['dedup'],
        merge_ids: [
          [1, 2, 3],
          [4, 5],
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects invalid action', () => {
    expect(parseSchema(memMaintainSchema, { action: 'invalid' }).success).toBe(false);
  });

  it('rejects invalid operation', () => {
    expect(parseSchema(memMaintainSchema, { action: 'execute', operations: ['invalid'] }).success).toBe(
      false,
    );
  });

  it('rejects merge_ids with single element group', () => {
    expect(
      parseSchema(memMaintainSchema, { action: 'execute', operations: ['dedup'], merge_ids: [[1]] }).success,
    ).toBe(false);
  });
});

// ─── memBrowseSchema ─────────────────────────────────────────────────────────

describe('memBrowseSchema', () => {
  it('accepts empty args (all defaults)', () => {
    expect(parseSchema(memBrowseSchema, {}).success).toBe(true);
  });

  it('accepts project and tier filter', () => {
    const r = parseSchema(memBrowseSchema, { project: 'my-project', tier: 'working', limit: 10 });
    expect(r.success).toBe(true);
    expect(r.data.tier).toBe('working');
    expect(r.data.limit).toBe(10);
  });

  it('rejects invalid tier', () => {
    expect(parseSchema(memBrowseSchema, { tier: 'invalid' }).success).toBe(false);
  });

  it('coerces string limit', () => {
    const r = parseSchema(memBrowseSchema, { limit: '15' });
    expect(r.success).toBe(true);
    expect(r.data.limit).toBe(15);
  });
});

// ─── memOptimizeSchema ──────────────────────────────────────────────────────

describe('memOptimizeSchema', () => {
  it('accepts empty args (all optional with defaults)', () => {
    expect(parseSchema(memOptimizeSchema, {}).success).toBe(true);
  });

  it('defaults action to preview', () => {
    const r = parseSchema(memOptimizeSchema, {});
    expect(r.success).toBe(true);
    expect(r.data.action).toBe('preview');
  });

  it('accepts all valid action values', () => {
    for (const action of ['preview', 'run', 'run_all']) {
      expect(parseSchema(memOptimizeSchema, { action }).success).toBe(true);
    }
  });

  it('rejects invalid action', () => {
    expect(parseSchema(memOptimizeSchema, { action: 'execute' }).success).toBe(false);
  });

  it('accepts tasks array', () => {
    const r = parseSchema(memOptimizeSchema, { action: 'run', tasks: ['re-enrich', 'normalize'] });
    expect(r.success).toBe(true);
  });

  it('rejects invalid task', () => {
    expect(parseSchema(memOptimizeSchema, { tasks: ['invalid'] }).success).toBe(false);
  });

  it('accepts max_items within range', () => {
    expect(parseSchema(memOptimizeSchema, { max_items: 1 }).success).toBe(true);
    expect(parseSchema(memOptimizeSchema, { max_items: 100 }).success).toBe(true);
  });

  it('rejects max_items out of range', () => {
    expect(parseSchema(memOptimizeSchema, { max_items: 0 }).success).toBe(false);
    expect(parseSchema(memOptimizeSchema, { max_items: 101 }).success).toBe(false);
  });

  it('coerces string max_items', () => {
    const r = parseSchema(memOptimizeSchema, { max_items: '10' });
    expect(r.success).toBe(true);
    expect(r.data.max_items).toBe(10);
  });
});

// ─── LLM string coercion ─────────────────────────────────────────────────────

describe('LLM string coercion (preprocess)', () => {
  it('coerces string integers to numbers', () => {
    const r = parseSchema(memSearchSchema, { importance: '2', limit: '50', offset: '0' });
    expect(r.success).toBe(true);
    expect(r.data.importance).toBe(2);
    expect(r.data.limit).toBe(50);
    expect(r.data.offset).toBe(0);
  });

  it('rejects non-numeric strings', () => {
    expect(parseSchema(memSearchSchema, { importance: 'abc' }).success).toBe(false);
    expect(parseSchema(memSearchSchema, { limit: '3.5' }).success).toBe(false);
  });

  it('coerces string anchor and before/after', () => {
    const r = parseSchema(memTimelineSchema, { anchor: '42', before: '3', after: '7' });
    expect(r.success).toBe(true);
    expect(r.data.anchor).toBe(42);
    expect(r.data.before).toBe(3);
    expect(r.data.after).toBe(7);
  });

  // memGetSchema.ids now emits string-tokens so P#/S#/# prefix info survives the schema
  // boundary for per-source routing in server.mjs (coerceMixedIdTokens). Bucketing happens
  // in the handler via lib/id-routing.bucketIdTokens. Bare-int inputs stringify through
  // unchanged; downstream handler parses via parseIdToken.
  it('coerces comma-separated string ids to token array', () => {
    const r = parseSchema(memGetSchema, { ids: '1,2,3' });
    expect(r.success).toBe(true);
    expect(r.data.ids).toEqual(['1', '2', '3']);
  });

  it('coerces single string id to array', () => {
    const r = parseSchema(memGetSchema, { ids: '42' });
    expect(r.success).toBe(true);
    expect(r.data.ids).toEqual(['42']);
  });

  it('coerces single number id to array', () => {
    const r = parseSchema(memGetSchema, { ids: 7 });
    expect(r.success).toBe(true);
    expect(r.data.ids).toEqual(['7']);
  });

  it('coerces array of string ids', () => {
    const r = parseSchema(memGetSchema, { ids: ['1', '2'] });
    expect(r.success).toBe(true);
    expect(r.data.ids).toEqual(['1', '2']);
  });

  // New: mixed-prefix tokens (#8127 parity). parseSchema passes them through; bucketing
  // happens in the handler.
  it('accepts mixed P#/S#/# prefix tokens', () => {
    const r = parseSchema(memGetSchema, { ids: ['#1', 'P#2', 'S#3'] });
    expect(r.success).toBe(true);
    expect(r.data.ids).toEqual(['#1', 'P#2', 'S#3']);
  });

  it('accepts comma-string with prefixes', () => {
    const r = parseSchema(memGetSchema, { ids: '1,P#2,S#3' });
    expect(r.success).toBe(true);
    expect(r.data.ids).toEqual(['1', 'P#2', 'S#3']);
  });

  it('coerces JSON-array string of mixed tokens', () => {
    const r = parseSchema(memGetSchema, { ids: '["#1","P#2"]' });
    expect(r.success).toBe(true);
    expect(r.data.ids).toEqual(['#1', 'P#2']);
  });

  it('rejects unparseable tokens via regex pipe', () => {
    const r = parseSchema(memGetSchema, { ids: ['garbage', 'P#1'] });
    expect(r.success).toBe(false);
  });

  it('coerces "true"/"false" strings to boolean', () => {
    const r = parseSchema(memDeleteSchema, { ids: [1], confirm: 'true' });
    expect(r.success).toBe(true);
    expect(r.data.confirm).toBe(true);

    const r2 = parseSchema(memDeleteSchema, { ids: [1], confirm: 'false' });
    expect(r2.success).toBe(true);
    expect(r2.data.confirm).toBe(false);
  });

  it('coerces "True"/"FALSE" (case-insensitive)', () => {
    expect(parseSchema(memDeleteSchema, { ids: [1], confirm: 'True' }).success).toBe(true);
    expect(parseSchema(memDeleteSchema, { ids: [1], confirm: 'FALSE' }).success).toBe(true);
  });

  it('coerces string importance in mem_save', () => {
    const r = parseSchema(memSaveSchema, { content: 'test', importance: '3' });
    expect(r.success).toBe(true);
    expect(r.data.importance).toBe(3);
  });

  it('coerces string days in mem_stats', () => {
    const r = parseSchema(memStatsSchema, { days: '90' });
    expect(r.success).toBe(true);
    expect(r.data.days).toBe(90);
  });

  it('coerces string age_days and preview in mem_compress', () => {
    const r = parseSchema(memCompressSchema, { preview: 'false', age_days: '60' });
    expect(r.success).toBe(true);
    expect(r.data.preview).toBe(false);
    expect(r.data.age_days).toBe(60);
  });

  it('coerces string retain_days in mem_maintain', () => {
    const r = parseSchema(memMaintainSchema, {
      action: 'execute',
      operations: ['purge_stale'],
      retain_days: '30',
    });
    expect(r.success).toBe(true);
    expect(r.data.retain_days).toBe(30);
  });

  it('coerces string ids inside merge_ids groups', () => {
    const r = parseSchema(memMaintainSchema, {
      action: 'execute',
      operations: ['dedup'],
      merge_ids: [['1', '2', '3']],
    });
    expect(r.success).toBe(true);
    expect(r.data.merge_ids).toEqual([[1, 2, 3]]);
  });

  it('still rejects invalid coerced values (range check)', () => {
    expect(parseSchema(memSearchSchema, { importance: '5' }).success).toBe(false);
    expect(parseSchema(memSearchSchema, { limit: '0' }).success).toBe(false);
    expect(parseSchema(memCompressSchema, { age_days: '10' }).success).toBe(false);
  });
});

// ─── Output format validation ───────────────────────────────────────────────

describe('output format contracts', () => {
  it('success format: {content: [{type: "text", text: string}]}', () => {
    const output = { content: [{ type: 'text', text: 'Found 5 results.' }] };
    const schema = z.object({
      content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
    });
    expect(schema.safeParse(output).success).toBe(true);
  });

  it('error format: {content: [...], isError: true}', () => {
    const output = { content: [{ type: 'text', text: 'Error: something failed' }], isError: true };
    const schema = z.object({
      content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
      isError: z.literal(true),
    });
    expect(schema.safeParse(output).success).toBe(true);
  });

  it('error text starts with "Error:"', () => {
    const errorText = 'Error: Invalid date_from: not-a-date';
    expect(errorText.startsWith('Error:')).toBe(true);
  });
});
