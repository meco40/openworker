import React, { useMemo } from 'react';
import { WorkerTask, WorkerTaskStatus } from '../types';

interface WorkerFlowProps {
  task: WorkerTask;
}

export const WorkerFlow: React.FC<WorkerFlowProps> = ({ task }) => {
  const steps = useMemo(() => {
    const list = [];
    list.push({
      id: 'start',
      label: 'INIT',
      detail: 'Workspace Provisioning',
      status: 'completed' as const,
      icon: '⚡',
    });

    if (task.status === WorkerTaskStatus.CLARIFYING) {
      list.push({
        id: 'clarify',
        label: 'PROBE',
        detail: 'Context Clarification',
        status: 'active' as const,
        icon: '❓',
      });
    }

    if (task.totalSteps > 0) {
      for (let i = 0; i < task.totalSteps; i++) {
        let status: 'pending' | 'active' | 'completed' = 'pending';
        if (task.status === WorkerTaskStatus.REVIEW || task.status === WorkerTaskStatus.COMPLETED) {
          status = 'completed';
        } else if (task.status === WorkerTaskStatus.EXECUTING) {
          if (i < task.currentStep) status = 'completed';
          else if (i === task.currentStep) status = 'active';
        }
        list.push({
          id: `step-${i}`,
          label: `OP_0${i + 1}`,
          detail: `Schritt ${i + 1}`,
          status,
          icon: '⚙️',
        });
      }
    } else if (
      task.status !== WorkerTaskStatus.PLANNING &&
      task.status !== WorkerTaskStatus.QUEUED
    ) {
      list.push({
        id: 'direct',
        label: 'DIRECT',
        detail: 'Optimized Straight-Through',
        status:
          task.status === WorkerTaskStatus.EXECUTING ? ('active' as const) : ('completed' as const),
        icon: '🚀',
      });
    }

    // Testing phase node
    if (task.status === WorkerTaskStatus.TESTING) {
      list.push({
        id: 'testing',
        label: 'TEST',
        detail: 'Quality Verification',
        status: 'active' as const,
        icon: '🧪',
      });
    }

    list.push({
      id: 'end',
      label: 'SYNC',
      detail: 'Result Synthesis',
      status:
        task.status === WorkerTaskStatus.COMPLETED
          ? ('completed' as const)
          : task.status === WorkerTaskStatus.REVIEW
            ? ('active' as const)
            : ('pending' as const),
      icon: '💎',
    });
    return list;
  }, [task]);

  return (
    <div className="scrollbar-hide relative w-full overflow-x-auto rounded-[2.5rem] border border-zinc-900 bg-zinc-950/50 px-8 py-16 shadow-inner">
      <div className="relative flex min-w-max items-center justify-center space-x-16 px-10">
        <div className="absolute top-1/2 left-0 z-0 h-1 w-full -translate-y-1/2 rounded-full bg-zinc-900/50" />
        {steps.map((step, i) => (
          <div key={step.id} className="group relative z-10 flex flex-col items-center">
            {i > 0 && (step.status === 'completed' || step.status === 'active') && (
              <div
                className={`absolute top-1/2 right-full z-0 h-1 w-16 -translate-y-1/2 transition-all duration-1000 ${step.status === 'active' ? 'animate-pulse bg-indigo-500' : 'bg-indigo-600'}`}
              />
            )}
            <div
              className={`relative flex h-14 w-14 cursor-help items-center justify-center rounded-2xl border-2 transition-all duration-700 ${step.status === 'active' ? 'z-20 scale-110 border-indigo-300 bg-indigo-600 shadow-[0_0_30px_rgba(99,102,241,0.5)]' : step.status === 'completed' ? 'border-indigo-500 bg-zinc-900 text-indigo-400' : 'border-zinc-800 bg-zinc-950 text-zinc-800'}`}
            >
              <span className="text-xl">{step.icon}</span>
            </div>
            <div className="mt-5 text-center">
              <div
                className={`text-[10px] font-black tracking-[0.2em] uppercase ${step.status === 'active' ? 'text-white' : 'text-zinc-600'}`}
              >
                {step.label}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
