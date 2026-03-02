import type { ContextBuilder } from '@/server/channels/messages/contextBuilder';
import type { Conversation } from '@/server/channels/messages/repository';
import type { RecallService } from '@/server/channels/messages/service/recall';
import { repairOrphanedToolCalls } from '@/server/channels/messages/service/transcriptRepair';
import { buildActiveSkillsPromptSection } from '@/server/channels/messages/service/dispatchers/skillsPrompt';
import type { DispatchMessage } from './types';

interface PrepareDispatchMessagesDeps {
  contextBuilder: ContextBuilder;
  recallService: RecallService;
  resolveConversationWorkspaceCwd?: (conversation: Conversation) => string | undefined;
}

interface PrepareDispatchMessagesParams {
  conversation: Conversation;
  userInput: string;
  executionDirective?: string;
  toolsDisabled?: boolean;
}

interface PrepareDispatchMessagesResult {
  messages: DispatchMessage[];
  memoryContext: string | null;
}

function prependExecutionDirective(messages: DispatchMessage[], executionDirective?: string): void {
  if (!executionDirective?.trim()) {
    return;
  }
  messages.unshift({
    role: 'system',
    content: executionDirective.trim(),
  });
}

function prependMemoryContext(messages: DispatchMessage[], memoryContext: string): void {
  messages.unshift({
    role: 'system',
    content: [
      'Relevant memory context (use this to ground your answers):',
      memoryContext,
      '',
      'Interpretation rules:',
      '- Memories tagged "[Subject: user]" describe the user, not the assistant/persona.',
      '- Memories tagged "[Subject: assistant]" describe you (the persona).',
      '- Memories tagged "[Subject: assistant, Self-Reference]" contain statements you made about yourself (e.g., "I slept with Max").',
      '- When the user asks "Did you...?" and a memory says "I...", the answer is YES.',
      '- Never claim user preferences, habits, or facts as your own.',
      '- When the user asks about something mentioned in [Chat History], reference the specific content rather than paraphrasing from later conversation patterns.',
      '- User messages in [Chat History] represent explicit instructions or facts - prioritize them over assistant summaries.',
    ].join('\n'),
  });
}

async function prependSkillsGuidance(
  messages: DispatchMessage[],
  conversation: Conversation,
  resolveConversationWorkspaceCwd?: (conversation: Conversation) => string | undefined,
): Promise<void> {
  try {
    const { loadAllSkillMd, filterEligibleSkills } = await import('@/server/skills/skillMd/index');
    const [{ BUILT_IN_SKILLS }, { getSkillRepository }] = await Promise.all([
      import('@/server/skills/builtInSkills'),
      import('@/server/skills/skillRepository'),
    ]);
    const skillRepo = await getSkillRepository();
    const installedSkills = skillRepo.listSkills().filter((skill) => skill.installed);
    const workspaceCwd = conversation.id
      ? resolveConversationWorkspaceCwd?.(conversation)
      : undefined;
    const allParsed = loadAllSkillMd({ workspaceCwd: workspaceCwd ?? undefined });
    const eligible = filterEligibleSkills(allParsed);
    const skillsSection = buildActiveSkillsPromptSection({
      installedSkills,
      eligibleParsedSkills: eligible,
      builtInSeeds: BUILT_IN_SKILLS,
    });
    if (skillsSection) {
      messages.unshift({ role: 'system', content: skillsSection });
    }
  } catch {
    // Non-fatal: if skill guidance fails to load, continue without it.
  }
}

export async function prepareDispatchMessages(
  deps: PrepareDispatchMessagesDeps,
  params: PrepareDispatchMessagesParams,
): Promise<PrepareDispatchMessagesResult> {
  let messages = deps.contextBuilder.buildGatewayMessages(
    params.conversation.id,
    params.conversation.userId,
    50,
    params.conversation.personaId,
  );
  messages = repairOrphanedToolCalls(messages);

  prependExecutionDirective(messages, params.executionDirective);

  const memoryContext = await deps.recallService.buildRecallContext(
    params.conversation,
    params.userInput,
  );
  if (memoryContext) {
    prependMemoryContext(messages, memoryContext);
  }

  if (!params.toolsDisabled) {
    await prependSkillsGuidance(
      messages,
      params.conversation,
      deps.resolveConversationWorkspaceCwd,
    );
  }

  return {
    messages,
    memoryContext: memoryContext ?? null,
  };
}
