export interface PlanningOption {
  id: string;
  label: string;
}

export interface PlanningChoiceQuestion {
  question: string;
  options: PlanningOption[];
}

export interface PlanningMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface PlanningSessionState {
  taskId: string;
  sessionKey?: string;
  messages: PlanningMessage[];
  currentQuestion?: PlanningChoiceQuestion;
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
  onPlanningComplete?: (ctx: { taskId: string; dispatchError?: string }) => Promise<void> | void;
  onFallbackRefresh?: () => Promise<void> | void;
}
