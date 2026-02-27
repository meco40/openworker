import { describe, expect, it } from 'vitest';
import { evaluateSystemActionSafety } from '@/server/master/safety';
import { executeSystemOperation } from '@/server/master/systemOps';

describe('master system safety', () => {
  it('blocks forbidden actions and requires approval for risky operations', () => {
    const forbidden = evaluateSystemActionSafety('rm -rf /');
    expect(forbidden.allowed).toBe(false);

    const risky = evaluateSystemActionSafety('shutdown /r');
    expect(risky.allowed).toBe(true);
    expect(risky.requiresApproval).toBe(true);
  });

  it('supports approve_once / approve_always / deny semantics', () => {
    const awaiting = executeSystemOperation({ command: 'npm install' });
    expect(awaiting.status).toBe('awaiting_approval');

    const once = executeSystemOperation({ command: 'npm install', decision: 'approve_once' });
    expect(once.status).toBe('executed');

    const always = executeSystemOperation({ command: 'npm install', decision: 'approve_always' });
    expect(always.status).toBe('executed');

    const denied = executeSystemOperation({ command: 'npm install', decision: 'deny' });
    expect(denied.status).toBe('blocked');
  });
});
