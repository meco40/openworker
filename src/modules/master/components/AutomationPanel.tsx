import React from 'react';
import type { MasterReminder } from '@/modules/master/types';

interface AutomationPanelProps {
  reminders: MasterReminder[];
}

export function AutomationPanel({ reminders }: AutomationPanelProps): React.ReactElement {
  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40 shadow-xl">
      <div className="border-b border-zinc-800/80 bg-zinc-950/40 px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
              Automation
            </h3>
            <p className="mt-1 text-sm text-zinc-500">
              Reminder lifecycle and cron-backed automation state.
            </p>
          </div>
          <span className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[10px] text-zinc-400">
            {reminders.length} reminders
          </span>
        </div>
      </div>

      <div className="space-y-3 p-4">
        {reminders.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-6 text-center text-sm text-zinc-500">
            No reminders scheduled.
          </div>
        ) : (
          reminders.map((reminder) => (
            <article
              key={reminder.id}
              className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-white">{reminder.title}</p>
                  <p className="mt-1 text-xs text-zinc-500">{reminder.message}</p>
                </div>
                <span className="rounded-full border border-zinc-800 px-2 py-1 font-mono text-[10px] text-zinc-400">
                  {reminder.status}
                </span>
              </div>
              <div className="mt-3 text-[11px] text-zinc-400">
                <p>Remind at: {new Date(reminder.remindAt).toLocaleString()}</p>
                {reminder.cronExpression && <p>Cron: {reminder.cronExpression}</p>}
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
