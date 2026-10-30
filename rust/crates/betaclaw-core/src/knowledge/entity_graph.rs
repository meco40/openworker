//! Port of `src/server/knowledge/entityGraph.ts` — types and interfaces only.
//!
//! | TypeScript                                   | Rust |
//! | -------------------------------------------- | ---- |
//! | `entityGraph.ts:9-15` (`EntityCategory`)      | [`EntityCategory`] |
//! | `entityGraph.ts:17-27` (`KnowledgeEntity`)    | [`KnowledgeEntity`] |
//! | `entityGraph.ts:29-37` (`EntityAlias`)        | [`EntityAlias`] |
//! | `entityGraph.ts:39-48` (`EntityRelation`)     | [`EntityRelation`] |
//! | `entityGraph.ts:50-55` (`EntityLookupResult`)| [`EntityLookupResult`] |
//! | `entityGraph.ts:57-62` (`EntityGraphFilter`)  | [`EntityGraphFilter`] |
//!
//! The TypeScript file is types-only; the behaviour lives in
//! [`super::repositories::entity_repository`]. Both closed unions that the SQLite
//! schema also enforces become enums (`category`, `owner`, `alias_type`); the
//! `properties` bags stay `serde_json` maps keyed by `String`, because the
//! TypeScript types them as `Record<string, string>` but never validates the
//! values.

/// `EntityCategory` from `entityGraph.ts:9-15`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntityCategory {
    Person,
    Project,
    Place,
    Organization,
    Concept,
    Object,
}

impl EntityCategory {
    /// The column text of `knowledge_entities.category`.
    pub fn as_str(self) -> &'static str {
        match self {
            EntityCategory::Person => "person",
            EntityCategory::Project => "project",
            EntityCategory::Place => "place",
            EntityCategory::Organization => "organization",
            EntityCategory::Concept => "concept",
            EntityCategory::Object => "object",
        }
    }

    /// `String(row.category) as EntityCategory` — an unchecked cast in the
    /// TypeScript. The port keeps the raw text at the read site and turns an
    /// unknown spelling into [`EntityCategory::Concept`] only for typed callers.
    pub fn from_column(value: &str) -> Self {
        match value {
            "person" => EntityCategory::Person,
            "project" => EntityCategory::Project,
            "place" => EntityCategory::Place,
            "organization" => EntityCategory::Organization,
            "object" => EntityCategory::Object,
            _ => EntityCategory::Concept,
        }
    }
}

/// `owner: 'persona' | 'user' | 'shared'` from `entityGraph.ts:23`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntityOwner {
    Persona,
    User,
    Shared,
}

impl EntityOwner {
    pub fn as_str(self) -> &'static str {
        match self {
            EntityOwner::Persona => "persona",
            EntityOwner::User => "user",
            EntityOwner::Shared => "shared",
        }
    }

    pub fn from_column(value: &str) -> Self {
        match value {
            "user" => EntityOwner::User,
            "shared" => EntityOwner::Shared,
            _ => EntityOwner::Persona,
        }
    }
}

/// `aliasType: 'name' | 'relation' | 'pronoun' | 'abbreviation'` from
/// `entityGraph.ts:33`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AliasType {
    Name,
    Relation,
    Pronoun,
    Abbreviation,
}

impl AliasType {
    pub fn as_str(self) -> &'static str {
        match self {
            AliasType::Name => "name",
            AliasType::Relation => "relation",
            AliasType::Pronoun => "pronoun",
            AliasType::Abbreviation => "abbreviation",
        }
    }

    pub fn from_column(value: &str) -> Self {
        match value {
            "relation" => AliasType::Relation,
            "pronoun" => AliasType::Pronoun,
            "abbreviation" => AliasType::Abbreviation,
            _ => AliasType::Name,
        }
    }
}

/// `properties: Record<string, string>` — a bag whose *declared* value type the
/// TypeScript never enforces: `parseJsonObject` returns whatever `JSON.parse`
/// produced and the repositories cast it. The port keeps the raw JSON value of
/// every entry in a [`serde_json::Map`] (insertion-ordered, because the workspace
/// enables `serde_json/preserve_order`) instead of coercing to `String`, so a
/// stored `{ "alter": 28 }` round-trips as `28`, exactly like the source.
pub type Properties = serde_json::Map<String, serde_json::Value>;

/// `KnowledgeEntity` from `entityGraph.ts:17-27`.
#[derive(Debug, Clone, PartialEq)]
pub struct KnowledgeEntity {
    pub id: String,
    pub user_id: String,
    pub persona_id: String,
    pub canonical_name: String,
    pub category: EntityCategory,
    pub owner: EntityOwner,
    pub properties: Properties,
    pub created_at: String,
    pub updated_at: String,
}

/// `EntityAlias` from `entityGraph.ts:29-37`.
#[derive(Debug, Clone, PartialEq)]
pub struct EntityAlias {
    pub id: String,
    pub entity_id: String,
    pub alias: String,
    pub alias_type: AliasType,
    pub owner: EntityOwner,
    pub confidence: f64,
    pub created_at: String,
}

/// `EntityRelation` from `entityGraph.ts:39-48`.
#[derive(Debug, Clone, PartialEq)]
pub struct EntityRelation {
    pub id: String,
    pub source_entity_id: String,
    pub target_entity_id: String,
    pub relation_type: String,
    pub properties: Properties,
    pub confidence: f64,
    pub created_at: String,
    pub updated_at: String,
}

/// `matchType: 'exact_name' | 'alias' | 'relation' | 'fuzzy'` from
/// `entityGraph.ts:53`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchType {
    ExactName,
    Alias,
    Relation,
    Fuzzy,
}

impl MatchType {
    pub fn as_str(self) -> &'static str {
        match self {
            MatchType::ExactName => "exact_name",
            MatchType::Alias => "alias",
            MatchType::Relation => "relation",
            MatchType::Fuzzy => "fuzzy",
        }
    }
}

/// `EntityLookupResult` from `entityGraph.ts:50-55`.
#[derive(Debug, Clone, PartialEq)]
pub struct EntityLookupResult {
    pub entity: KnowledgeEntity,
    pub matched_alias: String,
    pub match_type: MatchType,
    pub confidence: f64,
}

/// `EntityGraphFilter` from `entityGraph.ts:57-62`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct EntityGraphFilter {
    pub user_id: String,
    pub persona_id: String,
    pub category: Option<EntityCategory>,
    pub owner: Option<EntityOwner>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The enum spellings are the `CHECK` values of the SQLite schema, so a typo
    /// here would make every insert fail.
    #[test]
    fn the_closed_unions_match_the_schema_spellings() {
        assert_eq!(EntityCategory::Person.as_str(), "person");
        assert_eq!(EntityCategory::Project.as_str(), "project");
        assert_eq!(EntityCategory::Place.as_str(), "place");
        assert_eq!(EntityCategory::Organization.as_str(), "organization");
        assert_eq!(EntityCategory::Concept.as_str(), "concept");
        assert_eq!(EntityCategory::Object.as_str(), "object");
        assert_eq!(EntityOwner::Persona.as_str(), "persona");
        assert_eq!(EntityOwner::User.as_str(), "user");
        assert_eq!(EntityOwner::Shared.as_str(), "shared");
        assert_eq!(AliasType::Name.as_str(), "name");
        assert_eq!(AliasType::Relation.as_str(), "relation");
        assert_eq!(AliasType::Pronoun.as_str(), "pronoun");
        assert_eq!(AliasType::Abbreviation.as_str(), "abbreviation");
        assert_eq!(MatchType::ExactName.as_str(), "exact_name");
        assert_eq!(MatchType::Fuzzy.as_str(), "fuzzy");
    }

    /// An unchecked column cast falls back to the first branch; the reader keeps
    /// that tolerance instead of rejecting a row.
    #[test]
    fn an_unknown_column_value_falls_back() {
        assert_eq!(EntityCategory::from_column("place"), EntityCategory::Place);
        assert_eq!(
            EntityCategory::from_column("nonsense"),
            EntityCategory::Concept
        );
        assert_eq!(EntityOwner::from_column("shared"), EntityOwner::Shared);
        assert_eq!(EntityOwner::from_column("nonsense"), EntityOwner::Persona);
        assert_eq!(AliasType::from_column("pronoun"), AliasType::Pronoun);
        assert_eq!(AliasType::from_column("nonsense"), AliasType::Name);
    }
}
