
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
      value: typeof metrics?.uptimeSeconds === 'number' ? formatUptime(metrics.uptimeSeconds) : '--',
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
      label: 'Active SSE Sessions',
      value:
        typeof metrics?.activeSseSessions === 'number' ? formatNumber(metrics.activeSseSessions) : '--',
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
    <div className="space-y-6 animate-in fade-in duration-700">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {topCards.map((card, i) => (
          <div key={i} className="bg-zinc-900/50 border border-zinc-800 p-5 rounded-xl shadow-lg hover:border-violet-500/30 transition-all group overflow-hidden relative">
            <div className="absolute top-0 right-0 w-16 h-16 bg-violet-500/5 rounded-full blur-2xl -mr-8 -mt-8" />
            <div className="flex items-center justify-between mb-2">
              <span className="text-zinc-500 text-[10px] font-black uppercase tracking-widest">{card.label}</span>
              <svg className="w-5 h-5 text-violet-500 group-hover:scale-110 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={card.icon} />
              </svg>
            </div>
            <div className="text-2xl font-black text-white">{card.value}</div>
            <div className="text-[10px] text-zinc-600 mt-1 uppercase font-mono">{card.detail}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-zinc-900/50 border border-zinc-800 p-6 rounded-xl shadow-lg relative overflow-hidden flex flex-col">
          <div className="flex items-center justify-between mb-6 relative z-10">
            <h3 className="text-xs font-black text-white uppercase tracking-widest flex items-center space-x-2">
               <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
               <span>Temporal Task Monitor</span>
            </h3>
            <div className="text-[9px] text-zinc-500 font-mono uppercase">Cron Scheduler Active</div>
          </div>
          
          <div className="flex-1 space-y-3 overflow-y-auto max-h-[300px] scrollbar-hide">
            {scheduled.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-12">
                 <span className="text-[10px] text-zinc-600 uppercase font-black">No pro-active tasks queued.</span>
              </div>
            ) : sortedScheduled.map((task) => (
              <div key={task.id} className={`p-4 rounded-xl border flex items-center justify-between transition-all ${
                task.status === 'triggered' ? 'bg-zinc-950/20 border-zinc-800/40 opacity-50' : 'bg-zinc-950/60 border-emerald-500/20 hover:border-emerald-500/40'
              }`}>
                <div className="flex items-center space-x-4">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-mono text-[10px] font-black ${
                    task.status === 'triggered' ? 'bg-zinc-800 text-zinc-500' : 'bg-emerald-500/10 text-emerald-500'
                  }`}>
                    {task.status === 'triggered' ? '✓' : 'T-'}
                  </div>
                  <div>
                    <div className="text-xs font-bold text-zinc-200">{task.content}</div>
                    <div className="text-[9px] font-mono text-zinc-500 uppercase">{new Date(task.targetTime).toLocaleString()}</div>
                  </div>
                </div>
                <div className="text-[9px] font-black uppercase text-zinc-600 tracking-tighter">{task.platform}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-zinc-900/50 border border-zinc-800 p-6 rounded-xl shadow-lg flex flex-col">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-xs font-black text-white uppercase tracking-widest flex items-center space-x-2">
              <div className="w-1.5 h-1.5 rounded-full bg-violet-500" />
              <span>Personality Matrix</span>
            </h3>
          </div>
          <div className="w-full min-h-[200px]">
            <ResponsiveContainer width="100%" height={256}>
              <RadarChart cx="50%" cy="50%" outerRadius="70%" data={personalityStats}>
                <PolarGrid stroke="#27272a" />
                <PolarAngleAxis dataKey="subject" tick={{ fill: '#71717a', fontSize: 9, fontWeight: 'bold' }} />
                <Radar name="Evolution" dataKey="A" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.4} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 p-3 bg-zinc-950/40 border border-zinc-800 rounded-xl">
             <div className="text-[9px] font-black text-zinc-500 uppercase tracking-widest mb-1">Current Focus</div>
             <div className="text-[11px] text-zinc-300 italic">Learning relative time-patterns and pro-active reminders.</div>
          </div>
        </div>
      </div>
      
      <div className="bg-zinc-900/50 border border-zinc-800 p-6 rounded-xl shadow-lg overflow-hidden flex flex-col min-h-[200px]">
        <div className="flex items-center justify-between mb-6 shrink-0">
          <h3 className="text-xs font-black text-white uppercase tracking-widest flex items-center space-x-2">
             <div className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
             <span>Cognitive Learning Stream</span>
          </h3>
        </div>
        <div className="flex-1 space-y-2 font-mono text-[10px] overflow-y-auto max-h-[200px] scrollbar-hide">
          {state.eventHistory.map((log, i) => (
            <div key={i} className={`flex space-x-4 border-l-2 pl-4 py-2 transition-all hover:bg-zinc-800/20 ${
              log.type === 'TASK' ? 'border-emerald-500' : 
              log.type === 'MEM' ? 'border-violet-500' : 'border-zinc-700'
            }`}>
              <span className="text-zinc-600 shrink-0">{log.timestamp}</span>
              <span className={`shrink-0 font-black tracking-tighter ${
                log.type === 'TASK' ? 'text-emerald-500' : 
                log.type === 'MEM' ? 'text-violet-500' : 'text-zinc-400'
              }`}>[{log.type}]</span>
              <span className="text-zinc-400">{log.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
