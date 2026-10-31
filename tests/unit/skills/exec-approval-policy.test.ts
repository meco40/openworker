import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { areExecApprovalsRequired } from '@/server/skills/execApprovalPolicy';
import { requiresInteractiveToolApproval } from '@/server/channels/messages/service/core/configuration';
import { shellExecuteHandler } from '@/server/skills/handlers/shellExecute';
import { pythonExecuteHandler } from '@/server/skills/handlers/pythonExecute';
import { processManagerHandler } from '@/server/skills/handlers/processManager';
import { playwrightCliHandler } from '@/server/skills/handlers/playwrightCli';

const ENV_NAME = 'BETACLAW_EXEC_APPROVALS_REQUIRED';

describe('exec approval policy', () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[ENV_NAME];
    delete process.env[ENV_NAME];
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env[ENV_NAME];
    } else {
      process.env[ENV_NAME] = previous;
    }
  });

  describe('areExecApprovalsRequired', () => {
    it.each([
      [undefined, true],
      ['', true],
      ['true', true],
      ['TRUE', true],
      ['1', true],
      ['yes', true],
      [' false', true],
      ['false ', true],
      ['0', true],
      ['false', false],
      ['FALSE', false],
      ['False', false],
    ])('maps %j to %s', (value, expected) => {
      const env = value === undefined ? {} : { [ENV_NAME]: value };
      expect(areExecApprovalsRequired(env)).toBe(expected);
    });

    it('reads process.env by default', () => {
      expect(areExecApprovalsRequired()).toBe(true);
      process.env[ENV_NAME] = 'false';
      expect(areExecApprovalsRequired()).toBe(false);
    });
  });

  describe('with the variable unset', () => {
    it('requires interactive tool approval in the message service', () => {
      expect(requiresInteractiveToolApproval()).toBe(true);
      process.env[ENV_NAME] = 'false';
      expect(requiresInteractiveToolApproval()).toBe(false);
    });

    it('makes shell_execute demand an approval', async () => {
      await expect(shellExecuteHandler({ command: 'echo approval-default' })).rejects.toThrow(
        'Command requires approval.',
      );
    });

    it('makes python_execute demand an approval', async () => {
      await expect(pythonExecuteHandler({ code: 'print("approval-default")' })).rejects.toThrow(
        'Command requires approval.',
      );
    });

    it('makes the process manager demand an approval', async () => {
      const result = (await processManagerHandler({
        action: 'start',
        command: 'echo approval-default',
      })) as { ok?: boolean; error?: string };
      expect(result.ok).toBe(false);
      expect(String(result.error)).toContain('Command requires approval.');
    });

    it('makes the playwright cli demand an approval', async () => {
      await expect(playwrightCliHandler({ command: 'test' })).rejects.toThrow(
        'Command requires approval.',
      );
    });
  });
});
