// D#812: provider tokens with a fixed prefix and a fixed body that scrubSecrets kept as written
// (6.33.0 pre-tag review, defects F6). Shapes from gitleaks (config/gitleaks.toml @ 5f6ec56c:
// huggingface-*, digitalocean-*, pypi-upload-token, shopify-*) and trufflehog
// (pkg/detectors/groq). Fixtures are assembled from pieces so no whole token sits in the file.
import { describe, it, expect } from 'vitest';
import { scrubSecrets } from '../secret-scrub.mjs';

const HEX64 = '0123456789abcdef'.repeat(4);
const HEX32 = 'a1b2c3d4e5f60718'.repeat(2);
const TOKENS = {
  huggingface: 'hf' + '_' + 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3h',
  huggingfaceOrg: 'api' + '_org_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgH',
  digitaloceanPat: 'dop' + '_v1_' + HEX64,
  digitaloceanOauth: 'doo' + '_v1_' + HEX64,
  digitaloceanRefresh: 'dor' + '_v1_' + HEX64,
  pypi: 'pypi' + '-AgEIcHlwaS5vcmc' + 'CJDk3YzA1ZGI2LWE0ZDMtNGE0Ni1iYzE2LTA3YjM2NTBjYTZhNgACKlsz',
  pypiTest: 'pypi' + '-AgENdGVzdC5weXBpLm9yZw' + 'IkZjAzNmQ3NmQtNDZjYi00ZWNhLTk0ODgtNzE5ZTliY2M1Y2M0AAI',
  shopifyAccess: 'shp' + 'at_' + HEX32,
  shopifyCustom: 'shp' + 'ca_' + HEX32,
  shopifyPrivateApp: 'shp' + 'pa_' + HEX32,
  shopifySharedSecret: 'shp' + 'ss_' + HEX32,
  groq: 'gsk' + '_' + 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6kL9mN2pQ5sT8vW1y',
};

/** True when any 12-character piece of the token body is still in `out`. */
function leaks(out, token) {
  const body = token.slice(token.indexOf('_') + 1 || token.indexOf('-') + 1);
  for (let i = 0; i + 12 <= body.length; i++) if (out.includes(body.slice(i, i + 12))) return true;
  return false;
}

describe('scrubSecrets erases fixed-shape provider tokens (D#812)', () => {
  for (const [name, token] of Object.entries(TOKENS)) {
    it(`${name}: in prose, after =, in a JSON string, in a URL query`, () => {
      const shapes = [
        `Done. I set the value to ${token} and the tests pass.`,
        `export SOME_VAR=${token}`,
        JSON.stringify({ note: `use ${token} here` }),
        `https://example.test/hook?t=${token}&x=1`,
        // a tool output serialised twice: the token follows a literal backslash-n
        JSON.stringify(JSON.stringify(`line one\n${token}`)),
      ];
      for (const text of shapes) {
        const out = scrubSecrets(text);
        expect(leaks(out, token), `${name} kept in: ${out}`).toBe(false);
      }
    });
  }
});

describe('the same prefixes on ordinary text stay as written', () => {
  const keep = [
    'from huggingface_hub import hf_hub_download',
    'hf' + '_' + 'aB3dE6gH9jK2', // body too short
    'pip download pypi-simple pypi-AgE', // package-like words, no token body
    'dop' + '_v1_' + 'not-hex-at-all-' + 'z'.repeat(50),
    'shp' + 'at_' + 'a1b2c3d4e5f6', // body too short
    'gsk' + '_' + 'short_name',
  ];
  for (const text of keep) {
    it(JSON.stringify(text), () => {
      expect(scrubSecrets(text)).toBe(text);
    });
  }
});

// Pre-ship review of abeac529 (F8): each body has an exact length, and a pattern that widened to
// one more or one fewer character would erase identifiers no provider issues. Every near miss
// stays as written.
describe('a body one character off the shape stays as written', () => {
  const near = {
    huggingface: ['hf' + '_', 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3h'],
    huggingfaceOrg: ['api' + '_org_', 'aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgH'],
    digitalocean: ['dop' + '_v1_', HEX64],
    shopify: ['shp' + 'at_', HEX32],
    groq: ['gsk' + '_', 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6kL9mN2pQ5sT8vW1y'],
  };
  for (const [name, [prefix, body]] of Object.entries(near)) {
    it(`${name}: one short and one long`, () => {
      for (const b of [body.slice(0, -1), body + body[0]]) {
        const text = `value ${prefix}${b} end`;
        expect(scrubSecrets(text)).toBe(text);
      }
    });
  }
  it('digitalocean and shopify: a body with a letter past f is not hex, and stays', () => {
    for (const text of [
      'value ' + 'dop' + '_v1_' + HEX64.slice(0, -1) + 'g end',
      'value ' + 'shp' + 'at_' + HEX32.slice(0, -1) + 'G end',
    ])
      expect(scrubSecrets(text)).toBe(text);
  });
  it('pypi: a body one short of 50', () => {
    const text = 'value ' + 'pypi' + '-AgE' + 'x'.repeat(49) + ' end';
    expect(scrubSecrets(text)).toBe(text);
  });
});
