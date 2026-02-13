import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkerWorkflowTab from '../../../components/worker/WorkerWorkflowTab';
import WorkerTaskDetail from '../../../components/worker/WorkerTaskDetail';
import type { WorkerTask } from '../../../types';

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
  it('renders loading placeholder in standalone workflow tab', () => {
    const html = renderToStaticMarkup(React.createElement(WorkerWorkflowTab, { taskId: 'task-1' }));
    expect(html).toContain('Workflow wird geladen');
  });

  it('renders workflow tab button in task detail', () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkerTaskDetail, {
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
