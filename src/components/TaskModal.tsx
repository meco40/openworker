'use client';

import { useState, useCallback } from 'react';
import { X, Save, Trash2, Activity, Package, Bot, ClipboardList } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import { triggerAutoDispatch, shouldTriggerAutoDispatch } from '@/lib/auto-dispatch';
import { ActivityLog } from './ActivityLog';
import { DeliverablesList } from './DeliverablesList';
import { SessionsList } from './SessionsList';
import { PlanningTab } from './PlanningTab';
import { AgentModal } from './AgentModal';
import type { Task, TaskPriority, TaskStatus } from '@/lib/types';

type TabType = 'overview' | 'planning' | 'activity' | 'deliverables' | 'sessions';

interface TaskModalProps {
  task?: Task;
  onClose: () => void;
  workspaceId?: string;
}

export function TaskModal({ task, onClose, workspaceId }: TaskModalProps) {
  const { agents, addTask, updateTask, addEvent } = useMissionControl();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [usePlanningMode, setUsePlanningMode] = useState(false);
  // Auto-switch to planning tab if task is in planning status
  const [activeTab, setActiveTab] = useState<TabType>(
    task?.status === 'planning' ? 'planning' : 'overview',
  );

  // Stable callback for when spec is locked - use window.location.reload() to refresh data
  const handleSpecLocked = useCallback(() => {
    window.location.reload();
  }, []);

  const [form, setForm] = useState({
    title: task?.title || '',
    description: task?.description || '',
    priority: task?.priority || ('normal' as TaskPriority),
    status: task?.status || ('inbox' as TaskStatus),
    assigned_agent_id: task?.assigned_agent_id || '',
    due_date: task?.due_date || '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const url = task ? `/api/tasks/${task.id}` : '/api/tasks';
      const method = task ? 'PATCH' : 'POST';

      const payload = {
        ...form,
        // If planning mode is enabled for new tasks, override status to 'planning'
        status: !task && usePlanningMode ? 'planning' : form.status,
        assigned_agent_id: form.assigned_agent_id || null,
        due_date: form.due_date || null,
        workspace_id: workspaceId || task?.workspace_id || 'default',
      };

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const savedTask = await res.json();

        if (task) {
          updateTask(savedTask);

          // Check if auto-dispatch should be triggered and execute it
          if (
            shouldTriggerAutoDispatch(task.status, savedTask.status, savedTask.assigned_agent_id)
          ) {
            const result = await triggerAutoDispatch({
              taskId: savedTask.id,
              taskTitle: savedTask.title,
              agentId: savedTask.assigned_agent_id,
              agentName: savedTask.assigned_agent?.name || 'Unknown Agent',
              workspaceId: savedTask.workspace_id,
            });

            if (!result.success) {
              console.error('Auto-dispatch failed:', result.error);
            }
          }

          onClose();
        } else {
          addTask(savedTask);
          addEvent({
            id: crypto.randomUUID(),
            type: 'task_created',
            task_id: savedTask.id,
            message: `New task: ${savedTask.title}`,
            created_at: new Date().toISOString(),
          });

          // If planning mode is enabled, auto-generate questions and keep modal open
          if (usePlanningMode) {
            // Trigger question generation in background
            fetch(`/api/tasks/${savedTask.id}/planning`, { method: 'POST' })
              .then((res) => {
                if (res.ok) {
                  // Update our local task reference and switch to planning tab
                  updateTask({ ...savedTask, status: 'planning' });
                  setActiveTab('planning');
                } else {
                  return res.json().then((data) => {
                    console.error('Failed to start planning:', data.error);
                  });
                }
              })
              .catch((error) => {
                console.error('Failed to start planning:', error);
              });
          }
          onClose();
        }
      }
    } catch (error) {
      console.error('Failed to save task:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!task || !confirm(`Delete "${task.title}"?`)) return;

    try {
      const res = await fetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
      if (res.ok) {
        useMissionControl.setState((state) => ({
          tasks: state.tasks.filter((t) => t.id !== task.id),
        }));
        onClose();
      }
    } catch (error) {
      console.error('Failed to delete task:', error);
    }
  };

  const statuses: TaskStatus[] = [
    'planning',
    'inbox',
    'assigned',
    'in_progress',
    'testing',
    'review',
    'done',
  ];
  const priorities: TaskPriority[] = ['low', 'normal', 'high', 'urgent'];

  const tabs = [
    { id: 'overview' as TabType, label: 'Overview', icon: null },
    { id: 'planning' as TabType, label: 'Planning', icon: <ClipboardList className="h-4 w-4" /> },
    { id: 'activity' as TabType, label: 'Activity', icon: <Activity className="h-4 w-4" /> },
    { id: 'deliverables' as TabType, label: 'Deliverables', icon: <Package className="h-4 w-4" /> },
    { id: 'sessions' as TabType, label: 'Sessions', icon: <Bot className="h-4 w-4" /> },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-mc-bg-secondary border-mc-border flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg border">
        {/* Header */}
        <div className="border-mc-border flex flex-shrink-0 items-center justify-between border-b p-4">
          <h2 className="text-lg font-semibold">{task ? task.title : 'Create New Task'}</h2>
          <button onClick={onClose} className="hover:bg-mc-bg-tertiary rounded p-1">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs - only show for existing tasks */}
        {task && (
          <div className="border-mc-border flex flex-shrink-0 border-b">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'text-mc-accent border-mc-accent border-b-2'
                    : 'text-mc-text-secondary hover:text-mc-text'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        )}

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Title */}
              <div>
                <label className="mb-1 block text-sm font-medium">Title</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  required
                  className="bg-mc-bg border-mc-border focus:border-mc-accent w-full rounded border px-3 py-2 text-sm focus:outline-none"
                  placeholder="What needs to be done?"
                />
              </div>

              {/* Description */}
              <div>
                <label className="mb-1 block text-sm font-medium">Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={3}
                  className="bg-mc-bg border-mc-border focus:border-mc-accent w-full resize-none rounded border px-3 py-2 text-sm focus:outline-none"
                  placeholder="Add details..."
                />
              </div>

              {/* Planning Mode Toggle - only for new tasks */}
              {!task && (
                <div className="bg-mc-bg border-mc-border rounded-lg border p-3">
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      checked={usePlanningMode}
                      onChange={(e) => setUsePlanningMode(e.target.checked)}
                      className="border-mc-border mt-0.5 h-4 w-4 rounded"
                    />
                    <div>
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <ClipboardList className="text-mc-accent h-4 w-4" />
                        Enable Planning Mode
                      </span>
                      <p className="text-mc-text-secondary mt-1 text-xs">
                        Best for complex projects that need detailed requirements. You&apos;ll
                        answer a few questions to define scope, goals, and constraints before work
                        begins. Skip this for quick, straightforward tasks.
                      </p>
                    </div>
                  </label>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                {/* Status */}
                <div>
                  <label className="mb-1 block text-sm font-medium">Status</label>
                  <select
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value as TaskStatus })}
                    className="bg-mc-bg border-mc-border focus:border-mc-accent w-full rounded border px-3 py-2 text-sm focus:outline-none"
                  >
                    {statuses.map((s) => (
                      <option key={s} value={s}>
                        {s.replace('_', ' ').toUpperCase()}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Priority */}
                <div>
                  <label className="mb-1 block text-sm font-medium">Priority</label>
                  <select
                    value={form.priority}
                    onChange={(e) => setForm({ ...form, priority: e.target.value as TaskPriority })}
                    className="bg-mc-bg border-mc-border focus:border-mc-accent w-full rounded border px-3 py-2 text-sm focus:outline-none"
                  >
                    {priorities.map((p) => (
                      <option key={p} value={p}>
                        {p.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Assigned Agent */}
              <div>
                <label className="mb-1 block text-sm font-medium">Assign to</label>
                <select
                  value={form.assigned_agent_id}
                  onChange={(e) => {
                    if (e.target.value === '__add_new__') {
                      setShowAgentModal(true);
                    } else {
                      setForm({ ...form, assigned_agent_id: e.target.value });
                    }
                  }}
                  className="bg-mc-bg border-mc-border focus:border-mc-accent w-full rounded border px-3 py-2 text-sm focus:outline-none"
                >
                  <option value="">Unassigned</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.avatar_emoji} {agent.name} - {agent.role}
                    </option>
                  ))}
                  <option value="__add_new__" className="text-mc-accent">
                    ➕ Add new agent...
                  </option>
                </select>
              </div>

              {/* Due Date */}
              <div>
                <label className="mb-1 block text-sm font-medium">Due Date</label>
                <input
                  type="datetime-local"
                  value={form.due_date}
                  onChange={(e) => setForm({ ...form, due_date: e.target.value })}
                  className="bg-mc-bg border-mc-border focus:border-mc-accent w-full rounded border px-3 py-2 text-sm focus:outline-none"
                />
              </div>
            </form>
          )}

          {/* Planning Tab */}
          {activeTab === 'planning' && task && (
            <PlanningTab taskId={task.id} onSpecLocked={handleSpecLocked} />
          )}

          {/* Activity Tab */}
          {activeTab === 'activity' && task && <ActivityLog taskId={task.id} />}

          {/* Deliverables Tab */}
          {activeTab === 'deliverables' && task && <DeliverablesList taskId={task.id} />}

          {/* Sessions Tab */}
          {activeTab === 'sessions' && task && <SessionsList taskId={task.id} />}
        </div>

        {/* Footer - only show on overview tab */}
        {activeTab === 'overview' && (
          <div className="border-mc-border flex flex-shrink-0 items-center justify-between border-t p-4">
            <div className="flex gap-2">
              {task && (
                <>
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="text-mc-accent-red hover:bg-mc-accent-red/10 flex items-center gap-2 rounded px-3 py-2 text-sm"
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </button>
                </>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="text-mc-text-secondary hover:text-mc-text px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="bg-mc-accent text-mc-bg hover:bg-mc-accent/90 flex items-center gap-2 rounded px-4 py-2 text-sm font-medium disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                {isSubmitting ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Nested Agent Modal for inline agent creation */}
      {showAgentModal && (
        <AgentModal
          workspaceId={workspaceId}
          onClose={() => setShowAgentModal(false)}
          onAgentCreated={(agentId) => {
            // Auto-select the newly created agent
            setForm({ ...form, assigned_agent_id: agentId });
            setShowAgentModal(false);
          }}
        />
      )}
    </div>
  );
}
