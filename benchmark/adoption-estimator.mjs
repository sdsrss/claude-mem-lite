function olsLine(pts) {
  // pts: [{x,y}] centered externally; returns {a:intercept, b:slope}
  const n = pts.length;
  if (n === 0) return { a: 0, b: 0 };
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    sxy += p.x * p.y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { a: sy / n, b: 0 };
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  return { a, b };
}

export function localLinearRdd(points, cutoff) {
  const treated = points.filter((p) => p.shown).map((p) => ({ x: p.x - cutoff, y: p.y }));
  const control = points.filter((p) => !p.shown).map((p) => ({ x: p.x - cutoff, y: p.y }));
  const distinct = (a) => new Set(a.map((p) => p.x)).size;
  const meanY = (a) => (a.length ? a.reduce((s, p) => s + p.y, 0) / a.length : 0);
  let jump;
  if (distinct(treated) < 2 || distinct(control) < 2) jump = meanY(treated) - meanY(control);
  else jump = olsLine(treated).a - olsLine(control).a; // intercepts at x-cutoff=0
  return { jump, nTreated: treated.length, nControl: control.length };
}

// seeded LCG so bootstrap is deterministic (Math.random is unavailable in this repo's harness)
export function lcg(seedStr) {
  let s = 2166136261 >>> 0;
  for (const ch of String(seedStr)) {
    s ^= ch.charCodeAt(0);
    s = Math.imul(s, 16777619) >>> 0;
  }
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function clusterBootstrap(rows, { B = 2000, seedTerms = 'seed' } = {}) {
  const bySession = new Map();
  for (const r of rows) {
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
    bySession.get(r.sessionId).push(r.value);
  }
  const clusters = [...bySession.values()];
  const K = clusters.length;
  const rand = lcg(seedTerms + ':' + rows.length);
  const flatMean = (cs) => {
    let s = 0,
      n = 0;
    for (const c of cs)
      for (const v of c) {
        s += v;
        n++;
      }
    return n ? s / n : 0;
  };
  const means = [];
  for (let b = 0; b < B; b++) {
    const draw = [];
    for (let k = 0; k < K; k++) draw.push(clusters[Math.floor(rand() * K)]);
    means.push(flatMean(draw));
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(0.025 * B)] ?? 0;
  const hi = means[Math.floor(0.975 * B)] ?? 0;
  return { mean: flatMean(clusters), ci95: [lo, hi] };
}

const Z = {
  0.8: 0.8416212336,
  0.9: 1.2815515655,
  0.95: 1.644853627,
  0.975: 1.9599639845,
  0.99: 2.326347874,
  0.995: 2.5758293035,
};
function zQuantile(p) {
  const z = Z[Number(p.toFixed(4))];
  if (z === undefined) throw new Error(`mde: unsupported normal quantile ${p} (add it to Z)`);
  return z;
}
export function mde(nEvents, sd, { alpha = 0.05, power = 0.8 } = {}) {
  const zA = zQuantile(1 - alpha / 2); // two-sided
  const zB = zQuantile(power);
  return ((zA + zB) * sd) / Math.sqrt(Math.max(1, nEvents));
}
