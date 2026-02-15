// ─── Unit Tests: Persona Integration ─────────────────────────
// Tests for persona tool filtering and prompt building

import { describe, it, expect } from 'vitest';
import {
  parseToolsMd,
  filterToolsByPersona,
  isToolAllowed,
  buildPersonaSystemPrompt,
  type PersonaContext,
} from '../../../src/server/worker/personaIntegration';

describe('Persona Integration', () => {
  describe('parseToolsMd', () => {
    it('should return null for empty content', () => {
      expect(parseToolsMd('')).toBeNull();
      expect(parseToolsMd('   ')).toBeNull();
    });

    it('should parse simple tool list', () => {
      const content = `
- file_read
- write_file
- browser_fetch
      `;
      expect(parseToolsMd(content)).toEqual(['file_read', 'write_file', 'browser_fetch']);
    });

    it('should parse tools with asterisk', () => {
      const content = `
* shell_execute
* python_execute
      `;
      expect(parseToolsMd(content)).toEqual(['shell_execute', 'python_execute']);
    });

    it('should handle inline comments', () => {
      const content = `
- file_read # For reading files
- write_file # For writing files
      `;
      expect(parseToolsMd(content)).toEqual(['file_read', 'write_file']);
    });

    it('should return null for #all directive', () => {
      expect(parseToolsMd('# all')).toBeNull();
      expect(parseToolsMd('# default')).toBeNull();
    });

    it('should ignore headers and comments', () => {
      const content = `
# My Tools
# Only necessary tools

- file_read
- write_file

# End of list
      `;
      expect(parseToolsMd(content)).toEqual(['file_read', 'write_file']);
    });
  });

  describe('filterToolsByPersona', () => {
    const tools = [
      { function: { name: 'file_read' } },
      { function: { name: 'write_file' } },
      { function: { name: 'shell_execute' } },
      { function: { name: 'browser_fetch' } },
    ];

    it('should return all tools when allowedTools is null', () => {
      expect(filterToolsByPersona(tools, null)).toEqual(tools);
    });

    it('should return all tools when allowedTools is empty', () => {
      expect(filterToolsByPersona(tools, [])).toEqual(tools);
    });

    it('should filter tools based on allowed list', () => {
      const allowed = ['file_read', 'write_file'];
      const filtered = filterToolsByPersona(tools, allowed);
      expect(filtered).toHaveLength(2);
      expect(filtered.map((t) => t.function.name)).toEqual(['file_read', 'write_file']);
    });

    it('should return empty array if no tools match', () => {
      const allowed = ['non_existent_tool'];
      expect(filterToolsByPersona(tools, allowed)).toEqual([]);
    });
  });

  describe('isToolAllowed', () => {
    it('should allow all tools when allowedTools is null', () => {
      expect(isToolAllowed('any_tool', null)).toBe(true);
    });

    it('should allow tool in allowed list', () => {
      expect(isToolAllowed('file_read', ['file_read', 'write_file'])).toBe(true);
    });

    it('should deny tool not in allowed list', () => {
      expect(isToolAllowed('shell_execute', ['file_read', 'write_file'])).toBe(false);
    });
  });

  describe('buildPersonaSystemPrompt', () => {
    const basePrompt = 'Base: {title}, {objective}, {workspaceType}, {step}';
    const taskContext = {
      title: 'Test Task',
      objective: 'Test objective',
      workspaceType: 'general',
      step: 'Test step',
    };

    it('should replace placeholders without persona', () => {
      const personaContext: PersonaContext = {
        systemInstruction: null,
        name: null,
        emoji: null,
        vibe: null,
        allowedTools: null,
      };
      const result = buildPersonaSystemPrompt(basePrompt, personaContext, taskContext);
      expect(result).toContain('Test Task');
      expect(result).toContain('Test objective');
      expect(result).toContain('general');
      expect(result).toContain('Test step');
    });

    it('should add persona info when available', () => {
      const personaContext: PersonaContext = {
        systemInstruction: null,
        name: 'Developer',
        emoji: '👨‍💻',
        vibe: 'Professional',
        allowedTools: null,
      };
      const result = buildPersonaSystemPrompt(basePrompt, personaContext, taskContext);
      expect(result).toContain('👨‍💻 Developer');
      expect(result).toContain('Professional');
    });

    it('should add system instruction when available', () => {
      const personaContext: PersonaContext = {
        systemInstruction: 'Always write clean code.',
        name: null,
        emoji: null,
        vibe: null,
        allowedTools: null,
      };
      const result = buildPersonaSystemPrompt(basePrompt, personaContext, taskContext);
      expect(result).toContain('Always write clean code.');
    });

    it('should combine persona info and system instruction', () => {
      const personaContext: PersonaContext = {
        systemInstruction: 'Focus on security.',
        name: 'Security Expert',
        emoji: '🔒',
        vibe: 'Cautious',
        allowedTools: null,
      };
      const result = buildPersonaSystemPrompt(basePrompt, personaContext, taskContext);
      expect(result).toContain('🔒 Security Expert');
      expect(result).toContain('Cautious');
      expect(result).toContain('Focus on security.');
    });
  });
});
