import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalQueuePanel } from '@/modules/master/components/ApprovalQueuePanel';
import type { MasterApprovalRequest } from '@/modules/master/types';

function makeApproval(overrides: Partial<MasterApprovalRequest> = {}): MasterApprovalRequest {
  return {
    id: 'approval-1',
    runId: 'run-1',
    stepId: 'step-1',
    userId: 'u1',
    workspaceId: 'main',
    toolName: 'shell_execute',
    actionType: 'shell.exec',
    summary: 'Shell command requires approval',
    prompt: 'Run npm test',
    host: 'gateway',
    cwd: 'D:/web/clawtest',
    resolvedPath: null,
    fingerprint: 'shell.exec:run:npm-test',
    riskLevel: 'medium',
    status: 'pending',
    expiresAt: new Date().toISOString(),
    decision: null,
    decisionReason: null,
    decidedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('ApprovalQueuePanel', () => {
  it('renders pending approvals and applies decisions', () => {
    const onDecide = vi.fn();
    render(<ApprovalQueuePanel approvals={[makeApproval()]} loading={false} onDecide={onDecide} />);

    expect(screen.getByText('Shell command requires approval')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve Once' }));
    expect(onDecide).toHaveBeenCalledWith('approval-1', 'approve_once');
  });

  it('renders empty state when no approvals are pending', () => {
    render(
      <ApprovalQueuePanel
        approvals={[makeApproval({ status: 'approved', decision: 'approve_once' })]}
        loading={false}
        onDecide={() => {}}
      />,
    );

    expect(screen.getByText('No pending approvals.')).toBeInTheDocument();
  });
});
