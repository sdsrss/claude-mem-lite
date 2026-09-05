import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  scanPluginCacheHookPollution,
  clearPluginCacheHooks,
  hasInstallManagedHooks,
  hasLiveInstallManagedHooks,
  pluginCacheHookEvents,
} from '../plugin-cache-guard.mjs';

function makeHome() {
  const dir = join(tmpdir(), `mem-cache-guard-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeCacheHooks(home, version, hooksBody) {
  const dir = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', version, 'hooks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify(hooksBody, null, 2));
  return join(dir, 'hooks.json');
}

describe('plugin-cache-guard', () => {
  // Driven to failure in all three directions, because the whole point of this
  // reader is to say NO: a check that cannot go red over an emptied manifest is
  // the false green it was written to replace.
  describe('pluginCacheHookEvents', () => {
    it('reports the event names a populated manifest registers', () => {
      const home = makeHome();
      try {
        writeCacheHooks(home, '3.95.0', {
          hooks: {
            SessionStart: [{ matcher: '*', hooks: [] }],
            Stop: [{ matcher: '*', hooks: [] }],
          },
        });
        const root = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', '3.95.0');
        expect(pluginCacheHookEvents(root)).toEqual({
          ok: true, events: ['SessionStart', 'Stop'], reason: null,
        });
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('says NO for a manifest cleared to {} — the shape that shipped as all-green', () => {
      const home = makeHome();
      try {
        writeCacheHooks(home, '3.95.0', {
          description: 'claude-mem-lite hooks',
          _note: 'Auto-cleared by hook-update.mjs post-install',
          hooks: {},
        });
        const root = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', '3.95.0');
        expect(pluginCacheHookEvents(root)).toEqual({ ok: false, events: [], reason: 'empty' });
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('says NO for a missing manifest and for an unparseable one', () => {
      const home = makeHome();
      try {
        const root = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', '3.95.0');
        expect(pluginCacheHookEvents(root)).toEqual({ ok: false, events: [], reason: 'no-manifest' });

        mkdirSync(join(root, 'hooks'), { recursive: true });
        writeFileSync(join(root, 'hooks', 'hooks.json'), '{ not json');
        expect(pluginCacheHookEvents(root)).toEqual({ ok: false, events: [], reason: 'unreadable' });
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });

  describe('scanPluginCacheHookPollution', () => {
    it('returns empty when cache base does not exist', () => {
      const home = makeHome();
      try {
        expect(scanPluginCacheHookPollution({ home })).toEqual([]);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('detects populated hooks.json across multiple versions', () => {
      const home = makeHome();
      try {
        writeCacheHooks(home, '2.28.0', { hooks: { SessionStart: [{ matcher: '*', hooks: [] }] } });
        writeCacheHooks(home, '2.30.0', { hooks: { UserPromptSubmit: [{ matcher: '*', hooks: [] }] } });
        writeCacheHooks(home, '2.31.0', { hooks: {} });  // cleared — should not appear
        expect(scanPluginCacheHookPollution({ home })).toEqual(['2.28.0', '2.30.0']);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('ignores malformed hooks.json', () => {
      const home = makeHome();
      try {
        const dir = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', '2.28.0', 'hooks');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'hooks.json'), 'not-json');
        expect(scanPluginCacheHookPollution({ home })).toEqual([]);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });

  describe('clearPluginCacheHooks', () => {
    it('clears populated hooks.json and writes _note marker', () => {
      const home = makeHome();
      try {
        const path = writeCacheHooks(home, '2.28.0', {
          description: 'old',
          hooks: { UserPromptSubmit: [{ matcher: '*', hooks: [] }] },
        });
        const cleared = clearPluginCacheHooks({ home, reason: 'test-reason' });
        expect(cleared).toEqual(['2.28.0']);
        const after = JSON.parse(readFileSync(path, 'utf8'));
        expect(after.hooks).toEqual({});
        expect(after._note).toContain('test-reason');
        expect(after._note).toContain('2.28.0');
        expect(after.description).toBe('old');
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('leaves already-cleared hooks.json untouched', () => {
      const home = makeHome();
      try {
        const path = writeCacheHooks(home, '2.28.0', { description: 'd', hooks: {} });
        const before = readFileSync(path, 'utf8');
        const cleared = clearPluginCacheHooks({ home });
        expect(cleared).toEqual([]);
        expect(readFileSync(path, 'utf8')).toBe(before);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });

  describe('hasInstallManagedHooks', () => {
    it('returns false when settings.json missing', () => {
      const home = makeHome();
      try {
        expect(hasInstallManagedHooks({ home })).toBe(false);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('returns true when settings.json hooks reference claude-mem-lite path', () => {
      const home = makeHome();
      try {
        mkdirSync(join(home, '.claude'), { recursive: true });
        writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
          hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${home}/.claude-mem-lite/hook.mjs" session-start` }] }] },
        }));
        expect(hasInstallManagedHooks({ home })).toBe(true);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('returns false when settings.json has unrelated hooks only', () => {
      const home = makeHome();
      try {
        mkdirSync(join(home, '.claude'), { recursive: true });
        writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
          hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'node /tmp/other-tool/hook.mjs' }] }] },
        }));
        expect(hasInstallManagedHooks({ home })).toBe(false);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });

  // The predicate that gates the DESTRUCTIVE branch. hasInstallManagedHooks answers a
  // string question and is right to; this one has to be able to say NO to a settings.json
  // that mentions us and cannot run, because that state is indistinguishable from a live
  // global install by string alone and clearing on it empties the only working manifest.
  describe('hasLiveInstallManagedHooks', () => {
    function writeSettings(home, command) {
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
        hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command }] }] },
      }));
    }

    it('returns true when the managed entry names a launcher that exists', () => {
      const home = makeHome();
      try {
        const launcher = join(home, '.claude-mem-lite', 'scripts', 'hook-launcher.mjs');
        mkdirSync(join(home, '.claude-mem-lite', 'scripts'), { recursive: true });
        writeFileSync(launcher, '// installed\n');
        writeSettings(home, `node "${launcher}" hook.mjs session-start`);
        expect(hasInstallManagedHooks({ home })).toBe(true);
        expect(hasLiveInstallManagedHooks({ home })).toBe(true);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('says NO when the managed entry names a launcher that was deleted', () => {
      const home = makeHome();
      try {
        const launcher = join(home, '.claude-mem-lite', 'scripts', 'hook-launcher.mjs');
        writeSettings(home, `node "${launcher}" hook.mjs session-start`);
        // The string test still passes — that is precisely the trap.
        expect(hasInstallManagedHooks({ home })).toBe(true);
        expect(hasLiveInstallManagedHooks({ home })).toBe(false);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('resolves an unquoted legacy command path too', () => {
      const home = makeHome();
      try {
        const launcher = join(home, '.claude-mem-lite', 'hook.mjs');
        writeSettings(home, `node ${launcher} session-start`);
        expect(hasLiveInstallManagedHooks({ home })).toBe(false);
        mkdirSync(join(home, '.claude-mem-lite'), { recursive: true });
        writeFileSync(launcher, '// installed\n');
        expect(hasLiveInstallManagedHooks({ home })).toBe(true);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('keeps the string answer when no path can be parsed out of the command', () => {
      const home = makeHome();
      try {
        // Marker present, but nothing path-shaped to check — the narrow rule must not
        // turn "unfamiliar shape" into "dead", or it would silently disable the dedup.
        writeSettings(home, 'run-mem-hook --plugin .claude-mem-lite/ session-start');
        expect(hasInstallManagedHooks({ home })).toBe(true);
        expect(hasLiveInstallManagedHooks({ home })).toBe(true);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('stays false on a plugin-only install (nothing of ours in settings.json)', () => {
      const home = makeHome();
      try {
        writeSettings(home, 'node /tmp/other-tool/hook.mjs');
        expect(hasLiveInstallManagedHooks({ home })).toBe(false);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });
});
