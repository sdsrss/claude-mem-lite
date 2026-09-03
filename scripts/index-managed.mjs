#!/usr/bin/env node
// Smart feature extractor & indexer for managed skills/agents v2
// Multi-dimensional feature extraction for intent-based hook dispatch
// Advantage over Claude Code native: weighted scoring, usage learning, zero startup tokens

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveDataDir } from '../lib/resolve-data-dir.mjs';
import { discoverAllManaged, withRelativePaths } from '../resource-discovery.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';
import { FTS5_SCHEMA, TRIGGERS_SCHEMA } from '../registry.mjs';

// D#29: honor CLAUDE_MEM_DIR (offline indexer must read the same relocated data dir
// install.mjs/registry-scanner use; equals homedir when the env is unset).
const BASE_DIR = resolveDataDir(process.env.CLAUDE_MEM_DIR);
const MANAGED_DIR = join(BASE_DIR, 'managed');
const DB_PATH = join(BASE_DIR, 'resource-registry.db');

// ─── YAML Frontmatter Parser ─────────────────────────────────────────────────
// Lightweight YAML subset parser for skill/agent frontmatter.
// Known limitations: does not handle YAML arrays (- item), nested objects,
// or unquoted values containing colons (e.g. bare URLs). For such fields,
// wrap the value in quotes in the frontmatter: url: "https://..."

// parseFrontmatter is lib/frontmatter.mjs's (audit 2026-09-02 P1-16). This file carried a
// byte-identical 30-line copy — the largest duplicate block in the tree.

// ─── Feature Extraction v2 — Multi-Dimensional ──────────────────────────────

// Intents: what the user wants to accomplish
const INTENTS = {
  review:      [/\breview\b/i, /\baudit\b/i, /check\s*quality/i, /\binspect\b/i, /\blint\b/i, /code\s*quality/i, /static\s*analysis/i, /code\s*smell/i],
  debug:       [/\bdebug\b/i, /troubleshoot/i, /\berror\b/i, /\bbug\b/i, /diagnose/i, /root\s*cause/i, /stack\s*trace/i, /breakpoint/i, /\bfix\s+(?:bug|error|issue)/i],
  test:        [/\btest\b/i, /\btdd\b/i, /unit\s*test/i, /\be2e\b/i, /integration\s*test/i, /\bcoverage\b/i, /\bspec\b/i, /\bassert\b/i, /test\s*driven/i, /\bmock\b/i],
  generate:    [/\bcreate\b/i, /\bbuild\b/i, /\bscaffold\b/i, /\bgenerate\b/i, /\bimplement\b/i, /new\s*feature/i, /boilerplate/i, /\bstarter\b/i],
  deploy:      [/\bdeploy\b/i, /ci[\s/]*cd/i, /\bpipeline\b/i, /\brelease\b/i, /\bship\b/i, /\bpublish\b/i, /continuous\s*(integration|delivery|deployment)/i],
  refactor:    [/\brefactor\b/i, /\boptimize\b/i, /\bimprove\b/i, /clean\s*up/i, /\bsimplify\b/i, /restructure/i, /\bmodernize\b/i, /tech\s*debt/i],
  document:    [/\bdocument\b/i, /\bdocs?\b/i, /\breadme\b/i, /api\s*doc/i, /\bcomment\b/i, /\bannotate\b/i, /\bchangelog\b/i, /\bjsdoc\b/i],
  plan:        [/\bplan\b/i, /\bdesign\b/i, /\barchitect\b/i, /\bblueprint\b/i, /\broadmap\b/i, /\bstrategy\b/i, /\bspec(ification)?\b/i, /\brfc\b/i],
  security:    [/\bsecurity\b/i, /vulnerab/i, /\bauthenticat/i, /\bauthoriz/i, /\bencrypt/i, /\bxss\b/i, /injection/i, /penetrat/i, /\bthreat\b/i, /\bsast\b/i, /\bdast\b/i],
  performance: [/\bperformance\b/i, /\bprofil/i, /\bbenchmark\b/i, /\bspeed\b/i, /\blatency\b/i, /\bcache\b/i, /\bbottleneck\b/i, /\bmemory\s*leak/i, /\bload\s*test/i],
  database:    [/\bdatabase\b/i, /\bsql\b/i, /\bquery\b/i, /\bmigration\b/i, /\bschema\b/i, /\borm\b/i, /\btable\b/i, /\bindex\b/i],
  ui:          [/\bui\b/i, /\bux\b/i, /design\s*system/i, /\bcomponent\b/i, /\blayout\b/i, /\bresponsive\b/i, /\bcss\b/i, /\bstyl/i, /\bvisual\b/i, /\baccessib/i],
  api:         [/\bapi\b/i, /\brest\b/i, /\bgraphql\b/i, /\bendpoint\b/i, /\bgrpc\b/i, /\bopenapi\b/i, /\bswagger\b/i, /\broute\b/i, /\bwebhook\b/i],
  infra:       [/\bdevops\b/i, /\binfrastructure\b/i, /\bcloud\b/i, /\bterraform\b/i, /\bdocker\b/i, /\bkubernetes\b/i, /\bcontainer\b/i, /\bhelm\b/i, /\bansible\b/i],
  monitor:     [/\bmonitor\b/i, /\bobserv/i, /\blogging\b/i, /\balert\b/i, /\bmetric\b/i, /\btrac(e|ing)\b/i, /\bdashboard\b/i, /\bsla\b/i],
  collaborate: [/\bpr\b/i, /pull\s*request/i, /\bgit\b/i, /\bbranch\b/i, /\bmerge\b/i, /\bcommit\b/i, /\bworkflow\b/i, /\bonboard/i],
  learn:       [/\blearn\b/i, /\btutorial\b/i, /\bguide\b/i, /\bexplain\b/i, /\bteach\b/i, /best\s*practice/i, /\bpattern\b/i, /\banti.?pattern\b/i],
  migrate:     [/\bmigrat/i, /\bupgrad/i, /\bconvert\b/i, /\bport\b/i, /\blegacy\b/i, /\bmoderniz/i, /version\s*bump/i],
};

// Domains: technology areas
const DOMAINS = {
  frontend:    [/\breact\b/i, /\bvue\b/i, /\bangular\b/i, /\bsvelte\b/i, /next\.?js/i, /\bnuxt\b/i, /\bcss\b/i, /\btailwind\b/i, /\bhtml\b/i, /\bdom\b/i, /\bjsx\b/i],
  backend:     [/\bexpress\b/i, /\bfastapi\b/i, /\bdjango\b/i, /\bflask\b/i, /\brails\b/i, /\bspring\b/i, /\bmiddleware\b/i, /\bcontroller\b/i, /\bhono\b/i],
  database:    [/\bpostgres/i, /\bmysql\b/i, /\bmongodb\b/i, /\bredis\b/i, /\bsqlite\b/i, /\bprisma\b/i, /\bdrizzle\b/i, /\bsequelize\b/i, /\bsupabase\b/i],
  devops:      [/\bdocker\b/i, /\bkubernetes\b/i, /\bterraform\b/i, /\bansible\b/i, /github\s*actions/i, /\bgitlab/i, /\bjenkins\b/i, /\bhelm\b/i, /\bargocd\b/i],
  cloud:       [/\baws\b/i, /\bgcp\b/i, /\bazure\b/i, /\blambda\b/i, /\bserverless\b/i, /\bcloudflare\b/i, /\bvercel\b/i, /\bnetlify\b/i, /\bec2\b/i, /\bs3\b/i],
  security:    [/\boauth\b/i, /\bjwt\b/i, /\btls\b/i, /\bssl\b/i, /\brbac\b/i, /\bcors\b/i, /\bcsp\b/i, /\bsso\b/i, /\bsaml\b/i],
  mobile:      [/\bios\b/i, /\bandroid\b/i, /react.native/i, /\bflutter\b/i, /\bswift(ui)?\b/i, /\bkotlin\b/i, /\bexpo\b/i],
  testing:     [/\bjest\b/i, /\bvitest\b/i, /\bpytest\b/i, /\bmocha\b/i, /\bcypress\b/i, /\bplaywright\b/i, /\bselenium\b/i],
  python:      [/\bpython\b/i, /\bpip\b/i, /\bpoetry\b/i, /\bpydantic\b/i, /\buvicorn\b/i, /\basyncio\b/i, /\bcelery\b/i],
  javascript:  [/\bjavascript\b/i, /\btypescript\b/i, /\bnode\b/i, /\bnpm\b/i, /\bdeno\b/i, /\bbun\b/i, /\besbuild\b/i, /\bvite\b/i],
  rust:        [/\brust\b/i, /\bcargo\b/i, /\btokio\b/i, /\bwasm\b/i, /\baxum\b/i],
  go:          [/\bgolang\b/i, /\bgoroutine\b/i, /\bgin\b/i, /\bfiber\b/i],
  java:        [/\bjava\b(?!script)/i, /\bspring\b/i, /\bmaven\b/i, /\bgradle\b/i, /\bjvm\b/i],
  ml:          [/machine\s*learning/i, /\bneural\b/i, /\btensor/i, /\bpytorch\b/i, /\btransformer\b/i, /\bllm\b/i, /\bembedding\b/i, /\brag\b/i],
  architecture:[/\bmicroservice/i, /\bmonolith/i, /event.driven/i, /\bddd\b/i, /\bcqrs\b/i, /hexagonal/i, /clean\s*arch/i, /\bdistributed\b/i, /\bsaga\b/i],
};

// Specific technology names for tech_stack field
const TECH_NAMES = [
  'react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxt', 'remix', 'astro', 'solid',
  'express', 'fastapi', 'django', 'flask', 'rails', 'spring', 'nestjs', 'hono', 'fastify',
  'postgres', 'mysql', 'mongodb', 'redis', 'sqlite', 'dynamodb', 'cassandra', 'elasticsearch',
  'prisma', 'drizzle', 'sequelize', 'typeorm', 'sqlalchemy', 'supabase',
  'docker', 'kubernetes', 'terraform', 'ansible', 'pulumi', 'helm', 'argocd',
  'aws', 'gcp', 'azure', 'cloudflare', 'vercel', 'netlify', 'railway', 'fly.io',
  'jest', 'vitest', 'pytest', 'mocha', 'cypress', 'playwright', 'selenium', 'storybook',
  'tailwind', 'shadcn', 'material-ui', 'chakra', 'bootstrap',
  'graphql', 'grpc', 'trpc', 'openapi', 'websocket',
  'oauth', 'jwt', 'passport', 'clerk', 'auth0', 'firebase',
  'github-actions', 'gitlab-ci', 'jenkins', 'circleci',
  'python', 'typescript', 'javascript', 'rust', 'go', 'java', 'kotlin', 'swift',
  'pytorch', 'tensorflow', 'langchain', 'llamaindex', 'openai', 'anthropic',
  'kafka', 'rabbitmq', 'nats', 'pulsar',
  'prometheus', 'grafana', 'datadog', 'sentry', 'jaeger',
  'nginx', 'caddy', 'traefik', 'envoy', 'istio', 'linkerd',
];

function countMatches(text, patterns) {
  let total = 0;
  for (const re of patterns) {
    const m = text.match(new RegExp(re.source, 'gi'));
    if (m) total += m.length;
  }
  return total;
}

function extractFeatures(frontmatter, body) {
  const desc = frontmatter.description || '';
  const name = frontmatter.name || '';
  // Weight: description 3x, name 2x, body 1x
  const descWeighted = desc + ' ' + desc + ' ' + desc;
  const nameWeighted = name + ' ' + name;
  const fullText = nameWeighted + ' ' + descWeighted + ' ' + body;

  // ── 1. Intent tags (scored, weighted) ─────────────────────────────────
  const intentScores = {};
  for (const [intent, patterns] of Object.entries(INTENTS)) {
    const descScore = countMatches(desc, patterns) * 3;
    const bodyScore = countMatches(body, patterns);
    const total = descScore + bodyScore;
    if (total > 0) intentScores[intent] = total;
  }
  // Cap to top 5 intents — over-tagging dilutes FTS matching accuracy
  const sortedIntents = Object.entries(intentScores)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([k]) => k);

  // ── 2. Domain tags (scored, weighted) ─────────────────────────────────
  const domainScores = {};
  for (const [domain, patterns] of Object.entries(DOMAINS)) {
    const descScore = countMatches(desc, patterns) * 3;
    const bodyScore = countMatches(body, patterns);
    const total = descScore + bodyScore;
    if (total > 0) domainScores[domain] = total;
  }
  // Cap to top 5 domains
  const sortedDomains = Object.entries(domainScores)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([k]) => k);

  // ── 3. Action type — primary verb ─────────────────────────────────────
  const actionVerbs = {
    review:   /\breview\b|\baudit\b|\binspect\b|\bcheck\b|\bevaluate\b|\banalyze\b/gi,
    generate: /\bcreate\b|\bbuild\b|\bscaffold\b|\bgenerate\b|\bimplement\b/gi,
    debug:    /\bdebug\b|\bfix\b|\btroubleshoot\b|\bdiagnose\b|\bresolve\b/gi,
    test:     /\btest\b|\bverify\b|\bvalidate\b|\bassert\b/gi,
    deploy:   /\bdeploy\b|\brelease\b|\bpublish\b|\bship\b/gi,
    refactor: /\brefactor\b|\boptimize\b|\bimprove\b|\bclean\b/gi,
    document: /\bdocument\b|\bexplain\b|\bdescribe\b|\bannotate\b/gi,
    plan:     /\bplan\b|\bdesign\b|\barchitect\b|\bblueprint\b/gi,
    analyze:  /\banalyze\b|\bprofile\b|\bbenchmark\b|\bmeasure\b|\bassess\b/gi,
    migrate:  /\bmigrate\b|\bupgrade\b|\bconvert\b|\bport\b/gi,
  };
  let bestAction = '', bestCount = 0;
  for (const [action, re] of Object.entries(actionVerbs)) {
    // Weight description matches higher
    const descMatches = (desc.match(re) || []).length * 3;
    const bodyMatches = (body.match(re) || []).length;
    const total = descMatches + bodyMatches;
    if (total > bestCount) { bestCount = total; bestAction = action; }
  }

  // ── 4. Trigger patterns — multi-source extraction ─────────────────────
  const triggers = new Set();

  // From description: "Use when..." / "Use for..." / "Use proactively..."
  const useWhenAll = desc.matchAll(/use\s+(?:this\s+)?(?:when|for|proactively\s*(?:when|for)?)\s+(.+?)(?:\.\s|$)/gi);
  for (const m of useWhenAll) {
    const words = m[1].replace(/[()[\]{}]/g, '').match(/\b[a-z]{3,}(?:\s+[a-z]{3,}){0,2}/gi);
    if (words) words.forEach(w => triggers.add(w.replace(/\s+/g, '\\s+')));
  }

  // From description: verb+object patterns
  const verbObj = desc.match(/(?:review|debug|test|create|build|deploy|refactor|optimize|scaffold|analyze|design|implement|fix|diagnose|audit|check|monitor|migrate|upgrade)\s+\w+(?:\s+\w+)?/gi);
  if (verbObj) verbObj.forEach(p => triggers.add(p.replace(/\s+/g, '\\s+')));

  // From description: quoted phrases
  const quoted = desc.match(/"([^"]+)"/g);
  if (quoted) quoted.forEach(q => triggers.add(q.replace(/"/g, '').replace(/\s+/g, '\\s+')));

  // From body: "When to Use" section items
  const whenSection = body.match(/(?:##\s*When\s+to\s+Use|##\s*Use\s+Cases?|##\s*When\s+This\s+(?:Skill|Agent)\s+Applies)\s*\n([\s\S]*?)(?=\n##\s|\n$)/i);
  if (whenSection) {
    const bullets = whenSection[1].match(/^[-*]\s+(.+)$/gm);
    if (bullets) {
      bullets.forEach(b => {
        const clean = b.replace(/^[-*]\s+/, '').replace(/[()[\]{}]/g, '').trim();
        const kw = clean.match(/\b[a-z]{3,}(?:\s+[a-z]{3,}){0,2}/gi);
        if (kw) kw.slice(0, 3).forEach(w => triggers.add(w.replace(/\s+/g, '\\s+')));
      });
    }
  }

  // ── 5. Capability summary — structured extraction ─────────────────────
  const sections = (body.match(/^#{1,3}\s+(.+)$/gm) || [])
    // `u` flag required: without it this class holds the SURROGATE UNITS of the
    // three astral emoji, so the shared lead \uD83D strips out of EVERY other
    // U+1F3xx–1F5xx emoji and leaves a lone trailing surrogate behind —
    // "## 📊 Metrics" became "\uDCCA Metrics", which then went into `resources`
    // and `resources_fts` as unpaired UTF-16. With `u` the class matches whole
    // code points: only the four listed emoji are stripped, the rest survive intact.
    .map(s => s.replace(/^#{1,3}\s+/, '').replace(/[#*`🚀📋⚡🔍]/gu, '').trim())
    .filter(s => s.length > 2 && !/^(overview|purpose|table of contents|---)/i.test(s))
    .slice(0, 8);

  const paragraphs = body.split(/\n\n+/).filter(p =>
    p.trim() && !p.startsWith('#') && !p.startsWith('---') &&
    !p.startsWith('```') && p.trim().length > 30
  );
  const firstPara = (paragraphs[0] || '').replace(/\n/g, ' ').trim().slice(0, 300);

  const summary = [
    desc.slice(0, 200),
    firstPara ? `Detail: ${firstPara}` : '',
    sections.length ? `Sections: ${sections.join(', ')}` : '',
  ].filter(Boolean).join(' | ');

  // ── 6. Tech stack — specific technology names found ───────────────────
  const techStack = new Set();
  for (const tech of TECH_NAMES) {
    const re = new RegExp(`\\b${tech.replace(/[-.]/g, '[\\s\\-.]?')}\\b`, 'i');
    if (re.test(fullText)) techStack.add(tech);
  }

  // ── 7. Use cases — extracted from body ────────────────────────────────
  const useCases = [];
  // From bullet lists under "When to Use", "Use Cases", "Capabilities"
  const caseSections = body.matchAll(/(?:##\s*(?:When|Use|Capabilit|What|Feature|Responsibilit)[^\n]*)\s*\n([\s\S]*?)(?=\n##\s|\n$)/gi);
  for (const cs of caseSections) {
    const bullets = cs[1].match(/^[-*]\s+(.+)$/gm);
    if (bullets) {
      bullets.forEach(b => useCases.push(b.replace(/^[-*]\s+/, '').trim().slice(0, 100)));
    }
  }

  // ── 8. Complexity detection ───────────────────────────────────────────
  let complexity = 'intermediate';
  if (/\bbeginner\b|\bsimple\b|\bbasic\b|\bstarter\b|\bquick\s*start/i.test(fullText)) complexity = 'beginner';
  if (/\badvanced\b|\bexpert\b|\bmaster\b|\bsenior\b|\barchitect\b|\bdistributed\b|\bcomplex/i.test(fullText)) complexity = 'advanced';

  // ── 9. Input/Output types ─────────────────────────────────────────────
  const inputTypes = new Set();
  if (/\bcode\b|\bsource\b|\bfile\b|\bfunction\b|\bclass\b|\bmodule\b/i.test(fullText)) inputTypes.add('code');
  if (/\bconfig\b|\byaml\b|\bjson\b|\btoml\b|\.env\b/i.test(fullText)) inputTypes.add('config');
  if (/\burl\b|\bendpoint\b/i.test(fullText)) inputTypes.add('url');
  if (/\bproject\b|\brepo\b|\bcodebase\b/i.test(fullText)) inputTypes.add('project');
  if (/\bprompt\b|\bquery\b|\bquestion\b/i.test(fullText)) inputTypes.add('prompt');
  if (/\bimage\b|\bscreenshot\b/i.test(fullText)) inputTypes.add('visual');
  if (/\bdiff\b|\bpatch\b|\bchanges?\b/i.test(fullText)) inputTypes.add('diff');

  const outputTypes = new Set();
  if (/\breport\b|\bfinding\b|\banalysis\b|\bassessment\b/i.test(fullText)) outputTypes.add('report');
  if (/\bcode\b|\bimplementation\b|\bsnippet\b/i.test(fullText)) outputTypes.add('code');
  if (/\bplan\b|\broadmap\b|\bstrategy\b|\bblueprint\b/i.test(fullText)) outputTypes.add('plan');
  if (/\bfix\b|\bpatch\b|\bsolution\b|\bresolution\b/i.test(fullText)) outputTypes.add('fix');
  if (/\bdoc\b|\bdocumentation\b|\breadme\b|\bguide\b/i.test(fullText)) outputTypes.add('documentation');
  if (/\btemplate\b|\bscaffold\b|\bboilerplate\b/i.test(fullText)) outputTypes.add('template');
  if (/\bworkflow\b|\bpipeline\b|\bconfig\b/i.test(fullText)) outputTypes.add('workflow');

  // ── 10. Prerequisites ─────────────────────────────────────────────────
  const prereqs = {};
  if (frontmatter.tools) {
    prereqs.tools = Array.isArray(frontmatter.tools)
      ? frontmatter.tools : String(frontmatter.tools).split(/[,\s]+/).filter(Boolean);
  }
  if (frontmatter.model) prereqs.model = frontmatter.model;
  if (frontmatter.color) prereqs.color = frontmatter.color;

  // ── 11. Keywords — important terms for FTS boosting ───────────────────
  // Extract unique significant words from description (for FTS)
  const stopWords = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had',
    'do','does','did','will','would','could','should','may','might','shall','can','need',
    'for','and','but','or','not','with','this','that','from','into','through','during',
    'before','after','above','below','between','under','again','further','then','once',
    'here','there','when','where','why','how','all','each','every','both','few','more',
    'most','other','some','such','than','too','very','just','about','also','use','used',
    'using','user','users','well','new','make','like','including','across','ensuring']);
  const descWords = desc.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  const keywords = [...new Set(descWords.filter(w => !stopWords.has(w)))].slice(0, 20);

  // Fallback: if no trigger_patterns extracted, derive from description + intent
  let triggerStr = [...triggers].slice(0, 15).join('|');
  if (!triggerStr && desc) {
    // Use first sentence of description + intent tags as fallback trigger
    const firstSentence = desc.replace(/\.\s.*/, '').trim();
    if (firstSentence) triggerStr = firstSentence.replace(/\s+/g, '\\s+').slice(0, 200);
  }

  return {
    intent_tags: sortedIntents.join(','),
    domain_tags: sortedDomains.join(','),
    action_type: bestAction,
    trigger_patterns: triggerStr,
    capability_summary: summary.slice(0, 600),
    input_type: [...inputTypes].join(','),
    output_type: [...outputTypes].join(','),
    prerequisites: JSON.stringify(prereqs),
    // New v2 fields:
    tech_stack: [...techStack].join(','),
    use_cases: useCases.slice(0, 10).join('||'),
    complexity,
    keywords: keywords.join(' '),
  };
}

// ─── File Discovery (delegated to resource-discovery.mjs) ────────────────────

function discoverAll() {
  return withRelativePaths(discoverAllManaged(MANAGED_DIR), MANAGED_DIR);
}

// ─── Repo URL Lookup ─────────────────────────────────────────────────────────

function lookupRepoUrl(db, name, type) {
  try {
    const row = db.prepare(
      'SELECT repo_url FROM preinstalled WHERE name = ? AND type = ?'
    ).get(name.split('/')[0], type);
    return row?.repo_url || '';
  } catch { return ''; }
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return h.toString(16);
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log('🔍 Scanning managed/ directory...');
  const items = discoverAll();
  const agents = items.filter(i => i.type === 'agent');
  const skills = items.filter(i => i.type === 'skill');
  console.log(`   Found ${items.length} items (${agents.length} agents, ${skills.length} skills)`);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Add new v2 columns if missing
  const newCols = ['tech_stack', 'use_cases', 'complexity', 'keywords', 'parent_plugin'];
  for (const col of newCols) {
    if (!/^[a-z_]+$/.test(col)) throw new Error(`Invalid column name: ${col}`);
    try { db.exec(`ALTER TABLE resources ADD COLUMN ${col} TEXT DEFAULT ''`); } catch {}
  }

  // Drop old FTS + triggers (may have wrong column order), rebuild with canonical order
  const triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='resources'"
  ).all();
  for (const t of triggers) {
    try { db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`); } catch {}
  }
  try { db.exec('DROP TABLE IF EXISTS resources_fts'); } catch {}

  // Rebuild FTS from registry.mjs's canonical definition (audit 2026-09-02 P1-16). The
  // copy that used to live here restated the BM25 weights in a comment and gave
  // trigger_patterns a weight of five, while the shipped bm25() call has always been
  // 3,3,3,2,2,1,1,1 — a duplicated block drifting in its DOCUMENTATION first, which is how
  // a reader ends up tuning against a weight that does not exist. The real weights live at
  // registry-retriever.mjs's COMPOSITE_EXPR, and the guard in
  // tests/frontmatter-single-home.test.mjs sweeps for the stale spelling, so this note
  // deliberately does not reproduce it.
  // `IF NOT EXISTS` in the shared text is harmless here: the table was dropped above.
  db.exec(FTS5_SCHEMA);

  // UPSERT: preserve resource IDs so invocations.resource_id stays valid
  const upsert = db.prepare(`
    INSERT INTO resources (
      name, type, status, source, repo_url, local_path, parent_plugin, file_hash,
      intent_tags, domain_tags, action_type, trigger_patterns,
      capability_summary, input_type, output_type, prerequisites,
      tech_stack, use_cases, complexity, keywords, indexed_at
    ) VALUES (
      @name, @type, 'active', 'preinstalled', @repo_url, @local_path, @parent_plugin, @file_hash,
      @intent_tags, @domain_tags, @action_type, @trigger_patterns,
      @capability_summary, @input_type, @output_type, @prerequisites,
      @tech_stack, @use_cases, @complexity, @keywords, datetime('now')
    )
    ON CONFLICT(type, name) DO UPDATE SET
      status='active', source='preinstalled',
      repo_url=excluded.repo_url, local_path=excluded.local_path,
      parent_plugin=excluded.parent_plugin, file_hash=excluded.file_hash,
      intent_tags=excluded.intent_tags, domain_tags=excluded.domain_tags,
      action_type=excluded.action_type, trigger_patterns=excluded.trigger_patterns,
      capability_summary=excluded.capability_summary, input_type=excluded.input_type,
      output_type=excluded.output_type, prerequisites=excluded.prerequisites,
      tech_stack=excluded.tech_stack, use_cases=excluded.use_cases,
      complexity=excluded.complexity, keywords=excluded.keywords,
      indexed_at=datetime('now'), updated_at=datetime('now')
  `);

  let indexed = 0, errors = 0;
  const indexedNames = new Set();

  const upsertAll = db.transaction(() => {
    for (const item of items) {
      try {
        const content = readFileSync(item.absPath, 'utf8');
        if (content.trim().length < 10) { errors++; continue; } // skip near-empty

        const { frontmatter, body } = parseFrontmatter(content);
        const features = extractFeatures(frontmatter, body);
        const repoUrl = lookupRepoUrl(db, item.name, item.type);
        const hash = simpleHash(content);

        upsert.run({
          name: item.name,
          type: item.type,
          repo_url: repoUrl,
          local_path: item.filePath,
          parent_plugin: item.parentPlugin || null,
          file_hash: hash,
          ...features,
        });
        indexedNames.add(`${item.type}:${item.name}`);
        indexed++;
      } catch (e) {
        console.error(`   ✗ ${item.type} ${item.name}: ${e.message}`);
        errors++;
      }
    }

    // Soft-disable resources no longer in the scan (preserves invocations history)
    const allResources = db.prepare('SELECT id, type, name FROM resources WHERE status = ?').all('active');
    for (const r of allResources) {
      if (!indexedNames.has(`${r.type}:${r.name}`)) {
        db.prepare("UPDATE resources SET status = 'disabled', updated_at = datetime('now') WHERE id = ?").run(r.id);
      }
    }
  });

  upsertAll();

  // Populate FTS from resources table (triggers not yet active during UPSERT)
  db.exec(`
    INSERT INTO resources_fts(rowid, trigger_patterns, keywords, capability_summary,
      intent_tags, use_cases, domain_tags, tech_stack, name)
    SELECT id, trigger_patterns, keywords, capability_summary,
      intent_tags, use_cases, domain_tags, tech_stack, name
    FROM resources WHERE status = 'active'
  `);

  // Recreate FTS sync triggers for future changes — registry.mjs's definition (P1-16).
  db.exec(TRIGGERS_SCHEMA);


  // Stats
  const stats = db.prepare('SELECT type, COUNT(*) as cnt FROM resources GROUP BY type').all();
  const emptyStats = db.prepare(`
    SELECT
      SUM(CASE WHEN intent_tags = '' THEN 1 ELSE 0 END) as empty_intent,
      SUM(CASE WHEN domain_tags = '' THEN 1 ELSE 0 END) as empty_domain,
      SUM(CASE WHEN tech_stack = '' THEN 1 ELSE 0 END) as empty_tech,
      SUM(CASE WHEN keywords = '' THEN 1 ELSE 0 END) as empty_kw,
      COUNT(*) as total
    FROM resources
  `).get();

  console.log(`\n✅ Indexing complete:`);
  console.log(`   Indexed: ${indexed}  Errors: ${errors}`);
  for (const { type, cnt } of stats) console.log(`   ${type}: ${cnt}`);
  console.log(`\n📊 Feature coverage:`);
  console.log(`   Empty intent_tags:  ${emptyStats.empty_intent}/${emptyStats.total}`);
  console.log(`   Empty domain_tags:  ${emptyStats.empty_domain}/${emptyStats.total}`);
  console.log(`   Empty tech_stack:   ${emptyStats.empty_tech}/${emptyStats.total}`);
  console.log(`   Empty keywords:     ${emptyStats.empty_kw}/${emptyStats.total}`);

  // Samples
  console.log('\n📋 Sample features:');
  const samples = db.prepare(`
    SELECT name, type, intent_tags, domain_tags, tech_stack, action_type, complexity,
           substr(keywords, 1, 60) as kw, substr(trigger_patterns, 1, 60) as trig
    FROM resources ORDER BY RANDOM() LIMIT 5
  `).all();
  for (const s of samples) {
    console.log(`\n  ${s.type} "${s.name}" [${s.complexity}] action=${s.action_type}`);
    console.log(`    intents: ${s.intent_tags}`);
    console.log(`    domains: ${s.domain_tags}`);
    console.log(`    tech:    ${s.tech_stack}`);
    console.log(`    kw:      ${s.kw}`);
    console.log(`    trigger: ${s.trig}`);
  }

  db.close();
  console.log('\n✅ Done.');
}

main();
