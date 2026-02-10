
import React, { useState } from 'react';
import { CommandPermission } from '../types';
import { SECURITY_RULES } from '../constants';

const SecurityView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'overview' | 'commands'>('overview');
  const [commands, setCommands] = useState<CommandPermission[]>(SECURITY_RULES);

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <header className="flex items-center justify-between">
        <h2 className="text-2xl font-black text-white uppercase tracking-tight">Security Panel</h2>
        <div className="flex bg-zinc-900/50 p-1 rounded-xl border border-zinc-800">
          <button onClick={() => setActiveTab('overview')} className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest ${activeTab === 'overview' ? 'bg-indigo-600 text-white' : 'text-zinc-500'}`}>Overview</button>
          <button onClick={() => setActiveTab('commands')} className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest ${activeTab === 'commands' ? 'bg-indigo-600 text-white' : 'text-zinc-500'}`}>Whitelist</button>
        </div>
      </header>

      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          {['Active Firewall', 'E2E Encryption', 'Audit Logging', 'Task Isolation'].map(label => (
            <div key={label} className="bg-zinc-900/50 border border-zinc-800 p-6 rounded-2xl">
              <h4 className="text-xs font-black text-white uppercase mb-1">{label}</h4>
              <span className="text-[10px] text-emerald-500 font-mono uppercase">Status: OK</span>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'commands' && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl overflow-hidden">
          <table className="w-full text-left text-[11px]">
            <thead className="bg-zinc-950 text-zinc-600 uppercase font-black tracking-widest">
              <tr><th className="px-8 py-4">Command</th><th className="px-8 py-4">Risk</th><th className="px-8 py-4 text-right">Access</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {commands.map(c => (
                <tr key={c.id} className="hover:bg-zinc-800/20">
                  <td className="px-8 py-5 font-mono text-indigo-400">{c.command}</td>
                  <td className="px-8 py-5"><span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase ${c.risk === 'High' ? 'text-rose-500' : 'text-emerald-500'}`}>{c.risk}</span></td>
                  <td className="px-8 py-5 text-right"><button onClick={() => setCommands(prev => prev.map(rule => rule.id === c.id ? {...rule, enabled: !rule.enabled} : rule))} className={`px-3 py-1.5 rounded text-[9px] font-black uppercase ${c.enabled ? 'text-emerald-500' : 'text-zinc-600'}`}>{c.enabled ? 'Allowed' : 'Blocked'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default SecurityView;
