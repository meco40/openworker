import type { MasterRepository } from '@/server/master/repository';
import type { MasterToolForgeArtifact, WorkspaceScope } from '@/server/master/types';
import { validateToolForgeSpec } from '@/server/master/toolforge/validator';
import { runToolForgeSandboxChecks } from '@/server/master/toolforge/sandboxRunner';

export function executeToolForgePipeline(
  repo: MasterRepository,
  scope: WorkspaceScope,
  input: { name: string; spec: string; publishGlobally?: boolean; approved?: boolean },
): MasterToolForgeArtifact {
  const validation = validateToolForgeSpec(input.spec);
  if (!validation.valid) {
    throw new Error(`Invalid tool spec: ${validation.reason}`);
  }
  const sandbox = runToolForgeSandboxChecks({ name: input.name, spec: input.spec });
  const artifact = repo.createToolForgeArtifact(scope, {
    name: input.name,
    spec: input.spec,
    manifest: JSON.stringify({ name: input.name, version: '0.1.0' }),
    testSummary: sandbox.summary,
    riskReport: sandbox.riskReport,
    status: sandbox.passed ? 'awaiting_approval' : 'denied',
    publishedGlobally: false,
  });

  if (sandbox.passed && input.approved) {
    return (
      repo.updateToolForgeArtifact(scope, artifact.id, {
        status: 'published',
        publishedGlobally: Boolean(input.publishGlobally),
      }) || artifact
    );
  }
  return artifact;
}
