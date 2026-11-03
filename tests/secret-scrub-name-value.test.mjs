// Guards for the next attempt at D#679 / D#690, withdrawn at the v6.30.14 pre-tag review: writings that
// are not a credential, in environment lists and under `_KEY` names, must stay as they are. A pattern for
// D#679 (a credential's name in a `name` field, its value in a later `value` field) or D#690 (a name no
// label pattern knows, such as `ENCRYPTION_KEY=`) has to keep every row below green.
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { scrubSecrets } from '../secret-scrub.mjs';

// Generated at run time so the file holds no secret-shaped literal.
const HEX64 = randomBytes(32).toString('hex');
const B64 = randomBytes(32).toString('base64');
const B64URL = randomBytes(65).toString('base64url');
const UUID = randomBytes(16)
  .toString('hex')
  .replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
const J = JSON.stringify;

describe('environment lists', () => {
  // A name that only mentions a credential holds a pointer (a path, a secret's name, a URL), and `PWD`
  // is the working directory.
  it.each([
    ['a secret name', J({ environment: [{ name: 'DB_SECRET_NAME', value: 'prod/myapp/db-credentials' }] })],
    ['a token URL', 'env:\n- name: TOKEN_URL\n  value: https://auth.example.com/oauth/token\n'],
    ['a password file', J({ env: [{ name: 'PASSWORD_FILE', value: '/run/secrets/db_password' }] })],
    [
      'a credentials path',
      J({ env: [{ name: 'GOOGLE_APPLICATION_CREDENTIALS', value: '/var/secrets/google/key.json' }] }),
    ],
    ['the working directory', 'env:\n- name: PWD\n  value: /home/app/current\n'],
    ['a token lifetime', J({ env: [{ name: 'TOKEN_TTL', value: '3600' }] })],
  ])('a name that mentions a credential without ending in one stays: %s', (_name, text) => {
    expect(scrubSecrets(text)).toBe(text);
  });
});

describe('writings that are not a credential stay as they are', () => {
  it.each([
    ['a name/value pair with no credential name', 'env:\n- name: PORT\n  value: "3000"\n'],
    [
      'a secret reference, no value',
      'env:\n- name: DB_PASSWORD\n  valueFrom:\n    secretKeyRef:\n      name: db\n',
    ],
    ['a value shorter than 6', J({ env: [{ name: 'API_TOKEN', value: 'none' }] })],
    ['a YAML value shorter than 6', '- name: API_TOKEN\n  value: none\n'],
    ['a quoted key with a short value', '"api_key" = "none"\n'],
    ['a key name with a short value', 'PRIMARY_KEY=id\nSORT_KEY=createdAt\n'],
    ['a key name with a long identifier', 'SECRET_KEY_BASE=Rails_application_credentials_secret_key_base\n'],
    ['a 31-character value', 'ENCRYPTION_KEY=0123456789abcdef0123456789abcde\n'],
    // A `_key` that is an identifier or a public value: hashes, ids and public keys under these names.
    ['a CI cache key', `CACHE_KEY=${HEX64}\n  cache_key: v1-deps-${HEX64}\n`],
    ['a public key', `PUBLIC_KEY=${B64}\nVAPID_PUBLIC_KEY=${B64URL}\nPUBLISHABLE_KEY=${B64}\n`],
    ['a Supabase anon key', `VITE_SUPABASE_ANON_KEY=${B64}\n`],
    ['an SSH host key', `ssh_host_key: AAAAC3NzaC1lZDI1NTE5AAAAI${B64}\n`],
    ['a table key', `PARTITION_KEY=${UUID}\nsort_key: ${HEX64.slice(0, 40)}\nrow_key = "${HEX64}"\n`],
    ['a request key', `IDEMPOTENCY_KEY=${UUID}\ndedup_key: ${HEX64.slice(0, 32)}\n`],
    ['an object key', `OBJECT_KEY=uploads/2026/${HEX64.slice(0, 32)}\n`],
    ['a key id after the key', `KMS_KEY_ID=${UUID}\nSIGNING_KEY_ID=${HEX64.slice(0, 32)}\n`],
    // At a line start in a JSON string (the v6.30.14 review's F1): the name follows an escaped break.
    [
      'a public key at an escaped line start',
      J({ content: `NODE_ENV=production\nPUBLIC_KEY=${B64}\nCACHE_KEY=${HEX64}\n` }),
    ],
    ['a key flag with no name', `gh cache delete --key=node-modules-linux-${HEX64}\n`],
    [
      'a comparison in code',
      'if (field == "password") return "hidden_value_here";\nif ("token" === x) y = "abc123456";\n',
    ],
  ])('%s', (_name, text) => {
    expect(scrubSecrets(text)).toBe(text);
  });
});
