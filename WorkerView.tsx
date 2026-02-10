
import React, { useState } from 'react';
import { WorkerTask, WorkerTaskStatus, Team, Skill } from './types';
import { ai } from './services/gateway';
import { mapSkillsToTools } from './skills/definitions';
import { WorkerFlow } from './components/WorkerFlow';
import { ArtifactViewer } from './components/WorkerArtifacts';
import { useWorkerController } from './src/modules/worker/hooks/useWorkerController';
import { buildAnalyzeTaskPrompt, parseAnalyzeTaskPayload } from './src/modules/worker/services/analyzeTask';
import { buildExecutionStepPrompt, buildFinalizePrompt, normalizePlan } from './src/modules/worker/services/executeTaskPlan';

interface WorkerViewProps {
  teams: Team[];
  tasks: WorkerTask[];
  setTasks: React.Dispatch<React.SetStateAction<WorkerTask[]>>;
  skills: Skill[];
}

const WorkerView: React.FC<WorkerViewProps> = ({ teams, tasks, setTasks, skills }) => {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [input, setInput] = useState('');
  const [selectedTeamId, setSelectedTeamId] = useState<string>('team-personal');
  const [, setIsProcessing] = useState(false);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const { activeSkills, addTerminalLog } = useWorkerController(skills, setTerminalLogs);

  const selectedTask = tasks.find(t => t.id === selectedTaskId);
  const activeArtifact = selectedTask?.artifacts.find(a => a.id === activeArtifactId);

  const startNewTask = async () => {
    if (!input.trim()) return;
    const newTask: WorkerTask = {
      id: `task-${Date.now()}`,
      title: input.slice(0, 40) + (input.length > 40 ? '...' : ''),
      prompt: input,
      status: WorkerTaskStatus.PLANNING,
      usePlanMode: false,
      plan: [],
      currentStepIndex: 0,
      questions: [],
      answers: {},
      artifacts: [],
      teamId: selectedTeamId,
      createdAt: new Date().toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    };
    setTasks(prev => [newTask, ...prev]);
    setSelectedTaskId(newTask.id);
    setIsCreating(false);
    setInput('');
    setTerminalLogs([]);
    analyzeTask(newTask);
  };

  const analyzeTask = async (task: WorkerTask) => {
    setIsProcessing(true);
    addTerminalLog('openclaw analyze', `Loading ${activeSkills.length} authorized skills...`);
    
    try {
      const activeTools = mapSkillsToTools(skills);
      const prompt = buildAnalyzeTaskPrompt(task.prompt, activeSkills.map(s => s.name));
      
      const response = await ai.models.generateContent({
        contents: prompt,
        config: { 
          responseMimeType: 'application/json',
          tools: activeTools.length > 0 ? activeTools : undefined
        }
      });
      
      const data = parseAnalyzeTaskPayload(response.text || '{}');
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, ...data, status: data.usePlanMode ? WorkerTaskStatus.CLARIFYING : WorkerTaskStatus.REVIEW } : t));
      if (!data.usePlanMode) executeTaskPlan(task.id);
    } catch (e) { console.error(e); } finally { setIsProcessing(false); }
  };

  const executeTaskPlan = async (taskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    
    addTerminalLog('mkdir workspace', `Syncing with org: ${teams.find(tm => tm.id === task.teamId)?.name || 'Local'}`);
    
    setIsProcessing(true);
    try {
      const plan = normalizePlan(task.plan);
      const stepOutputs: string[] = [];

      for (let step = 0; step < plan.length; step++) {
        const stepDesc = plan[step];
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: WorkerTaskStatus.IN_PROGRESS, currentStepIndex: step } : t));
        addTerminalLog(`exec --step ${step + 1}`, stepDesc);

        const stepResponse = await ai.models.generateContent({
          contents: buildExecutionStepPrompt(task.prompt, stepDesc, step + 1, plan.length),
        });

        const stepText = (stepResponse.text || 'Step completed without textual output.').trim();
        stepOutputs.push(`Step ${step + 1}: ${stepText}`);
        addTerminalLog(`result --step ${step + 1}`, stepText.slice(0, 220));
      }

      const response = await ai.models.generateContent({
        contents: buildFinalizePrompt(task.prompt, stepOutputs),
        config: { responseMimeType: 'application/json' }
      });
      const parsed = JSON.parse(response.text || '{}');
      const artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts : [];
      const result = typeof parsed.result === 'string' && parsed.result.trim()
        ? parsed.result
        : 'Synthesis complete.';
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: WorkerTaskStatus.REVIEW, result, artifacts } : t));
      addTerminalLog('openclaw done', 'Workspace finalized and synced.');
    } catch (e) { console.error(e); } finally { setIsProcessing(false); }
  };

  const submitAnswer = (answer: string) => {
    if (!selectedTask) return;
    const updatedAnswers = { ...selectedTask.answers, [selectedTask.questions[Object.keys(selectedTask.answers).length].id]: answer };
    if (Object.keys(updatedAnswers).length >= selectedTask.questions.length) {
      setTasks(prev => prev.map(t => t.id === selectedTask.id ? { ...t, answers: updatedAnswers, status: WorkerTaskStatus.IN_PROGRESS } : t));
      executeTaskPlan(selectedTask.id);
    } else {
      setTasks(prev => prev.map(t => t.id === selectedTask.id ? { ...t, answers: updatedAnswers } : t));
    }
  };

  if (!selectedTaskId && !isCreating) {
    return (
      <div className="h-full flex flex-col space-y-8 animate-in fade-in duration-500 max-w-7xl mx-auto">
        <header className="flex items-center justify-between">
          <div>
            <h2 className="text-3xl font-black text-white tracking-tight uppercase">Workspaces</h2>
            <p className="text-zinc-500 text-sm mt-1">Autonomous worker nodes assigned to your organizations.</p>
          </div>
          <button onClick={() => setIsCreating(true)} className="px-8 py-4 bg-indigo-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-2xl hover:bg-indigo-500 transition-all flex items-center space-x-3">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4" strokeWidth="3" strokeLinecap="round"/></svg>
            <span>New Workspace</span>
          </button>
        </header>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pb-10">
          {tasks.length === 0 ? (
            <div className="col-span-full h-80 bg-zinc-900/20 border-2 border-dashed border-zinc-800 rounded-[2.5rem] flex flex-col items-center justify-center text-center p-10 cursor-pointer hover:border-zinc-700 transition-all" onClick={() => setIsCreating(true)}>
               <h3 className="text-white font-bold text-lg">No Active Environments</h3>
               <p className="text-zinc-500 text-sm mt-2">Initialize a new workspace to begin autonomous fulfillment.</p>
            </div>
          ) : tasks.map(task => (
            <div key={task.id} onClick={() => setSelectedTaskId(task.id)} className="bg-zinc-900/40 border border-zinc-800 p-6 rounded-[2rem] hover:border-indigo-500/50 hover:bg-zinc-900/80 transition-all cursor-pointer group flex flex-col h-[280px] shadow-lg relative">
              <div className="flex items-center justify-between mb-4">
                <span className="text-[8px] font-black uppercase px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">{task.status}</span>
                <span className="text-[10px] font-mono text-zinc-600">{task.createdAt}</span>
              </div>
              <h3 className="text-lg font-bold text-white mb-2 line-clamp-2">{task.title}</h3>
              <p className="text-xs text-zinc-500 line-clamp-2 mb-auto">{task.prompt}</p>
              <div className="mt-4 flex items-center justify-between">
                 <div className="px-2 py-0.5 bg-indigo-500/10 text-indigo-400 text-[8px] font-black uppercase border border-indigo-500/20 rounded">
                    {teams.find(t => t.id === task.teamId)?.name || 'Personal'}
                 </div>
                 <div className="flex -space-x-1">
                    {activeSkills.slice(0, 3).map(s => <div key={s.id} className="w-4 h-4 rounded-full bg-zinc-800 border border-zinc-950 flex items-center justify-center text-[6px]" title={s.name}>🛠️</div>)}
                 </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (isCreating) {
    return (
      <div className="h-full flex flex-col items-center justify-center space-y-12 animate-in zoom-in-95 max-w-4xl mx-auto text-center px-6">
         <h2 className="text-4xl font-black text-white uppercase tracking-tight">Provisioning Flow</h2>
         <div className="w-full grid grid-cols-1 md:grid-cols-4 gap-8">
            <div className="md:col-span-3 space-y-6 text-left">
              <label className="text-[10px] font-black text-zinc-500 uppercase tracking-widest ml-4">Deployment Objective</label>
              <textarea autoFocus value={input} onChange={e => setInput(e.target.value)} placeholder="Define the task for the autonomous node..." className="w-full h-48 bg-zinc-900/40 border-2 border-zinc-800 focus:border-indigo-500 rounded-[2.5rem] p-8 text-lg text-white outline-none transition-all shadow-inner resize-none"/>
              <div className="flex space-x-4">
                 <button onClick={() => setIsCreating(false)} className="px-10 py-5 bg-zinc-900 text-zinc-500 rounded-2xl text-xs font-black uppercase tracking-widest transition-all">Cancel</button>
                 <button onClick={startNewTask} disabled={!input.trim()} className="flex-1 py-5 bg-indigo-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest transition-all shadow-2xl disabled:opacity-30">Deploy Node</button>
              </div>
            </div>
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-[2rem] p-6 space-y-6 text-left h-fit">
               <h4 className="text-[10px] font-black text-zinc-600 uppercase tracking-widest">Assign Org</h4>
               <div className="space-y-2">
                  {teams.map(t => (
                    <button key={t.id} onClick={() => setSelectedTeamId(t.id)} className={`w-full p-4 rounded-xl border text-left text-[10px] font-black uppercase transition-all ${selectedTeamId === t.id ? 'bg-indigo-600 border-indigo-500 text-white shadow-lg' : 'bg-zinc-950 border-zinc-800 text-zinc-500'}`}>{t.name}</button>
                  ))}
               </div>
            </div>
         </div>
      </div>
    );
  }

  return (
    <div className="flex h-full gap-6 animate-in slide-in-from-right-8 duration-700 overflow-hidden">
      <div className="w-80 flex flex-col space-y-6 shrink-0 h-full">
        <button onClick={() => setSelectedTaskId(null)} className="w-full py-4 bg-zinc-900 text-zinc-400 hover:text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all border border-zinc-800">Exit Workspace</button>
        
        <div className="flex-1 bg-zinc-900 border border-zinc-800 rounded-[2.5rem] p-6 space-y-6 overflow-y-auto">
           <div>
             <h4 className="text-[10px] font-black text-zinc-600 uppercase tracking-widest mb-4">Registry Artifacts</h4>
             <div className="space-y-2">
              {selectedTask?.artifacts.map(art => (
                <button key={art.id} onClick={() => setActiveArtifactId(art.id)} className={`w-full flex items-center space-x-3 p-4 rounded-xl border transition-all ${activeArtifactId === art.id ? 'bg-indigo-600/10 border-indigo-500' : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:border-zinc-700'}`}>
                    <div className="text-xl">{art.type === 'code' ? '📄' : '📕'}</div>
                    <div className="text-[11px] font-bold text-white truncate">{art.name}</div>
                </button>
              ))}
             </div>
           </div>

           <div>
             <h4 className="text-[10px] font-black text-zinc-600 uppercase tracking-widest mb-4">Authorized Skills</h4>
             <div className="space-y-2">
                {activeSkills.map(s => (
                  <div key={s.id} className="flex items-center space-x-3 p-3 bg-zinc-950 border border-zinc-800 rounded-xl">
                    <div className="w-2 h-2 rounded-full bg-emerald-500" />
                    <span className="text-[10px] font-bold text-zinc-400 truncate">{s.name}</span>
                  </div>
                ))}
             </div>
           </div>
        </div>
      </div>
      <div className="flex-1 bg-zinc-950 border border-zinc-800 rounded-[3rem] overflow-hidden flex flex-col relative h-full">
         <header className="px-10 py-8 border-b border-zinc-900 bg-zinc-900/20 flex items-center justify-between">
            <h2 className="text-xl font-black text-white tracking-tight uppercase line-clamp-1">{selectedTask?.title}</h2>
            <div className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">{selectedTask?.status}</div>
         </header>
         <div className="flex-1 overflow-y-auto p-12">
            {activeArtifact ? (
               <ArtifactViewer artifact={activeArtifact} onClose={() => setActiveArtifactId(null)} />
            ) : (
              <div className="space-y-12">
                <WorkerFlow task={selectedTask!} />
                <div className="bg-black border border-zinc-800 rounded-2xl p-6 font-mono text-[10px] space-y-2 h-40 overflow-y-auto">
                   {terminalLogs.map((log, i) => <div key={i} className={log.startsWith('$') ? 'text-indigo-400' : log.includes('[TOOL_USE]') ? 'text-amber-500 font-bold' : 'text-zinc-500'}>{log}</div>)}
                </div>
                {selectedTask?.status === WorkerTaskStatus.CLARIFYING && (
                  <div className="space-y-6">
                    {selectedTask.questions.map((q, i) => {
                      if (i === Object.keys(selectedTask.answers).length) return (
                        <div key={q.id} className="bg-zinc-900 p-10 rounded-[2.5rem] border border-indigo-500/20 shadow-2xl space-y-6">
                           <h3 className="text-xl font-bold text-white">{q.text}</h3>
                           <div className="grid grid-cols-2 gap-4">
                              {q.options.map(opt => <button key={opt} onClick={() => submitAnswer(opt)} className="p-4 bg-zinc-950 border border-zinc-800 rounded-xl text-xs font-bold text-zinc-400 hover:border-indigo-500 hover:bg-indigo-600 hover:text-white transition-all">{opt}</button>)}
                           </div>
                        </div>
                      )
                      return null;
                    })}
                  </div>
                )}
                {selectedTask?.status === WorkerTaskStatus.REVIEW && (
                   <div className="bg-zinc-900 p-10 rounded-[2.5rem] border border-zinc-800 shadow-2xl space-y-6">
                      <h4 className="text-[10px] font-black text-zinc-600 uppercase tracking-widest">Synthesis Report</h4>
                      <div className="font-mono text-sm text-zinc-300">{selectedTask.result}</div>
                      <button onClick={() => setTasks(prev => prev.map(t => t.id === selectedTask.id ? { ...t, status: WorkerTaskStatus.COMPLETED } : t))} className="w-full py-5 bg-emerald-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-2xl">Finalize & Commit</button>
                   </div>
                )}
              </div>
            )}
         </div>
      </div>
    </div>
  );
};

export default WorkerView;
