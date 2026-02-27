import type { MasterRepository } from '@/server/master/repository';
import type { MasterCapabilityProposal, WorkspaceScope } from '@/server/master/types';
import { buildIntegrationProposalTemplate } from '@/server/master/capabilities/proposalTemplate';

export function createCapabilityApprenticeshipProposal(
  repo: MasterRepository,
  scope: WorkspaceScope,
  input: {
    capability: string;
    reason: string;
    apiReference: string;
    authModel: string;
    scopes: string[];
    rateLimit: string;
    fallbackPlan: string;
  },
): MasterCapabilityProposal {
  const proposalText = buildIntegrationProposalTemplate({
    capability: input.capability,
    reason: input.reason,
    apiReference: input.apiReference,
    authModel: input.authModel,
    scopes: input.scopes,
    rateLimit: input.rateLimit,
    fallbackPlan: input.fallbackPlan,
  });
  return repo.createCapabilityProposal(scope, {
    title: `Connector proposal: ${input.capability}`,
    capabilityKey: input.capability,
    status: 'awaiting_approval',
    proposal: proposalText,
    fallbackPlan: input.fallbackPlan,
  });
}
