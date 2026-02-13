// ─── Worker Activity Tab ─────────────────────────────────────
// Chronological activity log for a worker task.

import React, { useState, useEffect, useCallback } from 'react';
import type { WorkerActivity } from '../../types';

interface WorkerActivityTabProps {
  taskId: string;
}

const ACTIVITY_ICONS: Record<string, string> = {
  status_change: '🔄',
  persona_assigned: '👤',
  step_completed: '✅',
  step_failed: '❌',
  error: '⚠️',
  note: '📝',
  agent_message: '🤖',
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `vor ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `vor ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours}h`;
  const days = Math.floor(hours / 24);
  return `vor ${days}d`;
}

const WorkerActivityTab: React.FC<WorkerActivityTabProps> = ({ taskId }) => {
  const [activities, setActivities] = useState<WorkerActivity[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchActivities = useCallback(async () => {
    try {
      const res = await fetch(`/api/worker/${taskId}/activities`);
      if (res.ok) {
        const data = await res.json();
        setActivities(data.activities || []);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    fetchActivities();
    // Poll for updates every 5 seconds for active tasks
    const interval = setInterval(fetchActivities, 5000);
    return () => clearInterval(interval);
  }, [fetchActivities]);

  if (loading) {
    return <p className="worker-activity__loading">Aktivitäten laden…</p>;
  }

  if (activities.length === 0) {
    return <p className="worker-activity__empty">Noch keine Aktivitäten.</p>;
  }

  return (
    <div className="worker-activity">
      {activities.map((activity) => {
        const icon = ACTIVITY_ICONS[activity.type] || '📌';
        const meta = activity.metadata ? (() => {
          try { return JSON.parse(activity.metadata); }
          catch { return null; }
        })() : null;

        return (
          <div key={activity.id} className={`worker-activity__item worker-activity__item--${activity.type}`}>
            <span className="worker-activity__icon">{icon}</span>
            <div className="worker-activity__content">
              <p className="worker-activity__message">{activity.message}</p>
              {meta && activity.type === 'persona_assigned' && meta.personaName && (
                <span className="worker-activity__meta">
                  Persona: {meta.personaName}
                </span>
              )}
            </div>
            <span className="worker-activity__time" title={activity.createdAt}>
              {timeAgo(activity.createdAt)}
            </span>
          </div>
        );
      })}
    </div>
  );
};

export default WorkerActivityTab;
