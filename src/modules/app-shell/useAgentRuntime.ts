import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { ChannelType, Message, ScheduledTask, Skill, SystemLog } from '../../../types';
import { ai, getSystemInstruction } from '../../../services/gateway';
import type { GatewayChat, GatewayStreamChunk } from '../../../services/gateway';
import { mapSkillsToTools } from '../../../skills/definitions';
import { executeSkillFunctionCall } from '../../../skills/execute';
import { subscribeClawHubChanged } from '../../../skills/clawhub-events';
import { CORE_MEMORY_TOOLS, handleCoreMemoryCall } from '../../../core/memory';
import { createAgentPlaceholder } from '../chat/services/handleAgentResponse';
import { parseTaskScheduleArgs } from './taskScheduling';
import { usePersona } from '../personas/PersonaContext';
import { buildSystemInstruction } from './systemInstruction';

interface UseAgentRuntimeArgs {
  skills: Skill[];
  addEventLog: (type: SystemLog['type'], message: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setScheduledTasks: React.Dispatch<React.SetStateAction<ScheduledTask[]>>;
  updateMemoryDisplay: () => Promise<void>;
}

export function useAgentRuntime({
  skills,
  addEventLog,
  setMessages,
  setScheduledTasks,
  updateMemoryDisplay,
}: UseAgentRuntimeArgs) {
  const [isAgentTyping, setIsAgentTyping] = useState(false);
  const [clawHubPromptBlock, setClawHubPromptBlock] = useState('');
  const chatRef = useRef<GatewayChat | null>(null);
  const { activePersona } = usePersona();

  useEffect(() => {
    let disposed = false;

    const loadClawHubPrompt = async () => {
      try {
        const response = await fetch('/api/clawhub/prompt');
        const data = (await response.json()) as { ok?: boolean; prompt?: string };
        if (disposed) return;
        if (data.ok && typeof data.prompt === 'string') {
          setClawHubPromptBlock(data.prompt);
          return;
        }
      } catch {
        // ignore prompt loading errors; ClawHub prompt is optional context
      }
      if (!disposed) {
        setClawHubPromptBlock('');
      }
    };

    void loadClawHubPrompt();
    const unsubscribe = subscribeClawHubChanged(
      typeof window !== 'undefined' ? window : null,
      () => {
        void loadClawHubPrompt();
      },
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const optionalTools = mapSkillsToTools(skills, 'gemini');
    const allTools = [...CORE_MEMORY_TOOLS, ...optionalTools];

    // Build system instruction from active persona or fall back to default
    const instruction = buildSystemInstruction({
      baseInstruction: getSystemInstruction(),
      personaFiles: activePersona?.files || null,
      clawHubPromptBlock,
    });

    chatRef.current = ai.chats.create({
      config: {
        systemInstruction: instruction,
        tools: allTools,
      },
    });
  }, [skills, activePersona, clawHubPromptBlock]);

  const handleAgentResponse = useCallback(
    async (userContent: string, platform: ChannelType) => {
      if (!chatRef.current) {
        addEventLog('SYS', 'Chat instance not initialized.');
        return;
      }

      setIsAgentTyping(true);
      const agentPlaceholder = createAgentPlaceholder(platform);
      const agentMessageId = agentPlaceholder.id;
      setMessages((previous) => [...previous, agentPlaceholder]);

      try {
        const result = await chatRef.current.sendMessageStream({ message: userContent });
        let fullText = '';
        const toolOutputs: Array<{ name: string; result?: unknown; error?: string }> = [];

        for await (const chunk of result) {
          const typedChunk = chunk as GatewayStreamChunk;

          if (typedChunk.functionCalls) {
            const skillCalls: Array<
              Promise<{ name: string; result?: unknown; error?: string; skipped?: boolean }>
            > = [];

            for (const functionCall of typedChunk.functionCalls) {
              if (functionCall.name === 'core_task_schedule') {
                const { time_iso, message } = parseTaskScheduleArgs(functionCall.args);
                if (!time_iso || !message) {
                  toolOutputs.push({
                    name: functionCall.name,
                    error: 'Missing time_iso or message for core_task_schedule.',
                  });
                  continue;
                }

                const newTask: ScheduledTask = {
                  id: `task-${Date.now()}`,
                  targetTime: time_iso,
                  content: message,
                  platform,
                  status: 'pending',
                };
                setScheduledTasks((previous) => [...previous, newTask]);
                addEventLog('TASK', `Cron scheduled: ${new Date(time_iso).toLocaleString()}`);
                toolOutputs.push({
                  name: functionCall.name,
                  result: { status: 'scheduled', task: newTask },
                });
                continue;
              }

              if (
                functionCall.name === 'core_memory_store' ||
                functionCall.name === 'core_memory_recall'
              ) {
                const memoryResult = await handleCoreMemoryCall(
                  functionCall.name,
                  functionCall.args,
                  activePersona?.id,
                );
                if (memoryResult) {
                  if (memoryResult.action === 'store') {
                    await updateMemoryDisplay();
                    addEventLog('MEM', 'Knowledge stored.');
                  }
                  toolOutputs.push({ name: functionCall.name, result: memoryResult });
                }
                continue;
              }

              skillCalls.push(
                (async () => {
                  try {
                    const skillResult = await executeSkillFunctionCall(
                      functionCall.name,
                      functionCall.args,
                      skills,
                    );
                    if (skillResult === null) {
                      return { name: functionCall.name, skipped: true };
                    }
                    return { name: functionCall.name, result: skillResult };
                  } catch (error) {
                    const message =
                      error instanceof Error ? error.message : 'Skill execution failed';
                    return { name: functionCall.name, error: message };
                  }
                })(),
              );
            }

            const skillResults = await Promise.all(skillCalls);
            for (const skillOutput of skillResults) {
              if (skillOutput.skipped) {
                continue;
              }
              if (skillOutput.error) {
                addEventLog('SYS', `${skillOutput.name} failed: ${skillOutput.error}`);
                toolOutputs.push({ name: skillOutput.name, error: skillOutput.error });
                continue;
              }
              addEventLog('TOOL', `${skillOutput.name} executed.`);
              toolOutputs.push({ name: skillOutput.name, result: skillOutput.result });
            }
          }

          const chunkText = typedChunk.text || '';
          if (chunkText) {
            fullText += chunkText;
            setMessages((previous) =>
              previous.map((message) =>
                message.id === agentMessageId ? { ...message, content: fullText } : message,
              ),
            );
          }
        }

        if (toolOutputs.length > 0 && chatRef.current) {
          const toolSummary = JSON.stringify(toolOutputs, null, 2);
          const followUp = await chatRef.current.sendMessageStream({
            message: `Tool outputs for the previous user request "${userContent}":\n${toolSummary}\nUse these results to provide the final response to the user.`,
          });

          for await (const chunk of followUp) {
            const text = chunk.text || '';
            if (!text) {
              continue;
            }
            fullText += (fullText ? '\n' : '') + text;
            setMessages((previous) =>
              previous.map((message) =>
                message.id === agentMessageId ? { ...message, content: fullText } : message,
              ),
            );
          }
        }

        if (!fullText.trim()) {
          const fallback = 'Tool execution completed. No textual assistant output was produced.';
          setMessages((previous) =>
            previous.map((message) =>
              message.id === agentMessageId ? { ...message, content: fallback } : message,
            ),
          );
        }
      } catch (error) {
        console.error('Agent Stream Error:', error);
        addEventLog('SYS', 'Bridge signal lost.');
        setMessages((previous) =>
          previous.map((message) =>
            message.id === agentMessageId
              ? { ...message, content: '⚠️ Signal lost during transmission. Please retry.' }
              : message,
          ),
        );
      } finally {
        setIsAgentTyping(false);
      }
    },
    [activePersona?.id, addEventLog, setMessages, setScheduledTasks, skills, updateMemoryDisplay],
  );

  return {
    isAgentTyping,
    handleAgentResponse,
  };
}
