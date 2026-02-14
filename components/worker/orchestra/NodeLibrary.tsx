'use client';

import React, { type DragEvent } from 'react';
import type { PersonaInfo } from '../../../src/shared/lib/orchestra-graph-converter';

export interface NodeLibraryProps {
  personas: PersonaInfo[];
}

function handleDragStart(event: DragEvent, personaId: string): void {
  event.dataTransfer.setData('application/orchestra-persona-id', personaId);
  event.dataTransfer.effectAllowed = 'move';
}

/**
 * Left sidebar — draggable persona list.
 * Drag a persona onto the canvas to create a new node.
 */
export function NodeLibrary({ personas }: NodeLibraryProps) {
  return (
    <aside className="orchestra-node-library">
      <h3 className="orchestra-node-library__title">Personas</h3>
      <p className="orchestra-node-library__hint">
        Drag &amp; Drop auf das Canvas
      </p>
      <ul className="orchestra-node-library__list">
        {personas.map((persona) => (
          <li
            key={persona.id}
            className="orchestra-node-library__item"
            draggable
            onDragStart={(e) => handleDragStart(e, persona.id)}
          >
            <span className="orchestra-node-library__emoji">{persona.emoji}</span>
            <span className="orchestra-node-library__name">{persona.name}</span>
          </li>
        ))}
        {personas.length === 0 && (
          <li className="orchestra-node-library__empty">
            Keine Personas vorhanden
          </li>
        )}
      </ul>
    </aside>
  );
}
