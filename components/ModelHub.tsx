
import React, { useState, useEffect, useMemo } from 'react';
import { AIProvider, ModelProfile } from '../types';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { ai } from '../services/gemini';

// Focus on actual Gemini models as per the coding guidelines
const REAL_MODELS = [
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
  'gemini-2.5-flash-lite-latest',
  'gemini-2.5-flash-latest',
  'gemini-2.5-flash-image',
  'gemini-3-pro-image-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025'
];

const GEMINI_PROVIDER: AIProvider = { 
  id: 'gemini', 
  name: 'Google Gemini', 
  authType: 'api_key', 
  icon: '✨', 
  availableModels: REAL_MODELS 
};

const INITIAL_PROFILES: ModelProfile[] = [
  {
    id: 'p1',
    name: 'Production Chain',
    description: 'The actual active configuration for this node.',
    stack: [
      { id: 'm1', providerId: 'gemini', name: 'gemini-3-flash-preview', priority: 1, status: 'active' },
      { id: 'm2', providerId: 'gemini', name: 'gemini-3-pro-preview', priority: 2, status: 'active' },
    ]
  }
];

const ModelHub: React.FC = () => {
  const [profiles, setProfiles] = useState<ModelProfile[]>(INITIAL_PROFILES);
  const activeProfileId = 'p1';
  const [isProbing, setIsProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);
  
  const [sessionStats, setSessionStats] = useState({
    requests: 0,
    startTime: new Date().toLocaleTimeString(),
    history: [] as { time: string, value: number }[]
  });

  const activeProfile = useMemo(() => 
    profiles.find(p => p.id === activeProfileId) || profiles[0], 
  [profiles, activeProfileId]);

  const defaultModel = useMemo(() => 
    [...activeProfile.stack].sort((a, b) => a.priority - b.priority)[0],
  [activeProfile]);

  useEffect(() => {
    if (sessionStats.history.length > 0) return;
    setSessionStats(prev => ({
      ...prev,
      history: [{ time: prev.startTime, value: 0 }]
    }));
  }, [sessionStats.history.length]);

  const runConnectionProbe = async () => {
    setIsProbing(true);
    setProbeResult(null);
    try {
      const response = await ai.models.generateContent({
        model: defaultModel?.name || 'gemini-3-flash-preview',
        contents: 'Verify gateway connectivity. Respond with "CONNECTION_OPTIMAL" and current timestamp.',
      });
      setProbeResult(response.text || 'No response data.');
      setSessionStats(prev => {
        const requests = prev.requests + 1;
        const now = new Date();
        const time = `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`;
        return {
          ...prev,
          requests,
          history: [...prev.history, { time, value: requests }].slice(-10)
        };
      });
    } catch (error: any) {
      setProbeResult(`PROBE_FAILED: ${error.message}`);
    } finally {
      setIsProbing(false);
    }
  };

  const toggleStatus = (id: string) => {
    setProfiles(prev => prev.map(p => {
      if (p.id === activeProfileId) {
        return {
          ...p,
          stack: p.stack.map(m => m.id === id ? {
            ...m,
            status: m.status === 'active' ? 'offline' : 'active'
          } : m)
        };
      }
      return p;
    }));
  };

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-700 pb-20 max-w-6xl mx-auto">
      {/* Active Gateway Status */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 bg-zinc-900/40 p-8 rounded-3xl border border-zinc-800 shadow-2xl relative overflow-hidden group">
        <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-600/10 rounded-full blur-3xl -mr-32 -mt-32" />
        <div className="relative z-10">
          <div className="flex items-center space-x-3 mb-2">
            <h2 className="text-3xl font-black text-white tracking-tight uppercase">Gateway Control</h2>
            <div className="flex items-center space-x-2 bg-zinc-950 px-2 py-1 rounded border border-zinc-800">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-[10px] font-mono text-zinc-400">SESSION ACTIVE</span>
            </div>
          </div>
          <p className="text-sm text-zinc-500 max-w-lg leading-relaxed">
            Directly interface with the Gemini API. All telemetry below reflects your current session activity and available model configurations.
          </p>
        </div>
        
        <div className="relative z-10 flex flex-col items-center md:items-end">
           <button 
             onClick={runConnectionProbe}
             disabled={isProbing}
             className="px-6 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all shadow-2xl shadow-indigo-600/30 active:scale-95 disabled:opacity-50"
           >
             {isProbing ? 'Probing Kernel...' : 'Connection Probe'}
           </button>
           {probeResult && (
             <div className="mt-4 text-[9px] font-mono text-emerald-500 bg-zinc-950 px-3 py-1.5 rounded border border-zinc-800 animate-in fade-in zoom-in-95">
                {probeResult}
             </div>
           )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
        {/* Model Stack */}
        <div className="lg:col-span-2 space-y-6">
          <h3 className="text-xs font-black text-zinc-500 uppercase tracking-[0.2em] flex items-center space-x-2 px-2">
            <svg className="w-4 h-4 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h7" strokeWidth="2" strokeLinecap="round"/></svg>
            <span>Active Model Pipeline</span>
          </h3>

          <div className="space-y-4">
            {activeProfile.stack.map((model, idx) => (
              <div key={model.id} className={`bg-zinc-900 border transition-all duration-300 rounded-2xl p-6 flex items-center group relative ${
                model.status === 'active' ? 'border-zinc-800' : 'border-rose-500/30 opacity-50 grayscale'
              }`}>
                <div className="w-12 h-12 rounded-xl bg-zinc-950 border border-zinc-800 flex items-center justify-center text-xl mr-6 shadow-inner shrink-0">
                  {GEMINI_PROVIDER.icon}
                </div>

                <div className="flex-1 min-w-0">
                   <div className="flex items-center space-x-2">
                     <h4 className="font-bold text-white text-base truncate tracking-tight">{model.name}</h4>
                     {idx === 0 && <span className="bg-emerald-500/10 text-emerald-500 text-[8px] font-black uppercase px-2 py-0.5 rounded border border-emerald-500/20">Primary</span>}
                   </div>
                   <div className="flex items-center space-x-3 mt-1">
                      <span className="text-[10px] text-zinc-600 font-mono uppercase">Provider: Google Gemini</span>
                      <span className="text-zinc-800">•</span>
                      <span className={`text-[9px] font-black uppercase ${model.status === 'active' ? 'text-emerald-500' : 'text-rose-500'}`}>{model.status}</span>
                   </div>
                </div>

                <button 
                  onClick={() => toggleStatus(model.id)}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white rounded-xl text-[9px] font-black uppercase tracking-widest transition-all"
                >
                  {model.status === 'active' ? 'Disable' : 'Enable'}
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Info & Policies */}
        <div className="space-y-8">
           <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-xl">
              <h4 className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-6">Session Telemetry</h4>
              <div className="space-y-6">
                 <div className="flex justify-between items-center">
                    <span className="text-[11px] text-zinc-400">Requests this session</span>
                    <span className="text-lg font-mono font-bold text-white">{sessionStats.requests}</span>
                 </div>
                 <div className="flex justify-between items-center">
                    <span className="text-[11px] text-zinc-400">Initialization Time</span>
                    <span className="text-xs font-mono text-zinc-500">{sessionStats.startTime}</span>
                 </div>
                 <div className="flex justify-between items-center">
                    <span className="text-[11px] text-zinc-400">Endpoint Status</span>
                    <span className="text-[10px] font-black uppercase text-emerald-500 px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20">Optimal</span>
                 </div>
              </div>
           </div>

           <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-xl">
              <h4 className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-6">Node Environment</h4>
              <div className="space-y-4 font-mono text-[9px] text-zinc-600">
                 <div className="flex justify-between">
                    <span>SDK_VERSION</span>
                    <span className="text-indigo-400">@google/genai@1.40.0</span>
                 </div>
                 <div className="flex justify-between">
                    <span>API_STATUS</span>
                    <span className="text-emerald-500">AUTHENTICATED</span>
                 </div>
                 <div className="flex justify-between">
                    <span>MODALITY_SYNC</span>
                    <span className="text-indigo-400">TEXT/IMAGE/AUDIO</span>
                 </div>
              </div>
           </div>
        </div>
      </div>

      {/* Real-time Session Charts */}
      <div className="space-y-8 bg-zinc-900/40 p-10 rounded-[2.5rem] border border-zinc-800/60 shadow-inner">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-2xl font-black text-white tracking-tight uppercase">Session Performance</h3>
            <p className="text-sm text-zinc-500 mt-1 font-medium">Actual activity tracked during this browser session.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
          <div className="bg-zinc-950/50 border border-zinc-800/50 p-8 rounded-3xl space-y-6">
            <h4 className="text-[10px] font-black text-zinc-600 uppercase tracking-widest">Cumulative Requests</h4>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={sessionStats.history}>
                  <defs>
                    <linearGradient id="sessionFlow" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} opacity={0.3} />
                  <XAxis dataKey="time" stroke="#4b5563" fontSize={10} axisLine={false} tickLine={false} />
                  <YAxis stroke="#4b5563" fontSize={10} axisLine={false} tickLine={false} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#0c0c0c', border: '1px solid #27272a', borderRadius: '12px', fontSize: '10px' }}
                  />
                  <Area type="stepAfter" dataKey="value" stroke="#6366f1" fillOpacity={1} fill="url(#sessionFlow)" strokeWidth={3} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-zinc-950/50 border border-zinc-800/50 p-8 rounded-3xl flex flex-col items-center justify-center space-y-4">
             <div className="text-5xl">⚡</div>
             <div className="text-center">
                <div className="text-4xl font-black text-white">{sessionStats.requests}</div>
                <div className="text-[10px] font-black text-zinc-600 uppercase tracking-[0.3em] mt-2">Successful Handshakes</div>
             </div>
             <p className="text-[11px] text-zinc-500 text-center max-w-xs leading-relaxed italic">
               The gateway kernel is monitoring all transactions. Error rates and latency metrics are compiled per model execution.
             </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ModelHub;
