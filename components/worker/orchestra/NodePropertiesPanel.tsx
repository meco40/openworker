'use client';

import React, { useCallback, useState, useEffect } from 'react';
import type { Node } from '@xyflow/react';
import type {
  PersonaNodeData,
  PersonaInfo,
} from '../../../src/shared/lib/orchestra-graph-converter';
import type { OrchestraRoutingMode } from '../../../src/server/worker/orchestraGraph';

export interface SkillOption {
  id: string;
  name: string;
}

export interface NodePropertiesPanelProps {
  node: Node<PersonaNodeData> | null;
  personas: PersonaInfo[];
  skills: SkillOption[];
  allNodeIds: string[];
  onUpdate: (nodeId: string, data: Partial<PersonaNodeData>) => void;
  onSetStartNode: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
}

/**
 * Right sidebar — edit properties of the selected node.
 * Persona dropdown, skill multi-select, routing config, start-node toggle.
 */
export function NodePropertiesPanel({
  node,
  personas,
  skills,
  allNodeIds,
  onUpdate,
  onSetStartNode,
  onDeleteNode,
}: NodePropertiesPanelProps) {
  const [label, setLabel] = useState('');
  const [personaId, setPersonaId] = useState('');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [routingMode, setRoutingMode] = useState<OrchestraRoutingMode | 'none'>('none');
  const [allowedNextNodeIds, setAllowedNextNodeIds] = useState<string[]>([]);

  // Sync local state when selected node changes
  useEffect(() => {
    if (!node) return;
    setLabel(node.data.label || '');
    setPersonaId(node.data.personaId);
    setSelectedSkills(node.data.skillIds ?? []);
    setRoutingMode(node.data.routing?.mode ?? 'none');
    setAllowedNextNodeIds(node.data.routing?.allowedNextNodeIds ?? []);
  }, [node]);

  const handlePersonaChange = useCallback(
    (newPersonaId: string) => {
      if (!node) return;
      const persona = personas.find((p) => p.id === newPersonaId);
      setPersonaId(newPersonaId);
      onUpdate(node.id, {
        personaId: newPersonaId,
        personaName: persona?.name ?? newPersonaId,
        personaEmoji: persona?.emoji ?? '🤖',
      });
    },
    [node, personas, onUpdate],
  );

  const handleLabelChange = useCallback(
    (value: string) => {
      if (!node) return;
      setLabel(value);
      onUpdate(node.id, { label: value });
    },
    [node, onUpdate],
  );

  const handleSkillToggle = useCallback(
    (skillId: string) => {
      if (!node) return;
      const next = selectedSkills.includes(skillId)
        ? selectedSkills.filter((s) => s !== skillId)
        : [...selectedSkills, skillId];
      setSelectedSkills(next);
      onUpdate(node.id, { skillIds: next });
    },
    [node, selectedSkills, onUpdate],
  );

  const handleRoutingModeChange = useCallback(
    (mode: OrchestraRoutingMode | 'none') => {
      if (!node) return;
      setRoutingMode(mode);
      if (mode === 'none') {
        onUpdate(node.id, { routing: undefined });
      } else {
        onUpdate(node.id, {
          routing: {
            mode,
            allowedNextNodeIds: mode === 'llm' ? allowedNextNodeIds : undefined,
          },
        });
      }
    },
    [node, allowedNextNodeIds, onUpdate],
  );

  const handleAllowedNodeToggle = useCallback(
    (targetNodeId: string) => {
      if (!node) return;
      const next = allowedNextNodeIds.includes(targetNodeId)
        ? allowedNextNodeIds.filter((id) => id !== targetNodeId)
        : [...allowedNextNodeIds, targetNodeId];
      setAllowedNextNodeIds(next);
      onUpdate(node.id, {
        routing: {
          mode: routingMode === 'none' ? 'static' : routingMode,
          allowedNextNodeIds: next,
        },
      });
    },
    [node, allowedNextNodeIds, routingMode, onUpdate],
  );

  if (!node) {
    return (
      <aside className="orchestra-properties-panel orchestra-properties-panel--empty">
        <p className="orchestra-properties-panel__placeholder">
          Knoten auswählen um Eigenschaften zu bearbeiten
        </p>
      </aside>
    );
  }

  const otherNodes = allNodeIds.filter((id) => id !== node.id);

  return (
    <aside className="orchestra-properties-panel">
      <h3 className="orchestra-properties-panel__title">Knoten-Eigenschaften</h3>

      {/* Label */}
      <div className="orchestra-properties-panel__field">
        <label className="orchestra-properties-panel__label">Bezeichnung</label>
        <input
          className="orchestra-properties-panel__input"
          type="text"
          value={label}
          onChange={(e) => handleLabelChange(e.target.value)}
          placeholder="Knotenname"
        />
      </div>

      {/* Persona */}
      <div className="orchestra-properties-panel__field">
        <label className="orchestra-properties-panel__label">Persona</label>
        <select
          className="orchestra-properties-panel__select"
          value={personaId}
          onChange={(e) => handlePersonaChange(e.target.value)}
        >
          <option value="">— Persona wählen —</option>
          {personas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.emoji} {p.name}
            </option>
          ))}
        </select>
      </div>

      {/* Skills */}
      <div className="orchestra-properties-panel__field">
        <label className="orchestra-properties-panel__label">Skills</label>
        <div className="orchestra-properties-panel__checkbox-group">
          {skills.map((skill) => (
            <label key={skill.id} className="orchestra-properties-panel__checkbox-label">
              <input
                type="checkbox"
                checked={selectedSkills.includes(skill.id)}
                onChange={() => handleSkillToggle(skill.id)}
              />
              {skill.name}
            </label>
          ))}
          {skills.length === 0 && (
            <span className="orchestra-properties-panel__muted">Keine Skills installiert</span>
          )}
        </div>
      </div>

      {/* Routing */}
      <div className="orchestra-properties-panel__field">
        <label className="orchestra-properties-panel__label">Routing</label>
        <select
          className="orchestra-properties-panel__select"
          value={routingMode}
          onChange={(e) => handleRoutingModeChange(e.target.value as OrchestraRoutingMode | 'none')}
        >
          <option value="none">Kein Routing</option>
          <option value="static">Statisch (feste Reihenfolge)</option>
          <option value="llm">LLM-Routing (KI-gesteuert)</option>
        </select>
      </div>

      {/* Allowed next nodes (for LLM routing) */}
      {routingMode === 'llm' && otherNodes.length > 0 && (
        <div className="orchestra-properties-panel__field">
          <label className="orchestra-properties-panel__label">Erlaubte Zielknoten</label>
          <div className="orchestra-properties-panel__checkbox-group">
            {otherNodes.map((id) => (
              <label key={id} className="orchestra-properties-panel__checkbox-label">
                <input
                  type="checkbox"
                  checked={allowedNextNodeIds.includes(id)}
                  onChange={() => handleAllowedNodeToggle(id)}
                />
                {id}
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="orchestra-properties-panel__actions">
        {!node.data.isStartNode && (
          <button
            className="orchestra-properties-panel__btn orchestra-properties-panel__btn--start"
            onClick={() => onSetStartNode(node.id)}
          >
            Als Startknoten setzen
          </button>
        )}
        <button
          className="orchestra-properties-panel__btn orchestra-properties-panel__btn--delete"
          onClick={() => onDeleteNode(node.id)}
        >
          Knoten löschen
        </button>
      </div>
    </aside>
  );
}
