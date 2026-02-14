import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkerWorkflowTab from '../../../components/worker/WorkerWorkflowTab';
import WorkerTaskDetail from '../../../components/worker/WorkerTaskDetail';
import type { WorkerTask } from '../../../types';

vi.mock('../../../src/modules/worker/hooks/useWorkerWorkflow', () => ({
  useWorkerWorkflow: () => ({
    workflow: {
      taskId: 'task-1',
      runId: 'run-1',
      flowPublishedId: 'flow-1',
      currentNodeId: 'n2',
      timestamp: new Date().toISOString(),
      activePath: ['n1', 'n2'],
      edges: [{ from: 'n1', to: 'n2' }],
      nodes: [
        { id: 'n1', personaId: 'persona-research', status: 'completed' },
        { id: 'n2', personaId: 'persona-review', status: 'running' },
      ],
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

function makeTask(): WorkerTask {
  return {
    id: 'task-1',
    title: 'Workflow Task',
    objective: 'Check workflow tab rendering',
    status: 'executing' as WorkerTask['status'],
    workspaceType: 'general',
    priority: 'normal',
    currentStep: 0,
    totalSteps: 0,
    resultSummary: null,
    errorMessage: null,
    workspacePath: null,
    resumable: false,
    assignedPersonaId: null,
    planningMessages: null,
    planningComplete: false,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  };
}

describe('worker workflow tab', () => {
  it('renders live graph panel in standalone workflow tab', () => {
    const html = renderToStaticMarkup(createElement(WorkerWorkflowTab, { taskId: 'task-1' }));
    expect(html).toContain('Live-Graph (aktueller Run)');
    expect(html).toContain('Master steuert den Ablauf');
    expect(html).toContain('n1');
    expect(html).toContain('n2');
  });

  it('renders workflow tab button in task detail', () => {
    const html = renderToStaticMarkup(
      createElement(WorkerTaskDetail, {
        task: makeTask(),
        onBack: () => {},
        onCancel: () => {},
        onRetry: () => {},
        onResume: () => {},
        onApprove: () => {},
        onDelete: () => {},
      }),
    );
    expect(html).toContain('🧭 Workflow');
  });
});
