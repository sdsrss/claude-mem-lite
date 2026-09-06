// claude-mem-lite: Secret pattern detection and scrubbing
// Extracted from utils.mjs for focused responsibility

import { stripPrivate } from './lib/private-strip.mjs';

// ─── Secret Patterns ──────────────────────────────────────────────────────

export const SECRET_PATTERNS = [
  // Key-value assignments: password=xxx, token=xxx, api_key=xxx, secret=xxx, etc.
  // Excludes code-like values: null, undefined, true, false, None, empty, function calls (word()),
  // and short values (<6 chars) that are typically variable names not secrets.
  //
  // Split into two patterns so prose mentions don't get scrubbed:
  //   1. Bare credential nouns (password|passwd|token|bearer|secret) commonly appear
  //      in English prose — "Marker token: xyzpdq", "the bearer: alice". The prose
  //      mention shape is the `:` form, so the prose lookbehind (NOT preceded by
  //      English-word + horizontal-space) guards ONLY the `:` separator. An `=` is
  //      config-assignment syntax, never prose, so `<word> password=<secret>` ALWAYS
  //      scrubs — without this split that leaked (the lookbehind skipped any noun
  //      after "word ", regardless of separator). No pinned prose case uses `=` (all
  //      are `:`), so the `=` arm is leak-closing with no FP shift on the protected set.
  //   2. Structured keys (api_key, auth_token, …) keep the original behavior —
  //      a separator/compound key is unambiguous config syntax even when
  //      preceded by prose ("see auth_token: shhhhhh").
  // `(?:\b|_)` before the keyword: a plain word-boundary misses the single most
  // common credential shape — underscore-cased env vars (DB_PASSWORD, GH_TOKEN,
  // MY_AUTH_TOKEN) — because `_` is a \w char, so there is NO \b between it and the
  // keyword. Allowing a leading `_` catches those while the prose lookbehind still
  // excludes "Marker token: …". `secret` added so a bare SECRET=… with a mixed-alnum
  // value is covered (the hex-only assignment pattern below misses non-hex values).
  //   1a. `=` assignment → ALWAYS scrub (config syntax, never prose):
  [
    /((?:\b|_)(?:password|passwd|passphrase|token|bearer|secret)\s*=\s*)(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)[^\s,;'"}\]]{6,}/gi,
    '$1***',
  ],
  //   1b. `:` separator, PASSWORD nouns. Position decides how permissive the value
  //       class may be, because the two positions have opposite error costs.
  //
  //       CONFIG position (start of line, or not preceded by an English word +
  //       space) is unambiguous assignment syntax → scrub any value, exactly as
  //       before. Pinned by the `  password: hunter2` indent cases.
  //
  //       PROSE position ("<word> password: …") is where v3.61.0 first removed the
  //       lookbehind outright, to stop "deployed to staging, the db password:
  //       hunter2correct" from persisting a credential. That closed a leak by
  //       trading it for something worse: scrubbing runs on the WRITE path, and the
  //       value class matches ordinary English, so "Reset the password: instructions
  //       are in the onboarding doc" was stored irreversibly as "password: *** are
  //       in the onboarding doc" (caught by independent pre-tag review). The claim
  //       that "<word> password: <6+ chars>" always names a credential was simply
  //       false. So in prose position the VALUE must look like a credential: not a
  //       run of lowercase letters. A digit, any uppercase, or a symbol qualifies —
  //       `hunter2correct`, `S3cretValue`, `correct-horse-battery-staple` all scrub,
  //       while `instructions` / `rotation` / `yesterday` are left alone.
  //
  //       "Credential-shaped" is spelled as: NOT a single run of ≤15 letters. The
  //       patterns carry `i`, so the letter class is case-insensitive by
  //       construction — deliberately, because prose capitalizes ("Reset the
  //       password: Instructions are in the doc" must survive, and a
  //       lowercase-only test would corrupt it). The length bound is what still
  //       catches a letters-only secret: English words in prose run short, secrets
  //       do not, so `aVeryLongOpaqueSecretToken` (26) scrubs while `instructions`
  //       (12) does not.
  //
  //       Two known, accepted gaps: a short letters-only password in prose position
  //       ("the password: hunter") survives, and an English word longer than 15
  //       letters is over-scrubbed. Config position still catches the former; the
  //       latter is rare in prose and errs toward protecting a secret. A value
  //       indistinguishable from an English word cannot be told from one without
  //       corrupting prose — which is exactly the error this arm exists to undo.
  //       Both arms emit `***` (3 chars, under the {6,} floor), so they cannot
  //       double-apply.
  [
    /((?<![A-Za-z][ \t])(?:\b|_)(?:password|passwd|passphrase)\s*:\s*)(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)[^\s,;'"}\]]{6,}/gi,
    '$1***',
  ],
  [
    /((?:\b|_)(?:password|passwd|passphrase)\s*:\s*)(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)(?![A-Za-z]{1,15}(?=[\s,;'"}\]]|$))[^\s,;'"}\]]{6,}/gi,
    '$1***',
  ],
  //   1c. `:` separator, prose-ambiguous nouns → keep the lookbehind ("the token: alice"):
  [
    /((?<![A-Za-z][ \t])(?:\b|_)(?:token|bearer|secret)\s*:\s*)(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)[^\s,;'"}\]]{6,}/gi,
    '$1***',
  ],
  // access_token / refresh_token are the canonical OAuth2 field names — they were
  // missing from this KV list (drift vs the JSON list below). `(?:\b|_)` for the same
  // underscore-prefix reason.
  // `pgpassword|pgpass|mysql_pwd` are well-known credential ENV-VAR names whose
  // keyword tail is unreachable via the noun list above (`PGPASSWORD`=PG+password has
  // no \b/_ before "password"; `MYSQL_PWD` has no "password"/"token" substring). They
  // live in THIS pattern (no prose lookbehind) so `export PGPASSWORD=x` / `env MYSQL_PWD=x`
  // scrub — a compound credential env-var name is unambiguous config even after a word.
  // Enumerating known names (not a blanket letter-prefix) preserves the deliberate
  // low-FP decision that `topsecret=` / `access_token_count:` are non-credentials
  // (#8283 + utils.test.mjs:1089-1100); bare `pwd` is omitted so `PWD=` (a path) survives.
  [
    /((?:\b|_)(?:api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|pgpassword|pgpass|mysql_pwd)\s*[=:]\s*)(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)[^\s,;'"}\]]{6,}/gi,
    '$1***',
  ],
  // Space-separated credential CLI flag: `--password <value>` (long-form). The KV
  // patterns above require `=`/`:`; the shell long-flag form uses a space. Long-form
  // only — `-p`/`-u` short flags collide with unit/user/update flags (too FP-risky).
  // `(?!-)` stops it eating a following `--flag` when --password has no value.
  // R10 P1-6: `token`, `api-key` and `secret` join the list. `vault login --token hvs.…`,
  // `gh auth login --token …` and `op … --secret …` are the shapes that actually appear in
  // Bash output. The {6,} floor is what keeps `--token abc` (a placeholder in a usage line)
  // out, so do not lower it.
  [/(--(?:password|passwd|token|api[-_]?key|secret)[=\s]+)(?!-)[^\s'"]{6,}/gi, '$1***'],
  // Bare-key QUOTED values — `api_key="..."`, `password: '...'`. The unquoted KV
  // patterns above stop at `'`/`"` (excluded from their value class), so a quoted
  // value matched 0 chars and slipped through. Consumes the opening quote, the value,
  // and the matching close quote (backref \2), replacing only the value. Unlike the
  // JSON pattern below it does NOT require the KEY to be quoted, covering `key="value"`
  // object-literal / YAML / quoted-.env shapes. Split into the SAME two patterns as the
  // unquoted KV pairs above so prose survives — a quoted value does not turn prose into
  // config (`the token: "x"` is still prose, must NOT scrub; #8283 / utils.test.mjs:1090).
  //   (a) bare credential nouns: `=` always scrubs; `:` keeps the prose lookbehind
  //       (mirrors the unquoted 1a/1b split — a quoted value doesn't turn `:` prose
  //       into config, but `<word> password="x"` is still a leak):
  [/((?:\b|_)(?:password|passwd|passphrase|token|bearer|secret)\s*=\s*)(['"])[^'"]{6,}\2/gi, '$1$2***$2'],
  [/((?:\b|_)(?:password|passwd|passphrase)\s*:\s*)(['"])[^'"]{6,}\2/gi, '$1$2***$2'],
  [/((?<![A-Za-z][ \t])(?:\b|_)(?:token|bearer|secret)\s*:\s*)(['"])[^'"]{6,}\2/gi, '$1$2***$2'],
  //   (b) structured keys + named env vars are unambiguous config even after a word
  //       (`see api_key: "x"` DOES scrub, mirroring the unquoted structured-key path):
  [
    /((?:\b|_)(?:pgpassword|pgpass|mysql_pwd|api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)(['"])[^'"]{6,}\2/gi,
    '$1$2***$2',
  ],
  // AWS access keys: AKIA (long-term) + ASIA (STS temp) + AROA (role) + AIDA
  // (user) + ANPA/ANVA/AGPA (other principal types). All share the 4-letter
  // prefix + exactly 16 base32 chars shape — specific enough for near-zero FP.
  [/\b(?:AKIA|ASIA|AROA|AIDA|ANPA|ANVA|AGPA)[A-Z0-9]{16}\b/g, '***'],
  // OpenAI / Anthropic keys (sk-...) — specific prefixes have lower length threshold
  [/\bsk-(?:proj|ant|ant-api\d{2})-[a-zA-Z0-9_-]{8,}\b/g, '***'],
  [/\bsk-[a-zA-Z0-9_-]{20,}\b/g, '***'],
  // GitHub tokens (ghp_, gho_, github_pat_)
  [/\b(?:ghp_|gho_|ghs_|ghr_|ghu_)[a-zA-Z0-9_]{30,}\b/g, '***'],
  [/\bgithub_pat_[a-zA-Z0-9_]{22,}\b/g, '***'],
  // GitLab tokens (glpat-)
  [/\bglpat-[a-zA-Z0-9_-]{20,}\b/g, '***'],
  // Slack tokens (xox[bpasr]-, xapp-, xoxe-)
  [/\b(?:xox[bpasr]|xapp|xoxe)-[a-zA-Z0-9-]{10,}\b/g, '***'],
  // Slack incoming-webhook URL — the path after /services/ is the shared secret.
  [/(https:\/\/hooks\.slack\.com\/services\/)[A-Za-z0-9/]+/g, '$1***'],
  // JWT tokens (eyJ...eyJ...)
  [/\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+\b/g, '***'],
  // PEM private key blocks. `[A-Z0-9 ]*` covers every armor label — RSA/EC/DSA/
  // OPENSSH plus ENCRYPTED and PGP (… PRIVATE KEY BLOCK) — that the fixed
  // alternation missed; the block delimiters make FP impossible.
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
    '***PEM_KEY***',
  ],
  // Long hex strings in credential assignments (e.g. SECRET_KEY=abc123def456...).
  // `hash` deliberately excluded: `hash: <40hex>` / `hash=<md5>` are git SHAs and
  // checksums (real, preserved data in this hash-heavy repo), not credentials.
  [/(\b(?:key|secret|token)\s*[=:]\s*)[0-9a-f]{32,}\b/gi, '$1***'],
  // Google Cloud API keys (AIza...)
  [/\bAIza[A-Za-z0-9_-]{35}\b/g, '***'],
  // Authorization header credentials — Bearer (opaque), Basic (base64 user:pass),
  // and GitHub's `token` scheme all carry secrets after the scheme word.
  [/(Authorization:\s*(?:Bearer|Basic|token)\s+)[^\s,;'"}\]]+/gi, '$1***'],
  // R10 P1-6: the same header as a QUOTED KEY — `{"Authorization":"Bearer …"}`. The
  // pattern above needs `Authorization:` literally, and in JSON a quote sits between the
  // name and the colon, so a `curl -v` / fetch header dump walked straight through. The
  // scheme word is optional because a raw token as the whole value is just as common;
  // `authorization` is not a benign key, and over-scrub is the safe direction here.
  [/(['"](?:proxy-)?authorization['"]\s*:\s*)(['"])(?:(?:Bearer|Basic|token)\s+)?[^'"]{6,}\2/gi, '$1$2***$2'],
  // R10 P1-6: Azure storage. AccountKey= is the account's master credential and sig= is a
  // live SAS token; neither had any pattern. `sig` is anchored to a URL query position
  // (`?`/`&`) rather than a word boundary — bare `\bsig=` eats `const sig=computeX(y)`.
  [/\b(AccountKey|SharedAccessSignature)=[^\s;&'"]{16,}/gi, '$1=***'],
  [/([?&]sig=)[^\s;&'"]{16,}/gi, '$1***'],
  // Supabase / generic long base64 keys (40+ chars, common in env vars)
  [
    /(\b(?:SUPABASE_KEY|SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|REDIS_URL)\s*[=:]\s*)[^\s,;'"}\]]+/gi,
    '$1***',
  ],
  // Basic auth in URLs (https://user:password@host). ftp/ftps added — file-drop
  // creds are a common leak shape the https-only form missed. The userinfo run
  // EXCLUDES `:` (`[^@/\s:]+`) so the two runs can't overlap on a colon — the
  // overlapping form caused O(n²) catastrophic backtracking on a colon-heavy
  // non-terminating input (an availability DoS on the synchronous prompt path).
  [/(https?|ftps?):\/\/[^@/\s:]+:[^@/\s]+@/gi, '$1://***:***@'],
  // Database connection strings (postgres, mysql, mariadb, mssql, mongodb, redis,
  // amqp) incl. their TLS/alias variants (rediss/amqps/mssql/sqlserver) — managed
  // cloud DBs almost always use the TLS scheme, which the base-only list leaked.
  [
    // R10 P1-6: `(\+[\w-]+)?` accepts the DBAPI-driver suffix every ORM writes —
    // `postgresql+psycopg2://`, `mysql+pymysql://`, `mssql+pyodbc://`. Without it a
    // SQLAlchemy create_engine() line leaked user:password in full.
    /\b(postgres(?:ql)?|mysql|mariadb|mssql|sqlserver|mongodb(?:\+srv)?|rediss?|amqps?)(\+[\w-]+)?:\/\/[^\s,;'"}\]]+/gi,
    '$1$2://***',
  ],
  // npm tokens (npm_...)
  [/\bnpm_[a-zA-Z0-9]{36,}\b/g, '***'],
  // Stripe keys (sk_live_, rk_live_, pk_live_, sk_test_, pk_test_) + webhook signing secret (whsec_)
  [/\b[srp]k_(?:live|test)_[a-zA-Z0-9]{20,}\b/g, '***'],
  [/\bwhsec_[a-zA-Z0-9]{20,}\b/g, '***'],
  // SendGrid API keys: SG.<22>.<43> — two dots at fixed offsets make this
  // structurally unmistakable; near-zero false-positive risk.
  [/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, '***'],
  // Twilio identifiers: Account SID (AC…) + API Key SID (SK…), each = prefix
  // + exactly 32 hex. The 2-letter prefix + 32-hex shape is specific: an MD5
  // is 32 hex (no AC/SK prefix → no match) and a 40-hex git SHA has no internal
  // \b so the trailing \b can't land mid-string. We deliberately do NOT scrub
  // the bare-hex Twilio *auth token* — see comment block at end re: SHA collision.
  [/\b(?:AC|SK)[0-9a-f]{32}\b/g, '***'],
  // Mailgun private API keys: key-<32 hex>. Prefix-anchored for the same reason;
  // bare 32-hex (no `key-`) is intentionally left alone to avoid hashing FPs.
  [/\bkey-[0-9a-f]{32}\b/g, '***'],
  // JSON-quoted secrets — error payloads / API responses commonly carry creds
  // as `{"api_key": "..."}`. The base key=value pattern stops at quotes, so
  // these slip through. Match the value-quoted form explicitly. Length floor
  // (6) avoids tripping on intentional placeholder shorts ("...", "secret").
  [
    /("(?:password|passwd|token|api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|access[_-]?token|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer|refresh[_-]?token|session[_-]?id|sessionid)"\s*:\s*")[^"]{6,}(")/gi,
    '$1***$2',
  ],
  // JSON keys with vendor PREFIX/SUFFIX around the core credential noun —
  // `"x_api_key"`, `"aws_secret_access_key"`, `"my_password"`, `"gh_token"`.
  // The exact-name list above misses these. Anchored to the credential nouns
  // (password|secret|api_key|auth_token|access_token|private_key) so a benign
  // `"token_count"` value (numeric, <6 non-quote chars after scrub) and prose
  // keys stay low-FP; over-scrub is the safe direction for at-rest memory.
  [
    /("\w*(?:password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\w*"\s*:\s*")[^"]{6,}(")/gi,
    '$1***$2',
  ],
  // Quoted-KEY credential values — Python dict reprs `{'api_key': '...'}`, single-quoted
  // JS/JSON, and any mixed quoting. The quoted-VALUE patterns above match an UNQUOTED key
  // (the key's closing quote sits between the key name and the `[=:]`, so `keyword\s*[=:]`
  // never fires); the JSON patterns require BOTH key and value DOUBLE-quoted. So a single-
  // quoted or mixed-quoted pair — the most common at-rest shape for opaque app secrets in
  // stored LLM output / error payloads / code snippets — slipped through unredacted (#8805
  // sibling). A quoted key is unambiguous config/data, so — like the JSON patterns — no prose
  // guard is needed. Key quote and value quote are matched independently (`['"]` each); the
  // value's close is a backref (\2) to its own opening quote. Same credential-noun set as the
  // vendor-prefix JSON pattern above (bare `token`/`bearer` deliberately excluded to avoid
  // `'token_count': 123456`); `passphrase` added here too (double-quoted JSON passphrase is
  // subsumed by this pattern since `['"]` matches `"`). Over-scrub is the safe direction.
  [
    /(['"]\w*(?:password|passwd|passphrase|secret|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\w*['"]\s*:\s*)(['"])[^'"]{6,}\2/gi,
    '$1$2***$2',
  ],
  // Session cookies in headers / urlencoded bodies (sessionid=, session_id=, JSESSIONID=, PHPSESSID=).
  // 16+ chars filters out short test fixtures like sessionid=abc.
  // R10 P1-6: plain `session=` — the Cookie / urlencoded form — gets its OWN pattern
  // restricted to `=`. It must NOT join the alternation above, because that one also
  // accepts `:`, and bare `session:` is prose and JS-object-key syntax, not a cookie.
  // Measured over 182,361 non-empty lines of this repo's tracked text, old vs new
  // back-to-back on the same bytes: the `[=:]` form over-scrubbed 6 real lines
  // (`session: r.content_session_id,` in lib/search-core.mjs, `per session: ${...}` in
  // benchmark/cite-recall.mjs). The `=`-only form left 1 (`session=content_session_id)`
  // in a comment); the 24-char floor below leaves 0. 24 is not arbitrary — PHPSESSID is
  // 26 chars, JSESSIONID and Django's sessionid are 32, so a real cookie clears it while
  // an identifier-shaped word does not. The named-cookie branch keeps its 16-char floor.
  [/\b((?:session[_-]?id|sessionid|jsessionid|phpsessid)\s*[=:]\s*)[^\s,;'"}\]]{16,}/gi, '$1***'],
  [/\b(session\s*=\s*)[^\s,;'"}\]]{24,}/gi, '$1***'],
  // ── DELIBERATELY NOT COVERED: bare high-entropy / "raw N-char" tokens ──────
  // A generic `[A-Fa-f0-9]{40}` / high-entropy regex would scrub this repo's own
  // legitimate data: 40-hex git SHAs, 32-hex MD5s, 64-hex SHA256s, and stored
  // `minhash_sig` values. In a hash-heavy codebase the false-positive cost
  // (silent `***` over real content, lost recall) exceeds the marginal catch —
  // and an entropy gate doesn't help because git SHAs are themselves high-entropy.
  // The contextual forms (token=…, Authorization: Bearer …, "api_key":"…") above
  // already cover the dangerous *labelled* shapes. If you are tempted to add a
  // bare-token pattern here: don't — anchor it to a provider prefix instead.
];

/**
 * Scrub known secret patterns (API keys, tokens, credentials) from text.
 * Also strips user-marked `<private>...</private>` blocks first, so every
 * persistence/log path that scrubs secrets inherits the `<private>` opt-out —
 * previously stripPrivate ran only on the user-prompt hook, not on writes.
 * @param {string} text Input text potentially containing secrets
 * @returns {string} Text with secrets replaced by '***'
 */
export function scrubSecrets(text) {
  if (!text || typeof text !== 'string') return text || '';
  let result = stripPrivate(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
