// D#115 / v6.17.0 pre-tag review P3-4, the third face of issue #35. A cached
// `updateAvailable` is a claim about the version that ran when the check ran; in plugin mode
// Claude Code applies the update and nothing clears the flag. The SessionStart banner and the
// throttled checkForUpdate already judge it against the version running now
// (pendingCachedUpdate); `doctor` printed "update pending" from the raw flag, so a user on
// the latest version was told an update was pending.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_PATH = join(ROOT, 'install.mjs');
const RUNNING = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

let home;

function updateStateLine(latestVersion) {
  return doctorUpdateLine({ lastCheck: '2026-09-27T12:56:14Z', latestVersion, updateAvailable: true });
}

// `state` null: no state file. CLAUDE_MEM_SKIP_UPDATE is unset unless `extraEnv` sets it, so a
// developer shell that exports it cannot flip these cases.
function doctorUpdateLine(state, extraEnv = {}) {
  const runtime = join(home, 'data', 'runtime');
  mkdirSync(runtime, { recursive: true });
  if (state) writeFileSync(join(runtime, 'update-state.json'), JSON.stringify(state));
  // No code home under this HOME, so the running version is CLAUDE_PLUGIN_ROOT's — the
  // plugin-mode shape #35 is about.
  const env = {
    ...process.env,
    HOME: home,
    MEM_NO_AUTO_ADOPT: '1',
    CLAUDE_MEM_DIR: join(home, 'data'),
    CLAUDE_PLUGIN_ROOT: ROOT,
  };
  delete env.CLAUDE_MEM_SKIP_UPDATE;
  Object.assign(env, extraEnv);
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [INSTALL_PATH, 'doctor'], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    stdout = e.stdout || '';
  }
  return stdout.split('\n').find((l) => l.includes('Update state:')) || '';
}

describe('doctor judges a cached update against the running version (#35, D#115 P3-4)', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'doctor-update-pending-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('premise: a cached latest ahead of the running version still reads "update pending"', () => {
    const line = updateStateLine('999.0.0');
    expect(line, 'doctor printed no Update state line at all').toContain('latest: v999.0.0');
    expect(line).toContain('update pending');
  });

  it('does not say "update pending" when the cached latest is the version running', () => {
    const line = updateStateLine(RUNNING);
    expect(line, 'doctor printed no Update state line at all').toContain(`latest: v${RUNNING}`);
    expect(line).not.toContain('update pending');
  });
});

// D#255: from 2026-08-19 to 2026-10-07 every update lookup through a proxy failed (GitHub
// answered the tunnel's `Host: …:80` with 400), the background check is silent by design, and
// this line read ✓ with a fresh "last check" the whole time.
describe('doctor warns when the last update lookup failed (D#255)', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'doctor-update-lookup-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('names the reason and the start of the failing run', () => {
    const line = doctorUpdateLine({
      lastCheck: '2026-10-07T09:00:00Z',
      latestVersion: RUNNING,
      lookupError: 'HTTP 400 via proxy http://proxy.test:3128',
      lookupFailingSince: '2026-08-19T08:00:00Z',
    });
    expect(line, 'doctor printed no Update state line at all').toContain('⚠');
    expect(line).toContain('HTTP 400 via proxy http://proxy.test:3128');
    expect(line).toContain('2026-08-19T08:00:00Z');
  });

  it('control: the same state with no lookup error stays ✓', () => {
    const line = doctorUpdateLine({ lastCheck: '2026-10-07T09:00:00Z', latestVersion: RUNNING });
    expect(line, 'doctor printed no Update state line at all').toContain('✓');
    expect(line).not.toContain('failed');
  });
});

// D#266: with CLAUDE_MEM_SKIP_UPDATE set neither the background check nor self-update looks up
// (only a repair does), so a failure recorded before it was set stayed a warning, and with no
// state file doctor asked "first run?" about a check that does not run.
describe('doctor with update checks turned off (D#266)', () => {
  const failing = {
    lastCheck: '2026-09-01T00:00:00Z',
    latestVersion: RUNNING,
    lookupError: 'HTTP 400',
    lookupFailingSince: '2026-08-20T00:00:00Z',
  };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'doctor-update-off-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('premise: the same recorded failure warns while checks are on', () => {
    expect(doctorUpdateLine(failing)).toContain('⚠');
  });

  it('says the checks are off instead of warning about a failure nothing will clear', () => {
    const line = doctorUpdateLine(failing, { CLAUDE_MEM_SKIP_UPDATE: '1' });
    expect(line, 'doctor printed no Update state line at all').toContain('CLAUDE_MEM_SKIP_UPDATE');
    expect(line).toContain('✓');
    expect(line).not.toContain('failed');
  });

  it('with no state file, says the checks are off rather than "first run?"', () => {
    const line = doctorUpdateLine(null, { CLAUDE_MEM_SKIP_UPDATE: '1' });
    expect(line, 'doctor printed no Update state line at all').toContain('CLAUDE_MEM_SKIP_UPDATE');
    expect(line).not.toContain('first run');
  });

  it('control: no state file with checks on still reads "first run?"', () => {
    expect(doctorUpdateLine(null)).toContain('first run');
  });
});
