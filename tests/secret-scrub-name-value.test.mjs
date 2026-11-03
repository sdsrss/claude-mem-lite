// D#679: an environment list keeps the credential's name in a `name` field and its value in the `value`
// field after it (Kubernetes `env:`, ECS `environment`, AWS SSM `get-parameters`, Terraform), where no label
// pattern sees the pair. D#690: a name no label pattern knows (`ENCRYPTION_KEY=`, Rails `SECRET_KEY_BASE=`,
// Laravel `APP_KEY=base64:`) and a quoted key with `=` (TOML / HCL). One row per shape, then the writings that
// must stay as they are.
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { scrubSecrets } from '../secret-scrub.mjs';

// Assembled or generated at run time so the file holds no secret-shaped literal.
const V = 'Zr7Kq2Lm' + '9Xv4Tp8W';
const HEX64 = randomBytes(32).toString('hex');
const HEX128 = randomBytes(64).toString('hex');
const B64 = randomBytes(32).toString('base64');
const B64URL = randomBytes(65).toString('base64url');
const UUID = randomBytes(16)
  .toString('hex')
  .replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
const J = JSON.stringify;

describe('D#679: a name field naming a credential, then its value field', () => {
  it.each([
    [
      'pod JSON, compact',
      J({
        env: [
          { name: 'PORT', value: '3000' },
          { name: 'DB_PASSWORD', value: V },
        ],
      }),
    ],
    ['pod JSON, pretty', J({ env: [{ name: 'API_KEY', value: V }] }, null, 2)],
    ['YAML list', `env:\n- name: DB_PASSWORD\n  value: ${V}\n- name: PORT\n  value: "3000"\n`],
    ['YAML list, quoted', `        - name: "GITHUB_TOKEN"\n          value: "${V}"\n`],
    [
      'AWS SSM, a key between',
      J({ Parameters: [{ Name: '/prod/db/password', Type: 'SecureString', Value: V }] }, null, 4),
    ],
    ['ECS environment', J({ environment: [{ name: 'STRIPE_SECRET', value: V }] })],
    ['Terraform', `env {\n  name  = "DB_PASSWORD"\n  value = "${V}"\n}\n`],
    ['Terraform, one line', `env { name = "API_TOKEN", value = "${V}" }`],
    [
      'two value fields in the object',
      J({ name: 'API_TOKEN', value: V, note: 'x' }).replace('}', ',"value":"later-value"}'),
    ],
    ['a name the env form lists whole', J({ env: [{ name: 'MYSQL_PWD', value: V }] })],
    ['a noun with no separator before it', 'env:\n- name: PGPASSWORD\n  value: ' + V + '\n'],
  ])('%s', (_name, text) => {
    expect(scrubSecrets(text)).not.toContain(V);
  });

  // The name is read as `NAME=VALUE` is: the credential noun ends it. A name that only mentions one
  // holds a pointer (a path, a secret's name, a URL), and `PWD` is the working directory.
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

describe('D#690: a name no label pattern knows, with a key-shaped value', () => {
  it.each([
    ['ENCRYPTION_KEY, hex', `ENCRYPTION_KEY=${HEX64}\n`, HEX64],
    ['SECRET_KEY_BASE (Rails)', `SECRET_KEY_BASE=${HEX128}\n`, HEX128],
    ['APP_KEY (Laravel)', `APP_KEY=base64:${B64}\n`, B64],
    ['MASTER_KEY, YAML', `  master_key: ${HEX64.slice(0, 32)}\n`, HEX64.slice(0, 32)],
    ['SIGNING_KEY, quoted', `SIGNING_KEY="${B64}"\n`, B64],
    ['PASSWORD_SALT', `password_salt = '${HEX64}'\n`, HEX64],
    ['a name ending in the letters of an excluded word', `ESCROW_KEY=${HEX64}\n`, HEX64],
  ])('%s', (_name, text, value) => {
    expect(scrubSecrets(text)).not.toContain(value);
  });

  it.each([
    ['TOML', `"api_key" = "${V}"\n`],
    ['HCL map', `  "client_secret" = "${V}"\n`],
    ['single quotes', `'db_password'='${V}'\n`],
  ])('a quoted credential key with `=`: %s', (_name, text) => {
    expect(scrubSecrets(text)).not.toContain(V);
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
    ['a key flag with no name', `gh cache delete --key=node-modules-linux-${HEX64}\n`],
    [
      'a comparison in code',
      'if (field == "password") return "hidden_value_here";\nif ("token" === x) y = "abc123456";\n',
    ],
  ])('%s', (_name, text) => {
    expect(scrubSecrets(text)).toBe(text);
  });
});
