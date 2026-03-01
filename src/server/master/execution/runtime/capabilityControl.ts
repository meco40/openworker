import type { MasterRun } from '@/server/master/types';
import type { Capability, CapabilityControl } from '@/server/master/execution/runtime/types';

export function buildSystemCommand(contract: string): string {
  return `echo ${JSON.stringify(contract).slice(0, 120)}`;
}

export function buildCapabilityControl(capability: Capability, run: MasterRun): CapabilityControl {
  if (capability === 'code_generation') {
    const filePath = `master-output/${run.id}-solution.md`;
    return {
      requiresApproval: true,
      actionType: 'file.write',
      fingerprint: 'file.write',
      filePath,
    };
  }
  if (capability === 'system_ops') {
    return {
      requiresApproval: true,
      actionType: 'shell.exec',
      fingerprint: 'shell.exec',
      command: buildSystemCommand(run.contract),
    };
  }
  return {
    requiresApproval: false,
    actionType: capability,
    fingerprint: capability,
  };
}
