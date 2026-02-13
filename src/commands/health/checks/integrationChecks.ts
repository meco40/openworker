import type { HealthCheck, HealthCommandOptions } from '../../healthTypes';
import { runBridgeHealthCheck } from '../checkHelpers';

export async function runBridgeIntegrationChecks(
  options: HealthCommandOptions,
): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  checks.push(
    await runBridgeHealthCheck(
      'integration.whatsapp_bridge',
      'whatsapp',
      'WHATSAPP_BRIDGE_URL',
      options,
    ),
  );
  checks.push(
    await runBridgeHealthCheck(
      'integration.imessage_bridge',
      'imessage',
      'IMESSAGE_BRIDGE_URL',
      options,
    ),
  );
  return checks;
}
