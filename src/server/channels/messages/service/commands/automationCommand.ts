import type { ChannelType } from '@/shared/domain/types';
import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import type { CommandHandlerDeps } from './types';

export async function handleAutomationCommand(
  conversation: Conversation,
  payload: string,
  platform: ChannelType,
  externalChatId: string,
  sendResponse: CommandHandlerDeps['sendResponse'],
): Promise<StoredMessage> {
  const fullCommand = payload ? `/cron ${payload}` : '/cron';
  const { parseCronCommand } = await import('@/server/automation/commands');
  const parsed = parseCronCommand(fullCommand);

  const { getAutomationService } = await import('@/server/automation/runtime');
  const automationService = getAutomationService();

  switch (parsed.action) {
    case 'list': {
      const rules = automationService.listRules(conversation.userId);
      if (rules.length === 0) {
        return sendResponse(
          conversation,
          '⏱️ Keine Cron-Regeln vorhanden.\nNutze z. B.: `/cron add "0 10 * * *" --tz "Europe/Berlin" --prompt "Gib mir ein Briefing"`',
          platform,
          externalChatId,
        );
      }

      const lines = rules.map(
        (rule) =>
          `• ${rule.enabled ? '✓' : '⏸️'} **${rule.name}** (\`${rule.id}\`)\n  \`${rule.cronExpression}\` @ ${rule.timezone}\n  next: ${rule.nextRunAt || 'n/a'}`,
      );

      return sendResponse(
        conversation,
        `⏱️ **Cron-Regeln:**\n${lines.join('\n')}`,
        platform,
        externalChatId,
      );
    }

    case 'add':
    case 'every': {
      const rule = automationService.createRule({
        userId: conversation.userId,
        name: parsed.name || parsed.prompt.slice(0, 40),
        cronExpression: parsed.cronExpression,
        timezone: parsed.timezone,
        prompt: parsed.prompt,
        enabled: true,
      });

      return sendResponse(
        conversation,
        `✓ Cron-Regel erstellt: **${rule.name}**\nID: \`${rule.id}\`\nSchedule: \`${rule.cronExpression}\` (${rule.timezone})\nNächster Lauf: ${rule.nextRunAt || 'n/a'}`,
        platform,
        externalChatId,
      );
    }

    case 'pause': {
      const rule = automationService.updateRule(parsed.ruleId, conversation.userId, {
        enabled: false,
      });
      if (!rule) {
        return sendResponse(
          conversation,
          `❌ Regel \`${parsed.ruleId}\` nicht gefunden.`,
          platform,
          externalChatId,
        );
      }
      return sendResponse(
        conversation,
        `⏸️ Regel **${rule.name}** pausiert.`,
        platform,
        externalChatId,
      );
    }

    case 'resume': {
      const rule = automationService.updateRule(parsed.ruleId, conversation.userId, {
        enabled: true,
      });
      if (!rule) {
        return sendResponse(
          conversation,
          `❌ Regel \`${parsed.ruleId}\` nicht gefunden.`,
          platform,
          externalChatId,
        );
      }
      return sendResponse(
        conversation,
        `▶️ Regel **${rule.name}** aktiviert.`,
        platform,
        externalChatId,
      );
    }

    case 'remove': {
      const removed = automationService.deleteRule(parsed.ruleId, conversation.userId);
      if (!removed) {
        return sendResponse(
          conversation,
          `❌ Regel \`${parsed.ruleId}\` nicht gefunden.`,
          platform,
          externalChatId,
        );
      }
      return sendResponse(
        conversation,
        `🗑️ Regel \`${parsed.ruleId}\` gelöscht.`,
        platform,
        externalChatId,
      );
    }

    case 'run': {
      try {
        const run = automationService.createManualRun(parsed.ruleId, conversation.userId);
        return sendResponse(
          conversation,
          `🚀 Manueller Run erstellt: \`${run.id}\` (Regel: \`${run.ruleId}\`).`,
          platform,
          externalChatId,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Run konnte nicht erstellt werden.';
        return sendResponse(conversation, `❌ ${message}`, platform, externalChatId);
      }
    }

    case 'unsupported':
    default:
      return sendResponse(
        conversation,
        `⚠️ ${parsed.reason}\n\nUnterstützt:\n• /cron list\n• /cron add "<cron>" --tz "<TZ>" --prompt "<Text>"\n• /cron every "10m|1h|1d" --prompt "<Text>"\n• /cron pause <id>\n• /cron resume <id>\n• /cron remove <id>\n• /cron run <id>`,
        platform,
        externalChatId,
      );
  }
}
