'use client';

import { useState } from 'react';
import { ChevronRight, ChevronLeft, Clock } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import type { Event } from '@/lib/types';
import { formatDistanceToNow } from 'date-fns';

type FeedFilter = 'all' | 'tasks' | 'agents';

function getEventIcon(type: string): string {
  switch (type) {
    case 'task_created':
      return '📋';
    case 'task_assigned':
      return '👤';
    case 'task_status_changed':
      return '🔄';
    case 'task_completed':
      return '✅';
    case 'message_sent':
      return '💬';
    case 'agent_joined':
      return '🎉';
    case 'agent_status_changed':
      return '🔔';
    case 'system':
      return '⚙️';
    default:
      return '📌';
  }
}

export function LiveFeed() {
  const { events } = useMissionControl();
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [isMinimized, setIsMinimized] = useState(false);

  const toggleMinimize = () => setIsMinimized(!isMinimized);

  const filteredEvents = events.filter((event) => {
    if (filter === 'all') return true;
    if (filter === 'tasks')
      return ['task_created', 'task_assigned', 'task_status_changed', 'task_completed'].includes(
        event.type,
      );
    if (filter === 'agents')
      return ['agent_joined', 'agent_status_changed', 'message_sent'].includes(event.type);
    return true;
  });

  return (
    <aside
      className={`bg-mc-bg-secondary border-mc-border flex flex-col border-l transition-all duration-300 ease-in-out ${
        isMinimized ? 'w-12' : 'w-80'
      }`}
    >
      {/* Header */}
      <div className="border-mc-border border-b p-3">
        <div className="flex items-center">
          <button
            onClick={toggleMinimize}
            className="hover:bg-mc-bg-tertiary text-mc-text-secondary hover:text-mc-text rounded p-1 transition-colors"
            aria-label={isMinimized ? 'Expand feed' : 'Minimize feed'}
          >
            {isMinimized ? (
              <ChevronLeft className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
          {!isMinimized && (
            <span className="text-sm font-medium tracking-wider uppercase">Live Feed</span>
          )}
        </div>

        {/* Filter Tabs */}
        {!isMinimized && (
          <div className="mt-3 flex gap-1">
            {(['all', 'tasks', 'agents'] as FeedFilter[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                className={`rounded px-3 py-1 text-xs uppercase ${
                  filter === tab
                    ? 'bg-mc-accent text-mc-bg font-medium'
                    : 'text-mc-text-secondary hover:bg-mc-bg-tertiary'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Events List */}
      {!isMinimized && (
        <div className="flex-1 space-y-1 overflow-y-auto p-2">
          {filteredEvents.length === 0 ? (
            <div className="text-mc-text-secondary py-8 text-center text-sm">No events yet</div>
          ) : (
            filteredEvents.map((event) => <EventItem key={event.id} event={event} />)
          )}
        </div>
      )}
    </aside>
  );
}

function EventItem({ event }: { event: Event }) {
  const isTaskEvent = ['task_created', 'task_assigned', 'task_completed'].includes(event.type);
  const isHighlight = event.type === 'task_created' || event.type === 'task_completed';

  return (
    <div
      className={`animate-slide-in rounded border-l-2 p-2 ${
        isHighlight
          ? 'bg-mc-bg-tertiary border-mc-accent-pink'
          : 'hover:bg-mc-bg-tertiary border-transparent bg-transparent'
      }`}
    >
      <div className="flex items-start gap-2">
        <span className="text-sm">{getEventIcon(event.type)}</span>
        <div className="min-w-0 flex-1">
          <p className={`text-sm ${isTaskEvent ? 'text-mc-accent-pink' : 'text-mc-text'}`}>
            {event.message}
          </p>
          <div className="text-mc-text-secondary mt-1 flex items-center gap-1 text-xs">
            <Clock className="h-3 w-3" />
            {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
          </div>
        </div>
      </div>
    </div>
  );
}
