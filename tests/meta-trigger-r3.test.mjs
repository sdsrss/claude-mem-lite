// R3 H-M2 (MED): isMetaTriggerPrompt's curated strip list omitted control phrases
// named in lesson #8287's own examples (怎么停了) plus common continuations (go on,
// proceed, keep going, 再来一次). Uncaught → they leak into the handoff `working_on`
// as if they were the work subject (read-side fallback only fires when ALL prompts are meta).
import { describe, it, expect } from 'vitest';
import { isMetaTriggerPrompt } from '../utils.mjs';

describe('isMetaTriggerPrompt covers named control phrases (R3 H-M2)', () => {
  it('classifies lesson-named + common continuation phrases as meta', () => {
    for (const p of [
      '怎么停了',
      '停了',
      '再来一次',
      'go on',
      'go ahead',
      'proceed',
      'keep going',
      'carry on',
      'why did you stop',
    ]) {
      expect(isMetaTriggerPrompt(p), `"${p}" should be meta`).toBe(true);
    }
  });

  it('still treats a real subject as non-meta even when it contains a control word', () => {
    expect(isMetaTriggerPrompt('proceed to build the CSV export feature for the reports page')).toBe(false);
    expect(isMetaTriggerPrompt('服务停了之后需要自动重启并发送告警邮件通知运维')).toBe(false);
    expect(isMetaTriggerPrompt('实现用户登录和注册功能并加上二次验证')).toBe(false);
  });
});
