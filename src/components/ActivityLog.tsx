/**
 * ActivityLog Component
 * Displays chronological activity log for a task
 */

'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { formatDistanceToNow } from 'date-fns';
import type { TaskActivity } from '@/lib/types';

interface ActivityLogProps {
  taskId: string;
}

function getActivityIcon(type: string): string {
  switch (type) {
    case 'spawned':
      return '🚀';
    case 'updated':
      return '✏️';
    case 'completed':
      return '✅';
    case 'file_created':
      return '📄';
    case 'status_changed':
      return '🔄';
    default:
      return '📝';
  }
}

export function ActivityLog({ taskId }: ActivityLogProps) {
  const [activities, setActivities] = useState<TaskActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const lastCountRef = useRef(0);

  const loadActivities = useCallback(
    async (showLoading = false) => {
      try {
        if (showLoading) setLoading(true);

        const res = await fetch(`/api/tasks/${taskId}/activities`);
        const data = await res.json();

        if (res.ok) {
          setActivities(data);
          lastCountRef.current = data.length;
        }
      } catch (error) {
        console.error('Failed to load activities:', error);
      } finally {
        setLoading(false);
      }
    },
    [taskId],
  );

  // Initial load
  useEffect(() => {
    loadActivities(true);
  }, [taskId, loadActivities]);

  // Polling function
  const pollForActivities = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/activities`);
      if (res.ok) {
        const data = await res.json();
        // Only update if there are new activities
        if (data.length !== lastCountRef.current) {
          setActivities(data);
          lastCountRef.current = data.length;
        }
      }
    } catch (error) {
      console.error('Polling error:', error);
    }
  }, [taskId]); // setActivities is stable from React, no need to include

  // Poll for new activities every 5 seconds when task is in progress
  useEffect(() => {
    const pollInterval = setInterval(pollForActivities, 5000);

    pollingRef.current = pollInterval;

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, [taskId, pollForActivities]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-mc-text-secondary">Loading activities...</div>
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div className="text-mc-text-secondary flex flex-col items-center justify-center py-8">
        <div className="mb-2 text-4xl">📝</div>
        <p>No activity yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {activities.map((activity) => (
        <div
          key={activity.id}
          className="bg-mc-bg border-mc-border flex gap-3 rounded-lg border p-3"
        >
          {/* Icon */}
          <div className="flex-shrink-0 text-2xl">{getActivityIcon(activity.activity_type)}</div>

          {/* Content */}
          <div className="min-w-0 flex-1">
            {/* Agent info */}
            {activity.agent && (
              <div className="mb-1 flex items-center gap-2">
                <span className="text-sm">{activity.agent.avatar_emoji}</span>
                <span className="text-mc-text text-sm font-medium">{activity.agent.name}</span>
              </div>
            )}

            {/* Message */}
            <p className="text-mc-text text-sm break-words">{activity.message}</p>

            {/* Metadata */}
            {activity.metadata && (
              <div className="bg-mc-bg-tertiary text-mc-text-secondary mt-2 rounded p-2 font-mono text-xs">
                {typeof activity.metadata === 'string'
                  ? activity.metadata
                  : JSON.stringify(JSON.parse(activity.metadata), null, 2)}
              </div>
            )}

            {/* Timestamp */}
            <div className="text-mc-text-secondary mt-2 text-xs">
              {formatDistanceToNow(new Date(activity.created_at), { addSuffix: true })}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
