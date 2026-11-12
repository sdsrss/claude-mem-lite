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
  //
  // A KEY'S BEGIN IS NOT A VALUE (D#657). These patterns run before the private key ones below, and
  // a value took the `-----BEGIN` of a key written right after its label (`PRIVATE_KEY=-----BEGIN …`,
  // or `private_key = <<EOT\n-----BEGIN …` in a JSON string, where the escaped break is no space):
  // the key passes then saw no BEGIN and stored every line of a cut-off key. So a value stops before a
  // private key's BEGIN, and the label patterns' values also before `***PEM_KEY***`, or the next pass
  // took that mark and the lines after it up to a space (6.30.11 kept them: it erased such a key from
  // its END).
  // The `--password` flag stops at the BEGIN only: with the mark stop as well, a line that the reading
  // of a cut-off key left after its mark, which the flag's value on the next pass erased in 6.30.11,
  // was kept.
  // A quoted value is left to the key passes when it holds the BEGIN line and nothing else (`'…-----\n'
  // +`: a key concatenated one string per line, Node's util.inspect of an object); a whole key printed
  // that way was stored when the text was in a JSON string. A quoted value with more of the
  // key in it is erased to its closing quote as before: the key passes miss some of what that erases
  // (a first body line cut inside its first 40 characters).
  //
  // A VALUE ON A LATER LINE (D#683). The whitespace after a separator may run onto the next lines, so a
  // value written below its label is still erased (`password:` then `  <v>`; prettier's `const X =` then
  // `  "<v>";`), but not when that line opens with a label of its own (`NAME: v`, `NAME=v`, `"name":`).
  // A label with an empty value (`POSTGRES_PASSWORD:` in a compose file, `password =` in an INI section)
  // took the next line's label as its value, and that line's value was stored. Such a line is now read
  // as it would be on its own; text with no line break between a separator and its value scrubs exactly
  // as before. A name over 64 characters is not taken for a label, so the check reads a bounded prefix
  // of the line. The quoted-value, JSON-key and env-name patterns below carry the same rule.
  //   1a. `=` assignment → ALWAYS scrub (config syntax, never prose):
  [
    /((?:\b|_)(?:password|passwd|passphrase|token|bearer|secret)(?:[*_~`]{1,3})?\s*=(?:[*_~]{1,2}(?=\s))?(?:[^\S\r\n]*|[^\S\r\n]*[\r\n]\s*(?![*~`]{0,3}[\w.-]{1,64}[*~`]{0,3}[^\S\r\n]*(?:[=：](?!=)|:(?=[\s'"]))[^\S\r\n]*\S)))(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)(?:(?!-----BEGIN [A-Z0-9 ]*PRIVATE KEY|\*\*\*PEM_KEY\*\*\*)[^\s,;'"}\]]){6,}/gi,
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
    /((?:(?<![A-Za-z][ \t][*_~]{0,3})(?:\b|_)(?:password|passwd|passphrase)(?:[*_~]{1,3})?|(?=_?(?:password|passwd|passphrase)`)(?<![A-Za-z][ \t]`[\w-]{0,40})(?<=`[\w-]{0,40})(?:\b|_)(?:password|passwd|passphrase)`)\s*[:：](?:[*_~]{1,2}(?=\s))?(?:[^\S\r\n]*|[^\S\r\n]*[\r\n]\s*(?![*~`]{0,3}[\w.-]{1,64}[*~`]{0,3}[^\S\r\n]*(?:[=：](?!=)|:(?=[\s'"]))[^\S\r\n]*\S)))(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)(?:(?!-----BEGIN [A-Z0-9 ]*PRIVATE KEY|\*\*\*PEM_KEY\*\*\*)[^\s,;'"}\]]){6,}/gi,
    '$1***',
  ],
  [
    /((?:\b|_)(?:password|passwd|passphrase)(?:[*_~`]{1,3})?\s*[:：](?:[*_~]{1,2}(?=\s))?(?:[^\S\r\n]*|[^\S\r\n]*[\r\n]\s*(?![*~`]{0,3}[\w.-]{1,64}[*~`]{0,3}[^\S\r\n]*(?:[=：](?!=)|:(?=[\s'"]))[^\S\r\n]*\S)))(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)(?![A-Za-z]{1,15}(?=[`*~]*(?:[\s,;'"}\]]|$)))(?:(?!-----BEGIN [A-Z0-9 ]*PRIVATE KEY|\*\*\*PEM_KEY\*\*\*)[^\s,;'"}\]]){6,}/gi,
    '$1***',
  ],
  //   1c. `:` separator, prose-ambiguous nouns → keep the lookbehind ("the token: alicebob"):
  [
    /((?:(?<![A-Za-z][ \t][*_~]{0,3})(?:\b|_)(?:token|bearer|secret)(?:[*_~]{1,3})?|(?=_?(?:token|bearer|secret)`)(?<![A-Za-z][ \t]`[\w-]{0,40})(?<=`[\w-]{0,40})(?:\b|_)(?:token|bearer|secret)`)\s*[:：](?:[*_~]{1,2}(?=\s))?(?:[^\S\r\n]*|[^\S\r\n]*[\r\n]\s*(?![*~`]{0,3}[\w.-]{1,64}[*~`]{0,3}[^\S\r\n]*(?:[=：](?!=)|:(?=[\s'"]))[^\S\r\n]*\S)))(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)(?:(?!-----BEGIN [A-Z0-9 ]*PRIVATE KEY|\*\*\*PEM_KEY\*\*\*)[^\s,;'"}\]]){6,}/gi,
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
    /((?:\b|_)(?:api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|pgpassword|pgpass|mysql_pwd)(?:[*_~`]{1,3})?\s*[=:：](?:[*_~]{1,2}(?=\s))?(?:[^\S\r\n]*|[^\S\r\n]*[\r\n]\s*(?![*~`]{0,3}[\w.-]{1,64}[*~`]{0,3}[^\S\r\n]*(?:[=：](?!=)|:(?=[\s'"]))[^\S\r\n]*\S)))(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)(?:(?!-----BEGIN [A-Z0-9 ]*PRIVATE KEY|\*\*\*PEM_KEY\*\*\*)[^\s,;'"}\]]){6,}/gi,
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
  [
    /(--(?:password|passwd|token|api[-_]?key|secret)[=\s]+)(?!-)(?:(?!-----BEGIN [A-Z0-9 ]*PRIVATE KEY)[^\s'"]){6,}/gi,
    '$1***',
  ],
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
    /((?:\b|_)(?:password|passwd|passphrase|token|bearer|secret)(?:[*_~`]{1,3})?\s*=(?:[*_~]{1,2}(?=\s))?(?:[^\S\r\n]*|[^\S\r\n]*[\r\n]\s*(?!(?:"[^"\r\n]*"|'[^'\r\n]*')[^\S\r\n]*[:=：])))(['"])(?!-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:\\+[nr])*\2)[^'"]{6,}\2/gi,
    '$1$2***$2',
  ],
  [
    /((?:\b|_)(?:password|passwd|passphrase)(?:[*_~`]{1,3})?\s*[:：](?:[*_~]{1,2}(?=\s))?(?:[^\S\r\n]*|[^\S\r\n]*[\r\n]\s*(?!(?:"[^"\r\n]*"|'[^'\r\n]*')[^\S\r\n]*[:=：])))(['"])(?!-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:\\+[nr])*\2)[^'"]{6,}\2/gi,
    '$1$2***$2',
  ],
  [
    /((?:(?<![A-Za-z][ \t][*_~]{0,3})(?:\b|_)(?:token|bearer|secret)(?:[*_~]{1,3})?|(?=_?(?:token|bearer|secret)`)(?<![A-Za-z][ \t]`[\w-]{0,40})(?<=`[\w-]{0,40})(?:\b|_)(?:token|bearer|secret)`)\s*[:：](?:[*_~]{1,2}(?=\s))?(?:[^\S\r\n]*|[^\S\r\n]*[\r\n]\s*(?!(?:"[^"\r\n]*"|'[^'\r\n]*')[^\S\r\n]*[:=：])))(['"])(?!-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:\\+[nr])*\2)[^'"]{6,}\2/gi,
    '$1$2***$2',
  ],
  //   (b) structured keys + named env vars are unambiguous config even after a word
  //       (`see api_key: "x"` DOES scrub, mirroring the unquoted structured-key path):
  [
    /((?:\b|_)(?:pgpassword|pgpass|mysql_pwd|api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token)(?:[*_~`]{1,3})?\s*[=:：](?:[*_~]{1,2}(?=\s))?(?:[^\S\r\n]*|[^\S\r\n]*[\r\n]\s*(?!(?:"[^"\r\n]*"|'[^'\r\n]*')[^\S\r\n]*[:=：])))(['"])(?!-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:\\+[nr])*\2)[^'"]{6,}\2/gi,
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
  [
    /(['"](?:proxy-)?authorization['"]\s*:(?:[^\S\r\n]*|[^\S\r\n]*[\r\n]\s*(?!(?:"[^"\r\n]*"|'[^'\r\n]*')[^\S\r\n]*[:=：])))(['"])(?:(?:Bearer|Basic|token)\s+)?[^'"]{6,}\2/gi,
    '$1$2***$2',
  ],
  // R10 P1-6: Azure storage. AccountKey= is the account's master credential and sig= is a
  // live SAS token; neither had any pattern. `sig` is anchored to a URL query position
  // (`?`/`&`) rather than a word boundary — bare `\bsig=` eats `const sig=computeX(y)`.
  [/\b(AccountKey|SharedAccessSignature)=[^\s;&'"]{16,}/gi, '$1=***'],
  [/([?&]sig=)[^\s;&'"]{16,}/gi, '$1***'],
  // Supabase / generic long base64 keys (40+ chars, common in env vars)
  [
    /(\b(?:SUPABASE_KEY|SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|REDIS_URL)\s*[=:](?:[^\S\r\n]*|[^\S\r\n]*[\r\n]\s*(?![*~`]{0,3}[\w.-]{1,64}[*~`]{0,3}[^\S\r\n]*(?:[=：](?!=)|:(?=[\s'"]))[^\S\r\n]*\S)))[^\s,;'"}\]]+/gi,
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
  // D#812: fixed-prefix, fixed-body provider tokens. Shapes from gitleaks (config/gitleaks.toml
  // @ 5f6ec56c: huggingface-*, digitalocean-*, pypi-upload-token, shopify-*) and trufflehog
  // (pkg/detectors/groq). Each body is one character class, so a failing match is linear.
  [/\b(?:hf|api_org)_[a-zA-Z0-9]{34}(?![A-Za-z0-9])/g, '***'],
  [/\bdo[opr]_v1_[a-f0-9]{64}(?![A-Za-z0-9])/g, '***'],
  [/\bpypi-AgE[A-Za-z0-9_-]{50,}/g, '***'],
  [/\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}(?![A-Za-z0-9])/g, '***'],
  [/\bgsk_[a-zA-Z0-9]{52}(?![A-Za-z0-9])/g, '***'],
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
    /("(?:password|passwd|token|api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|access[_-]?token|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer|refresh[_-]?token|session[_-]?id|sessionid)"\s*:(?:[^\S\r\n]*|[^\S\r\n]*[\r\n]\s*(?!(?:"[^"\r\n]*"|'[^'\r\n]*')[^\S\r\n]*[:=：]))")[^"]{6,}(")/gi,
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
    /("\w{0,64}(?:password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\w{0,64}"\s*:(?:[^\S\r\n]*|[^\S\r\n]*[\r\n]\s*(?!(?:"[^"\r\n]*"|'[^'\r\n]*')[^\S\r\n]*[:=：]))")[^"]{6,}(")/gi,
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
    /(['"](?:\w{0,64}(?:password|passwd|passphrase|secret|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\w{0,64}|\w{1,64}_token)['"]\s*:(?:[^\S\r\n]*|[^\S\r\n]*[\r\n]\s*(?!(?:"[^"\r\n]*"|'[^'\r\n]*')[^\S\r\n]*[:=：])))(['"])[^'"]{6,}\2/gi,
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
const B64_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Whether base64 `s` starts the way a DER private key starts: a SEQUENCE holding an INTEGER 0 or 1
 * (PKCS#1, PKCS#8, SEC1, DSA) or a SEQUENCE and an OID (encrypted PKCS#8; a public key's
 * SubjectPublicKeyInfo starts that way too, so a public-key line under a PRIVATE KEY marker is
 * erased as well). The prefix list above missed keys whose DER header begins otherwise: secp256k1
 * `MHQC`, P-521 `MIHc`/`MIHu`, Ed448 `MEcC`, X448 `MEYC`, the 192/224-bit curves and others (D#504 F1).
 */
function isDerKeyStart(s) {
  if (s.length < 12) return false;
  const b = [];
  for (let i = 0; i < 12; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const v = B64_DIGITS.indexOf(s[i + k]);
      if (v < 0) return false;
      n = n * 64 + v;
    }
    b.push(n >> 16, (n >> 8) & 255, n & 255);
  }
  if (b[0] !== 0x30) return false;
  const o = b[1] < 0x80 ? 2 : b[1] <= 0x83 ? b[1] - 0x7e : -1;
  if (o < 0) return false;
  if (b[o] === 0x02 && b[o + 1] === 0x01 && b[o + 2] <= 1) return true;
  return b[o] === 0x30 && b[o + (b[o + 1] === 0x81 ? 3 : 2)] === 0x06;
}

const startsLikeKey = (s) => KEY_MAGIC_RE.test(s) || isDerKeyStart(s);
// RFC 1421 / RFC 4880 armor headers, before the body. Named, not any `Word:`: a `Note:` line is
// prose, and taking it for a header made the lone base64 line under it a key.
// RFC 1421's full set and tool-written `X-` headers count too (v6.19.2 pre-tag delta review F4:
// `Content-Domain` or `X-Custom` before the body stored the whole key).
const ARMOR_HEADER_RE =
  /^(?:Proc-Type|DEK-Info|Content-Domain|Originator-ID-(?:Asymmetric|Symmetric)|Originator-Certificate|Issuer-Certificate|MIC-Info|Key-Info|Recipient-ID-(?:Asymmetric|Symmetric)|CRL|Version|Comment|Hash|Charset|MessageID|X-[A-Za-z0-9-]+)[ \t]*:/i;
const MAX_ARMOR_HEADERS = 16;
// The blank line of a run from which readKeyLines asks its memo where the run ends.
const BLANK_MEMO_AFTER = 8;
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

// The characters an escaped line acts on: breaks and backslashes; every other character only moves
// it on. Steps past LINE_STEP_BUDGET of them are searched natively: a line that runs to the end of
// the text, read once per BEGIN at its depth and once per pass, was 94.6% of the time of the
// escape-depth shape (D#511). A line at depth 0 keeps the plain loop.
const ESC_LINE_STOP_RE = /[\n\r\\]/g;
const LINE_STEP_BUDGET = 32;

/** The line starting at s: its end, and where the next line starts (-1 at the end of the text). */
function nextLine(text, s, u) {
  if (u > 0) return nextEscapedLine(text, s, u);
  const n = text.length;
  for (let i = s; i < n; i++) {
    const ch = text[i];
    if (ch === '\n') return { end: i, next: i + 1 };
    if (ch === '\r') return { end: i, next: text[i + 1] === '\n' ? i + 2 : i + 1 };
  }
  return { end: n, next: -1 };
}

/** nextLine at break depth u > 0. */
function nextEscapedLine(text, s, u) {
  const n = text.length;
  let i = s;
  let lim = Math.min(n, s + LINE_STEP_BUDGET);
  for (;;) {
    while (i < lim) {
      const ch = text[i];
      if (ch === '\n') return { end: i, next: i + 1 };
      if (ch === '\r') return { end: i, next: text[i + 1] === '\n' ? i + 2 : i + 1 };
      if (ch === '\\') {
        let j = i;
        while (j < n && text[j] === '\\') j++;
        const r = j - i;
        const c = text[j];
        if ((c === 'n' || c === 'r') && isEscBreak(r, u)) {
          let next = j + 1;
          if (c === 'r' && text.startsWith('\\'.repeat(u) + 'n', next)) next += u + 1;
          // The pattern starts with a quote, so no other character can begin a match.
          if (u === 1 && (text[next] === '"' || text[next] === "'")) {
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
    if (i >= n) return { end: n, next: -1 };
    ESC_LINE_STOP_RE.lastIndex = i;
    if (!ESC_LINE_STOP_RE.test(text)) return { end: n, next: -1 };
    i = ESC_LINE_STOP_RE.lastIndex - 1;
    lim = Math.min(n, i + LINE_STEP_BUDGET);
  }
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

// D#168: the line prefix grammars a BEGIN line can carry with code after them, before the BEGIN:
// a Read column (`     5\t`, `5→`), a diff mark, a quote, a grep column (`path:5:`, `path:`),
// after at most one string opener (`'+`, `b'+`, `'''+`). Named forms only, not "what the next line
// shares with this one": that reading took `//`, `#` and a bare `>` for prefixes and was withdrawn
// from 6.19.4 for the prose it erased and the keys it let through on a later pass. The diff mark
// comes before the grep forms, so `-key: '''` is a diff line, not a grep path `-key:`. In escaped
// text a tab is `\t` and a quote may be `\"`.
const PREFIX_GRAMMAR_RE =
  /^[ \t]*(?:[rRbBuUfF]{0,2}(?:\\*['"`]){1,3})?([ \t]*\d+(?:\t|\\+t)|\d+→|[-+]|(?:>[ \t]?)+|[^\s'"`:\\]+[:-]\d+[:-]|[^\s'"`:\\]+:)/;
// D#614 A2: a grep column after any path, up to the line's last `:N:` or `-N-` (a number past the path
// is the grep's; one inside code before the BEGIN is rare): a backslash, a space, a drive letter or
// another colon, a quote or a backtick in the path, or a leading `-`, `+` or `>`, which the grammar
// above reads as a diff mark or a quote.
const GREP_ANY_PATH_RE = /^[ \t]*(\S.*(?::\d+:|-\d+-))/;
// A grammar is a few characters; testing more of a long left context costs a pass over it per BEGIN.
const PREFIX_GRAMMAR_SCAN = 256;
// How far escaped text is searched back for the start of a BEGIN's line past single quotes (D#614 A3).
// It was PREFIX_GRAMMAR_SCAN, and a code line of more than 256 characters before its last quote
// (keyword arguments, a dict literal) left no grammar, so the key under it was stored. Not unbounded:
// the walks of BEGINs at one escape depth never overlap (each BEGIN's break ends the next one's
// walk), but those at different depths cross the same run, judging each quote or backslash in it.
// One BEGIN per depth (1, 2, 4, 8) after 150k characters of escaped quotes read 18x benign under
// coverage unbounded, 1.2x at this bound.
const LINE_START_SCAN = 4096;
// From a position back over the characters that cannot end a line in escaped text: anything but a
// break, a double quote or a backslash. A lookbehind is matched backward, so this runs natively.
const LINE_BACK_RE = /(?<=([^\n\r"\\]*))/y;
// A key line (LONG or CUT) starts with a run of 16+ of these, so a stretch without one holds none.
const B64_RUN16_RE = /[A-Za-z0-9+/=]{16}/;
// The longest gap the D#168 skip tests; past it the reading runs.
const SKIP_GAP_SCAN = 4096;

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

const isTagNameCode = (c) =>
  (c >= 65 && c <= 90) ||
  (c >= 97 && c <= 122) ||
  (c >= 48 && c <= 57) ||
  c === 95 ||
  c === 58 ||
  c === 46 ||
  c === 45;

/**
 * The length of a closing tag `</name>` (a letter, then up to 40 of `[\w:.-]`) that ends `line` at
 * q, starting at a or after; 0 when there is none. `/<\/[A-Za-z][\w:.-]{0,40}>$/` on
 * `line.slice(a, q)`, read from its end: the name is the run of name characters before the `>`,
 * since a `/` cannot be one of them.
 */
function closingTagLength(line, a, q) {
  if (line[q - 1] !== '>') return 0;
  let r = q - 1;
  while (r > a && q - 1 - r <= 41 && isTagNameCode(line.charCodeAt(r - 1))) r--;
  const len = q - 1 - r;
  if (len < 1 || len > 41 || r - 2 < a || line[r - 1] !== '/' || line[r - 2] !== '<') return 0;
  const c = line.charCodeAt(r);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? q - (r - 2) : 0;
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
  const tag = q > a ? closingTagLength(line, a, q) : 0;
  if (tag) b = q - tag;
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
function cutOffKeyEnd(text, b, be, ctx) {
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
  const left = text.slice(ls, b);
  const shape = run >= 16 ? null : ctx.shapeOf(left);
  // The first character of the prefix after its spaces and tabs: a shape's match can only start a
  // line whose first character after spaces and tabs is this one (a digit, `:` and `-` stand for
  // more, and none of them begins a blank line below).
  let pl = ls;
  while (pl < b && (text.charCodeAt(pl) === 32 || text.charCodeAt(pl) === 9)) pl++;
  const shapeLead = shape ? text.charCodeAt(pl) : -1;
  const label = text.slice(b, be);
  const read = readKeyLines(text, next, u, shape, shapeLead, longs, longest, first, end, ctx.memoOf);
  const found = read.longs > 0 && keyEvidence(read, label, true) ? read.end : -1;
  // The lines below read again with the shape of `prefix`, whose first character after blanks is
  // `lead`: the reading of the key they hold, or null. `accept`: a further test of that reading.
  const reread = (prefix, lead, accept = null) => {
    const alt = ctx.shapeOf(prefix);
    if (!alt || ctx.endFollows(be)) return null;
    const again = readKeyLines(text, next, u, alt, lead, longs, longest, first, end, ctx.memoOf);
    if (!(again.longs > 0 && again.end > found && keyEvidence(again, label, false))) return null;
    if (accept && !accept(again)) return null;
    ctx.reread = true;
    return again;
  };
  // The lines under a diff context BEGIN (D#614 A1, D#641) read with a diff mark's shape, which takes
  // context lines too: where the key ends, or -1. Only when the lines it takes include a removed or
  // added one: Read output starts its lines with spaces as well, and a reading there took the next
  // line's number for a key's short last line. A removed key that ends with its short last line (or a
  // PGP checksum) is followed by the added key's lines, which the reading stopped at: they are read
  // on, as lines of the same key.
  // What D#641 added (a reading of a BEGIN whose next line has no mark, `admitted` false, and the added
  // key's lines) never spans another private-key BEGIN, which no key in a real diff holds: a header line
  // holding one, swallowed by the span, started no reading of its own on a later pass, where it read on
  // over the first pass's ***PEM_KEY*** line and erased a cut line after it (6 of 400,000 r3mix texts).
  // And what D#641 added reads only inside a unified diff's hunk (ctx.inHunk, from the BEGIN's line
  // start `gl`): an indented cut key in prose read the dash list under it as removed and added key
  // lines, losing it (6.30.10 pre-tag r1 F2).
  const diffRead = (admitted, gl) => {
    // Such a reading ends before the next BEGIN and takes a marked line, so with no marked line before
    // that BEGIN there is none to read (header BEGINs over context lines read the same run again each).
    if (!admitted && !(ctx.inHunk(gl, u) && markedLineIn(text, next, ctx.nextBegin(next), u))) return -1;
    let r = reread(
      '-',
      45,
      (a) => (admitted || ctx.nextBegin(next) >= a.end) && markedLineIn(text, next, a.end, u),
    );
    if (!r) return -1;
    const alt = ctx.shapeOf('-');
    for (;;) {
      const n = r.shorts > 0 ? nextLine(text, r.end, u).next : -1;
      if (n === -1 || (text[n] !== '-' && text[n] !== '+') || !ctx.inHunk(gl, u)) return r.end;
      const again = readKeyLines(text, n, u, alt, 45, 0, 0, '', -1, ctx.memoOf);
      if (again.longs === 0 || ctx.nextBegin(n) < again.end) return r.end;
      r = again;
    }
  };
  // D#168: code between the line prefix and the BEGIN (`-KEY = '''`, `     5\tKEY = """`) or a
  // string opener before it (`'+`, `"-`) made the whole left context the shape, which no line below
  // starts with, so nothing past the BEGIN line was read and a cut key was stored. Read again with
  // the prefix grammar alone, only when the reading above took nothing below the BEGIN line (its
  // output is unchanged otherwise), and only on stronger evidence than that reading's: two prefixed
  // identifiers under a BEGIN in a diff are a list, not a key. Not when an END follows before the
  // next BEGIN: that is a whole block the block pattern did not take on this pass (a partial BEGIN
  // inside it), which it takes whole once the blocker goes; a ***PEM_KEY*** over its BEGIN would
  // keep every line after the first one that is not base64 (v6.19.4 round-2 F1).
  if (run < 16 && (found === -1 || found <= i)) {
    // Skipped only when it cannot find a key line, never cut short: a read limit at the next header
    // BEGIN stored keys twice (D#169), since a quoted or unclosed BEGIN starts no reading of its own.
    // With no key on the BEGIN line, the first line the reading counts is a key line, which starts
    // with a 16+ base64 run, after blank lines and armor headers only, and a header has a colon. A
    // line holding a private-key BEGIN is neither blank nor a key line (its core holds that text, or
    // starts one `-` into it, and `BEGIN ` ends any run), and no header name holds one (names have
    // no space, the BEGIN has one after `BEGIN`): a header line holding one has its colon before it.
    // So with no run and no colon before the next one (or the end) the reading stops on its line at
    // the latest. Not any `-----BEGIN `: `X-----BEGIN : v` is a header whose name swallows it, read
    // through, and ending the gap there stored the key below it (D#607 F5). Reading every short
    // BEGIN block again (`'+-----BEGIN …` over a bare `+`, 5,400 per pass) took that shape from
    // 4.7x to 10.1x benign under coverage, past the linearity budget on CI.
    // Only over a short gap, since the skip saves a reading and the reading is the answer: with no
    // private-key BEGIN below, the gap is the rest of the text, and testing it on each pass took
    // pemHeaderThenCerts from 75 to 142 ms where the reading stops on its first line.
    if (longs === 0 && next === -1) return found;
    if (longs === 0) {
      const to = ctx.nextBegin(next);
      if (to - next <= SKIP_GAP_SCAN) {
        const gap = text.slice(next, to);
        if (!B64_RUN16_RE.test(gap) && !gap.includes(':')) return found;
      }
    }
    const gl = lineStartPastQuotes(text, ls, u);
    const head = gl === -1 ? '' : text.slice(gl, Math.min(b, gl + PREFIX_GRAMMAR_SCAN));
    const g = gl === -1 ? null : PREFIX_GRAMMAR_RE.exec(head);
    const gs = g ? gl + g[0].length - g[1].length : -1;
    let gp = gl;
    while (gp < b && (text.charCodeAt(gp) === 32 || text.charCodeAt(gp) === 9)) gp++;
    // Only when the line is more than its grammar before the BEGIN: an opener before it or code after it.
    if (g && !(gs === gp && gl + g[0].length === b)) {
      let lead = gs;
      while (text.charCodeAt(lead) === 32 || text.charCodeAt(lead) === 9) lead++;
      const r = reread(g[1], text.charCodeAt(lead));
      if (r) return r.end;
    }
    // D#614 A2: a grep column after a path the grammar refuses; not the column the grammar read
    // already, nor the first reading's own prefix. That prefix is the column whenever nothing stands
    // between it and the BEGIN, except in escaped text after a quote in the path (`it's/`), where the
    // prefix starts past the quote.
    const p = gl === -1 ? null : GREP_ANY_PATH_RE.exec(head);
    if (p && !(g && g[1] === p[1]) && p[1] !== left.replace(/^[ \t]+/, '')) {
      const r = reread(p[1], text.charCodeAt(gl + p[0].length - p[1].length));
      if (r) return r.end;
    }
    // D#614 A1: a unified diff's context line starts with its space, with code after it or none, and
    // the removed and added lines below it with `-` and `+`, which the line prefix (that space, or the
    // code) never matched.
    if (gl !== -1 && isDiffContextLine(text, gl, b)) {
      const r = diffRead(text[next] === '-' || text[next] === '+', gl);
      if (r !== -1) return r;
    }
  } else if (run < 16) {
    // D#641: in a real diff the lines under a context BEGIN can be context lines too: an OpenSSH key's
    // first body line is the same for every key of its type. The reading above took them for the key
    // and stopped at the first removed line, so the removed and added lines were stored.
    const after = nextLine(text, found, u).next;
    if (after !== -1 && (text[after] === '-' || text[after] === '+')) {
      const gl = lineStartPastQuotes(text, ls, u);
      if (gl !== -1 && isDiffContextLine(text, gl, b)) {
        const r = diffRead(false, gl);
        if (r !== -1) return r;
      }
    }
  }
  return found;
}

/**
 * Whether the line from `gl` to the BEGIN at `b` is a unified diff's context line: led by its space,
 * with code after it or none. Not when the line holds an escaped break of another depth: it is then
 * several lines, the first one led by a space.
 */
function isDiffContextLine(text, gl, b) {
  return text.charCodeAt(gl) === 32 && !/\\[nr]/.test(text.slice(gl, b));
}

// A unified diff's hunk header and the counts of old and new lines under it (1 when left out).
const HUNK_HEADER_RE = /@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/g;

/**
 * Whether a line starts at `at` at break depth u: the text's start, a break (at an escape depth not a
 * real one right after a backslash, which nextEscapedLine steps over), or the quote that opens a string
 * at that depth (`"patch":"@@ …` in JSON, where the line is the string's first).
 */
function startsLineAt(text, at, u) {
  if (at === 0) return true;
  const c = text[at - 1];
  if (c === '\n' || c === '\r') return u === 0 || text[at - 2] !== '\\';
  if (c === 'n' || c === 'r') return isEscBreak(backslashesBefore(text, at - 1, 0), u);
  return (c === '"' || c === "'") && isStringEnd(backslashesBefore(text, at - 1, 0), u);
}

// A break at an escape depth, found natively: a backslash run then `n` or `r` (its length decides the
// depth), or a real break not right after a backslash (nextEscapedLine steps over the character after a
// run). The lookbehinds start a match at a run's first backslash only, so each run is read once.
const ESC_BREAK_TOKEN_RE = /(?<!\\)\\+[nr]|(?<!\\)[\n\r]/g;
const BREAK_RE = /[\n\r]/g;

/**
 * nextLine from a line start `s`, its break found natively. A hunk's lines are read at the depth asked,
 * and in text at several depths a line runs across the others' text: nextEscapedLine stopped at each
 * backslash in it, 33% of the time of hunks at four depths in turn under coverage.
 */
function hunkNextLine(text, s, u) {
  const re = u === 0 ? BREAK_RE : ESC_BREAK_TOKEN_RE;
  re.lastIndex = s;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const r = m[0].length - 1;
    if (r === 0 || isEscBreak(r, u)) return nextLine(text, m.index, u);
  }
  return { end: text.length, next: -1 };
}

/**
 * Whether a line starting at `s` is in a unified diff's hunk at break depth u (D#649), from the headers
 * `heads` ({ at, old, add }, ascending). A hunk is the lines below a header that starts a line, as
 * nextLine reads them: a `-` line spends one of the old count, a `+` line one of the new, and a context
 * line (led by a space, or empty: git's diff.suppressBlankEmpty and GNU diff's --suppress-blank-empty
 * leave it so) one of each while both last; any other line ends it (`\ No newline at end of file` comes
 * after one side's last line, so no context line follows it). Only context lines are asked about (a
 * BEGIN's line led by a space), so once a count is spent nothing after it is in the hunk. A line's
 * question goes to the nearest header before it that starts a line at u; a header's text inside a line
 * (the diff of a file that holds one) starts no hunk. A hunk is read from its header only as far as the
 * line asked about, and on from there for a later one, so no line is read twice: reading each hunk
 * whole read the last line of every hunk at one depth across the text at the others, 14.7x benign under
 * coverage (hunks at four depths in turn, 3.9x on v6.30.10).
 */
function hunkReader(text, heads, u) {
  const own = heads.filter((h) => startsLineAt(text, h.at, u));
  const read = new Map();
  return (s) => {
    let lo = 0;
    let hi = own.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (own[mid].at < s) lo = mid + 1;
      else hi = mid;
    }
    const k = lo - 1;
    if (k < 0) return false;
    let h = read.get(k);
    if (h === undefined) {
      const { at, old, add } = own[k];
      read.set(k, (h = { next: hunkNextLine(text, at, u).next, old, add, starts: new Set() }));
    }
    // Never past the next header: it is at or after s (a later line's question goes to its hunk).
    while (h.next !== -1 && h.next <= s) {
      const at = h.next;
      const line = hunkNextLine(text, at, u);
      const c = line.end === at ? 32 : text.charCodeAt(at);
      if (c === 32 && h.old > 0 && h.add > 0) {
        h.old--;
        h.add--;
      } else if (c === 45) h.old--;
      else if (c === 43) h.add--;
      else {
        h.next = -1;
        break;
      }
      h.starts.add(at);
      h.next = line.next;
    }
    return h.starts.has(s);
  };
}

// A diff mark after a character that can end a line: a break, and at an escape depth an escaped
// break's letter or (one escape deep) the quote that reopens a string concatenated across lines.
const MARK_AFTER_BREAK_RE = /[\n\r][-+]/g;
const MARK_AFTER_ESC_RE = /[\n\r"'nr][-+]/g;

/**
 * Whether a line that starts in [from, to) at break depth u (`from` a line start) starts with a diff's
 * `-` or `+`. The marks are found natively and each is checked to start a line as nextLine reads them:
 * reading the lines one by one went through every line of a run under a BEGIN in Read output (each led
 * by a space) on each of the 32 passes a chain of labelled secrets takes, 42-57% of two linearity
 * shapes under coverage.
 */
function markedLineIn(text, from, to, u) {
  if (from === -1 || from >= to) return false;
  const c0 = text.charCodeAt(from);
  if (c0 === 45 || c0 === 43) return true;
  const re = u === 0 ? MARK_AFTER_BREAK_RE : MARK_AFTER_ESC_RE;
  const seg = to === Infinity ? text.slice(from) : text.slice(from, to);
  re.lastIndex = 0;
  for (let m = re.exec(seg); m; m = re.exec(seg)) {
    re.lastIndex = m.index + 1;
    const c = from + m.index;
    const ch = text.charCodeAt(c);
    // At an escape depth a real break right after a backslash run is that run's next character, which
    // nextEscapedLine steps over.
    if (ch === 10 || ch === 13) {
      if (u === 0 || text.charCodeAt(c - 1) !== 92) return true;
    } else if (ch === 110 || ch === 114) {
      if (isEscBreak(backslashesBefore(text, c, from), u)) return true;
    } else if (u === 1) {
      // The quote that opens the string after `\n" +` and a break: a line start when an escaped break
      // at depth 1 starts the concatenation (nextEscapedLine's CONCAT_AFTER_RE).
      if (opensConcat(text, c, from)) return true;
    }
  }
  return false;
}

/**
 * Whether the quote at `c` opens the string after a depth-1 escaped break, a quote, an optional `+` and a
 * break, so that a line starts after it: CONCAT_AFTER_RE (nextEscapedLine) read backward, within `from`.
 */
function opensConcat(text, c, from) {
  const blanks = (j) => {
    while (j >= from && (text[j] === ' ' || text[j] === '\t')) j--;
    return j;
  };
  let j = blanks(c - 1);
  if (j < from) return false;
  if (text[j] === '\n') j -= j - 1 >= from && text[j - 1] === '\r' ? 2 : 1;
  else if (text[j] === '\r') j--;
  else return false;
  j = blanks(j);
  if (j >= from && text[j] === '+') j = blanks(j - 1);
  if (j < from || (text[j] !== '"' && text[j] !== "'")) return false;
  j--;
  return j >= from && (text[j] === 'n' || text[j] === 'r') && isEscBreak(backslashesBefore(text, j, from), 1);
}

/**
 * Where the line that holds the BEGIN starts, from `ls`, the start cutOffKeyEnd's prefix walk found:
 * that, unless the walk stopped at a single quote in escaped text, or -1. The walk stops at an
 * unescaped single quote, which JSON never escapes (`-KEY = '''` in a JSON string leaves ''), so look
 * past single quotes for the start of the line: a break, or a double quote that ends a string at this
 * depth (the string the line is in), or the start of the text. At most LINE_START_SCAN characters
 * back; past that, -1.
 */
function lineStartPastQuotes(text, ls, u) {
  if (!(u > 0 && ls > 0 && text[ls - 1] === "'")) return ls;
  // Native between candidates: a character by character walk was most of the time of a shape that
  // repeats one 300-character line (pemEscapedLongCodeBeforeBegin), and now goes the whole line.
  const lim = Math.max(0, ls - LINE_START_SCAN);
  for (let j = ls - 1; ;) {
    LINE_BACK_RE.lastIndex = j;
    const k = j - LINE_BACK_RE.exec(text)[1].length;
    if (k === 0) return lim === 0 ? 0 : -1;
    // text[k - 1] is a break, a double quote or a backslash. A backslash run then `n` or `r` at k is
    // an escaped break at this depth when the run fits it; the line starts after that letter.
    const c = text.charCodeAt(k - 1);
    if (c === 92) {
      const e = text.charCodeAt(k);
      if (k + 1 < lim) return -1;
      if ((e === 110 || e === 114) && isEscBreak(backslashesBefore(text, k, 0), u)) return k + 1;
    } else if (k < lim) return -1;
    else if (c === 10 || c === 13 || isStringEnd(backslashesBefore(text, k - 1, 0), u)) return k;
    j = k - 1;
  }
}

/**
 * Whether a reading is a key: one base64 line of 40+ characters or a start the way a key encoding
 * starts; when `loose`, also armor headers or two lines of 16+. The grammar reading (D#168) is not
 * loose: armor headers over an identifier (`Proc-Type`, `DEK-Info`, then `loadPrivateKeyFromDisk`)
 * read as a key on 858-899 of ~12,000 keyless fuzz texts per seed, which the reading above keeps.
 */
function keyEvidence(r, label, loose) {
  // Under an opener whose prefix does not match the diff lines below it (`'+`, `rb'+`,
  // `+KEY = '''`) the line still starts with its `+`; the magic is tested without it (D#167).
  const body = r.first.replace(/^[-+]/, '');
  const magic = startsLikeKey(body) || (label.includes('PGP') && PGP_MAGIC_RE.test(body));
  return (loose && (r.longs >= 2 || r.armors > 0)) || r.longest >= 40 || magic;
}

/**
 * The lines of a cut key below its BEGIN line, read with one line shape, from the state the BEGIN
 * line left (`longs`, `longest`, `first`, `end`: a key pasted onto the BEGIN line counts as one line).
 *
 * `memoOf(shape)` (one scrubCutOffKeys call's) keeps what a reading found past two points,
 * keyed by the line and the depth, of which the rest of the reading is a function (with the shape:
 * its lead is the first character of the prefix the source was built from, and the one test that
 * reads it tells only a quote or `<` from the rest, which the source keeps literally): where
 * a run of blank lines ends, from its BLANK_MEMO_AFTER-th line (the run only sets pendingBlank),
 * and the result from the first counted base64 line on, when nothing was counted before it (from
 * there `armors` is never read, and the state is that line's alone). D#607 F1: 16 header lines
 * that each hold a BEGIN (`-Comment: -----BEGIN …`) under a code BEGIN each read the same run again
 * under the prefix grammar and refused it, 33x benign at 200k chars (186x under coverage). Short
 * runs never reach the memo: a memo of every blank run made two shapes slower (D#500). Headers at
 * different depths still read the run once per depth: a line's end depends on it.
 */
function readKeyLines(text, next, u, shape, shapeLead, longs, longest, first, end, memoOf) {
  let memo = null;
  let armors = 0;
  let shorts = 0;
  let pendingBlank = false;
  let blanks = 0;
  let blankKey = null;
  let longKey = null;
  while (next !== -1) {
    const at = next;
    // Another BEGIN line is never part of this key; stop before reading it whole.
    if (!shape && text.startsWith('-----BEGIN ', next)) {
      if (blankKey !== null) memo.blank.set(blankKey, at);
      blankKey = null;
      break;
    }
    const line = nextLine(text, next, u);
    // Blank lines read here without lineCore, where the runs a BEGIN reads through spent a third of
    // their time (D#511). Spaces and tabs, at most one quote or backtick, spaces and tabs: blank
    // whatever the shape, since a shape that matches takes a prefix of it and lineCore takes leading
    // blanks, one leading quote and trailing blanks from the rest. Spaces and tabs, at most one
    // quote, then exactly a closing tag and blanks: blank too, unless the shape can start where the
    // line does (lineCore takes the tag whole, but a shape could take part of it).
    const le = line.end;
    let k = next;
    while (k < le && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
    const c0 = text.charCodeAt(k);
    if (k < le && (c0 === 34 || c0 === 39 || c0 === 96)) k++;
    let blank = k === le;
    if (!blank && text.charCodeAt(k) === 60 && c0 !== shapeLead) {
      let e2 = le;
      while (e2 > k && (text.charCodeAt(e2 - 1) === 32 || text.charCodeAt(e2 - 1) === 9)) e2--;
      blank = closingTagLength(text, k, e2) === e2 - k;
    } else if (!blank && k > next && (c0 === 34 || c0 === 39 || c0 === 96)) {
      while (k < le && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
      blank = k === le;
    }
    if (blank) {
      next = line.next;
      if (shorts > 0) break;
      pendingBlank = true;
      if (++blanks === BLANK_MEMO_AFTER) {
        const key = at + ',' + u;
        memo ??= memoOf(shape);
        const to = memo.blank.get(key);
        if (to !== undefined) {
          next = to;
          blanks = 0;
        } else blankKey = key;
      }
      continue;
    }
    const { core, start, end: coreEnd } = lineCore(text, next, line.end, shape);
    const kind = classify(core);
    next = line.next;
    // A run ends here (blankKey is set only inside one).
    if (kind !== BLANK && blanks !== 0) {
      blanks = 0;
      if (blankKey !== null) memo.blank.set(blankKey, at);
      blankKey = null;
    }
    if (kind === END) {
      if (longs > 0) end = start + KEY_END_LINE_RE.exec(core)[0].length;
      break;
    }
    if (kind === BLANK) {
      if (shorts > 0) break;
      pendingBlank = true;
      if (++blanks === BLANK_MEMO_AFTER) {
        const key = at + ',' + u;
        memo ??= memoOf(shape);
        const to = memo.blank.get(key);
        if (to !== undefined) {
          next = to;
          blanks = 0;
        } else blankKey = key;
      }
      continue;
    }
    if (longs === 0) {
      if (kind === ARMOR && ++armors <= MAX_ARMOR_HEADERS) continue;
      if (kind !== LONG && kind !== CUT) break;
    }
    if (kind === LONG && shorts === 0) {
      if (longs === 0) {
        longKey = at + ',' + u;
        memo ??= memoOf(shape);
        const r = memo.long.get(longKey);
        if (r !== undefined)
          return { longs: r.longs, longest: r.longest, first: r.first, end: r.end, armors, shorts: r.shorts };
      }
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
  if (blankKey !== null) memo.blank.set(blankKey, -1);
  if (longKey !== null) memo.long.set(longKey, { longs, longest, first, end, shorts });
  return { longs, longest, first, end, armors, shorts };
}

// Separate scanners: KEY_BEGIN_RE's lastIndex drives scrubCutOffKeys' loop while these run.
const KEY_BEGIN_SCAN_RE = new RegExp(KEY_BEGIN_RE.source, 'g');
const KEY_END_SCAN_RE = new RegExp(KEY_END_RE.source, 'g');
const KEY_BEGIN_NEXT_RE = new RegExp(KEY_BEGIN_RE.source, 'g');
const KEY_BEGIN_INNER_RE = new RegExp(KEY_BEGIN_RE.source, 'g');

/** Start offsets of every match of the global regex `re` in `text`. */
function matchStarts(re, text) {
  const starts = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) starts.push(m.index);
  return starts;
}

/** The first value in ascending `arr` at or after `x`, or Infinity. */
function firstAtOrAfter(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo < arr.length ? arr[lo] : Infinity;
}

function scrubCutOffKeys(text) {
  if (!text.includes('PRIVATE KEY')) return text;
  // Whether an END follows offset `be` before the next BEGIN. Positions found once per call, on
  // first use, so a text with many BEGINs is not rescanned to its end for each.
  let begins = null;
  let ends = null;
  const endFollows = (be) => {
    if (begins === null) {
      begins = matchStarts(KEY_BEGIN_SCAN_RE, text);
      ends = matchStarts(KEY_END_SCAN_RE, text);
    }
    const e = firstAtOrAfter(ends, be);
    return e !== Infinity && e < firstAtOrAfter(begins, be);
  };
  // The first private-key BEGIN at or after line start `x`, or Infinity: the leftmost match from a
  // start, kept for every x between that start and it (a line start is never inside a match, which
  // holds no break). Not the positions above: found for every BEGIN on each pass, they cost a shape
  // whose skip holds before endFollows is asked 14-18% under coverage (a binary search in them, 9.6%).
  let beginFrom = Infinity;
  let beginAt = Infinity;
  const nextBegin = (x) => {
    if (!(beginFrom <= x && beginAt >= x)) {
      beginFrom = x;
      KEY_BEGIN_NEXT_RE.lastIndex = x;
      const m = KEY_BEGIN_NEXT_RE.exec(text);
      beginAt = m ? m.index : Infinity;
    }
    return beginAt;
  };
  // One line-prefix regex per distinct short prefix, for this call only: a text repeating one BEGIN
  // line built the same regex for each BEGIN, 15-22% of those shapes' time under coverage.
  const shapes = new Map();
  const shapeOf = (prefix) => {
    if (prefix.length > 64) return prefixShape(prefix);
    let r = shapes.get(prefix);
    if (r === undefined) shapes.set(prefix, (r = prefixShape(prefix)));
    return r;
  };
  // What a reading found past a point, per line shape, for this call only (readKeyLines). Keyed by
  // the shape's source, not the regex: prefixes that differ only in digits (Read columns, grep line
  // numbers) build the same pattern from different strings, and one over 64 characters a new regex
  // per BEGIN, which kept every header BEGIN of numbered output in a memo of its own (D#607 r2 P2-1).
  const memos = new Map();
  const memoOf = (shape) => {
    const id = shape && shape.source;
    let m = memos.get(id);
    if (m === undefined) memos.set(id, (m = { blank: new Map(), long: new Map() }));
    return m;
  };
  // Whether the line starting at `s` (depth u) is in a unified diff's hunk (hunkReader): the headers
  // found once per call, on first use, and one reader per depth.
  let heads = null;
  const hunks = new Map();
  const inHunk = (s, u) => {
    if (heads === null) {
      heads = [];
      HUNK_HEADER_RE.lastIndex = 0;
      for (let h; (h = HUNK_HEADER_RE.exec(text));) {
        heads.push({ at: h.index, old: h[1] === undefined ? 1 : +h[1], add: h[2] === undefined ? 1 : +h[2] });
      }
    }
    let has = hunks.get(u);
    if (has === undefined) hunks.set(u, (has = hunkReader(text, heads, u)));
    return has(s);
  };
  const ctx = { endFollows, nextBegin, shapeOf, memoOf, inHunk, reread: false };
  KEY_BEGIN_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = KEY_BEGIN_RE.exec(text))) {
    ctx.reread = false;
    let end = cutOffKeyEnd(text, m.index, m.index + m[0].length, ctx);
    if (end === -1) continue;
    // D#614 A4 (D#633): a span read again with a named grammar's shape can take a header line that
    // holds another private-key BEGIN for an armor header and end where that BEGIN's own reading goes
    // on (a 15-character line, a line that is only its prefix, another header). The span covered the
    // BEGIN, which then started no reading, so the lines past the span were stored; 6.30.8, whose
    // first reading found nothing there, read the inner BEGIN and erased them. Each private-key BEGIN
    // inside such a span is read too, and the span ends where the farthest of them ends. Only for these
    // readings: under a BEGIN with nothing before it the same holds in 6.30.8 (a separate defect).
    if (ctx.reread) {
      KEY_BEGIN_INNER_RE.lastIndex = m.index + m[0].length;
      for (let n; (n = KEY_BEGIN_INNER_RE.exec(text)) && n.index < end;) {
        const e = cutOffKeyEnd(text, n.index, n.index + n[0].length, ctx);
        if (e > end) end = e;
      }
    }
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
  if (!(longs >= 2 || longest >= 40 || crc || (clean && b64ish) || startsLikeKey(topCore))) return null;
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

function runPatterns(text) {
  let result = text;
  for (let pass = 1; ; pass++) {
    const before = result;
    for (const [pattern, replacement] of SECRET_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    if (result === before || pass >= MAX_SCRUB_PASSES) break;
  }
  return result;
}

// ─── Escaped string literals (D#687, D#693, D#685) ────────────────────────
//
// A JSON string literal holds its text one escape level deep: a key's quotes are `\"` and a line break
// is the two characters `\n`. The patterns above are written for text, so inside a literal a JSON key
// never closes on a bare quote, a label never starts a line, and a label's value runs on over the
// escaped breaks into the next line's label. What `aws secretsmanager get-secret-value --query
// SecretString` prints (`"{\"password\":\"…\"}"`), a `.env` that `kubectl … | jq -c .data` prints as one
// string, an escaped JSON literal in a source file or a `.env` value: all were stored. Two attempts that
// taught the patterns about escaped line starts (D#663, D#668) were withdrawn at review: a pattern
// that starts in a new place carries its value's run-on there.
//
// So each double-quoted literal on one line whose body holds an escape is decoded (as JSON; an escape
// JSON does not know is kept as written) and scrubbed as text, MAX_LITERAL_DEPTH levels deep, and
// rewritten, as the scrubbed text encoded as JSON, only when that scrub changed it: a literal it
// leaves alone keeps every byte. A literal opens at a quote with an even number of backslashes before
// it, and a text that ends inside one has it read to the end. Literals are found by a walk from stop
// character to stop character: the regex it replaced pushed a backtrack frame per character of a body,
// `(?:[^"\\\r\n]|\\[^\r\n])*`, and threw RangeError on a literal of millions of characters (v6.30.14
// review r1).
//
// A rewritten literal keeps erased what the patterns erase in its escaped body: their run-on erases
// the lines after a label up to a space, and the text reading keeps such a line when it has no label
// of its own. Without that, 5-8 values in 20,000 generated texts that v6.30.13 erased were stored
// (D#687 differential, 2026-11-02). The patterns then run over the whole text as before. A word is
// erased from the rewritten literal when the body holds it and what the patterns leave of the body does
// not, in either of two readings, and the rewritten literal is read both ways. As written, a word ends at
// every escape. Joined, a run of backslashes followed by `/` or by `u` and four hex digits reads as that
// one character: a rewritten literal holds the character itself, so PHP's `\/` and .NET's `\u002B` join
// words there that the body split (read only as written, 266-715 of 20,000 generated `.env` texts at one
// level kept such a word, v6.30.14 review r2; 220 of 329,366 generated values two and three levels in,
// review r3). Read only joined, a word the inner level erased part of was gone and its pieces were new
// (194 of 649,498 generated values, v6.30.15 review r1). Decoding literal by literal instead stored values
// where the patterns had erased a backslash before a quote and so moved where a literal ends (75 of
// 165,125 generated values, 2026-11-03).
//
// Bounds: MAX_LITERALS literals are decoded per text and level (real transcripts, 2026-11-02: at most
// 133 in one text); with no bound, `"\"` repeated over 500,000 characters took 104x the patterns alone
// (415 ms against 4). A rewritten literal can give the patterns a reading they did not have, so a text
// that holds a backslash is scrubbed again until it no longer changes, MAX_LITERAL_ROUNDS times at
// most; with one round, 23-42 of 20,000 generated texts changed on a second call (scrubSecrets is
// idempotent by contract: import-jsonl's dedup and cmdRestore rely on it). A text the first round
// leaves as it is is a fixed point already, and is not scrubbed again.
const LITERAL_STOP_RE = /["\\\r\n]/g;
const JSON_ESCAPE_RE = /\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g;
const JSON_ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const VALUE_TOKEN_RE = /[A-Za-z0-9+/=_.-]+/g;
const HEX4_RE = /^[0-9a-fA-F]{4}$/;
const MAX_LITERAL_DEPTH = 3;
const MAX_LITERALS = 256;
const MAX_LITERAL_ROUNDS = 4;

function decodeLiteral(body) {
  try {
    return JSON.parse(`"${body}"`);
  } catch {
    return body.replace(JSON_ESCAPE_RE, (_m, e) =>
      e[0] === 'u' ? String.fromCharCode(parseInt(e.slice(1), 16)) : JSON_ESCAPES[e],
    );
  }
}

/**
 * text with every escape that decodes to one character, at any depth (a run of backslashes, then `/` or
 * `u` and four hex digits), read as that character; and where each such escape was: [index in the
 * reading, start, end in text], flat.
 */
function joinedReading(text) {
  let read = '';
  let last = 0;
  const units = [];
  for (let i = text.indexOf('\\'); i !== -1;) {
    let j = i;
    while (text.charCodeAt(j) === 92) j++;
    let end = -1;
    let ch;
    if (text[j] === '/') {
      end = j + 1;
      ch = '/';
    } else if (text[j] === 'u' && HEX4_RE.test(text.slice(j + 1, j + 5))) {
      end = j + 5;
      ch = String.fromCharCode(parseInt(text.slice(j + 1, end), 16));
    }
    if (end === -1) {
      i = text.indexOf('\\', j);
      continue;
    }
    read += text.slice(last, i);
    units.push(read.length, i, end);
    read += ch;
    last = end;
    i = text.indexOf('\\', end);
  }
  return [read + text.slice(last), units];
}

const joinedTokens = (text) => new Set(joinedReading(text)[0].match(VALUE_TOKEN_RE));

/** text with each value token in `erase`, as joinedReading reads it, replaced by `***`. */
function eraseJoined(text, erase) {
  const [read, units] = joinedReading(text);
  let u = 0;
  let shift = 0;
  const at = (k) => {
    for (; u < units.length && units[u] < k; u += 3) shift += units[u + 2] - units[u + 1] - 1;
    return k + shift;
  };
  let out = '';
  let last = 0;
  for (const { 0: token, index } of read.matchAll(VALUE_TOKEN_RE)) {
    if (!erase.has(token)) continue;
    out += text.slice(last, at(index)) + '***';
    last = at(index + token.length);
  }
  return out + text.slice(last);
}

/**
 * The first literal opening at or after `from`: [start, bodyEnd, end], the body being text[start + 1,
 * bodyEnd) and the closing quote, if any, text[bodyEnd, end). Null when there is none. A quote whose body
 * meets a line break, or a backslash before one or at the end of the text, opens no literal.
 */
function nextLiteral(text, from) {
  const n = text.length;
  for (let q = text.indexOf('"', from); q !== -1; q = text.indexOf('"', q + 1)) {
    if (backslashesBefore(text, q, 0) % 2 === 1) continue;
    let i = q + 1;
    for (;;) {
      LITERAL_STOP_RE.lastIndex = i;
      if (!LITERAL_STOP_RE.test(text)) return [q, n, n];
      i = LITERAL_STOP_RE.lastIndex - 1;
      const c = text.charCodeAt(i);
      if (c === 34) return [q, i, i + 1];
      if (c !== 92 || i + 1 === n) break;
      const d = text.charCodeAt(i + 1);
      if (d === 10 || d === 13) break;
      i += 2;
    }
  }
  return null;
}

/**
 * text with the body of each literal it decodes replaced by lit(body): a literal whose body holds an
 * escape, the first MAX_LITERALS of them, and none at MAX_LITERAL_DEPTH.
 */
function readLiterals(text, depth, lit) {
  if (depth >= MAX_LITERAL_DEPTH || !text.includes('\\')) return text;
  let budget = MAX_LITERALS;
  let out = '';
  let last = 0;
  for (let m = nextLiteral(text, 0); m && budget > 0; m = nextLiteral(text, m[2])) {
    const body = text.slice(m[0] + 1, m[1]);
    if (!body.includes('\\')) continue;
    budget--;
    out += text.slice(last, m[0] + 1) + lit(body);
    last = m[1];
  }
  return out + text.slice(last);
}

function scrubEscapedLiterals(text, depth) {
  return readLiterals(text, depth, (body) => {
    const decoded = decodeLiteral(body);
    const scrubbed = scrubText(decoded, depth + 1);
    if (scrubbed === decoded) return body;
    const left = decodeLiteral(runPatterns(body));
    const erase = new Set();
    const keptJoined = joinedTokens(left);
    for (const token of joinedTokens(decoded)) if (!keptJoined.has(token)) erase.add(token);
    const keptAsWritten = new Set(left.match(VALUE_TOKEN_RE));
    for (const token of decoded.match(VALUE_TOKEN_RE) ?? []) if (!keptAsWritten.has(token)) erase.add(token);
    const out = eraseJoined(scrubbed, erase).replace(VALUE_TOKEN_RE, (token) =>
      erase.has(token) ? '***' : token,
    );
    return JSON.stringify(out).slice(1, -1);
  });
}

function scrubText(text, depth) {
  return runPatterns(scrubEscapedLiterals(stripPrivate(text), depth));
}

export function scrubSecrets(text) {
  if (!text || typeof text !== 'string') return text || '';
  let result = scrubText(text, 0);
  if (result === text) return result;
  for (let round = 1; round < MAX_LITERAL_ROUNDS && result.includes('\\'); round++) {
    const next = scrubText(result, 0);
    if (next === result) break;
    result = next;
  }
  return result;
}
