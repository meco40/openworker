'use client';

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { buildLogicGraphSource } from '@/modules/agent-room/logicGraph';
import type { SwarmPhase } from '@/modules/agent-room/swarmPhases';

interface LogicGraphPanelProps {
  artifact: string;
  currentPhase?: SwarmPhase;
  swarmStatus?: string;
}

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

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
  const [zoom, setZoom] = useState(1);
  const svgContainerRef = useRef<HTMLDivElement>(null);

  const zoomIn = useCallback(() => setZoom((z) => Math.min(z + ZOOM_STEP, ZOOM_MAX)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(z - ZOOM_STEP, ZOOM_MIN)), []);
  const zoomReset = useCallback(() => setZoom(1), []);

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

  // Inject SVG into DOM via ref instead of dangerouslySetInnerHTML
  useEffect(() => {
    const container = svgContainerRef.current;
    if (!container) return;
    container.innerHTML = '';
    if (svg) {
      const template = document.createElement('template');
      template.innerHTML = svg;
      container.appendChild(template.content);
    }
  }, [svg]);

  return (
    <div className="rounded-xl border border-zinc-800 bg-[#060b18] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-xs font-semibold tracking-widest text-cyan-200 uppercase">
          Swarm Diagram
        </h4>
        <div className="flex items-center gap-1.5">
          {svg && (
            <>
              <button
                onClick={zoomOut}
                disabled={zoom <= ZOOM_MIN}
                className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
                title="Zoom out"
              >
                −
              </button>
              <button
                onClick={zoomReset}
                className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                title="Reset zoom"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                onClick={zoomIn}
                disabled={zoom >= ZOOM_MAX}
                className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
                title="Zoom in"
              >
                +
              </button>
              <button
                onClick={zoomIn}
                className="ml-1 rounded border border-indigo-500/40 px-1.5 py-0.5 text-[10px] text-indigo-300 hover:bg-indigo-500/10"
                title="Magnify"
              >
                🔍
              </button>
            </>
          )}
          <span className="rounded border border-indigo-500/40 px-2 py-0.5 text-[10px] text-indigo-300">
            {source?.startsWith('flowchart') ? 'Auto-generated' : 'AI-generated'}
          </span>
        </div>
      </div>
      <div className="min-h-[42rem] rounded-lg border border-zinc-800 bg-[#020611] p-3">
        {svg ? (
          <div
            ref={svgContainerRef}
            className="flex min-h-[38rem] justify-center overflow-auto [&_svg]:max-w-none"
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: 'top center',
            }}
          />
        ) : (
          <div className="flex min-h-[38rem] items-center justify-center text-xs text-zinc-500">
            {renderError || 'No diagram available yet. Will be generated during the swarm run.'}
          </div>
        )}
      </div>
    </div>
  );
}
