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

  return (
    <div className="worker-workflow">
      <div className="worker-workflow__meta">
        <span>Run: {workflow.runId || '-'}</span>
        <span>Flow: {workflow.flowPublishedId || '-'}</span>
        <span>Aktiv: {workflow.currentNodeId || '-'}</span>
      </div>

      <ul className="worker-workflow__nodes">
        {workflow.nodes.map((node) => (
          <li key={node.id} className={`worker-workflow__node worker-workflow__node--${node.status}`}>
            <span>{STATUS_ICON[node.status] || '•'}</span>
            <span>{node.id}</span>
            <span>{node.personaId || '-'}</span>
            <span>{node.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default WorkerWorkflowTab;
