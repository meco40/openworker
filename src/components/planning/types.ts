export interface PlanningOption {
  id: string;
  label: string;
}

export interface PlanningQuestion {
  question: string;
  options: PlanningOption[];
}

export interface PlanningMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface PlanningState {
  taskId: string;
  sessionKey?: string;
  messages: PlanningMessage[];
  currentQuestion?: PlanningQuestion;
  isComplete: boolean;
  dispatchError?: string;
  spec?: {
    title: string;
    summary: string;
    deliverables: string[];
    success_criteria: string[];
    constraints: Record<string, unknown>;
  };
  agents?: Array<{
    name: string;
    role: string;
    avatar_emoji: string;
    soul_md: string;
    instructions: string;
  }>;
  isStarted: boolean;
}

export interface PlanningTabProps {
  taskId: string;
  onSpecLocked?: () => void;
}
