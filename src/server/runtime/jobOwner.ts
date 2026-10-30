export type JobOwner = 'node' | 'rust' | 'off';

/**
 * Resolves the designated owner for a background job between Node and Rust.
 * Semantics:
 * - 'rust': Rust owns the job; Node must not run it.
 * - 'node': Node owns the job; Rust must not run it.
 * - 'off': neither process runs the job.
 * Default is 'node' when unconfigured.
 * The emergency kill-switch BETACLAW_NODE_BACKGROUND_JOBS=off disables Node ownership.
 */
export function resolveJobOwner(
  envVarName: string,
  defaultValue: JobOwner = 'node',
  env: Record<string, string | undefined> = process.env,
): JobOwner {
  const raw = (env[envVarName] || '').trim().toLowerCase();
  let owner: JobOwner;

  if (raw === 'rust') {
    owner = 'rust';
  } else if (raw === 'off' || raw === 'false' || raw === '0') {
    owner = 'off';
  } else if (raw === 'node') {
    owner = 'node';
  } else {
    owner = defaultValue;
  }

  // Emergency node kill-switch: if owner resolved to node but node background jobs are disabled, force off.
  const nodeJobs = (env.BETACLAW_NODE_BACKGROUND_JOBS || '').trim().toLowerCase();
  if (owner === 'node' && (nodeJobs === 'off' || nodeJobs === 'false' || nodeJobs === '0')) {
    return 'off';
  }

  return owner;
}
