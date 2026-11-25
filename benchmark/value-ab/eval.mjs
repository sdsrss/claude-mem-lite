// Hidden acceptance for the value A/B's S1 -> S2 discount scenario (benchmark/value-ab/, rebuilt 2026-11-24 from
// docs/audits/20260929-sandbox-usage-eval.md Appendix B). Run on a CLEAN CLONE after each session's lazy commit.
// E1: a line discount; E2: SAVE10 -> 101.70, FLAT5 -> 107.35, "Logo:1:1200.00:10" -> 1220.40, a bad code exits non-zero.
// Usage: node benchmark/value-ab/eval.mjs <clone> [scratch-dir]  -> one JSON line on stdout.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function bareImports(dir, found = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) bareImports(p, found);
    else if (/\.(m?js|cjs)$/.test(name)) {
      for (const m of readFileSync(p, 'utf8').matchAll(
        /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g,
      )) {
        if (!m[1].startsWith('.') && !m[1].startsWith('node:') && !m[1].startsWith('/'))
          found.push(`${name}:${m[1]}`);
      }
    }
  }
  return found;
}

/** Evaluate one clone; `scratch` holds the per-check data dirs. */
export async function evaluate(repoDir, scratch) {
  const repo = resolve(repoDir);
  const out = {};

  const suite = spawnSync('npm', ['test'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, TMPDIR: scratch },
  });
  out.suite = suite.status === 0;

  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const depKeys = ['dependencies', 'devDependencies'].filter((k) => pkg[k] && Object.keys(pkg[k]).length);
  const bare = bareImports(join(repo, 'src'));
  out.noDeps = depKeys.length === 0 && bare.length === 0;
  if (!out.noDeps) out.depDetail = { depKeys, bareImports: bare };

  try {
    const { createInvoice } = await import(pathToFileURL(join(repo, 'src', 'invoice.mjs')).href);
    const inv = createInvoice({
      customer: 'Acme',
      date: '2026-01-01',
      region: 'CN',
      lines: [{ name: 'A', qty: 2, unitPrice: 1000, discountPct: 10 }],
    });
    out.E1 = inv.subtotal === 1800 && inv.tax === 234;
    out.E1detail = { subtotal: inv.subtotal, tax: inv.tax };
  } catch (e) {
    out.E1 = false;
    out.E1detail = String(e.message).slice(0, 200);
  }

  const binRel = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.invoicer ?? 'src/cli.mjs');
  const cli = join(repo, binRel);
  const run = (args) => {
    const r = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, INVOICER_DATA: mkdtempSync(join(scratch, 'data-')), TMPDIR: scratch },
    });
    return { status: r.status, text: `${r.stdout}\n${r.stderr}` };
  };
  const save10 = run(['create', '--customer', 'Acme', '--item', 'X:1:100.00', '--coupon', 'SAVE10']);
  const flat5 = run(['create', '--customer', 'Acme', '--item', 'X:1:100.00', '--coupon', 'FLAT5']);
  const lineDisc = run(['create', '--customer', 'Acme', '--item', 'Logo:1:1200.00:10']);
  const bogus = run(['create', '--customer', 'Acme', '--item', 'X:1:100.00', '--coupon', 'BOGUS']);
  out.E2 = {
    save10: save10.status === 0 && save10.text.includes('101.70'),
    flat5: flat5.status === 0 && flat5.text.includes('107.35'),
    lineDiscount: lineDisc.status === 0 && lineDisc.text.includes('1220.40'),
    bogusRejected: bogus.status !== 0 && bogus.status !== null,
  };
  out.E2pass = Object.values(out.E2).filter(Boolean).length;
  out.E2all = out.E2pass === 4;
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repo, scratchArg] = process.argv.slice(2);
  if (!repo) {
    console.error('usage: node benchmark/value-ab/eval.mjs <clone> [scratch-dir]');
    process.exit(2);
  }
  const scratch = scratchArg ?? process.env.EVAL_TMP ?? mkdtempSync(join(tmpdir(), 'valueab-eval-'));
  console.log(JSON.stringify(await evaluate(repo, scratch)));
}
