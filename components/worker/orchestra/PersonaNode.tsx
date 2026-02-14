'use client';

import React, { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { PersonaNodeData } from '../../../src/shared/lib/orchestra-graph-converter';

function PersonaNodeComponent({ data, selected }: NodeProps & { data: PersonaNodeData }) {
  return (
    <div
      className={`orchestra-persona-node ${data.isStartNode ? 'orchestra-persona-node--start' : ''} ${selected ? 'orchestra-persona-node--selected' : ''}`}
    >
      <Handle type="target" position={Position.Top} className="orchestra-handle" />

      <div className="orchestra-persona-node__header">
        <span className="orchestra-persona-node__emoji">{data.personaEmoji}</span>
        <span className="orchestra-persona-node__name">{data.label || data.personaName}</span>
      </div>

      {data.skillIds.length > 0 && (
        <div className="orchestra-persona-node__skills">
          {data.skillIds.map((skillId) => (
            <span key={skillId} className="orchestra-persona-node__skill-badge">
              {skillId}
            </span>
          ))}
        </div>
      )}

      {data.routing && (
        <div className="orchestra-persona-node__routing-indicator">
          {data.routing.mode === 'llm' ? '🔀 LLM-Routing' : '➡️ Statisch'}
        </div>
      )}

      {data.isStartNode && <div className="orchestra-persona-node__start-badge">Start</div>}

      <Handle type="source" position={Position.Bottom} className="orchestra-handle" />
    </div>
  );
}

export const PersonaNode = memo(PersonaNodeComponent);
