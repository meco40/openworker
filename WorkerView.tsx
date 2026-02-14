// ─── Worker View ────────────────────────────────────────────
// Refactored entry point: hooks + atomic components only.

import React, { useState, useCallback } from 'react';
import WorkerTaskList from './components/worker/WorkerTaskList';
import WorkerTaskCreation from './components/worker/WorkerTaskCreation';
import WorkerTaskDetail from './components/worker/WorkerTaskDetail';
import WorkerKanbanBoard from './components/worker/WorkerKanbanBoard';
import WorkerPersonaSidebar from './components/worker/WorkerPersonaSidebar';
import WorkerOrchestraTab from './components/worker/WorkerOrchestraTab';
import { useWorkerTasks } from './src/modules/worker/hooks/useWorkerTasks';
import type { WorkerTask } from './types';
import type { WorkerTaskStatus } from './src/server/worker/workerStateMachine';

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
    deleteAllTasks,
    refreshTasks,
  } = useWorkerTasks();

  const [view, setView] = useState<'kanban' | 'list' | 'create' | 'detail' | 'orchestra'>('kanban');
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
    setView('kanban');
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

  const handleMoveTask = useCallback(
    async (taskId: string, targetStatus: WorkerTaskStatus) => {
      try {
        const res = await fetch(`/api/worker/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'move', status: targetStatus }),
        });
        if (res.ok) {
          refreshTasks();
        }
      } catch (err) {
        console.error('[WorkerView] Move failed:', err);
      }
    },
    [refreshTasks],
  );

  const handleAssignPersona = useCallback(
    async (taskId: string, personaId: string | null) => {
      try {
        const res = await fetch(`/api/worker/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'assign', personaId }),
        });
        if (res.ok) {
          refreshTasks();
        }
      } catch (err) {
        console.error('[WorkerView] Assign failed:', err);
      }
    },
    [refreshTasks],
  );

  // Get selected task's persona for sidebar
  const selectedTaskForSidebar = selectedTask || (tasks.length > 0 ? tasks[0] : null);

  return (
    <div className="worker-view">
      <div className="worker-view__main">
        {(view === 'kanban' || view === 'list' || view === 'orchestra') && (
          <div className="worker-view__toggle">
            <button
              className={`worker-btn ${view === 'kanban' ? 'worker-btn--primary' : 'worker-btn--ghost'}`}
              onClick={() => setView('kanban')}
            >
              ▦ Kanban
            </button>
            <button
              className={`worker-btn ${view === 'list' ? 'worker-btn--primary' : 'worker-btn--ghost'}`}
              onClick={() => setView('list')}
            >
              ☰ Liste
            </button>
            <button
              className={`worker-btn ${view === 'orchestra' ? 'worker-btn--primary' : 'worker-btn--ghost'}`}
              onClick={() => setView('orchestra')}
            >
              🎼 Orchestra
            </button>
          </div>
        )}

        {view === 'kanban' && (
          <WorkerKanbanBoard
            tasks={tasks}
            onMoveTask={handleMoveTask}
            onSelectTask={handleSelectTask}
            onCreateTask={() => setView('create')}
          />
        )}

        {view === 'list' && (
          <WorkerTaskList
            tasks={tasks}
            loading={loading}
            error={error}
            onSelectTask={handleSelectTask}
            onCreateNew={() => setView('create')}
            onDeleteTask={deleteTask}
            onDeleteAllTasks={deleteAllTasks}
          />
        )}

        {view === 'create' && <WorkerTaskCreation onSubmit={handleCreate} onCancel={handleBack} />}

        {view === 'orchestra' && <WorkerOrchestraTab />}

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

      {(view === 'kanban' || view === 'list') && (
        <WorkerPersonaSidebar
          selectedTaskId={selectedTaskForSidebar?.id || null}
          assignedPersonaId={selectedTaskForSidebar?.assignedPersonaId || null}
          onAssign={handleAssignPersona}
        />
      )}
    </div>
  );
};

export default WorkerView;
