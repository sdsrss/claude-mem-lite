// Seed project for the value A/B (benchmark/value-ab/): the 300-line `invoicer` CLI rebuilt on 2026-11-24
// from docs/audits/20260929-sandbox-usage-eval.md Appendix B. Kept as strings, not files, so its own
// `test/*.test.mjs` never reaches vitest, eslint, prettier or knip. Planted: `allocate` rounds each share
// (sums drift by a cent), and `store.mjs` throws an opaque TypeError when INVOICER_DATA is unset.
// Usage: node benchmark/value-ab/seed.mjs <dir>
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Commit 1: core modules and their tests. */
const CORE = [
  [
    'package.json',
    `{
  "name": "invoicer",
  "version": "0.1.0",
  "description": "Small invoicing CLI",
  "type": "module",
  "bin": { "invoicer": "src/cli.mjs" },
  "scripts": { "test": "node --test" },
  "engines": { "node": ">=22" },
  "license": "MIT"
}
`,
  ],
  [
    '.gitignore',
    `node_modules/
data/
`,
  ],
  [
    'README.md',
    `# invoicer

A small invoicing CLI. Amounts are stored as integer cents.

\`\`\`
export INVOICER_DATA=./data
node src/cli.mjs create --customer Acme --item "Logo design:1:1200.00" --region CN
node src/cli.mjs list
node src/cli.mjs show INV-0001
node src/cli.mjs split INV-0001 --people alice,bob,carol [--weights 1,1,2]
\`\`\`

Regions: CN 13%, SG 9%, EU 20%, HK 0%. Run the tests with \`npm test\`.
`,
  ],
  [
    'src/money.mjs',
    `// Money helpers. All amounts are integer cents internally.

export function parseMoney(text) {
  const m = /^(\\d+)(?:\\.(\\d{1,2}))?$/.exec(String(text).trim());
  if (!m) throw new Error(\`invalid amount: \${text}\`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

export function formatMoney(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return \`\${sign}\${Math.floor(abs / 100)}.\${String(abs % 100).padStart(2, '0')}\`;
}

// Split \`total\` cents across participants in proportion to \`weights\`.
export function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => Math.round((total * w) / sum));
}
`,
  ],
  [
    'src/tax.mjs',
    `const RATES = { CN: 0.13, SG: 0.09, EU: 0.2, HK: 0 };

export function taxRate(region) {
  if (!(region in RATES)) throw new Error(\`unknown region: \${region}\`);
  return RATES[region];
}

// Tax on a subtotal in cents, rounded to the cent.
export function computeTax(subtotal, region) {
  return Math.round(subtotal * taxRate(region));
}
`,
  ],
  [
    'src/invoice.mjs',
    `import { computeTax } from './tax.mjs';

export function lineAmount(line) {
  return line.qty * line.unitPrice;
}

// lines: [{ name, qty, unitPrice }] with unitPrice in cents.
export function createInvoice({ id, customer, date, region = 'CN', lines }) {
  if (!customer) throw new Error('customer is required');
  if (!lines?.length) throw new Error('at least one line is required');
  const subtotal = lines.reduce((sum, line) => sum + lineAmount(line), 0);
  const tax = computeTax(subtotal, region);
  return { id, customer, date, region, lines, subtotal, tax, total: subtotal + tax };
}
`,
  ],
  [
    'src/store.mjs',
    `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function dataFile() {
  return join(process.env.INVOICER_DATA, 'invoices.json');
}

export function loadAll() {
  const file = dataFile();
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function saveAll(invoices) {
  writeFileSync(dataFile(), JSON.stringify(invoices, null, 2));
}

export function addInvoice(invoice) {
  const all = loadAll();
  const record = { ...invoice, id: \`INV-\${String(all.length + 1).padStart(4, '0')}\` };
  all.push(record);
  saveAll(all);
  return record;
}

export function getInvoice(id) {
  return loadAll().find((invoice) => invoice.id === id);
}
`,
  ],
  [
    'test/money.test.mjs',
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, formatMoney, parseMoney } from '../src/money.mjs';

test('parseMoney reads yuan strings into cents', () => {
  assert.equal(parseMoney('12.30'), 1230);
  assert.equal(parseMoney('5'), 500);
});

test('formatMoney prints cents as yuan', () => {
  assert.equal(formatMoney(1230), '12.30');
  assert.equal(formatMoney(5), '0.05');
});

test('allocate splits an even amount evenly', () => {
  assert.deepEqual(allocate(900, [1, 1, 1]), [300, 300, 300]);
});
`,
  ],
  [
    'test/tax.test.mjs',
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTax } from '../src/tax.mjs';

test('CN tax is 13%', () => {
  assert.equal(computeTax(10000, 'CN'), 1300);
});

test('unknown region throws', () => {
  assert.throws(() => computeTax(100, 'XX'), /unknown region/);
});
`,
  ],
  [
    'test/invoice.test.mjs',
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInvoice } from '../src/invoice.mjs';

test('createInvoice totals lines and tax', () => {
  const inv = createInvoice({ customer: 'Acme', date: '2026-01-01', lines: [{ name: 'A', qty: 2, unitPrice: 1000 }] });
  assert.equal(inv.subtotal, 2000);
  assert.equal(inv.tax, 260);
  assert.equal(inv.total, 2260);
});
`,
  ],
];

/** Commit 2: the CLI and its test. */
const CLI = [
  [
    'src/cli.mjs',
    `#!/usr/bin/env node
import { allocate, formatMoney, parseMoney } from './money.mjs';
import { createInvoice } from './invoice.mjs';
import { addInvoice, getInvoice, loadAll } from './store.mjs';

function parseArgs(argv) {
  const opts = { _: [], item: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[++i];
      if (key === 'item') opts.item.push(value);
      else opts[key] = value;
    } else {
      opts._.push(arg);
    }
  }
  return opts;
}

// "name:qty:unitPrice", e.g. "Logo design:1:1200.00"
function parseItem(text) {
  const [name, qty, price] = text.split(':');
  return { name, qty: Number(qty), unitPrice: parseMoney(price) };
}

function printInvoice(inv) {
  console.log(\`Invoice \${inv.id}  \${inv.date}  \${inv.customer} (\${inv.region})\`);
  for (const line of inv.lines) console.log(\`  \${line.name} x\${line.qty} @ \${formatMoney(line.unitPrice)}\`);
  console.log(\`Subtotal: \${formatMoney(inv.subtotal)}\`);
  console.log(\`Tax:      \${formatMoney(inv.tax)}\`);
  console.log(\`Total:    \${formatMoney(inv.total)}\`);
}

function requireInvoice(id) {
  const inv = getInvoice(id);
  if (!inv) {
    console.error(\`not found: \${id}\`);
    process.exit(1);
  }
  return inv;
}

const [command, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);

switch (command) {
  case 'create': {
    const inv = createInvoice({
      customer: opts.customer,
      date: opts.date ?? new Date().toISOString().slice(0, 10),
      region: opts.region ?? 'CN',
      lines: opts.item.map(parseItem),
    });
    printInvoice(addInvoice(inv));
    break;
  }
  case 'list':
    for (const inv of loadAll()) console.log(\`\${inv.id}  \${inv.date}  \${inv.customer}  \${formatMoney(inv.total)}\`);
    break;
  case 'show':
    printInvoice(requireInvoice(opts._[0]));
    break;
  case 'split': {
    const inv = requireInvoice(opts._[0]);
    const people = (opts.people ?? '').split(',').filter(Boolean);
    const weights = opts.weights ? opts.weights.split(',').map(Number) : people.map(() => 1);
    allocate(inv.total, weights).forEach((share, i) => console.log(\`\${people[i] ?? \`#\${i + 1}\`}: \${formatMoney(share)}\`));
    break;
  }
  default:
    console.error('usage: invoicer <create|list|show|split> [options]');
    process.exit(1);
}
`,
  ],
  [
    'test/cli.test.mjs',
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = join(import.meta.dirname, '..', 'src', 'cli.mjs');

test('create then list', () => {
  const env = { ...process.env, INVOICER_DATA: mkdtempSync(join(tmpdir(), 'invoicer-')) };
  const created = spawnSync(process.execPath, [cli, 'create', '--customer', 'Acme', '--item', 'Logo:1:1200.00'], { env, encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /Total:\\s+1356\\.00/);
  const listed = spawnSync(process.execPath, [cli, 'list'], { env, encoding: 'utf8' });
  assert.match(listed.stdout, /INV-0001 .* Acme +1356\\.00/);
});
`,
  ],
];

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'Dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
  GIT_AUTHOR_DATE: '2026-11-24T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-11-24T00:00:00Z',
};

function git(dir, args) {
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-C', dir, ...args], {
    env: { ...process.env, ...GIT_ENV },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function writeAll(dir, files) {
  for (const [rel, text] of files) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

/** Write the seed into an empty or missing `dir` and make its two commits. */
export function buildSeed(dir) {
  if (existsSync(join(dir, '.git'))) throw new Error(`seed target already a repo: ${dir}`);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  writeAll(dir, CORE);
  git(dir, ['add', '--', ...CORE.map(([rel]) => rel)]);
  git(dir, ['commit', '-q', '-m', 'Initial invoicer core: money, tax, invoice, store']);
  writeAll(dir, CLI);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'Add CLI and tests']);
}

function replaceOnce(file, from, to) {
  const text = readFileSync(file, 'utf8');
  if (text.split(from).length !== 2) throw new Error(`reference edit does not apply once in ${file}`);
  writeFileSync(file, text.replace(from, to));
}

/**
 * The S1+S2 reference solution (line discount, SAVE10/FLAT5 coupons, CLI --coupon and a 4th --item field).
 * Used only to prove the hidden acceptance can say YES; it is not shown to any arm.
 */
export function applyReference(dir) {
  const invoice = join(dir, 'src', 'invoice.mjs');
  replaceOnce(
    invoice,
    'export function lineAmount(line) {\n  return line.qty * line.unitPrice;\n}',
    [
      'export function lineAmount(line) {',
      '  return Math.round(line.qty * line.unitPrice * (1 - (line.discountPct ?? 0) / 100));',
      '}',
      '',
      'export function applyCoupon(subtotal, coupon) {',
      '  if (!coupon) return subtotal;',
      "  if (coupon === 'SAVE10') return subtotal - Math.round(subtotal * 0.1);",
      "  if (coupon === 'FLAT5') return Math.max(0, subtotal - 500);",
      '  throw new Error(`invalid coupon: ${coupon}`);',
      '}',
    ].join('\n'),
  );
  replaceOnce(
    invoice,
    "export function createInvoice({ id, customer, date, region = 'CN', lines }) {",
    "export function createInvoice({ id, customer, date, region = 'CN', lines, coupon }) {",
  );
  replaceOnce(
    invoice,
    'const subtotal = lines.reduce((sum, line) => sum + lineAmount(line), 0);',
    'const subtotal = applyCoupon(lines.reduce((sum, line) => sum + lineAmount(line), 0), coupon);',
  );
  const cli = join(dir, 'src', 'cli.mjs');
  replaceOnce(
    cli,
    "  const [name, qty, price] = text.split(':');\n  return { name, qty: Number(qty), unitPrice: parseMoney(price) };",
    "  const [name, qty, price, discount] = text.split(':');\n  return { name, qty: Number(qty), unitPrice: parseMoney(price), discountPct: Number(discount ?? 0) };",
  );
  replaceOnce(
    cli,
    '      lines: opts.item.map(parseItem),\n',
    '      lines: opts.item.map(parseItem),\n      coupon: opts.coupon,\n',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node benchmark/value-ab/seed.mjs <dir>');
    process.exit(2);
  }
  buildSeed(target);
  console.log(`seed written to ${target}`);
}
