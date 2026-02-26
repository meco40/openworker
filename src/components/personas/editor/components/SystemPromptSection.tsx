'use client';

import React from 'react';
import { TAB_LABELS } from '@/components/personas/personaLabels';
import type { SystemPromptSectionProps } from '../types';

export function SystemPromptSection({
  editorContent,
  setEditorContent,
  setDirty,
  activeTab,
}: SystemPromptSectionProps) {
  const activeFile = activeTab === 'GATEWAY' ? null : activeTab;

  return (
    <textarea
      value={editorContent}
      onChange={(event) => {
        setEditorContent(event.target.value);
        setDirty(true);
      }}
      className="absolute inset-0 h-full w-full resize-none bg-zinc-950 p-6 font-mono text-sm leading-relaxed text-zinc-200 placeholder:text-zinc-700 focus:outline-none"
      placeholder={`# ${activeFile ? TAB_LABELS[activeFile] : ''}\n\nSchreibe hier die ${activeFile ? TAB_LABELS[activeFile] : ''}-Definition für deine Persona...`}
      spellCheck={false}
    />
  );
}
