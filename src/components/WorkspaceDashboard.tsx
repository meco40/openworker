'use client';

import { useState, useEffect } from 'react';
import { Plus, ArrowRight, Folder, Users, CheckSquare, Trash2, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import type { WorkspaceStats } from '@/lib/types';
import { useAlertDialog } from '@/components/shared/ConfirmDialogProvider';

export function WorkspaceDashboard() {
  const [workspaces, setWorkspaces] = useState<WorkspaceStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    loadWorkspaces();
  }, []);

  const loadWorkspaces = async () => {
    try {
      const res = await fetch('/api/workspaces?stats=true');
      if (res.ok) {
        const data = await res.json();
        setWorkspaces(data);
      }
    } catch (error) {
      console.error('Failed to load workspaces:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-mc-bg flex min-h-screen items-center justify-center">
        <div className="text-center">
          <div className="mb-4 animate-pulse text-4xl">🦞</div>
          <p className="text-mc-text-secondary">Loading workspaces...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-mc-bg min-h-screen">
      {/* Header */}
      <header className="border-mc-border bg-mc-bg-secondary border-b">
        <div className="mx-auto max-w-7xl px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🦞</span>
              <h1 className="text-xl font-bold">Mission Control</h1>
            </div>
            <button
              onClick={() => setShowCreateModal(true)}
              className="bg-mc-accent text-mc-bg hover:bg-mc-accent/90 flex items-center gap-2 rounded-lg px-4 py-2 font-medium"
            >
              <Plus className="h-4 w-4" />
              New Workspace
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-8">
          <h2 className="mb-2 text-2xl font-bold">All Workspaces</h2>
          <p className="text-mc-text-secondary">
            Select a workspace to view its mission queue and agents
          </p>
        </div>

        {workspaces.length === 0 ? (
          <div className="py-16 text-center">
            <Folder className="text-mc-text-secondary mx-auto mb-4 h-16 w-16" />
            <h3 className="mb-2 text-lg font-medium">No workspaces yet</h3>
            <p className="text-mc-text-secondary mb-6">
              Create your first workspace to get started
            </p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="bg-mc-accent text-mc-bg hover:bg-mc-accent/90 rounded-lg px-6 py-3 font-medium"
            >
              Create Workspace
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {workspaces.map((workspace) => (
              <WorkspaceCard
                key={workspace.id}
                workspace={workspace}
                onDelete={(id) => setWorkspaces(workspaces.filter((w) => w.id !== id))}
              />
            ))}

            {/* Add workspace card */}
            <button
              onClick={() => setShowCreateModal(true)}
              className="border-mc-border hover:border-mc-accent/50 flex min-h-[200px] flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-6 transition-colors"
            >
              <div className="bg-mc-bg-tertiary flex h-12 w-12 items-center justify-center rounded-full">
                <Plus className="text-mc-text-secondary h-6 w-6" />
              </div>
              <span className="text-mc-text-secondary font-medium">Add Workspace</span>
            </button>
          </div>
        )}
      </main>

      {/* Create Modal */}
      {showCreateModal && (
        <CreateWorkspaceModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            loadWorkspaces();
          }}
        />
      )}
    </div>
  );
}

function WorkspaceCard({
  workspace,
  onDelete,
}: {
  workspace: WorkspaceStats;
  onDelete: (id: string) => void;
}) {
  const alertDialog = useAlertDialog();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDeleting(true);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}`, { method: 'DELETE' });
      if (res.ok) {
        onDelete(workspace.id);
      } else {
        const data = await res.json();
        await alertDialog({
          title: 'Workspace konnte nicht gelöscht werden',
          description: data.error || 'Failed to delete workspace',
          tone: 'danger',
        });
      }
    } catch {
      await alertDialog({
        title: 'Workspace konnte nicht gelöscht werden',
        description: 'Failed to delete workspace',
        tone: 'danger',
      });
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  return (
    <>
      <Link href={`/mission-control/workspace/${workspace.slug}`}>
        <div className="bg-mc-bg-secondary border-mc-border hover:border-mc-accent/50 group relative cursor-pointer rounded-xl border p-6 transition-all hover:shadow-lg">
          <div className="mb-4 flex items-start justify-between">
            <div className="flex items-center gap-3">
              <span className="text-3xl">{workspace.icon}</span>
              <div>
                <h3 className="group-hover:text-mc-accent text-lg font-semibold transition-colors">
                  {workspace.name}
                </h3>
                <p className="text-mc-text-secondary text-sm">/{workspace.slug}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {workspace.id !== 'default' && (
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setShowDeleteConfirm(true);
                  }}
                  className="hover:bg-mc-accent-red/20 text-mc-text-secondary hover:text-mc-accent-red rounded p-1.5 opacity-0 transition-colors group-hover:opacity-100"
                  title="Delete workspace"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
              <ArrowRight className="text-mc-text-secondary group-hover:text-mc-accent h-5 w-5 transition-colors" />
            </div>
          </div>

          {/* Simple task/agent counts */}
          <div className="text-mc-text-secondary mt-4 flex items-center gap-4 text-sm">
            <div className="flex items-center gap-1">
              <CheckSquare className="h-4 w-4" />
              <span>{workspace.taskCounts.total} tasks</span>
            </div>
            <div className="flex items-center gap-1">
              <Users className="h-4 w-4" />
              <span>{workspace.agentCount} agents</span>
            </div>
          </div>
        </div>
      </Link>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <button
            type="button"
            aria-label="Close delete confirmation"
            onClick={() => setShowDeleteConfirm(false)}
            className="absolute inset-0"
          />
          <div className="bg-mc-bg-secondary border-mc-border relative w-full max-w-md rounded-xl border p-6">
            <div className="mb-4 flex items-center gap-3">
              <div className="bg-mc-accent-red/20 rounded-full p-3">
                <AlertTriangle className="text-mc-accent-red h-6 w-6" />
              </div>
              <div>
                <h3 className="text-lg font-semibold">Delete Workspace</h3>
                <p className="text-mc-text-secondary text-sm">This action cannot be undone</p>
              </div>
            </div>

            <p className="text-mc-text-secondary mb-6">
              Are you sure you want to delete <strong>{workspace.name}</strong>?
              {workspace.taskCounts.total > 0 && (
                <span className="text-mc-accent-red mt-2 block">
                  ⚠️ This workspace has {workspace.taskCounts.total} task(s). Delete them first.
                </span>
              )}
            </p>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="text-mc-text-secondary hover:text-mc-text px-4 py-2"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting || workspace.taskCounts.total > 0 || workspace.agentCount > 0}
                className="bg-mc-accent-red hover:bg-mc-accent-red/90 rounded-lg px-4 py-2 font-medium text-white disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Delete Workspace'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function CreateWorkspaceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('📁');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const icons = ['📁', '💼', '🏢', '🚀', '💡', '🎯', '📊', '🔧', '🌟', '🏠'];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), icon }),
      });

      if (res.ok) {
        onCreated();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to create workspace');
      }
    } catch {
      setError('Failed to create workspace');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-mc-bg-secondary border-mc-border w-full max-w-md rounded-xl border">
        <div className="border-mc-border border-b p-6">
          <h2 className="text-lg font-semibold">Create New Workspace</h2>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          {/* Icon selector */}
          <div>
            <p className="mb-2 block text-sm font-medium">Icon</p>
            <div className="flex flex-wrap gap-2">
              {icons.map((i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setIcon(i)}
                  className={`flex h-10 w-10 items-center justify-center rounded-lg text-xl transition-colors ${
                    icon === i
                      ? 'bg-mc-accent/20 border-mc-accent border-2'
                      : 'bg-mc-bg border-mc-border hover:border-mc-accent/50 border'
                  }`}
                >
                  {i}
                </button>
              ))}
            </div>
          </div>

          {/* Name input */}
          <div>
            <label htmlFor="workspace-name-input" className="mb-2 block text-sm font-medium">
              Name
            </label>
            <input
              id="workspace-name-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Acme Corp"
              className="bg-mc-bg border-mc-border focus:border-mc-accent w-full rounded-lg border px-4 py-2 focus:outline-none"
            />
          </div>

          {error && <div className="text-mc-accent-red text-sm">{error}</div>}

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="text-mc-text-secondary hover:text-mc-text px-4 py-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || isSubmitting}
              className="bg-mc-accent text-mc-bg hover:bg-mc-accent/90 rounded-lg px-6 py-2 font-medium disabled:opacity-50"
            >
              {isSubmitting ? 'Creating...' : 'Create Workspace'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
