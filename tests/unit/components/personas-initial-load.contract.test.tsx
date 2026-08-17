import { act, renderHook, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePersonaTemplates } from '@/components/personas/hooks/usePersonaTemplates';
import { usePipelineModels } from '@/components/personas/hooks/usePipelineModels';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('personas initial load contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not request persona templates until the template panel is opened', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        templates: [{ id: 'blank', name: 'Blank', emoji: 'B', vibe: 'test' }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePersonaTemplates());

    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      result.current.setShowTemplates(true);
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/personas/templates');
    expect(result.current.templates).toEqual([
      { id: 'blank', name: 'Blank', emoji: 'B', vibe: 'test' },
    ]);

    await act(async () => {
      result.current.setShowTemplates(false);
    });
    await act(async () => {
      result.current.setShowTemplates(true);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('dedupes pipeline model requests after the first successful load', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        models: [{ id: 'model-1', displayName: 'Model 1', provider: 'test' }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePipelineModels());

    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.loadPipelineModels();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/model-hub/pipeline');
    expect(result.current.pipelineModels).toEqual([
      { id: 'model-1', displayName: 'Model 1', provider: 'test' },
    ]);

    await act(async () => {
      await result.current.loadPipelineModels();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps model-hub pipeline loading out of the initial personas view', () => {
    const personasView = read('src/components/PersonasView.tsx');

    expect(personasView).toContain("activeTab !== 'GATEWAY'");
    expect(personasView).toContain('void loadPipelineModels();');
    expect(personasView).not.toContain('useEffect(() => {\n    loadPipelineModels();');
  });
});
