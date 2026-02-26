/**
 * Types and interfaces for recall service
 */

export type StrictRecallCandidate = {
  source: 'chat' | 'memory';
  role: 'user' | 'agent' | 'system' | 'memory';
  text: string;
  createdAt?: string;
  normalized: string;
  topicHits: number;
  timeHits: number;
  score: number;
};
