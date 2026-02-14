import React from 'react';
import { useWorkerWorkflow } from '../../src/modules/worker/hooks/useWorkerWorkflow';

interface WorkerWorkflowTabProps {
  taskId: string;
}

const STATUS_ICON: Record<string, string> = {
  pending: '⏳',
  running: '⚙️',
  completed: '✅',
  failed: '❌',
  skipped: '⏭️',
};

type WorkflowPosition = {
  x: number;
  y: number;
  level: number;
};

function computeLevels(nodes: Array<{ id: string }>, edges: Array<{ from: string; to: string }>) {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    incoming.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of edges) {
    incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
    const list = outgoing.get(edge.from) || [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }

  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const [nodeId, count] of incoming.entries()) {
    if (count === 0) {
      level.set(nodeId, 0);
      queue.push(nodeId);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentLevel = level.get(current) || 0;
    const nextNodes = outgoing.get(current) || [];
    for (const nextNode of nextNodes) {
      const nextLevel = Math.max(level.get(nextNode) || 0, currentLevel + 1);
      level.set(nextNode, nextLevel);
      incoming.set(nextNode, (incoming.get(nextNode) || 0) - 1);
      if ((incoming.get(nextNode) || 0) <= 0) queue.push(nextNode);
    }
  }

  for (const node of nodes) {
    if (!level.has(node.id)) level.set(node.id, 0);
  }

  return level;
}

const WorkerWorkflowTab: React.FC<WorkerWorkflowTabProps> = ({ taskId }) => {
  const { workflow, loading, error } = useWorkerWorkflow(taskId);

  if (loading) {
    return <p>Workflow wird geladen…</p>;
  }

  if (error) {
    return <p className="worker-alert worker-alert--error">{error}</p>;
  }

  if (!workflow || workflow.nodes.length === 0) {
    return <p className="worker-output__empty">Kein Workflow für diese Task verfügbar.</p>;
  }

  const levelMap = computeLevels(workflow.nodes, workflow.edges);
  const byLevel = new Map<number, string[]>();
  for (const node of workflow.nodes) {
    const level = levelMap.get(node.id) || 0;
    const bucket = byLevel.get(level) || [];
    bucket.push(node.id);
    byLevel.set(level, bucket);
  }

  const NODE_WIDTH = 180;
  const NODE_HEIGHT = 90;
  const COL_GAP = 56;
  const ROW_GAP = 40;
  const MARGIN = 24;
  const positions = new Map<string, WorkflowPosition>();
  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
  for (const level of sortedLevels) {
    const columnNodes = byLevel.get(level) || [];
    for (let row = 0; row < columnNodes.length; row += 1) {
      positions.set(columnNodes[row]!, {
        x: MARGIN + level * (NODE_WIDTH + COL_GAP),
        y: MARGIN + row * (NODE_HEIGHT + ROW_GAP),
        level,
      });
    }
  }
  const columns = Math.max(1, sortedLevels.length);
  const rows = Math.max(1, ...[...byLevel.values()].map((nodes) => nodes.length));
  const canvasWidth = MARGIN * 2 + columns * NODE_WIDTH + Math.max(0, columns - 1) * COL_GAP;
  const canvasHeight = MARGIN * 2 + rows * NODE_HEIGHT + Math.max(0, rows - 1) * ROW_GAP;

  return (
    <div className="worker-workflow">
      <header className="worker-workflow__header">
        <h3>Live-Graph (aktueller Run)</h3>
        <p>Master steuert den Ablauf. Dieser Tab zeigt nur den aktuellen Run in Echtzeit.</p>
      </header>
      <div className="worker-workflow__meta">
        <span>Run: {workflow.runId || '-'}</span>
        <span>Flow: {workflow.flowPublishedId || '-'}</span>
        <span>Aktiv: {workflow.currentNodeId || '-'}</span>
      </div>

      <div className="worker-workflow__canvas-wrap">
        <div className="worker-workflow__canvas" role="img" aria-label="Workflow Live Graph">
          <svg width={canvasWidth} height={canvasHeight}>
            {workflow.edges.map((edge) => {
              const from = positions.get(edge.from);
              const to = positions.get(edge.to);
              if (!from || !to) return null;
              return (
                <line
                  key={`${edge.from}->${edge.to}`}
                  x1={from.x + NODE_WIDTH}
                  y1={from.y + NODE_HEIGHT / 2}
                  x2={to.x}
                  y2={to.y + NODE_HEIGHT / 2}
                  stroke="currentColor"
                  strokeOpacity="0.65"
                  strokeWidth="2"
                />
              );
            })}
          </svg>

          {workflow.nodes.map((node) => {
            const pos = positions.get(node.id);
            if (!pos) return null;
            return (
              <article
                key={node.id}
                className={`worker-workflow__canvas-node worker-workflow__canvas-node--${node.status} ${
                  workflow.currentNodeId === node.id ? 'worker-workflow__canvas-node--active' : ''
                }`}
                style={{ left: pos.x, top: pos.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
              >
                <strong>
                  {STATUS_ICON[node.status] || '•'} {node.id}
                </strong>
                <span>{node.personaId || '-'}</span>
                <small>{node.status}</small>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default WorkerWorkflowTab;
