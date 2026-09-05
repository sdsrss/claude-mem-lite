// tests/efficacy-bridge-select.test.mjs
import { describe, it, expect } from 'vitest';
import { lessonBindsToRegion, bridgeFired } from '../lib/efficacy-bridge-select.mjs';

describe('lessonBindsToRegion', () => {
  it('true when a lesson identifier appears in the region', () => {
    expect(
      lessonBindsToRegion('guard `recoverChildrenOf` against null', 'function recoverChildrenOf(p){}'),
    ).toBe(true);
  });
  it('false when no named identifier overlaps the region', () => {
    expect(lessonBindsToRegion('always validate input', 'const x = compressedInto + 1;')).toBe(false);
  });
  it('false on empty inputs', () => {
    expect(lessonBindsToRegion('', '')).toBe(false);
  });
});

describe('bridgeFired', () => {
  it('detects the bridge marker', () => {
    expect(bridgeFired('[mem] ⚠ #42 → this edit must: null-check foo. Confirm...')).toBe(true);
  });
  it('false for the plain ack line', () => {
    expect(bridgeFired('[mem] ⚠ Before this edit: apply each lesson...')).toBe(false);
  });
});
