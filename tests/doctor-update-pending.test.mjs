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

function doctorUpdateLine(state) {
  const runtime = join(home, 'data', 'runtime');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'update-state.json'), JSON.stringify(state));
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [INSTALL_PATH, 'doctor'], {
      encoding: 'utf8',
      // No code home under this HOME, so the running version is CLAUDE_PLUGIN_ROOT's — the
      // plugin-mode shape #35 is about.
      env: {
        ...process.env,
        HOME: home,
        MEM_NO_AUTO_ADOPT: '1',
        CLAUDE_MEM_DIR: join(home, 'data'),
        CLAUDE_PLUGIN_ROOT: ROOT,
      },
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
