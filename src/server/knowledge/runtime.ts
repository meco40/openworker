import { SqliteKnowledgeRepository } from './sqliteKnowledgeRepository';

declare global {
  var __knowledgeRepository: SqliteKnowledgeRepository | undefined;
}

export function getKnowledgeRepository(): SqliteKnowledgeRepository {
  if (!globalThis.__knowledgeRepository || globalThis.__knowledgeRepository.isClosed()) {
    globalThis.__knowledgeRepository = new SqliteKnowledgeRepository();
  }
  return globalThis.__knowledgeRepository;
}
