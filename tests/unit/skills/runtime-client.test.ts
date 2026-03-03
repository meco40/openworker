import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSkillApi } from '@/skills/runtime-client';

describe('executeSkillApi', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('successfully executes skill and returns result', async () => {
    const mockResult = { data: 'test data', timestamp: '2024-01-01' };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: mockResult }),
    });

    const result = await executeSkillApi('testSkill', { param1: 'value1' });

    expect(result).toEqual(mockResult);
    expect(global.fetch).toHaveBeenCalledWith('/api/skills/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'testSkill', args: { param1: 'value1' } }),
    });
  });

  it('handles empty args correctly', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: null }),
    });

    await executeSkillApi('testSkill');

    expect(global.fetch).toHaveBeenCalledWith('/api/skills/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'testSkill', args: {} }),
    });
  });

  it('throws error when response is not ok', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: 'Internal server error' }),
    });

    await expect(executeSkillApi('testSkill')).rejects.toThrow('Internal server error');
  });

  it('throws error when payload.ok is false', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: false, error: 'Skill execution failed' }),
    });

    await expect(executeSkillApi('testSkill')).rejects.toThrow('Skill execution failed');
  });

  it('throws generic error message when no error field in response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ ok: false }),
    });

    await expect(executeSkillApi('testSkill')).rejects.toThrow(
      'Skill testSkill failed with status 404',
    );
  });

  it('uses status-based fallback when error field is not present', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, message: 'Bad request' }),
    });

    await expect(executeSkillApi('testSkill')).rejects.toThrow(
      'Skill testSkill failed with status 400',
    );
  });

  it('uses status-based fallback when only warning field is present', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({ ok: false, warning: 'Validation warning' }),
    });

    await expect(executeSkillApi('testSkill')).rejects.toThrow(
      'Skill testSkill failed with status 422',
    );
  });

  it('handles network errors gracefully', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Network error'));

    await expect(executeSkillApi('testSkill')).rejects.toThrow('Network error');
  });

  it('handles malformed JSON response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('Invalid JSON');
      },
    });

    await expect(executeSkillApi('testSkill')).rejects.toThrow('Invalid JSON');
  });
});
