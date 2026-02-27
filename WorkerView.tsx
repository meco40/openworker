import React, { useState } from 'react';
import { WorkerTask, WorkerTaskStatus, Team, Skill } from './types';
import { ai } from './services/gateway';
import { mapSkillsToTools } from './skills/definitions';
import { WorkerFlow } from './components/WorkerFlow';
import { ArtifactViewer } from './components/WorkerArtifacts';
import { useWorkerController } from './src/modules/worker/hooks/useWorkerController';
import {
  buildAnalyzeTaskPrompt,
  parseAnalyzeTaskPayload,
} from './src/modules/worker/services/analyzeTask';
import {
  buildExecutionStepPrompt,
  buildFinalizePrompt,
  normalizePlan,
} from './src/modules/worker/services/executeTaskPlan';

interface WorkerViewProps {
  teams: Team[];
  tasks: WorkerTask[];
  setTasks: React.Dispatch<React.SetStateAction<WorkerTask[]>>;
  skills: Skill[];
}

const statusConfig: Record<
  WorkerTaskStatus,
  { label: string; color: string; bg: string; border: string; dot: string }
> = {
  [WorkerTaskStatus.PLANNING]: {
    label: 'Planning',
    color: 'text-amber-400',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/20',
    dot: 'bg-amber-400',
  },
  [WorkerTaskStatus.CLARIFYING]: {
    label: 'Clarifying',
    color: 'text-sky-400',
    bg: 'bg-sky-500/10',
    border: 'border-sky-500/20',
    dot: 'bg-sky-400',
  },
  [WorkerTaskStatus.IN_PROGRESS]: {
    label: 'In Progress',
    color: 'text-indigo-400',
    bg: 'bg-indigo-500/10',
    border: 'border-indigo-500/20',
    dot: 'bg-indigo-400',
  },
  [WorkerTaskStatus.REVIEW]: {
    label: 'Review',
    color: 'text-violet-400',
    bg: 'bg-violet-500/10',
    border: 'border-violet-500/20',
    dot: 'bg-violet-400',
  },
  [WorkerTaskStatus.COMPLETED]: {
    label: 'Completed',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/20',
    dot: 'bg-emerald-400',
  },
  [WorkerTaskStatus.FAILED]: {
    label: 'Failed',
    color: 'text-rose-400',
    bg: 'bg-rose-500/10',
    border: 'border-rose-500/20',
    dot: 'bg-rose-400',
  },
};

const WorkerView: React.FC<WorkerViewProps> = ({ teams, tasks, setTasks, skills }) => {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [input, setInput] = useState('');
  const [selectedTeamId, setSelectedTeamId] = useState<string>('team-personal');
  const [, setIsProcessing] = useState(false);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const { activeSkills, addTerminalLog } = useWorkerController(skills, setTerminalLogs);

  const selectedTask = tasks.find((t) => t.id === selectedTaskId);
  const activeArtifact = selectedTask?.artifacts.find((a) => a.id === activeArtifactId);

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
      createdAt: new Date().toLocaleString([], {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }),
    };
    setTasks((prev) => [newTask, ...prev]);
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
      const prompt = buildAnalyzeTaskPrompt(
        task.prompt,
        activeSkills.map((s) => s.name),
      );

      const response = await ai.models.generateContent({
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          tools: activeTools.length > 0 ? activeTools : undefined,
        },
      });

      const data = parseAnalyzeTaskPayload(response.text || '{}');
      setTasks((prev) =>
        prev.map((t) =>
          t.id === task.id
            ? {
                ...t,
                ...data,
                status: data.usePlanMode ? WorkerTaskStatus.CLARIFYING : WorkerTaskStatus.REVIEW,
              }
            : t,
        ),
      );
      if (!data.usePlanMode) executeTaskPlan(task.id);
    } catch (e) {
      console.error(e);
    } finally {
      setIsProcessing(false);
    }
  };

  const executeTaskPlan = async (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    addTerminalLog(
      'mkdir workspace',
      `Syncing with org: ${teams.find((tm) => tm.id === task.teamId)?.name || 'Local'}`,
    );

    setIsProcessing(true);
    try {
      const plan = normalizePlan(task.plan);
      const stepOutputs: string[] = [];

      for (let step = 0; step < plan.length; step++) {
        const stepDesc = plan[step];
        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId
              ? { ...t, status: WorkerTaskStatus.IN_PROGRESS, currentStepIndex: step }
              : t,
          ),
        );
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
        config: { responseMimeType: 'application/json' },
      });
      const parsed = JSON.parse(response.text || '{}');
      const artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts : [];
      const result =
        typeof parsed.result === 'string' && parsed.result.trim()
          ? parsed.result
          : 'Synthesis complete.';
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId ? { ...t, status: WorkerTaskStatus.REVIEW, result, artifacts } : t,
        ),
      );
      addTerminalLog('openclaw done', 'Workspace finalized and synced.');
    } catch (e) {
      console.error(e);
    } finally {
      setIsProcessing(false);
    }
  };

  const submitAnswer = (answer: string) => {
    if (!selectedTask) return;
    const updatedAnswers = {
      ...selectedTask.answers,
      [selectedTask.questions[Object.keys(selectedTask.answers).length].id]: answer,
    };
    if (Object.keys(updatedAnswers).length >= selectedTask.questions.length) {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === selectedTask.id
            ? { ...t, answers: updatedAnswers, status: WorkerTaskStatus.IN_PROGRESS }
            : t,
        ),
      );
      executeTaskPlan(selectedTask.id);
    } else {
      setTasks((prev) =>
        prev.map((t) => (t.id === selectedTask.id ? { ...t, answers: updatedAnswers } : t)),
      );
    }
  };

  // ─── Task List View ───────────────────────────────────────────────────────────
  if (!selectedTaskId && !isCreating) {
    return (
      <div className="animate-in fade-in mx-auto flex h-full max-w-7xl flex-col space-y-8 duration-500">
        {/* Header */}
        <header className="relative flex items-center justify-between overflow-hidden rounded-[2rem] border border-zinc-800 bg-zinc-900/40 px-8 py-6">
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-indigo-600/5 via-transparent to-violet-600/5" />
          <div className="relative z-10">
            <div className="mb-1 flex items-center space-x-3">
              <div className="h-2 w-2 animate-pulse rounded-full bg-indigo-500" />
              <span className="text-[10px] font-black tracking-widest text-indigo-400 uppercase">
                Agent Room
              </span>
            </div>
            <h2 className="text-3xl font-black tracking-tight text-white">Autonomous Workspaces</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Deploy and manage autonomous worker nodes across your organizations.
            </p>
          </div>
          <div className="relative z-10 flex items-center space-x-4">
            <div className="hidden text-right md:block">
              <div className="text-[9px] font-black tracking-widest text-zinc-600 uppercase">
                Active Skills
              </div>
              <div className="text-lg font-black text-indigo-400">{activeSkills.length}</div>
            </div>
            <button
              onClick={() => setIsCreating(true)}
              className="flex items-center space-x-2 rounded-xl bg-indigo-600 px-6 py-3.5 text-xs font-black tracking-widest text-white uppercase shadow-lg shadow-indigo-600/20 transition-all hover:bg-indigo-500 hover:shadow-indigo-500/30 active:scale-95"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M12 4v16m8-8H4" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
              <span>New Workspace</span>
            </button>
          </div>
        </header>

        {/* Stats Row */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {[
            { label: 'Total Tasks', value: tasks.length, color: 'text-white' },
            {
              label: 'In Progress',
              value: tasks.filter((t) => t.status === WorkerTaskStatus.IN_PROGRESS).length,
              color: 'text-indigo-400',
            },
            {
              label: 'Completed',
              value: tasks.filter((t) => t.status === WorkerTaskStatus.COMPLETED).length,
              color: 'text-emerald-400',
            },
            {
              label: 'Pending Review',
              value: tasks.filter((t) => t.status === WorkerTaskStatus.REVIEW).length,
              color: 'text-violet-400',
            },
          ].map((stat, i) => (
            <div
              key={i}
              className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 transition-all hover:border-zinc-700"
            >
              <div className="mb-1 text-[9px] font-black tracking-widest text-zinc-600 uppercase">
                {stat.label}
              </div>
              <div className={`text-2xl font-black ${stat.color}`}>{stat.value}</div>
            </div>
          ))}
        </div>

        {/* Task Grid */}
        <div className="grid grid-cols-1 gap-5 pb-10 md:grid-cols-2 lg:grid-cols-3">
          {tasks.length === 0 ? (
            <div
              className="group col-span-full flex h-72 cursor-pointer flex-col items-center justify-center rounded-[2rem] border-2 border-dashed border-zinc-800 bg-zinc-900/20 p-10 text-center transition-all hover:border-indigo-500/30 hover:bg-zinc-900/30"
              onClick={() => setIsCreating(true)}
            >
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-indigo-500/20 bg-indigo-600/10 transition-transform group-hover:scale-110">
                <svg
                  className="h-8 w-8 text-indigo-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                  />
                </svg>
              </div>
              <h3 className="mb-1 text-base font-bold text-white">No Active Environments</h3>
              <p className="text-sm text-zinc-500">
                Initialize a new workspace to begin autonomous fulfillment.
              </p>
              <span className="mt-4 text-[10px] font-black tracking-widest text-indigo-400 uppercase">
                Click to Deploy →
              </span>
            </div>
          ) : (
            tasks.map((task) => {
              const sc = statusConfig[task.status] || statusConfig[WorkerTaskStatus.PLANNING];
              const teamName = teams.find((t) => t.id === task.teamId)?.name || 'Personal';
              return (
                <div
                  key={task.id}
                  onClick={() => setSelectedTaskId(task.id)}
                  className="group relative flex cursor-pointer flex-col overflow-hidden rounded-[1.5rem] border border-zinc-800 bg-zinc-900/50 p-6 shadow-lg transition-all hover:border-indigo-500/40 hover:bg-zinc-900/80"
                >
                  {/* Subtle gradient accent */}
                  <div className="absolute top-0 right-0 -mt-16 -mr-16 h-32 w-32 rounded-full bg-indigo-600/5 blur-2xl transition-all group-hover:bg-indigo-600/10" />

                  <div className="relative z-10 mb-4 flex items-start justify-between">
                    <div
                      className={`flex items-center space-x-1.5 rounded-lg border px-2.5 py-1 ${sc.bg} ${sc.border}`}
                    >
                      <div
                        className={`h-1.5 w-1.5 rounded-full ${sc.dot} ${task.status === WorkerTaskStatus.IN_PROGRESS ? 'animate-pulse' : ''}`}
                      />
                      <span
                        className={`text-[9px] font-black tracking-wider uppercase ${sc.color}`}
                      >
                        {sc.label}
                      </span>
                    </div>
                    <span className="font-mono text-[9px] text-zinc-600">{task.createdAt}</span>
                  </div>

                  <h3 className="relative z-10 mb-2 line-clamp-2 text-sm font-bold text-white transition-colors group-hover:text-indigo-300">
                    {task.title}
                  </h3>
                  <p className="relative z-10 mb-auto line-clamp-2 text-xs text-zinc-500">
                    {task.prompt}
                  </p>

                  <div className="relative z-10 mt-5 flex items-center justify-between border-t border-zinc-800/60 pt-4">
                    <div className="flex items-center space-x-2">
                      <div className="flex h-5 w-5 items-center justify-center rounded-md border border-indigo-500/20 bg-indigo-600/20">
                        <svg
                          className="h-3 w-3 text-indigo-400"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                          />
                        </svg>
                      </div>
                      <span className="text-[10px] font-bold text-zinc-500">{teamName}</span>
                    </div>
                    <div className="flex items-center space-x-1">
                      {activeSkills.slice(0, 3).map((s) => (
                        <div
                          key={s.id}
                          className="flex h-5 w-5 items-center justify-center rounded-md border border-zinc-700 bg-zinc-800 text-[8px]"
                          title={s.name}
                        >
                          🛠
                        </div>
                      ))}
                      {activeSkills.length > 3 && (
                        <div className="flex h-5 w-5 items-center justify-center rounded-md border border-zinc-700 bg-zinc-800 text-[8px] text-zinc-500">
                          +{activeSkills.length - 3}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  // ─── Create Task View ─────────────────────────────────────────────────────────
  if (isCreating) {
    return (
      <div className="animate-in zoom-in-95 mx-auto flex h-full w-full max-w-4xl flex-col items-center justify-center px-6 duration-300">
        <div className="w-full space-y-8">
          {/* Header */}
          <div className="space-y-2 text-center">
            <div className="mb-2 inline-flex items-center space-x-2 rounded-lg border border-indigo-500/20 bg-indigo-600/10 px-3 py-1.5">
              <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500" />
              <span className="text-[10px] font-black tracking-widest text-indigo-400 uppercase">
                New Deployment
              </span>
            </div>
            <h2 className="text-3xl font-black tracking-tight text-white uppercase">
              Provisioning Flow
            </h2>
            <p className="text-sm text-zinc-500">
              Define the objective and assign an organization for this autonomous node.
            </p>
          </div>

          {/* Form */}
          <div className="grid grid-cols-1 gap-6 md:grid-cols-4">
            <div className="space-y-4 md:col-span-3">
              <label className="ml-1 block text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                Deployment Objective
              </label>
              <textarea
                autoFocus
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Define the task for the autonomous node..."
                className="h-44 w-full resize-none rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 text-base text-white placeholder-zinc-700 shadow-inner transition-all outline-none focus:border-indigo-500/60 focus:ring-1 focus:ring-indigo-500/20"
              />
              <div className="flex space-x-3">
                <button
                  onClick={() => setIsCreating(false)}
                  className="rounded-xl border border-zinc-800 bg-zinc-900 px-8 py-3.5 text-xs font-black tracking-widest text-zinc-400 uppercase transition-all hover:bg-zinc-800 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  onClick={startNewTask}
                  disabled={!input.trim()}
                  className="flex-1 rounded-xl bg-indigo-600 py-3.5 text-xs font-black tracking-widest text-white uppercase shadow-lg shadow-indigo-600/20 transition-all hover:bg-indigo-500 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-30"
                >
                  Deploy Node
                </button>
              </div>
            </div>

            {/* Team Selector */}
            <div className="h-fit space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
              <h4 className="text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                Assign Organization
              </h4>
              <div className="space-y-2">
                {teams.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setSelectedTeamId(t.id)}
                    className={`w-full rounded-xl border p-3 text-left text-[10px] font-black tracking-wide uppercase transition-all ${
                      selectedTeamId === t.id
                        ? 'border-indigo-500/50 bg-indigo-600/20 text-indigo-300 shadow-sm'
                        : 'border-zinc-800 bg-zinc-950/50 text-zinc-500 hover:border-zinc-700 hover:text-zinc-400'
                    }`}
                  >
                    <div className="flex items-center space-x-2">
                      {selectedTeamId === t.id && (
                        <div className="h-1.5 w-1.5 rounded-full bg-indigo-400" />
                      )}
                      <span>{t.name}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Task Detail View ─────────────────────────────────────────────────────────
  const sc = selectedTask
    ? statusConfig[selectedTask.status] || statusConfig[WorkerTaskStatus.PLANNING]
    : statusConfig[WorkerTaskStatus.PLANNING];

  return (
    <div className="animate-in slide-in-from-right-4 flex h-full gap-5 overflow-hidden duration-500">
      {/* Left Sidebar */}
      <div className="flex h-full w-72 shrink-0 flex-col space-y-4">
        <button
          onClick={() => setSelectedTaskId(null)}
          className="flex w-full items-center justify-center space-x-2 rounded-xl border border-zinc-800 bg-zinc-900/60 py-3 text-[10px] font-black tracking-widest text-zinc-400 uppercase transition-all hover:border-zinc-700 hover:bg-zinc-900 hover:text-white"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2.5}
              d="M15 19l-7-7 7-7"
            />
          </svg>
          <span>All Workspaces</span>
        </button>

        <div className="flex-1 space-y-6 overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
          {/* Artifacts */}
          <div>
            <h4 className="mb-3 flex items-center space-x-2 text-[9px] font-black tracking-widest text-zinc-600 uppercase">
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <span>Artifacts</span>
            </h4>
            {selectedTask?.artifacts.length === 0 || !selectedTask?.artifacts ? (
              <div className="py-4 text-center text-[9px] font-bold text-zinc-700 uppercase">
                No artifacts yet
              </div>
            ) : (
              <div className="space-y-2">
                {selectedTask.artifacts.map((art) => (
                  <button
                    key={art.id}
                    onClick={() => setActiveArtifactId(art.id)}
                    className={`flex w-full items-center space-x-3 rounded-xl border p-3 transition-all ${
                      activeArtifactId === art.id
                        ? 'border-indigo-500/40 bg-indigo-600/15 shadow-sm'
                        : 'border-zinc-800 bg-zinc-950/50 hover:border-zinc-700'
                    }`}
                  >
                    <div className="text-base">{art.type === 'code' ? '📄' : '📕'}</div>
                    <div className="truncate text-[11px] font-bold text-zinc-300">{art.name}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Active Skills */}
          <div>
            <h4 className="mb-3 flex items-center space-x-2 text-[9px] font-black tracking-widest text-zinc-600 uppercase">
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
              <span>Active Skills</span>
            </h4>
            {activeSkills.length === 0 ? (
              <div className="py-4 text-center text-[9px] font-bold text-zinc-700 uppercase">
                No skills loaded
              </div>
            ) : (
              <div className="space-y-1.5">
                {activeSkills.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center space-x-2.5 rounded-lg border border-zinc-800/60 bg-zinc-950/50 p-2.5"
                  >
                    <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                    <span className="truncate text-[10px] font-bold text-zinc-400">{s.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="relative flex h-full flex-1 flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/80">
        {/* Task Header */}
        <header className="flex shrink-0 items-center justify-between border-b border-zinc-800/80 bg-zinc-900/30 px-8 py-5 backdrop-blur-sm">
          <div className="flex min-w-0 items-center space-x-4">
            <div
              className={`flex shrink-0 items-center space-x-1.5 rounded-lg border px-2.5 py-1 ${sc.bg} ${sc.border}`}
            >
              <div
                className={`h-1.5 w-1.5 rounded-full ${sc.dot} ${selectedTask?.status === WorkerTaskStatus.IN_PROGRESS ? 'animate-pulse' : ''}`}
              />
              <span className={`text-[9px] font-black tracking-wider uppercase ${sc.color}`}>
                {sc.label}
              </span>
            </div>
            <h2 className="truncate text-base font-black tracking-tight text-white">
              {selectedTask?.title}
            </h2>
          </div>
          <div className="flex shrink-0 items-center space-x-3">
            <span className="font-mono text-[9px] text-zinc-600">{selectedTask?.createdAt}</span>
            <div className="rounded-lg border border-zinc-700/50 bg-zinc-800/60 px-2.5 py-1 text-[9px] font-black tracking-wider text-zinc-400 uppercase">
              {teams.find((t) => t.id === selectedTask?.teamId)?.name || 'Personal'}
            </div>
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-8">
          {activeArtifact ? (
            <ArtifactViewer artifact={activeArtifact} onClose={() => setActiveArtifactId(null)} />
          ) : (
            <div className="mx-auto max-w-4xl space-y-8">
              {/* Worker Flow */}
              <WorkerFlow task={selectedTask!} />

              {/* Terminal */}
              <div className="overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-950">
                <div className="flex items-center justify-between border-b border-zinc-800/60 bg-zinc-900/40 px-4 py-2.5">
                  <div className="flex items-center space-x-2">
                    <div className="flex space-x-1.5">
                      <div className="h-2.5 w-2.5 rounded-full bg-rose-500/60" />
                      <div className="h-2.5 w-2.5 rounded-full bg-amber-500/60" />
                      <div className="h-2.5 w-2.5 rounded-full bg-emerald-500/60" />
                    </div>
                    <span className="ml-2 text-[9px] font-black tracking-widest text-zinc-600 uppercase">
                      Terminal Output
                    </span>
                  </div>
                  <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                </div>
                <div className="h-36 space-y-1.5 overflow-y-auto p-4 font-mono text-[10px]">
                  {terminalLogs.length === 0 ? (
                    <div className="text-zinc-700 italic">Awaiting execution...</div>
                  ) : (
                    terminalLogs.map((log, i) => (
                      <div
                        key={i}
                        className={
                          log.startsWith('$')
                            ? 'text-indigo-400'
                            : log.includes('[TOOL_USE]')
                              ? 'font-bold text-amber-400'
                              : 'text-zinc-500'
                        }
                      >
                        {log}
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Clarifying Questions */}
              {selectedTask?.status === WorkerTaskStatus.CLARIFYING && (
                <div className="space-y-4">
                  {selectedTask.questions.map((q, i) => {
                    if (i !== Object.keys(selectedTask.answers).length) return null;
                    return (
                      <div
                        key={q.id}
                        className="space-y-6 rounded-2xl border border-indigo-500/20 bg-zinc-900/60 p-8 shadow-xl"
                      >
                        <div className="flex items-start space-x-3">
                          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-indigo-500/30 bg-indigo-600/20">
                            <svg
                              className="h-4 w-4 text-indigo-400"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                              />
                            </svg>
                          </div>
                          <h3 className="text-base leading-snug font-bold text-white">{q.text}</h3>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          {q.options.map((opt) => (
                            <button
                              key={opt}
                              onClick={() => submitAnswer(opt)}
                              className="rounded-xl border border-zinc-800 bg-zinc-950/80 p-4 text-left text-xs font-bold text-zinc-400 transition-all hover:border-indigo-500/50 hover:bg-indigo-600/10 hover:text-indigo-300"
                            >
                              {opt}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Review / Synthesis Report */}
              {selectedTask?.status === WorkerTaskStatus.REVIEW && (
                <div className="space-y-6 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 shadow-xl">
                  <div className="flex items-center space-x-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-600/20">
                      <svg
                        className="h-4 w-4 text-violet-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                      </svg>
                    </div>
                    <div>
                      <div className="text-[9px] font-black tracking-widest text-zinc-600 uppercase">
                        Synthesis Report
                      </div>
                      <div className="text-sm font-bold text-white">
                        Task Complete — Awaiting Confirmation
                      </div>
                    </div>
                  </div>
                  <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/60 p-5 font-mono text-sm leading-relaxed whitespace-pre-wrap text-zinc-300">
                    {selectedTask.result}
                  </div>
                  <button
                    onClick={() =>
                      setTasks((prev) =>
                        prev.map((t) =>
                          t.id === selectedTask.id
                            ? { ...t, status: WorkerTaskStatus.COMPLETED }
                            : t,
                        ),
                      )
                    }
                    className="flex w-full items-center justify-center space-x-2 rounded-xl bg-emerald-600 py-4 text-xs font-black tracking-widest text-white uppercase shadow-lg shadow-emerald-600/20 transition-all hover:bg-emerald-500 active:scale-[0.99]"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2.5}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    <span>Finalize & Commit</span>
                  </button>
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
