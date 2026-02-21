import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  KnowledgeEntity,
  EntityAlias,
  EntityRelation,
  EntityGraphFilter,
  EntityLookupResult,
} from '@/server/knowledge/entityGraph';
import { parseJsonObject } from './utils';

export class EntityRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  upsertEntity(input: Omit<KnowledgeEntity, 'createdAt' | 'updatedAt'>): KnowledgeEntity {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO knowledge_entities (
          id, user_id, persona_id, canonical_name, category, owner, properties_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, persona_id, canonical_name, owner)
        DO UPDATE SET
          category = excluded.category,
          properties_json = excluded.properties_json,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        input.id,
        input.userId,
        input.personaId,
        input.canonicalName,
        input.category,
        input.owner,
        JSON.stringify(input.properties),
        now,
        now,
      );

    return { ...input, createdAt: now, updatedAt: now };
  }

  addAlias(alias: Omit<EntityAlias, 'id' | 'createdAt'>): void {
    const id = `ealias-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO knowledge_entity_aliases (id, entity_id, alias, alias_type, owner, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_id, alias, owner) DO UPDATE SET
          alias_type = excluded.alias_type,
          confidence = excluded.confidence
        `,
      )
      .run(id, alias.entityId, alias.alias, alias.aliasType, alias.owner, alias.confidence, now);
  }

  addRelation(relation: Omit<EntityRelation, 'id' | 'createdAt' | 'updatedAt'>): void {
    const id = `erel-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO knowledge_entity_relations (
          id, source_entity_id, target_entity_id, relation_type, properties_json, confidence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_entity_id, target_entity_id, relation_type) DO UPDATE SET
          properties_json = excluded.properties_json,
          confidence = excluded.confidence,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        id,
        relation.sourceEntityId,
        relation.targetEntityId,
        relation.relationType,
        JSON.stringify(relation.properties),
        relation.confidence,
        now,
        now,
      );
  }

  updateEntityProperties(entityId: string, properties: Record<string, string>): void {
    const row = this.db
      .prepare('SELECT properties_json FROM knowledge_entities WHERE id = ?')
      .get(entityId) as { properties_json: string } | undefined;
    if (!row) return;

    const existing = parseJsonObject(row.properties_json) as Record<string, string>;
    const merged = { ...existing, ...properties };
    this.db
      .prepare('UPDATE knowledge_entities SET properties_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(merged), new Date().toISOString(), entityId);
  }

  resolveEntity(text: string, filter: EntityGraphFilter): EntityLookupResult | null {
    const normalized = text
      .toLowerCase()
      .replace(/^(mein|meine|dein|deine|sein|seine|ihr|ihre)\s+/i, '');

    // 1. Exact name match
    const byName = this.db
      .prepare(
        `SELECT * FROM knowledge_entities
         WHERE user_id = ? AND persona_id = ? AND LOWER(canonical_name) = ?
         LIMIT 1`,
      )
      .get(filter.userId, filter.personaId, normalized) as Record<string, unknown> | undefined;
    if (byName) {
      return {
        entity: this.mapEntityRow(byName),
        matchedAlias: text,
        matchType: 'exact_name',
        confidence: 1.0,
      };
    }

    // 2. Alias match (including relation words)
    const byAlias = this.db
      .prepare(
        `SELECT e.*, a.alias AS matched_alias, a.alias_type, a.confidence AS alias_confidence
         FROM knowledge_entity_aliases a
         JOIN knowledge_entities e ON e.id = a.entity_id
         WHERE e.user_id = ? AND e.persona_id = ? AND LOWER(a.alias) = ?
         ORDER BY a.confidence DESC LIMIT 1`,
      )
      .get(filter.userId, filter.personaId, normalized) as Record<string, unknown> | undefined;
    if (byAlias) {
      return {
        entity: this.mapEntityRow(byAlias),
        matchedAlias: String(byAlias.matched_alias),
        matchType: 'alias',
        confidence: Number(byAlias.alias_confidence),
      };
    }

    // 3. Fuzzy match (prefix LIKE)
    const byFuzzy = this.db
      .prepare(
        `SELECT e.*, a.alias AS matched_alias
         FROM knowledge_entity_aliases a
         JOIN knowledge_entities e ON e.id = a.entity_id
         WHERE e.user_id = ? AND e.persona_id = ? AND LOWER(a.alias) LIKE ?
         ORDER BY LENGTH(a.alias) ASC LIMIT 1`,
      )
      .get(filter.userId, filter.personaId, `${normalized}%`) as
      | Record<string, unknown>
      | undefined;
    if (byFuzzy) {
      return {
        entity: this.mapEntityRow(byFuzzy),
        matchedAlias: String(byFuzzy.matched_alias),
        matchType: 'fuzzy',
        confidence: 0.6,
      };
    }

    return null;
  }

  resolveEntityByRelation(
    relation: string,
    owner: 'persona' | 'user',
    filter: EntityGraphFilter,
  ): EntityLookupResult | null {
    const normalized = relation.toLowerCase();
    const row = this.db
      .prepare(
        `SELECT e.*, a.alias AS matched_alias, a.confidence AS alias_confidence
         FROM knowledge_entity_aliases a
         JOIN knowledge_entities e ON e.id = a.entity_id
         WHERE e.user_id = ? AND e.persona_id = ? AND LOWER(a.alias) = ? AND a.owner = ?
         ORDER BY a.confidence DESC LIMIT 1`,
      )
      .get(filter.userId, filter.personaId, normalized, owner) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      entity: this.mapEntityRow(row),
      matchedAlias: String(row.matched_alias),
      matchType: 'relation',
      confidence: Number(row.alias_confidence),
    };
  }

  listEntities(filter: EntityGraphFilter, limit = 100): KnowledgeEntity[] {
    const conditions: string[] = ['user_id = ?', 'persona_id = ?'];
    const params: Array<string | number> = [filter.userId, filter.personaId];

    if (filter.category) {
      conditions.push('category = ?');
      params.push(filter.category);
    }
    if (filter.owner) {
      conditions.push('owner = ?');
      params.push(filter.owner);
    }

    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_entities
         WHERE ${conditions.join(' AND ')}
         ORDER BY canonical_name ASC LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapEntityRow(r));
  }

  getAliasCountsByEntityIds(entityIds: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entityId of entityIds) {
      counts[entityId] = 0;
    }
    if (entityIds.length === 0) {
      return counts;
    }

    const placeholders = entityIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT entity_id, COUNT(*) AS alias_count
         FROM knowledge_entity_aliases
         WHERE entity_id IN (${placeholders})
         GROUP BY entity_id`,
      )
      .all(...entityIds) as Array<{ entity_id: string; alias_count: number }>;

    for (const row of rows) {
      counts[row.entity_id] = Number(row.alias_count || 0);
    }

    return counts;
  }

  listRelationsByEntityIds(entityIds: string[]): EntityRelation[] {
    if (entityIds.length === 0) {
      return [];
    }

    const placeholders = entityIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_entity_relations
         WHERE source_entity_id IN (${placeholders})
           AND target_entity_id IN (${placeholders})
         ORDER BY created_at DESC`,
      )
      .all(...entityIds, ...entityIds) as Record<string, unknown>[];

    return rows.map((row) => this.mapRelationRow(row));
  }

  getEntityWithRelations(entityId: string): {
    entity: KnowledgeEntity;
    relations: EntityRelation[];
    aliases: EntityAlias[];
  } {
    const entityRow = this.db
      .prepare('SELECT * FROM knowledge_entities WHERE id = ?')
      .get(entityId) as Record<string, unknown> | undefined;
    if (!entityRow) {
      throw new Error(`Entity ${entityId} not found`);
    }

    const relationRows = this.db
      .prepare(
        `SELECT * FROM knowledge_entity_relations
         WHERE source_entity_id = ? OR target_entity_id = ?
         ORDER BY created_at DESC`,
      )
      .all(entityId, entityId) as Record<string, unknown>[];

    const aliasRows = this.db
      .prepare('SELECT * FROM knowledge_entity_aliases WHERE entity_id = ? ORDER BY alias ASC')
      .all(entityId) as Record<string, unknown>[];

    return {
      entity: this.mapEntityRow(entityRow),
      relations: relationRows.map((r) => this.mapRelationRow(r)),
      aliases: aliasRows.map((r) => this.mapAliasRow(r)),
    };
  }

  getRelatedEntities(entityId: string, relationType?: string): KnowledgeEntity[] {
    const conditions = ['source_entity_id = ?'];
    const params: string[] = [entityId];
    if (relationType) {
      conditions.push('relation_type = ?');
      params.push(relationType);
    }

    const relationRows = this.db
      .prepare(
        `SELECT target_entity_id FROM knowledge_entity_relations
         WHERE ${conditions.join(' AND ')}`,
      )
      .all(...params) as Array<{ target_entity_id: string }>;

    const targetIds = relationRows.map((r) => r.target_entity_id);
    if (targetIds.length === 0) return [];

    const placeholders = targetIds.map(() => '?').join(',');
    const entityRows = this.db
      .prepare(`SELECT * FROM knowledge_entities WHERE id IN (${placeholders})`)
      .all(...targetIds) as Record<string, unknown>[];

    return entityRows.map((r) => this.mapEntityRow(r));
  }

  findPath(fromEntityId: string, toEntityId: string, maxDepth = 4): EntityRelation[] {
    // BFS graph traversal
    interface QueueItem {
      entityId: string;
      path: EntityRelation[];
    }

    const visited = new Set<string>([fromEntityId]);
    const queue: QueueItem[] = [{ entityId: fromEntityId, path: [] }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.path.length >= maxDepth) continue;

      const edges = this.db
        .prepare('SELECT * FROM knowledge_entity_relations WHERE source_entity_id = ?')
        .all(current.entityId) as Record<string, unknown>[];

      for (const edgeRow of edges) {
        const edge = this.mapRelationRow(edgeRow);
        if (edge.targetEntityId === toEntityId) {
          return [...current.path, edge];
        }
        if (!visited.has(edge.targetEntityId)) {
          visited.add(edge.targetEntityId);
          queue.push({
            entityId: edge.targetEntityId,
            path: [...current.path, edge],
          });
        }
      }
    }

    return [];
  }

  deleteEntity(entityId: string): void {
    // CASCADE handles aliases and relations via FK constraints
    this.db.prepare('DELETE FROM knowledge_entities WHERE id = ?').run(entityId);
  }

  deleteEntitiesByName(name: string, filter: EntityGraphFilter): number {
    const result = this.db
      .prepare(
        `DELETE FROM knowledge_entities
         WHERE user_id = ? AND persona_id = ? AND LOWER(canonical_name) = ?`,
      )
      .run(filter.userId, filter.personaId, name.toLowerCase());
    return result.changes;
  }

  private mapEntityRow(row: Record<string, unknown>): KnowledgeEntity {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      personaId: String(row.persona_id),
      canonicalName: String(row.canonical_name),
      category: String(row.category) as KnowledgeEntity['category'],
      owner: String(row.owner) as 'persona' | 'user' | 'shared',
      properties: parseJsonObject(row.properties_json) as Record<string, string>,
      createdAt: String(row.created_at || ''),
      updatedAt: String(row.updated_at || ''),
    };
  }

  private mapAliasRow(row: Record<string, unknown>): EntityAlias {
    return {
      id: String(row.id),
      entityId: String(row.entity_id),
      alias: String(row.alias),
      aliasType: String(row.alias_type) as EntityAlias['aliasType'],
      owner: String(row.owner) as 'persona' | 'user' | 'shared',
      confidence: Number(row.confidence),
      createdAt: String(row.created_at || ''),
    };
  }

  private mapRelationRow(row: Record<string, unknown>): EntityRelation {
    return {
      id: String(row.id),
      sourceEntityId: String(row.source_entity_id),
      targetEntityId: String(row.target_entity_id),
      relationType: String(row.relation_type),
      properties: parseJsonObject(row.properties_json) as Record<string, string>,
      confidence: Number(row.confidence),
      createdAt: String(row.created_at || ''),
      updatedAt: String(row.updated_at || ''),
    };
  }
}
