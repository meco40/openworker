import { Type, FunctionDeclaration } from '@google/genai';

export const memoryStoreSpec: FunctionDeclaration = {
  name: 'core_memory_store',
  description:
    "INTERNAL CORE: Persist critical information, user preferences, or 'lessons learned' to the system's long-term memory graph.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      type: {
        type: Type.STRING,
        enum: [
          'fact',
          'preference',
          'avoidance',
          'lesson',
          'personality_trait',
          'workflow_pattern',
        ],
        description: 'The category of memory.',
      },
      content: { type: Type.STRING, description: 'The information to be remembered.' },
      importance: { type: Type.NUMBER, description: 'Priority level (1-5).' },
    },
    required: ['type', 'content'],
  },
};

export const memoryRecallSpec: FunctionDeclaration = {
  name: 'core_memory_recall',
  description:
    "INTERNAL CORE: Retrieve historical data or context from the system's long-term memory graph based on a semantic query.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: 'The topic or fact to search for in memory.' },
    },
    required: ['query'],
  },
};

export const taskScheduleSpec: FunctionDeclaration = {
  name: 'core_task_schedule',
  description:
    'Schedule a reminder or a proactive message for a specific future time. Use this for appointments, deadlines, or when the user asks to be reminded.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      time_iso: {
        type: Type.STRING,
        description: 'The exact ISO 8601 timestamp for the reminder (e.g., 2025-05-20T10:00:00Z).',
      },
      message: { type: Type.STRING, description: 'The content of the reminder to be sent.' },
    },
    required: ['time_iso', 'message'],
  },
};

export const CORE_MEMORY_TOOLS = [
  { functionDeclarations: [memoryStoreSpec, memoryRecallSpec, taskScheduleSpec] },
];
