import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PersonasSidebar } from '@/components/personas/PersonasSidebar';
import { FormHeader } from '@/components/personas/editor/components/FormHeader';
import { SystemPromptSection } from '@/components/personas/editor/components/SystemPromptSection';
import type { PersonaWithFiles } from '@/server/personas/personaTypes';

const masterPersona: PersonaWithFiles = {
  id: 'persona-master',
  name: 'Master',
  slug: 'master',
  emoji: '🧭',
  vibe: 'system',
  systemPersonaKey: 'master',
  preferredModelId: null,
  modelHubProfileId: null,
  memoryPersonaType: 'assistant',
  isAutonomous: true,
  maxToolCalls: 120,
  allowedToolFunctionNames: ['shell_execute'],
  userId: 'user-1',
  createdAt: '2026-03-05T00:00:00.000Z',
  updatedAt: '2026-03-05T00:00:00.000Z',
  files: {
    'SOUL.md': 'Master soul',
    'IDENTITY.md': '',
    'AGENTS.md': 'Master agents',
    'USER.md': 'Master user',
    'TOOLS.md': '',
    'HEARTBEAT.md': '',
  },
};

describe('system persona UI treatment', () => {
  it('shows a System badge in the personas sidebar for Master', () => {
    render(
      <PersonasSidebar
        personas={[masterPersona]}
        activePersonaId={null}
        loading={false}
        selectedId={masterPersona.id}
        onSelectPersona={() => {}}
        showTemplates={false}
        setShowTemplates={() => {}}
        creating={false}
        templates={[]}
        onCreatePersona={() => {}}
      />,
    );

    expect(screen.getByText('System')).toBeInTheDocument();
  });

  it('removes direct edit/delete affordances and points Master to Master settings', () => {
    render(
      <FormHeader
        selectedPersona={masterPersona}
        editingMeta={false}
        setEditingMeta={() => {}}
        metaName={masterPersona.name}
        setMetaName={() => {}}
        metaEmoji={masterPersona.emoji}
        setMetaEmoji={() => {}}
        metaVibe={masterPersona.vibe}
        setMetaVibe={() => {}}
        saveMeta={() => {}}
        saving={false}
        startEditMeta={() => {}}
        activePersonaId={null}
        setActivePersonaId={() => {}}
        duplicatePersona={() => {}}
        creating={false}
        deletePersona={() => {}}
        systemManaged
        systemManagementHint="Konfiguration über Master > Settings"
      />,
    );

    expect(screen.getByText('Konfiguration über Master > Settings')).toBeInTheDocument();
    expect(screen.queryByTitle('Bearbeiten')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Löschen')).not.toBeInTheDocument();
  });

  it('renders system prompt tabs read-only for Master', () => {
    const setEditorContent = vi.fn();
    const setDirty = vi.fn();

    render(
      <SystemPromptSection
        editorContent="Master soul"
        setEditorContent={setEditorContent}
        setDirty={setDirty}
        activeTab="SOUL.md"
        readOnly
        readOnlyMessage="Konfiguration über Master > Settings"
      />,
    );

    expect(screen.getByText('Konfiguration über Master > Settings')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeDisabled();
  });
});
