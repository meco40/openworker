import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkerView from '../../../WorkerView';

vi.mock('../../../src/modules/worker/hooks/useWorkerTasks', () => ({
  useWorkerTasks: () => ({
    tasks: [],
    loading: false,
    error: null,
    createTask: vi.fn(),
    cancelTask: vi.fn(),
    retryTask: vi.fn(),
    resumeTask: vi.fn(),
    approveTask: vi.fn(),
    deleteTask: vi.fn(),
    deleteAllTasks: vi.fn(),
    refreshTasks: vi.fn(),
  }),
}));

vi.mock('../../../components/worker/WorkerTaskList', () => ({
  default: () => 'task-list',
}));
vi.mock('../../../components/worker/WorkerTaskCreation', () => ({
  default: () => 'task-create',
}));
vi.mock('../../../components/worker/WorkerTaskDetail', () => ({
  default: () => 'task-detail',
}));
vi.mock('../../../components/worker/WorkerKanbanBoard', () => ({
  default: () => 'task-kanban',
}));
vi.mock('../../../components/worker/WorkerPersonaSidebar', () => ({
  default: () => 'persona-sidebar',
}));
vi.mock('../../../components/worker/WorkerOrchestraTab', () => ({
  default: () => 'orchestra-tab',
}));

describe('WorkerView settings tab', () => {
  it('renders Settings in the top view toggle', () => {
    const html = renderToStaticMarkup(createElement(WorkerView));
    expect(html).toContain('Kanban');
    expect(html).toContain('Orchestra');
    expect(html).toContain('Settings');
  });
});

