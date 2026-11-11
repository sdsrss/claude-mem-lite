#!/usr/bin/env node
// Mock claude CLI for E2E tests — deterministic JSON responses
// Usage: CLAUDE_CODE_PATH=scripts/mock-claude.mjs
// Called as: node mock-claude.mjs -p --model haiku  (with prompt on stdin)

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  data += chunk;
});
process.stdin.on('end', () => {
  const prompt = data.trim();

  // Detect prompt type and return appropriate JSON
  if (prompt.includes('"type":"decision|bugfix|feature|refactor|discovery|change"')) {
    // Episode extraction prompt
    const isError = prompt.includes('Error: yes');
    const isSingle = prompt.includes('Extract a structured observation');
    process.stdout.write(
      JSON.stringify({
        type: isError ? 'bugfix' : 'change',
        title: isSingle ? 'Mock single observation' : 'Mock episode summary',
        narrative: 'Mock narrative from LLM extraction describing what happened.',
        concepts: ['mock-concept', 'testing'],
        facts: ['mock fact 1', 'mock fact 2'],
        importance: isError ? 2 : 1,
        // v2.56.0 #1: paired-DROP gate requires substantive lesson for type=change
        // + imp<2. Real Haiku usually produces a lesson on first pass; the noise
        // band the gate targets is `lesson_learned: 'none'` after Haiku gave up.
        // Mock returns a realistic lesson so e2e tests exercise the save path.
        lesson_learned: 'Mock lesson — extracted insight that justifies persisting this observation.',
      }),
    );
  } else if (prompt.includes('A coding memory was just saved')) {
    // Save-time enrichment prompt (lib/save-enrich.mjs, G1+G2)
    process.stdout.write(
      JSON.stringify({
        lesson_learned: 'Mock distilled lesson — root cause plus fix in one sentence.',
        search_aliases: ['mock alias one', 'mock alias two', '模拟别名'],
      }),
    );
  } else if (prompt.includes('"request":"what the user was working on"')) {
    // Session summary prompt
    process.stdout.write(
      JSON.stringify({
        request: 'Mock session request description',
        investigated: 'Mock investigation details',
        learned: 'Mock key findings',
        completed: 'Mock accomplishments',
        next_steps: 'Mock suggested follow-up',
      }),
    );
  } else {
    // Unknown prompt type — return valid but generic JSON
    process.stdout.write(
      JSON.stringify({
        type: 'discovery',
        title: 'Unknown prompt type',
        narrative: 'Fallback response',
        concepts: [],
        facts: [],
        importance: 1,
      }),
    );
  }
});
