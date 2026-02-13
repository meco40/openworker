// ─── Worker Kanban Board ────────────────────────────────────
// 7-column Kanban with HTML5 native drag-and-drop.
// State machine enforces valid transitions on drop.

'use client';

import React, { useCallback, useState, useMemo } from 'react';
import type { WorkerTask } from '../../types';
import {
  KANBAN_COLUMNS,
  canTransition,
  type KanbanColumn,
  type WorkerTaskStatus,
} from '../../src/server/worker/workerStateMachine';

interface WorkerKanbanBoardProps {
  tasks: WorkerTask[];
  onMoveTask: (taskId: string, targetStatus: WorkerTaskStatus) => Promise<void>;
  onSelectTask: (task: WorkerTask) => void;
  onCreateTask: () => void;
}

const STATUS_LABELS: Record<string, { label: string; icon: string }> = {
  inbox: { label: 'Eingang', icon: '📥' },
  queued: { label: 'Warteschlange', icon: '⏳' },
  assigned: { label: 'Zugewiesen', icon: '👤' },
  planning: { label: 'Planung', icon: '🧠' },
  clarifying: { label: 'Rückfragen', icon: '❓' },
  executing: { label: 'In Arbeit', icon: '⚙️' },
  waiting_approval: { label: 'Genehmigung', icon: '🔒' },
  testing: { label: 'Testing', icon: '🧪' },
  review: { label: 'Review', icon: '👀' },
  completed: { label: 'Abgeschlossen', icon: '✅' },
  failed: { label: 'Fehlgeschlagen', icon: '❌' },
  cancelled: { label: 'Abgebrochen', icon: '🚫' },
  interrupted: { label: 'Unterbrochen', icon: '⚡' },
};

const COLUMN_COLORS: Record<string, string> = {
  planning: '#3b82f6',
  inbox: '#8b5cf6',
  assigned: '#0ea5e9',
  'in-progress': '#f59e0b',
  testing: '#14b8a6',
  review: '#06b6d4',
  done: '#6b7280',
};

export default function WorkerKanbanBoard({
  tasks,
  onMoveTask,
  onSelectTask,
  onCreateTask,
}: WorkerKanbanBoardProps) {
  const [draggedTask, setDraggedTask] = useState<WorkerTask | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const getTasksForColumn = useCallback(
    (column: KanbanColumn): WorkerTask[] =>
      tasks.filter((t) =>
        column.statuses.includes(t.status as WorkerTaskStatus),
      ),
    [tasks],
  );

  const getDropStatus = useCallback(
    (column: KanbanColumn): WorkerTaskStatus | null => {
      if (!draggedTask) return null;
      for (const status of column.statuses) {
        if (
          canTransition(
            draggedTask.status as WorkerTaskStatus,
            status,
            'manual',
          )
        ) {
          return status;
        }
      }
      return null;
    },
    [draggedTask],
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent, task: WorkerTask) => {
      setDraggedTask(task);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', task.id);
    },
    [],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, column: KanbanColumn) => {
      const targetStatus = getDropStatus(column);
      if (targetStatus) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDropTarget(column.id);
      }
    },
    [getDropStatus],
  );

  const handleDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent, column: KanbanColumn) => {
      e.preventDefault();
      setDropTarget(null);
      if (!draggedTask) return;

      const targetStatus = getDropStatus(column);
      if (targetStatus && targetStatus !== draggedTask.status) {
        await onMoveTask(draggedTask.id, targetStatus);
      }
      setDraggedTask(null);
    },
    [draggedTask, getDropStatus, onMoveTask],
  );

  const handleDragEnd = useCallback(() => {
    setDraggedTask(null);
    setDropTarget(null);
  }, []);

  const totalCount = useMemo(() => tasks.length, [tasks]);

  return (
    <div className="kanban-board">
      <div className="kanban-board__header">
        <div className="kanban-board__title">
          <h2>Worker Tasks</h2>
          <span className="kanban-board__badge">{totalCount}</span>
        </div>
        <button
          className="worker-btn worker-btn--primary"
          onClick={onCreateTask}
        >
          + Neuer Task
        </button>
      </div>

      <div className="kanban-board__columns">
        {KANBAN_COLUMNS.map((column) => {
          const columnTasks = getTasksForColumn(column);
          const isValidTarget = dropTarget === column.id;
          const accentColor =
            COLUMN_COLORS[column.id] || 'var(--accent, #3b82f6)';

          return (
            <div
              key={column.id}
              className={`kanban-column ${isValidTarget ? 'kanban-column--drop-target' : ''}`}
              style={
                isValidTarget
                  ? ({ '--col-accent': accentColor } as React.CSSProperties)
                  : undefined
              }
              onDragOver={(e) => handleDragOver(e, column)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, column)}
            >
              <div className="kanban-column__header">
                <span className="kanban-column__title">{column.label}</span>
                <span className="kanban-column__count">
                  {columnTasks.length}
                </span>
              </div>
              <div className="kanban-column__body">
                {columnTasks.map((task) => {
                  const statusInfo = STATUS_LABELS[task.status] || {
                    label: task.status,
                    icon: '❔',
                  };
                  return (
                    <div
                      key={task.id}
                      className={`kanban-card ${draggedTask?.id === task.id ? 'kanban-card--dragging' : ''}`}
                      draggable
                      onDragStart={(e) => handleDragStart(e, task)}
                      onDragEnd={handleDragEnd}
                      onClick={() => onSelectTask(task)}
                    >
                      <div className="kanban-card__header">
                        <span className="kanban-card__status">
                          {statusInfo.icon}
                        </span>
                        <span className="kanban-card__priority">
                          {task.priority}
                        </span>
                      </div>
                      <div className="kanban-card__title">{task.title}</div>
                      {task.currentStep !== undefined &&
                        task.totalSteps !== undefined &&
                        task.totalSteps > 0 && (
                          <div className="kanban-card__progress">
                            <div
                              className="kanban-card__progress-bar"
                              style={{
                                width: `${(task.currentStep / task.totalSteps) * 100}%`,
                              }}
                            />
                            <span className="kanban-card__progress-text">
                              {task.currentStep}/{task.totalSteps}
                            </span>
                          </div>
                        )}
                    </div>
                  );
                })}
                {columnTasks.length === 0 && (
                  <div className="kanban-column__empty">Keine Tasks</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
