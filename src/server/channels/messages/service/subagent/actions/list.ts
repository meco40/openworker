import { listSubagentRunsForConversation } from '@/server/agents/subagentRegistry';
import { SUBAGENT_RECENT_MINUTES } from '../constants';
import type { ActionResult } from '../types';

export function formatSubagentList(conversationId: string): string {
  const runs = listSubagentRunsForConversation(conversationId, SUBAGENT_RECENT_MINUTES);
  const lines: string[] = [];
  lines.push('Subagents');
  lines.push('');
  lines.push('active:');
  if (runs.active.length === 0) {
    lines.push('(none)');
  } else {
    runs.active.forEach((run, index) => {
      lines.push(`${index + 1}. ${run.agentId} (${run.runId.slice(0, 8)}) - running`);
    });
  }
  lines.push('');
  lines.push(`recent (last ${SUBAGENT_RECENT_MINUTES}m):`);
  if (runs.recent.length === 0) {
    lines.push('(none)');
  } else {
    runs.recent.forEach((run, index) => {
      const status = run.status;
      const preview = (run.resultPreview || run.error || '').trim();
      const suffix = preview ? ` - ${preview.slice(0, 80)}` : '';
      lines.push(`${index + 1}. ${run.agentId} (${run.runId.slice(0, 8)}) - ${status}${suffix}`);
    });
  }
  return lines.join('\n');
}

export function executeListAction(conversationId: string): ActionResult {
  const runs = listSubagentRunsForConversation(conversationId, SUBAGENT_RECENT_MINUTES);
  return {
    text: formatSubagentList(conversationId),
    payload: {
      status: 'ok',
      action: 'list',
      active: runs.active,
      recent: runs.recent,
    },
  };
}
