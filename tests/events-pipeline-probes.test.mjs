// G16: events end-to-end pipeline probes — healthy-pass + archaeology-replay
// teeth. The probes' value claim is "a FTS/shape-layer events regression that
// reads NEUTRAL on every metric suite turns PROBE-FAIL here"; that claim is
// only evidence if a replayed historical breakage actually flips them red.
// Replayed state: v3.44-era "events rows exist but events_fts is empty/broken"
// (the audit's canonical events-unsearchable face).

import { describe, it, expect } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { runEventsPipelineProbes, seedEventsPipelineCorpus } from '../benchmark/events-pipeline-probes.mjs';

describe('events pipeline probes (G16)', () => {
  it('all probes pass on a healthy seeded corpus', async () => {
    const probes = await runEventsPipelineProbes();
    const failed = probes.filter((p) => !p.pass);
    expect(failed.map((p) => `${p.name}: ${p.detail}`)).toEqual([]);
    expect(probes.length).toBe(9);   // 6 G16 events probes + 3 D#121 cite/noise banding probes
  });

  it('TEETH: wiping events_fts turns the reachability probe red (archaeology replay)', async () => {
    const db = createTestDb();
    seedEventsPipelineCorpus(db);
    // Replay the events-unsearchable state: FTS index emptied while the events
    // rows remain (what a broken trigger / skipped backfill produces).
    db.exec(`DELETE FROM events_fts`);
    const probes = await runEventsPipelineProbes(db);
    db.close();
    const byName = Object.fromEntries(probes.map((p) => [p.name, p]));
    expect(byName['event-reachable-via-fts'].pass).toBe(false);
    expect(byName['strong-event-outranks-weak-obs'].pass).toBe(false);
    expect(byName['event-type-filter-maps'].pass).toBe(false);
  });

  // D#200: the cite-widening probe compares two INDEPENDENTLY seeded corpora, so
  // each arm computes its own integer-millisecond recency `age` and the ratio
  // drifts by 2.0052e-10 per millisecond of skew between them. That is real
  // flake, not a scoring defect — it went red on CI (run 33602196907) at 5 ms.
  // A clock whose STEP grows makes arm 2's seed→query elapsed exceed arm 1's
  // deterministically; an equal-step clock cancels out and cannot catch this.
  it('TEETH: the cite-widening ratio is clock-independent (D#200)', async () => {
    const realNow = Date.now;
    let t = realNow.call(Date);
    let step = 0;
    Date.now = () => (t += ++step);
    let probes;
    try {
      probes = await runEventsPipelineProbes();
    } finally {
      Date.now = realNow;
    }
    const failed = probes.filter((p) => !p.pass);
    expect(failed.map((p) => `${p.name}: ${p.detail}`)).toEqual([]);
  });

  it('TEETH: a broken events_fts face THROWS into the probe (tolerateMissingFts=false), not silent-degrades', async () => {
    const db = createTestDb();
    seedEventsPipelineCorpus(db);
    db.exec(`DROP TABLE events_fts`);
    const probes = await runEventsPipelineProbes(db);
    db.close();
    const reach = probes.find((p) => p.name === 'event-reachable-via-fts');
    expect(reach.pass).toBe(false);
    expect(reach.detail).toContain('threw');
  });
});
