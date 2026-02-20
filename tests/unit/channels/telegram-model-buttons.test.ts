import { describe, expect, it } from 'vitest';
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  parseModelCallbackData,
} from '../../../src/server/channels/telegram/modelButtons';

describe('telegram model buttons', () => {
  it('parses provider list callbacks', () => {
    expect(parseModelCallbackData('mdl_prov')).toEqual({ type: 'providers' });
    expect(parseModelCallbackData('mdl_back')).toEqual({ type: 'back' });
  });

  it('parses provider page callbacks', () => {
    expect(parseModelCallbackData('mdl_list_openai_2')).toEqual({
      type: 'list',
      provider: 'openai',
      page: 2,
    });
  });

  it('parses model selection callbacks', () => {
    expect(parseModelCallbackData('mdl_sel_openai/gpt-4o')).toEqual({
      type: 'select',
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  it('builds compact provider rows with 2 buttons per row', () => {
    const rows = buildProviderKeyboard([
      { id: 'openai', count: 2 },
      { id: 'gemini', count: 5 },
      { id: 'anthropic', count: 1 },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(2);
    expect(rows[1]).toHaveLength(1);
  });

  it('builds model pages with a back row', () => {
    const rows = buildModelsKeyboard({
      provider: 'openai',
      models: ['gpt-4o', 'gpt-4.1'],
      currentModel: 'gpt-4o',
      currentPage: 1,
      totalPages: 1,
    });

    expect(rows.some((row) => row.some((button) => button.callback_data === 'mdl_back'))).toBe(
      true,
    );
  });

  it('calculates pages with minimum 1', () => {
    expect(calculateTotalPages(0, 8)).toBe(1);
    expect(calculateTotalPages(17, 8)).toBe(3);
  });
});
