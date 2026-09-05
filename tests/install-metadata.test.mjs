// Minimal regression contract for install-metadata.mjs (baseline 2026-09-05).
//
// The module is 2072 lines of curated data and, before this file, the only shipped
// module whose basename appeared nowhere under tests/. install.mjs consumes it in three
// places (registry seed INSERT, FTS5 backfill UPDATE, install-time upsertResource) and
// every one of them assumes the shape pinned here: `type:name` keys, four always-present
// string fields, and `recommendation_mode` set on exactly the MARKETING_ON_REQUEST set
// (the module mutates its own table at load time to do that). A malformed entry does not
// throw in install.mjs — it silently seeds a resource with an empty summary, which is the
// failure this file exists to make visible.
import { describe, it, expect } from 'vitest';
import { RESOURCE_METADATA, MARKETING_ON_REQUEST } from '../install-metadata.mjs';

// `domain_tags` is a required STRING but may be empty: four entries (general-purpose /
// explore / plan agents, sequential-thinking) deliberately carry '' because they have no
// domain, and every consumer reads it as `meta.domain_tags || ''`. The other three must
// be non-empty — install.mjs falls back to a name-echo for them, which is exactly the
// "generic name-echo fallback" the header says this table exists to replace.
const REQUIRED = ['intent_tags', 'domain_tags', 'capability_summary', 'trigger_patterns'];
const REQUIRED_NON_EMPTY = ['intent_tags', 'capability_summary', 'trigger_patterns'];
const OPTIONAL = ['keywords', 'tech_stack', 'use_cases', 'invocation_name', 'recommendation_mode'];
const KNOWN_TYPES = new Set(['skill', 'agent']);
const KNOWN_MODES = new Set(['on_request', 'proactive']);

describe('install-metadata.mjs — resource metadata contract', () => {
  const entries = Object.entries(RESOURCE_METADATA);

  it('is non-trivial (premise for every assertion below)', () => {
    expect(entries.length).toBeGreaterThan(100);
    expect(MARKETING_ON_REQUEST.size).toBeGreaterThan(10);
  });

  it('every key is `<type>:<name>` with a known type and a non-empty name', () => {
    const bad = entries.map(([k]) => k).filter((k) => {
      const sep = k.indexOf(':');
      return sep <= 0 || !KNOWN_TYPES.has(k.slice(0, sep)) || k.slice(sep + 1).length === 0;
    });
    expect(bad).toEqual([]);
  });

  it('every entry carries the four required string fields, three of them non-empty', () => {
    const bad = [];
    for (const [k, meta] of entries) {
      for (const f of REQUIRED) {
        if (typeof meta[f] !== 'string') bad.push(`${k}.${f} (${typeof meta[f]})`);
      }
      for (const f of REQUIRED_NON_EMPTY) {
        if (typeof meta[f] === 'string' && meta[f].trim() === '') bad.push(`${k}.${f} (empty)`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('carries no fields outside the documented set, and optional fields are strings', () => {
    const allowed = new Set([...REQUIRED, ...OPTIONAL]);
    const bad = [];
    for (const [k, meta] of entries) {
      for (const [f, v] of Object.entries(meta)) {
        if (!allowed.has(f)) bad.push(`${k}.${f} (unknown field)`);
        else if (typeof v !== 'string') bad.push(`${k}.${f} (${typeof v})`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('recommendation_mode, when present, is a known mode', () => {
    const bad = entries
      .filter(([, m]) => m.recommendation_mode !== undefined && !KNOWN_MODES.has(m.recommendation_mode))
      .map(([k, m]) => `${k}=${m.recommendation_mode}`);
    expect(bad).toEqual([]);
  });

  it('every MARKETING_ON_REQUEST key exists and was flipped to on_request at load', () => {
    const missing = [...MARKETING_ON_REQUEST].filter((k) => !RESOURCE_METADATA[k]);
    expect(missing).toEqual([]);
    const notFlipped = [...MARKETING_ON_REQUEST].filter((k) => RESOURCE_METADATA[k]?.recommendation_mode !== 'on_request');
    expect(notFlipped).toEqual([]);
  });

  it('invocation_name, when set, is a non-empty string without whitespace', () => {
    const bad = entries
      .filter(([, m]) => m.invocation_name !== undefined && !/^\S+$/.test(m.invocation_name))
      .map(([k]) => k);
    expect(bad).toEqual([]);
  });
});
