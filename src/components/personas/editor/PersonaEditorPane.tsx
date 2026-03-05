'use client';

import React from 'react';
import type { PersonaEditorPaneProps } from './types';
import {
  FormHeader,
  TabNavigation,
  GatewayTabContent,
  SystemPromptSection,
  ActionButtons,
} from './components';

export function PersonaEditorPane({
  selectedPersona,
  selectedId,
  systemManaged,
  systemManagementHint,
  editingMeta,
  setEditingMeta,
  metaName,
  setMetaName,
  metaEmoji,
  setMetaEmoji,
  metaVibe,
  setMetaVibe,
  saveMeta,
  saving,
  startEditMeta,
  activePersonaId,
  setActivePersonaId,
  duplicatePersona,
  creating,
  deletePersona,
  activeTab,
  setActiveTab,
  dirty,
  setDirty,
  editorContent,
  setEditorContent,
  saveFile,
  pipelineModels,
  preferredModelId,
  onPreferredModelChange,
  savingPreferredModel,
  memoryPersonaType,
  onMemoryPersonaTypeChange,
  savingMemoryPersonaType,
  isAutonomous,
  maxToolCalls,
  onIsAutonomousChange,
  onMaxToolCallsChange,
  savingAutonomous,
}: PersonaEditorPaneProps) {
  const isGatewayTab = activeTab === 'GATEWAY';

  return (
    <>
      <FormHeader
        selectedPersona={selectedPersona}
        systemManaged={systemManaged}
        systemManagementHint={systemManagementHint}
        editingMeta={editingMeta}
        setEditingMeta={setEditingMeta}
        metaName={metaName}
        setMetaName={setMetaName}
        metaEmoji={metaEmoji}
        setMetaEmoji={setMetaEmoji}
        metaVibe={metaVibe}
        setMetaVibe={setMetaVibe}
        saveMeta={saveMeta}
        saving={saving}
        startEditMeta={startEditMeta}
        activePersonaId={activePersonaId}
        setActivePersonaId={setActivePersonaId}
        duplicatePersona={duplicatePersona}
        creating={creating}
        deletePersona={deletePersona}
      />

      <TabNavigation activeTab={activeTab} setActiveTab={setActiveTab} dirty={dirty} />

      <div className="relative flex-1">
        {isGatewayTab ? (
          <GatewayTabContent
            pipelineModels={pipelineModels}
            preferredModelId={preferredModelId}
            onPreferredModelChange={onPreferredModelChange}
            savingPreferredModel={savingPreferredModel}
            readOnly={systemManaged}
            readOnlyMessage={systemManagementHint}
            memoryPersonaType={memoryPersonaType}
            onMemoryPersonaTypeChange={onMemoryPersonaTypeChange}
            savingMemoryPersonaType={savingMemoryPersonaType}
            isAutonomous={isAutonomous}
            maxToolCalls={maxToolCalls}
            onIsAutonomousChange={onIsAutonomousChange}
            onMaxToolCallsChange={onMaxToolCallsChange}
            savingAutonomous={savingAutonomous}
          />
        ) : (
          <SystemPromptSection
            editorContent={editorContent}
            setEditorContent={setEditorContent}
            setDirty={setDirty}
            activeTab={activeTab}
            readOnly={systemManaged}
            readOnlyMessage={systemManagementHint}
          />
        )}
      </div>

      <ActionButtons
        isGatewayTab={isGatewayTab}
        dirty={dirty}
        saving={saving}
        savingPreferredModel={savingPreferredModel}
        systemManaged={systemManaged}
        systemManagementHint={systemManagementHint}
        selectedId={selectedId}
        editorContent={editorContent}
        preferredModelId={preferredModelId}
        onPreferredModelChange={onPreferredModelChange}
        saveFile={saveFile}
      />
    </>
  );
}
