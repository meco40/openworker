// ─── Worker View ────────────────────────────────────────────
// Refactored entry point: hooks + atomic components only.

import React, { useState, useCallback } from 'react';
import WorkerTaskList from './components/worker/WorkerTaskList';
import WorkerTaskCreation from './components/worker/WorkerTaskCreation';
import WorkerTaskDetail from './components/worker/WorkerTaskDetail';
import { useWorkerTasks } from './src/modules/worker/hooks/useWorkerTasks';
import type { WorkerTask } from './types';

const WorkerView: React.FC = () => {
  const {
    tasks,
    loading,
    error,
    createTask,
    cancelTask,
    retryTask,
    resumeTask,
    approveTask,
    deleteTask,
    refreshTasks,
  } = useWorkerTasks();

  const [view, setView] = useState<'list' | 'create' | 'detail'>('list');
  const [selectedTask, setSelectedTask] = useState<WorkerTask | null>(null);

  const handleSelectTask = useCallback(async (task: WorkerTask) => {
    // Fetch fresh task detail with steps/artifacts
    try {
      const res = await fetch(`/api/worker/${task.id}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedTask(data.task || task);
      } else {
        setSelectedTask(task);
      }
    } catch {
      setSelectedTask(task);
    }
    setView('detail');
  }, []);

  const handleCreate = useCallback(
    async (
      objective: string,
      options?: {
        title?: string;
        priority?: string;
        workspaceType?: import('./types').WorkspaceType;
      },
    ) => {
      const task = await createTask(objective, options);
      if (task) {
        setSelectedTask(task);
        setView('detail');
      }
    },
    [createTask],
  );

  const handleBack = useCallback(() => {
    setView('list');
    setSelectedTask(null);
    refreshTasks();
  }, [refreshTasks]);

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteTask(id);
      handleBack();
    },
    [deleteTask, handleBack],
  );

  return (
    <div className="worker-view">
      {view === 'list' && (
        <WorkerTaskList
          tasks={tasks}
          loading={loading}
          error={error}
          onSelectTask={handleSelectTask}
          onCreateNew={() => setView('create')}
        />
      )}

      {view === 'create' && <WorkerTaskCreation onSubmit={handleCreate} onCancel={handleBack} />}

      {view === 'detail' && selectedTask && (
        <WorkerTaskDetail
          task={selectedTask}
          onBack={handleBack}
          onCancel={cancelTask}
          onRetry={retryTask}
          onResume={resumeTask}
          onApprove={approveTask}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
};

export default WorkerView;
