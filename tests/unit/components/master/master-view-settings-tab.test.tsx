import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MasterView from '@/modules/master/components/MasterView';
import type { MockProcedure } from '../../../helpers/mockProcedure';

const mockView = {
  masterMode: 'system' as 'system' | 'legacy',
  masterPersona: {
    id: 'master-1',
    name: 'Master',
    slug: 'master',
    emoji: '🧭',
    systemPersonaKey: 'master',
  },
  masterSettings: {
    persona: {
      id: 'master-1',
      name: 'Master',
      slug: 'master',
      emoji: '🧭',
      systemPersonaKey: 'master',
    },
    runtimeSettings: {
      preferredModelId: 'gpt-4o-mini',
      modelHubProfileId: 'ops-team',
      isAutonomous: true,
      maxToolCalls: 120,
    },
    allowedToolFunctionNames: ['shell_execute', 'web_search'],
    toolPolicy: {
      security: 'allowlist' as const,
      ask: 'on_miss' as const,
      allowlist: [],
    },
    instructionFiles: {
      'SOUL.md': 'Master soul',
      'AGENTS.md': 'Master agents',
      'USER.md': 'Master user',
    },
  },
  availablePersonas: [
    {
      id: 'master-1',
      name: 'Master',
      slug: 'master',
      emoji: '🧭',
      systemPersonaKey: 'master',
    },
  ],
  workspaces: [{ id: 'main', name: 'Main', slug: 'main' }],
  runs: [],
  approvalRequests: [],
  subagentSessions: [],
  reminders: [],
  paginatedRuns: [],
  runsPage: 0,
  totalRunPages: 1,
  selectedRun: null,
  selectedRunDetail: null,
  metrics: null,
  exportBundle: null,
  eventsConnected: false,
  loading: false,
  loadingAction: null,
  statusMessage: null,
  hasActiveRuns: false,
  hasPendingApprovals: false,
  selectedPersonaId: 'master-1',
  workspaceId: 'main',
  runTitle: 'New Master Contract',
  runContract: '',
  selectedRunId: null,
  setSelectedPersonaId: vi.fn<MockProcedure>(),
  setWorkspaceId: vi.fn<MockProcedure>(),
  setRunTitle: vi.fn<MockProcedure>(),
  setRunContract: vi.fn<MockProcedure>(),
  setSelectedRunId: vi.fn<MockProcedure>(),
  setRunsPage: vi.fn<MockProcedure>(),
  dismissStatus: vi.fn<MockProcedure>(),
  createRun: vi.fn<() => Promise<void>>(async () => {}),
  startRun: vi.fn<() => Promise<void>>(async () => {}),
  exportRun: vi.fn<() => Promise<void>>(async () => {}),
  cancelRun: vi.fn<() => Promise<void>>(async () => {}),
  submitDecision: vi.fn<() => Promise<void>>(async () => {}),
  decideApproval: vi.fn<() => Promise<void>>(async () => {}),
  submitFeedback: vi.fn<() => Promise<{ ok: true }>>(async () => ({ ok: true as const })),
  saveSettings: vi.fn<() => Promise<void>>(async () => {}),
  dismissExportBundle: vi.fn<MockProcedure>(),
  refreshAll: vi.fn<() => Promise<void>>(async () => {}),
};

vi.mock('@/modules/master/hooks/useMasterView', () => ({
  useMasterView: () => mockView,
}));

vi.mock('@/modules/master/components/MasterEntryPage', () => ({
  default: ({ onEnterDashboard }: { onEnterDashboard: () => void }) => (
    <button type="button" onClick={onEnterDashboard}>
      Open Dashboard
    </button>
  ),
}));

describe('MasterView settings tab', () => {
  it('renders the fixed Master persona and opens the settings tab', () => {
    render(<MasterView />);

    fireEvent.click(screen.getByRole('button', { name: /open dashboard/i }));

    expect(screen.getByText(/system persona managed via settings/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /settings/i }));
    expect(screen.getByText(/manage the fixed master persona/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Master soul')).toBeInTheDocument();
  });

  it('hides the settings tab while Master runs in legacy persona mode', () => {
    mockView.masterMode = 'legacy';

    render(<MasterView />);

    fireEvent.click(screen.getByRole('button', { name: /open dashboard/i }));

    expect(screen.queryByRole('tab', { name: /settings/i })).not.toBeInTheDocument();
    expect(screen.getByText(/legacy mode/i)).toBeInTheDocument();

    mockView.masterMode = 'system';
  });
});
