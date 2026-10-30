//! The world model hooks of the inbound pipeline: the `WorldModelPort`.
//!
//! Port of the flag and response checks of `handleInbound.ts`, wired to the canonical
//! PostgreSQL World Model and Graphiti recall.

use std::sync::{Arc, Mutex, PoisonError};

use betaclaw_core::channels::messages::service::execution::ports::PortResult;
use betaclaw_core::channels::messages::service::ports::{
    BoxFuture, CorrelateInput, RecordObservationInput, WorldModelFlags, WorldModelPort,
};
use betaclaw_core::channels::messages::service::recall::ports::{
    RecallSourceError, RecallWorldModel,
};
use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::world_model::config::WorldModelConfig;
use betaclaw_core::world_model::db::{
    BoxFuture as PgBoxFuture, NoQueryEmbedder, NormalizedScope, PgError, PgExecutor,
    UnconfiguredPgExecutor,
};
use betaclaw_core::world_model::driver::{PgPoolSettings, SqlxPgExecutor};
use betaclaw_core::world_model::graphiti::client::{GraphitiClientConfig, GraphitiRestClient};
use betaclaw_core::world_model::repositories::event_repository::list_event_timeline;
use betaclaw_core::world_model::repositories::observation_repository::insert_observation_with_result;
use betaclaw_core::world_model::retrieval::index::{
    retrieve_context, RetrievalContextResult, RetrievalDeps, RetrieveContextInput,
};
use betaclaw_core::world_model::retrieval::structured::{EventTimelineLoader, EventTimelinePoint};
use betaclaw_core::world_model::scope::WorldModelScope;
use betaclaw_core::world_model::services::inbound_response_correlation::{
    correlate_inbound_response as correlate_inbound,
    looks_like_response as text_looks_like_response, InboundConversation, InboundCorrelationInput,
    InboundUserMessageInput,
};
use betaclaw_core::world_model::types::{ObservationInput, ObservationSourceType};

use super::failed;

/// The World-Model PostgreSQL pool, connected on first use and shared by the memory and
/// the world-model retrieval. `db.ts:87-98` builds the pool once; a failed connect is not
/// kept, so a later call tries again.
pub struct PgHandle {
    settings: PgPoolSettings,
    executor: Mutex<Option<Arc<SqlxPgExecutor>>>,
}

impl PgHandle {
    pub fn new(config: &WorldModelConfig) -> Self {
        Self {
            settings: PgPoolSettings::from_config(config),
            executor: Mutex::new(None),
        }
    }

    /// The executor of the pool. An empty or invalid `database_url` fails here with the
    /// driver's own message, which the callers pass on as the named error.
    pub fn executor(&self) -> Result<Arc<dyn PgExecutor>, PgError> {
        let mut slot = self.executor.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(executor) = slot.as_ref() {
            return Ok(executor.clone() as Arc<dyn PgExecutor>);
        }
        let connected = Arc::new(connect_blocking(&self.settings)?);
        *slot = Some(connected.clone());
        Ok(connected as Arc<dyn PgExecutor>)
    }
}

/// `SqlxPgExecutor::connect` from synchronous code. The pool needs the async runtime, so the
/// call moves the worker out of the way with `block_in_place`. It refuses a current-thread
/// runtime, which cannot block.
fn connect_blocking(settings: &PgPoolSettings) -> Result<SqlxPgExecutor, PgError> {
    let handle = tokio::runtime::Handle::try_current()
        .map_err(|_| PgError::new("PostgreSQL pool: no async runtime in this thread"))?;
    if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::CurrentThread {
        return Err(PgError::new(
            "PostgreSQL pool: the gateway needs a multi-thread runtime to connect",
        ));
    }
    tokio::task::block_in_place(|| handle.block_on(SqlxPgExecutor::connect(settings)))
}

struct PgEventTimeline;

impl EventTimelineLoader for PgEventTimeline {
    fn timeline<'a>(
        &'a self,
        executor: &'a dyn PgExecutor,
        scope: &'a NormalizedScope,
        event_id: &'a str,
    ) -> PgBoxFuture<'a, Result<Vec<EventTimelinePoint>, PgError>> {
        Box::pin(async move {
            let wm_scope = WorldModelScope::new(
                scope.user_id.clone(),
                scope.persona_id.clone(),
                Some(scope.workspace_id.clone()),
            );
            let rows = list_event_timeline::<PgError>(executor, Some(&wm_scope), event_id).await?;
            Ok(rows
                .into_iter()
                .map(|point| EventTimelinePoint {
                    id: point.transition.id,
                    event_id: point.transition.input.event_id,
                    from_status: point.transition.input.from_status,
                    to_status: point.transition.input.to_status,
                    reason: point.transition.input.reason,
                    source_observation_id: point.transition.input.source_observation_id,
                    confidence: point.transition.input.confidence,
                    transitioned_at: point.transition.transitioned_at,
                    title: point.title,
                })
                .collect())
        })
    }
}

/// `retrieveContext(input)` of the recall source (`recall/index.ts`, the world-model
/// lane).
pub struct WorldRetrieval {
    config: WorldModelConfig,
    pg: Arc<PgHandle>,
    graphiti: GraphitiRestClient,
}

impl WorldRetrieval {
    pub fn new(
        config: WorldModelConfig,
        pg: Arc<PgHandle>,
        transport: Arc<dyn HttpTransport>,
    ) -> Self {
        Self {
            config,
            pg,
            graphiti: GraphitiRestClient::new(GraphitiClientConfig::from_env(), transport),
        }
    }
}

impl RecallWorldModel for WorldRetrieval {
    async fn retrieve_context(
        &self,
        input: &RetrieveContextInput,
    ) -> Result<RetrievalContextResult, RecallSourceError> {
        // `index.ts:97-100`: a disabled world model returns before any query, so no
        // pool is needed for it.
        let disabled = !self.config.enabled && !self.config.e2e_enabled;
        let executor: Arc<dyn PgExecutor> = if disabled {
            Arc::new(UnconfiguredPgExecutor)
        } else {
            self.pg.executor().map_err(|error| {
                RecallSourceError(format!(
                    "chat_runtime: RecallWorldModel::retrieve_context: {error}"
                ))
            })?
        };
        let deps = RetrievalDeps {
            executor: executor.as_ref(),
            embedder: &NoQueryEmbedder,
            timeline: &PgEventTimeline,
            graphiti: &self.graphiti,
        };
        Ok(retrieve_context(&self.config, &deps, input).await)
    }
}

pub struct WorldModel {
    config: WorldModelConfig,
    flags: WorldModelFlags,
    pg: Arc<PgHandle>,
}

impl WorldModel {
    /// `getWorldModelConfig()` together with `isWorldModelRequired(mode)`.
    pub fn new(config: WorldModelConfig, pg: Arc<PgHandle>) -> Self {
        let flags = WorldModelFlags {
            enabled: config.enabled,
            e2e_enabled: config.e2e_enabled,
            required: config.mode.is_required(),
        };
        Self { config, flags, pg }
    }

    #[cfg(test)]
    pub fn from_config(config: &WorldModelConfig) -> Self {
        Self::new(config.clone(), Arc::new(PgHandle::new(config)))
    }
}

impl WorldModelPort for WorldModel {
    fn flags(&self) -> WorldModelFlags {
        self.flags
    }

    fn looks_like_response(&self, content: &str) -> bool {
        text_looks_like_response(content)
    }

    fn record_observation(
        &self,
        input: RecordObservationInput,
    ) -> BoxFuture<'_, PortResult<String>> {
        Box::pin(async move {
            let executor = self.pg.executor().map_err(failed)?;
            let scope = WorldModelScope::new(
                input.user_id.clone(),
                input.persona_id.clone(),
                Some(input.workspace_id.clone()),
            );
            let source_type = match input.source_type {
                "chat_message" => ObservationSourceType::ChatMessage,
                "email" => ObservationSourceType::Email,
                "calendar_event" => ObservationSourceType::CalendarEvent,
                "location_signal" => ObservationSourceType::LocationSignal,
                "tool_execution" => ObservationSourceType::ToolExecution,
                "outbound_message" => ObservationSourceType::OutboundMessage,
                "user_confirmation" => ObservationSourceType::UserConfirmation,
                "automation" => ObservationSourceType::Automation,
                _ => ObservationSourceType::Manual,
            };
            let payload = input.payload.as_object().cloned().unwrap_or_default();
            let obs_input = ObservationInput {
                user_id: input.user_id,
                persona_id: input.persona_id,
                workspace_id: Some(input.workspace_id),
                source_type,
                source_id: input.source_id,
                occurred_at: input.occurred_at,
                payload,
                source_authority: Some(input.source_authority.to_string()),
            };
            let inserted = insert_observation_with_result::<PgError>(
                executor.as_ref(),
                Some(&scope),
                &obs_input,
            )
            .await
            .map_err(failed)?;
            Ok(inserted.observation.id)
        })
    }

    fn correlate_inbound_response(&self, input: CorrelateInput) -> BoxFuture<'_, PortResult<()>> {
        Box::pin(async move {
            let executor = self.pg.executor().map_err(failed)?;
            let persona_id = input.conversation.persona_id.clone().unwrap_or_default();
            let scope = WorldModelScope::new(
                input.conversation.user_id.clone(),
                persona_id,
                Some(String::new()),
            );
            let corr_input = InboundCorrelationInput {
                conversation: InboundConversation {
                    id: input.conversation.id,
                    user_id: input.conversation.user_id,
                    persona_id: input.conversation.persona_id,
                    workspace_id: None,
                    channel_type: input.conversation.channel_type.as_str().to_string(),
                    external_chat_id: input.conversation.external_chat_id,
                },
                user_message: InboundUserMessageInput {
                    text: input.text,
                    received_at: input.received_at,
                    observation_id: input.observation_id,
                    source_id: Some(input.source_id),
                },
            };
            let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            correlate_inbound(
                executor.as_ref(),
                Some(&scope),
                &self.config,
                &corr_input,
                &now,
            )
            .await
            .map(|_| ())
            .map_err(failed)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use betaclaw_core::world_model::config::resolve_world_model_config;
    use std::collections::HashMap;

    #[test]
    fn flags_follow_the_configuration() {
        let config = resolve_world_model_config(&HashMap::new());
        let flags = WorldModel::from_config(&config).flags();
        assert_eq!(flags.enabled, config.enabled);
        assert_eq!(flags.e2e_enabled, config.e2e_enabled);
        assert_eq!(flags.required, config.mode.is_required());
    }
}
