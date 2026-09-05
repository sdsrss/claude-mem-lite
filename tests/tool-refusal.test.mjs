// lib/tool-refusal.mjs — the gate on the PostToolUseFailure path (D#170).
//
// This module exists because that event fires for EVERY failed tool call, and on the
// maintainer's machine 68.9% of host-flagged Bash failures were the agent's own tool
// chain refusing — sandbox denials, policy hooks, permission prompts declined. Injecting
// three memories in response to a denied permission prompt is noise by construction.
//
// The cases below are split the way the module's own docblock argues they should be: the
// sentinels must fire on refusals, and — the half that is easy to forget and impossible
// to notice in production — must NOT fire on real program output that happens to use the
// same English words. A gate that swallows real failures fails silently, because silence
// is also what the surface did before this event was wired.
import { describe, it, expect } from 'vitest';
import { isToolChainRefusal, shouldRecallOnFailure, REFUSAL_SENTINELS } from '../lib/tool-refusal.mjs';

// Verbatim shapes, taken from real transcripts rather than written from memory.
const REFUSALS = {
  seccomp: 'apply-seccomp: unshare(CLONE_NEWUSER): Invalid argument',
  spec: '§8 SAFETY (immutable): denied dangerous Bash invocation:\n  - rm -rf with unvalidated $S',
  claudemd: '[claudemd] §11 memory-hint: your prompt matches MEMORY.md tags.',
  codeGraph:
    '[code-graph] Raw `grep` on indexed source — denied; the AST-aware equivalent already ran for you:',
  noTool: '<tool_use_error>Error: No such tool available: Bash.',
  coordinator: 'Bash is not available to you as the coordinator — run it in a subagent',
  userNo: "The user doesn't want to take this action right now.",
  permission: 'Claude requested permissions to use Bash, but you have not granted it yet.',
  excluded: '命令里有 ;，而它匹配了 sandbox.excludedCommands —— 请拆成多次 Bash 调用',
  // The family review found missing. The marker is a section CITATION, not the one
  // section that happened to be found first — the §7 shape alone was 13 of 135 firing
  // cases, and it injects: its own boilerplate becomes the query, so a blocked `git
  // push` recalled three memories about statusline adoption.
  shipBaseline: '§7 Ship-baseline: base-branch CI is RED — release(0.68.3): a failing workflow',
  memoryHint: '§11 MEMORY.md read-the-file (HARD): your prompt matches MEMORY.md tags.',
  specificity: '§10-V Specificity: value claims MUST cite an absolute number.',
  // The three above satisfy BOTH section patterns, so deleting either one was silent —
  // mutation caught that. These two separate them: the first has no colon (only the
  // start-anchored pattern sees it), the second is mid-sentence (only the
  // citation-shaped pattern does).
  sectionNoColon: '§9 Quality parallel-path completeness blocked this command before it ran',
  sectionEmbedded: 'pre-bash guard refused — §5 AUTH: scope not granted for this path',
};

// Real program failures. Several are chosen BECAUSE they contain refusal vocabulary
// ("denied", "permission", "not available") in a program's own voice — that is the
// collision the sentinels have to survive.
const REAL_FAILURES = {
  enoent: "Error: ENOENT: no such file or directory, open '/x/package.json'",
  permDenied: 'sh: ./deploy.sh: Permission denied',
  dockerDenied:
    'Error response from daemon: pull access denied for acme/api, repository does not exist or may require authorisation',
  http403: 'HTTP 403 Forbidden — access denied by the upstream API gateway',
  npmPerm: 'npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied, mkdir /usr/lib/node_modules',
  psql: 'psql: error: connection to server failed: FATAL:  permission denied for database "app"',
  moduleGone: "ModuleNotFoundError: No module named 'claude_sandbox'",
  unavailable: 'error: the requested feature is not available in this build',
  segv: 'Segmentation fault (core dumped)',
};

describe('tool-refusal — refusals are recognised', () => {
  for (const [name, text] of Object.entries(REFUSALS)) {
    it(`classifies "${name}" as a tool-chain refusal`, () => {
      expect(isToolChainRefusal(text)).toBe(true);
      expect(shouldRecallOnFailure({ error: text })).toEqual({ ok: false, reason: 'refusal' });
    });
  }
});

describe('tool-refusal — real program failures are NOT swallowed', () => {
  for (const [name, text] of Object.entries(REAL_FAILURES)) {
    it(`lets "${name}" through`, () => {
      expect(isToolChainRefusal(text)).toBe(false);
      expect(shouldRecallOnFailure({ error: text }).ok).toBe(true);
    });
  }

  it('a sentinel loosened to a bare word would break these — that is the point', () => {
    // Four of the nine real failures above say "denied" or "permission" in a program's
    // own voice. This asserts the fixture actually contains that collision, so the case
    // above is not vacuously green on a set of failures no loose pattern would match.
    const colliding = Object.values(REAL_FAILURES).filter((t) => /denied|permission|not available/i.test(t));
    expect(colliding.length).toBeGreaterThanOrEqual(4);
    for (const t of colliding) expect(isToolChainRefusal(t)).toBe(false);
  });
});

describe('tool-refusal — the two non-text gates', () => {
  it('an interrupt is not a program failure', () => {
    // The host's own flag, and the only discriminator here that is not pattern matching.
    expect(shouldRecallOnFailure({ error: REAL_FAILURES.enoent, is_interrupt: true })).toEqual({
      ok: false,
      reason: 'interrupt',
    });
    // Only the boolean true — a stray truthy string must not silence a real failure.
    expect(shouldRecallOnFailure({ error: REAL_FAILURES.enoent, is_interrupt: 'false' }).ok).toBe(true);
  });

  it('too little text to query on', () => {
    expect(shouldRecallOnFailure({ error: '' })).toEqual({ ok: false, reason: 'empty' });
    expect(shouldRecallOnFailure({ error: 'exit 1' })).toEqual({ ok: false, reason: 'empty' });
    expect(shouldRecallOnFailure({})).toEqual({ ok: false, reason: 'empty' });
    // The threshold matches PostToolUse's own `resp.length < 10`, so the two entry
    // points agree about what "no output" means.
    expect(shouldRecallOnFailure({ error: '0123456789' }).ok).toBe(true);
    expect(shouldRecallOnFailure({ error: '012345678' })).toEqual({ ok: false, reason: 'empty' });
  });

  it('survives a payload that is not shaped like a payload', () => {
    for (const junk of [null, undefined, {}, { error: null }, { error: 42 }, { error: [] }]) {
      expect(shouldRecallOnFailure(junk).ok, JSON.stringify(junk)).toBe(false);
    }
    expect(isToolChainRefusal(null)).toBe(false);
    expect(isToolChainRefusal(12)).toBe(false);
  });
});

describe('tool-refusal — the sentinel list itself', () => {
  // The earlier version of this block matched each sentinel's SOURCE against a
  // whitelist of substrings taken from the current list. Review broke it in one line:
  // a new loose sentinel `/doesn/i` passed, because "doesn" was already whitelisted for
  // the `user doesn't want to` entry. A whitelist keyed to the thing it is checking is
  // not a check. Both cases below are behavioural instead.

  it('every sentinel earns its place — it matches a real refusal', () => {
    // Adding a pattern without adding the refusal it was written for now fails here,
    // which also means the REFUSALS fixture cannot fall behind the list.
    const texts = Object.values(REFUSALS);
    for (const re of REFUSAL_SENTINELS) {
      expect(
        texts.some((t) => re.test(t)),
        `sentinel ${re.source} matches none of the refusal fixtures — add the shape it was written for`,
      ).toBe(true);
    }
  });

  it('no sentinel matches a real program failure — checked one at a time', () => {
    // The aggregate `isToolChainRefusal` cases above would stay green if a bad sentinel
    // were added but another one shadowed it. Per-sentinel attribution catches that, and
    // it is what kills a loose pattern regardless of which words it happens to contain.
    for (const re of REFUSAL_SENTINELS) {
      for (const [name, text] of Object.entries(REAL_FAILURES)) {
        expect(re.test(text), `sentinel ${re.source} swallows the real failure "${name}"`).toBe(false);
      }
    }
  });
});
