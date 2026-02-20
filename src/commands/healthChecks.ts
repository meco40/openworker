import type { HealthCheck, HealthCommandOptions } from '@/commands/healthTypes';
import {
  runGatewayRegistryCheck,
  runKnowledgeLayerCheck,
  runLoggingRepositoryCheck,
  runMemoryRepositoryCheck,
  runStatsRepositoryCheck,
} from '@/commands/health/checks/coreChecks';
import {
  runAlertRoutingCheck,
  runErrorBudgetCheck,
  runMemoryPressureCheck,
} from '@/commands/health/checks/diagnosticsChecks';
import { runBridgeIntegrationChecks } from '@/commands/health/checks/integrationChecks';
import { runSecuritySnapshotCheck } from '@/commands/health/checks/securityChecks';

export async function runHealthChecks(options: HealthCommandOptions = {}): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  const detailedMemoryDiagnostics = options.memoryDiagnosticsEnabled === true;

  checks.push(runLoggingRepositoryCheck());
  checks.push(runStatsRepositoryCheck());
  checks.push(await runMemoryRepositoryCheck());
  checks.push(runSecuritySnapshotCheck());
  checks.push(runGatewayRegistryCheck());
  checks.push(runErrorBudgetCheck());
  checks.push(await runMemoryPressureCheck(detailedMemoryDiagnostics));
  checks.push(runAlertRoutingCheck());
  checks.push(...(await runBridgeIntegrationChecks(options)));
  checks.push(runKnowledgeLayerCheck());

  return checks;
}
