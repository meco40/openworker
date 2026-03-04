import { AgentV2Repository } from '@/server/agent-v2/repository';
import { AgentV2ExtensionHost } from '@/server/agent-v2/extensions/host';
import { AgentV2SessionManager } from '@/server/agent-v2/session';

declare global {
  var __agentV2Repository: AgentV2Repository | undefined;
  var __agentV2ExtensionHost: AgentV2ExtensionHost | undefined;
  var __agentV2SessionManager: AgentV2SessionManager | undefined;
}

export function getAgentV2Repository(): AgentV2Repository {
  if (!globalThis.__agentV2Repository) {
    globalThis.__agentV2Repository = new AgentV2Repository();
  }
  return globalThis.__agentV2Repository;
}

export function getAgentV2ExtensionHost(): AgentV2ExtensionHost {
  if (!globalThis.__agentV2ExtensionHost) {
    globalThis.__agentV2ExtensionHost = new AgentV2ExtensionHost(getAgentV2Repository());
  }
  return globalThis.__agentV2ExtensionHost;
}

export function getAgentV2SessionManager(): AgentV2SessionManager {
  if (!globalThis.__agentV2SessionManager) {
    globalThis.__agentV2SessionManager = new AgentV2SessionManager(
      getAgentV2Repository(),
      getAgentV2ExtensionHost(),
    );
  }
  return globalThis.__agentV2SessionManager;
}
