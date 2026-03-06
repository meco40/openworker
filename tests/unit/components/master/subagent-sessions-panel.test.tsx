import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SubagentSessionsPanel } from '@/modules/master/components/SubagentSessionsPanel';
import type { MasterSubagentSession } from '@/modules/master/types';

function makeSession(overrides: Partial<MasterSubagentSession> = {}): MasterSubagentSession {
  return {
    id: 'session-1',
    runId: 'run-1',
    userId: 'u1',
    workspaceId: 'main',
    status: 'running',
    title: 'Research task',
    prompt: 'Investigate current API surface',
    assignedTools: ['web_search', 'fetch_url'],
    ownerId: 'worker-1',
    leaseExpiresAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    latestEventAt: new Date().toISOString(),
    resultSummary: 'Collected primary docs',
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('SubagentSessionsPanel', () => {
  it('renders sessions filtered by run id', () => {
    render(
      <SubagentSessionsPanel
        sessions={[makeSession(), makeSession({ id: 'session-2', runId: 'run-2', title: 'Other' })]}
        runId="run-1"
      />,
    );

    expect(screen.getByText('Research task')).toBeInTheDocument();
    expect(screen.queryByText('Other')).not.toBeInTheDocument();
    expect(screen.getByText('Collected primary docs')).toBeInTheDocument();
  });

  it('renders empty state when no sessions exist', () => {
    render(<SubagentSessionsPanel sessions={[]} />);
    expect(screen.getByText('No subagent sessions recorded.')).toBeInTheDocument();
  });
});
