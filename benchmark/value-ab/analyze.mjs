// Summarise a value A/B batch (benchmark/value-ab/launch.sh): per-trajectory outcome, what the S2 session could
// see before it started, plugin calls, cost and context size, then per model: S2 complete-continuation counts with
// a two-sided Fisher exact test (the pre-registered primary metric of docs/audits/20261124-value-ab-preregistration.md).
// Usage: node benchmark/value-ab/analyze.mjs <workdir>   (reads <workdir>/runs/<model>-<arm>-<n>/, writes rows.json)
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const KEY = /SAVE10|FLAT5|优惠码|coupon/i;

function comb(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** Two-sided Fisher exact p for a/n1 successes against c/n2 (sum of tables no more likely than the observed one). */
export function fisherTwoSided(a, n1, c, n2) {
  const K = a + c;
  const N = n1 + n2;
  const p = (x) => (comb(n1, x) * comb(n2, K - x)) / comb(N, K);
  const obs = p(a);
  let sum = 0;
  for (let x = Math.max(0, K - n2); x <= Math.min(K, n1); x++) if (p(x) <= obs * (1 + 1e-9)) sum += p(x);
  return Math.min(1, sum);
}

const listJsonl = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((proj) => {
        const p = join(dir, proj);
        return statSync(p).isDirectory()
          ? readdirSync(p)
              .filter((f) => f.endsWith('.jsonl'))
              .map((f) => join(p, f))
          : [];
      })
    : [];

/** Transcripts that appeared in post-S<n> and not in post-S<n-1>. */
function sessionFiles(run, n) {
  const prev = new Set(
    n > 1 ? listJsonl(join(run, `post-S${n - 1}`, 'cfgprojects')).map((f) => basename(f)) : [],
  );
  return listJsonl(join(run, `post-S${n}`, 'cfgprojects')).filter((f) => !prev.has(basename(f)));
}

function readLines(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function scan(files) {
  const info = {
    injectKey: false,
    upsHandoff: false,
    memCalls: [],
    readsJsonl: false,
    firstCtx: null,
    denied: 0,
  };
  for (const f of files) {
    if (readFileSync(f, 'utf8').includes('<session-handoff')) info.upsHandoff = true;
    for (const e of readLines(f)) {
      const a = e.attachment ?? {};
      if (a.type === 'hook_additional_context' && a.hookEvent === 'SessionStart') {
        const handoff = JSON.stringify(a.content).split('## claude-mem-lite')[0];
        if (KEY.test(handoff)) info.injectKey = true;
      }
      const m = e.message ?? {};
      if (e.type === 'assistant' && info.firstCtx === null && m.usage) {
        const u = m.usage;
        info.firstCtx =
          (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      }
      if (!Array.isArray(m.content)) continue;
      for (const x of m.content) {
        if (x.type === 'tool_use') {
          const inp = JSON.stringify(x.input ?? {});
          if (x.name.startsWith('mcp__plugin_claude-mem-lite')) info.memCalls.push(x.name.split('__').pop());
          else if (/cli\.mjs/.test(inp) && /\b(save|defer|get|search|recall)\b/.test(inp)) {
            info.memCalls.push(`cli:${(inp.match(/\b(save|defer \w+|get|search|recall)\b/) ?? ['?'])[0]}`);
          }
          if (inp.includes('.jsonl')) info.readsJsonl = true;
        }
        if (x.type === 'tool_result' && JSON.stringify(x.content ?? '').includes('requires approval'))
          info.denied++;
      }
    }
  }
  return info;
}

export function analyze(workdir) {
  const runsDir = join(workdir, 'runs');
  const rows = [];
  for (const id of readdirSync(runsDir).sort()) {
    const m = /^([a-z]+)-([cp])-\d+$/.exec(id);
    if (!m) continue;
    const run = join(runsDir, id);
    const r = { id, model: m[1], arm: m[2] };
    const metaFile = join(run, 'meta.json');
    r.gapDays = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, 'utf8')).gapDays ?? 0) : 0;
    try {
      for (const n of [1, 2]) {
        const d = JSON.parse(readFileSync(join(run, `S${n}.json`), 'utf8'));
        r[`S${n}`] = {
          isError: d.is_error,
          cost: d.total_cost_usd ?? 0,
          sec: (d.duration_ms ?? 0) / 1000,
          turns: d.num_turns,
          models: Object.keys(d.modelUsage ?? {}),
        };
        r[`eval${n}`] = JSON.parse(readFileSync(join(run, `eval-S${n}.json`), 'utf8'));
      }
    } catch (e) {
      r.broken = String(e.message);
      rows.push(r);
      continue;
    }
    const memDir = join(run, 'preS2', 'cfgprojects');
    const hostMem = existsSync(memDir)
      ? readdirSync(memDir).flatMap((p) => {
          const md = join(memDir, p, 'memory');
          return existsSync(md)
            ? readdirSync(md)
                .filter((f) => f.endsWith('.md'))
                .map((f) => join(md, f))
            : [];
        })
      : [];
    r.hostMemPlan = hostMem.some((f) => KEY.test(readFileSync(f, 'utf8')));
    const hits = join(run, 'preS2', 'repo-hits.txt');
    r.repoPlan = existsSync(hits) && KEY.test(readFileSync(hits, 'utf8'));
    const s1 = scan(sessionFiles(run, 1));
    const s2 = scan(sessionFiles(run, 2));
    Object.assign(r, {
      s1Mem: s1.memCalls,
      s2Mem: s2.memCalls,
      s2InjectPlan: s2.injectKey,
      s2Handoff: s2.upsHandoff,
      s2ReadsJsonl: s2.readsJsonl,
      s1FirstCtx: s1.firstCtx,
      denied: s1.denied + s2.denied,
    });
    const bgDir = join(run, 'bg');
    const bg = existsSync(bgDir)
      ? readdirSync(bgDir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => JSON.parse(readFileSync(join(bgDir, f), 'utf8')))
      : [];
    r.bgCalls = bg.length;
    r.bgCost = bg.reduce((s, b) => s + (b.total_cost_usd ?? 0), 0);
    rows.push(r);
  }

  const summary = {};
  for (const model of [...new Set(rows.map((r) => r.model))]) {
    const s = {};
    for (const arm of ['c', 'p']) {
      const a = rows.filter((r) => r.model === model && r.arm === arm && !r.broken);
      if (!a.length) continue;
      const mean = (f) => a.reduce((x, r) => x + f(r), 0) / a.length;
      s[arm] = {
        n: a.length,
        s2Complete: a.filter((r) => r.eval2.E2all).length,
        s1E1: a.filter((r) => r.eval1.E1).length,
        hostMemPlan: a.filter((r) => r.hostMemPlan).length,
        s2Handoff: a.filter((r) => r.s2Handoff).length,
        gapDays: [...new Set(a.map((r) => r.gapDays))],
        s1Cost: mean((r) => r.S1.cost),
        s1Sec: mean((r) => r.S1.sec),
        s1Turns: mean((r) => r.S1.turns),
        s1FirstCtx: mean((r) => r.s1FirstCtx ?? 0),
        bgCostPerTrajectory: mean((r) => r.bgCost),
        invalid: a.filter((r) => r.S1.isError || r.S2.isError || r.denied > 0).map((r) => r.id),
      };
    }
    if (s.c && s.p) s.fisherP = fisherTwoSided(s.p.s2Complete, s.p.n, s.c.s2Complete, s.c.n);
    summary[model] = s;
  }
  return { rows, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const workdir = process.argv[2];
  if (!workdir) {
    console.error('usage: node benchmark/value-ab/analyze.mjs <workdir>');
    process.exit(2);
  }
  const { rows, summary } = analyze(workdir);
  writeFileSync(join(workdir, 'rows.json'), JSON.stringify(rows, null, 1));
  for (const r of rows) {
    if (r.broken) {
      console.log(`${r.id}  BROKEN  ${r.broken}`);
      continue;
    }
    console.log(
      [
        r.id.padEnd(8),
        `E1 ${r.eval1.E1 ? 'T' : 'F'}`,
        `S2 E2 ${r.eval2.E2pass}/4`,
        `suite ${r.eval2.suite ? 'T' : 'F'}`,
        `deps ${r.eval2.noDeps ? 'none' : 'ADDED'}`,
        `hostMemPlan ${r.hostMemPlan ? 'Y' : 'n'}`,
        `repoPlan ${r.repoPlan ? 'Y' : 'n'}`,
        `inject ${r.s2InjectPlan ? 'Y' : 'n'}`,
        `upsHandoff ${r.s2Handoff ? 'Y' : 'n'}`,
        `S1 ${r.s1Mem.join(',') || '-'}`,
        `S2 ${r.s2Mem.join(',') || '-'}`,
        `$ ${r.S1.cost.toFixed(3)}/${r.S2.cost.toFixed(3)}`,
        `bg ${r.bgCalls}`,
        `ctx ${r.s1FirstCtx ?? '-'}`,
        r.denied ? `DENIED ${r.denied}` : '',
        [...new Set([...r.S1.models, ...r.S2.models])].join('/'),
      ].join('  '),
    );
  }
  console.log(JSON.stringify(summary, null, 1));
}
