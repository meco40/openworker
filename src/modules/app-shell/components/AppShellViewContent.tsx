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
} from '../../../../types';
import Dashboard from '../../../../components/Dashboard';
import ChatInterface from '../../../../components/ChatInterface';
import ChannelPairing from '../../../../messenger/ChannelPairing';
import ViewErrorBoundary from '../../../../components/ViewErrorBoundary';

const ModelHub = dynamic(() => import('../../../../components/ModelHub'));
const SkillsRegistry = dynamic(() => import('../../../../skills/SkillsRegistry'));
const TaskManagerView = dynamic(() => import('../../tasks/components/TaskManagerView'));
const LogsView = dynamic(() => import('../../telemetry/components/LogsView'));
const SecurityView = dynamic(() => import('../../../../components/SecurityView'));
const ConfigEditor = dynamic(() => import('../../config/components/ConfigEditor'));
const ProfileView = dynamic(() => import('../../../../components/ProfileView'));
const ExposureManager = dynamic(() => import('../../exposure/components/ExposureManager'));
const StatsView = dynamic(() => import('../../../../components/StatsView'));
const PersonasView = dynamic(() => import('../../../../components/PersonasView'));
const MemoryView = dynamic(() => import('../../../../components/MemoryView'));

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
  isAgentTyping: boolean;
  chatStreamDebug: ChatStreamDebugState;
  onSendMessage: (content: string, platform: ChannelType, attachment?: MessageAttachment) => void;
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
    </div>
  );
};

export default AppShellViewContent;
