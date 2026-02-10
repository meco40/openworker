import { useEffect, useState } from 'react';
import type React from 'react';
import type { Message, ScheduledTask, SystemLog } from '../../../types';
import { getDuePendingTasks, markDueTasksTriggered } from './taskScheduling';

interface UseTaskSchedulerArgs {
  addEventLog: (type: SystemLog['type'], message: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}

export function useTaskScheduler({ addEventLog, setMessages }: UseTaskSchedulerArgs) {
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);

  useEffect(() => {
    const pulse = setInterval(() => {
      const now = new Date();
      setScheduledTasks((previous) => {
        const dueTasks = getDuePendingTasks(previous, now);
        if (dueTasks.length === 0) {
          return previous;
        }

        dueTasks.forEach((task) => {
          const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          setMessages((currentMessages) => [
            ...currentMessages,
            {
              id: `reminder-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
              role: 'agent',
              content: `🔔 PROAKTIVE ERINNERUNG: ${task.content}`,
              timestamp,
              platform: task.platform,
            },
          ]);
          addEventLog('TASK', `Reminder triggered: ${task.content.slice(0, 20)}...`);
        });

        return markDueTasksTriggered(previous, now);
      });
    }, 15000);

    return () => clearInterval(pulse);
  }, [addEventLog, setMessages]);

  return {
    scheduledTasks,
    setScheduledTasks,
  };
}
