import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkerTaskStatus, type WorkerTask } from '../../../types';
import WorkerTaskDetail from '../../../components/worker/WorkerTaskDetail';

function makeTask(): WorkerTask {
  return {
    id: 'task-layout-1',
    title: 'Layout Task',
    objective: 'Check tab placement',
    status: WorkerTaskStatus.QUEUED,
    workspaceType: 'general',
    priority: 'normal',
    currentStep: 0,
    totalSteps: 3,
    resultSummary: 'VERY_LONG_SUMMARY_BLOCK',
    errorMessage: null,
    workspacePath: null,
    resumable: false,
    assignedPersonaId: null,
    planningMessages: null,
    planningComplete: false,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    steps: [],
    artifacts: [],
  };
}

describe('WorkerTaskDetail layout', () => {
  it('does not render result summary above tabs on initial view', () => {
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

    expect(html).not.toContain('VERY_LONG_SUMMARY_BLOCK');
    expect(html).toContain('📋 Schritte');
    expect(html).toContain('📄 Output');
  });
});
