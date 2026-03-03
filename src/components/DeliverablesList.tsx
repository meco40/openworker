/**
 * DeliverablesList Component
 * Displays deliverables (files, URLs, artifacts) for a task
 */

'use client';

import { useEffect, useState, useCallback } from 'react';
import { FileText, Link as LinkIcon, Package, ExternalLink, Eye } from 'lucide-react';
import { debug } from '@/lib/debug';
import type { TaskDeliverable } from '@/lib/types';
import { useAlertDialog } from '@/components/shared/ConfirmDialogProvider';

interface DeliverablesListProps {
  taskId: string;
}

function getDeliverableIcon(type: string) {
  switch (type) {
    case 'file':
      return <FileText className="h-5 w-5" />;
    case 'url':
      return <LinkIcon className="h-5 w-5" />;
    case 'artifact':
      return <Package className="h-5 w-5" />;
    default:
      return <FileText className="h-5 w-5" />;
  }
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function DeliverablesList({ taskId }: DeliverablesListProps) {
  const alertDialog = useAlertDialog();
  const [deliverables, setDeliverables] = useState<TaskDeliverable[]>([]);
  const [loading, setLoading] = useState(true);

  const loadDeliverables = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/deliverables`);
      if (res.ok) {
        const data = await res.json();
        setDeliverables(data);
      }
    } catch (error) {
      console.error('Failed to load deliverables:', error);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    loadDeliverables();
  }, [loadDeliverables]);

  const handleOpen = async (deliverable: TaskDeliverable) => {
    // URLs open directly in new tab
    if (deliverable.deliverable_type === 'url' && deliverable.path) {
      window.open(deliverable.path, '_blank');
      return;
    }

    // Files - try to open in Finder
    if (deliverable.path) {
      try {
        debug.file('Opening file in Finder', { path: deliverable.path });
        const res = await fetch('/api/files/reveal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: deliverable.path }),
        });

        if (res.ok) {
          debug.file('Opened in Finder successfully');
          return;
        }

        const error = await res.json();
        debug.file('Failed to open', error);

        if (res.status === 404) {
          await alertDialog({
            title: 'Datei nicht gefunden',
            description: `File not found:\n${deliverable.path}\n\nThe file may have been moved or deleted.`,
            tone: 'danger',
          });
        } else if (res.status === 403) {
          await alertDialog({
            title: 'Pfad nicht erlaubt',
            description: `Cannot open this location:\n${deliverable.path}\n\nPath is outside allowed directories.`,
            tone: 'danger',
          });
        } else {
          throw new Error(error.error || 'Unknown error');
        }
      } catch (error) {
        console.error('Failed to open file:', error);
        // Fallback: copy path to clipboard
        try {
          await navigator.clipboard.writeText(deliverable.path);
          await alertDialog({
            title: 'Finder konnte nicht geöffnet werden',
            description: `Could not open Finder. Path copied to clipboard:\n${deliverable.path}`,
            tone: 'danger',
          });
        } catch {
          await alertDialog({
            title: 'Dateipfad',
            description: `File path:\n${deliverable.path}`,
          });
        }
      }
    }
  };

  const handlePreview = (deliverable: TaskDeliverable) => {
    if (deliverable.path) {
      debug.file('Opening preview', { path: deliverable.path });
      window.open(`/api/files/preview?path=${encodeURIComponent(deliverable.path)}`, '_blank');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-mc-text-secondary">Loading deliverables...</div>
      </div>
    );
  }

  if (deliverables.length === 0) {
    return (
      <div className="text-mc-text-secondary flex flex-col items-center justify-center py-8">
        <div className="mb-2 text-4xl">📦</div>
        <p>No deliverables yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {deliverables.map((deliverable) => (
        <div
          key={deliverable.id}
          className="bg-mc-bg border-mc-border hover:border-mc-accent flex gap-3 rounded-lg border p-3 transition-colors"
        >
          {/* Icon */}
          <div className="text-mc-accent flex-shrink-0">
            {getDeliverableIcon(deliverable.deliverable_type)}
          </div>

          {/* Content */}
          <div className="min-w-0 flex-1">
            {/* Title - clickable for URLs */}
            <div className="flex items-start justify-between gap-2">
              {deliverable.deliverable_type === 'url' && deliverable.path ? (
                <a
                  href={deliverable.path}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-mc-accent hover:text-mc-accent/80 flex items-center gap-1.5 font-medium hover:underline"
                >
                  {deliverable.title}
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              ) : (
                <h4 className="text-mc-text font-medium">{deliverable.title}</h4>
              )}
              <div className="flex items-center gap-1">
                {/* Preview button for HTML files */}
                {deliverable.deliverable_type === 'file' && deliverable.path?.endsWith('.html') && (
                  <button
                    onClick={() => handlePreview(deliverable)}
                    className="hover:bg-mc-bg-tertiary text-mc-accent-cyan flex-shrink-0 rounded p-1.5"
                    title="Preview in browser"
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                )}
                {/* Open/Reveal button */}
                {deliverable.path && (
                  <button
                    onClick={() => handleOpen(deliverable)}
                    className="hover:bg-mc-bg-tertiary text-mc-accent flex-shrink-0 rounded p-1.5"
                    title={deliverable.deliverable_type === 'url' ? 'Open URL' : 'Reveal in Finder'}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>

            {/* Description */}
            {deliverable.description && (
              <p className="text-mc-text-secondary mt-1 text-sm">{deliverable.description}</p>
            )}

            {/* Path - clickable for URLs */}
            {deliverable.path &&
              (deliverable.deliverable_type === 'url' ? (
                <a
                  href={deliverable.path}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bg-mc-bg-tertiary text-mc-accent hover:text-mc-accent/80 hover:bg-mc-bg-tertiary/80 mt-2 block rounded p-2 font-mono text-xs break-all"
                >
                  {deliverable.path}
                </a>
              ) : (
                <div className="bg-mc-bg-tertiary text-mc-text-secondary mt-2 rounded p-2 font-mono text-xs break-all">
                  {deliverable.path}
                </div>
              ))}

            {/* Metadata */}
            <div className="text-mc-text-secondary mt-2 flex items-center gap-4 text-xs">
              <span className="capitalize">{deliverable.deliverable_type}</span>
              <span>•</span>
              <span>{formatTimestamp(deliverable.created_at)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
