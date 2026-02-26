'use client';

/**
 * useSwarmExport — export and query utilities for swarm data.
 */

import { useCallback } from 'react';
import type { SwarmRecord } from '@/modules/agent-room/swarmTypes';
import type { PersonaSummary } from '@/server/personas/personaTypes';

export function useSwarmExport(swarms: SwarmRecord[], personas: PersonaSummary[]) {
  const exportRunJson = useCallback(
    (swarmId: string): string | null => {
      const swarm = swarms.find((item) => item.id === swarmId);
      if (!swarm) return null;

      const participants = swarm.units.map((unit) => {
        const persona = personas.find((p) => p.id === unit.personaId);
        return {
          personaId: unit.personaId,
          name: persona?.name ?? 'Unknown',
          role: unit.role,
        };
      });

      const turnPattern = /\*\*\[([^\]]+)\]:\*\*\s*([\s\S]*?)(?=\*\*\[[^\]]+\]:\*\*|$)/g;
      const turns: Array<{ speaker: string; content: string }> = [];
      let tm: RegExpExecArray | null;
      const artifactText = swarm.artifact || '';
      while ((tm = turnPattern.exec(artifactText))) {
        turns.push({ speaker: tm[1].trim(), content: tm[2].trim() });
      }

      const leadPersona = personas.find((p) => p.id === swarm.leadPersonaId);
      const exportData = {
        id: swarm.id,
        title: swarm.title,
        task: swarm.task,
        status: swarm.status,
        currentPhase: swarm.currentPhase,
        consensusScore: swarm.consensusScore,
        leadPersona: leadPersona
          ? { id: leadPersona.id, name: leadPersona.name }
          : { id: swarm.leadPersonaId, name: 'Unknown' },
        participants,
        artifact: swarm.artifact,
        turns,
        friction: swarm.friction,
        createdAt: swarm.createdAt,
        updatedAt: swarm.updatedAt,
      };
      return JSON.stringify(exportData, null, 2);
    },
    [swarms, personas],
  );

  /**
   * Export swarm run as formatted Markdown document.
   */
  const exportRunMarkdown = useCallback(
    (swarmId: string): string | null => {
      const swarm = swarms.find((item) => item.id === swarmId);
      if (!swarm) return null;

      const leadPersona = personas.find((p) => p.id === swarm.leadPersonaId);
      const lines: string[] = [
        `# ${swarm.title}`,
        '',
        `**Task:** ${swarm.task}`,
        `**Status:** ${swarm.status} | **Phase:** ${swarm.currentPhase} | **Consensus:** ${swarm.consensusScore}%`,
        `**Lead:** ${leadPersona?.name ?? swarm.leadPersonaId}`,
        '',
        '## Participants',
        '',
      ];

      for (const unit of swarm.units) {
        const persona = personas.find((p) => p.id === unit.personaId);
        lines.push(
          `- ${persona?.emoji ?? '🤖'} **${persona?.name ?? unit.personaId}** — ${unit.role}`,
        );
      }

      lines.push('', '## Discussion', '');

      if (swarm.artifact) {
        lines.push(swarm.artifact);
      } else {
        lines.push('_No discussion yet._');
      }

      if (swarm.friction.reasons.length > 0) {
        lines.push('', '## Friction Signals', '');
        for (const reason of swarm.friction.reasons) {
          lines.push(`- ${reason}`);
        }
      }

      lines.push('', '---', `_Exported: ${new Date().toISOString()}_`);
      return lines.join('\n');
    },
    [swarms, personas],
  );

  return { exportRunJson, exportRunMarkdown };
}
