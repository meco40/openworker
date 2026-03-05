'use client';

import React from 'react';
import type {
  ModelConfigSectionProps,
  MemoryTypeSectionProps,
  AutonomousConfigSectionProps,
} from '../types';
import { ModelConfigSection } from './ModelConfigSection';
import { MemoryTypeSection } from './MemoryTypeSection';
import { AutonomousConfigSection } from './AutonomousConfigSection';

interface GatewayTabContentProps
  extends ModelConfigSectionProps, MemoryTypeSectionProps, AutonomousConfigSectionProps {}

export function GatewayTabContent({
  pipelineModels,
  preferredModelId,
  onPreferredModelChange,
  savingPreferredModel,
  readOnly,
  readOnlyMessage,
  memoryPersonaType,
  onMemoryPersonaTypeChange,
  savingMemoryPersonaType,
  isAutonomous,
  maxToolCalls,
  onIsAutonomousChange,
  onMaxToolCallsChange,
  savingAutonomous,
}: GatewayTabContentProps) {
  return (
    <div className="absolute inset-0 h-full w-full overflow-auto bg-zinc-950 p-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="space-y-2">
          <h4 className="text-lg font-bold text-white">Gateway Konfiguration</h4>
          <p className="text-sm text-zinc-400">
            Wähle das bevorzugte Modell für diese Persona. Das bevorzugte Modell wird zuerst
            versucht. Bei Rate-Limit oder Fehler wird automatisch auf die anderen aktiven Modelle in
            der Pipeline ausgewichen.
          </p>
        </div>

        <ModelConfigSection
          pipelineModels={pipelineModels}
          preferredModelId={preferredModelId}
          onPreferredModelChange={onPreferredModelChange}
          savingPreferredModel={savingPreferredModel}
          readOnly={readOnly}
          readOnlyMessage={readOnlyMessage}
        />

        <MemoryTypeSection
          memoryPersonaType={memoryPersonaType}
          onMemoryPersonaTypeChange={onMemoryPersonaTypeChange}
          savingMemoryPersonaType={savingMemoryPersonaType}
          readOnly={readOnly}
          readOnlyMessage={readOnlyMessage}
        />

        <AutonomousConfigSection
          isAutonomous={isAutonomous}
          maxToolCalls={maxToolCalls}
          onIsAutonomousChange={onIsAutonomousChange}
          onMaxToolCallsChange={onMaxToolCallsChange}
          savingAutonomous={savingAutonomous}
          readOnly={readOnly}
          readOnlyMessage={readOnlyMessage}
        />
      </div>
    </div>
  );
}
