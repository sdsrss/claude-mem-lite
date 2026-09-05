import { describe, it, expect } from 'vitest';
import { buildEnrichPrompt, applyEnrichment } from '../registry-enricher.mjs';
import { createRegistryTestDb } from './test-helpers.mjs';

describe('buildEnrichPrompt', () => {
  it('includes skill content and existing metadata', () => {
    const prompt = buildEnrichPrompt('humanizer', '# Humanizer\nRemove AI patterns', {
      intent_tags: 'writing',
    });
    expect(prompt).toContain('humanizer');
    expect(prompt).toContain('Remove AI patterns');
    expect(prompt).toContain('writing');
    expect(prompt).toContain('Return JSON only');
  });

  it('truncates long content', () => {
    const longContent = 'x'.repeat(5000);
    const prompt = buildEnrichPrompt('test', longContent, {});
    expect(prompt.length).toBeLessThan(4500);
  });

  it('omits existing-metadata when no tags', () => {
    const prompt = buildEnrichPrompt('test', 'content', {});
    expect(prompt).not.toContain('existing-metadata');
  });
});

describe('applyEnrichment', () => {
  it('fills empty fields from LLM result', () => {
    const db = createRegistryTestDb();
    db.prepare(
      `
      INSERT INTO resources (name, type, source, file_hash, status, local_path, invocation_name,
        capability_summary, trigger_patterns, keywords, intent_tags, use_cases, domain_tags, tech_stack)
      VALUES ('test-skill', 'skill', 'github', 'hash', 'active', '/tmp', 'test-skill',
        '', '', '', '', '', '', '')
    `,
    ).run();

    applyEnrichment(db, 'test-skill', 'skill', {
      capability_summary: 'Removes AI writing patterns from text',
      intent_tags: 'writing,editing,humanize',
      domain_tags: 'content,writing',
      trigger_patterns: 'when user wants to remove AI patterns from text',
      use_cases: 'blog posts,marketing copy',
      tech_stack: '',
      quality_assessment: { has_clear_instructions: true, specificity: 'high', estimated_utility: 'high' },
    });

    const row = db.prepare("SELECT * FROM resources WHERE name = 'test-skill'").get();
    expect(row.capability_summary).toBe('Removes AI writing patterns from text');
    expect(row.intent_tags).toBe('writing,editing,humanize');
    expect(row.enrichment_status).toBe('done');
    expect(row.quality_tier).toBe('verified');
    db.close();
  });

  it('does not overwrite existing non-empty fields', () => {
    const db = createRegistryTestDb();
    db.prepare(
      `
      INSERT INTO resources (name, type, source, file_hash, status, local_path, invocation_name,
        capability_summary, trigger_patterns, keywords, intent_tags, use_cases, domain_tags, tech_stack)
      VALUES ('curated', 'skill', 'preinstalled', 'hash', 'active', '/tmp', 'curated',
        'Existing summary', 'existing triggers', 'existing kw', 'existing intents', '', '', '')
    `,
    ).run();

    applyEnrichment(db, 'curated', 'skill', {
      capability_summary: 'New summary from LLM',
      intent_tags: 'new,tags',
      trigger_patterns: 'new triggers',
      quality_assessment: { has_clear_instructions: true, specificity: 'medium' },
    });

    const row = db.prepare("SELECT * FROM resources WHERE name = 'curated'").get();
    expect(row.capability_summary).toBe('Existing summary');
    expect(row.intent_tags).toBe('existing intents');
    expect(row.trigger_patterns).toBe('existing triggers');
    db.close();
  });

  it('does not upgrade quality_tier for non-community resources', () => {
    const db = createRegistryTestDb();
    db.prepare(
      `
      INSERT INTO resources (name, type, source, file_hash, status, local_path, invocation_name,
        capability_summary, trigger_patterns, keywords, intent_tags, use_cases, domain_tags, tech_stack, quality_tier)
      VALUES ('installed-skill', 'skill', 'preinstalled', 'hash', 'active', '/tmp', 'installed-skill',
        '', '', '', '', '', '', '', 'installed')
    `,
    ).run();

    applyEnrichment(db, 'installed-skill', 'skill', {
      capability_summary: 'test',
      quality_assessment: { has_clear_instructions: true, specificity: 'high' },
    });

    const row = db.prepare("SELECT quality_tier FROM resources WHERE name = 'installed-skill'").get();
    expect(row.quality_tier).toBe('installed'); // not downgraded to verified
    db.close();
  });
});
