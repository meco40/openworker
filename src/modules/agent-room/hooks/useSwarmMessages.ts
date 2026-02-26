'use client';

/**
 * useSwarmMessages — manages the chat message list for Agent Room swarms.
 *
 * Tracks per-swarm messages including:
 * - Phase divider messages
 * - Streaming agent turn messages (per-agent via **[Name]:** parsing)
 * - Finalized agent turns
 * - Operator messages
 *
 * Integrates with useAgentRoomRuntime via onAgentEventRef for delta streaming.
 */

import { useCallback, useRef, useState } from 'react';
import type { AgentV2EventEnvelope } from '@/server/agent-v2/types';
import {
  SWARM_PHASES,
  type SwarmPhase,
  type ResolvedSwarmUnit,
  getSwarmPhaseLabel,
} from '@/modules/agent-room/swarmPhases';
import { parseAgentTurns, type ParsedAgentTurn } from '@/modules/agent-room/agentTurnParser';

export interface SwarmMessage {
  id: string;
  /** null for system/operator messages */
  personaId: string | null;
  personaName: string;
  personaEmoji: string;
  content: string;
  phase: SwarmPhase | null;
  timestamp: string;
  /** true while the AI is still streaming this message */
  isStreaming: boolean;
  /** true for user-authored messages */
  isOperator: boolean;
  /** 'agent' | 'phase-divider' | 'operator' */
  kind: 'agent' | 'phase-divider' | 'operator';
}

interface StreamingTurn {
  messageId: string;
  commandId: string;
  content: string;
  phase: SwarmPhase | null;
}

let counter = 0;
function uid(): string {
  return `msg-${Date.now()}-${++counter}`;
}

export function useSwarmMessages() {
  const [messages, setMessages] = useState<SwarmMessage[]>([]);
  const streamingRef = useRef<Map<string, StreamingTurn>>(new Map());
  const currentSwarmIdRef = useRef<string | null>(null);

  const resetForSwarm = useCallback((swarmId: string) => {
    currentSwarmIdRef.current = swarmId;
    streamingRef.current.clear();
    setMessages([]);
  }, []);

  /**
   * Reconstruct chat history from the stored artifact when navigating back to
   * an already-running or completed swarm.
   *
   * Splits the artifact by the `---` phase dividers, maps each section to a
   * SWARM_PHASES entry, and produces phase-divider + per-persona messages.
   * Called automatically when a swarm with an existing artifact is selected.
   */
  const hydrateFromArtifact = useCallback(
    (artifact: string, units: ResolvedSwarmUnit[], leadPersonaId: string) => {
      if (!artifact.trim()) return;
      streamingRef.current.clear();

      const now = new Date().toISOString();
      const rebuilt: SwarmMessage[] = [];

      // Build reverse lookup: phase label (lowercase) → SwarmPhase
      const labelToPhase = new Map<string, SwarmPhase>();
      for (const phase of SWARM_PHASES) {
        labelToPhase.set(getSwarmPhaseLabel(phase).toLowerCase(), phase);
      }

      // Find all phase markers: --- Phase Label ---
      const phaseMarkerPattern = /^---\s*(.+?)\s*---$/gm;
      const markers: Array<{ label: string; index: number; end: number }> = [];
      let match: RegExpExecArray | null;
      while ((match = phaseMarkerPattern.exec(artifact)) !== null) {
        markers.push({
          label: match[1].trim(),
          index: match.index,
          end: match.index + match[0].length,
        });
      }

      if (markers.length === 0) {
        // Legacy artifact without phase markers — treat everything as analysis
        const turns = parseAgentTurns(artifact, units, leadPersonaId);
        if (turns.length > 0) {
          rebuilt.push({
            id: uid(),
            personaId: null,
            personaName: 'System',
            personaEmoji: '⚡',
            content: getSwarmPhaseLabel('analysis'),
            phase: 'analysis' as SwarmPhase,
            timestamp: now,
            isStreaming: false,
            isOperator: false,
            kind: 'phase-divider',
          });
          for (const turn of turns) {
            rebuilt.push({
              id: uid(),
              personaId: turn.personaId,
              personaName: turn.personaName,
              personaEmoji: turn.personaEmoji,
              content: turn.content,
              phase: 'analysis' as SwarmPhase,
              timestamp: now,
              isStreaming: false,
              isOperator: false,
              kind: 'agent',
            });
          }
        }
      } else {
        // Parse sections between phase markers
        for (let i = 0; i < markers.length; i++) {
          const marker = markers[i];
          const nextMarker = markers[i + 1];
          const sectionText = artifact
            .slice(marker.end, nextMarker ? nextMarker.index : undefined)
            .trim();
          const phase: SwarmPhase =
            labelToPhase.get(marker.label.toLowerCase()) ?? SWARM_PHASES[i] ?? 'analysis';

          // Phase divider
          rebuilt.push({
            id: uid(),
            personaId: null,
            personaName: 'System',
            personaEmoji: '⚡',
            content: getSwarmPhaseLabel(phase),
            phase,
            timestamp: now,
            isStreaming: false,
            isOperator: false,
            kind: 'phase-divider',
          });

          // Per-persona turns in this section
          if (sectionText) {
            const turns = parseAgentTurns(sectionText, units, leadPersonaId);
            for (const turn of turns) {
              rebuilt.push({
                id: uid(),
                personaId: turn.personaId,
                personaName: turn.personaName,
                personaEmoji: turn.personaEmoji,
                content: turn.content,
                phase,
                timestamp: now,
                isStreaming: false,
                isOperator: false,
                kind: 'agent',
              });
            }
          }
        }
      }

      if (rebuilt.length > 0) {
        setMessages(rebuilt);
      }
    },
    [],
  );

  const addPhaseDivider = useCallback((phase: SwarmPhase) => {
    const divider: SwarmMessage = {
      id: uid(),
      personaId: null,
      personaName: 'System',
      personaEmoji: '⚡',
      content: getSwarmPhaseLabel(phase),
      phase,
      timestamp: new Date().toISOString(),
      isStreaming: false,
      isOperator: false,
      kind: 'phase-divider',
    };
    setMessages((prev) => [...prev, divider]);
  }, []);

  const addOperatorMessage = useCallback((content: string) => {
    const msg: SwarmMessage = {
      id: uid(),
      personaId: null,
      personaName: 'You',
      personaEmoji: '👤',
      content,
      phase: null,
      timestamp: new Date().toISOString(),
      isStreaming: false,
      isOperator: true,
      kind: 'operator',
    };
    setMessages((prev) => [...prev, msg]);
  }, []);

  /**
   * Called when a new agent command starts for a swarm.
   * Adds a streaming placeholder message for the given commandId / phase.
   */
  const startAgentTurn = useCallback(
    (params: {
      commandId: string;
      personaId: string;
      personaName: string;
      personaEmoji: string;
      phase: SwarmPhase;
    }) => {
      const { commandId, personaId, personaName, personaEmoji, phase } = params;
      if (streamingRef.current.has(commandId)) return;

      const messageId = uid();
      const msg: SwarmMessage = {
        id: messageId,
        personaId,
        personaName,
        personaEmoji,
        content: '',
        phase,
        timestamp: new Date().toISOString(),
        isStreaming: true,
        isOperator: false,
        kind: 'agent',
      };
      streamingRef.current.set(commandId, { messageId, commandId, content: '', phase });
      setMessages((prev) => [...prev, msg]);
    },
    [],
  );

  /** Append a streaming token to the message being built for commandId */
  const appendToken = useCallback((commandId: string, token: string) => {
    const entry = streamingRef.current.get(commandId);
    if (!entry) return;
    const newContent = entry.content + token;
    streamingRef.current.set(commandId, { ...entry, content: newContent });
    setMessages((prev) =>
      prev.map((m) => (m.id === entry.messageId ? { ...m, content: newContent } : m)),
    );
  }, []);

  /** Finalize the streaming message for commandId (remove thinking indicator) */
  const finalizeAgentTurn = useCallback((commandId: string) => {
    const entry = streamingRef.current.get(commandId);
    if (!entry) return;
    streamingRef.current.delete(commandId);
    setMessages((prev) =>
      prev.map((m) => (m.id === entry.messageId ? { ...m, isStreaming: false } : m)),
    );
  }, []);

  /** Get current streaming content for a commandId (for parseAgentTurns) */
  const getStreamingContent = useCallback((commandId: string): string | null => {
    return streamingRef.current.get(commandId)?.content ?? null;
  }, []);

  /**
   * Replace the single streaming blob for commandId with split per-persona turns.
   * Call this on command.completed BEFORE handleAgentEvent so streamingRef still exists.
   */
  const replaceStreamingWithTurns = useCallback((commandId: string, turns: ParsedAgentTurn[]) => {
    const entry = streamingRef.current.get(commandId);
    if (!entry) return;
    streamingRef.current.delete(commandId);

    if (turns.length === 0) {
      // Fallback: just finalize the existing streaming message
      setMessages((prev) =>
        prev.map((m) => (m.id === entry.messageId ? { ...m, isStreaming: false } : m)),
      );
      return;
    }

    const now = new Date().toISOString();
    const newMessages: SwarmMessage[] = turns.map((turn) => ({
      id: uid(),
      personaId: turn.personaId,
      personaName: turn.personaName,
      personaEmoji: turn.personaEmoji,
      content: turn.content,
      phase: entry.phase,
      timestamp: now,
      isStreaming: false,
      isOperator: false,
      kind: 'agent' as const,
    }));

    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === entry.messageId);
      if (idx === -1) return [...prev, ...newMessages];
      return [...prev.slice(0, idx), ...newMessages, ...prev.slice(idx + 1)];
    });
  }, []);

  /**
   * Main event handler — wire this to useAgentRoomRuntime's onAgentEventRef.
   *
   * Tracks delta tokens + command completion. Start/finalize turns from the
   * caller when a new phase command is dispatched (via swarm status updates).
   */
  const handleAgentEvent = useCallback(
    (event: AgentV2EventEnvelope) => {
      if (event.type === 'agent.v2.model.delta') {
        const commandId = event.commandId;
        if (!commandId) return;
        const delta = String((event.payload as { delta?: unknown })?.delta || '');
        if (delta) appendToken(commandId, delta);
        return;
      }

      if (event.type === 'agent.v2.command.completed' || event.type === 'agent.v2.error') {
        const commandId = event.commandId;
        if (!commandId) return;
        finalizeAgentTurn(commandId);
        return;
      }
    },
    [appendToken, finalizeAgentTurn],
  );

  return {
    messages,
    resetForSwarm,
    hydrateFromArtifact,
    addPhaseDivider,
    addOperatorMessage,
    startAgentTurn,
    appendToken,
    finalizeAgentTurn,
    handleAgentEvent,
    getStreamingContent,
    replaceStreamingWithTurns,
  };
}
