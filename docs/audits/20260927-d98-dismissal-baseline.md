# D#98 baseline — lesson-id dismissals in assistant text

Stamp: 2026-09-27T11:59:07Z. Tree: main @ 0bcf947 (before 396ae10). Population: 216 top-level
`~/.claude/projects/*/*.jsonl` transcripts on the maintainer machine, main thread only
(`isSidechain !== true`), every project. Extractors: the shipped `citationIdRe`, `isDismissalAt`,
`extractInjectedBySurface`, `unionSurfaces`, `extractCitationsFromTranscript`.

| Reading | Value |
|---|---|
| `#NN` mentions in assistant text | 2007 |
| of which dismissals (`isDismissalAt`) | 335 (16.7%) |
| text-only responses (no tool_use) | 1890 |
| … with ≥1 `#NN` token (regex caliber: also matches issue/PR numbers) | 380 |
| … with ≥1 dismissal | 98 |
| Stop cite-recall gate, qualifying sessions (hook-injected ≥ 5) | 95 |
| gate ratio incl. dismissals (shipped): p25 / median / p75 | 0 / 0.167 / 0.333 |
| … fires at 0.4 | 78 / 95 |
| crediting-only ratio: p25 / median / p75 | 0 / 0.111 / 0.200 |
| … fires at 0.4 / 0.3 / 0.25 / 0.2 | 87 / 78 / 73 / 65 |

Readout owed after the release carrying 396ae10: re-run the script below with a `--since`
cut at the first session on that release (add the filter on the transcript's first
timestamp), same population rules, and compare the dismissal share and the
reply-with-dismissal count; then `node benchmark/citation-live-replay.mjs --since <T0>` for
the per-face cite rate. Do not mix sessions from before and after the release in the D#104
framing readout either: the directive change is common-mode to both framing arms.

```js
// D#98 baseline: dismissal share, reply citation density, and the Stop cite-recall gate
// with vs without dismissals. Shipped extractors only.
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
const REPO = process.argv[2];
const ct = await import(join(REPO, 'lib/citation-tracker.mjs'));
const { readTranscriptEntries } = await import(join(REPO, 'lib/transcript-scan.mjs'));
const root = join(homedir(), '.claude/projects');
const files = [];
for (const d of readdirSync(root)) {
  let names; try { names = readdirSync(join(root, d)); } catch { continue; }
  for (const n of names) if (n.endsWith('.jsonl')) files.push(join(root, d, n));
}
const re = ct.citationIdRe();
let mentions = 0, dismiss = 0, replies = 0, repliesWithCite = 0, repliesWithDismiss = 0;
const gate = [];
for (const f of files) {
  // final-reply proxy: last text block of each assistant response that has no tool_use
  const resp = new Map();
  for (const e of readTranscriptEntries(f)) {
    if (e.type !== 'assistant' || !e.message || e.isSidechain === true) continue;
    const c = e.message.content; if (!Array.isArray(c)) continue;
    const k = e.requestId || e.message.id || e.uuid;
    let r = resp.get(k); if (!r) resp.set(k, (r = { text: '', tool: false }));
    for (const b of c) { if (b.type === 'tool_use') r.tool = true; if (b.type === 'text' && typeof b.text === 'string') r.text += '\n' + b.text; }
  }
  for (const r of resp.values()) {
    if (!r.text.trim()) continue;
    let anyC = false, anyD = false;
    re.lastIndex = 0; let m;
    while ((m = re.exec(r.text))) { mentions++; anyC = true; if (ct.isDismissalAt(r.text, m.index + m[0].length)) { dismiss++; anyD = true; } }
    if (!r.tool) { replies++; if (anyC) repliesWithCite++; if (anyD) repliesWithDismiss++; }
  }
  try {
    const inj = ct.unionSurfaces(ct.extractInjectedBySurface(f, { mainOnly: true }));
    if (inj.size < 5) continue;
    const withD = ct.extractCitationsFromTranscript(f, { mainOnly: true, includeDismissed: true });
    const noD = ct.extractCitationsFromTranscript(f, { mainOnly: true });
    let a = 0, b = 0; for (const id of inj) { if (withD.has(id)) a++; if (noD.has(id)) b++; }
    gate.push({ n: inj.size, withD: a / inj.size, noD: b / inj.size });
  } catch {}
}
const q = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const fire = (k, t) => gate.filter((g) => g[k] < t).length;
console.log(JSON.stringify({
  stamp: new Date().toISOString(), transcripts: files.length,
  mentions, dismiss, dismissShare: +(dismiss / mentions).toFixed(3),
  textOnlyReplies: replies, repliesWithCite, repliesWithDismiss,
  gateSessions: gate.length,
  withDismissed: { p25: q(gate.map(g=>g.withD),.25), median: q(gate.map(g=>g.withD),.5), p75: q(gate.map(g=>g.withD),.75), fireAt04: fire('withD', 0.4) },
  crediting: { p25: q(gate.map(g=>g.noD),.25), median: q(gate.map(g=>g.noD),.5), p75: q(gate.map(g=>g.noD),.75), fireAt04: fire('noD', 0.4), fireAt03: fire('noD',0.3), fireAt025: fire('noD',0.25), fireAt02: fire('noD',0.2) },
}, null, 1));
```
