import React, { useState } from 'react';

interface ClawTask {
  id: string;
  name: string;
  status: 'running' | 'sleeping' | 'stopped';
  cpu: number;
  memory: number;
  uptime: string;
}

const TaskManagerView: React.FC = () => {
  const [tasks, setTasks] = useState<ClawTask[]>([
    {
      id: 't1',
      name: 'gemini-relay-daemon',
      status: 'running',
      cpu: 4.2,
      memory: 128.5,
      uptime: '02:45:11',
    },
    {
      id: 't2',
      name: 'bridge-whatsapp-node',
      status: 'running',
      cpu: 1.1,
      memory: 64.2,
      uptime: '01:12:05',
    },
    {
      id: 't3',
      name: 'skill-browser-chromium',
      status: 'sleeping',
      cpu: 0.0,
      memory: 256.0,
      uptime: '00:22:15',
    },
    {
      id: 't4',
      name: 'bridge-telegram-node',
      status: 'running',
      cpu: 0.8,
      memory: 42.1,
      uptime: '01:05:33',
    },
    {
      id: 't5',
      name: 'voice-native-engine',
      status: 'stopped',
      cpu: 0.0,
      memory: 0.0,
      uptime: '00:00:00',
    },
  ]);

  const killTask = (id: string) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status: 'stopped', cpu: 0, memory: 0 } : t)),
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white">Task Manager</h2>
          <p className="text-sm text-zinc-500">Monitor and manage active Claw Gateway processes.</p>
        </div>
        <button className="rounded border border-indigo-500/20 bg-indigo-600/10 px-4 py-2 text-xs font-bold text-indigo-500 uppercase transition-all hover:bg-indigo-600/20">
          Kill All Zombie Procs
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
        <table className="w-full text-left text-xs">
          <thead className="bg-zinc-950 font-bold text-zinc-500 uppercase">
            <tr>
              <th className="px-6 py-4">Process Name</th>
              <th className="px-6 py-4">Status</th>
              <th className="px-6 py-4">CPU %</th>
              <th className="px-6 py-4">Memory</th>
              <th className="px-6 py-4">Uptime</th>
              <th className="px-6 py-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800 font-mono">
            {tasks.map((task) => (
              <tr key={task.id} className="hover:bg-zinc-800/30">
                <td className="px-6 py-4 font-bold text-zinc-300">{task.name}</td>
                <td className="px-6 py-4">
                  <div className="flex items-center space-x-2">
                    <div
                      className={`h-1.5 w-1.5 rounded-full ${
                        task.status === 'running'
                          ? 'animate-pulse bg-emerald-500'
                          : task.status === 'sleeping'
                            ? 'bg-indigo-400'
                            : 'bg-zinc-700'
                      }`}
                    />
                    <span
                      className={`text-[10px] font-black uppercase ${
                        task.status === 'running'
                          ? 'text-emerald-500'
                          : task.status === 'sleeping'
                            ? 'text-indigo-400'
                            : 'text-zinc-600'
                      }`}
                    >
                      {task.status}
                    </span>
                  </div>
                </td>
                <td className="px-6 py-4 text-zinc-400">{task.cpu.toFixed(1)}%</td>
                <td className="px-6 py-4 text-zinc-400">
                  {task.memory > 0 ? `${task.memory} MB` : '-'}
                </td>
                <td className="px-6 py-4 text-zinc-500">{task.uptime}</td>
                <td className="px-6 py-4 text-right">
                  <button
                    disabled={task.status === 'stopped'}
                    onClick={() => killTask(task.id)}
                    className={`text-[10px] font-black tracking-widest uppercase ${
                      task.status === 'stopped'
                        ? 'cursor-not-allowed text-zinc-800'
                        : 'text-rose-500 hover:text-rose-400'
                    }`}
                  >
                    SIGKILL
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h4 className="mb-4 text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
            Memory Pressure
          </h4>
          <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
            <div className="h-full w-[42%] bg-indigo-500" />
          </div>
          <div className="mt-2 flex justify-between font-mono text-[10px] text-zinc-600 uppercase">
            <span>432 MB / 1024 MB</span>
            <span>42% Load</span>
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h4 className="mb-4 text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
            Thread Affinity
          </h4>
          <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
            <div className="h-full w-[18%] bg-emerald-500" />
          </div>
          <div className="mt-2 flex justify-between font-mono text-[10px] text-zinc-600 uppercase">
            <span>Active Threads: 12</span>
            <span>18% Load</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TaskManagerView;
