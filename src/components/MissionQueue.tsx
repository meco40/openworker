'use client';

import { useState } from 'react';
import { Plus, ChevronRight, GripVertical } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import { triggerAutoDispatch, shouldTriggerAutoDispatch } from '@/lib/auto-dispatch';
import type { Task, TaskStatus } from '@/lib/types';
import { TaskModal } from './TaskModal';
import { formatDistanceToNow } from 'date-fns';

interface MissionQueueProps {
  workspaceId?: string;
}

const COLUMNS: { id: TaskStatus; label: string; color: string }[] = [
  { id: 'pending_dispatch', label: '⏳ PENDING DISPATCH', color: 'border-t-mc-accent-red' },
  { id: 'planning', label: '📋 PLANNING', color: 'border-t-mc-accent-purple' },
  { id: 'inbox', label: 'INBOX', color: 'border-t-mc-accent-pink' },
  { id: 'assigned', label: 'ASSIGNED', color: 'border-t-mc-accent-yellow' },
  { id: 'in_progress', label: 'IN PROGRESS', color: 'border-t-mc-accent' },
  { id: 'testing', label: 'TESTING', color: 'border-t-mc-accent-cyan' },
  { id: 'review', label: 'REVIEW', color: 'border-t-mc-accent-purple' },
  { id: 'done', label: 'DONE', color: 'border-t-mc-accent-green' },
];

function handleDragOver(e: React.DragEvent): void {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

export function MissionQueue({ workspaceId }: MissionQueueProps) {
  const { tasks, updateTaskStatus, addEvent } = useMissionControl();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [draggedTask, setDraggedTask] = useState<Task | null>(null);

  const getTasksByStatus = (status: TaskStatus) => tasks.filter((task) => task.status === status);

  const handleDragStart = (e: React.DragEvent, task: Task) => {
    setDraggedTask(task);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDrop = async (e: React.DragEvent, targetStatus: TaskStatus) => {
    e.preventDefault();
    if (!draggedTask || draggedTask.status === targetStatus) {
      setDraggedTask(null);
      return;
    }

    // Optimistic update
    updateTaskStatus(draggedTask.id, targetStatus);

    // Persist to API
    try {
      const res = await fetch(`/api/tasks/${draggedTask.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: targetStatus }),
      });

      if (res.ok) {
        // Add event
        addEvent({
          id: crypto.randomUUID(),
          type: targetStatus === 'done' ? 'task_completed' : 'task_status_changed',
          task_id: draggedTask.id,
          message: `Task "${draggedTask.title}" moved to ${targetStatus}`,
          created_at: new Date().toISOString(),
        });

        // Check if auto-dispatch should be triggered and execute it
        if (
          shouldTriggerAutoDispatch(draggedTask.status, targetStatus, draggedTask.assigned_agent_id)
        ) {
          const result = await triggerAutoDispatch({
            taskId: draggedTask.id,
            taskTitle: draggedTask.title,
            agentId: draggedTask.assigned_agent_id,
            agentName: draggedTask.assigned_agent?.name || 'Unknown Agent',
            workspaceId: draggedTask.workspace_id,
          });

          if (!result.success) {
            console.error('Auto-dispatch failed:', result.error);
            // Keep queue state consistent: task was moved to in_progress,
            // but execution did not start.
            updateTaskStatus(draggedTask.id, 'pending_dispatch');
            try {
              await fetch(`/api/tasks/${draggedTask.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'pending_dispatch' }),
              });
            } catch (persistErr) {
              console.error('Failed to persist pending_dispatch status:', persistErr);
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to update task status:', error);
      // Revert on error
      updateTaskStatus(draggedTask.id, draggedTask.status);
    }

    setDraggedTask(null);
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="border-mc-border flex items-center justify-between border-b p-3">
        <div className="flex items-center gap-2">
          <ChevronRight className="text-mc-text-secondary h-4 w-4" />
          <span className="text-sm font-medium tracking-wider uppercase">Mission Queue</span>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="bg-mc-accent-pink text-mc-bg hover:bg-mc-accent-pink/90 flex items-center gap-2 rounded px-3 py-1.5 text-sm font-medium"
        >
          <Plus className="h-4 w-4" />
          New Task
        </button>
      </div>

      {/* Kanban Columns */}
      <div className="flex flex-1 gap-3 overflow-x-auto p-3">
        {COLUMNS.map((column) => {
          const columnTasks = getTasksByStatus(column.id);
          return (
            <div
              key={column.id}
              className={`bg-mc-bg border-mc-border/50 flex max-w-[300px] min-w-[220px] flex-1 flex-col rounded-lg border border-t-2 ${column.color}`}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, column.id)}
            >
              {/* Column Header */}
              <div className="border-mc-border flex items-center justify-between border-b p-2">
                <span className="text-mc-text-secondary text-xs font-medium uppercase">
                  {column.label}
                </span>
                <span className="bg-mc-bg-tertiary text-mc-text-secondary rounded px-2 py-0.5 text-xs">
                  {columnTasks.length}
                </span>
              </div>

              {/* Tasks */}
              <div className="flex-1 space-y-2 overflow-y-auto p-2">
                {columnTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onDragStart={handleDragStart}
                    onClick={() => setEditingTask(task)}
                    isDragging={draggedTask?.id === task.id}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Modals */}
      {showCreateModal && (
        <TaskModal onClose={() => setShowCreateModal(false)} workspaceId={workspaceId} />
      )}
      {editingTask && (
        <TaskModal
          task={editingTask}
          onClose={() => setEditingTask(null)}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
}

interface TaskCardProps {
  task: Task;
  onDragStart: (e: React.DragEvent, task: Task) => void;
  onClick: () => void;
  isDragging: boolean;
}

function TaskCard({ task, onDragStart, onClick, isDragging }: TaskCardProps) {
  const priorityStyles = {
    low: 'text-mc-text-secondary',
    normal: 'text-mc-accent',
    high: 'text-mc-accent-yellow',
    urgent: 'text-mc-accent-red',
  };

  const priorityDots = {
    low: 'bg-mc-text-secondary/40',
    normal: 'bg-mc-accent',
    high: 'bg-mc-accent-yellow',
    urgent: 'bg-mc-accent-red',
  };

  const isPlanning = task.status === 'planning';
  const isPendingDispatch = task.status === 'pending_dispatch';

  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => onDragStart(e, task)}
      onClick={onClick}
      className={`group bg-mc-bg-secondary cursor-pointer rounded-lg border transition-all hover:shadow-lg hover:shadow-black/20 ${
        isDragging ? 'scale-95 opacity-50' : ''
      } ${isPlanning ? 'border-purple-500/40 hover:border-purple-500' : 'border-mc-border/50 hover:border-mc-accent/40'}`}
    >
      {/* Drag handle bar */}
      <div className="border-mc-border/30 flex items-center justify-center border-b py-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        <GripVertical className="text-mc-text-secondary/50 h-4 w-4 cursor-grab" />
      </div>

      {/* Card content */}
      <div className="p-4">
        {/* Title */}
        <h4 className="mb-3 line-clamp-2 text-sm leading-snug font-medium">{task.title}</h4>

        {/* Planning mode indicator */}
        {(isPlanning || isPendingDispatch) && (
          <div className="mb-3 flex items-center gap-2 rounded-md border border-purple-500/20 bg-purple-500/10 px-3 py-2">
            <div className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-purple-500" />
            <span className="text-xs font-medium text-purple-400">
              {isPendingDispatch ? 'Retry dispatch needed' : 'Continue planning'}
            </span>
          </div>
        )}

        {/* Assigned agent */}
        {task.assigned_agent && (
          <div className="bg-mc-bg-tertiary/50 mb-3 flex items-center gap-2 rounded px-2 py-1.5">
            <span className="text-base">
              {(task.assigned_agent as unknown as { avatar_emoji: string }).avatar_emoji}
            </span>
            <span className="text-mc-text-secondary truncate text-xs">
              {(task.assigned_agent as unknown as { name: string }).name}
            </span>
          </div>
        )}

        {/* Footer: priority + timestamp */}
        <div className="border-mc-border/20 flex items-center justify-between border-t pt-2">
          <div className="flex items-center gap-1.5">
            <div className={`h-1.5 w-1.5 rounded-full ${priorityDots[task.priority]}`} />
            <span className={`text-xs capitalize ${priorityStyles[task.priority]}`}>
              {task.priority}
            </span>
          </div>
          <span className="text-mc-text-secondary/60 text-[10px]">
            {formatDistanceToNow(new Date(task.created_at), { addSuffix: true })}
          </span>
        </div>
      </div>
    </button>
  );
}
