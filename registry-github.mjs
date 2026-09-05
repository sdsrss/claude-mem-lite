// claude-mem-lite: GitHub API helpers for smart import
// Pure functions for URL parsing and API URL construction
// Actual HTTP calls are in registry-importer.mjs

/**
 * Parse a GitHub URL into owner, repo, branch, path.
 * @param {string} url GitHub URL
 * @returns {{ owner: string, repo: string, branch: string, path: string } | null}
 */
export function parseGitHubUrl(url) {
  if (!url || typeof url !== 'string') return null;
  // Drop any query string / fragment (a copy-pasted "?tab=readme" or "#section"
  // browser anchor) before matching. Otherwise it leaks into the captured branch
  // ("main?x#y") and corrupts the GitHub API URL built from it, so the import
  // fails with a confusing 404 on a URL that opens fine in the browser.
  const clean = url.split(/[?#]/)[0];
  // RFC 3986: scheme + host are case-insensitive, but the path (owner/repo/branch/dir)
  // is NOT. Lowercase ONLY the scheme://github.com prefix — and only when github.com is
  // the real host (followed by '/' or end, never as a substring of github.com.evil.com)
  // — so a pasted "HTTPS://GitHub.com/…" (valid, opens in the browser) isn't rejected as
  // "Invalid GitHub URL". The structural host check in the match below is unchanged, so
  // github.com.evil.com / github.com@evil.com still fail.
  const normalized = clean.replace(/^https?:\/\/github\.com(?=\/|$)/i, (m) => m.toLowerCase());
  const match = normalized.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?(?:\/tree\/([^/]+)(\/.*)?)?$/,
  );
  if (!match) return null;
  const [, owner, repo, branch, pathRaw] = match;
  return {
    owner,
    repo,
    branch: branch || 'main',
    path: pathRaw ? pathRaw.replace(/^\//, '') : '',
  };
}

// Percent-encode ONE path segment. Git ref names may legally contain `#` (git forbids `?`,
// not `#`), and so may file names — interpolated raw, that `#` opens a URL FRAGMENT and
// swallows the rest: `…/git/trees/feat#x?recursive=1` parses as hash `#x?recursive=1` with an
// EMPTY query, so GitHub answered a NON-recursive tree and every nested skills/*/SKILL.md went
// silently undiscovered; the raw content URL lost its whole path the same way (audit
// 2026-09-05 R6 Q2, measured). encodeURIComponent leaves the unreserved set — including the
// `.`, `-`, `_` and `~` that ordinary owners/repos/branches are made of — untouched.
const seg = (s) => encodeURIComponent(String(s ?? ''));

// A repo-relative file path is MANY segments: encode each one but keep the `/` separators.
// encodeURIComponent on the whole path would emit `skills%2Ffoo%2FSKILL.md` and 404 every
// ordinary import — the counter-case pinned in tests/registry-github.test.mjs.
const segPath = (p) =>
  String(p ?? '')
    .split('/')
    .map(seg)
    .join('/');

/**
 * Build GitHub API tree URL (recursive).
 */
export function buildTreeUrl(owner, repo, branch) {
  return `https://api.github.com/repos/${seg(owner)}/${seg(repo)}/git/trees/${seg(branch)}?recursive=1`;
}

/**
 * Build raw content URL for a file.
 */
export function buildContentUrl(owner, repo, branch, path) {
  return `https://raw.githubusercontent.com/${seg(owner)}/${seg(repo)}/${seg(branch)}/${segPath(path)}`;
}

/**
 * Build GitHub API repo metadata URL.
 */
export function buildRepoUrl(owner, repo) {
  return `https://api.github.com/repos/${seg(owner)}/${seg(repo)}`;
}

/**
 * Build headers for GitHub API requests.
 * Uses GITHUB_TOKEN env var if available.
 * @returns {Record<string, string>}
 */
export function buildHeaders() {
  const headers = { 'User-Agent': 'claude-mem-lite', Accept: 'application/vnd.github.v3+json' };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `token ${token}`;
  return headers;
}
