import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MissionQueue } from '@/components/MissionQueue';
import type { Task } from '@/lib/types';

const mockTasks: Task[] = [
  {
    id: 'task-1',
    title: 'WebApp',
    status: 'pending_dispatch',
    priority: 'normal',
    assigned_agent_id: null,
    created_by_agent_id: null,
    workspace_id: 'workspace-1',
    business_id: 'business-1',
    created_at: '2026-02-25T18:00:00.000Z',
    updated_at: '2026-02-25T18:00:00.000Z',
  },
];

vi.mock('@/lib/store', () => ({
  useMissionControl: () => ({
    tasks: mockTasks,
    updateTaskStatus: vi.fn(),
    addEvent: vi.fn(),
  }),
}));

describe('MissionQueue pending dispatch rendering', () => {
  it('renders pending_dispatch tasks in mission queue columns', () => {
    const html = renderToStaticMarkup(createElement(MissionQueue, { workspaceId: 'workspace-1' }));

    expect(html).toContain('PENDING DISPATCH');
    expect(html).toContain('WebApp');
    expect(html).toContain('Retry dispatch needed');
  });
});
