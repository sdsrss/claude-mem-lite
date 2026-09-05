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

/**
 * Build GitHub API tree URL (recursive).
 */
export function buildTreeUrl(owner, repo, branch) {
  return `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
}

/**
 * Build raw content URL for a file.
 */
export function buildContentUrl(owner, repo, branch, path) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

/**
 * Build GitHub API repo metadata URL.
 */
export function buildRepoUrl(owner, repo) {
  return `https://api.github.com/repos/${owner}/${repo}`;
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
