// claude-mem-lite: LLM enrichment for registry resources (Stage 2)
// Sends resource content to Haiku for semantic metadata generation
// Graceful degradation: failure preserves existing data

// Async dispatcher: enrichResource is reached from the MCP handlers for
// mem_registry `enrich` and `import_url`, where a blocking CLI leg would freeze
// the server event loop for the whole BG_LLM_TIMEOUT_MS budget (D#138 MEDIUM-3).
import { callHaikuJSONAsync, BG_LLM_TIMEOUT_MS } from './haiku-client.mjs';
import { truncate, debugCatch } from './utils.mjs';

/**
 * Build the enrichment prompt for Haiku.
 * @param {string} name Resource name
 * @param {string} content SKILL.md/AGENT.md content
 * @param {object} existingMeta Existing metadata from DB
 * @returns {string} Prompt string
 */
export function buildEnrichPrompt(name, content, existingMeta) {
  const truncated = truncate(content, 3000);
  const existing = existingMeta.intent_tags
    ? `\n<existing-metadata>\ncurrent_tags: ${existingMeta.intent_tags}\n</existing-metadata>`
    : '';

  return `You are a tool classification expert. Analyze this Claude Code skill and extract structured metadata.

<skill-name>${name}</skill-name>
<skill-content>
${truncated}
</skill-content>
${existing}
Return JSON only:
{"capability_summary":"One sentence (<80 chars)","intent_tags":"comma-separated intents","domain_tags":"comma-separated domains","trigger_patterns":"when to recommend","use_cases":"comma-separated scenarios","tech_stack":"comma-separated tech","quality_assessment":{"has_clear_instructions":true,"has_examples":false,"specificity":"high","estimated_utility":"high"}}`;
}

/**
 * Apply LLM enrichment results to a resource.
 * Only fills empty fields — never overwrites existing non-empty data.
 * @param {Database} db Registry database
 * @param {string} name Resource name
 * @param {string} type Resource type
 * @param {object} enrichResult LLM result JSON
 */
export function applyEnrichment(db, name, type, enrichResult) {
  const row = db.prepare('SELECT * FROM resources WHERE name = ? AND type = ?').get(name, type);
  if (!row) return;

  const updates = [];
  const params = [];

  // Only fill empty fields
  const fields = [
    'capability_summary',
    'intent_tags',
    'domain_tags',
    'trigger_patterns',
    'use_cases',
    'tech_stack',
  ];
  for (const f of fields) {
    if ((!row[f] || row[f].trim() === '') && enrichResult[f]) {
      updates.push(`${f} = ?`);
      params.push(enrichResult[f]);
    }
  }

  // Always update enrichment status
  updates.push("enrichment_status = 'done'");
  updates.push('enriched_at = ?');
  params.push(Date.now());

  // Quality tier upgrade based on assessment
  const qa = enrichResult.quality_assessment;
  if (qa && row.quality_tier === 'community') {
    if (qa.has_clear_instructions && (qa.specificity === 'high' || qa.specificity === 'medium')) {
      updates.push("quality_tier = 'verified'");
    }
  }

  params.push(name, type);
  db.prepare(`UPDATE resources SET ${updates.join(', ')} WHERE name = ? AND type = ?`).run(...params);
}

/**
 * Enrich a single resource via Haiku LLM.
 * @param {Database} db Registry database
 * @param {string} name Resource name
 * @param {string} type Resource type
 * @param {string} content SKILL.md/AGENT.md content
 * @returns {Promise<boolean>} true if enriched successfully
 */
export async function enrichResource(db, name, type, content) {
  const existing = db
    .prepare('SELECT intent_tags, capability_summary FROM resources WHERE name = ? AND type = ?')
    .get(name, type);
  if (!existing) return false;

  db.prepare("UPDATE resources SET enrichment_status = 'pending' WHERE name = ? AND type = ?").run(
    name,
    type,
  );

  try {
    const prompt = buildEnrichPrompt(name, content, existing);
    const result = await callHaikuJSONAsync(prompt, { timeout: BG_LLM_TIMEOUT_MS, maxTokens: 500 });

    if (!result || !result.capability_summary) {
      db.prepare("UPDATE resources SET enrichment_status = 'failed' WHERE name = ? AND type = ?").run(
        name,
        type,
      );
      return false;
    }

    applyEnrichment(db, name, type, result);
    return true;
  } catch (e) {
    debugCatch(e, 'enricher');
    db.prepare("UPDATE resources SET enrichment_status = 'failed' WHERE name = ? AND type = ?").run(
      name,
      type,
    );
    return false;
  }
}
