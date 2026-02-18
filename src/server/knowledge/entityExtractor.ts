/**
 * Entity Extractor — normalizes, validates, and merges LLM-extracted entities
 * before they are persisted to the knowledge entity graph.
 */
import type { EntityAlias, EntityCategory, KnowledgeEntity } from './entityGraph';
import type { StoredMessage } from '../channels/messages/repository';

/**
 * Shape returned by the LLM for each entity in the extraction JSON.
 */
export interface ExtractedEntity {
  name: string;
  category: EntityCategory;
  owner: 'persona' | 'user' | 'shared';
  aliases: string[];
  relations: {
    targetName: string;
    relationType: string;
    direction: 'outgoing' | 'incoming';
  }[];
  properties: Record<string, string>;
  sourceSeq: number[];
}

/** Relation-indicating alias words (German). */
const RELATION_WORDS = new Set([
  'bruder',
  'schwester',
  'mutter',
  'vater',
  'freund',
  'freundin',
  'tante',
  'onkel',
  'oma',
  'opa',
  'partner',
  'partnerin',
  'chef',
  'kollege',
  'kollegin',
  'nachbar',
  'nachbarin',
]);

/** Returns true if the alias text looks like a relation word (e.g. "Bruder"). */
export function isRelationWord(alias: string): boolean {
  const normalized = alias
    .toLowerCase()
    .replace(/^(mein|meine|dein|deine|sein|seine|ihr|ihre)\s+/i, '');
  return RELATION_WORDS.has(normalized);
}

export interface MergeVerdict {
  action: 'create' | 'merge';
  updates?: { properties?: Record<string, string> };
  newAliases?: string[];
  /** Relations to process — carried through for both create and merge paths */
  relations?: ExtractedEntity['relations'];
}

export class EntityExtractor {
  /**
   * Validates LLM-extracted entities and normalizes them.
   * Filters out entries with empty names or invalid categories.
   */
  normalizeEntities(rawEntities: unknown[], messages: StoredMessage[]): ExtractedEntity[] {
    const results: ExtractedEntity[] = [];
    if (!Array.isArray(rawEntities)) return results;

    for (const raw of rawEntities) {
      if (!raw || typeof raw !== 'object') continue;
      const obj = raw as Record<string, unknown>;

      const name = String(obj.name || '').trim();
      if (!name) continue;

      const category = String(obj.category || 'person') as EntityCategory;
      const validCategories: EntityCategory[] = [
        'person',
        'project',
        'place',
        'organization',
        'concept',
        'object',
      ];
      if (!validCategories.includes(category)) continue;

      const owner = String(obj.owner || 'shared') as 'persona' | 'user' | 'shared';
      const validOwners = ['persona', 'user', 'shared'];
      if (!validOwners.includes(owner)) continue;

      const aliases = Array.isArray(obj.aliases)
        ? (obj.aliases as unknown[]).map((a) => String(a).trim()).filter((a) => a.length > 0)
        : [];

      const relations = Array.isArray(obj.relations)
        ? (obj.relations as unknown[])
            .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
            .map((r) => ({
              targetName: String(r.targetName || '').trim(),
              relationType: String(r.relationType || '')
                .trim()
                .toLowerCase(),
              direction: (String(r.direction) === 'incoming' ? 'incoming' : 'outgoing') as
                | 'outgoing'
                | 'incoming',
            }))
            .filter((r) => r.targetName.length > 0 && r.relationType.length > 0)
        : [];

      const properties =
        obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)
          ? Object.fromEntries(
              Object.entries(obj.properties as Record<string, unknown>).map(([k, v]) => [
                k,
                String(v),
              ]),
            )
          : {};

      const sourceSeq = Array.isArray(obj.sourceSeq)
        ? (obj.sourceSeq as unknown[])
            .map((s) => Number(s))
            .filter((s) => Number.isFinite(s) && s > 0)
        : [];

      const entity: ExtractedEntity = {
        name,
        category,
        owner,
        aliases,
        relations,
        properties,
        sourceSeq,
      };

      // Validate owner against message roles
      results.push(this.validateOwner(entity, messages));
    }

    return results;
  }

  /**
   * Owner-Validierung gegen message.role (wie bei Events).
   * If sourceSeq maps to a single message, that message's role wins.
   */
  validateOwner(entity: ExtractedEntity, messages: StoredMessage[]): ExtractedEntity {
    if (entity.sourceSeq.length === 0) return entity;

    const seqToRole = new Map<number, string>();
    for (const msg of messages) {
      const seq = Number(msg.seq);
      if (Number.isFinite(seq)) {
        seqToRole.set(seq, msg.role);
      }
    }

    const roles = new Set(
      entity.sourceSeq.map((seq) => seqToRole.get(seq)).filter((r): r is string => !!r),
    );

    if (roles.size === 1) {
      const role = [...roles][0];
      const ownerFromRole: 'persona' | 'user' = role === 'user' ? 'user' : 'persona';
      // Only override if the entity has a possessive-based owner claim
      if (entity.owner !== 'shared') {
        return { ...entity, owner: ownerFromRole };
      }
    }

    return entity;
  }

  /**
   * Merge-Logik: Wenn Entity bereits im Graph existiert, zusammenfuehren.
   * Returns whether to create a new entity or merge into existing.
   */
  mergeWithExisting(
    extracted: ExtractedEntity,
    existing: KnowledgeEntity | null,
    existingAliases: EntityAlias[],
  ): MergeVerdict {
    if (!existing) {
      return {
        action: 'create',
        relations: extracted.relations.length > 0 ? extracted.relations : undefined,
      };
    }

    // Merge: find new aliases and properties
    const existingAliasSet = new Set(existingAliases.map((a) => a.alias.toLowerCase()));
    const newAliases = extracted.aliases.filter((a) => !existingAliasSet.has(a.toLowerCase()));

    const newProperties: Record<string, string> = {};
    let hasNewProperties = false;
    for (const [key, value] of Object.entries(extracted.properties)) {
      if (!(key in existing.properties) || existing.properties[key] !== value) {
        newProperties[key] = value;
        hasNewProperties = true;
      }
    }

    return {
      action: 'merge',
      updates: hasNewProperties ? { properties: newProperties } : undefined,
      newAliases: newAliases.length > 0 ? newAliases : undefined,
      relations: extracted.relations.length > 0 ? extracted.relations : undefined,
    };
  }
}
