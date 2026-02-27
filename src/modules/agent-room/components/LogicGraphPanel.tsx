'use client';

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { buildAutoLogicGraphSource, buildLogicGraphSource } from '@/modules/agent-room/logicGraph';
import type { SwarmPhase } from '@/modules/agent-room/swarmPhases';

interface LogicGraphPanelProps {
  artifact: string;
  currentPhase?: SwarmPhase;
  swarmStatus?: string;
}

function isMermaidErrorSvg(markup: string): boolean {
  const text = String(markup || '');
  return /(syntax error in text|parse error|lexical error)/i.test(text);
}

export default function LogicGraphPanel({
  artifact,
  currentPhase,
  swarmStatus,
}: LogicGraphPanelProps) {
  const activePhases = useMemo(
    () =>
      currentPhase
        ? {
            phase: currentPhase,
            currentPhase,
            status: swarmStatus ?? 'running',
          }
        : undefined,
    [currentPhase, swarmStatus],
  );

  const source = useMemo(
    () => buildLogicGraphSource(artifact, activePhases),
    [artifact, activePhases],
  );

  const fallbackSource = useMemo(
    () => buildAutoLogicGraphSource(artifact, activePhases),
    [artifact, activePhases],
  );

  const [svg, setSvg] = useState<string>('');
  const [renderError, setRenderError] = useState<string | null>(null);
  const svgContainerRef = useRef<HTMLDivElement>(null);

  const downloadSvg = useCallback(() => {
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'swarm-diagram.svg';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [svg]);

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
        const renderOnce = async (candidate: string) => {
          const id = `agent-room-graph-${Math.random().toString(36).slice(2, 10)}`;
          return mermaid.render(id, candidate);
        };

        let result = await renderOnce(source);

        // Mermaid may return an error SVG instead of throwing.
        // In that case, recover by falling back to the auto-generated graph.
        if (isMermaidErrorSvg(result.svg) && fallbackSource && fallbackSource !== source) {
          const fallbackResult = await renderOnce(fallbackSource);
          if (!isMermaidErrorSvg(fallbackResult.svg)) {
            result = fallbackResult;
          }
        }

        if (isMermaidErrorSvg(result.svg)) {
          throw new Error('Diagram syntax error in AI-generated Mermaid source.');
        }

        if (!cancelled) {
          setSvg(result.svg);
          setRenderError(null);
        }
      } catch (error) {
        // If Mermaid throws on invalid AI source, try the auto-generated fallback graph.
        if (!cancelled && fallbackSource && fallbackSource !== source) {
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
            const fallbackId = `agent-room-graph-fallback-${Math.random().toString(36).slice(2, 10)}`;
            const fallbackResult = await mermaid.render(fallbackId, fallbackSource);
            if (!isMermaidErrorSvg(fallbackResult.svg)) {
              setSvg(fallbackResult.svg);
              setRenderError(null);
              return;
            }
          } catch {
            // ignore and surface original render failure below
          }
        }

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
  }, [source, fallbackSource]);

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
            <button
              onClick={downloadSvg}
              className="rounded border border-indigo-500/40 px-2 py-0.5 text-[10px] text-indigo-300 hover:bg-indigo-500/10"
              title="Download SVG"
            >
              Download SVG
            </button>
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
