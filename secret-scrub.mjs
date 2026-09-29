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
  //
  // MARKDOWN AROUND A LABEL (D#128). `- **Password**: \`<v>\`` put `**` between the noun and
  // its separator, so no label pattern matched and the value was stored. Models write labels
  // that way all the time. So a label may carry up to three markup characters after the noun
  // (`[*_~\`]`), and up to two of `*_~` between the separator and the value
  // (`**Password:** <v>`). Three rules keep this from widening what counts as a value:
  //   - no backtick after the separator: `` `password:` <next word> `` names the label and
  //     then goes on in prose, and the next word (or a CJK run with no spaces) was scrubbed;
  //   - at most two characters there, so the scrubber's own `***` is never taken for markup
  //     (`password=*** token=abc` would scrub `token=abc` on the second pass);
  //   - the prose check looks through emphasis (`the **password**: …` is prose) but not a
  //     backtick, since `` word `token: <v>` `` is code, not prose. A label wrapped in code
  //     (`` `GH_TOKEN`: <v> ``) has its own branch, whose prose check looks past the opening
  //     backtick. That branch starts with a cheap lookahead: without it the 40-char lookbehind
  //     ran at every position, and a 500k-char input went from 407 ms to 3,387 ms.
  // Measured 2026-09-27 over 831,328 unique lines (this repo's tracked text plus local
  // transcripts: prompts, replies, tool output), old and new run back to back: 28 lines
  // differ. All the catches are fixtures quoted from the D#128 audit; the rest are
  // `- **token**:assistant …` and `` `PGPASSWORD`=PG+password ``, which the same text with
  // no markup scrubs too, plus a JSON-escaped `\n` taken as a value. Idempotence failures: 0
  // and 0. A 13,770-case ground-truth fuzz (labels × 8 wrappings × separators × values ×
  // positions): leaks 12,580 → 421, none newly opened. All 421 are `<word> token|secret|bearer:`
  // in prose, left open by design (below).
  //
  // ACCEPTED GAPS (D#131). This scrubber stops ACCIDENTAL persistence; an author who wants a
  // secret stored can always encode it. So shapes only an adversary writes stay open:
  // zero-width characters inside a label, fullwidth letters. Shapes that occur naturally but
  // cannot be told from prose stay open too: `password is <v>` and `<word> token: <v>` (the
  // guard below). A pattern that caught them would also rewrite ordinary sentences, and
  // v3.61.0 already had to undo exactly that. `| password | <v> |` table rows stay open for a
  // different reason: those 831k lines held 1 such row and none with a credential-shaped
  // value, so a table pattern's false-positive rate cannot be measured here.
  //   1a. `=` assignment → ALWAYS scrub (config syntax, never prose):
  [
    /((?:\b|_)(?:password|passwd|passphrase|token|bearer|secret)(?:[*_~`]{1,3})?\s*=(?:[*_~]{1,2}(?=\s))?\s*)(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)[^\s,;'"}\]]{6,}/gi,
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
    /((?:(?<![A-Za-z][ \t][*_~]{0,3})(?:\b|_)(?:password|passwd|passphrase)(?:[*_~]{1,3})?|(?=_?(?:password|passwd|passphrase)`)(?<![A-Za-z][ \t]`[\w-]{0,40})(?<=`[\w-]{0,40})(?:\b|_)(?:password|passwd|passphrase)`)\s*[:：](?:[*_~]{1,2}(?=\s))?\s*)(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)[^\s,;'"}\]]{6,}/gi,
    '$1***',
  ],
  [
    /((?:\b|_)(?:password|passwd|passphrase)(?:[*_~`]{1,3})?\s*[:：](?:[*_~]{1,2}(?=\s))?\s*)(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)(?![A-Za-z]{1,15}(?=[`*~]*(?:[\s,;'"}\]]|$)))[^\s,;'"}\]]{6,}/gi,
    '$1***',
  ],
  //   1c. `:` separator, prose-ambiguous nouns → keep the lookbehind ("the token: alicebob"):
  [
    /((?:(?<![A-Za-z][ \t][*_~]{0,3})(?:\b|_)(?:token|bearer|secret)(?:[*_~]{1,3})?|(?=_?(?:token|bearer|secret)`)(?<![A-Za-z][ \t]`[\w-]{0,40})(?<=`[\w-]{0,40})(?:\b|_)(?:token|bearer|secret)`)\s*[:：](?:[*_~]{1,2}(?=\s))?\s*)(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)[^\s,;'"}\]]{6,}/gi,
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
    /((?:\b|_)(?:api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|pgpassword|pgpass|mysql_pwd)(?:[*_~`]{1,3})?\s*[=:：](?:[*_~]{1,2}(?=\s))?\s*)(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)[^\s,;'"}\]]{6,}/gi,
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
  [
    /((?:\b|_)(?:password|passwd|passphrase|token|bearer|secret)(?:[*_~`]{1,3})?\s*=(?:[*_~]{1,2}(?=\s))?\s*)(['"])[^'"]{6,}\2/gi,
    '$1$2***$2',
  ],
  [
    /((?:\b|_)(?:password|passwd|passphrase)(?:[*_~`]{1,3})?\s*[:：](?:[*_~]{1,2}(?=\s))?\s*)(['"])[^'"]{6,}\2/gi,
    '$1$2***$2',
  ],
  [
    /((?:(?<![A-Za-z][ \t][*_~]{0,3})(?:\b|_)(?:token|bearer|secret)(?:[*_~]{1,3})?|(?=_?(?:token|bearer|secret)`)(?<![A-Za-z][ \t]`[\w-]{0,40})(?<=`[\w-]{0,40})(?:\b|_)(?:token|bearer|secret)`)\s*[:：](?:[*_~]{1,2}(?=\s))?\s*)(['"])[^'"]{6,}\2/gi,
    '$1$2***$2',
  ],
  //   (b) structured keys + named env vars are unambiguous config even after a word
  //       (`see api_key: "x"` DOES scrub, mirroring the unquoted structured-key path):
  [
    /((?:\b|_)(?:pgpassword|pgpass|mysql_pwd|api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token)(?:[*_~`]{1,3})?\s*[=:：](?:[*_~]{1,2}(?=\s))?\s*)(['"])[^'"]{6,}\2/gi,
    '$1$2***$2',
  ],
  // AWS access keys: AKIA (long-term) + ASIA (STS temp) + AROA (role) + AIDA
  // (user) + ANPA/ANVA/AGPA (other principal types). All share the 4-letter
  // prefix + exactly 16 base32 chars shape — specific enough for near-zero FP.
  [/\b(?:AKIA|ASIA|AROA|AIDA|ANPA|ANVA|AGPA)[A-Z0-9]{16}(?![A-Za-z0-9])/g, '***'],
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
  // JWT tokens (eyJ...eyJ...), from any `eyJ`: one glued to a prefix (`my-sess-eyJ…`,
  // `session-<uuid>-eyJ…`, `tok_eyJ…`) is still a JWT. Every `eyJ` of one dotless run used to be a
  // fresh start that rescanned the run to its end — quadratic, 9.6 s on 200k chars of `eyJ-`
  // (D#130) — and v6.19.0's bounded lookbehind that fixed it missed a prefix over 40 characters
  // (round-3 review P3-2). Here a failed start consumes its run instead (`|eyJ[\w-]*`, returned
  // unchanged), so the scan resumes after it. Nothing is lost: the first segment cannot contain a
  // `.`, so every later `eyJ` of the same run reaches the same run end and fails the same way.
  [
    /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+\b|eyJ[a-zA-Z0-9_-]*/g,
    (m) => (m.includes('.') ? '***' : m),
  ],
  // PEM private key blocks. `[A-Z0-9 ]*` covers every armor label — RSA/EC/DSA/
  // OPENSSH plus ENCRYPTED and PGP (… PRIVATE KEY BLOCK) — that the fixed
  // alternation missed.
  // The body stops at the next `-----BEGIN ` (D#130): with `[\s\S]*?` every header with no END
  // scanned to the end of the text, on each of scrubSecrets' passes — quadratic, 8.3 s on 500k
  // chars. A block whose END is missing is left to the next pattern. Nor does it cross a mark this
  // scrubber wrote: on a later pass, a BEGIN that a scrubbed key used to block reached a far END
  // and erased the prose between (v6.19.2 pre-tag defect review F5).
  // Text that names a BEGIN and, later, an END with no key between them loses the text between
  // (D#155, accepted). Keeping such a block was tried for 6.19.3 and withdrawn before the tag: each
  // of the three keep rules measured stored keys this pattern erases, either a key it took for text
  // or a key tail the kept markers hid from scrubKeyTails (docs/audits/20260928-v6.19.3-pretag-*.md).
  // On this machine (2026-09-28) all 967 such blocks in 1,064 transcripts came from this
  // repository's scrubber work; the other projects' transcripts held 6 BEGIN markers and no END.
  // That shows the shape is rare here, not that text about PEM markers elsewhere keeps its words.
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:(?!-----BEGIN [A-Z0-9 ]*PRIVATE KEY|\*\*\*PEM_KEY\*\*\*)[\s\S])*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
    '***PEM_KEY***',
  ],
  // A cut-off key (`head id_rsa`, a tool output cut mid-key) and a headerless key tail (`tail
  // key.pem`). These are line scanners, not patterns (D#145): three rounds of review each found a
  // line shape the regex versions misread, and each fix to one shape erased prose in another.
  // See scrubCutOffKeys and scrubKeyTails below for the line rules.
  [{ [Symbol.replace]: (text) => scrubCutOffKeys(text) }, null],
  [{ [Symbol.replace]: (text) => scrubKeyTails(text) }, null],
  // Long hex strings in credential assignments (e.g. SECRET_KEY=abc123def456...).
  // `hash` deliberately excluded: `hash: <40hex>` / `hash=<md5>` are git SHAs and
  // checksums (real, preserved data in this hash-heavy repo), not credentials.
  [/(\b(?:key|secret|token)\s*[=:]\s*)[0-9a-f]{32,}\b/gi, '$1***'],
  // Google Cloud API keys (AIza...)
  [/\bAIza[A-Za-z0-9_-]{35}\b/g, '***'],
  // Authorization header credentials — Bearer (opaque), Basic (base64 user:pass),
  // and GitHub's `token` scheme all carry secrets after the scheme word.
  [
    /(Authorization(?:[*_~`]{1,3})?[:：](?:[*_~]{1,2}(?=\s))?\s*(?:Bearer|Basic|token)\s+)[^\s,;'"}\]]+/gi,
    '$1***',
  ],
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
  [/\bnpm_[a-zA-Z0-9]{36,}(?![A-Za-z0-9])/g, '***'],
  // Stripe keys (sk_live_, rk_live_, pk_live_, sk_test_, pk_test_) + webhook signing secret (whsec_)
  [/\b[srp]k_(?:live|test)_[a-zA-Z0-9]{20,}(?![A-Za-z0-9])/g, '***'],
  [/\bwhsec_[a-zA-Z0-9]{20,}(?![A-Za-z0-9])/g, '***'],
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
  // `\w{0,64}`, not `\w*`, on both sides of the noun here and in the next pattern (D#130): from
  // one quote, `\w*` ran to the end of a word run and backtracked through every keyword in it,
  // each rescanning the run — `"` + `secret` x 33k took 4.6 s. 64 is far past any key name.
  [
    /("\w{0,64}(?:password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\w{0,64}"\s*:\s*")[^"]{6,}(")/gi,
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
    /(['"](?:\w{0,64}(?:password|passwd|passphrase|secret|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\w{0,64}|\w{1,64}_token)['"]\s*:\s*)(['"])[^'"]{6,}\2/gi,
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

// ─── Cut-off private keys (D#145) ──────────────────────────────────────────
// A key's text reaches the scrubber in many line shapes: plain LF/CRLF/CR lines, JSON-escaped
// breaks (`\n` as two characters, or `\\n` when serialised twice), lines carrying a prefix (the
// Read tool's `     2\t` or `2→`, grep's `id_rsa:`, a `> ` quote, a diff `-`), and lines inside a
// quoted string. The scanners read the text as lines of ONE shape per key, decided at the key:
//   - the break after the BEGIN line (or before the END line) says whether breaks are real or
//     escaped, and at which depth; in real-break text a backslash is never a break, so a Windows
//     path in a `Comment:` value no longer ends the header (v6.19.1 round-3 P3-E);
//   - the text before the BEGIN (or END) on its line is the line prefix, and every other line
//     loses a prefix of the same shape (digits may differ, `:` and `-` swap for grep context)
//     before it is judged;
//   - lines end at breaks only. A header value that runs on into the next JSON fields is still
//     one header line, so it erases nothing without a base64 line under it (round-3 P3-C).
// A body line is WHOLE base64: 16+ characters, or 1-15 for the last line. So a word under a key
// body keeps its text (round-3 P3-A: `Don't` lost `Don`), as does a path or an identifier that
// starts the next line (P3-B), and a body needs one long line, so a header followed by words is
// not a key (F3). A string's closing quote, a backtick or a closing tag after the line is not part
// of it. A line whose base64 run is followed by something else is a cut or annotated key line
// when the run is 40+ characters or a truncation mark or delimiter follows it (`…`, `...`,
// `[truncated]`, `<`): its base64 goes and the rest stays (delta review P3-2; v6.19.2 pre-tag
// defect review F4). A shorter run followed by words starts a line of prose.

const KEY_BEGIN_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;
const KEY_END_RE = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;
const KEY_END_LINE_RE = /^-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const B64_LONG_RE = /^[A-Za-z0-9+/=]{16,}$/;
const B64_SHORT_RE = /^[A-Za-z0-9+/=]{1,15}$/;
// Space-separated chunks, allowed only on the BEGIN line itself (a key pasted onto one line).
const B64_CHUNKS_RE = /^[A-Za-z0-9+/=]+(?:[ \t]+[A-Za-z0-9+/=]+)*$/;
const B64_RUN_RE = /^[A-Za-z0-9+/=]{16,}/;
// What may follow a key line that was cut or annotated: a truncation mark or a delimiter. A quote
// ends the string a key sits in (`…', 'rc': 0}`, `…","stderr":…`): the scanners do not track which
// quote opened a string, since no character before a quote tells an opening quote from prose
// (`Here's`, `Run 'head id_rsa'`, `b'…'`; v6.19.2 pre-tag reviews, delta F1 and round-3 F1/F2).
// Two escapes deep a string ends at `\"` (round-4 F2). Five dashes are the next key's marker glued
// to a cut line (`for i in …; do head -c 80 k; done`).
const CUT_MARK_RE = /^(?: ?…| ?\.\.\.| ?\[| ?<|[`"']|\\+["']|-----)/;
const PGP_CRC_RE = /^=[A-Za-z0-9+/]{4}$/;
// How a key's base64 starts: a DER SEQUENCE (PKCS#1, PKCS#8, SEC1) or OpenSSH's `openssh-key-v1`;
// under a PGP header, a secret-key packet in the old or new format (`lQ…`, `xc…`/`xV…`).
const KEY_MAGIC_RE = /^(?:MII|MIG|MC4C|MHcC|b3BlbnNzaC1rZXktdjE)/;
const PGP_MAGIC_RE = /^(?:lQ|x[cV])/;
// RFC 1421 / RFC 4880 armor headers, before the body. Named, not any `Word:`: a `Note:` line is
// prose, and taking it for a header made the lone base64 line under it a key.
// RFC 1421's full set and tool-written `X-` headers count too (v6.19.2 pre-tag delta review F4:
// `Content-Domain` or `X-Custom` before the body stored the whole key).
const ARMOR_HEADER_RE =
  /^(?:Proc-Type|DEK-Info|Content-Domain|Originator-ID-(?:Asymmetric|Symmetric)|Originator-Certificate|Issuer-Certificate|MIC-Info|Key-Info|Recipient-ID-(?:Asymmetric|Symmetric)|CRL|Version|Comment|Hash|Charset|MessageID|X-[A-Za-z0-9-]+)[ \t]*:/i;
const MAX_ARMOR_HEADERS = 16;
// A JS/Python string split across source lines: `…\n" +` then `"…` on the next line. Not a comma:
// `'…\n',` then `'…'` is the next element of a list, and its first word is not the key's last line.
// One whitespace quantifier on each side of the `+`: `[ \t]*\+?[ \t]*` split a run between two
// and was quadratic when no break followed (v6.19.2 pre-tag defect review F1: 16-19 s at 200k).
const CONCAT_AFTER_RE = /["'](?:[ \t]*\+)?[ \t]*(?:\r\n|\n|\r)[ \t]*["']/y;
const CONCAT_BEFORE_RE = /(?:\\r)?\\n["'](?:[ \t]*\+)?[ \t]*(?:\r\n|\n|\r)[ \t]*["']$/;
const PEM_MARK = '***PEM_KEY***';
// After an END that ends its line: a closing quote or punctuation, then a break or the text end.
// Closing tags may be nested (`END</code></pre>`; round-4 F3), and a string's closing quote, escaped
// or not, ends the line whatever follows it: `…END-----","stderr":""` is `tail -n 2` in a tool
// result (round-5 F3).
const CLEAN_AFTER_END_RE = /(?:[ \t`,;)\]}]|<\/[A-Za-z][\w:.-]{0,40}>)*(?:\r|\n|\\+[nr]|\\*["']|$)/y;

const BLANK = 0;
const LONG = 1;
const SHORT = 2;
const END = 3;
const ARMOR = 4;
const CUT = 5;
const OTHER = 6;

// Character-class checks by code, not a regex per character. (What brought the many-BEGINs linearity
// shape back under its budget after the v6.19.2 CI run was cutOffKeyEnd stopping before another
// BEGIN line, not these checks: under coverage the shape measured 5.6-6.2x benign with these checks
// alone, 1.9-2.3x with the stop alone.)
function isB64Code(c) {
  return (
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61
  );
}

function backslashesBefore(text, i, floor) {
  let j = i;
  while (j > floor && text[j - 1] === '\\') j--;
  return i - j;
}

// Break depth `u`: 0 = real breaks only, 1 = `\n`, 2 = `\\n`, … A run of r backslashes then `n`
// is a break at depth u when r % 2u === u (the backslashes before it are escaped backslashes).
const isEscBreak = (r, u) => u > 0 && r % (2 * u) === u;
// An unescaped quote at depth u ends the string: r % 2u < u.
const isStringEnd = (r, u) => u > 0 && r % (2 * u) < u;

/** The line starting at s: its end, and where the next line starts (-1 at the end of the text). */
function nextLine(text, s, u) {
  const n = text.length;
  let i = s;
  while (i < n) {
    const ch = text[i];
    if (ch === '\n') return { end: i, next: i + 1 };
    if (ch === '\r') return { end: i, next: text[i + 1] === '\n' ? i + 2 : i + 1 };
    if (u > 0 && ch === '\\') {
      let j = i;
      while (j < n && text[j] === '\\') j++;
      const r = j - i;
      const c = text[j];
      if ((c === 'n' || c === 'r') && isEscBreak(r, u)) {
        let next = j + 1;
        if (c === 'r' && text.startsWith('\\'.repeat(u) + 'n', next)) next += u + 1;
        if (u === 1) {
          CONCAT_AFTER_RE.lastIndex = next;
          const m = CONCAT_AFTER_RE.exec(text);
          if (m) next += m[0].length;
        }
        return { end: j - u, next };
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return { end: n, next: -1 };
}

/** The line that ends at the break before `ls`, or null when `ls` starts the text or string. */
function prevLine(text, ls, u, floor) {
  if (ls - 1 < floor) return null;
  const c = text[ls - 1];
  let bs = -1;
  if (c === '\n') bs = ls - 2 >= floor && text[ls - 2] === '\r' ? ls - 2 : ls - 1;
  else if (c === '\r') bs = ls - 1;
  else if ((c === 'n' || c === 'r') && isEscBreak(backslashesBefore(text, ls - 1, floor), u)) {
    bs = ls - 1 - u;
    const r2 = bs - 1 >= floor && text[bs - 1] === 'r' ? backslashesBefore(text, bs - 1, floor) : 0;
    if (c === 'n' && isEscBreak(r2, u)) bs -= u + 1;
  } else if (u === 1 && (c === '"' || c === "'")) {
    const m = CONCAT_BEFORE_RE.exec(text.slice(Math.max(floor, ls - 64), ls));
    if (m) bs = ls - m[0].length;
  }
  if (bs === -1) return null;
  let i = bs - 1;
  while (i >= floor) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') break;
    if (u > 0 && (ch === 'n' || ch === 'r') && isEscBreak(backslashesBefore(text, i, floor), u)) break;
    if (u > 0 && (ch === '"' || ch === "'") && isStringEnd(backslashesBefore(text, i, floor), u)) break;
    i--;
  }
  return { start: i + 1, end: bs };
}

/** A regex for the line prefix `prefix` has, with digits free and grep's `:`/`-` interchangeable. */
function prefixShape(prefix) {
  const body = prefix.replace(/^[ \t]+/, '');
  if (!body || body.length > 256) return null;
  if (body === '-' || body === '+') return /^[ \t]*[-+ ]/;
  const src = body
    .replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    .replace(/\d+/g, '\\d+')
    .replace(/[:-]/g, '[:-]');
  return new RegExp(`^[ \\t]*${src}`);
}

/** The judged part of line [s, e): no prefix of the key's shape, no padding, no string quotes. */
function lineCore(text, s, e, shape) {
  let line = text.slice(s, e);
  let off = s;
  if (shape) {
    const m = shape.exec(line);
    if (m) {
      line = line.slice(m[0].length);
      off += m[0].length;
    }
  }
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  if (a < b && (line[a] === '"' || line[a] === "'" || line[a] === '`')) a++;
  // A closing quote or backtick with what may follow it (`",`, `" +`, `')`), or a closing tag
  // (`</key>`), and escaped breaks before it. Read from the end: an unanchored
  // `(?:\\+[rn])*["']…$` retried every start in a backslash run.
  let q = b;
  while (q > a && ' \t+,;)]}'.includes(line[q - 1])) q--;
  const tag = q > a && line[q - 1] === '>' ? /<\/[A-Za-z][\w:.-]{0,40}>$/.exec(line.slice(a, q)) : null;
  if (tag) b = q - tag[0].length;
  else if (q > a && (line[q - 1] === '"' || line[q - 1] === "'" || line[q - 1] === '`')) {
    q--;
    for (;;) {
      if (q - 1 <= a || (line[q - 1] !== 'n' && line[q - 1] !== 'r')) break;
      let k = q - 1;
      while (k > a && line[k - 1] === '\\') k--;
      if (k === q - 1) break;
      q = k;
    }
    b = q;
  }
  return { core: line.slice(a, b), start: off + a, end: off + b };
}

function classify(core) {
  if (core === '') return BLANK;
  if (B64_LONG_RE.test(core)) return LONG;
  if (B64_SHORT_RE.test(core)) return SHORT;
  if (KEY_END_LINE_RE.test(core)) return END;
  if (ARMOR_HEADER_RE.test(core)) return ARMOR;
  if (cutRun(core)) return CUT;
  return OTHER;
}

/**
 * The base64 run a cut or annotated key line starts with, or null: 16+ characters followed by a
 * truncation mark or a delimiter (`…`, `...`, `[truncated]`, `<`, a backtick), or 40+ followed by
 * anything (`<64> see above`). A shorter run followed by text is an identifier or a path starting
 * a line of prose (`exportedArmoredPrivateKey = …`, round-3 P3-B), which stays.
 */
function cutRun(core) {
  const m = B64_RUN_RE.exec(core);
  if (!m) return null;
  return m[0].length >= 40 || CUT_MARK_RE.test(core.slice(m[0].length)) ? m[0] : null;
}

/**
 * Where the key that starts with the BEGIN at [b, be) ends, or -1 when no key material follows it.
 * Header lines and blank lines may come first; then 16+-character base64 lines (blank lines only
 * between them), one shorter last line (and a PGP `=XXXX` checksum after it), and the END if it
 * is there. One base64 line alone is a key only when it is 40+ characters, starts the way a key
 * encoding starts (DER `MII…`, OpenSSH `b3BlbnNzaC1rZXktdjE…`) or follows armor headers: a path
 * or an identifier of 16-39 characters under a header is prose (delta review P3-5). A complete
 * block never gets here; the block pattern above takes it first.
 */
function cutOffKeyEnd(text, b, be) {
  // The rest of the BEGIN line: nothing, or base64 chunks, then a break that sets the depth.
  let i = be;
  for (
    let c = text.charCodeAt(i);
    i < text.length && (isB64Code(c) || c === 32 || c === 9);
    c = text.charCodeAt(++i)
  );
  const rest = text.slice(be, i).trim();
  let u;
  let next;
  if (i >= text.length) return -1;
  if (text[i] === '\n' || text[i] === '\r') {
    u = 0;
    next = text[i] === '\r' && text[i + 1] === '\n' ? i + 2 : i + 1;
  } else if (text[i] === '\\') {
    let j = i;
    while (j < text.length && text[j] === '\\') j++;
    const r = j - i;
    if (text[j] !== 'n' && text[j] !== 'r') return -1;
    u = r & -r;
    if (r !== u) return -1; // a literal backslash on the BEGIN line: not a key line
    ({ next } = nextLine(text, i, u));
  } else return -1;
  let longs = 0;
  let longest = 0;
  let first = '';
  let end = -1;
  if (rest) {
    // A key pasted onto its BEGIN line: every chunk but the last is a full 16+ line. Words there
    // are prose, even one of 16+ letters (v6.19.2 pre-tag defect review F9). A loop, not a spread:
    // Math.max(...chunks) overflowed the stack past ~125k chunks (F2).
    if (!B64_CHUNKS_RE.test(rest)) return -1;
    const chunks = rest.split(/[ \t]+/);
    for (let k = 0; k < chunks.length; k++) {
      if (k < chunks.length - 1 && chunks[k].length < 16) return -1;
      if (chunks[k].length > longest) longest = chunks[k].length;
    }
    if (longest < 16) return -1;
    longs = 1;
    first = chunks[0];
    end = be + text.slice(be, i).trimEnd().length;
  }
  // The BEGIN line's prefix.
  let ls = b;
  while (ls > 0) {
    const ch = text[ls - 1];
    if (ch === '\n' || ch === '\r') break;
    if (u > 0 && (ch === 'n' || ch === 'r') && isEscBreak(backslashesBefore(text, ls - 1, 0), u)) break;
    if (u > 0 && (ch === '"' || ch === "'") && isStringEnd(backslashesBefore(text, ls - 1, 0), u)) break;
    ls--;
  }
  // A 16+ base64 run glued to the BEGIN is the previous key's cut line, not a line prefix: taken
  // for one, it stripped this key's identical body line and one copy of a repeated cut key went
  // per pass (v6.19.2 pre-tag round-5 review F2).
  let run = 0;
  while (run < 16 && b - run > ls && isB64Code(text.charCodeAt(b - run - 1))) run++;
  const shape = run >= 16 ? null : prefixShape(text.slice(ls, b));

  let armors = 0;
  let shorts = 0;
  let pendingBlank = false;
  while (next !== -1) {
    // Another BEGIN line is never part of this key; stop before reading it whole.
    if (!shape && text.startsWith('-----BEGIN ', next)) break;
    const line = nextLine(text, next, u);
    const { core, start, end: coreEnd } = lineCore(text, next, line.end, shape);
    const kind = classify(core);
    next = line.next;
    if (kind === END) {
      if (longs > 0) end = start + KEY_END_LINE_RE.exec(core)[0].length;
      break;
    }
    if (kind === BLANK) {
      if (shorts > 0) break;
      pendingBlank = true;
      continue;
    }
    if (longs === 0) {
      if (kind === ARMOR && ++armors <= MAX_ARMOR_HEADERS) continue;
      if (kind !== LONG && kind !== CUT) break;
    }
    if (kind === LONG && shorts === 0) {
      if (longs++ === 0) first = core;
      longest = Math.max(longest, core.length);
      end = coreEnd;
      pendingBlank = false;
      continue;
    }
    // A cut line ends the key whatever came before it, blank lines included: a PGP or encrypted
    // key has one before its body, and `head` of it in a JSON string ends in a cut line (round-4
    // F1: checked after the blank-line stop, it was never read and the whole key was stored).
    if (kind === CUT && shorts === 0) {
      const run = cutRun(core);
      if (longs++ === 0) first = run;
      longest = Math.max(longest, run.length);
      end = start + run.length;
      break;
    }
    if (pendingBlank) break;
    if (kind === SHORT && (shorts === 0 || (shorts === 1 && PGP_CRC_RE.test(core)))) {
      shorts++;
      end = coreEnd;
      continue;
    }
    break;
  }
  if (longs === 0) return -1;
  const magic = KEY_MAGIC_RE.test(first) || (text.slice(b, be).includes('PGP') && PGP_MAGIC_RE.test(first));
  return longs >= 2 || armors > 0 || longest >= 40 || magic ? end : -1;
}

function scrubCutOffKeys(text) {
  if (!text.includes('PRIVATE KEY')) return text;
  KEY_BEGIN_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = KEY_BEGIN_RE.exec(text))) {
    const end = cutOffKeyEnd(text, m.index, m.index + m[0].length);
    if (end === -1) continue;
    out += text.slice(last, m.index) + PEM_MARK;
    last = end;
    KEY_BEGIN_RE.lastIndex = end;
  }
  return last === 0 ? text : out + text.slice(last);
}

/**
 * The span [start, end) of the key tail that ends with the END at [e, ee), or null: whole base64
 * lines of 16+ characters directly above it, with one shorter line before the END, or two when the
 * one before the END is a PGP `=XXXX` checksum (delta review P2; two short words above an END are
 * prose, round-3 P3-D). The span takes the END too, unless words precede the END on its line (a
 * sentence naming it): then the lines above go and the sentence stays (F7). `floor` is the end of
 * the previous END, so no line is read twice.
 */
function keyTailSpan(text, e, ee, floor) {
  let ls = e;
  let u = 0;
  while (ls > floor) {
    const ch = text[ls - 1];
    if (ch === '\n' || ch === '\r') break;
    if (ch === 'n' || ch === 'r') {
      const r = backslashesBefore(text, ls - 1, floor);
      if (r > 0) {
        u = r & -r;
        break;
      }
    }
    ls--;
  }
  let longs = 0;
  let shorts = 0;
  let crc = false;
  let top = -1;
  let topCore = '';
  let longest = 0;
  let bottom = -1;
  const take = (core, start, end) => {
    if (!accept(core, start)) return false;
    if (bottom === -1) bottom = end;
    return true;
  };
  const accept = (core, start) => {
    const kind = classify(core);
    if (kind === LONG) {
      longs++;
      top = start;
      topCore = core;
      if (core.length > longest) longest = core.length;
      return true;
    }
    if (longs > 0 || kind !== SHORT) return false;
    if (shorts === 0) {
      shorts = 1;
      crc = PGP_CRC_RE.test(core);
      return true;
    }
    if (shorts === 1 && crc) {
      shorts = 2;
      return true;
    }
    return false;
  };
  // The END line's own prefix: a line prefix, the key's last base64 run glued to the END, or words.
  // Words with spaces are a line prefix when the line above starts the same way (`web-1  | `, a
  // syslog stamp, `> > `; v6.19.2 pre-tag delta review F2), and a sentence naming the END if not.
  const prefix = text.slice(ls, e);
  const trimmed = prefix.trim();
  let shape = null;
  let sentence = false;
  let prefixed = false;
  if (/^[ \t]*[A-Za-z0-9+/=]+$/.test(prefix)) {
    const at = ls + prefix.indexOf(trimmed);
    if (!take(trimmed, at, at + trimmed.length)) return null;
  } else {
    shape = prefixShape(prefix);
    const above = shape && prevLine(text, ls, u, floor);
    prefixed = Boolean(above && shape.test(text.slice(above.start, above.end)));
    if (/\S\s+\S/.test(trimmed) && !prefixed) {
      sentence = true;
      shape = null;
    }
  }
  // An END alone on its line (after nothing but a line prefix, before nothing but a quote,
  // punctuation or a closing tag) is evidence enough for one line over it that has a digit, a `+`
  // or `=` padding: `tail -n 2` of a key whose last line is 16-39 characters (delta F3). A 16+
  // run of random base64 almost always has one; a camelCase identifier or a path has none
  // (round-3 F3). An END in a sentence or in inline code followed by words is not alone.
  CLEAN_AFTER_END_RE.lastIndex = ee;
  const clean = !sentence && (trimmed === '' || prefixed) && CLEAN_AFTER_END_RE.test(text);
  let cur = ls;
  for (let line; (line = prevLine(text, cur, u, floor)); cur = line.start) {
    const { core, start, end } = lineCore(text, line.start, line.end, shape);
    if (!take(core, start, end)) break;
  }
  // Otherwise the same evidence a cut-off key needs: one base64 line alone is a key tail only when
  // it is 40+ characters, starts like a key encoding or sits over a PGP checksum; an identifier of
  // 16-39 characters over an END named in prose is not (F7).
  if (longs === 0) return null;
  const b64ish = /[0-9+]|=$/.test(topCore);
  if (!(longs >= 2 || longest >= 40 || crc || (clean && b64ish) || KEY_MAGIC_RE.test(topCore))) return null;
  return [top, sentence ? bottom : ee];
}

function scrubKeyTails(text) {
  if (!text.includes('PRIVATE KEY')) return text;
  KEY_END_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let floor = 0;
  let m;
  while ((m = KEY_END_RE.exec(text))) {
    const span = keyTailSpan(text, m.index, m.index + m[0].length, Math.max(floor, last));
    if (span) {
      out += text.slice(last, span[0]) + PEM_MARK;
      last = span[1];
    }
    floor = m.index + m[0].length;
  }
  return last === 0 ? text : out + text.slice(last);
}

/**
 * Scrub known secret patterns (API keys, tokens, credentials) from text.
 * Also strips user-marked `<private>...</private>` blocks first, so every
 * persistence/log path that scrubs secrets inherits the `<private>` opt-out —
 * previously stripPrivate ran only on the user-prompt hook, not on writes.
 * @param {string} text Input text potentially containing secrets
 * @returns {string} Text with secrets replaced by '***'
 */
// ── D#52 / D#46: one sweep is not a fixed point ─────────────────────────────
// Three patterns carry the prose lookbehind `(?<![A-Za-z][ \t])` — "preceded by
// letter + horizontal space means English prose, leave it alone". That guard is
// load-bearing (#8283 / round-4 / R5): `the token: alicebob` stays readable only
// because of it, while `token: alicebob` is scrubbed. (Not `alice` — five characters
// is under the value class's minimum of six, so that phrase is never scrubbed at all
// and cannot show the guard doing anything.)
// But a /g match CONSUMES its value, so the NEXT labelled keyword on the same
// line is preceded by that value's last character plus a space. The lookbehind
// cannot tell that from a word, so it skipped it: `token: <v> secret: <v>` left
// the SECOND secret in plaintext. Replacing the first one rewrites that left
// context to `*** `, and `*` is not [A-Za-z], which is why a second sweep caught
// what the first missed — the same fact D#46 reported as non-idempotence.
// The leak and the drift are one defect, and a fixed point closes both; the
// idempotence is what cmdRestore's re-scrub of five EXPORT_COLUMNS needed.
//
// Cost is unchanged on real content: the loop's FIRST iteration is the sweep
// that used to be the whole function, and text the scrubber does not modify
// exits on the `===` right after it. Measured 2026-09-22 on the live corpus:
// of the 287 NON-EMPTY values across text/subtitle/concepts/facts/search_aliases,
// 0 are modified at all, so the common path pays one string comparison. (A first
// draft of this line said "0 of 452"; 452 was the NOT-NULL count, ~39% of which
// are empty strings that nothing could modify — the zero was true and the
// denominator was not the population.)
//
// TERMINATION IS THE CAP, and saying anything stronger would be a guess. A first
// draft of this comment argued it structurally — "`***` is 3 characters and every
// value class requires at least 6, so a replacement can never become a new match".
// Pre-ship review measured that and it is FALSE of six patterns whose value class
// is `+` or `*`; two of them (the PEM block and the `postgres://` DSN) demonstrably
// re-match their own `***` output. Convergence is fast in practice — 7 sweeps was
// the maximum over 40 000 fuzzed inputs — but the only thing that BOUNDS this loop
// is MAX_SCRUB_PASSES, so that is what the comment is allowed to claim.
//
// Convergence rate, stated with the shape it is a property of: N space-adjacent
// secrets take N+1 sweeps only when each value ends in an ASCII LETTER, because
// that is what re-arms the prose lookbehind for the next keyword. A value ending
// in a digit does not re-arm it, so those converge in 2 regardless of N.
//
// Hitting the cap leaves labelled secrets unscrubbed past the 32nd, and that is
// the deliberate choice. The earlier draft instead re-ran the three prose-guarded
// patterns with the guard STRIPPED — which clears the remainder, and also applies
// to the whole string rather than the un-converged region, so prose elsewhere in
// the same input is redacted irreversibly on the write path. Pre-ship review
// reproduced it: a 33-deep chain turned `Reset the password: instructions are in
// the onboarding doc` into `Reset the password: *** are in…`, which is verbatim
// the v3.61.0 regression lines 44-50 of this file record as already undone once.
// Past the cap the function is also no longer idempotent — the property cmdRestore's
// re-scrub relies on holds only below it — and a second call scrubs further, which
// is the safe direction.
// Reaching the cap needs a deliberately constructed ~447-byte adjacent chain;
// corrupting prose needs only to be in the same string as one. Between a partial
// scrub of a crafted credential dump and irreversible damage to a user's text,
// this repo has twice decided the text matters more.
const MAX_SCRUB_PASSES = 32;

export function scrubSecrets(text) {
  if (!text || typeof text !== 'string') return text || '';
  let result = stripPrivate(text);
  for (let pass = 1; ; pass++) {
    const before = result;
    for (const [pattern, replacement] of SECRET_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    if (result === before || pass >= MAX_SCRUB_PASSES) break;
  }
  return result;
}
