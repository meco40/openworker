import { AgentV2Error } from '@/server/agent-v2/errors';
import { getAgentV2SessionManager } from '@/server/agent-v2/runtime';
import { registerMethod, type RespondFn } from '@/server/gateway/method-router';
import type { GatewayClient } from '@/server/gateway/client-registry';

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = String(params[key] || '').trim();
  if (!value) throw new AgentV2Error(`${key} is required`, 'INVALID_REQUEST');
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = String(params[key] || '').trim();
  return value || undefined;
}

function requiredBoolean(params: Record<string, unknown>, key: string): boolean {
  if (!(key in params)) throw new AgentV2Error(`${key} is required`, 'INVALID_REQUEST');
  return Boolean(params[key]);
}

registerMethod(
  'agent.v2.session.start',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const manager = getAgentV2SessionManager();
    const started = await manager.startSession({
      userId: client.userId,
      title: optionalString(params, 'title'),
    });
    respond({
      session: started.session,
      events: started.events,
    });
  },
  'v2',
);

registerMethod(
  'agent.v2.session.input',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const manager = getAgentV2SessionManager();
    const result = await manager.enqueueInput({
      sessionId: requiredString(params, 'sessionId'),
      userId: client.userId,
      content: requiredString(params, 'content'),
      idempotencyKey: optionalString(params, 'idempotencyKey'),
    });
    respond({
      command: result.command,
      session: result.session,
    });
  },
  'v2',
);

registerMethod(
  'agent.v2.session.steer',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const manager = getAgentV2SessionManager();
    const result = await manager.enqueueSteer({
      sessionId: requiredString(params, 'sessionId'),
      userId: client.userId,
      instruction: requiredString(params, 'instruction'),
      idempotencyKey: optionalString(params, 'idempotencyKey'),
    });
    respond({
      command: result.command,
      session: result.session,
    });
  },
  'v2',
);

registerMethod(
  'agent.v2.session.follow_up',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const manager = getAgentV2SessionManager();
    const result = await manager.enqueueFollowUp({
      sessionId: requiredString(params, 'sessionId'),
      userId: client.userId,
      content: requiredString(params, 'content'),
      idempotencyKey: optionalString(params, 'idempotencyKey'),
    });
    respond({
      command: result.command,
      session: result.session,
    });
  },
  'v2',
);

registerMethod(
  'agent.v2.session.approval.respond',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const manager = getAgentV2SessionManager();
    const result = await manager.enqueueApprovalResponse({
      sessionId: requiredString(params, 'sessionId'),
      userId: client.userId,
      approvalToken: requiredString(params, 'approvalToken'),
      approved: requiredBoolean(params, 'approved'),
      approveAlways: Boolean(params.approveAlways),
      toolId: optionalString(params, 'toolId'),
      toolFunctionName: optionalString(params, 'toolFunctionName'),
      idempotencyKey: optionalString(params, 'idempotencyKey'),
    });
    respond({
      command: result.command,
      session: result.session,
    });
  },
  'v2',
);

registerMethod(
  'agent.v2.session.abort',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const manager = getAgentV2SessionManager();
    const result = await manager.enqueueAbort({
      sessionId: requiredString(params, 'sessionId'),
      userId: client.userId,
      reason: optionalString(params, 'reason'),
      idempotencyKey: optionalString(params, 'idempotencyKey'),
    });
    respond({
      command: result.command,
      session: result.session,
    });
  },
  'v2',
);

registerMethod(
  'agent.v2.session.get',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const manager = getAgentV2SessionManager();
    const session = manager.getSession(requiredString(params, 'sessionId'), client.userId);
    respond({ session });
  },
  'v2',
);

registerMethod(
  'agent.v2.session.list',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const manager = getAgentV2SessionManager();
    const rawLimit = Number(params.limit);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : 50;
    const sessions = manager.listSessions(client.userId, limit);
    respond({ sessions });
  },
  'v2',
);

registerMethod(
  'agent.v2.session.replay',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const manager = getAgentV2SessionManager();
    const sessionId = requiredString(params, 'sessionId');
    const fromSeq = Number(params.fromSeq);
    if (!Number.isFinite(fromSeq) || fromSeq < 0) {
      throw new AgentV2Error('fromSeq must be a non-negative number', 'INVALID_REQUEST');
    }
    const rawLimit = Number(params.limit);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : undefined;
    const events = manager.replaySessionEvents({
      sessionId,
      userId: client.userId,
      fromSeq,
      limit,
    });
    respond({
      events,
      nextSeq: events.length > 0 ? events[events.length - 1].seq : fromSeq,
    });
  },
  'v2',
);
