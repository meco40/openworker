//! Port of `src/server/channels/telegram/nativeCommandHandler.ts` (the `/model` and
//! `/chatdelete` commands), `src/server/channels/telegram/modelSelection.ts` (the
//! model override and its browser) and `src/server/channels/telegram/modelButtons.ts`
//! (the keyboards and the callback data).
//!
//! `/new`, `/reset`, `/persona` and `/cron` are not handled here. Their text goes to
//! the dispatch, which runs its own slash commands, as in TypeScript.
//!
//! ponytail: `localeCompare` is approximated by a case-folded comparison. It matches
//! ICU for the letters and digits of model ids, not for punctuation.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Display;
use std::sync::Arc;

use betaclaw_core::channels::adapters::telegram::outbound::{
    build_inline_keyboard, InlineKeyboardButton, TelegramSender, TelegramTextOptions,
};
use betaclaw_core::channels::adapters::telegram::types::{TelegramCallbackQuery, TelegramChat};
use betaclaw_core::channels::adapters::types::ChannelError;
use betaclaw_core::channels::pairing::credentials::ChannelEnv;
use betaclaw_core::messages_store::types::{ChannelType, Conversation};
use betaclaw_core::model_hub::service::pipeline::list_pipeline;
use betaclaw_core::model_hub::sqlite::SqliteModelHubRepository;
use betaclaw_core::model_hub::types::{PipelineModelEntry, PipelineStatus};
use tracing::warn;

use super::attachments::AttachmentStore;
use super::chat::delete_message_with_side_effects;
use super::store::ChannelDb;
use crate::state::SharedState;

const CLEAR_MODEL_ARGS: [&str; 4] = ["off", "clear", "auto", "default"];
const MODELS_PAGE_SIZE: usize = 8;
const MAX_CALLBACK_DATA_BYTES: usize = 64;
const MODEL_LABEL_MAX_CHARS: usize = 40;

/// The Telegram commands that need the gateway state. The bridge and the services
/// hold clones of the same value.
#[derive(Clone)]
pub(crate) struct TelegramCommands {
    pub(crate) state: SharedState,
    pub(crate) db: Arc<ChannelDb>,
    pub(crate) attachments: Arc<AttachmentStore>,
    pub(crate) env: Arc<ChannelEnv>,
    pub(crate) sender: TelegramSender,
}

impl TelegramCommands {
    /// `handleTelegramNativeCommand`. `true` when the text was a native command and
    /// it was run here.
    pub(crate) async fn handle_native_command(
        &self,
        text: &str,
        external_chat_id: &str,
    ) -> Result<bool, ChannelError> {
        match parse_native_command(text) {
            NativeCommand::None => Ok(false),
            NativeCommand::Model(args) => {
                self.model_command(&args, external_chat_id).await?;
                Ok(true)
            }
            NativeCommand::ChatDelete => {
                self.chat_delete(external_chat_id).await?;
                Ok(true)
            }
        }
    }

    /// `processTelegramModelCallback`. `true` when the callback data was a model
    /// button, whatever the outcome.
    pub(crate) async fn handle_model_callback(
        &self,
        query: &TelegramCallbackQuery,
    ) -> Result<bool, ChannelError> {
        let Some(data) = query
            .data
            .as_deref()
            .map(str::trim)
            .filter(|data| !data.is_empty())
        else {
            return Ok(false);
        };
        let Some(callback) = parse_model_callback(data) else {
            return Ok(false);
        };

        let message = query.message.as_ref();
        let Some(chat) = message.and_then(|message| message.chat.as_ref()) else {
            self.sender
                .answer_callback_query(&query.id, Some("Missing chat context."), false)
                .await?;
            return Ok(true);
        };
        let target = callback_external_chat_id(chat, message.and_then(|m| m.message_thread_id));
        let message_id = message.and_then(|message| message.message_id);
        let providers = self.active_providers()?;
        let conversation = self.conversation(&target)?;
        let current = conversation.model_override.as_deref();

        match callback {
            ModelCallback::Providers | ModelCallback::Back => {
                self.sender
                    .answer_callback_query(&query.id, None, false)
                    .await?;
                let rows = if providers.is_empty() {
                    browse_rows()
                } else {
                    provider_rows(&providers)
                };
                self.send_or_edit(
                    &target,
                    &overview_text(current, &providers),
                    message_id,
                    rows,
                )
                .await?;
            }
            ModelCallback::List { provider, page } => {
                let Some(entry) = providers.iter().find(|entry| entry.id == provider) else {
                    self.sender
                        .answer_callback_query(&query.id, Some("Provider not found."), false)
                        .await?;
                    return Ok(true);
                };
                let total = total_pages(entry.models.len());
                let rows = models_rows(
                    &entry.id,
                    &entry.models,
                    current,
                    page.clamp(1, total),
                    total,
                );
                self.sender
                    .answer_callback_query(&query.id, None, false)
                    .await?;
                let text = format!(
                    "Provider {} ({} models)\nSelect a model:",
                    entry.id,
                    entry.models.len()
                );
                self.send_or_edit(&target, &text, message_id, rows).await?;
            }
            ModelCallback::Select { provider, model } => {
                let selected = providers
                    .iter()
                    .find(|entry| entry.id == provider)
                    .and_then(|entry| {
                        entry
                            .models
                            .iter()
                            .find(|name| **name == model)
                            .map(|name| (entry.id.clone(), name.clone()))
                    });
                let Some((provider_id, model)) = selected else {
                    self.sender
                        .answer_callback_query(&query.id, Some("Model not available."), false)
                        .await?;
                    return Ok(true);
                };
                self.set_override(&conversation, Some(&model))?;
                let answer = format!("Model set: {model}");
                self.sender
                    .answer_callback_query(&query.id, Some(&answer), false)
                    .await?;
                let text = format!("Model override set to {model} ({provider_id}).");
                self.send_or_edit(&target, &text, message_id, browse_rows())
                    .await?;
            }
        }
        Ok(true)
    }

    /// `handleTelegramModelCommand`.
    async fn model_command(&self, args: &str, external_chat_id: &str) -> Result<(), ChannelError> {
        let conversation = self.conversation(external_chat_id)?;
        let providers = self.active_providers()?;
        let arg = args.trim();

        if CLEAR_MODEL_ARGS.contains(&arg.to_lowercase().as_str()) {
            self.set_override(&conversation, None)?;
            return self
                .reply(
                    external_chat_id,
                    "Model override cleared. The pipeline fallback will be used.",
                )
                .await;
        }
        if !arg.is_empty() {
            return match find_model_by_reference(&providers, arg) {
                Some((provider, model)) => {
                    self.set_override(&conversation, Some(&model))?;
                    let text = format!("Model override set to {model} ({provider}).");
                    self.reply(external_chat_id, &text).await
                }
                None => {
                    self.reply(
                        external_chat_id,
                        "Model not found in active pipeline. Send /model for provider browsing.",
                    )
                    .await
                }
            };
        }

        let overview = overview_text(conversation.model_override.as_deref(), &providers);
        let options = TelegramTextOptions {
            reply_markup: build_inline_keyboard(provider_rows(&providers)),
            ..TelegramTextOptions::default()
        };
        self.sender
            .deliver(external_chat_id, &overview, &options)
            .await
            .map(|_| ())
    }

    /// `handleTelegramDeleteCommand`: removes the newest message of the chat.
    async fn chat_delete(&self, external_chat_id: &str) -> Result<(), ChannelError> {
        let conversation = self
            .db
            .with(|store| {
                store.get_conversation_by_external_chat(
                    ChannelType::Telegram.as_str(),
                    external_chat_id,
                    None,
                )
            })
            .map_err(channel_error)?;
        let Some(conversation) = conversation else {
            return self.reply(external_chat_id, "Nothing to delete.").await;
        };
        let messages = self
            .state
            .messages
            .lock()
            .await
            .list_messages(&conversation.id, 1, None, Some(&conversation.user_id))
            .map_err(channel_error)?;
        let Some(latest) = messages.last() else {
            return self.reply(external_chat_id, "Nothing to delete.").await;
        };

        let deleted = delete_message_with_side_effects(
            &self.state,
            &self.attachments,
            &conversation.user_id,
            &latest.id,
            Some(&conversation.id),
        )
        .await
        .map_err(channel_error)?;
        let text = if deleted {
            "Last message deleted."
        } else {
            "Nothing to delete."
        };
        self.reply(external_chat_id, text).await
    }

    /// The conversation of a Telegram chat, created when it is missing.
    fn conversation(&self, external_chat_id: &str) -> Result<Conversation, ChannelError> {
        self.db
            .get_or_create_conversation(ChannelType::Telegram.as_str(), external_chat_id)
            .map_err(channel_error)
    }

    fn set_override(
        &self,
        conversation: &Conversation,
        model: Option<&str>,
    ) -> Result<(), ChannelError> {
        self.db
            .with(|store| {
                store.update_model_override(&conversation.id, model, &conversation.user_id)
            })
            .map_err(channel_error)
    }

    /// `listActiveProviders` for the profile of `MODEL_HUB_PROFILE_ID` (default `p1`).
    fn active_providers(&self) -> Result<Vec<ModelProvider>, ChannelError> {
        let profile = self
            .env
            .get("MODEL_HUB_PROFILE_ID")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "p1".to_string());
        let path = self
            .env
            .get("MODEL_HUB_DB_PATH")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "model-hub.db".to_string());
        let repository = SqliteModelHubRepository::open(&path).map_err(channel_error)?;
        let entries = list_pipeline(&repository, &profile).map_err(channel_error)?;
        Ok(group_active_providers(&entries))
    }

    async fn reply(&self, target: &str, text: &str) -> Result<(), ChannelError> {
        self.sender
            .deliver(target, text, &TelegramTextOptions::default())
            .await
            .map(|_| ())
    }

    /// `sendOrEditTelegramModelMessage`: edits the message the button sits on, and
    /// sends a new one when the edit fails or there is no message to edit.
    async fn send_or_edit(
        &self,
        target: &str,
        text: &str,
        message_id: Option<i64>,
        rows: Vec<Vec<InlineKeyboardButton>>,
    ) -> Result<(), ChannelError> {
        let options = TelegramTextOptions {
            reply_markup: build_inline_keyboard(rows),
            ..TelegramTextOptions::default()
        };
        if let Some(message_id) = message_id {
            match self
                .sender
                .edit_message(target, message_id, text, &options)
                .await
            {
                Ok(()) => return Ok(()),
                Err(error) => {
                    warn!("[Telegram] editMessageText failed, falling back to sendMessage: {error}")
                }
            }
        }
        self.sender
            .deliver(target, text, &options)
            .await
            .map(|_| ())
    }
}

fn channel_error(error: impl Display) -> ChannelError {
    ChannelError::new(error.to_string())
}

/// `ParsedTelegramNativeCommand`.
#[derive(Debug, PartialEq, Eq)]
enum NativeCommand {
    None,
    Model(String),
    ChatDelete,
}

/// `parseTelegramNativeCommand`. The token is case-insensitive and may carry the
/// bot name (`/model@bot`).
fn parse_native_command(text: &str) -> NativeCommand {
    let trimmed = text.trim();
    if !trimmed.starts_with('/') {
        return NativeCommand::None;
    }
    let first_space = trimmed.find(' ');
    let token = first_space
        .map_or(trimmed, |index| &trimmed[..index])
        .to_lowercase();
    let bare = token.split('@').next().unwrap_or_default();
    let args =
        first_space.map_or_else(String::new, |index| trimmed[index + 1..].trim().to_string());
    match bare {
        "/model" => NativeCommand::Model(args),
        "/chatdelete" => NativeCommand::ChatDelete,
        _ => NativeCommand::None,
    }
}

/// `TelegramModelProvider`: a provider of the active pipeline and its model names.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ModelProvider {
    id: String,
    models: Vec<String>,
}

/// `normalizeProviderKey`: trimmed, lower case, and only `[a-z0-9_-]` kept.
fn normalize_provider_key(provider_id: &str) -> String {
    provider_id
        .trim()
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || *ch == '_' || *ch == '-')
        .collect()
}

/// `listActiveProviders`: the active entries grouped by provider. Models are unique
/// and sorted, providers are sorted by id.
fn group_active_providers(entries: &[PipelineModelEntry]) -> Vec<ModelProvider> {
    let mut by_provider: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for entry in entries
        .iter()
        .filter(|entry| matches!(entry.status, PipelineStatus::Active))
    {
        let key = normalize_provider_key(&entry.provider_id);
        if !key.is_empty() {
            by_provider
                .entry(key)
                .or_default()
                .insert(entry.model_name.clone());
        }
    }
    by_provider
        .into_iter()
        .map(|(id, models)| {
            let mut models: Vec<String> = models.into_iter().collect();
            models.sort_by_key(|model| (model.to_lowercase(), model.clone()));
            ModelProvider { id, models }
        })
        .collect()
}

/// `findModelByReference`: `provider/model` as an exact pair, else a model name
/// that exists under exactly one provider (case-insensitive).
fn find_model_by_reference(providers: &[ModelProvider], raw: &str) -> Option<(String, String)> {
    let reference = raw.trim();
    if reference.is_empty() {
        return None;
    }
    if let Some(slash) = reference.find('/') {
        let provider = normalize_provider_key(&reference[..slash]);
        let candidate = reference[slash + 1..].trim();
        if let Some(entry) = providers.iter().find(|entry| entry.id == provider) {
            if let Some(model) = entry
                .models
                .iter()
                .find(|model| model.as_str() == candidate)
            {
                return Some((provider, model.clone()));
            }
        }
    }
    let wanted = reference.to_lowercase();
    let mut matches = providers.iter().flat_map(|entry| {
        entry
            .models
            .iter()
            .filter(|model| model.to_lowercase() == wanted)
            .map(|model| (entry.id.clone(), model.clone()))
    });
    match (matches.next(), matches.next()) {
        (Some(only), None) => Some(only),
        _ => None,
    }
}

/// `buildModelOverviewText`.
fn overview_text(current: Option<&str>, providers: &[ModelProvider]) -> String {
    let current = current
        .filter(|value| !value.is_empty())
        .unwrap_or("auto (pipeline fallback)");
    let mut lines = vec![
        "Model selection".to_string(),
        format!("Current override: {current}"),
        String::new(),
    ];
    if providers.is_empty() {
        lines.push("No active models are available in profile p1.".to_string());
        return lines.join("\n");
    }
    lines.push("Providers:".to_string());
    lines.extend(
        providers
            .iter()
            .map(|provider| format!("- {}: {} models", provider.id, provider.models.len())),
    );
    lines.push(String::new());
    lines.push("Use /model <model-id> to set directly, or choose a provider below.".to_string());
    lines.join("\n")
}

/// `ParsedModelCallback`.
#[derive(Debug, PartialEq, Eq)]
enum ModelCallback {
    Providers,
    Back,
    List { provider: String, page: usize },
    Select { provider: String, model: String },
}

/// `parseModelCallbackData`. The provider of a list callback keeps its case, so a
/// provider that was not lower case does not match the listing, as in TypeScript.
fn parse_model_callback(data: &str) -> Option<ModelCallback> {
    let trimmed = data.trim();
    if !trimmed.starts_with("mdl_") {
        return None;
    }
    match trimmed {
        "mdl_prov" => return Some(ModelCallback::Providers),
        "mdl_back" => return Some(ModelCallback::Back),
        _ => {}
    }
    if let Some(rest) = trimmed.strip_prefix("mdl_list_") {
        if let Some((provider, page)) = rest.rsplit_once('_') {
            let provider_ok = !provider.is_empty()
                && provider
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
            let page_ok = !page.is_empty() && page.chars().all(|ch| ch.is_ascii_digit());
            if let (true, true, Ok(page)) = (provider_ok, page_ok, page.parse::<usize>()) {
                if page >= 1 {
                    return Some(ModelCallback::List {
                        provider: provider.to_string(),
                        page,
                    });
                }
            }
        }
    }
    if let Some(reference) = trimmed.strip_prefix("mdl_sel_") {
        if let Some(slash) = reference.find('/') {
            if slash > 0 && slash < reference.len() - 1 {
                return Some(ModelCallback::Select {
                    provider: reference[..slash].to_string(),
                    model: reference[slash + 1..].to_string(),
                });
            }
        }
    }
    None
}

/// `resolveCallbackConversationExternalChatId`: the same rule as for messages. A
/// forum topic has its own conversation, except topic 1, the general topic.
fn callback_external_chat_id(chat: &TelegramChat, thread: Option<i64>) -> String {
    let base = chat.id.to_string();
    let thread = match thread {
        Some(thread) if thread > 0 => thread,
        _ => return base,
    };
    let is_forum_group = chat.kind == "supergroup" && chat.is_forum == Some(true);
    if chat.kind == "private" || (is_forum_group && thread != 1) {
        return format!("{base}:topic:{thread}");
    }
    base
}

/// `buildProviderKeyboard`: two providers per row.
fn provider_rows(providers: &[ModelProvider]) -> Vec<Vec<InlineKeyboardButton>> {
    providers
        .chunks(2)
        .map(|pair| {
            pair.iter()
                .map(|provider| {
                    button(
                        format!("{} ({})", provider.id, provider.models.len()),
                        format!("mdl_list_{}_1", provider.id),
                    )
                })
                .collect()
        })
        .collect()
}

/// `buildBrowseProvidersButton`.
fn browse_rows() -> Vec<Vec<InlineKeyboardButton>> {
    vec![vec![button("Browse providers", "mdl_prov")]]
}

/// `buildModelsKeyboard`: one page of models, the page row and the back button.
/// Buttons whose callback data would exceed Telegram's limit are left out.
fn models_rows(
    provider: &str,
    models: &[String],
    current: Option<&str>,
    page: usize,
    total_pages: usize,
) -> Vec<Vec<InlineKeyboardButton>> {
    if models.is_empty() {
        return vec![vec![button("< Back", "mdl_back")]];
    }
    let mut rows = Vec::new();
    let start = page.saturating_sub(1) * MODELS_PAGE_SIZE;
    for model in models.iter().skip(start).take(MODELS_PAGE_SIZE) {
        let callback = format!("mdl_sel_{provider}/{model}");
        if callback.len() > MAX_CALLBACK_DATA_BYTES {
            continue;
        }
        let label = truncate_model_id(model, MODEL_LABEL_MAX_CHARS);
        let text = if current == Some(model.as_str()) {
            format!("{label} *")
        } else {
            label
        };
        rows.push(vec![button(text, callback)]);
    }
    if total_pages > 1 {
        let mut page_row = Vec::new();
        if page > 1 {
            page_row.push(button(
                "< Prev",
                format!("mdl_list_{provider}_{}", page - 1),
            ));
        }
        page_row.push(button(
            format!("{page}/{total_pages}"),
            format!("mdl_list_{provider}_{page}"),
        ));
        if page < total_pages {
            page_row.push(button(
                "Next >",
                format!("mdl_list_{provider}_{}", page + 1),
            ));
        }
        rows.push(page_row);
    }
    rows.push(vec![button("< Back", "mdl_back")]);
    rows
}

/// `calculateTotalPages` with the model page size. An empty list has one page.
fn total_pages(total_models: usize) -> usize {
    total_models.div_ceil(MODELS_PAGE_SIZE).max(1)
}

/// `truncateModelId`: the tail of a long id behind an ellipsis.
fn truncate_model_id(model: &str, max_chars: usize) -> String {
    let count = model.chars().count();
    if count <= max_chars {
        return model.to_string();
    }
    let tail: String = model.chars().skip(count - (max_chars - 3)).collect();
    format!("...{tail}")
}

fn button(text: impl Into<String>, callback_data: impl Into<String>) -> InlineKeyboardButton {
    InlineKeyboardButton {
        text: text.into(),
        callback_data: callback_data.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::families::channels_wire::test_support::{
        harness_on, telegram_ok, FakeInbound, Harness, ScratchDir, ScriptedHttp,
    };
    use betaclaw_core::messages_store::{MessageRole, SaveMessageInput};
    use betaclaw_core::model_hub::http::{HttpError, HttpResponse};
    use serde_json::json;

    fn entry(provider: &str, model: &str, status: PipelineStatus) -> PipelineModelEntry {
        PipelineModelEntry {
            id: format!("{provider}/{model}"),
            profile_id: "p1".to_string(),
            account_id: "acc".to_string(),
            provider_id: provider.to_string(),
            model_name: model.to_string(),
            reasoning_effort: None,
            priority: 0,
            status,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn providers() -> Vec<ModelProvider> {
        vec![
            ModelProvider {
                id: "openai".to_string(),
                models: vec!["gpt-4o".to_string(), "gpt-5".to_string()],
            },
            ModelProvider {
                id: "anthropic".to_string(),
                models: vec!["claude".to_string()],
            },
        ]
    }

    fn texts(rows: &[Vec<InlineKeyboardButton>]) -> Vec<String> {
        rows.iter().flatten().map(|b| b.text.clone()).collect()
    }

    #[test]
    fn native_commands_are_parsed_like_the_typescript_handler() {
        assert_eq!(
            parse_native_command("/model"),
            NativeCommand::Model(String::new())
        );
        assert_eq!(
            parse_native_command("/Model@mybot  gpt-5 "),
            NativeCommand::Model("gpt-5".to_string())
        );
        assert_eq!(
            parse_native_command("/chatdelete now"),
            NativeCommand::ChatDelete
        );
        assert_eq!(parse_native_command("/new"), NativeCommand::None);
        assert_eq!(parse_native_command("hello /model"), NativeCommand::None);
    }

    #[test]
    fn active_providers_are_grouped_and_sorted() {
        let entries = [
            entry("OpenAI ", "gpt-5", PipelineStatus::Active),
            entry("openai", "gpt-4o", PipelineStatus::Active),
            entry("openai", "gpt-5", PipelineStatus::Active),
            entry("openai", "Gpt-Old", PipelineStatus::RateLimited),
            entry("!!", "x", PipelineStatus::Active),
        ];
        assert_eq!(
            group_active_providers(&entries),
            vec![ModelProvider {
                id: "openai".to_string(),
                models: vec!["gpt-4o".to_string(), "gpt-5".to_string()],
            }]
        );
    }

    #[test]
    fn a_model_reference_resolves_by_pair_or_unique_name() {
        let providers = providers();
        assert_eq!(
            find_model_by_reference(&providers, "anthropic/claude"),
            Some(("anthropic".to_string(), "claude".to_string()))
        );
        assert_eq!(
            find_model_by_reference(&providers, "GPT-5"),
            Some(("openai".to_string(), "gpt-5".to_string()))
        );
        assert_eq!(find_model_by_reference(&providers, "gpt-9"), None);
        assert_eq!(find_model_by_reference(&providers, "   "), None);

        let shared = vec![
            ModelProvider {
                id: "a".to_string(),
                models: vec!["m".to_string()],
            },
            ModelProvider {
                id: "b".to_string(),
                models: vec!["M".to_string()],
            },
        ];
        assert_eq!(find_model_by_reference(&shared, "m"), None);
        assert_eq!(
            find_model_by_reference(&shared, "b/M"),
            Some(("b".to_string(), "M".to_string()))
        );
    }

    #[test]
    fn callback_data_is_parsed_and_other_data_is_not_a_model_button() {
        assert_eq!(
            parse_model_callback("mdl_prov"),
            Some(ModelCallback::Providers)
        );
        assert_eq!(parse_model_callback("mdl_back"), Some(ModelCallback::Back));
        assert_eq!(
            parse_model_callback("mdl_list_openai_2"),
            Some(ModelCallback::List {
                provider: "openai".to_string(),
                page: 2
            })
        );
        assert_eq!(
            parse_model_callback("mdl_list_my_prov_1"),
            Some(ModelCallback::List {
                provider: "my_prov".to_string(),
                page: 1
            })
        );
        assert_eq!(
            parse_model_callback("mdl_sel_openai/gpt-5"),
            Some(ModelCallback::Select {
                provider: "openai".to_string(),
                model: "gpt-5".to_string()
            })
        );
        assert_eq!(parse_model_callback("mdl_list_openai_0"), None);
        assert_eq!(parse_model_callback("mdl_sel_/gpt"), None);
        assert_eq!(parse_model_callback("mdl_sel_openai/"), None);
        assert_eq!(parse_model_callback("mdl_other"), None);
        assert_eq!(parse_model_callback("hello"), None);
    }

    #[test]
    fn the_last_models_page_has_prev_and_no_next() {
        let models: Vec<String> = (1..=10).map(|n| format!("m{n}")).collect();
        let rows = models_rows("openai", &models, Some("m9"), 2, 2);
        assert_eq!(texts(&rows), vec!["m9 *", "m10", "< Prev", "2/2", "< Back"]);
        let callbacks: Vec<String> = rows
            .iter()
            .flatten()
            .map(|b| b.callback_data.clone())
            .collect();
        assert_eq!(callbacks[2], "mdl_list_openai_1");
        assert_eq!(callbacks[3], "mdl_list_openai_2");
    }

    #[test]
    fn oversized_model_buttons_are_left_out_and_long_labels_are_cut() {
        let provider = "p".repeat(50);
        let long = "x".repeat(40);
        let rows = models_rows(&provider, &[long], None, 1, 1);
        assert_eq!(texts(&rows), vec!["< Back"]);

        let id = format!("{}tail", "a".repeat(60));
        assert_eq!(
            truncate_model_id(&id, 40),
            format!("...{}", "a".repeat(33)) + "tail"
        );
        assert_eq!(truncate_model_id("short", 40), "short");
    }

    #[test]
    fn the_overview_names_the_fallback_and_the_empty_pipeline() {
        assert_eq!(
            overview_text(None, &[]),
            "Model selection\nCurrent override: auto (pipeline fallback)\n\nNo active models are available in profile p1."
        );
        let text = overview_text(Some("gpt-5"), &providers());
        assert!(text.contains("Current override: gpt-5"));
        assert!(text.contains("- openai: 2 models"));
    }

    #[test]
    fn a_forum_topic_callback_has_its_own_conversation_except_topic_one() {
        let chat = |kind: &str, is_forum: Option<bool>| {
            serde_json::from_value::<TelegramChat>(
                json!({"id": -100, "type": kind, "is_forum": is_forum}),
            )
            .expect("a chat")
        };
        assert_eq!(
            callback_external_chat_id(&chat("supergroup", Some(true)), Some(9)),
            "-100:topic:9"
        );
        assert_eq!(
            callback_external_chat_id(&chat("supergroup", Some(true)), Some(1)),
            "-100"
        );
        assert_eq!(
            callback_external_chat_id(&chat("group", None), Some(9)),
            "-100"
        );
        assert_eq!(
            callback_external_chat_id(&chat("private", None), Some(3)),
            "-100:topic:3"
        );
    }

    /// A harness whose Telegram answers come from `responses`, in call order.
    fn telegram_harness(
        scratch: &ScratchDir,
        responses: Vec<Result<HttpResponse, HttpError>>,
    ) -> (Harness, Arc<ScriptedHttp>) {
        let transport = ScriptedHttp::with(responses);
        let h = harness_on(scratch, FakeInbound::default(), transport.clone());
        h.services.env.set("TELEGRAM_BOT_TOKEN", "1:t");
        h.services
            .env
            .set("MODEL_HUB_DB_PATH", &scratch.path_string("model-hub.db"));
        (h, transport)
    }

    /// The JSON body of the request at `index`.
    fn sent_body(transport: &ScriptedHttp, index: usize) -> String {
        transport.requests()[index].body.clone().unwrap_or_default()
    }

    /// The Telegram method of the request at `index`, from its URL.
    fn method_at(transport: &ScriptedHttp, index: usize) -> String {
        let url = transport.urls()[index].clone();
        url.rsplit('/').next().unwrap_or_default().to_string()
    }

    fn callback(data: &str, message_id: Option<i64>) -> TelegramCallbackQuery {
        let mut message = json!({"chat": {"id": 555, "type": "private"}});
        if let Some(message_id) = message_id {
            message["message_id"] = json!(message_id);
        }
        serde_json::from_value(json!({"id": "cb1", "data": data, "message": message}))
            .expect("a callback query")
    }

    #[tokio::test]
    async fn chatdelete_removes_the_newest_message_and_reports_it() {
        let scratch = ScratchDir::new();
        let (h, transport) = telegram_harness(&scratch, vec![telegram_ok(1)]);
        let conversation = h
            .services
            .db
            .get_or_create_conversation("Telegram", "555")
            .expect("conversation");
        let saved = h
            .state
            .messages
            .lock()
            .await
            .save_message(&SaveMessageInput {
                conversation_id: &conversation.id,
                role: MessageRole::User,
                content: "bye",
                platform: "Telegram",
                external_msg_id: None,
                sender_name: None,
                metadata: None,
                client_message_id: None,
            })
            .expect("saved");

        let handled = h
            .services
            .telegram
            .handle_native_command("/chatdelete", "555")
            .await
            .expect("handled");

        assert!(handled);
        assert!(sent_body(&transport, 0).contains("Last message deleted."));
        let remaining = h
            .state
            .messages
            .lock()
            .await
            .get_message(&saved.id, Some(&conversation.user_id))
            .expect("lookup");
        assert!(remaining.is_none());
    }

    #[tokio::test]
    async fn chatdelete_in_an_empty_chat_says_so() {
        let scratch = ScratchDir::new();
        let (h, transport) = telegram_harness(&scratch, vec![telegram_ok(1)]);

        h.services
            .telegram
            .handle_native_command("/chatdelete", "999")
            .await
            .expect("handled");

        assert!(sent_body(&transport, 0).contains("Nothing to delete."));
    }

    #[tokio::test]
    async fn model_without_arguments_shows_the_empty_pipeline_without_buttons() {
        let scratch = ScratchDir::new();
        let (h, transport) = telegram_harness(&scratch, vec![telegram_ok(1)]);

        h.services
            .telegram
            .handle_native_command("/model", "555")
            .await
            .expect("handled");

        let body = sent_body(&transport, 0);
        assert!(body.contains("No active models are available in profile p1."));
        assert!(!body.contains("reply_markup"));
    }

    #[tokio::test]
    async fn model_clear_and_unknown_arguments_are_answered() {
        let scratch = ScratchDir::new();
        let (h, transport) = telegram_harness(&scratch, vec![telegram_ok(1), telegram_ok(2)]);

        h.services
            .telegram
            .handle_native_command("/model off", "555")
            .await
            .expect("handled");
        h.services
            .telegram
            .handle_native_command("/model gpt-9", "555")
            .await
            .expect("handled");

        assert!(sent_body(&transport, 0)
            .contains("Model override cleared. The pipeline fallback will be used."));
        assert!(sent_body(&transport, 1)
            .contains("Model not found in active pipeline. Send /model for provider browsing."));
    }

    #[tokio::test]
    async fn a_text_that_is_not_a_native_command_is_left_to_the_dispatch() {
        let scratch = ScratchDir::new();
        let (h, transport) = telegram_harness(&scratch, vec![]);

        let handled = h
            .services
            .telegram
            .handle_native_command("/new", "555")
            .await
            .expect("handled");

        assert!(!handled);
        assert!(transport.requests().is_empty());
    }

    #[tokio::test]
    async fn the_browse_button_edits_the_message_it_sits_on() {
        let scratch = ScratchDir::new();
        let (h, transport) = telegram_harness(&scratch, vec![telegram_ok(0), telegram_ok(0)]);

        let handled = h
            .services
            .telegram
            .handle_model_callback(&callback("mdl_prov", Some(40)))
            .await
            .expect("handled");

        assert!(handled);
        assert_eq!(method_at(&transport, 0), "answerCallbackQuery");
        assert_eq!(method_at(&transport, 1), "editMessageText");
        let edit = sent_body(&transport, 1);
        assert!(edit.contains("No active models are available in profile p1."));
        assert!(edit.contains("Browse providers"));
        assert!(edit.contains("\"message_id\":40"));
    }

    #[tokio::test]
    async fn a_model_choice_that_is_not_active_is_answered_and_nothing_is_edited() {
        let scratch = ScratchDir::new();
        let (h, transport) = telegram_harness(&scratch, vec![telegram_ok(0)]);

        h.services
            .telegram
            .handle_model_callback(&callback("mdl_sel_openai/gpt-5", Some(40)))
            .await
            .expect("handled");

        assert_eq!(transport.urls().len(), 1);
        assert!(sent_body(&transport, 0).contains("Model not available."));
    }

    #[tokio::test]
    async fn a_listing_of_an_unknown_provider_is_answered() {
        let scratch = ScratchDir::new();
        let (h, transport) = telegram_harness(&scratch, vec![telegram_ok(0)]);

        h.services
            .telegram
            .handle_model_callback(&callback("mdl_list_openai_1", Some(40)))
            .await
            .expect("handled");

        assert_eq!(transport.urls().len(), 1);
        assert!(sent_body(&transport, 0).contains("Provider not found."));
    }

    #[tokio::test]
    async fn a_callback_that_is_not_a_model_button_is_not_handled_here() {
        let scratch = ScratchDir::new();
        let (h, transport) = telegram_harness(&scratch, vec![]);

        let handled = h
            .services
            .telegram
            .handle_model_callback(&callback("other:data", Some(1)))
            .await
            .expect("handled");

        assert!(!handled);
        assert!(transport.requests().is_empty());
    }
}
