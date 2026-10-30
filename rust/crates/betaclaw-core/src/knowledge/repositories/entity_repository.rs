//! Port of `src/server/knowledge/repositories/entityRepository.ts`.
//!
//! | TypeScript member                                   | Rust member |
//! | --------------------------------------------------- | ----------- |
//! | `entityRepository.ts:12` (class)                     | [`EntityRepository`] |
//! | `entityRepository.ts:15-43` (`upsertEntity`)         | [`EntityRepository::upsert_entity`] |
//! | `entityRepository.ts:45-59` (`addAlias`)             | [`EntityRepository::add_alias`] |
//! | `entityRepository.ts:61-86` (`addRelation`)          | [`EntityRepository::add_relation`] |
//! | `entityRepository.ts:88-99` (`updateEntityProperties`)| [`EntityRepository::update_entity_properties`] |
//! | `entityRepository.ts:101-164` (`resolveEntity`)      | [`EntityRepository::resolve_entity`] |
//! | `entityRepository.ts:166-190` (`resolveEntityByRelation`) | [`EntityRepository::resolve_entity_by_relation`] |
//! | `entityRepository.ts:192-214` (`listEntities`)       | [`EntityRepository::list_entities`] |
//! | `entityRepository.ts:216-240` (`getAliasCountsByEntityIds`) | [`EntityRepository::get_alias_counts_by_entity_ids`] |
//! | `entityRepository.ts:242-258` (`listRelationsByEntityIds`) | [`EntityRepository::list_relations_by_entity_ids`] |
//! | `entityRepository.ts:260-289` (`getEntityWithRelations`) | [`EntityRepository::get_entity_with_relations`] |
//! | `entityRepository.ts:291-315` (`getRelatedEntities`) | [`EntityRepository::get_related_entities`] |
//! | `entityRepository.ts:317-351` (`findPath`)           | [`EntityRepository::find_path`] |
//! | `entityRepository.ts:353-356` (`deleteEntity`)       | [`EntityRepository::delete_entity`] |
//! | `entityRepository.ts:358-366` (`deleteEntitiesByName`) | [`EntityRepository::delete_entities_by_name`] |
//! | `entityRepository.ts:368-405` (row mappers)          | [`read_entity`], [`read_alias`], [`read_relation`] |
//!
//! # The possessive prefix
//!
//! `resolveEntity` first lower-cases the text and strips a leading possessive:
//! `/^(mein|meine|dein|deine|sein|seine|ihr|ihre)\s+/i`
//! (`entityRepository.ts:102-104`). The lower-casing happens **before** the
//! replace, so the normalized text is entirely lower-case. The port hand-writes
//! the alternation as an ordered word list with an ECMAScript whitespace test
//! ([`strip_possessive_prefix`]); no `regex` crate is needed, and the patterns
//! are literal alternatives with a single `\s+`, not a backreference or a capture
//! group.
//!
//! # The three-tier lookup
//!
//! 1. exact `LOWER(canonical_name) = ?`, `confidence: 1.0`, `matchedAlias` is the
//!    **original** text;
//! 2. `LOWER(a.alias) = ?` joined to the entity, `confidence` is the alias
//!    confidence;
//! 3. `LOWER(a.alias) LIKE ?` with `${normalized}%`, ordered by `LENGTH(a.alias)`,
//!    `confidence: 0.6`.
//!
//! # Generated ids
//!
//! `addAlias`/`addRelation` mint `ealias-<Date.now()>-<hex>` / `erel-…` — the
//! same shape [`super::random_hex`] and [`super::js_now_millis`] produce.
//!
//! # Deviations
//!
//! 1. **`properties` keeps raw JSON values** (see
//!    [`crate::knowledge::entity_graph::Properties`]); `parseJsonObject` is
//!    passed through unchanged, including the `{...existing, ...properties}`
//!    merge order.
//! 2. **`getEntityWithRelations` errors instead of throwing a `TypeError`.**
//!    A missing entity is `Entity <id> not found`
//!    ([`KnowledgeRepositoryError::EntityNotFound`]) — the same message the
//!    source builds at `entityRepository.ts:269`.

use rusqlite::params_from_iter;
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension};

use super::{js_now_millis, parse_json_object, random_hex, KnowledgeRepositoryError};
use crate::knowledge::entity_graph::{
    AliasType, EntityAlias, EntityCategory, EntityGraphFilter, EntityLookupResult, EntityOwner,
    EntityRelation, KnowledgeEntity, MatchType, Properties,
};
use crate::knowledge::repository::{
    AddEntityAliasInput, AddEntityRelationInput, EntityWithRelations, UpsertKnowledgeEntityInput,
};

/// `EntityRepository` from `entityRepository.ts:12`.
pub struct EntityRepository<'a> {
    db: &'a Connection,
}

/// `\s` of ECMAScript, i.e. `WhiteSpace` + `LineTerminator`.
fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `text.toLowerCase().replace(/^(mein|meine|dein|deine|sein|seine|ihr|ihre)\s+/i, '')`
/// (`entityRepository.ts:102-104`).
pub fn strip_possessive_prefix(lowered: &str) -> &str {
    const WORDS: [&str; 8] = [
        "mein", "meine", "dein", "deine", "sein", "seine", "ihr", "ihre",
    ];
    for word in WORDS {
        if let Some(rest) = lowered.strip_prefix(word) {
            let trimmed = rest.trim_start_matches(is_js_whitespace);
            if trimmed.len() != rest.len() {
                return trimmed;
            }
        }
    }
    lowered
}

impl<'a> EntityRepository<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// `upsertEntity` from `entityRepository.ts:15-43`.
    ///
    /// Returns the *input* with the two stamps attached — the source does not
    /// read the row back, so a conflict-updated `category`/`properties` is
    /// reported as the caller passed it.
    pub fn upsert_entity(
        &self,
        input: &UpsertKnowledgeEntityInput,
    ) -> Result<KnowledgeEntity, KnowledgeRepositoryError> {
        let now = super::now_iso();
        self.db.execute(
            "
            INSERT INTO knowledge_entities (
              id, user_id, persona_id, canonical_name, category, owner, properties_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, persona_id, canonical_name, owner)
            DO UPDATE SET
              category = excluded.category,
              properties_json = excluded.properties_json,
              updated_at = excluded.updated_at
          ",
            params![
                input.id,
                input.user_id,
                input.persona_id,
                input.canonical_name,
                input.category.as_str(),
                input.owner.as_str(),
                serde_json::to_string(&input.properties)?,
                now,
                now
            ],
        )?;

        Ok(KnowledgeEntity {
            id: input.id.clone(),
            user_id: input.user_id.clone(),
            persona_id: input.persona_id.clone(),
            canonical_name: input.canonical_name.clone(),
            category: input.category,
            owner: input.owner,
            properties: input.properties.clone(),
            created_at: now.clone(),
            updated_at: now,
        })
    }

    /// `addAlias` from `entityRepository.ts:45-59`.
    pub fn add_alias(&self, alias: &AddEntityAliasInput) -> Result<(), KnowledgeRepositoryError> {
        let id = format!("ealias-{}-{}", js_now_millis(), random_hex(4));
        let now = super::now_iso();
        self.db.execute(
            "
            INSERT INTO knowledge_entity_aliases (id, entity_id, alias, alias_type, owner, confidence, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(entity_id, alias, owner) DO UPDATE SET
              alias_type = excluded.alias_type,
              confidence = excluded.confidence
          ",
            params![
                id,
                alias.entity_id,
                alias.alias,
                alias.alias_type.as_str(),
                alias.owner.as_str(),
                alias.confidence,
                now
            ],
        )?;
        Ok(())
    }

    /// `addRelation` from `entityRepository.ts:61-86`.
    pub fn add_relation(
        &self,
        relation: &AddEntityRelationInput,
    ) -> Result<(), KnowledgeRepositoryError> {
        let id = format!("erel-{}-{}", js_now_millis(), random_hex(4));
        let now = super::now_iso();
        self.db.execute(
            "
            INSERT INTO knowledge_entity_relations (
              id, source_entity_id, target_entity_id, relation_type, properties_json, confidence, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_entity_id, target_entity_id, relation_type) DO UPDATE SET
              properties_json = excluded.properties_json,
              confidence = excluded.confidence,
              updated_at = excluded.updated_at
          ",
            params![
                id,
                relation.source_entity_id,
                relation.target_entity_id,
                relation.relation_type,
                serde_json::to_string(&relation.properties)?,
                relation.confidence,
                now,
                now
            ],
        )?;
        Ok(())
    }

    /// `updateEntityProperties` from `entityRepository.ts:88-99`.
    pub fn update_entity_properties(
        &self,
        entity_id: &str,
        properties: &Properties,
    ) -> Result<(), KnowledgeRepositoryError> {
        let existing = self
            .db
            .query_row(
                "SELECT properties_json FROM knowledge_entities WHERE id = ?",
                params![entity_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?;
        let Some(existing) = existing else {
            return Ok(());
        };

        let mut merged = parse_json_object(existing.as_deref());
        // `{ ...existing, ...properties }`: a known key keeps its position, a new
        // key is appended.
        for (key, value) in properties {
            merged.insert(key.clone(), value.clone());
        }

        self.db.execute(
            "UPDATE knowledge_entities SET properties_json = ?, updated_at = ? WHERE id = ?",
            params![serde_json::to_string(&merged)?, super::now_iso(), entity_id],
        )?;
        Ok(())
    }

    /// `resolveEntity` from `entityRepository.ts:101-164`.
    pub fn resolve_entity(
        &self,
        text: &str,
        filter: &EntityGraphFilter,
    ) -> Result<Option<EntityLookupResult>, KnowledgeRepositoryError> {
        let lowered = text.to_lowercase();
        let normalized = strip_possessive_prefix(&lowered);

        // 1. Exact name match.
        let by_name = self
            .db
            .query_row(
                "SELECT * FROM knowledge_entities
                 WHERE user_id = ? AND persona_id = ? AND LOWER(canonical_name) = ?
                 LIMIT 1",
                params![filter.user_id, filter.persona_id, normalized],
                |row| read_entity(row, 0),
            )
            .optional()?;
        if let Some(entity) = by_name {
            return Ok(Some(EntityLookupResult {
                entity,
                matched_alias: text.to_string(),
                match_type: MatchType::ExactName,
                confidence: 1.0,
            }));
        }

        // 2. Alias match (including relation words).
        let by_alias = self
            .db
            .query_row(
                "SELECT e.*, a.alias AS matched_alias, a.alias_type, a.confidence AS alias_confidence
                 FROM knowledge_entity_aliases a
                 JOIN knowledge_entities e ON e.id = a.entity_id
                 WHERE e.user_id = ? AND e.persona_id = ? AND LOWER(a.alias) = ?
                 ORDER BY a.confidence DESC LIMIT 1",
                params![filter.user_id, filter.persona_id, normalized],
                |row| {
                    Ok((
                        read_entity(row, 0)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<f64>>(11)?,
                    ))
                },
            )
            .optional()?;
        if let Some((entity, matched_alias, alias_confidence)) = by_alias {
            return Ok(Some(EntityLookupResult {
                entity,
                matched_alias: matched_alias.unwrap_or_default(),
                match_type: MatchType::Alias,
                confidence: alias_confidence.unwrap_or(0.0),
            }));
        }

        // 3. Fuzzy match (prefix LIKE).
        let by_fuzzy = self
            .db
            .query_row(
                "SELECT e.*, a.alias AS matched_alias
                 FROM knowledge_entity_aliases a
                 JOIN knowledge_entities e ON e.id = a.entity_id
                 WHERE e.user_id = ? AND e.persona_id = ? AND LOWER(a.alias) LIKE ?
                 ORDER BY LENGTH(a.alias) ASC LIMIT 1",
                params![filter.user_id, filter.persona_id, format!("{normalized}%")],
                |row| Ok((read_entity(row, 0)?, row.get::<_, Option<String>>(9)?)),
            )
            .optional()?;
        if let Some((entity, matched_alias)) = by_fuzzy {
            return Ok(Some(EntityLookupResult {
                entity,
                matched_alias: matched_alias.unwrap_or_default(),
                match_type: MatchType::Fuzzy,
                confidence: 0.6,
            }));
        }

        Ok(None)
    }

    /// `resolveEntityByRelation` from `entityRepository.ts:166-190`.
    pub fn resolve_entity_by_relation(
        &self,
        relation: &str,
        owner: EntityOwner,
        filter: &EntityGraphFilter,
    ) -> Result<Option<EntityLookupResult>, KnowledgeRepositoryError> {
        let normalized = relation.to_lowercase();
        let row = self
            .db
            .query_row(
                "SELECT e.*, a.alias AS matched_alias, a.confidence AS alias_confidence
                 FROM knowledge_entity_aliases a
                 JOIN knowledge_entities e ON e.id = a.entity_id
                 WHERE e.user_id = ? AND e.persona_id = ? AND LOWER(a.alias) = ? AND a.owner = ?
                 ORDER BY a.confidence DESC LIMIT 1",
                params![
                    filter.user_id,
                    filter.persona_id,
                    normalized,
                    owner.as_str()
                ],
                |row| {
                    Ok((
                        read_entity(row, 0)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<f64>>(10)?,
                    ))
                },
            )
            .optional()?;
        let Some((entity, matched_alias, alias_confidence)) = row else {
            return Ok(None);
        };
        Ok(Some(EntityLookupResult {
            entity,
            matched_alias: matched_alias.unwrap_or_default(),
            match_type: MatchType::Relation,
            confidence: alias_confidence.unwrap_or(0.0),
        }))
    }

    /// `listEntities` from `entityRepository.ts:192-214`.
    pub fn list_entities(
        &self,
        filter: &EntityGraphFilter,
        limit: Option<i64>,
    ) -> Result<Vec<KnowledgeEntity>, KnowledgeRepositoryError> {
        let limit = limit.unwrap_or(100);
        let mut conditions = vec!["user_id = ?".to_string(), "persona_id = ?".to_string()];
        let mut values = vec![
            Value::Text(filter.user_id.clone()),
            Value::Text(filter.persona_id.clone()),
        ];
        if let Some(category) = filter.category {
            conditions.push("category = ?".to_string());
            values.push(Value::Text(category.as_str().to_string()));
        }
        if let Some(owner) = filter.owner {
            conditions.push("owner = ?".to_string());
            values.push(Value::Text(owner.as_str().to_string()));
        }
        values.push(Value::Integer(limit));

        let sql = format!(
            "SELECT * FROM knowledge_entities
             WHERE {}
             ORDER BY canonical_name ASC LIMIT ?",
            conditions.join(" AND ")
        );
        let mut statement = self.db.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), |row| read_entity(row, 0))?;
        let mut entities = Vec::new();
        for row in rows {
            entities.push(row?);
        }
        Ok(entities)
    }

    /// `getAliasCountsByEntityIds` from `entityRepository.ts:216-240`.
    pub fn get_alias_counts_by_entity_ids(
        &self,
        entity_ids: &[String],
    ) -> Result<std::collections::BTreeMap<String, i64>, KnowledgeRepositoryError> {
        let mut counts = std::collections::BTreeMap::new();
        for entity_id in entity_ids {
            counts.insert(entity_id.clone(), 0);
        }
        if entity_ids.is_empty() {
            return Ok(counts);
        }

        let placeholders = vec!["?"; entity_ids.len()].join(",");
        let sql = format!(
            "SELECT entity_id, COUNT(*) AS alias_count
             FROM knowledge_entity_aliases
             WHERE entity_id IN ({placeholders})
             GROUP BY entity_id"
        );
        let mut statement = self.db.prepare(&sql)?;
        let rows = statement.query_map(
            params_from_iter(entity_ids.iter().map(|id| Value::Text(id.clone()))),
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)),
        )?;
        for row in rows {
            let (entity_id, alias_count) = row?;
            counts.insert(entity_id, alias_count.unwrap_or(0));
        }
        Ok(counts)
    }

    /// `listRelationsByEntityIds` from `entityRepository.ts:242-258`.
    pub fn list_relations_by_entity_ids(
        &self,
        entity_ids: &[String],
    ) -> Result<Vec<EntityRelation>, KnowledgeRepositoryError> {
        if entity_ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = vec!["?"; entity_ids.len()].join(",");
        let sql = format!(
            "SELECT * FROM knowledge_entity_relations
             WHERE source_entity_id IN ({placeholders})
               AND target_entity_id IN ({placeholders})
             ORDER BY created_at DESC"
        );
        let mut values: Vec<Value> = entity_ids
            .iter()
            .map(|id| Value::Text(id.clone()))
            .collect();
        values.extend(entity_ids.iter().map(|id| Value::Text(id.clone())));

        let mut statement = self.db.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), |row| read_relation(row, 0))?;
        let mut relations = Vec::new();
        for row in rows {
            relations.push(row?);
        }
        Ok(relations)
    }

    /// `getEntityWithRelations` from `entityRepository.ts:260-289`.
    pub fn get_entity_with_relations(
        &self,
        entity_id: &str,
    ) -> Result<EntityWithRelations, KnowledgeRepositoryError> {
        let entity = self
            .db
            .query_row(
                "SELECT * FROM knowledge_entities WHERE id = ?",
                params![entity_id],
                |row| read_entity(row, 0),
            )
            .optional()?
            .ok_or_else(|| KnowledgeRepositoryError::EntityNotFound {
                entity_id: entity_id.to_string(),
            })?;

        let mut statement = self.db.prepare(
            "SELECT * FROM knowledge_entity_relations
             WHERE source_entity_id = ? OR target_entity_id = ?
             ORDER BY created_at DESC",
        )?;
        let relation_rows =
            statement.query_map(params![entity_id, entity_id], |row| read_relation(row, 0))?;
        let mut relations = Vec::new();
        for row in relation_rows {
            relations.push(row?);
        }

        let mut statement = self.db.prepare(
            "SELECT * FROM knowledge_entity_aliases WHERE entity_id = ? ORDER BY alias ASC",
        )?;
        let alias_rows = statement.query_map(params![entity_id], |row| read_alias(row, 0))?;
        let mut aliases = Vec::new();
        for row in alias_rows {
            aliases.push(row?);
        }

        Ok(EntityWithRelations {
            entity,
            relations,
            aliases,
        })
    }

    /// `getRelatedEntities` from `entityRepository.ts:291-315`.
    pub fn get_related_entities(
        &self,
        entity_id: &str,
        relation_type: Option<&str>,
    ) -> Result<Vec<KnowledgeEntity>, KnowledgeRepositoryError> {
        let mut conditions = vec!["source_entity_id = ?".to_string()];
        let mut values = vec![Value::Text(entity_id.to_string())];
        if let Some(relation_type) = relation_type {
            conditions.push("relation_type = ?".to_string());
            values.push(Value::Text(relation_type.to_string()));
        }

        let sql = format!(
            "SELECT target_entity_id FROM knowledge_entity_relations
             WHERE {}",
            conditions.join(" AND ")
        );
        let target_ids = {
            let mut statement = self.db.prepare(&sql)?;
            let rows =
                statement.query_map(params_from_iter(values), |row| row.get::<_, String>(0))?;
            let mut ids = Vec::new();
            for row in rows {
                ids.push(row?);
            }
            ids
        };
        if target_ids.is_empty() {
            return Ok(Vec::new());
        }

        let placeholders = vec!["?"; target_ids.len()].join(",");
        let sql = format!("SELECT * FROM knowledge_entities WHERE id IN ({placeholders})");
        let mut statement = self.db.prepare(&sql)?;
        let rows = statement.query_map(
            params_from_iter(target_ids.iter().map(|id| Value::Text(id.clone()))),
            |row| read_entity(row, 0),
        )?;
        let mut entities = Vec::new();
        for row in rows {
            entities.push(row?);
        }
        Ok(entities)
    }

    /// `findPath` from `entityRepository.ts:317-351`.
    pub fn find_path(
        &self,
        from_entity_id: &str,
        to_entity_id: &str,
        max_depth: Option<i64>,
    ) -> Result<Vec<EntityRelation>, KnowledgeRepositoryError> {
        let max_depth = max_depth.unwrap_or(4);

        let mut visited: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        visited.insert(from_entity_id.to_string());
        // A BFS queue of (entity id, path so far).
        let mut queue: std::collections::VecDeque<(String, Vec<EntityRelation>)> =
            std::collections::VecDeque::new();
        queue.push_back((from_entity_id.to_string(), Vec::new()));

        while let Some((current_id, path)) = queue.pop_front() {
            if path.len() as i64 >= max_depth {
                continue;
            }
            let mut statement = self
                .db
                .prepare("SELECT * FROM knowledge_entity_relations WHERE source_entity_id = ?")?;
            let rows = statement.query_map(params![current_id], |row| read_relation(row, 0))?;
            let mut edges = Vec::new();
            for row in rows {
                edges.push(row?);
            }

            for edge in edges {
                if edge.target_entity_id == to_entity_id {
                    let mut found = path.clone();
                    found.push(edge);
                    return Ok(found);
                }
                if visited.insert(edge.target_entity_id.clone()) {
                    let mut next = path.clone();
                    next.push(edge.clone());
                    queue.push_back((edge.target_entity_id.clone(), next));
                }
            }
        }

        Ok(Vec::new())
    }

    /// `deleteEntity` from `entityRepository.ts:353-356`.
    ///
    /// `CASCADE` handles aliases and relations via the FK constraints.
    pub fn delete_entity(&self, entity_id: &str) -> Result<(), KnowledgeRepositoryError> {
        self.db.execute(
            "DELETE FROM knowledge_entities WHERE id = ?",
            params![entity_id],
        )?;
        Ok(())
    }

    /// `deleteEntitiesByName` from `entityRepository.ts:358-366`.
    pub fn delete_entities_by_name(
        &self,
        name: &str,
        filter: &EntityGraphFilter,
    ) -> Result<i64, KnowledgeRepositoryError> {
        let changes = self.db.execute(
            "DELETE FROM knowledge_entities
             WHERE user_id = ? AND persona_id = ? AND LOWER(canonical_name) = ?",
            params![filter.user_id, filter.persona_id, name.to_lowercase()],
        )?;
        Ok(changes as i64)
    }
}

/// `mapEntityRow` from `entityRepository.ts:368-380`.
///
/// `base` is the offset of the entity's nine columns, so the joined
/// `SELECT e.*, a.alias …` projections can share the reader.
fn read_entity(row: &rusqlite::Row<'_>, base: usize) -> rusqlite::Result<KnowledgeEntity> {
    Ok(KnowledgeEntity {
        id: row.get(base)?,
        user_id: row.get(base + 1)?,
        persona_id: row.get(base + 2)?,
        canonical_name: row.get(base + 3)?,
        category: EntityCategory::from_column(&row.get::<_, String>(base + 4)?),
        owner: EntityOwner::from_column(&row.get::<_, String>(base + 5)?),
        properties: parse_json_object(row.get::<_, Option<String>>(base + 6)?.as_deref()),
        created_at: row.get::<_, Option<String>>(base + 7)?.unwrap_or_default(),
        updated_at: row.get::<_, Option<String>>(base + 8)?.unwrap_or_default(),
    })
}

/// `mapAliasRow` from `entityRepository.ts:382-392`.
fn read_alias(row: &rusqlite::Row<'_>, base: usize) -> rusqlite::Result<EntityAlias> {
    Ok(EntityAlias {
        id: row.get(base)?,
        entity_id: row.get(base + 1)?,
        alias: row.get(base + 2)?,
        alias_type: AliasType::from_column(&row.get::<_, String>(base + 3)?),
        owner: EntityOwner::from_column(&row.get::<_, String>(base + 4)?),
        confidence: row.get::<_, Option<f64>>(base + 5)?.unwrap_or(0.0),
        created_at: row.get::<_, Option<String>>(base + 6)?.unwrap_or_default(),
    })
}

/// `mapRelationRow` from `entityRepository.ts:394-405`.
fn read_relation(row: &rusqlite::Row<'_>, base: usize) -> rusqlite::Result<EntityRelation> {
    Ok(EntityRelation {
        id: row.get(base)?,
        source_entity_id: row.get(base + 1)?,
        target_entity_id: row.get(base + 2)?,
        relation_type: row.get(base + 3)?,
        properties: parse_json_object(row.get::<_, Option<String>>(base + 4)?.as_deref()),
        confidence: row.get::<_, Option<f64>>(base + 5)?.unwrap_or(0.0),
        created_at: row.get::<_, Option<String>>(base + 6)?.unwrap_or_default(),
        updated_at: row.get::<_, Option<String>>(base + 7)?.unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open, OpenOptions};
    use crate::knowledge::repositories::migrations::run_knowledge_migrations;

    fn connection() -> Connection {
        let connection = open(OpenOptions::new(":memory:")).expect("open");
        run_knowledge_migrations(&connection).expect("migrate");
        connection
    }

    fn filter() -> EntityGraphFilter {
        EntityGraphFilter {
            user_id: "u-1".to_string(),
            persona_id: "p-1".to_string(),
            ..Default::default()
        }
    }

    fn entity(id: &str, name: &str) -> UpsertKnowledgeEntityInput {
        UpsertKnowledgeEntityInput {
            id: id.to_string(),
            user_id: "u-1".to_string(),
            persona_id: "p-1".to_string(),
            canonical_name: name.to_string(),
            category: EntityCategory::Person,
            owner: EntityOwner::Persona,
            properties: Properties::new(),
        }
    }

    #[test]
    fn the_possessive_prefix_is_stripped_like_the_regex() {
        assert_eq!(strip_possessive_prefix("mein bruder"), "bruder");
        assert_eq!(strip_possessive_prefix("meine mutter"), "mutter");
        assert_eq!(strip_possessive_prefix("deine   schwester"), "schwester");
        assert_eq!(strip_possessive_prefix("ihre firma"), "firma");
        // `ihr` must not swallow `ihre`, and a non-word prefix is kept.
        assert_eq!(strip_possessive_prefix("ihr hund"), "hund");
        assert_eq!(strip_possessive_prefix("meineke"), "meineke");
        assert_eq!(strip_possessive_prefix("max"), "max");
        // A `\s` without a trailing word still strips the whole run.
        assert_eq!(strip_possessive_prefix("sein\u{00a0}auto"), "auto");
    }

    #[test]
    fn resolve_entity_walks_the_three_tiers() {
        let connection = connection();
        let repo = EntityRepository::new(&connection);
        repo.upsert_entity(&entity("ent-max", "Max"))
            .expect("entity");
        repo.add_alias(&AddEntityAliasInput {
            entity_id: "ent-max".to_string(),
            alias: "bruder".to_string(),
            alias_type: AliasType::Relation,
            owner: EntityOwner::Persona,
            confidence: 0.9,
        })
        .expect("alias");

        let exact = repo
            .resolve_entity("Max", &filter())
            .expect("resolve")
            .expect("some");
        assert_eq!(exact.match_type, MatchType::ExactName);
        assert_eq!(exact.matched_alias, "Max", "the original text is kept");
        assert_eq!(exact.confidence, 1.0);

        // The possessive is removed before the alias comparison.
        let alias = repo
            .resolve_entity("Mein Bruder", &filter())
            .expect("resolve")
            .expect("some");
        assert_eq!(alias.match_type, MatchType::Alias);
        assert_eq!(alias.matched_alias, "bruder");
        assert_eq!(alias.confidence, 0.9);

        let fuzzy = repo
            .resolve_entity("brud", &filter())
            .expect("resolve")
            .expect("some");
        assert_eq!(fuzzy.match_type, MatchType::Fuzzy);
        assert_eq!(fuzzy.confidence, 0.6);

        assert!(repo
            .resolve_entity("unbekannt", &filter())
            .expect("resolve")
            .is_none());
    }

    #[test]
    fn relations_paths_and_cascade_delete() {
        let connection = connection();
        let repo = EntityRepository::new(&connection);
        repo.upsert_entity(&entity("ent-a", "Max")).expect("a");
        repo.upsert_entity(&entity("ent-b", "Nata")).expect("b");
        repo.upsert_entity(&entity("ent-c", "Ada")).expect("c");
        repo.add_relation(&AddEntityRelationInput {
            source_entity_id: "ent-a".to_string(),
            target_entity_id: "ent-b".to_string(),
            relation_type: "bruder".to_string(),
            properties: Properties::new(),
            confidence: 0.8,
        })
        .expect("r1");
        repo.add_relation(&AddEntityRelationInput {
            source_entity_id: "ent-b".to_string(),
            target_entity_id: "ent-c".to_string(),
            relation_type: "freundin".to_string(),
            properties: Properties::new(),
            confidence: 0.7,
        })
        .expect("r2");
        repo.add_alias(&AddEntityAliasInput {
            entity_id: "ent-a".to_string(),
            alias: "bruder".to_string(),
            alias_type: AliasType::Relation,
            owner: EntityOwner::Persona,
            confidence: 0.9,
        })
        .expect("alias");

        assert_eq!(
            repo.get_related_entities("ent-a", None)
                .expect("related")
                .len(),
            1
        );
        assert_eq!(
            repo.get_related_entities("ent-a", Some("freundin"))
                .expect("related")
                .len(),
            0
        );

        let path = repo.find_path("ent-a", "ent-c", None).expect("path");
        assert_eq!(path.len(), 2, "a -> b -> c");
        assert_eq!(path[0].relation_type, "bruder");
        assert_eq!(path[1].relation_type, "freundin");
        assert!(repo
            .find_path("ent-c", "ent-a", None)
            .expect("path")
            .is_empty());

        let with = repo.get_entity_with_relations("ent-a").expect("with");
        assert_eq!(with.entity.canonical_name, "Max");
        assert_eq!(with.relations.len(), 1);
        assert_eq!(with.aliases.len(), 1);

        let counts = repo
            .get_alias_counts_by_entity_ids(&["ent-a".to_string(), "ent-b".to_string()])
            .expect("counts");
        assert_eq!(counts.get("ent-a"), Some(&1));
        assert_eq!(counts.get("ent-b"), Some(&0));

        assert_eq!(
            repo.delete_entities_by_name("NATA", &filter())
                .expect("delete"),
            1
        );

        let error = repo
            .get_entity_with_relations("missing")
            .expect_err("missing entity");
        assert_eq!(error.to_string(), "Entity missing not found");
    }
}
