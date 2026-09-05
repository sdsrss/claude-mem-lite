import { describe, it, expect } from 'vitest';
import {
  parseGitHubUrl,
  buildTreeUrl,
  buildContentUrl,
  buildRepoUrl,
  buildHeaders,
} from '../registry-github.mjs';

describe('parseGitHubUrl', () => {
  it('parses standard repo URL', () => {
    const r = parseGitHubUrl('https://github.com/user/repo');
    expect(r).toEqual({ owner: 'user', repo: 'repo', branch: 'main', path: '' });
  });

  it('parses URL with branch', () => {
    const r = parseGitHubUrl('https://github.com/user/repo/tree/develop');
    expect(r).toEqual({ owner: 'user', repo: 'repo', branch: 'develop', path: '' });
  });

  it('parses URL with branch and path', () => {
    const r = parseGitHubUrl('https://github.com/user/repo/tree/main/skills/foo');
    expect(r).toEqual({ owner: 'user', repo: 'repo', branch: 'main', path: 'skills/foo' });
  });

  it('returns null for invalid URL', () => {
    expect(parseGitHubUrl('https://gitlab.com/foo/bar')).toBeNull();
    expect(parseGitHubUrl('not-a-url')).toBeNull();
    expect(parseGitHubUrl('')).toBeNull();
  });

  it('handles trailing slash', () => {
    const r = parseGitHubUrl('https://github.com/user/repo/');
    expect(r).toEqual({ owner: 'user', repo: 'repo', branch: 'main', path: '' });
  });

  it('handles .git suffix', () => {
    const r = parseGitHubUrl('https://github.com/user/repo.git');
    expect(r).toEqual({ owner: 'user', repo: 'repo', branch: 'main', path: '' });
  });

  it('strips a copy-pasted query string / fragment so it does not leak into branch', () => {
    // A browser-copied "?tab=…" or "#section" must not become part of the branch
    // ("main?recursive=1#x") and corrupt the GitHub API URL → confusing 404.
    expect(parseGitHubUrl('https://github.com/user/repo/tree/main?recursive=1#x')).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'main',
      path: '',
    });
    expect(parseGitHubUrl('https://github.com/user/repo/tree/main#readme')).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'main',
      path: '',
    });
    expect(parseGitHubUrl('https://github.com/user/repo?tab=readme')).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'main',
      path: '',
    });
    expect(parseGitHubUrl('https://github.com/user/repo/tree/dev/skills/foo?ref=abc')).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'dev',
      path: 'skills/foo',
    });
  });

  it('treats scheme + host as case-insensitive (RFC 3986) but preserves path case', () => {
    // A pasted "HTTPS://GitHub.com/…" is a valid URL that opens in the browser; rejecting
    // it as "Invalid GitHub URL" is wrong. Scheme + host are case-insensitive; the path
    // (owner / repo / branch / dir) is case-SENSITIVE on GitHub and must be preserved.
    expect(parseGitHubUrl('HTTPS://GitHub.com/anthropics/skills')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
      branch: 'main',
      path: '',
    });
    expect(parseGitHubUrl('https://GITHUB.COM/user/repo/tree/main')).toEqual({
      owner: 'user',
      repo: 'repo',
      branch: 'main',
      path: '',
    });
    expect(parseGitHubUrl('HTTPS://GitHub.com/Anthropic-AI/My_Repo/tree/Feature/Src/File')).toEqual({
      owner: 'Anthropic-AI',
      repo: 'My_Repo',
      branch: 'Feature',
      path: 'Src/File',
    });
  });

  it('rejects host-spoofing / SSRF lookalikes', () => {
    expect(parseGitHubUrl('https://github.com.evil.com/user/repo')).toBeNull();
    expect(parseGitHubUrl('https://github.com@evil.com/user/repo')).toBeNull();
    expect(parseGitHubUrl('https://evil.com/github.com/user/repo')).toBeNull();
    // case-insensitivity must NOT open a spoofing hole (the structural host check stands)
    expect(parseGitHubUrl('HTTPS://GitHub.com.evil.com/user/repo')).toBeNull();
    expect(parseGitHubUrl('https://GITHUB.COM@evil.com/user/repo')).toBeNull();
  });
});

describe('URL builders', () => {
  it('buildTreeUrl returns correct API URL', () => {
    expect(buildTreeUrl('user', 'repo', 'main')).toBe(
      'https://api.github.com/repos/user/repo/git/trees/main?recursive=1',
    );
  });

  it('buildContentUrl returns correct raw URL', () => {
    expect(buildContentUrl('user', 'repo', 'main', 'skills/foo/SKILL.md')).toBe(
      'https://raw.githubusercontent.com/user/repo/main/skills/foo/SKILL.md',
    );
  });

  it('buildRepoUrl returns correct API URL', () => {
    expect(buildRepoUrl('user', 'repo')).toBe('https://api.github.com/repos/user/repo');
  });

  // ── audit 2026-09-05 R6 Q2 ───────────────────────────────────────────────────────
  // Git ref names may legally contain `#` (unlike `?`, which git forbids), and so may file
  // names. Interpolated raw, that `#` opens a URL FRAGMENT and swallows everything after it.
  // Measured on the un-encoded builder: new URL(buildTreeUrl('u','r','feat#x')) parsed as
  // { search: '', hash: '#x?recursive=1' } — so GitHub received a NON-recursive tree request
  // and every nested skills/*/SKILL.md became invisible, silently. The content URL lost its
  // whole path the same way.
  // FAILS IF: the builders go back to raw interpolation.
  it('a # in the branch cannot swallow the recursive=1 query', () => {
    const u = new URL(buildTreeUrl('user', 'repo', 'feat#x'));
    expect(u.searchParams.get('recursive')).toBe('1');
    expect(u.hash).toBe('');
    expect(u.pathname).toBe('/repos/user/repo/git/trees/feat%23x');
  });

  it('a # in the branch or path cannot truncate the raw content URL', () => {
    const u = new URL(buildContentUrl('user', 'repo', 'feat#x', 'skills/foo#1/SKILL.md'));
    expect(u.hash).toBe('');
    expect(u.pathname).toBe('/user/repo/feat%23x/skills/foo%231/SKILL.md');
  });

  // The counter-case: encoding must preserve the path SEPARATORS — encodeURIComponent on the
  // whole path would turn `skills/foo/SKILL.md` into `skills%2Ffoo%2FSKILL.md` and 404 every
  // ordinary import. The three cases above are satisfied by that broken form too, so without
  // this one the pin would green-light it.
  it('ordinary owner/repo/branch/path round-trip unchanged', () => {
    expect(buildTreeUrl('user', 'repo', 'main')).toBe(
      'https://api.github.com/repos/user/repo/git/trees/main?recursive=1',
    );
    expect(buildContentUrl('user', 'repo', 'main', 'skills/foo/SKILL.md')).toBe(
      'https://raw.githubusercontent.com/user/repo/main/skills/foo/SKILL.md',
    );
    expect(buildRepoUrl('user', 'repo')).toBe('https://api.github.com/repos/user/repo');
  });
});

describe('buildHeaders', () => {
  it('includes User-Agent', () => {
    const h = buildHeaders();
    expect(h['User-Agent']).toBe('claude-mem-lite');
  });

  it('includes Accept header', () => {
    const h = buildHeaders();
    expect(h.Accept).toBe('application/vnd.github.v3+json');
  });
});
