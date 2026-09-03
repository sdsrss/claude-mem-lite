#!/usr/bin/env node
// scripts/post-tool-recall.js — PostToolUse companion to pre-tool-recall.js for
// the bind-salience forcing-function (component 2). After an Edit/Write, if a
// lesson surfaced for this file named an identifier that was present BEFORE the
// edit (recorded in the cooldown by pre-tool-recall.js) and is now GONE, emit a
// one-line non-blocking nudge. Only active under CLAUDE_MEM_SALIENCE=bind.
//
// Catches "you removed a required reference" lessons. It does NOT catch "you
// failed to ADD a call" (the identifier was never in the pre-edit file →
// presentIdents excluded it); that class is carried by the pre-edit
// BIND_DIRECTIVE, not here. See the spec's component-2 limits.
//
// Safety: readonly, no DB, exit 0 always. The cooldown path rule comes from
// lib/cooldown-path.mjs — it used to be inlined here "per the #8447 fast-path
// convention", but that exemption stopped applying to THIS script the moment it grew
// the four lib imports below (audit 2026-09-02 P1-1: the fourth copy; the previous
// round collapsed only three of four). A writer/reader disagreement on this name does
// not error — it reads a file nobody wrote, silently zeroing the bind-mode
// dropped-identifier check.

import { existsSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import { resolveDataDir } from '../lib/resolve-data-dir.mjs';
import { recordHookError } from '../lib/hook-telemetry.mjs';
// D#154: every envelope on this stdout goes through the one writer. This script has a
// single emit today, so the change buys nothing on its own — it buys that a SECOND
// emit added later merges instead of producing two JSON documents, which the host
// parses as neither (lib/hook-stdout.mjs). Import-free module over no runtime deps.
import { queueHookContext, flushHookStdout } from '../lib/hook-stdout.mjs';
import { cooldownPathFor as sharedCooldownPathFor } from '../lib/cooldown-path.mjs';

const SALIENCE_BIND = process.env.CLAUDE_MEM_SALIENCE === 'bind';

const DATA_DIR = resolveDataDir(process.env.CLAUDE_MEM_DIR);
const RUNTIME_DIR = process.env.CLAUDE_MEM_RUNTIME_DIR || join(DATA_DIR, 'runtime');
const LEGACY_COOLDOWN_PATH = join(RUNTIME_DIR, 'pre-recall-cooldown.json');

// The no-session legacy fallback stays local: it is this script's own back-compat with
// pre-session-id cooldown files, not part of the shared naming rule. Same split as
// scripts/pre-tool-recall.js, which is the writer.
function cooldownPathFor(sessionId) {
  if (!sessionId) return LEGACY_COOLDOWN_PATH;
  return sharedCooldownPathFor(RUNTIME_DIR, sessionId);
}

async function main() {
  if (!SALIENCE_BIND) return;
  if (process.env.CLAUDE_MEM_HOOK_RUNNING) return;
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let filePath, sessionId;
  try {
    const e = JSON.parse(input);
    filePath = e.tool_input?.file_path;
    sessionId = e.session_id || null;
  } catch { return; }
  if (!filePath) return;

  const cdPath = cooldownPathFor(sessionId);
  if (!existsSync(cdPath)) return;
  let entry;
  try { entry = JSON.parse(readFileSync(cdPath, 'utf8'))[filePath]; } catch (e) {
    // A corrupt cooldown file (torn concurrent write — audit 2026-08-14 M-6) turns
    // the bind-salience check into a zero-trace no-op; record it so `stats` can see
    // the surface die instead of silently reading zero errors (M-5).
    recordHookError('post-recall:cooldown-parse', e, RUNTIME_DIR, { file: basename(cdPath) });
    return;
  }
  const idents = entry && entry.lessonIdents;
  if (!idents || typeof idents !== 'object') return;

  let post;
  try { post = readFileSync(filePath, 'utf8'); } catch { return; }

  const dropped = [];
  for (const [obsId, tokens] of Object.entries(idents)) {
    for (const t of tokens) if (!post.includes(t)) dropped.push({ obsId, token: t });
  }
  if (!dropped.length) return;

  const lines = ['[mem] PostToolUse recall — system-injected context, continue your planned action:'];
  for (const d of dropped.slice(0, 3)) {
    lines.push(`[mem] ⚠ your edit to ${basename(filePath)} dropped \`${d.token}\` flagged by #${d.obsId} — if intentional say so, else re-check before moving on.`);
  }
  queueHookContext('PostToolUse', lines.join('\n'));
  flushHookStdout();
}

// No forced process.exit(0): main() consumes stdin to EOF (or early-returns without
// touching it) and holds no open handles (no DB, no timers), so the event loop drains
// and the process exits 0 on its own — which FLUSHES the stdout nudge above. A forced
// exit could drop that pending async write on a piped stdout (the v3.33.1 gotcha the
// payload-bearing sibling hooks avoid). catch() keeps the exit code 0.
// Swallow EPIPE: if Claude Code closes the read end before the async write drains, the
// stream emits 'error' — without the (now-removed) forced exit, an unhandled one would
// surface as a non-zero exit + stack. A hook must never fail loud on a dropped pipe.
process.stdout.on('error', () => {});
// Record what slips past main()'s early returns before the mandatory swallow —
// this script had zero telemetry (audit 2026-08-14 M-5). Recorder never throws;
// the outer catch keeps the exit code 0 regardless.
main().catch((e) => { try { recordHookError('post-recall:main', e, RUNTIME_DIR); } catch { /* never */ } });
