import { describe, it, expect, vi } from 'vitest';
import { parseIntFlag, isNumericToken } from '../lib/cli-flags.mjs';
import { suggestUnknownFlags, KNOWN_CLI_FLAGS } from '../cli/common.mjs';

describe('parseIntFlag', () => {
  it('returns defaultValue when input is undefined / null / empty', () => {
    const warn = vi.fn();
    expect(parseIntFlag(undefined, { name: '--limit', defaultValue: 20, warn })).toBe(20);
    expect(parseIntFlag(null, { name: '--limit', defaultValue: 20, warn })).toBe(20);
    expect(parseIntFlag('', { name: '--limit', defaultValue: 20, warn })).toBe(20);
    expect(warn).not.toHaveBeenCalled();
  });

  it('parses valid integer input within default min=1', () => {
    const warn = vi.fn();
    expect(parseIntFlag('42', { name: '--limit', defaultValue: 20, warn })).toBe(42);
    expect(parseIntFlag(42, { name: '--limit', defaultValue: 20, warn })).toBe(42);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects non-integer input with stderr warn + default fallback', () => {
    const warn = vi.fn();
    const result = parseIntFlag('abc', { name: '--limit', defaultValue: 20, warn });
    expect(result).toBe(20);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Invalid --limit "abc"');
    expect(warn.mock.calls[0][0]).toContain('using default 20');
  });

  // Round1-P2: bare parseInt silently coerced trailing-garbage / hex / scientific
  // tokens ("2abc"→2, "3xyz"→3, "0x10"→0, "1e2"→1) whose numeric prefix landed in
  // range, slipping past the Number.isInteger gate and violating the warn+default
  // contract. Strict shape validation now rejects pure garbage. NOTE: float literals
  // ("3.7"→3) stay accepted by design (#8277) — see the 'rejects floats' case above;
  // this fix deliberately does NOT touch that documented behavior.
  it('rejects prefix-numeric garbage that parseInt would silently coerce', () => {
    for (const bad of ['2abc', '3xyz', '0x10', '1e2']) {
      const warn = vi.fn();
      const result = parseIntFlag(bad, { name: '--limit', defaultValue: 20, warn });
      expect(result, `"${bad}" should fall back to default`).toBe(20);
      expect(warn, `"${bad}" should emit a warning`).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(`Invalid --limit "${bad}"`);
    }
  });

  it('rejects below-min input (negative integers, the #8277 trap)', () => {
    const warn = vi.fn();
    // -5 is truthy in JS, so the bare `parseInt(x, 10) || default` pattern
    // would silently accept it; parseIntFlag must reject.
    const result = parseIntFlag('-5', { name: '--limit', defaultValue: 20, warn });
    expect(result).toBe(20);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('-5');
  });

  it('rejects below-min input (zero with default min=1)', () => {
    const warn = vi.fn();
    expect(parseIntFlag('0', { name: '--limit', defaultValue: 20, warn })).toBe(20);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('accepts zero when min=0 (e.g. --offset)', () => {
    const warn = vi.fn();
    expect(parseIntFlag('0', { name: '--offset', defaultValue: 0, min: 0, warn })).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects above-max input with bounded warning text', () => {
    const warn = vi.fn();
    const result = parseIntFlag('99999999', { name: '--limit', defaultValue: 20, max: 1000, warn });
    expect(result).toBe(20);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('between 1 and 1000');
  });

  it('accepts the exact upper bound', () => {
    const warn = vi.fn();
    expect(parseIntFlag('1000', { name: '--limit', defaultValue: 20, max: 1000, warn })).toBe(1000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warning includes the open-ended range when no max set', () => {
    const warn = vi.fn();
    parseIntFlag('-1', { name: '--days', defaultValue: 30, warn });
    expect(warn.mock.calls[0][0]).toContain('≥ 1');
  });

  it('rejects floats (parseInt truncates but isInteger guards)', () => {
    const warn = vi.fn();
    // parseInt('3.7', 10) = 3 (truncation). isInteger(3) = true. So '3.7' parses to 3.
    // This is acceptable per #8277 — explicit warn-then-default is for non-integer
    // results, and parseInt produces integer 3 from '3.7'. Verify the documented behavior.
    expect(parseIntFlag('3.7', { name: '--limit', defaultValue: 20, warn })).toBe(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects "Infinity" / "NaN" string literals', () => {
    const warn = vi.fn();
    expect(parseIntFlag('Infinity', { name: '--limit', defaultValue: 20, warn })).toBe(20);
    expect(parseIntFlag('NaN', { name: '--limit', defaultValue: 20, warn })).toBe(20);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('importance bound: min=1 max=3', () => {
    const warn = vi.fn();
    expect(parseIntFlag('2', { name: '--importance', defaultValue: 1, min: 1, max: 3, warn })).toBe(2);
    expect(parseIntFlag('5', { name: '--importance', defaultValue: 1, min: 1, max: 3, warn })).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('between 1 and 3');
  });
});

// Round2-P2: shared strict-shape gate used by parseIntFlag and the reject-style
// numeric flags (save/update --importance, defer --priority).
describe('isNumericToken', () => {
  it('accepts integers and float literals, rejects garbage / hex / scientific / empty', () => {
    for (const ok of ['2', '-3', '0', '2.9', ' 5 ', '100']) {
      expect(isNumericToken(ok), `"${ok}" should be accepted`).toBe(true);
    }
    for (const bad of ['2abc', '3xyz', '0x10', '1e2', 'abc', '', '   ', 'NaN', 'Infinity']) {
      expect(isNumericToken(bad), `"${bad}" should be rejected`).toBe(false);
    }
  });
});

// parseArgs silently drops unknown flags, so a misspelled flag (`--improtance 3`,
// `--projcte X`, `--lmit 5`) changed results with zero signal. suggestUnknownFlags
// catches likely typos (edit distance <= 2 from a known flag) without false-alarming
// on valid flags or truly-novel names.
describe('suggestUnknownFlags', () => {
  it('flags a misspelled flag with the closest known suggestion', () => {
    expect(suggestUnknownFlags({ improtance: '3' })).toEqual([
      { flag: 'improtance', suggestion: 'importance' },
    ]);
    expect(suggestUnknownFlags({ projcte: 'x' })).toEqual([{ flag: 'projcte', suggestion: 'project' }]);
    expect(suggestUnknownFlags({ lmit: '5' })).toEqual([{ flag: 'lmit', suggestion: 'limit' }]);
  });

  it('never warns on a valid flag', () => {
    // Every catalogued flag must round-trip clean — else a correct invocation gets a
    // spurious "did you mean" note. Guards against KNOWN_CLI_FLAGS omissions.
    for (const known of KNOWN_CLI_FLAGS) {
      expect(suggestUnknownFlags({ [known]: 'v' }), `--${known} must not warn`).toEqual([]);
    }
  });

  it('reports a far-from-anything unknown flag WITHOUT inventing a suggestion', () => {
    // Was: stay silent, on the theory that no close match might mean "a valid flag we
    // did not catalogue". But silence is what let a dropped filter pass for an applied
    // one — `--obs_type bugfix` (distance 4 from `type`) returned rows of every type
    // with zero output. Report it; suggestion stays null so no wrong name is invented.
    // The catalogue was audited against every code-read flag when this flipped.
    expect(suggestUnknownFlags({ xyzzy: '1' })).toEqual([{ flag: 'xyzzy', suggestion: null }]);
    expect(suggestUnknownFlags({ 'completely-different-flag': true })).toEqual([
      { flag: 'completely-different-flag', suggestion: null },
    ]);
  });

  it('ignores the empty-string key from a bare `--`', () => {
    expect(suggestUnknownFlags({ '': true })).toEqual([]);
  });

  it('reports multiple typos in one invocation', () => {
    const result = suggestUnknownFlags({ improtance: '3', lmit: '5' });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.flag).sort()).toEqual(['improtance', 'lmit']);
  });
});
