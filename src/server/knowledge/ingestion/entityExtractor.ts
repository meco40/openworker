import { createId } from '@/shared/lib/ids';
import {
  EntityExtractor,
  isRelationWord,
  type ExtractedEntity,
} from '@/server/knowledge/entityExtractor';
import { expandMultilingualAliases } from '@/server/knowledge/multilingualAliases';
import { detectProjectStatusSignal } from '@/server/knowledge/projectTracker';
import type { IngestionWindow } from '@/server/knowledge/ingestionCursor';
import type { KnowledgeRepositoryLike } from './types';
import { DEFAULT_RELATION_CONFIDENCE } from './constants';

export interface EntityProcessingContext {
  window: IngestionWindow;
  entities: ExtractedEntity[];
}

export interface EntityProcessingResult {
  created: number;
  merged: number;
  relationsAdded: number;
}

interface PendingRelation {
  entityId: string;
  relations: {
    targetName: string;
    relationType: string;
    direction: 'outgoing' | 'incoming';
  }[];
}

/**
 * Normalize self-references in entity names to the persona name.
 */
export function normalizeSelfReferences(
  entities: ExtractedEntity[],
  personaName: string,
  personaId: string,
): void {
  if (!entities || personaName === personaId) return;

  const selfRefs = new Set(['ich', 'me', 'myself', personaId.toLowerCase()]);

  for (const entity of entities) {
    // Replace entity name if it's a self-reference
    if (selfRefs.has(entity.name.toLowerCase())) {
      entity.name = personaName;
    }
    // Also fix relation targets that are self-references
    if (entity.relations) {
      for (const rel of entity.relations) {
        if (selfRefs.has(rel.targetName.toLowerCase())) {
          rel.targetName = personaName;
        }
      }
    }
  }
}

/**
 * Post-extraction speaker role validation for events.
 * Cross-checks speakerRole against subject entity name.
 */
export function validateEventSpeakerRoles(
  events: ExtractedEvent[] | undefined,
  entities: ExtractedEntity[] | undefined,
  personaName: string,
): void {
  if (!events || !personaName) return;

  // Collect known user-entity names from extraction
  const userEntityNames = new Set<string>();
  userEntityNames.add('user');
  if (entities) {
    for (const ent of entities) {
      if (ent.owner === 'user' && ent.category === 'person') {
        userEntityNames.add(ent.name.toLowerCase());
      }
    }
  }

  const personaLower = personaName.toLowerCase();

  for (const event of events) {
    const subjectLower = event.subject?.toLowerCase() || '';
    if (subjectLower === personaLower && event.speakerRole !== 'assistant') {
      event.speakerRole = 'assistant';
    } else if (userEntityNames.has(subjectLower) && event.speakerRole !== 'user') {
      event.speakerRole = 'user';
    }
  }
}

// Import type for events
import type { ExtractedEvent } from '@/server/knowledge/eventExtractor';

/**
 * Process and store entities to the knowledge repository.
 * Uses a two-pass approach: first create/merge entities, then add relations.
 */
export function storeEntities(
  repo: KnowledgeRepositoryLike,
  context: EntityProcessingContext,
): EntityProcessingResult {
  const { window, entities } = context;

  if (
    !entities ||
    entities.length === 0 ||
    !repo.upsertEntity ||
    !repo.addAlias ||
    !repo.resolveEntity
  ) {
    return { created: 0, merged: 0, relationsAdded: 0 };
  }

  const entityExtractor = new EntityExtractor();
  const upsertEntity = repo.upsertEntity.bind(repo);
  const addAlias = repo.addAlias.bind(repo);
  const resolveEntity = repo.resolveEntity.bind(repo);

  // PASS 1: Create/merge all entities + aliases (no relations yet)
  const pendingRelations: PendingRelation[] = [];
  let created = 0;
  let merged = 0;

  for (const rawEntity of entities) {
    const validated = entityExtractor.validateOwner(rawEntity, window.messages);
    if (!validated.name) continue;

    const graphFilter = { userId: window.userId, personaId: window.personaId };
    const existing = resolveEntity(validated.name, graphFilter);

    const verdict = entityExtractor.mergeWithExisting(
      validated,
      existing?.entity ?? null,
      existing && repo.getEntityWithRelations
        ? repo.getEntityWithRelations(existing.entity.id).aliases
        : [],
    );

    let entityId: string;

    if (verdict.action === 'create') {
      const newEntity = upsertEntity({
        id: createId('ent'),
        userId: window.userId,
        personaId: window.personaId,
        canonicalName: validated.name,
        category: validated.category,
        owner: validated.owner,
        properties: validated.properties,
      });
      entityId = newEntity.id;
      created++;

      // Add original aliases + multilingual expansions
      const allAliases = new Set(validated.aliases);
      for (const alias of validated.aliases) {
        for (const expanded of expandMultilingualAliases(alias)) {
          allAliases.add(expanded);
        }
      }

      for (const alias of allAliases) {
        addAlias({
          entityId: newEntity.id,
          alias,
          aliasType: isRelationWord(alias) ? 'relation' : 'name',
          owner: validated.owner,
          confidence: DEFAULT_RELATION_CONFIDENCE,
        });
      }

      // Project status tracking
      if (validated.category === 'project') {
        const messageText = window.messages.map((m) => String(m.content || '')).join(' ');
        const projectStatus = detectProjectStatusSignal(messageText);
        if (projectStatus && repo.updateEntityProperties) {
          repo.updateEntityProperties(newEntity.id, {
            ...validated.properties,
            projectStatus,
          });
        }
      }
    } else {
      entityId = existing!.entity.id;
      merged++;

      // Merge: add new aliases and properties
      const newAliases = verdict.newAliases;
      if (newAliases && newAliases.length > 0) {
        const expandedNewAliases = new Set<string>(newAliases);
        for (const alias of newAliases) {
          for (const expanded of expandMultilingualAliases(alias)) {
            expandedNewAliases.add(expanded);
          }
        }
        for (const alias of expandedNewAliases) {
          addAlias({
            entityId: existing!.entity.id,
            alias,
            aliasType: isRelationWord(alias) ? 'relation' : 'name',
            owner: validated.owner,
            confidence: DEFAULT_RELATION_CONFIDENCE,
          });
        }
      }
      if (verdict.updates?.properties && repo.updateEntityProperties) {
        repo.updateEntityProperties(existing!.entity.id, verdict.updates.properties);
      }
    }

    // Collect relations for pass 2
    if (verdict.relations && verdict.relations.length > 0) {
      pendingRelations.push({ entityId, relations: verdict.relations });
    }
  }

  // PASS 2: Store all relations (all entities now exist)
  let relationsAdded = 0;
  if (repo.addRelation && pendingRelations.length > 0) {
    const graphFilter = { userId: window.userId, personaId: window.personaId };
    for (const { entityId, relations } of pendingRelations) {
      for (const rel of relations) {
        const target = resolveEntity(rel.targetName, graphFilter);
        if (target) {
          repo.addRelation({
            sourceEntityId: rel.direction === 'outgoing' ? entityId : target.entity.id,
            targetEntityId: rel.direction === 'outgoing' ? target.entity.id : entityId,
            relationType: rel.relationType,
            properties: {},
            confidence: DEFAULT_RELATION_CONFIDENCE,
          });
          relationsAdded++;
        }
      }
    }
  }

  return { created, merged, relationsAdded };
}
