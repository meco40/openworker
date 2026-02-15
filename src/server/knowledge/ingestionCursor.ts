import type { MessageRepository, StoredMessage } from '../channels/messages/repository';
import type { KnowledgeIngestionCheckpoint, KnowledgeRepository } from './repository';

const DEFAULT_WINDOW_LIMIT = 200;
const FULL_SCAN_LIMIT = Number.MAX_SAFE_INTEGER;
type CursorMessageRepository = Pick<MessageRepository, 'listMessages' | 'listMessagesAfterSeq'>;
type CursorKnowledgeRepository = Pick<
  KnowledgeRepository,
  'getIngestionCheckpoint' | 'upsertIngestionCheckpoint'
>;

export interface TranscriptCursorScope {
  userId: string;
  personaId: string;
  conversationId: string;
}

export interface TranscriptIngestionWindow {
  fromSeqExclusive: number;
  toSeqInclusive: number;
  messages: StoredMessage[];
}

function normalizeLimit(limit: number | undefined): number {
  const normalized = Number(limit);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return DEFAULT_WINDOW_LIMIT;
  }
  return Math.floor(normalized);
}

function normalizeSeq(seq: number): number {
  if (!Number.isFinite(seq) || seq < 0) return 0;
  return Math.floor(seq);
}

function hasNumericSeq(message: StoredMessage): message is StoredMessage & { seq: number } {
  return typeof message.seq === 'number' && Number.isFinite(message.seq);
}

function compareBySeq(a: StoredMessage & { seq: number }, b: StoredMessage & { seq: number }): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
  return a.id.localeCompare(b.id);
}

export class TranscriptIngestionCursor {
  constructor(
    private readonly dependencies: {
      messageRepository: CursorMessageRepository;
      knowledgeRepository: CursorKnowledgeRepository;
    },
  ) {}

  getWindow(scope: TranscriptCursorScope, limit = DEFAULT_WINDOW_LIMIT): TranscriptIngestionWindow {
    const normalizedLimit = normalizeLimit(limit);
    const checkpoint =
      this.dependencies.knowledgeRepository.getIngestionCheckpoint(
        scope.userId,
        scope.personaId,
        scope.conversationId,
      ) || null;
    const fromSeqExclusive = normalizeSeq(checkpoint?.lastProcessedSeq || 0);

    const messages = this.listMessagesAfterSeq(scope, fromSeqExclusive, normalizedLimit);
    const toSeqInclusive =
      messages.length > 0
        ? normalizeSeq(messages[messages.length - 1]?.seq || fromSeqExclusive)
        : fromSeqExclusive;

    return {
      fromSeqExclusive,
      toSeqInclusive,
      messages,
    };
  }

  advanceCheckpoint(
    scope: TranscriptCursorScope,
    processedThroughSeq: number,
    updatedAt?: string,
  ): KnowledgeIngestionCheckpoint {
    const requestedSeq = normalizeSeq(processedThroughSeq);
    const existing =
      this.dependencies.knowledgeRepository.getIngestionCheckpoint(
        scope.userId,
        scope.personaId,
        scope.conversationId,
      ) || null;
    const currentSeq = normalizeSeq(existing?.lastProcessedSeq || 0);
    const nextSeq = Math.max(currentSeq, requestedSeq);

    return this.dependencies.knowledgeRepository.upsertIngestionCheckpoint({
      userId: scope.userId,
      personaId: scope.personaId,
      conversationId: scope.conversationId,
      lastProcessedSeq: nextSeq,
      updatedAt,
    });
  }

  ingest(scope: TranscriptCursorScope, limit = DEFAULT_WINDOW_LIMIT): TranscriptIngestionWindow {
    const window = this.getWindow(scope, limit);
    if (window.messages.length === 0) {
      return window;
    }

    const checkpoint = this.advanceCheckpoint(scope, window.toSeqInclusive);
    return {
      fromSeqExclusive: window.fromSeqExclusive,
      toSeqInclusive: checkpoint.lastProcessedSeq,
      messages: window.messages,
    };
  }

  private listMessagesAfterSeq(
    scope: TranscriptCursorScope,
    afterSeq: number,
    limit: number,
  ): StoredMessage[] {
    const { messageRepository } = this.dependencies;
    const helper = messageRepository.listMessagesAfterSeq;

    if (typeof helper === 'function') {
      return messageRepository
        .listMessagesAfterSeq!(scope.conversationId, afterSeq, limit, scope.userId)
        .filter(hasNumericSeq)
        .sort(compareBySeq)
        .slice(0, limit);
    }

    return messageRepository
      .listMessages(scope.conversationId, FULL_SCAN_LIMIT, undefined, scope.userId)
      .filter(hasNumericSeq)
      .filter((message) => message.seq > afterSeq)
      .sort(compareBySeq)
      .slice(0, limit);
  }
}
