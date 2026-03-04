'use client';

import { useState } from 'react';
import type { SwarmPhase } from '@/shared/domain/swarmPhases';
import type { SwarmRecord } from '@/modules/agent-room/swarmTypes';
import LogicGraphPanel from '../LogicGraphPanel';
import { ArtifactTab } from './ArtifactTab';
import { HistoryTab } from './HistoryTab';
import { ConflictTab } from './ConflictTab';

type CanvasTab = 'logic_graph' | 'artifact' | 'history' | 'conflict';

function canvasTabLabel(tab: CanvasTab): string {
  switch (tab) {
    case 'logic_graph':
      return 'Logic Graph';
    case 'artifact':
      return 'Artifact';
    case 'history':
      return 'History';
    case 'conflict':
      return 'Conflicts';
  }
}

interface CanvasPanelProps {
  swarm: SwarmRecord | null;
}

export function CanvasPanel({ swarm }: CanvasPanelProps) {
  const [canvasTab, setCanvasTab] = useState<CanvasTab>('logic_graph');

  return (
    <aside className="flex min-w-0 flex-1 flex-col rounded-xl border border-zinc-800 bg-[#060d20]">
      {/* Canvas tab bar */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-800 px-3 py-2">
        {(['logic_graph', 'artifact', 'history', 'conflict'] as CanvasTab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setCanvasTab(tab)}
            className={`rounded px-2 py-1 text-[10px] whitespace-nowrap transition-colors ${
              canvasTab === tab
                ? 'bg-indigo-500/30 text-indigo-100'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {canvasTabLabel(tab)}
          </button>
        ))}
      </div>

      {/* Canvas content */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {canvasTab === 'logic_graph' && (
          <LogicGraphPanel
            artifact={swarm?.artifact || ''}
            currentPhase={swarm?.currentPhase as SwarmPhase | undefined}
            swarmStatus={swarm?.status}
          />
        )}
        {canvasTab === 'artifact' && <ArtifactTab artifact={swarm?.artifact || ''} />}
        {canvasTab === 'history' && <HistoryTab artifactHistory={swarm?.artifactHistory ?? []} />}
        {canvasTab === 'conflict' && <ConflictTab friction={swarm?.friction} />}
      </div>
    </aside>
  );
}
