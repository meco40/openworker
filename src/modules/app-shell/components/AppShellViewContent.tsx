import React from 'react';
import dynamic from 'next/dynamic';
import {
  type ChatApprovalDecision,
  type ChannelType,
  type ControlPlaneMetricsState,
  type ChatStreamDebugState,
  type Conversation,
  type CoupledChannel,
  type GatewayState,
  type Message,
  type MessageApprovalRequest,
  type MessageAttachment,
  type ScheduledTask,
  type Skill,
  View,
} from '@/shared/domain/types';
import ViewErrorBoundary from '@/components/ViewErrorBoundary';

const ViewLoadingFallback: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex min-h-[240px] items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/40 text-xs font-semibold tracking-wide text-zinc-400">
    Loading {label}...
  </div>
);

function loading(label: string) {
  return function ViewLoading() {
    return <ViewLoadingFallback label={label} />;
  };
}

const Dashboard = dynamic(() => import('@/components/Dashboard'), {
  loading: loading('Control Plane'),
});
const ChatInterface = dynamic(() => import('@/components/ChatInterface'), {
  loading: loading('Multi-Channel Inbox'),
});
const ChannelPairing = dynamic(() => import('@/messenger/ChannelPairing'), {
  loading: loading('Messenger Coupling'),
});
const ModelHub = dynamic(() => import('@/components/ModelHub'), {
  loading: loading('AI Model Hub'),
});
const SkillsRegistry = dynamic(() => import('@/skills/SkillsRegistry'), {
  loading: loading('Skill Registry'),
});
const TaskManagerView = dynamic(() => import('@/modules/tasks/components/TaskManagerView'), {
  loading: loading('Task Monitor'),
});
const LogsView = dynamic(() => import('@/modules/telemetry/components/LogsView'), {
  loading: loading('System Logs'),
});
const SecurityView = dynamic(() => import('@/components/SecurityView'), {
  loading: loading('Security Panel'),
});
const ConfigEditor = dynamic(() => import('@/modules/config/components/ConfigEditor'), {
  loading: loading('Gateway Config'),
});
const ProfileView = dynamic(() => import('@/components/ProfileView'), {
  loading: loading('Operator Profile'),
});
const ExposureManager = dynamic(() => import('@/modules/exposure/components/ExposureManager'), {
  loading: loading('Remote Exposure'),
});
const StatsView = dynamic(() => import('@/components/StatsView'), {
  loading: loading('Usage Stats'),
});
const PersonasView = dynamic(() => import('@/components/PersonasView'), {
  loading: loading('Agent Personas'),
});
const MemoryView = dynamic(() => import('@/components/MemoryView'), {
  loading: loading('Memory'),
});
const KnowledgeView = dynamic(() => import('@/components/KnowledgeView'), {
  loading: loading('Knowledge'),
});
const CronView = dynamic(() => import('@/modules/cron/components/CronView'), {
  loading: loading('Cron'),
});
const InstancesView = dynamic(() => import('@/modules/ops/components/InstancesView'), {
  loading: loading('Instances'),
});
const SessionsView = dynamic(() => import('@/modules/ops/components/SessionsView'), {
  loading: loading('Sessions'),
});
const NodesView = dynamic(() => import('@/modules/ops/components/NodesView'), {
  loading: loading('Nodes'),
});
const AgentsView = dynamic(() => import('@/modules/ops/components/AgentsView'), {
  loading: loading('Agents'),
});
const ConversationDebuggerView = dynamic(
  () => import('@/modules/conversation-debugger/ConversationDebuggerView'),
  { loading: loading('Conversation Debugger') },
);

interface AppShellViewContentProps {
  currentView: View;
  gatewayState: GatewayState;
  controlPlaneMetricsState: ControlPlaneMetricsState;
  scheduledTasks: ScheduledTask[];
  skills: Skill[];
  setSkills: React.Dispatch<React.SetStateAction<Skill[]>>;
  messages: Message[];
  conversations: Conversation[];
  activeConversationId: string | null;
  activePersonaId?: string | null;
  isAgentTyping: boolean;
  chatStreamDebug: ChatStreamDebugState;
  onSendMessage: (
    content: string,
    platform: ChannelType,
    attachment?: MessageAttachment,
    conversationId?: string,
    personaId?: string,
  ) => void | Promise<void>;
  onRespondApproval: (
    message: Message,
    approvalRequest: MessageApprovalRequest,
    decision: ChatApprovalDecision,
  ) => void;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => void;
  coupledChannels: Record<string, CoupledChannel>;
  onUpdateCoupling: (id: string, update: Partial<CoupledChannel>) => void;
  onSimulateIncoming: (content: string, platform: ChannelType) => void;
}

const AppShellViewContent: React.FC<AppShellViewContentProps> = ({
  currentView,
  gatewayState,
  controlPlaneMetricsState,
  scheduledTasks,
  skills,
  setSkills,
  messages,
  conversations,
  activeConversationId,
  activePersonaId,
  isAgentTyping,
  chatStreamDebug,
  onSendMessage,
  onRespondApproval,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  coupledChannels,
  onUpdateCoupling,
  onSimulateIncoming,
}) => {
  return (
    <div className="flex-1 overflow-auto p-6">
      {currentView === View.DASHBOARD && (
        <ViewErrorBoundary label="Control Plane">
          <Dashboard
            state={{ ...gatewayState, scheduledTasks }}
            metricsState={controlPlaneMetricsState}
          />
        </ViewErrorBoundary>
      )}
      {currentView === View.MODELS && (
        <ViewErrorBoundary label="AI Model Hub">
          <ModelHub />
        </ViewErrorBoundary>
      )}
      {currentView === View.CHAT && (
        <ViewErrorBoundary label="Multi-Channel Inbox">
          <ChatInterface
            messages={messages}
            onSendMessage={onSendMessage}
            onRespondApproval={onRespondApproval}
            isTyping={isAgentTyping}
            chatStreamDebug={chatStreamDebug}
            conversations={conversations}
            activeConversationId={activeConversationId}
            activePersonaId={activePersonaId}
            onSelectConversation={onSelectConversation}
            onNewConversation={onNewConversation}
            onDeleteConversation={onDeleteConversation}
          />
        </ViewErrorBoundary>
      )}
      {currentView === View.CHANNELS && (
        <ViewErrorBoundary label="Messenger Coupling">
          <ChannelPairing
            coupledChannels={coupledChannels}
            onUpdateCoupling={onUpdateCoupling}
            onSimulateIncoming={onSimulateIncoming}
          />
        </ViewErrorBoundary>
      )}
      {currentView === View.SKILLS && (
        <ViewErrorBoundary label="Skill Registry">
          <SkillsRegistry skills={skills} setSkills={setSkills} />
        </ViewErrorBoundary>
      )}
      {currentView === View.TASKS && (
        <ViewErrorBoundary label="Task Monitor">
          <TaskManagerView />
        </ViewErrorBoundary>
      )}
      {currentView === View.INSTANCES && (
        <ViewErrorBoundary label="Instances">
          <InstancesView />
        </ViewErrorBoundary>
      )}
      {currentView === View.SESSIONS && (
        <ViewErrorBoundary label="Sessions">
          <SessionsView />
        </ViewErrorBoundary>
      )}
      {currentView === View.CRON && (
        <ViewErrorBoundary label="Cron">
          <CronView />
        </ViewErrorBoundary>
      )}
      {currentView === View.NODES && (
        <ViewErrorBoundary label="Nodes">
          <NodesView />
        </ViewErrorBoundary>
      )}
      {currentView === View.AGENTS && (
        <ViewErrorBoundary label="Agents">
          <AgentsView />
        </ViewErrorBoundary>
      )}
      {currentView === View.LOGS && (
        <ViewErrorBoundary label="System Logs">
          <LogsView />
        </ViewErrorBoundary>
      )}
      {currentView === View.SECURITY && (
        <ViewErrorBoundary label="Security Panel">
          <SecurityView />
        </ViewErrorBoundary>
      )}
      {currentView === View.CONFIG && (
        <ViewErrorBoundary label="Gateway Config">
          <ConfigEditor />
        </ViewErrorBoundary>
      )}
      {currentView === View.PROFILE && (
        <ViewErrorBoundary label="Operator Profile">
          <ProfileView metricsState={controlPlaneMetricsState} />
        </ViewErrorBoundary>
      )}
      {currentView === View.EXPOSURE && (
        <ViewErrorBoundary label="Remote Exposure">
          <ExposureManager />
        </ViewErrorBoundary>
      )}
      {currentView === View.STATS && (
        <ViewErrorBoundary label="Usage Stats">
          <StatsView />
        </ViewErrorBoundary>
      )}
      {currentView === View.PERSONAS && (
        <ViewErrorBoundary label="Agent Personas">
          <PersonasView />
        </ViewErrorBoundary>
      )}
      {currentView === View.MEMORY && (
        <ViewErrorBoundary label="Memory">
          <MemoryView />
        </ViewErrorBoundary>
      )}
      {currentView === View.KNOWLEDGE && (
        <ViewErrorBoundary label="Knowledge">
          <KnowledgeView />
        </ViewErrorBoundary>
      )}
      {currentView === View.DEBUGGER && (
        <ViewErrorBoundary label="Conversation Debugger">
          <ConversationDebuggerView />
        </ViewErrorBoundary>
      )}
    </div>
  );
};

export default AppShellViewContent;
