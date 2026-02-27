import type { CronRuleDraft } from '@/modules/cron/hooks/useCronRules';

export interface CronTemplate {
  id: string;
  label: string;
  description: string;
  icon: string;
  draft: CronRuleDraft;
}

/**
 * Predefined cron rule templates for quick-start rule creation.
 * Add new entries here to extend the template library.
 */
export const CRON_TEMPLATES: CronTemplate[] = [
  {
    id: 'morning-briefing',
    label: 'Morning Briefing',
    description: 'Daily summary at 09:00 UTC',
    icon: '🌅',
    draft: {
      name: 'Morning Briefing',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      prompt:
        'Generate a concise morning briefing: summarize overnight activity, highlight pending tasks, and list key priorities for today.',
      enabled: true,
    },
  },
  {
    id: 'evening-digest',
    label: 'Evening Digest',
    description: 'Daily digest at 18:00 UTC',
    icon: '🌆',
    draft: {
      name: 'Evening Digest',
      cronExpression: '0 18 * * *',
      timezone: 'UTC',
      prompt:
        'Compile an evening digest: summarize completed tasks, outstanding items, and any alerts or anomalies from today.',
      enabled: true,
    },
  },
  {
    id: 'hourly-health-check',
    label: 'Hourly Health Check',
    description: 'System health check every hour',
    icon: '🩺',
    draft: {
      name: 'Hourly Health Check',
      cronExpression: '0 * * * *',
      timezone: 'UTC',
      prompt:
        'Run a system health check: verify service availability, check error rates, and report any degraded components.',
      enabled: true,
    },
  },
  {
    id: 'weekly-summary',
    label: 'Weekly Summary',
    description: 'Monday 08:00 UTC weekly report',
    icon: '📊',
    draft: {
      name: 'Weekly Summary',
      cronExpression: '0 8 * * 1',
      timezone: 'UTC',
      prompt:
        'Produce a weekly summary report: aggregate metrics from the past 7 days, highlight trends, and outline goals for the coming week.',
      enabled: true,
    },
  },
  {
    id: 'queue-cleanup',
    label: 'Queue Cleanup',
    description: 'Daily maintenance at 02:30 UTC',
    icon: '🧹',
    draft: {
      name: 'Queue Cleanup',
      cronExpression: '30 2 * * *',
      timezone: 'UTC',
      prompt:
        'Perform queue maintenance: purge stale dead-letter entries older than 7 days, compact run history, and report cleanup statistics.',
      enabled: true,
    },
  },
];
