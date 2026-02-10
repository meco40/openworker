import React from 'react';
import dynamic from 'next/dynamic';
import {
  type ChannelType,
  type Conversation,
  type CoupledChannel,
  type GatewayState,
  type Message,
  type MessageAttachment,
  type ScheduledTask,
  type Skill,
  type Team,
  View,
  type WorkerTask,
} from '../../../../types';
import Dashboard from '../../../../components/Dashboard';
import ChatInterface from '../../../../components/ChatInterface';
import ChannelPairing from '../../../../messenger/ChannelPairing';
import ViewErrorBoundary from '../../../../components/ViewErrorBoundary';

const WorkerView = dynamic(() => import('../../../../WorkerView'));
const TeamManager = dynamic(() => import('../../../../components/TeamManager'));
const ModelHub = dynamic(() => import('../../../../components/ModelHub'));
const SkillsRegistry = dynamic(() => import('../../../../skills/SkillsRegistry'));
const TaskManagerView = dynamic(() => import('../../tasks/components/TaskManagerView'));
const LogsView = dynamic(() => import('../../telemetry/components/LogsView'));
const SecurityView = dynamic(() => import('../../../../components/SecurityView'));
const ConfigEditor = dynamic(() => import('../../config/components/ConfigEditor'));
const ProfileView = dynamic(() => import('../../../../components/ProfileView'));
const ExposureManager = dynamic(() => import('../../exposure/components/ExposureManager'));

interface AppShellViewContentProps {
  currentView: View;
  gatewayState: GatewayState;
  scheduledTasks: ScheduledTask[];
  teams: Team[];
  setTeams: React.Dispatch<React.SetStateAction<Team[]>>;
  tasks: WorkerTask[];
  setTasks: React.Dispatch<React.SetStateAction<WorkerTask[]>>;
  skills: Skill[];
  setSkills: React.Dispatch<React.SetStateAction<Skill[]>>;
  messages: Message[];
  conversations: Conversation[];
  activeConversationId: string | null;
  isAgentTyping: boolean;
  onSendMessage: (content: string, platform: ChannelType, attachment?: MessageAttachment) => void;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  coupledChannels: Record<string, CoupledChannel>;
  onUpdateCoupling: (id: string, update: Partial<CoupledChannel>) => void;
  onSimulateIncoming: (content: string, platform: ChannelType) => void;
}

const AppShellViewContent: React.FC<AppShellViewContentProps> = ({
  currentView,
  gatewayState,
  scheduledTasks,
  teams,
  setTeams,
  tasks,
  setTasks,
  skills,
  setSkills,
  messages,
  conversations,
  activeConversationId,
  isAgentTyping,
  onSendMessage,
  onSelectConversation,
  onNewConversation,
  coupledChannels,
  onUpdateCoupling,
  onSimulateIncoming,
}) => {
  return (
    <div className="flex-1 overflow-auto p-6">
      {currentView === View.DASHBOARD && <ViewErrorBoundary label="Control Plane"><Dashboard state={{ ...gatewayState, scheduledTasks }} /></ViewErrorBoundary>}
      {currentView === View.WORKER && (
        <ViewErrorBoundary label="Autonomous Worker">
          <WorkerView teams={teams} tasks={tasks} setTasks={setTasks} skills={skills} />
        </ViewErrorBoundary>
      )}
      {currentView === View.TEAMS && <ViewErrorBoundary label="Team Collaboration"><TeamManager teams={teams} setTeams={setTeams} tasks={tasks} /></ViewErrorBoundary>}
      {currentView === View.MODELS && <ViewErrorBoundary label="AI Model Hub"><ModelHub /></ViewErrorBoundary>}
      {currentView === View.CHAT && (
        <ViewErrorBoundary label="Multi-Channel Inbox">
          <ChatInterface
            messages={messages}
            onSendMessage={onSendMessage}
            isTyping={isAgentTyping}
            conversations={conversations}
            activeConversationId={activeConversationId}
            onSelectConversation={onSelectConversation}
            onNewConversation={onNewConversation}
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
      {currentView === View.SKILLS && <ViewErrorBoundary label="Skill Registry"><SkillsRegistry skills={skills} setSkills={setSkills} /></ViewErrorBoundary>}
      {currentView === View.TASKS && <ViewErrorBoundary label="Task Monitor"><TaskManagerView /></ViewErrorBoundary>}
      {currentView === View.LOGS && <ViewErrorBoundary label="System Logs"><LogsView /></ViewErrorBoundary>}
      {currentView === View.SECURITY && <ViewErrorBoundary label="Security Panel"><SecurityView /></ViewErrorBoundary>}
      {currentView === View.CONFIG && <ViewErrorBoundary label="Gateway Config"><ConfigEditor /></ViewErrorBoundary>}
      {currentView === View.PROFILE && <ViewErrorBoundary label="SaaS Identity"><ProfileView /></ViewErrorBoundary>}
      {currentView === View.EXPOSURE && <ViewErrorBoundary label="Remote Exposure"><ExposureManager /></ViewErrorBoundary>}
    </div>
  );
};

export default AppShellViewContent;
