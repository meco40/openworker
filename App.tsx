'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, GatewayState, ChannelType, CoupledChannel, Message, SystemLog, Team, WorkerTask, Skill, ScheduledTask } from './types';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import ChatInterface from './components/ChatInterface';
import SkillsRegistry from './skills/SkillsRegistry';
import TerminalWizard from './components/TerminalWizard';
import { LiveCanvas } from './components/LiveCanvas';
import ChannelPairing from './messenger/ChannelPairing';
import SecurityView from './components/SecurityView';
import ProfileView from './components/ProfileView';
import WorkerView from './WorkerView';
import TeamManager from './components/TeamManager';

import ModelHub from './components/ModelHub';
import TaskManagerView from './components/TaskManagerView';
import LogsView from './components/LogsView';
import ConfigEditor from './components/ConfigEditor';
import ExposureManager from './components/ExposureManager';

import { ai, SYSTEM_INSTRUCTION } from './services/gemini';
import { mapSkillsToTools } from './skills/definitions';
import { executeSkillFunctionCall } from './skills/execute';
import { CORE_MEMORY_TOOLS, handleCoreMemoryCall, getMemorySnapshot } from './core/memory';
import { INITIAL_TEAMS, INITIAL_SKILLS } from './constants';
import type { GatewayChat, GatewayStreamChunk } from './services/gemini';

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<View>(View.DASHBOARD);
  const [onboarded, setOnboarded] = useState<boolean>(false);
  const [isCanvasOpen, setIsCanvasOpen] = useState(false);
  const [teams, setTeams] = useState<Team[]>(INITIAL_TEAMS);
  const [tasks, setTasks] = useState<WorkerTask[]>([]);
  const [skills, setSkills] = useState<Skill[]>(INITIAL_SKILLS);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const [isAgentTyping, setIsAgentTyping] = useState(false);
  
  const [coupledChannels, setCoupledChannels] = useState<Record<string, CoupledChannel>>({
    whatsapp: { type: ChannelType.WHATSAPP, status: 'idle' },
    telegram: { type: ChannelType.TELEGRAM, status: 'idle' },
    discord: { type: ChannelType.DISCORD, status: 'idle' },
    imessage: { type: ChannelType.IMESSAGE, status: 'idle' }
  });

  const [messages, setMessages] = useState<Message[]>([
    { id: 'msg-init', role: 'system', content: 'Gateway Core initialized. Temporal Task Engine Standing By.', timestamp: '14:00', platform: ChannelType.WEBCHAT }
  ]);

  const [gatewayState, setGatewayState] = useState<GatewayState>({
    version: '1.2.5-proactive', uptime: 0, cpuUsage: 12, memoryUsage: 256, activeSessions: 1, onboarded: false, totalTokens: 0,
    eventHistory: [{ timestamp: new Date().toLocaleTimeString(), type: 'SYS', message: 'Gateway Core initialized.' }],
    trafficData: Array.from({ length: 12 }, (_, i) => ({ name: `${i * 2}:00`, tokens: 0 })),
    memoryEntries: [],
    scheduledTasks: []
  });

  const chatRef = useRef<GatewayChat | null>(null);

  const addEventLog = useCallback((type: SystemLog['type'], message: string) => {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setGatewayState(prev => ({ 
      ...prev, 
      eventHistory: [{ timestamp, type, message }, ...prev.eventHistory].slice(0, 50) 
    }));
  }, []);

  const updateMemoryDisplay = useCallback(() => {
    const nodes = getMemorySnapshot();
    setGatewayState(prev => ({
      ...prev,
      memoryEntries: nodes.map(n => ({
        id: n.id,
        type: n.type,
        content: n.content,
        timestamp: n.timestamp,
        importance: n.importance
      }))
    }));
  }, []);

  useEffect(() => {
    const pulse = setInterval(() => {
      const now = new Date();
      setScheduledTasks(prev => {
        const toTrigger = prev.filter(t => t.status === 'pending' && new Date(t.targetTime) <= now);
        if (toTrigger.length > 0) {
          toTrigger.forEach(task => {
            const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            setMessages(msgs => [...msgs, {
              id: `reminder-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
              role: 'agent',
              content: `🔔 PROAKTIVE ERINNERUNG: ${task.content}`,
              timestamp,
              platform: task.platform
            }]);
            addEventLog('TASK', `Reminder triggered: ${task.content.slice(0, 20)}...`);
          });
          return prev.map(t => (new Date(t.targetTime) <= now ? { ...t, status: 'triggered' } : t));
        }
        return prev;
      });
    }, 15000);
    return () => clearInterval(pulse);
  }, [addEventLog]);

  useEffect(() => {
    const optionalTools = mapSkillsToTools(skills, 'gemini');
    const allTools = [...CORE_MEMORY_TOOLS, ...optionalTools];

    chatRef.current = ai.chats.create({ 
      model: 'gemini-3-flash-preview', 
      config: { 
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: allTools
      } 
    });
  }, [skills]);

  const handleAgentResponse = useCallback(async (userContent: string, platform: ChannelType) => {
    if (!chatRef.current) {
      addEventLog('SYS', 'Chat instance not initialized.');
      return;
    }
    
    setIsAgentTyping(true);
    const agentMsgId = `msg-agent-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    setMessages(prev => [...prev, { id: agentMsgId, role: 'agent', content: '', timestamp, platform }]);
    
    try {
      const result = await chatRef.current.sendMessageStream({ message: userContent });
      let fullText = '';
      const toolOutputs: Array<{ name: string; result?: unknown; error?: string }> = [];
      
      for await (const chunk of result) {
        const c = chunk as GatewayStreamChunk;
        
        if (c.functionCalls) {
          for (const fc of c.functionCalls) {
            if (fc.name === 'core_task_schedule') {
              const { time_iso, message } = fc.args as any;
              const newTask: ScheduledTask = {
                id: `task-${Date.now()}`,
                targetTime: time_iso,
                content: message,
                platform,
                status: 'pending'
              };
              setScheduledTasks(prev => [...prev, newTask]);
              addEventLog('TASK', `Cron scheduled: ${new Date(time_iso).toLocaleString()}`);
              toolOutputs.push({ name: fc.name, result: { status: 'scheduled', task: newTask } });
            } else {
              const memoryResult = await handleCoreMemoryCall(fc.name, fc.args);
              if (memoryResult) {
                if (memoryResult?.action === 'store') {
                  updateMemoryDisplay();
                  addEventLog('MEM', `Knowledge stored.`);
                }
                toolOutputs.push({ name: fc.name, result: memoryResult });
                continue;
              }

              try {
                const skillResult = await executeSkillFunctionCall(fc.name, fc.args, skills);
                if (skillResult !== null) {
                  addEventLog('TOOL', `${fc.name} executed.`);
                  toolOutputs.push({ name: fc.name, result: skillResult });
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : 'Skill execution failed';
                addEventLog('SYS', `${fc.name} failed: ${message}`);
                toolOutputs.push({ name: fc.name, error: message });
              }
            }
          }
        }
        
        const chunkText = c.text || '';
        if (chunkText) {
          fullText += chunkText;
          setMessages(prev => prev.map(m => m.id === agentMsgId ? { ...m, content: fullText } : m));
        }
      }

      if (toolOutputs.length > 0 && chatRef.current) {
        const toolSummary = JSON.stringify(toolOutputs, null, 2);
        const followUp = await chatRef.current.sendMessageStream({
          message: `Tool outputs for the previous user request "${userContent}":\n${toolSummary}\nUse these results to provide the final response to the user.`,
        });

        for await (const chunk of followUp) {
          const text = chunk.text || '';
          if (text) {
            fullText += (fullText ? '\n' : '') + text;
            setMessages(prev => prev.map(m => m.id === agentMsgId ? { ...m, content: fullText } : m));
          }
        }
      }

      if (!fullText.trim()) {
        const fallback = 'Tool execution completed. No textual assistant output was produced.';
        setMessages(prev => prev.map(m => m.id === agentMsgId ? { ...m, content: fallback } : m));
      }
    } catch (error) { 
        console.error("Agent Stream Error:", error);
        addEventLog('SYS', 'Bridge signal lost.'); 
        setMessages(prev => prev.map(m => m.id === agentMsgId ? { ...m, content: '⚠️ Signal lost during transmission. Please retry.' } : m));
    } finally {
        setIsAgentTyping(false);
    }
  }, [addEventLog, skills, updateMemoryDisplay]);

  const routeMessage = useCallback(async (content: string, platform: ChannelType, role: 'user' | 'agent' | 'system') => {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const msgId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    
    setMessages(prev => [...prev, { id: msgId, role, content, timestamp, platform }]);
    
    if (role === 'system') {
      addEventLog('SYS', content);
    } else {
      addEventLog('CHAN', `Signal via ${platform}`);
    }

    if (role === 'user') {
      await handleAgentResponse(content, platform);
    }
  }, [addEventLog, handleAgentResponse]);

  if (!onboarded) return <TerminalWizard onComplete={() => setOnboarded(true)} />;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0a0a0a] text-zinc-300">
      <Sidebar activeView={currentView} onViewChange={setCurrentView} onToggleCanvas={() => setIsCanvasOpen(!isCanvasOpen)} />
      <main className="flex-1 flex flex-col relative overflow-hidden">
        <header className="h-16 border-b border-zinc-800 flex items-center justify-between px-6 bg-[#0c0c0c] z-10">
          <div className="flex items-center space-x-4">
            <h1 className="text-lg font-bold text-white tracking-tight">OpenClaw Gateway</h1>
            <div className="px-2 py-0.5 rounded border border-violet-500/30 bg-violet-500/5 text-[9px] font-black text-violet-400 uppercase tracking-widest">Active Bridge Node</div>
          </div>
          <div className="flex items-center space-x-6">
             <div className="text-right"> 
                <div className="text-[10px] text-zinc-600 uppercase">Active Crons</div> 
                <div className="text-emerald-500 font-mono font-bold">{scheduledTasks.filter(t => t.status === 'pending').length}</div> 
             </div>
             <div className="text-right"> 
                <div className="text-[10px] text-zinc-600 uppercase">Vector DB</div> 
                <div className="text-zinc-300 font-mono">{gatewayState.memoryEntries.length}</div> 
             </div>
          </div>
        </header>
        <div className="flex-1 overflow-auto p-6">
          {currentView === View.DASHBOARD && <Dashboard state={{...gatewayState, scheduledTasks}} />}
          {currentView === View.WORKER && <WorkerView teams={teams} tasks={tasks} setTasks={setTasks} skills={skills} />}
          {currentView === View.TEAMS && <TeamManager teams={teams} setTeams={setTeams} tasks={tasks} />}
          {currentView === View.MODELS && <ModelHub />}
          {currentView === View.CHAT && (
            <ChatInterface 
              coupledChannels={coupledChannels} 
              messages={messages} 
              onSendMessage={(c, p) => routeMessage(c, p, 'user')}
              isTyping={isAgentTyping}
            />
          )}
          {currentView === View.CHANNELS && <ChannelPairing coupledChannels={coupledChannels} onUpdateCoupling={(id, u) => setCoupledChannels(prev => ({ ...prev, [id]: { ...prev[id], ...u } }))} onSimulateIncoming={(c, p) => routeMessage(c, p, 'user')} />}
          {currentView === View.SKILLS && <SkillsRegistry skills={skills} setSkills={setSkills} />}
          {currentView === View.TASKS && <TaskManagerView />}
          {currentView === View.LOGS && <LogsView />}
          {currentView === View.SECURITY && <SecurityView />}
          {currentView === View.CONFIG && <ConfigEditor />}
          {currentView === View.PROFILE && <ProfileView />}
          {currentView === View.EXPOSURE && <ExposureManager />}
        </div>
      </main>
      {isCanvasOpen && <LiveCanvas onClose={() => setIsCanvasOpen(false)} isVisionEnabled={skills.find(s => s.id === 'vision')?.installed} />}
    </div>
  );
};

export default App;
