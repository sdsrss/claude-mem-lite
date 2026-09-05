// MCP must not silently drop a filter it doesn't recognize.
//
// The CLI and the MCP tools expose the same filters under different names:
//
//   CLI                       MCP
//   search --source S         type: S          ← and MCP `type` ≠ CLI `--type`
//   search --from/--to/--since  date_from/date_to/date_since
//   recent --type T           obs_type: T
//   recent --since D          date_since: D
//
// A caller working from the CLI vocabulary (the plugin doc tells agents to reach
// for `claude-mem-lite <cmd>`, so that vocabulary is the one in context) sends the
// CLI name. The MCP schema has no such property, so the validator strips it and the
// tool answers the UNFILTERED question — "recent bugfixes from the last day" comes
// back as every recent memory, with nothing marking the filter as dropped. A wider
// result set that looks filtered is the worst failure mode for a memory tool: the
// model reports it as the answer.
//
// v3.59.0 already closed the mirror-image gap (MCP field names accepted as CLI
// flags). These cases pin the other direction. `mem_search.type` keeps its
// source-table meaning — it is enum-validated, so the CLI mental model
// (`type: "bugfix"`) fails loudly with the valid values listed, which is fine.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';

const SERVER_PATH = resolve(import.meta.dirname, '../server.mjs');
const DB_DIR = join(tmpdir(), `mem-alias-test-${process.pid}`);

let client, transport;

function textOf(result) {
  return (result?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}
const idsOf = (text) => [...new Set((String(text).match(/#(\d+)/g) || []).map((s) => s.slice(1)))].sort();

beforeAll(async () => {
  try {
    rmSync(DB_DIR, { recursive: true });
  } catch {}
  mkdirSync(`${DB_DIR}/runtime`, { recursive: true });

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      ...process.env,
      CLAUDE_MEM_DIR: DB_DIR,
      CLAUDE_PROJECT_DIR: '/test/alias',
      PWD: '/test/alias',
      CLAUDE_MEM_AUTO_DEEP: '0',
      CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    },
  });
  client = new Client({ name: 'mem-alias-client', version: '0.0.0' });
  await client.connect(transport);

  const seed = [
    ['bugfix', 'Fixed the websocket idle timeout disconnect behind the balancer'],
    ['decision', 'Chose Redis over Memcached for the session store'],
    ['feature', 'Added a token bucket rate limiter to the public API'],
    ['bugfix', 'Fixed flaky CI from a shared test database connection pool'],
  ];
  for (const [type, content] of seed) {
    await client.callTool({ name: 'mem_save', arguments: { content, type } });
  }
}, 25_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {}
  try {
    await transport?.close();
  } catch {}
  try {
    rmSync(DB_DIR, { recursive: true });
  } catch {}
});

describe('mem_recent honors CLI filter names', () => {
  it('`type` (CLI `recent --type`) filters, and matches `obs_type`', async () => {
    const viaCli = idsOf(
      textOf(await client.callTool({ name: 'mem_recent', arguments: { limit: 10, type: 'bugfix' } })),
    );
    const viaMcp = idsOf(
      textOf(await client.callTool({ name: 'mem_recent', arguments: { limit: 10, obs_type: 'bugfix' } })),
    );
    const unfiltered = idsOf(textOf(await client.callTool({ name: 'mem_recent', arguments: { limit: 10 } })));

    expect(viaCli).toEqual(viaMcp);
    expect(viaCli.length).toBeGreaterThan(0);
    expect(viaCli.length, 'the filter must actually narrow the set').toBeLessThan(unfiltered.length);
  });

  it('`since` (CLI `recent --since`) filters, and matches `date_since`', async () => {
    const viaCli = idsOf(
      textOf(await client.callTool({ name: 'mem_recent', arguments: { limit: 10, since: '30s' } })),
    );
    const viaMcp = idsOf(
      textOf(await client.callTool({ name: 'mem_recent', arguments: { limit: 10, date_since: '30s' } })),
    );
    expect(viaCli).toEqual(viaMcp);
    // Equality alone passes when BOTH sides drop the filter. A window that excludes
    // everything is what proves the alias is honored.
    const excluded = textOf(
      await client.callTool({ name: 'mem_recent', arguments: { limit: 10, since: '1s' } }),
    );
    await new Promise((r) => setTimeout(r, 1100));
    const stillExcluded = idsOf(
      textOf(await client.callTool({ name: 'mem_recent', arguments: { limit: 10, since: '1s' } })),
    );
    expect(
      stillExcluded,
      `a 1s window must exclude rows seeded seconds ago (got: ${excluded.slice(0, 80)})`,
    ).toEqual([]);
  });

  it('rejects a bad `since` instead of ignoring it', async () => {
    const res = await client.callTool({ name: 'mem_recent', arguments: { limit: 10, since: 'banana' } });
    expect(textOf(res)).toMatch(/Invalid date_since|Invalid since/i);
  });

  it('canonical name wins when both are supplied', async () => {
    const both = idsOf(
      textOf(
        await client.callTool({
          name: 'mem_recent',
          arguments: { limit: 10, obs_type: 'bugfix', type: 'decision' },
        }),
      ),
    );
    const canonical = idsOf(
      textOf(await client.callTool({ name: 'mem_recent', arguments: { limit: 10, obs_type: 'bugfix' } })),
    );
    expect(both).toEqual(canonical);
  });
});

describe('mem_search honors CLI filter names', () => {
  it('`source` (CLI `search --source`) filters, and matches `type`', async () => {
    const viaCli = textOf(
      await client.callTool({ name: 'mem_search', arguments: { query: 'fixed', source: 'sessions' } }),
    );
    const viaMcp = textOf(
      await client.callTool({ name: 'mem_search', arguments: { query: 'fixed', type: 'sessions' } }),
    );
    // No sessions exist in this fresh DB, so a HONORED sessions-filter returns
    // nothing on both paths; a DROPPED one returns the observation hits.
    expect(idsOf(viaCli)).toEqual(idsOf(viaMcp));
    expect(idsOf(viaCli)).toEqual([]);
  });

  it('`since` (CLI `search --since`) filters, and matches `date_since`', async () => {
    const viaCli = idsOf(
      textOf(await client.callTool({ name: 'mem_search', arguments: { query: 'fixed', since: '30s' } })),
    );
    const viaMcp = idsOf(
      textOf(await client.callTool({ name: 'mem_search', arguments: { query: 'fixed', date_since: '30s' } })),
    );
    expect(viaCli).toEqual(viaMcp);
    // Narrowing proof (see the mem_recent sibling): a 1s window must drop everything.
    await new Promise((r) => setTimeout(r, 1100));
    const narrowed = idsOf(
      textOf(await client.callTool({ name: 'mem_search', arguments: { query: 'fixed', since: '1s' } })),
    );
    expect(narrowed, 'a 1s window must exclude rows seeded seconds ago').toEqual([]);
  });

  it('`from`/`to` (CLI `search --from/--to`) filter, and match date_from/date_to', async () => {
    const future = '2099-01-01';
    const viaCli = idsOf(
      textOf(await client.callTool({ name: 'mem_search', arguments: { query: 'fixed', from: future } })),
    );
    const viaMcp = idsOf(
      textOf(await client.callTool({ name: 'mem_search', arguments: { query: 'fixed', date_from: future } })),
    );
    expect(viaCli).toEqual(viaMcp);
    expect(viaCli, 'a future lower bound must exclude everything').toEqual([]);
  });

  it('`type` keeps its source-table meaning and rejects an obs type loudly', async () => {
    // Enum-validated: the caller gets an error naming the valid source tables, not a
    // silent empty result — that is the acceptable half of the `type` name collision.
    let message;
    try {
      const res = await client.callTool({
        name: 'mem_search',
        arguments: { query: 'fixed', type: 'bugfix' },
      });
      expect(res?.isError, 'expected a validation failure').toBe(true);
      message = textOf(res);
    } catch (err) {
      message = String(err?.message || err);
    }
    expect(message).toMatch(/observations/i);
  });
});
