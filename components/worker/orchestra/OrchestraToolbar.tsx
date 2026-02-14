'use client';

import React from 'react';

export interface OrchestraToolbarProps {
  flowName: string;
  isDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onAutoLayout: () => void;
  onSave: () => void;
  onPublish: () => void;
  onDelete: () => void;
  saving?: boolean;
  publishing?: boolean;
}

/**
 * Top toolbar — flow name, undo/redo, auto-layout, save, publish, delete.
 */
export function OrchestraToolbar({
  flowName,
  isDirty,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onAutoLayout,
  onSave,
  onPublish,
  onDelete,
  saving = false,
  publishing = false,
}: OrchestraToolbarProps) {
  return (
    <div className="orchestra-toolbar">
      <div className="orchestra-toolbar__left">
        <span className="orchestra-toolbar__flow-name">
          {flowName}
          {isDirty && <span className="orchestra-toolbar__dirty-dot" title="Ungespeicherte Änderungen">●</span>}
        </span>
      </div>

      <div className="orchestra-toolbar__center">
        <button
          className="orchestra-toolbar__btn"
          onClick={onUndo}
          disabled={!canUndo}
          title="Rückgängig (Ctrl+Z)"
        >
          ↩ Undo
        </button>
        <button
          className="orchestra-toolbar__btn"
          onClick={onRedo}
          disabled={!canRedo}
          title="Wiederholen (Ctrl+Shift+Z)"
        >
          ↪ Redo
        </button>
        <span className="orchestra-toolbar__separator" />
        <button
          className="orchestra-toolbar__btn"
          onClick={onAutoLayout}
          title="Automatisches Layout"
        >
          ⊞ Layout
        </button>
      </div>

      <div className="orchestra-toolbar__right">
        <button
          className="orchestra-toolbar__btn orchestra-toolbar__btn--save"
          onClick={onSave}
          disabled={saving || !isDirty}
        >
          {saving ? 'Speichern…' : '💾 Speichern'}
        </button>
        <button
          className="orchestra-toolbar__btn orchestra-toolbar__btn--publish"
          onClick={onPublish}
          disabled={publishing || isDirty}
          title={isDirty ? 'Zuerst speichern' : 'Flow veröffentlichen'}
        >
          {publishing ? 'Veröffentlichen…' : '🚀 Veröffentlichen'}
        </button>
        <button
          className="orchestra-toolbar__btn orchestra-toolbar__btn--delete"
          onClick={onDelete}
          title="Flow löschen"
        >
          🗑️
        </button>
      </div>
    </div>
  );
}
