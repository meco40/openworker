import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MasterEntryPage from '@/modules/master/components/MasterEntryPage';

vi.mock('@/modules/master/components/MasterFaceCanvasThree', () => ({
  __esModule: true,
  default: () => <div data-testid="master-face-canvas">Avatar</div>,
}));

vi.mock('@/modules/master/voice/grok/useGrokVoiceAgent', () => ({
  useGrokVoiceAgent: () => ({
    status: 'idle',
    faceState: 'idle',
    amplitude: 0,
    transcript: '',
    aiResponse: '',
    error: null,
    sttSupported: true,
    ttsSupported: true,
    connected: false,
    startListening: vi.fn(async () => {}),
    stopListening: vi.fn(),
    cancel: vi.fn(),
    submitText: vi.fn(async () => {}),
    replay: vi.fn(),
    subscribeOutputAudio: () => () => {},
  }),
}));

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
}

describe('MasterEntryPage viewport behavior', () => {
  beforeEach(() => {
    setViewportWidth(1024);
  });

  it('hides 3D avatar under 380px and shows compact fallback', async () => {
    setViewportWidth(360);
    render(<MasterEntryPage onEnterDashboard={vi.fn()} personaId="p1" workspaceId="main" />);

    await waitFor(() => {
      expect(screen.queryByTestId('master-face-canvas')).not.toBeInTheDocument();
    });
    expect(screen.getByText(/3d avatar hidden on small screens/i)).toBeInTheDocument();
  });

  it('renders 3D avatar for viewports >= 380px', async () => {
    setViewportWidth(420);
    render(<MasterEntryPage onEnterDashboard={vi.fn()} personaId="p1" workspaceId="main" />);

    await waitFor(() => {
      expect(screen.getByTestId('master-face-canvas')).toBeInTheDocument();
    });
  });
});
