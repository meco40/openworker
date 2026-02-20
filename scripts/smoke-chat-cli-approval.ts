import { createRequire } from 'node:module';
import { GatewayRpcClient } from '../src/cli/lib/gatewayRpc';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

type Decision = 'approve_once' | 'approve_always' | 'deny' | 'skip';

interface CliOptions {
  url?: string;
  conversationId?: string;
  personaId?: string;
  message: string;
  decision: Decision;
  waitMs: number;
}

interface ChatHistoryMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  metadata?: string | null;
  createdAt: string;
  seq?: number;
}

interface ParsedMetadata {
  status?: unknown;
  approvalToken?: unknown;
  approval_token?: unknown;
  approvalPrompt?: unknown;
  approval_prompt?: unknown;
  approvalToolId?: unknown;
  approvalToolFunction?: unknown;
}

interface ApprovalCandidate {
  message: ChatHistoryMessage;
  token: string;
  prompt?: string;
  toolId?: string;
  toolFunctionName?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const optionValue = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index < 0 || index >= args.length - 1) return undefined;
    const [value] = args.splice(index, 2).slice(1);
    return String(value || '').trim() || undefined;
  };

  const url = optionValue('--url');
  const conversationId = optionValue('--conversation');
  const personaId = optionValue('--persona');
  const messageOption = optionValue('--message');
  const decisionRaw = (optionValue('--decision') || 'approve_once').toLowerCase();
  const waitMsRaw = Number(optionValue('--wait-ms') || '1200');
  const waitMs = Number.isFinite(waitMsRaw) && waitMsRaw >= 0 ? Math.floor(waitMsRaw) : 1200;
  const message = (messageOption || args.join(' ')).trim();

  if (!message) {
    throw new Error(
      'Usage: npm run smoke:chat-cli-approval -- --message "..." or trailing text.\n' +
        'Example: npm run smoke:chat-cli-approval -- "Nutze shell_execute und fuehre echo smoke aus."',
    );
  }

  const allowedDecisions: Decision[] = ['approve_once', 'approve_always', 'deny', 'skip'];
  const decision = allowedDecisions.includes(decisionRaw as Decision)
    ? (decisionRaw as Decision)
    : 'approve_once';

  return {
    url,
    conversationId,
    personaId,
    message,
    decision,
    waitMs,
  };
}

function parseMetadata(raw: string | null | undefined): ParsedMetadata | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as ParsedMetadata;
  } catch {
    return null;
  }
}

function resolveApprovalCandidate(messages: ChatHistoryMessage[]): ApprovalCandidate | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'agent') continue;

    const metadata = parseMetadata(message.metadata);
    if (!metadata) continue;
    if (String(metadata.status || '').trim() !== 'approval_required') continue;

    const tokenValue =
      typeof metadata.approvalToken === 'string'
        ? metadata.approvalToken
        : typeof metadata.approval_token === 'string'
          ? metadata.approval_token
          : '';
    const token = tokenValue.trim();
    if (!token) continue;

    const prompt =
      typeof metadata.approvalPrompt === 'string'
        ? metadata.approvalPrompt.trim() || undefined
        : typeof metadata.approval_prompt === 'string'
          ? metadata.approval_prompt.trim() || undefined
          : undefined;
    const toolId =
      typeof metadata.approvalToolId === 'string'
        ? metadata.approvalToolId.trim() || undefined
        : undefined;
    const toolFunctionName =
      typeof metadata.approvalToolFunction === 'string'
        ? metadata.approvalToolFunction.trim() || undefined
        : undefined;

    return {
      message,
      token,
      prompt,
      toolId,
      toolFunctionName,
    };
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHistory(
  client: GatewayRpcClient,
  conversationId: string,
  limit = 40,
): Promise<ChatHistoryMessage[]> {
  const payload = await client.request('chat.history', { conversationId, limit });
  if (!Array.isArray(payload)) return [];

  return payload
    .filter((entry): entry is ChatHistoryMessage => {
      if (!entry || typeof entry !== 'object') return false;
      const typed = entry as Record<string, unknown>;
      return (
        typeof typed.id === 'string' &&
        typeof typed.role === 'string' &&
        typeof typed.content === 'string' &&
        typeof typed.createdAt === 'string'
      );
    })
    .map((entry) => ({
      id: entry.id,
      role: entry.role,
      content: entry.content,
      metadata: entry.metadata ?? null,
      createdAt: entry.createdAt,
      seq: entry.seq,
    }));
}

function printFinalMessage(message: ChatHistoryMessage | undefined): void {
  if (!message) {
    console.log('No final agent message found after approval step.');
    return;
  }
  console.log('\n--- Final Agent Message ---');
  console.log(message.content || '(empty)');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const client = await GatewayRpcClient.connect({ url: options.url, timeoutMs: 60_000 });

  try {
    let conversationId = options.conversationId;
    if (!conversationId) {
      const resetPayload = (await client.request('sessions.reset', {
        title: `Smoke ${new Date().toISOString()}`,
      })) as { conversationId?: string };
      conversationId = String(resetPayload?.conversationId || '').trim();
      if (!conversationId) {
        throw new Error('Could not create a conversation via sessions.reset.');
      }
    }

    console.log(`Conversation: ${conversationId}`);
    console.log(`Decision: ${options.decision}`);
    console.log('--- Streaming ---');

    await client.requestStream(
      'chat.stream',
      {
        conversationId,
        content: options.message,
        personaId: options.personaId || undefined,
        clientMessageId: `smoke-${Date.now()}`,
      },
      (delta) => {
        if (!delta) return;
        process.stdout.write(delta);
      },
    );
    process.stdout.write('\n');

    const historyAfterStream = await fetchHistory(client, conversationId, 60);
    const approval = resolveApprovalCandidate(historyAfterStream);

    if (!approval) {
      console.log('\nNo approval_required message found.');
      console.log(
        'If your prompt did not trigger shell_execute, rerun with a stricter tool prompt.',
      );
      const latestAgent = [...historyAfterStream].reverse().find((entry) => entry.role === 'agent');
      printFinalMessage(latestAgent);
      return;
    }

    console.log('\nApproval token detected.');
    if (approval.prompt) {
      console.log('--- Approval Prompt ---');
      console.log(approval.prompt);
    }

    if (options.decision === 'skip') {
      console.log('Decision=skip, not sending chat.approval.respond.');
      return;
    }

    const approved = options.decision !== 'deny';
    const approveAlways = options.decision === 'approve_always';
    const beforeLastId = historyAfterStream[historyAfterStream.length - 1]?.id;

    const approvalResult = await client.request('chat.approval.respond', {
      conversationId,
      approvalToken: approval.token,
      approved,
      approveAlways,
      toolId: approval.toolId,
      toolFunctionName: approval.toolFunctionName,
    });
    console.log('\n--- Approval Result ---');
    console.log(JSON.stringify(approvalResult, null, 2));

    if (!approved) {
      return;
    }

    const maxPolls = 8;
    let finalAgent: ChatHistoryMessage | undefined;
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      await sleep(options.waitMs);
      const history = await fetchHistory(client, conversationId, 80);
      const latestAgent = [...history].reverse().find((entry) => entry.role === 'agent');
      if (!latestAgent) continue;
      if (latestAgent.id === approval.message.id || latestAgent.id === beforeLastId) continue;
      finalAgent = latestAgent;
      break;
    }

    printFinalMessage(finalAgent);
  } finally {
    client.close();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Smoke test failed: ${message}`);
  process.exitCode = 1;
});
