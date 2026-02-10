
import React, { useMemo } from 'react';
import { WorkerTask, WorkerTaskStatus } from '../types';

interface WorkerFlowProps {
  task: WorkerTask;
}

export const WorkerFlow: React.FC<WorkerFlowProps> = ({ task }) => {
  const steps = useMemo(() => {
    const list = [];
    list.push({ id: 'start', label: 'INIT', detail: 'Workspace Provisioning', status: 'completed', icon: '⚡' });
    if (task.questions.length > 0 || task.status === WorkerTaskStatus.CLARIFYING) {
      list.push({ id: 'clarify', label: 'PROBE', detail: 'Context Clarification', status: task.status === WorkerTaskStatus.CLARIFYING ? 'active' : (Object.keys(task.answers).length > 0 ? 'completed' : 'pending'), icon: '❓' });
    }
    if (task.usePlanMode && task.plan.length > 0) {
      task.plan.forEach((step, i) => {
        let status = 'pending';
        if (task.status === WorkerTaskStatus.REVIEW || task.status === WorkerTaskStatus.COMPLETED) status = 'completed';
        else if (task.status === WorkerTaskStatus.IN_PROGRESS) {
          if (i < task.currentStepIndex) status = 'completed';
          else if (i === task.currentStepIndex) status = 'active';
        }
        list.push({ id: `step-${i}`, label: `OP_0${i+1}`, detail: step, status, icon: '⚙️' });
      });
    } else if (!task.usePlanMode && task.status !== WorkerTaskStatus.PLANNING) {
      list.push({ id: 'direct', label: 'DIRECT', detail: 'Optimized Straight-Through', status: task.status === WorkerTaskStatus.IN_PROGRESS ? 'active' : 'completed', icon: '🚀' });
    }
    list.push({ id: 'end', label: 'SYNC', detail: 'Result Synthesis', status: task.status === WorkerTaskStatus.COMPLETED ? 'completed' : (task.status === WorkerTaskStatus.REVIEW ? 'active' : 'pending'), icon: '💎' });
    return list;
  }, [task]);

  return (
    <div className="relative w-full py-16 px-8 overflow-x-auto scrollbar-hide bg-zinc-950/50 rounded-[2.5rem] border border-zinc-900 shadow-inner">
      <div className="flex items-center space-x-16 min-w-max relative justify-center px-10">
        <div className="absolute top-1/2 left-0 w-full h-1 bg-zinc-900/50 -translate-y-1/2 z-0 rounded-full" />
        {steps.map((step, i) => (
          <div key={step.id} className="relative z-10 flex flex-col items-center group">
            {i > 0 && (step.status === 'completed' || step.status === 'active') && (
              <div className={`absolute top-1/2 right-full w-16 h-1 -translate-y-1/2 z-0 transition-all duration-1000 ${step.status === 'active' ? 'bg-indigo-500 animate-pulse' : 'bg-indigo-600'}`} />
            )}
            <div className={`relative w-14 h-14 rounded-2xl flex items-center justify-center border-2 transition-all duration-700 cursor-help ${step.status === 'active' ? 'bg-indigo-600 border-indigo-300 shadow-[0_0_30px_rgba(99,102,241,0.5)] scale-110 z-20' : step.status === 'completed' ? 'bg-zinc-900 border-indigo-500 text-indigo-400' : 'bg-zinc-950 border-zinc-800 text-zinc-800'}`}>
              <span className="text-xl">{step.icon}</span>
            </div>
            <div className="mt-5 text-center">
               <div className={`text-[10px] font-black tracking-[0.2em] uppercase ${step.status === 'active' ? 'text-white' : 'text-zinc-600'}`}>{step.label}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
