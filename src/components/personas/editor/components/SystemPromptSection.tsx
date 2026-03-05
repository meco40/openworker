'use client';

import React from 'react';
import { TAB_LABELS } from '@/components/personas/personaLabels';
import type { SystemPromptSectionProps } from '../types';

export function SystemPromptSection({
  editorContent,
  setEditorContent,
  setDirty,
  activeTab,
  readOnly = false,
  readOnlyMessage,
}: SystemPromptSectionProps) {
  const activeFile = activeTab === 'GATEWAY' ? null : activeTab;

  return (
    <div className="absolute inset-0 flex h-full w-full flex-col bg-zinc-950">
      {readOnlyMessage && (
        <div className="border-b border-amber-500/20 bg-amber-500/10 px-6 py-3 text-sm text-amber-200">
          {readOnlyMessage}
        </div>
      )}
      <textarea
        value={editorContent}
        onChange={(event) => {
          if (readOnly) return;
          setEditorContent(event.target.value);
          setDirty(true);
        }}
        disabled={readOnly}
        readOnly={readOnly}
        className="h-full w-full flex-1 resize-none bg-zinc-950 p-6 font-mono text-sm leading-relaxed text-zinc-200 placeholder:text-zinc-700 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
        placeholder={`# ${activeFile ? TAB_LABELS[activeFile] : ''}\n\nSchreibe hier die ${activeFile ? TAB_LABELS[activeFile] : ''}-Definition für deine Persona...`}
        spellCheck={false}
      />
    </div>
  );
}
