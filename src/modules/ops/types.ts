import type { Conversation } from '@/shared/domain/types';
import type { PersonaSummary } from '@/server/personas/personaTypes';
import type { RoomRunState } from '@/server/rooms/types';

export interface OpsInstancesConnectionSummary {
  connId: string;
  connectedAt: string;
  subscriptionCount: number;
  requestCount: number;
  seq: number;
}

export interface OpsInstancesResponse {
  ok: true;
  instances: {
    global: {
      connectionCount: number;
      userCount: number;
    };
    currentUser: {
      connectionCount: number;
      connections: OpsInstancesConnectionSummary[];
    };
    generatedAt: string;
  };
}

export type OpsSessionSummary = Pick<
  Conversation,
  | 'id'
  | 'channelType'
  | 'externalChatId'
  | 'title'
  | 'modelOverride'
  | 'personaId'
  | 'createdAt'
  | 'updatedAt'
>;

export interface OpsSessionsResponse {
  ok: true;
  query: {
    q: string;
    limit: number;
    activeMinutes: number | null;
    includeGlobalRequested: boolean;
    includeGlobalApplied: boolean;
    includeUnknown: boolean;
  };
  sessions: OpsSessionSummary[];
  generatedAt: string;
}

export interface OpsNodeChannelSummary {
  channel: string;
  status: string;
  externalPeerId: string | null;
  peerName: string | null;
  transport: string | null;
  personaId: string | null;
  lastSeenAt: string | null;
  supportsInbound: boolean;
  supportsOutbound: boolean;
  supportsPairing: boolean;
  supportsStreaming: boolean;
  accounts?: Array<{
    accountId: string;
    pairingStatus: string | null;
    peerName: string | null;
    lastSeenAt: string | null;
    allowFrom: string[];
  }>;
}

export interface OpsNodesResponse {
  ok: true;
  mutation?: {
    action: string;
    [key: string]: unknown;
  };
  nodes: {
    health: {
      status: string;
      summary: {
        ok: number;
        warning: number;
        critical: number;
        skipped: number;
      };
      generatedAt: string;
    };
    doctor: {
      status: string;
      findings: number;
      recommendations: number;
      generatedAt: string;
    };
    channels: OpsNodeChannelSummary[];
    automation: {
      activeRules: number;
      queuedRuns: number;
      runningRuns: number;
      deadLetterRuns: number;
      leaseAgeSeconds: number | null;
    };
    personas: Array<{
      id: string;
      name: string;
      emoji: string;
      vibe: string;
      updatedAt: string;
    }>;
    execApprovals: {
      total: number;
      items: Array<{
        fingerprint: string;
        command: string;
        updatedAt: string;
      }>;
    };
    telegramPairing: {
      status: string;
      pendingChatId: string | null;
      pendingExpiresAt: string | null;
      hasPending: boolean;
    };
    rooms: {
      totalRooms: number;
      runningRooms: number;
      totalMembers: number;
      totalMessages: number;
    };
    generatedAt: string;
  };
}

export interface OpsAgentPersonaSummary extends Pick<
  PersonaSummary,
  'id' | 'name' | 'emoji' | 'vibe' | 'updatedAt'
> {
  activeRoomCount: number;
}

export interface OpsAgentRoomSnapshot {
  roomId: string;
  roomName: string;
  runState: RoomRunState;
  memberCount: number;
  runtimeByStatus: Record<string, number>;
  activeRun: {
    runId: string;
    runState: RoomRunState;
    leaseOwner: string | null;
    leaseExpiresAt: string | null;
    heartbeatAt: string | null;
  } | null;
}

export interface OpsAgentsResponse {
  ok: true;
  query: {
    limit: number;
  };
  agents: {
    personas: OpsAgentPersonaSummary[];
    sampledRooms: OpsAgentRoomSnapshot[];
    generatedAt: string;
  };
}
