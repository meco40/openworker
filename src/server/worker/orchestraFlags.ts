function isEnabled(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function isWorkerOrchestraEnabled(): boolean {
  return isEnabled(process.env.WORKER_ORCHESTRA_ENABLED, true);
}

export function isWorkerOrchestraBuilderWriteEnabled(): boolean {
  return isEnabled(process.env.WORKER_ORCHESTRA_BUILDER_WRITE_ENABLED, true);
}

export function isWorkerWorkflowTabEnabled(): boolean {
  return isEnabled(process.env.WORKER_WORKFLOW_TAB_ENABLED, true);
}
