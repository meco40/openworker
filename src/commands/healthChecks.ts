import type { HealthCheck, HealthCommandOptions } from './healthTypes';
import {
  runGatewayRegistryCheck,
  runKnowledgeLayerCheck,
  runLoggingRepositoryCheck,
  runMemoryRepositoryCheck,
  runStatsRepositoryCheck,
} from './health/checks/coreChecks';
import {
  runAlertRoutingCheck,
  runErrorBudgetCheck,
  runMemoryPressureCheck,
} from './health/checks/diagnosticsChecks';
import { runBridgeIntegrationChecks } from './health/checks/integrationChecks';
import { runSecuritySnapshotCheck } from './health/checks/securityChecks';

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
