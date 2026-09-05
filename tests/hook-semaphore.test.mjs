// Tests for hook-semaphore.mjs — LLM concurrency semaphore
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, mkdirSync } from 'fs';
import {
  acquireLLMSlot,
  releaseLLMSlot,
  _setLocalHeldAt,
  LLM_SEM_MAX,
  LLM_SEM_TIMEOUT,
  LLM_SEM_STALE_MS,
  sleepMs,
} from '../hook-semaphore.mjs';
import { BG_LLM_TIMEOUT_MS } from '../haiku-client.mjs';
import { DB_DIR } from '../schema.mjs';

const RUNTIME_DIR = join(DB_DIR, 'runtime');
const slotFile = () => join(RUNTIME_DIR, `llm-sem-${process.pid}`);

function cleanupSemFiles() {
  try {
    for (const f of readdirSync(RUNTIME_DIR)) {
      if (f.startsWith('llm-sem-')) {
        try {
          unlinkSync(join(RUNTIME_DIR, f));
        } catch {}
      }
    }
  } catch {}
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('hook-semaphore.mjs', () => {
  beforeEach(() => {
    try {
      mkdirSync(RUNTIME_DIR, { recursive: true });
    } catch {}
    // acquireLLMSlot keeps MODULE-level bookkeeping of whether this process holds
    // the slot (so a concurrent same-process acquire cannot unlink a live
    // sibling's file). Several cases below acquire without releasing, and unlinking
    // the file does not clear that record — the next case would then queue behind a
    // holder that no longer exists. Reset through the real API rather than a
    // test-only export, so this stays honest about the contract it is resetting.
    releaseLLMSlot();
    cleanupSemFiles();
  });

  afterEach(() => {
    releaseLLMSlot();
    cleanupSemFiles();
  });

  // ─── Constants ──────────────────────────────────────────────────────────

  describe('constants', () => {
    it('exports LLM_SEM_MAX as 2', () => {
      expect(LLM_SEM_MAX).toBe(2);
    });

    // D#134 MEDIUM-2. The wait budget and the stale threshold are both DERIVED
    // from the longest a slot can legitimately be held (BG_LLM_TIMEOUT_MS, the
    // background LLM call budget raised to 45s in v3.66.0). They were literals,
    // and when the hold grew from ~15-20s to 45s the literals did not follow:
    // the (MAX+1)-th worker gave up at 30s while a holder was still working (a
    // save that lands WITHOUT enrichment — silent degradation, not an error),
    // and the 60s reaper left a 45s holder just 15s of margin.
    it('waits longer than a slot can legitimately be held', () => {
      expect(LLM_SEM_TIMEOUT).toBeGreaterThan(BG_LLM_TIMEOUT_MS);
    });

    it('reaps stale slots only well beyond the longest legitimate hold', () => {
      // 2x the hold: a holder must never be reaped while alive and working,
      // and one wait-cycle of margin on top for scheduler jitter.
      expect(LLM_SEM_STALE_MS).toBeGreaterThanOrEqual(BG_LLM_TIMEOUT_MS * 2);
      expect(LLM_SEM_STALE_MS).toBeGreaterThan(LLM_SEM_TIMEOUT);
    });

    // Pre-tag review b1: the two tests above pin the CONSTANTS, and a
    // behavioural test of the wait budget costs 45s of wall clock. But the
    // acquire loop computes its own deadline, so re-hardcoding 30000 there
    // reinstates D#134 MEDIUM-2 verbatim while every assertion above stays
    // green. Cheap source guard for the one line that consumes the budget.
    it('the acquire loop derives its deadline from LLM_SEM_TIMEOUT, not a literal', () => {
      // D#207: join(), not new URL('../X.mjs', …) — that form blinds knip to the module.
      const src = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', 'hook-semaphore.mjs'),
        'utf8',
      );
      const deadline = src.match(/const deadline = [^;]+;/);
      expect(deadline, 'acquire deadline not found').not.toBeNull();
      expect(deadline[0]).toContain('LLM_SEM_TIMEOUT');
      expect(deadline[0], 'deadline must not re-hardcode a budget').not.toMatch(/\d{4,}/);
    });

    it('the stale reaper compares against LLM_SEM_STALE_MS, not a literal', () => {
      // D#207: join(), not new URL('../X.mjs', …) — that form blinds knip to the module.
      const src = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', 'hook-semaphore.mjs'),
        'utf8',
      );
      const ageCheck = src.match(/if \(age > [^)]+\)/);
      expect(ageCheck, 'age check not found').not.toBeNull();
      expect(ageCheck[0]).toContain('LLM_SEM_STALE_MS');
    });
  });

  // ─── sleepMs ────────────────────────────────────────────────────────────

  describe('sleepMs', () => {
    it('resolves after specified duration', async () => {
      const start = Date.now();
      await sleepMs(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });
  });

  // ─── acquireLLMSlot / releaseLLMSlot ────────────────────────────────────

  describe('acquireLLMSlot', () => {
    it('acquires slot and creates semaphore file', async () => {
      const got = await acquireLLMSlot();
      expect(got).toBe(true);
      expect(existsSync(slotFile())).toBe(true);
    });

    it('semaphore file contains pid and timestamp', async () => {
      await acquireLLMSlot();
      const info = JSON.parse(readFileSync(slotFile(), 'utf8'));
      expect(info.pid).toBe(process.pid);
      expect(info.ts).toBeGreaterThan(0);
    });

    it('releaseLLMSlot removes semaphore file', async () => {
      await acquireLLMSlot();
      releaseLLMSlot();
      expect(existsSync(slotFile())).toBe(false);
    });

    it('cleans stale slot files (>60s old)', async () => {
      // Create a stale slot file from a non-existent PID
      const staleFile = join(RUNTIME_DIR, 'llm-sem-2147483646');
      writeFileSync(staleFile, JSON.stringify({ pid: 2147483646, ts: Date.now() - 120000 }));

      const got = await acquireLLMSlot();
      expect(got).toBe(true);
      // Stale file should be cleaned
      expect(existsSync(staleFile)).toBe(false);
    });

    it('cleans slot files from dead processes', async () => {
      // Create a slot file with non-existent PID but recent timestamp
      const deadFile = join(RUNTIME_DIR, 'llm-sem-2147483645');
      writeFileSync(deadFile, JSON.stringify({ pid: 2147483645, ts: Date.now() }));

      const got = await acquireLLMSlot();
      expect(got).toBe(true);
      // Dead process file should be cleaned
      expect(existsSync(deadFile)).toBe(false);
    });

    // D#134 MEDIUM-2, the counting half. Age alone must not evict a LIVE
    // holder: doing so drops it out of `active`, and the next acquirer then
    // sees room that does not exist — more than LLM_SEM_MAX concurrent LLM
    // calls, which is the exact contention this file exists to prevent. The ts
    // is stamped once at acquire and never refreshed, so a 45s call spent 45s
    // of a 60s budget; liveness, not age, is the primary test.
    it('keeps a live holder past the old 60s age cutoff', async () => {
      const liveHolder = join(RUNTIME_DIR, 'llm-sem-livetest');
      // Our own pid: guaranteed alive for the duration of the test.
      writeFileSync(liveHolder, JSON.stringify({ pid: process.pid, ts: Date.now() - 90_000 }));
      try {
        const got = await acquireLLMSlot();
        expect(got).toBe(true); // ours + the live holder = 2 = LLM_SEM_MAX
        expect(existsSync(liveHolder)).toBe(true);
      } finally {
        try {
          unlinkSync(liveHolder);
        } catch {}
      }
    });

    // The backstop the age check is actually FOR: a recorded pid that has been
    // recycled by an unrelated long-lived process would pass the liveness test
    // forever, so age still wins once it is implausible as a real hold.
    it('still reaps a slot older than the stale threshold even if its pid is alive', async () => {
      const zombie = join(RUNTIME_DIR, 'llm-sem-zombietest');
      writeFileSync(
        zombie,
        JSON.stringify({ pid: process.pid, ts: Date.now() - (LLM_SEM_STALE_MS + 10_000) }),
      );
      try {
        const got = await acquireLLMSlot();
        expect(got).toBe(true);
        expect(existsSync(zombie)).toBe(false);
      } finally {
        try {
          unlinkSync(zombie);
        } catch {}
      }
    });

    it('respects max concurrent slots', async () => {
      // Simulate LLM_SEM_MAX active slots from other "processes"
      // We can't fake live PIDs easily, so we create slot files
      // with the current process PID offset, which process.kill(pid, 0)
      // will fail on with ESRCH (cleaning them). So instead we test
      // that acquiring succeeds when under limit.

      const got = await acquireLLMSlot();
      expect(got).toBe(true);

      // Count active sem files
      const semFiles = readdirSync(RUNTIME_DIR).filter((f) => f.startsWith('llm-sem-'));
      expect(semFiles.length).toBe(1);
    });

    it('re-acquires slot for same PID (updates timestamp)', async () => {
      // First acquire
      const got1 = await acquireLLMSlot();
      expect(got1).toBe(true);
      const info1 = JSON.parse(readFileSync(slotFile(), 'utf8'));

      // Small delay
      await sleepMs(10);

      // Release and re-acquire
      releaseLLMSlot();
      const got2 = await acquireLLMSlot();
      expect(got2).toBe(true);
      const info2 = JSON.parse(readFileSync(slotFile(), 'utf8'));

      expect(info2.ts).toBeGreaterThanOrEqual(info1.ts);
    });
    // ─── Pre-tag review, v3.68.0 (D#138 MEDIUM-3 follow-on) ──────────────────
    // The slot file is named per PROCESS. Before the MCP LLM legs went async,
    // two acquires could not overlap inside one process — execFileSync held the
    // event loop, so a second tools/call was not even read from stdio while the
    // first was in its LLM call. The EEXIST branch encodes exactly that
    // assumption ("we are inside acquire and therefore do NOT hold a slot, so it
    // is always stale") and unlinks unconditionally. De-blocking makes the
    // overlap the normal case for two concurrent mem_optimize calls.
    it("a concurrent acquire in the SAME process does not delete the live holder's slot", async () => {
      const first = await acquireLLMSlot();
      expect(first).toBe(true);
      const held = JSON.parse(readFileSync(slotFile(), 'utf8'));

      // Second acquire while the first is still held — the shape two concurrent
      // MCP handlers now produce. FAILS IF the EEXIST branch unlinks: the live
      // holder's file disappears, so the cross-process `active` count no longer
      // sees it (more than LLM_SEM_MAX concurrent `claude -p`), and the first
      // holder's later release unlinks the SECOND holder's file.
      const secondPromise = acquireLLMSlot();
      await sleepMs(250);
      expect(existsSync(slotFile()), "live holder's slot was unlinked by a sibling acquire").toBe(true);
      const still = JSON.parse(readFileSync(slotFile(), 'utf8'));
      expect(still.ts, "the live holder's slot was replaced, not preserved").toBe(held.ts);

      // Once the holder releases, the waiter proceeds.
      releaseLLMSlot();
      await expect(secondPromise).resolves.toBe(true);
      releaseLLMSlot();
      expect(existsSync(slotFile())).toBe(false);
    });
    // The OTHER half of the same-process gate, and the half a post-tag review
    // found untested: replacing `localHeldAt && age < LLM_SEM_STALE_MS` with a
    // bare `if (localHeldAt)` — deleting the self-heal entirely — left this file
    // 16/16 green. The escape hatch is what keeps one caller that acquired and
    // never released from deadlocking every later LLM call in a long-lived MCP
    // server; the review measured that blast radius at 181s for this file alone.
    // A record older than LLM_SEM_STALE_MS cannot be produced by waiting, hence
    // the test-only setter.
    it('a local hold record older than the stale threshold falls through instead of queueing', async () => {
      // Simulate a caller that acquired and never released, long ago.
      _setLocalHeldAt(Date.now() - LLM_SEM_STALE_MS - 1000);

      const t0 = Date.now();
      const got = await acquireLLMSlot();
      const elapsed = Date.now() - t0;

      expect(got, 'a stale local record must not block acquisition').toBe(true);
      // FAILS IF the gate drops its age check: acquire then queues behind a
      // holder that does not exist and only returns after LLM_SEM_TIMEOUT.
      expect(elapsed, 'stale record was queued behind rather than reclaimed').toBeLessThan(2000);
      expect(existsSync(slotFile())).toBe(true);
    });

    it('a FRESH local hold record still queues (the gate is not simply gone)', async () => {
      _setLocalHeldAt(Date.now());
      let settled = false;
      const pending = acquireLLMSlot().then((v) => {
        settled = true;
        return v;
      });

      await sleepMs(300);
      expect(settled, 'a live sibling hold must make a second acquire wait').toBe(false);

      releaseLLMSlot(); // sibling finishes
      await expect(pending).resolves.toBe(true);
    });
  });
});
