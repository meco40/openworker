import { describe, it, expect } from 'vitest';
import {
  isPersonaSelfReference,
  isUserReference,
  detectFactSubject,
} from '../../../src/server/knowledge/extractor';
import { detectMemorySubject } from '../../../src/server/memory/service';
import type { MemoryNode } from '../../../core/memory/types';

describe('Self-Reference Detection', () => {
  describe('isPersonaSelfReference', () => {
    it('should detect German self-references', () => {
      expect(isPersonaSelfReference('Ich habe mit Max geschlafen')).toBe(true);
      expect(isPersonaSelfReference('Mein Bruder ist krank')).toBe(true);
      expect(isPersonaSelfReference('Meine Schwester kommt morgen')).toBe(true);
      expect(isPersonaSelfReference('Das ist mir egal')).toBe(true);
      expect(isPersonaSelfReference('Kannst du mich abholen?')).toBe(true);
    });

    it('should detect English self-references', () => {
      expect(isPersonaSelfReference('I have been to Berlin')).toBe(true);
      expect(isPersonaSelfReference('My brother is sick')).toBe(true);
      expect(isPersonaSelfReference('I am happy')).toBe(true);
    });

    it('should not detect non-self-references', () => {
      expect(isPersonaSelfReference('Du hast das gut gemacht')).toBe(false);
      expect(isPersonaSelfReference('Das Wetter ist schön')).toBe(false);
      expect(isPersonaSelfReference('Berlin ist eine Stadt')).toBe(false);
    });
  });

  describe('isUserReference', () => {
    it('should detect German user-references', () => {
      expect(isUserReference('Du hast mit Max geschlafen')).toBe(true);
      expect(isUserReference('Dein Bruder ist krank')).toBe(true);
      expect(isUserReference('Deine Schwester kommt morgen')).toBe(true);
      expect(isUserReference('Das ist dir egal')).toBe(true);
      expect(isUserReference('Ich hole dich ab')).toBe(true);
    });

    it('should detect English user-references', () => {
      expect(isUserReference('You have been to Berlin')).toBe(true);
      expect(isUserReference('Your brother is sick')).toBe(true);
      expect(isUserReference('You are happy')).toBe(true);
    });

    it('should not detect non-user-references', () => {
      expect(isUserReference('Ich habe das gut gemacht')).toBe(false);
      expect(isUserReference('Das Wetter ist schön')).toBe(false);
    });
  });

  describe('detectFactSubject', () => {
    it('should identify assistant facts', () => {
      expect(detectFactSubject('Ich habe mit Max geschlafen')).toBe('assistant');
      expect(detectFactSubject('Mein Bruder ist krank')).toBe('assistant');
      expect(detectFactSubject('I am going to Berlin')).toBe('assistant');
    });

    it('should identify user facts', () => {
      expect(detectFactSubject('Du hast mit Max geschlafen')).toBe('user');
      expect(detectFactSubject('Dein Bruder ist krank')).toBe('user');
      expect(detectFactSubject('You are going to Berlin')).toBe('user');
    });

    it('should identify conversation facts', () => {
      expect(detectFactSubject('Das Meeting war produktiv')).toBe('conversation');
      expect(detectFactSubject('Berlin ist die Hauptstadt')).toBe('conversation');
    });
  });

  describe('Memory Subject Detection', () => {
    it('should detect assistant subject from metadata', () => {
      const node: MemoryNode = {
        id: '1',
        type: 'fact',
        content: 'Ich habe gut geschlafen',
        importance: 3,
        confidence: 0.8,
        timestamp: '2024-01-01',
        metadata: { subject: 'assistant' },
      };
      expect(detectMemorySubject(node)).toBe('assistant');
    });

    it('should detect user subject from metadata', () => {
      const node: MemoryNode = {
        id: '1',
        type: 'fact',
        content: 'Du hast gut geschlafen',
        importance: 3,
        confidence: 0.8,
        timestamp: '2024-01-01',
        metadata: { subject: 'user' },
      };
      expect(detectMemorySubject(node)).toBe('user');
    });

    it('should detect self-reference from content', () => {
      const node: MemoryNode = {
        id: '1',
        type: 'fact',
        content: 'Ich habe mit Max geschlafen',
        importance: 3,
        confidence: 0.8,
        timestamp: '2024-01-01',
        metadata: {},
      };
      expect(detectMemorySubject(node)).toBe('assistant');
    });

    it('should detect user-reference from content', () => {
      const node: MemoryNode = {
        id: '1',
        type: 'fact',
        content: 'Du hast mit Max geschlafen',
        importance: 3,
        confidence: 0.8,
        timestamp: '2024-01-01',
        metadata: {},
      };
      expect(detectMemorySubject(node)).toBe('user');
    });

    it('should prioritize selfReference metadata', () => {
      const node: MemoryNode = {
        id: '1',
        type: 'fact',
        content: 'Neutral fact without pronouns',
        importance: 3,
        confidence: 0.8,
        timestamp: '2024-01-01',
        metadata: { selfReference: true },
      };
      expect(detectMemorySubject(node)).toBe('assistant');
    });
  });
});
