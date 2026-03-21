// claude-mem-lite LLM concurrency semaphore
// Limits concurrent claude -p calls to prevent resource contention

import { join } from 'path';
import { readFileSync, writeFileSync, unlinkSync, readdirSync, openSync, closeSync, writeSync, constants as fsConstants } from 'fs';
import { RUNTIME_DIR } from './hook-shared.mjs';

export const LLM_SEM_MAX = 2;
export const LLM_SEM_TIMEOUT = 30000; // 30s max wait

export const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Acquire a file-based semaphore slot for LLM calls.
 * Uses acquire-then-verify: atomically creates a slot file, then checks total count.
 * @returns {Promise<boolean>} true if slot acquired, false on timeout
 */
export async function acquireLLMSlot() {
  const deadline = Date.now() + LLM_SEM_TIMEOUT;
  const slotFile = join(RUNTIME_DIR, `llm-sem-${process.pid}`);

  while (Date.now() < deadline) {
    // Acquire-then-verify: atomically create our slot first, then check total count
    let created = false;
    try {
      let fd;
      try {
        fd = openSync(slotFile, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
        const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
        writeSync(fd, payload);
        created = true;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    } catch {
      // Slot file already exists for this PID — update timestamp
      try { writeFileSync(slotFile, JSON.stringify({ pid: process.pid, ts: Date.now() })); created = true; } catch {}
    }

    if (!created) { await sleepMs(200 + Math.random() * 800); continue; }

    // Count all active semaphore files (including ours) and clean stale ones
    let active = 0;
    try {
      for (const f of readdirSync(RUNTIME_DIR)) {
        if (!f.startsWith('llm-sem-')) continue;
        const fp = join(RUNTIME_DIR, f);
        try {
          const raw = readFileSync(fp, 'utf8');
          const info = JSON.parse(raw);
          const age = Date.now() - (info.ts || 0);
          if (age > 60000) {
            try { unlinkSync(fp); } catch {}
            continue;
          }
          if (info.pid) {
            try { process.kill(info.pid, 0); active++; } catch (killErr) {
              if (killErr.code === 'ESRCH') { try { unlinkSync(fp); } catch {} }
              else { active++; } // EPERM = process exists but different user
            }
          } else {
            active++;
          }
        } catch {
          // Corrupt/unreadable semaphore file — treat as stale and remove
          try { unlinkSync(fp); } catch {}
        }
      }
    } catch {}

    if (active <= LLM_SEM_MAX) return true; // Slot acquired

    // Too many concurrent — release our slot and back off
    try { unlinkSync(slotFile); } catch {}
    await sleepMs(200 + Math.random() * 800);
  }
  return false; // Timed out
}

/**
 * Release the file-based semaphore slot for the current process.
 */
export function releaseLLMSlot() {
  try { unlinkSync(join(RUNTIME_DIR, `llm-sem-${process.pid}`)); } catch {}
}
