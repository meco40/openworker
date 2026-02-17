/**
 * Knowledge Entity Graph — Types + Interfaces
 *
 * Enables the system to recognize that "Max", "mein Bruder", and "er"
 * refer to the same entity. The graph stores entities with aliases and
 * directional relations (e.g. Max --bruder--> Nata).
 */

export type EntityCategory =
  | 'person' // Max, Lisa, Tante Erna
  | 'project' // Notes2, MeinBlog
  | 'place' // Berlin, Buero, Zuhause
  | 'organization' // Siemens, BMW
  | 'concept' // Next.js, TypeScript, Prisma
  | 'object'; // Auto, Laptop

export interface KnowledgeEntity {
  id: string; // ent-xxx
  userId: string;
  personaId: string;
  canonicalName: string; // "Max"
  category: EntityCategory;
  owner: 'persona' | 'user' | 'shared'; // whose "Bruder"?
  properties: Record<string, string>; // {beruf: "Ingenieur", alter: "28"}
  createdAt: string;
  updatedAt: string;
}

export interface EntityAlias {
  id: string;
  entityId: string; // FK → knowledge_entities
  alias: string; // "mein Bruder", "Bruder", "er"
  aliasType: 'name' | 'relation' | 'pronoun' | 'abbreviation';
  owner: 'persona' | 'user' | 'shared'; // "MEIN Bruder" → owner
  confidence: number; // 0.0–1.0
  createdAt: string;
}

export interface EntityRelation {
  id: string;
  sourceEntityId: string; // FK → knowledge_entities
  targetEntityId: string; // FK → knowledge_entities
  relationType: string; // "bruder", "framework", "auftraggeber"
  properties: Record<string, string>; // {seit: "2026-01", status: "aktiv"}
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface EntityLookupResult {
  entity: KnowledgeEntity;
  matchedAlias: string;
  matchType: 'exact_name' | 'alias' | 'relation' | 'fuzzy';
  confidence: number;
}

export interface EntityGraphFilter {
  userId: string;
  personaId: string;
  category?: EntityCategory;
  owner?: 'persona' | 'user' | 'shared';
}
