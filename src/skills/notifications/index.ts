import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'notifications',
  name: 'Notifications',
  description: 'Sendet Webhooks und E-Mails. Erfordert OPENCLAW_NOTIFICATIONS_ENABLED=true.',
  version: '1.0.0',
  category: 'Automation',
  functionName: 'notifications',
  tool: {
    name: 'notifications',
    description:
      'Send notifications via webhook or email. Use action="webhook_send" to POST JSON to a URL, or action="email_send" to send an email. Requires OPENCLAW_NOTIFICATIONS_ENABLED=true environment variable.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['webhook_send', 'email_send'],
          description: 'The notification action to perform.',
        },
        url: {
          type: 'string',
          description: '[webhook_send] The webhook URL to POST to.',
        },
        payload: {
          type: 'object',
          description: '[webhook_send] The JSON payload to send.',
        },
        headers: {
          type: 'object',
          description: '[webhook_send] Optional extra headers.',
        },
        to: {
          type: 'string',
          description: '[email_send] Recipient address or comma-separated list of addresses.',
        },
        subject: {
          type: 'string',
          description: '[email_send] Email subject line.',
        },
        body: {
          type: 'string',
          description: '[email_send] Plain-text email body.',
        },
        from: {
          type: 'string',
          description: '[email_send] Optional sender address (overrides SMTP_FROM).',
        },
      },
      required: ['action'],
    },
  },
};

const notificationsSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('notifications', args),
};

export default notificationsSkill;
