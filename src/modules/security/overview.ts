import type { CommandPermission } from '@/shared/domain/types';

export type SecurityCheckStatus = 'ok' | 'warning' | 'critical';

export interface SecurityCheck {
  id: 'firewall' | 'encryption' | 'audit' | 'isolation';
  label: string;
  status: SecurityCheckStatus;
  detail: string;
}

function hasDangerousCommandEnabled(commands: CommandPermission[]): boolean {
  return commands.some(
    (rule) =>
      rule.enabled &&
      /rm\s+-rf|del\s+\/f\s+\/s\s+\/q|powershell\s+-enc|format\b|shutdown\b|restart-computer\b|reg\s+delete|sc\s+stop|diskpart|bcdedit|invoke-expression|iex\b/i.test(
        rule.command,
      ),
  );
}

export function buildCommandSecurityChecks(commands: CommandPermission[]): SecurityCheck[] {
  const enabledHighRisk = commands.filter((rule) => rule.risk === 'High' && rule.enabled).length;
  const blockedRules = commands.filter((rule) => !rule.enabled).length;
  const blockedHighRisk = commands.filter((rule) => rule.risk === 'High' && !rule.enabled).length;

  const firewallStatus: SecurityCheckStatus = enabledHighRisk > 0 ? 'critical' : 'ok';
  const isolationStatus: SecurityCheckStatus = hasDangerousCommandEnabled(commands)
    ? 'critical'
    : blockedHighRisk > 0
      ? 'ok'
      : 'warning';

  return [
    {
      id: 'firewall',
      label: 'Active Firewall',
      status: firewallStatus,
      detail:
        firewallStatus === 'critical'
          ? `${enabledHighRisk} High-Risk-Command(s) sind aktiv.`
          : `${blockedRules} Regel(n) blockiert.`,
    },
    {
      id: 'isolation',
      label: 'Task Isolation',
      status: isolationStatus,
      detail:
        isolationStatus === 'critical'
          ? 'Gefährliche Shell-Kommandos sind aktiviert.'
          : isolationStatus === 'warning'
            ? 'Keine High-Risk-Regel blockiert.'
            : `${blockedHighRisk} High-Risk-Regel(n) isoliert.`,
    },
  ];
}
