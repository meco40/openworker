'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { buildLogicGraphSource } from '@/modules/agent-room/logicGraph';
import type { SwarmPhase } from '@/modules/agent-room/swarmPhases';

interface LogicGraphPanelProps {
  artifact: string;
  currentPhase?: SwarmPhase;
  swarmStatus?: string;
}

export default function LogicGraphPanel({
  artifact,
  currentPhase,
  swarmStatus,
}: LogicGraphPanelProps) {
  const source = useMemo(
    () =>
      buildLogicGraphSource(
        artifact,
        currentPhase
          ? {
              phase: currentPhase,
              currentPhase,
              status: swarmStatus ?? 'running',
            }
          : undefined,
      ),
    [artifact, currentPhase, swarmStatus],
  );
  const [svg, setSvg] = useState<string>('');
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function renderGraph() {
      if (!source) {
        setSvg('');
        setRenderError(null);
        return;
      }
      try {
        const mermaidModule = await import('mermaid');
        const mermaid = mermaidModule.default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'dark',
          themeVariables: {
            fontSize: '18px',
          },
        });
        const id = `agent-room-graph-${Math.random().toString(36).slice(2, 10)}`;
        const result = await mermaid.render(id, source);
        if (!cancelled) {
          setSvg(result.svg);
          setRenderError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setSvg('');
          setRenderError(error instanceof Error ? error.message : 'Graph rendering failed.');
        }
      }
    }
    void renderGraph();
    return () => {
      cancelled = true;
    };
  }, [source]);

  return (
    <div className="rounded-xl border border-zinc-800 bg-[#060b18] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-xs font-semibold tracking-widest text-cyan-200 uppercase">
          Swarm Diagram
        </h4>
        <span className="rounded border border-indigo-500/40 px-2 py-0.5 text-[10px] text-indigo-300">
          {source?.startsWith('flowchart') ? 'Auto-generated' : 'AI-generated'}
        </span>
      </div>
      <div className="min-h-[42rem] rounded-lg border border-zinc-800 bg-[#020611] p-3">
        {svg ? (
          <div
            className="flex min-h-[38rem] justify-center overflow-auto [&_svg]:h-full [&_svg]:w-full [&_svg]:max-w-none"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="flex min-h-[38rem] items-center justify-center text-xs text-zinc-500">
            {renderError || 'Kein Diagramm verfügbar. Wird nach der Result-Phase generiert.'}
          </div>
        )}
      </div>
    </div>
  );
}
