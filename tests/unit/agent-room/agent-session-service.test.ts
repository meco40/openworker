import { describe, expect, it } from 'vitest';
import type { PhaseBufferEntry } from '@/server/agent-room/types';
import {
  parseAgentSessions,
  getAgentSessionEntry,
  updatePhaseBufferSessions,
  extractSpeakerFromPhaseBuffer,
} from '@/server/agent-room/services/agentSession.service';

describe('agentSession.service (typed PhaseBufferEntry)', () => {
  describe('parseAgentSessions', () => {
    it('returns empty array for empty buffer', () => {
      expect(parseAgentSessions([])).toEqual([]);
    });

    it('extracts agentsession entries from typed buffer', () => {
      const buffer: PhaseBufferEntry[] = [
        { type: 'agentsession', personaId: 'p1', sessionId: 's1', lastSeq: 5 },
        { type: 'speaker', personaId: 'p1' },
        { type: 'agentsession', personaId: 'p2', sessionId: 's2', lastSeq: 10 },
      ];
      const sessions = parseAgentSessions(buffer);
      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toEqual({ personaId: 'p1', sessionId: 's1', lastSeq: 5 });
      expect(sessions[1]).toEqual({ personaId: 'p2', sessionId: 's2', lastSeq: 10 });
    });

    it('ignores speaker entries', () => {
      const buffer: PhaseBufferEntry[] = [{ type: 'speaker', personaId: 'p1' }];
      expect(parseAgentSessions(buffer)).toEqual([]);
    });
  });

  describe('getAgentSessionEntry', () => {
    it('returns null when persona not found', () => {
      const buffer: PhaseBufferEntry[] = [
        { type: 'agentsession', personaId: 'p1', sessionId: 's1', lastSeq: 3 },
      ];
      expect(getAgentSessionEntry(buffer, 'unknown')).toBeNull();
    });

    it('returns matching session', () => {
      const buffer: PhaseBufferEntry[] = [
        { type: 'agentsession', personaId: 'p1', sessionId: 's1', lastSeq: 3 },
        { type: 'agentsession', personaId: 'p2', sessionId: 's2', lastSeq: 7 },
      ];
      expect(getAgentSessionEntry(buffer, 'p2')).toEqual({
        personaId: 'p2',
        sessionId: 's2',
        lastSeq: 7,
      });
    });
  });

  describe('updatePhaseBufferSessions', () => {
    it('adds a new session entry when persona not found', () => {
      const buffer: PhaseBufferEntry[] = [{ type: 'speaker', personaId: 'p1' }];
      const result = updatePhaseBufferSessions(buffer, {
        personaId: 'p2',
        sessionId: 's2',
        lastSeq: 0,
      });
      expect(result).toHaveLength(2);
      expect(result[1]).toEqual({
        type: 'agentsession',
        personaId: 'p2',
        sessionId: 's2',
        lastSeq: 0,
      });
    });

    it('updates existing session entry in place', () => {
      const buffer: PhaseBufferEntry[] = [
        { type: 'agentsession', personaId: 'p1', sessionId: 's1', lastSeq: 3 },
        { type: 'agentsession', personaId: 'p2', sessionId: 's2', lastSeq: 5 },
      ];
      const result = updatePhaseBufferSessions(buffer, {
        personaId: 'p1',
        sessionId: 's1',
        lastSeq: 10,
      });
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        type: 'agentsession',
        personaId: 'p1',
        sessionId: 's1',
        lastSeq: 10,
      });
      // Other entries unchanged
      expect(result[1]).toEqual(buffer[1]);
    });

    it('preserves non-agentsession entries', () => {
      const buffer: PhaseBufferEntry[] = [
        { type: 'speaker', personaId: 'p1' },
        { type: 'agentsession', personaId: 'p1', sessionId: 's1', lastSeq: 0 },
      ];
      const result = updatePhaseBufferSessions(buffer, {
        personaId: 'p1',
        sessionId: 's1',
        lastSeq: 5,
      });
      expect(result[0]).toEqual({ type: 'speaker', personaId: 'p1' });
    });
  });

  describe('extractSpeakerFromPhaseBuffer', () => {
    it('returns null for null buffer', () => {
      expect(extractSpeakerFromPhaseBuffer(null)).toBeNull();
    });

    it('returns null for empty buffer', () => {
      expect(extractSpeakerFromPhaseBuffer([])).toBeNull();
    });

    it('returns null when no speaker entry exists', () => {
      const buffer: PhaseBufferEntry[] = [
        { type: 'agentsession', personaId: 'p1', sessionId: 's1', lastSeq: 3 },
      ];
      expect(extractSpeakerFromPhaseBuffer(buffer)).toBeNull();
    });

    it('extracts speaker personaId from typed entry', () => {
      const buffer: PhaseBufferEntry[] = [
        { type: 'agentsession', personaId: 'p1', sessionId: 's1', lastSeq: 3 },
        { type: 'speaker', personaId: 'p2' },
      ];
      expect(extractSpeakerFromPhaseBuffer(buffer)).toBe('p2');
    });
  });
});
