
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
    { id: 't1', name: 'gemini-relay-daemon', status: 'running', cpu: 4.2, memory: 128.5, uptime: '02:45:11' },
    { id: 't2', name: 'bridge-whatsapp-node', status: 'running', cpu: 1.1, memory: 64.2, uptime: '01:12:05' },
    { id: 't3', name: 'skill-browser-chromium', status: 'sleeping', cpu: 0.0, memory: 256.0, uptime: '00:22:15' },
    { id: 't4', name: 'bridge-telegram-node', status: 'running', cpu: 0.8, memory: 42.1, uptime: '01:05:33' },
    { id: 't5', name: 'voice-native-engine', status: 'stopped', cpu: 0.0, memory: 0.0, uptime: '00:00:00' },
  ]);

  const killTask = (id: string) => {
    setTasks(prev => prev.map(t => t.id === id ? {...t, status: 'stopped', cpu: 0, memory: 0} : t));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Task Manager</h2>
          <p className="text-sm text-zinc-500">Monitor and manage active Claw Gateway processes.</p>
        </div>
        <button className="px-4 py-2 bg-indigo-600/10 text-indigo-500 border border-indigo-500/20 rounded text-xs font-bold hover:bg-indigo-600/20 transition-all uppercase">
          Kill All Zombie Procs
        </button>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead className="text-zinc-500 uppercase font-bold bg-zinc-950">
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
            {tasks.map(task => (
              <tr key={task.id} className="hover:bg-zinc-800/30">
                <td className="px-6 py-4 text-zinc-300 font-bold">{task.name}</td>
                <td className="px-6 py-4">
                  <div className="flex items-center space-x-2">
                    <div className={`w-1.5 h-1.5 rounded-full ${
                      task.status === 'running' ? 'bg-emerald-500 animate-pulse' : 
                      task.status === 'sleeping' ? 'bg-indigo-400' : 'bg-zinc-700'
                    }`} />
                    <span className={`text-[10px] uppercase font-black ${
                      task.status === 'running' ? 'text-emerald-500' : 
                      task.status === 'sleeping' ? 'text-indigo-400' : 'text-zinc-600'
                    }`}>{task.status}</span>
                  </div>
                </td>
                <td className="px-6 py-4 text-zinc-400">{task.cpu.toFixed(1)}%</td>
                <td className="px-6 py-4 text-zinc-400">{task.memory > 0 ? `${task.memory} MB` : '-'}</td>
                <td className="px-6 py-4 text-zinc-500">{task.uptime}</td>
                <td className="px-6 py-4 text-right">
                  <button 
                    disabled={task.status === 'stopped'}
                    onClick={() => killTask(task.id)}
                    className={`text-[10px] font-black uppercase tracking-widest ${
                      task.status === 'stopped' ? 'text-zinc-800 cursor-not-allowed' : 'text-rose-500 hover:text-rose-400'
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
        <div className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-lg">
          <h4 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-4">Memory Pressure</h4>
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div className="h-full bg-indigo-500 w-[42%]" />
          </div>
          <div className="flex justify-between mt-2 text-[10px] font-mono text-zinc-600 uppercase">
            <span>432 MB / 1024 MB</span>
            <span>42% Load</span>
          </div>
        </div>
        <div className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-lg">
          <h4 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-4">Thread Affinity</h4>
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 w-[18%]" />
          </div>
          <div className="flex justify-between mt-2 text-[10px] font-mono text-zinc-600 uppercase">
            <span>Active Threads: 12</span>
            <span>18% Load</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TaskManagerView;
