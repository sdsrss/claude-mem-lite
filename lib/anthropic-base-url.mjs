// lib/anthropic-base-url.mjs - one resolver for ANTHROPIC_BASE_URL.
//
// Two callers need the same answer and used to derive it differently:
// haiku-client's callModelAPI builds the request URL from it, and
// lib/llm-provider-probe.mjs picks the host + port doctor probes. When the two
// disagree, doctor certifies a hop the product never uses - the false-green
// shape this seam exists to remove. So the trim, the URL parse, and the
// validity verdict live here and both sites read the same result.
//
// ANTHROPIC_BASE_URL is the Claude Code / Anthropic SDK convention: an origin
// (+ optional /anthropic path on Azure Foundry) with NO /v1 suffix - callers
// append the endpoint path. Unset or blank keeps the public API, which is the
// behaviour before the gateway override existed.

import net from 'node:net';

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

// Plain http:// is allowed only to loopback. Anywhere else it puts the
// x-api-key on the wire unencrypted (and prompts in the clear), so that value
// is refused rather than silently honoured.
function isLoopbackHost(host) {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '[::1]' ||
    // A real dotted-quad loopback, not a DNS name that merely starts "127."
    // ("127.attacker.example" resolves wherever its owner says).
    (net.isIP(host) === 4 && host.startsWith('127.'))
  );
}

/**
 * Resolve the configured base URL into a usable origin + path.
 *
 * Never throws and always returns a well-formed `url` a caller can append
 * `/v1/messages` to: blank / unset keeps the public default, and a value that is
 * set but unusable (unparseable, non-http(s) scheme, userinfo, a query string or
 * fragment, or plain http to a non-loopback host) also returns the default so
 * callers always get a parseable value. `error` names why; the direct API leg
 * ignores the fallback and skips itself when a configured value is unusable, and
 * doctor surfaces the same reason instead of probing a hop nothing uses.
 *
 * @returns {{url: string, configured: boolean, error: string|null}}
 *   url        normalized origin+path, no trailing slash
 *   configured ANTHROPIC_BASE_URL was set to a non-blank value
 *   error      why a configured value is unusable, or null when it is fine
 */
export function resolveAnthropicBaseUrl() {
  const raw = (process.env.ANTHROPIC_BASE_URL || '').trim();
  if (!raw) return { url: DEFAULT_ANTHROPIC_BASE_URL, configured: false, error: null };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      url: DEFAULT_ANTHROPIC_BASE_URL,
      configured: true,
      error: 'ANTHROPIC_BASE_URL is not a valid URL',
    };
  }
  if (parsed.username || parsed.password) {
    // fetch() refuses to build a request with credentials in the URL, so every
    // call would fall back to the CLI while doctor reported the host reachable.
    return {
      url: DEFAULT_ANTHROPIC_BASE_URL,
      configured: true,
      error: 'ANTHROPIC_BASE_URL must not include userinfo (user:pass@)',
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      url: DEFAULT_ANTHROPIC_BASE_URL,
      configured: true,
      error: `ANTHROPIC_BASE_URL must use http or https (got ${parsed.protocol})`,
    };
  }
  // Raw string, not URL.search/hash: a bare trailing "?" or "#" leaves both
  // empty while still swallowing the appended path into the query.
  if (/[?#]/.test(raw)) {
    return {
      url: DEFAULT_ANTHROPIC_BASE_URL,
      configured: true,
      error: 'ANTHROPIC_BASE_URL must not include a query string or fragment',
    };
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    return {
      url: DEFAULT_ANTHROPIC_BASE_URL,
      configured: true,
      error: `ANTHROPIC_BASE_URL uses plain http to a non-loopback host (${parsed.hostname}); refusing to send the API key unencrypted`,
    };
  }
  return { url: raw.replace(/\/+$/, ''), configured: true, error: null };
}
