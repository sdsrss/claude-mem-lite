// tests/efficacy-arms.test.mjs
import { describe, it, expect } from 'vitest';
import { armConfig, INJECTED_ARMS, taskSuffixForArm } from '../lib/efficacy-arms.mjs';

describe('efficacy arm semantics (single tested source of truth — cf. #8711 env floor)', () => {
  it('F: bind-salience injection', () => {
    expect(armConfig('F')).toEqual({
      inject: true,
      salience: 'bind',
      appendRequirement: false,
      appendImperativeLesson: false,
    });
  });
  it('A: default (current) salience injection — empty salience = unset', () => {
    expect(armConfig('A')).toEqual({
      inject: true,
      salience: '',
      appendRequirement: false,
      appendImperativeLesson: false,
    });
  });
  it('AL: legacy-format injection', () => {
    expect(armConfig('AL')).toEqual({
      inject: true,
      salience: 'legacy',
      appendRequirement: false,
      appendImperativeLesson: false,
    });
  });
  it('B: bridge-salience injection (comprehension-bridge FF)', () => {
    expect(armConfig('B')).toEqual({
      inject: true,
      salience: 'bridge',
      appendRequirement: false,
      appendImperativeLesson: false,
    });
  });
  it('C: empty control', () => {
    expect(armConfig('C')).toEqual({
      inject: false,
      salience: '',
      appendRequirement: false,
      appendImperativeLesson: false,
    });
  });
  it('T: empty sandbox + spelled-out requirement (positive control)', () => {
    expect(armConfig('T')).toEqual({
      inject: false,
      salience: '',
      appendRequirement: true,
      appendImperativeLesson: false,
    });
  });
  it('U: empty sandbox + memory-imperative lesson at the prompt position (channel-isolation vs T)', () => {
    expect(armConfig('U')).toEqual({
      inject: false,
      salience: '',
      appendRequirement: false,
      appendImperativeLesson: true,
    });
  });
  it('INJECTED_ARMS is exactly {A, AL, B, F} (T and U ride the prompt, not the sandbox)', () => {
    expect([...INJECTED_ARMS].sort()).toEqual(['A', 'AL', 'B', 'F']);
  });
});

describe('taskSuffixForArm (the prompt-position contribution)', () => {
  const spec = {
    task: 'Fix the bug.',
    requirement: 'Keep the WHERE clause.',
    lesson: 'never DELETE without WHERE',
  };
  it('T appends the genuine requirement', () => {
    expect(taskSuffixForArm('T', spec)).toBe(' Keep the WHERE clause.');
  });
  it('U appends the memory-imperative lesson (no #NN tag in the measurement)', () => {
    expect(taskSuffixForArm('U', spec)).toBe(
      ' Memory — a past lesson applies to THIS task. You must: never DELETE without WHERE.',
    );
  });
  it('A/B/C/F contribute no prompt suffix (they inject via sandbox or not at all)', () => {
    for (const arm of ['A', 'B', 'C', 'F']) expect(taskSuffixForArm(arm, spec)).toBe('');
  });
  it('U with no lesson in the spec contributes nothing', () => {
    expect(taskSuffixForArm('U', { task: 't' })).toBe('');
  });
});
