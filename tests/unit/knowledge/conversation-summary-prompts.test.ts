import { describe, it, expect } from 'vitest';
import { getSummaryPrompt, SUMMARY_PROMPTS } from '@/server/knowledge/conversationSummaryPrompts';
import type { PersonaType } from '@/server/personas/personaTypes';

describe('conversationSummaryPrompts', () => {
  it('has prompts for all persona types', () => {
    const types: PersonaType[] = ['roleplay', 'builder', 'assistant', 'general'];
    for (const type of types) {
      expect(SUMMARY_PROMPTS[type]).toBeDefined();
      expect(SUMMARY_PROMPTS[type].length).toBeGreaterThan(50);
    }
  });

  it('roleplay prompt mentions narrative and emotion', () => {
    const prompt = getSummaryPrompt('roleplay');
    expect(prompt).toContain('NARRATIVE');
    expect(prompt).toMatch(/emotion|gefuehl/i);
  });

  it('builder prompt mentions status report and project', () => {
    const prompt = getSummaryPrompt('builder');
    expect(prompt).toContain('STATUS');
    expect(prompt).toMatch(/projekt|project/i);
  });

  it('assistant prompt mentions tasks', () => {
    const prompt = getSummaryPrompt('assistant');
    expect(prompt).toMatch(/aufgabe|task/i);
  });

  it('general prompt is concise', () => {
    const prompt = getSummaryPrompt('general');
    expect(prompt.length).toBeLessThan(SUMMARY_PROMPTS.roleplay.length);
  });

  it('returns correct prompt for given persona type', () => {
    expect(getSummaryPrompt('roleplay')).toBe(SUMMARY_PROMPTS.roleplay);
    expect(getSummaryPrompt('builder')).toBe(SUMMARY_PROMPTS.builder);
  });
});
