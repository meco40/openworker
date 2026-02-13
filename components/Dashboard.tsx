import React from 'react';
import { ControlPlaneMetricsState, GatewayState, ScheduledTask } from '../types';
import { ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, Radar } from 'recharts';

interface DashboardProps {
  state: GatewayState & { scheduledTasks?: ScheduledTask[] };
  metricsState: ControlPlaneMetricsState;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatNumber(value: number): string {
  return value.toLocaleString('de-DE');
}

const Dashboard: React.FC<DashboardProps> = ({ state, metricsState }) => {
  const scheduled = state.scheduledTasks || [];
  const sortedScheduled = [...scheduled].sort(
    (a, b) => new Date(a.targetTime).getTime() - new Date(b.targetTime).getTime(),
  );

  const personalityStats = [
    {
      subject: 'Communication',
      A: state.memoryEntries.filter((m) => m.type === 'preference').length * 20,
      fullMark: 100,
    },
    {
      subject: 'Workflows',
      A: state.memoryEntries.filter((m) => m.type === 'fact').length * 15,
      fullMark: 100,
    },
    {
      subject: 'Avoidance',
      A: state.memoryEntries.filter((m) => m.type === 'avoidance').length * 25,
      fullMark: 100,
    },
    { subject: 'Time Awareness', A: Math.min(100, (scheduled.length || 0) * 20), fullMark: 100 },
    { subject: 'Proactivity', A: Math.min(100, state.memoryEntries.length * 10), fullMark: 100 },
  ];

  const metrics = metricsState.metrics;

  const topCards = [
    {
      label: 'Uptime',
      value:
        typeof metrics?.uptimeSeconds === 'number' ? formatUptime(metrics.uptimeSeconds) : '--',
      detail: 'Server Process',
      icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
    },
    {
      label: 'Pending Worker Tasks',
      value:
        typeof metrics?.pendingWorkerTasks === 'number'
          ? formatNumber(metrics.pendingWorkerTasks)
          : '--',
      detail: 'Open Task Queue',
      icon: 'M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 5a2 2 0 002 2h2a2 2 0 002-2',
    },
    {
      label: 'Active WS Sessions',
      value:
        typeof metrics?.activeWsSessions === 'number'
          ? formatNumber(metrics.activeWsSessions)
          : '--',
      detail: 'Realtime Connections',
      icon: 'M8 10h.01M12 10h.01M16 10h.01M9 16h6M4 6h16M4 6a2 2 0 00-2 2v8a2 2 0 002 2',
    },
    {
      label: 'Tokens Today',
      value: typeof metrics?.tokensToday === 'number' ? formatNumber(metrics.tokensToday) : '--',
      detail: 'Current Day Usage',
      icon: 'M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343',
    },
  ];

  return (
    <div className="animate-in fade-in space-y-6 duration-700">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        {topCards.map((card, i) => (
          <div
            key={i}
            className="group relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 shadow-lg transition-all hover:border-violet-500/30"
          >
            <div className="absolute top-0 right-0 -mt-8 -mr-8 h-16 w-16 rounded-full bg-violet-500/5 blur-2xl" />
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                {card.label}
              </span>
              <svg
                className="h-5 w-5 text-violet-500 transition-transform group-hover:scale-110"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={card.icon} />
              </svg>
            </div>
            <div className="text-2xl font-black text-white">{card.value}</div>
            <div className="mt-1 font-mono text-[10px] text-zinc-600 uppercase">{card.detail}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="relative flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-lg lg:col-span-2">
          <div className="relative z-10 mb-6 flex items-center justify-between">
            <h3 className="flex items-center space-x-2 text-xs font-black tracking-widest text-white uppercase">
              <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              <span>Temporal Task Monitor</span>
            </h3>
            <div className="font-mono text-[9px] text-zinc-500 uppercase">
              Cron Scheduler Active
            </div>
          </div>

          <div className="scrollbar-hide max-h-[300px] flex-1 space-y-3 overflow-y-auto">
            {scheduled.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center p-12 text-center">
                <span className="text-[10px] font-black text-zinc-600 uppercase">
                  No pro-active tasks queued.
                </span>
              </div>
            ) : (
              sortedScheduled.map((task) => (
                <div
                  key={task.id}
                  className={`flex items-center justify-between rounded-xl border p-4 transition-all ${
                    task.status === 'triggered'
                      ? 'border-zinc-800/40 bg-zinc-950/20 opacity-50'
                      : 'border-emerald-500/20 bg-zinc-950/60 hover:border-emerald-500/40'
                  }`}
                >
                  <div className="flex items-center space-x-4">
                    <div
                      className={`flex h-8 w-8 items-center justify-center rounded-lg font-mono text-[10px] font-black ${
                        task.status === 'triggered'
                          ? 'bg-zinc-800 text-zinc-500'
                          : 'bg-emerald-500/10 text-emerald-500'
                      }`}
                    >
                      {task.status === 'triggered' ? '✓' : 'T-'}
                    </div>
                    <div>
                      <div className="text-xs font-bold text-zinc-200">{task.content}</div>
                      <div className="font-mono text-[9px] text-zinc-500 uppercase">
                        {new Date(task.targetTime).toLocaleString()}
                      </div>
                    </div>
                  </div>
                  <div className="text-[9px] font-black tracking-tighter text-zinc-600 uppercase">
                    {task.platform}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-lg">
          <div className="mb-6 flex items-center justify-between">
            <h3 className="flex items-center space-x-2 text-xs font-black tracking-widest text-white uppercase">
              <div className="h-1.5 w-1.5 rounded-full bg-violet-500" />
              <span>Personality Matrix</span>
            </h3>
          </div>
          <div className="min-h-[200px] w-full">
            <ResponsiveContainer width="100%" height={256}>
              <RadarChart cx="50%" cy="50%" outerRadius="70%" data={personalityStats}>
                <PolarGrid stroke="#27272a" />
                <PolarAngleAxis
                  dataKey="subject"
                  tick={{ fill: '#71717a', fontSize: 9, fontWeight: 'bold' }}
                />
                <Radar
                  name="Evolution"
                  dataKey="A"
                  stroke="#8b5cf6"
                  fill="#8b5cf6"
                  fillOpacity={0.4}
                  isAnimationActive={false}
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
            <div className="mb-1 text-[9px] font-black tracking-widest text-zinc-500 uppercase">
              Current Focus
            </div>
            <div className="text-[11px] text-zinc-300 italic">
              Learning relative time-patterns and pro-active reminders.
            </div>
          </div>
        </div>
      </div>

      <div className="flex min-h-[200px] flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-lg">
        <div className="mb-6 flex shrink-0 items-center justify-between">
          <h3 className="flex items-center space-x-2 text-xs font-black tracking-widest text-white uppercase">
            <div className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
            <span>Cognitive Learning Stream</span>
          </h3>
        </div>
        <div className="scrollbar-hide max-h-[200px] flex-1 space-y-2 overflow-y-auto font-mono text-[10px]">
          {state.eventHistory.map((log, i) => (
            <div
              key={i}
              className={`flex space-x-4 border-l-2 py-2 pl-4 transition-all hover:bg-zinc-800/20 ${
                log.type === 'TASK'
                  ? 'border-emerald-500'
                  : log.type === 'MEM'
                    ? 'border-violet-500'
                    : 'border-zinc-700'
              }`}
            >
              <span className="shrink-0 text-zinc-600">{log.timestamp}</span>
              <span
                className={`shrink-0 font-black tracking-tighter ${
                  log.type === 'TASK'
                    ? 'text-emerald-500'
                    : log.type === 'MEM'
                      ? 'text-violet-500'
                      : 'text-zinc-400'
                }`}
              >
                [{log.type}]
              </span>
              <span className="text-zinc-400">{log.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
