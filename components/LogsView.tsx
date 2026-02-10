
import React, { useState, useEffect, useRef } from 'react';

interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

const LogsView: React.FC = () => {
  const [filter, setFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [logs, setLogs] = useState<LogEntry[]>([
    { id: '1', timestamp: '14:20:01', level: 'info', source: 'GATEWAY', message: 'Daemon started successfully on port 8080.' },
    { id: '2', timestamp: '14:20:05', level: 'info', source: 'AUTH', message: 'API Key rotation check completed.' },
    { id: '3', timestamp: '14:21:12', level: 'warn', source: 'BRIDGE', message: 'Latency spike detected on Telegram node (240ms).' },
    { id: '4', timestamp: '14:22:45', level: 'error', source: 'SKILLS', message: 'Failed to initialize "social.nexus": Token expired.' },
  ]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const filteredLogs = logs.filter(l => filter === 'all' || l.level === filter);

  return (
    <div className="flex flex-col h-full space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">System Logs</h2>
          <p className="text-sm text-zinc-500">Real-time telemetry and bridge activity stream.</p>
        </div>
        <div className="flex space-x-2">
          <select 
            value={filter}
            onChange={(e) => setFilter(e.target.value as any)}
            className="bg-zinc-800 text-xs font-bold text-zinc-300 px-3 py-2 rounded border border-zinc-700 focus:outline-none"
          >
            <option value="all">ALL LEVELS</option>
            <option value="info">INFO ONLY</option>
            <option value="warn">WARNINGS</option>
            <option value="error">ERRORS</option>
          </select>
          <button 
            onClick={() => setLogs([])}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded text-xs font-bold transition-all uppercase"
          >
            Clear Buffer
          </button>
        </div>
      </div>

      <div className="flex-1 bg-black border border-zinc-800 rounded-lg overflow-hidden flex flex-col font-mono text-xs">
        <div className="bg-zinc-900/50 px-4 py-2 border-b border-zinc-800 flex items-center space-x-4 text-zinc-500 uppercase font-black tracking-tighter">
          <span className="w-20">Timestamp</span>
          <span className="w-16">Level</span>
          <span className="w-24">Source</span>
          <span>Message</span>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-1">
          {filteredLogs.map(log => (
            <div key={log.id} className="flex space-x-4 group hover:bg-zinc-900/50 py-0.5 rounded px-1 transition-colors">
              <span className="w-20 text-zinc-600">{log.timestamp}</span>
              <span className={`w-16 font-bold ${
                log.level === 'error' ? 'text-rose-500' : 
                log.level === 'warn' ? 'text-amber-500' : 'text-emerald-500'
              }`}>[{log.level.toUpperCase()}]</span>
              <span className="w-24 text-indigo-400">{log.source}</span>
              <span className="text-zinc-400 group-hover:text-zinc-200">{log.message}</span>
            </div>
          ))}
          {filteredLogs.length === 0 && (
            <div className="h-full flex items-center justify-center text-zinc-800 italic">
              Buffer is empty. Waiting for activity...
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default LogsView;
