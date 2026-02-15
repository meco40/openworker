import { SqliteKnowledgeRepository } from './sqliteKnowledgeRepository';
import { resolveKnowledgeConfig } from './config';
import { KnowledgeIngestionService } from './ingestionService';
import { KnowledgeRetrievalService } from './retrievalService';

declare global {
  var __knowledgeRepository: SqliteKnowledgeRepository | undefined;
}

export function getKnowledgeRepository(): SqliteKnowledgeRepository {
  if (!globalThis.__knowledgeRepository || globalThis.__knowledgeRepository.isClosed()) {
    globalThis.__knowledgeRepository = new SqliteKnowledgeRepository();
  }
  return globalThis.__knowledgeRepository;
}

export function getKnowledgeRetrievalService(): KnowledgeRetrievalService {
  const config = resolveKnowledgeConfig();
  return new KnowledgeRetrievalService(getKnowledgeRepository(), {
    maxContextChars: Math.max(800, config.maxContextTokens * 4),
  });
}

export function getKnowledgeIngestionService(): KnowledgeIngestionService {
  return new KnowledgeIngestionService(getKnowledgeRepository());
}
