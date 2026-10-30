//! Port of `src/server/channels/messages/service/dispatchers/ai/runModelToolLoop.ts`.
//!
//! The tool loop: ask the model, run the function it requests, feed the result back,
//! and stop on a final text answer or on one of the guards below. Guards, in source
//! order: max tool calls, critical loop pre-check, approval pause, repeated failure
//! (`MAX_REPEATED_FAILED_TOOL_CALLS`), critical post-check. Loop warnings are added as a
//! prefix to the tool result.
//!
//! A gateway error propagates as `Err`, as the TypeScript `await` does. The caller
//! turns it into the "AI dispatch failed" reply.
//!
//! Signature note: the TypeScript `buildToolSignature` and `buildArgsHash` build the
//! same string (`name:JSON(args || {})`), so the port uses one value for both.

use serde_json::{json, Map, Value};

use crate::channels::messages::service::dispatchers::ai::types::{
    ModelOutcome, OutcomeMetadata, RunModelToolLoopParams,
};
use crate::channels::messages::service::execution::ports::PortResult;
use crate::channels::messages::service::ports::ModelGateway;
use crate::channels::messages::service::tool_loop_detector::{
    build_args_hash, build_result_hash, create_loop_detector_state, detect_loop, record_call,
    record_outcome, LoopDetectionResult, LoopLevel,
};
use crate::channels::messages::service::tool_manager::{ToolCallRequest, ToolManager};
use crate::channels::messages::service::types::{
    ToolExecutionResult, MAX_REPEATED_FAILED_TOOL_CALLS, MAX_TOOL_ROUNDS, TOOL_CALLS_HARD_CAP,
};
use crate::messages_store::types::ChannelType;
use crate::model_hub::service::types::DispatchWithFallbackOptions;
use crate::model_hub::types::{
    GatewayAuditContext, GatewayAuditKind, GatewayMessage, GatewayRequest, GatewayResponse,
    GatewayRole, GatewayUsage,
};

/// Runs the tool loop (`runModelToolLoop`, `runModelToolLoop.ts:19-242`).
pub async fn run_model_tool_loop(
    model: &dyn ModelGateway,
    tools: &ToolManager,
    params: RunModelToolLoopParams,
) -> PortResult<ModelOutcome> {
    let encryption_key = model.encryption_key()?;
    let max_tool_calls = normalize_max_tool_calls(params.max_tool_calls);
    let profile_id = params.model_hub_profile_id.clone();
    let mut executed: i64 = 0;
    let mut failed_signature: Option<String> = None;
    let mut consecutive_failed: usize = 0;
    let mut loop_state = create_loop_detector_state();
    let mut messages: Vec<GatewayMessage> = params.messages.clone();

    while executed <= max_tool_calls {
        let mut request = GatewayRequest::new(String::new(), messages.clone());
        request.tools =
            (!params.tool_context.tools.is_empty()).then(|| params.tool_context.tools.clone());
        request.stream = Some(params.on_stream_delta.is_some());
        request.audit_context = Some(GatewayAuditContext {
            kind: GatewayAuditKind::Chat,
            conversation_id: Some(params.conversation.id.clone()),
            turn_seq: params.audit_context_extras.turn_seq,
            memory_context: params.audit_context_extras.memory_context.clone(),
            task_id: None,
            step_id: None,
            node_id: None,
        });
        let options = DispatchWithFallbackOptions {
            abort: params.abort_signal.clone(),
            model_override: params.preferred_model_id.clone(),
            on_stream_delta: params.on_stream_delta.clone(),
        };

        let result = model
            .dispatch_with_fallback(profile_id.clone(), encryption_key.clone(), request, options)
            .await?;

        if !result.ok {
            let error_text = result.error.clone().filter(|e| !e.is_empty());
            return Ok(ModelOutcome {
                content: format!(
                    "AI dispatch failed: {}",
                    error_text
                        .clone()
                        .unwrap_or_else(|| "unknown error".to_string())
                ),
                // No `usage` key on this path (`runModelToolLoop.ts:57-68`).
                metadata: with_stats(
                    map_of([
                        ("ok", json!(false)),
                        ("runtime", json!("model-hub")),
                        ("profileId", json!(profile_id)),
                        ("model", nullable(&result.model)),
                        ("provider", nullable(&result.provider)),
                    ]),
                    executed,
                    [(
                        "error",
                        json!(error_text.unwrap_or_else(|| "AI dispatch failed".to_string())),
                    )],
                ),
            });
        }

        if let Some(call) = result
            .function_calls
            .as_ref()
            .and_then(|calls| calls.first())
            .filter(|call| !call.name.trim().is_empty())
        {
            let function_name = call.name.trim().to_string();

            if executed >= max_tool_calls {
                return Ok(ModelOutcome {
                    content: format!(
                        "Tool loop stopped before completion: reached max tool calls ({max_tool_calls}) while model requested \"{function_name}\"."
                    ),
                    metadata: with_stats(
                        base_metadata(&profile_id, &result, false),
                        executed,
                        [
                            ("status", json!("tool_limit_reached")),
                            ("requestedTool", json!(function_name)),
                            ("maxToolCalls", json!(max_tool_calls)),
                            ("usage", usage_value(&result.usage)),
                        ],
                    ),
                });
            }

            let tool_args = match &call.args {
                None | Some(Value::Null) => json!({}),
                Some(other) => other.clone(),
            };
            // `buildToolSignature` and `buildArgsHash` produce the same string.
            let args_hash = build_args_hash(&function_name, &tool_args);
            record_call(&mut loop_state, &function_name, &args_hash);
            let pre_check = detect_loop(&loop_state, &function_name, &args_hash);
            if pre_check.level == LoopLevel::Critical {
                return Ok(ModelOutcome {
                    content: pre_check.message,
                    metadata: map_of([
                        ("ok", json!(false)),
                        ("status", json!("loop_detected_critical")),
                        ("runtime", json!("model-hub")),
                        ("profileId", json!(profile_id)),
                        ("model", Value::Null),
                        ("provider", Value::Null),
                    ]),
                });
            }

            emit_delta(&params, &format!("\u{0}tc:{function_name}"));
            let execution = tools
                .execute_tool_function_call(ToolCallRequest {
                    conversation: params.conversation.clone(),
                    platform: channel_of(&params),
                    external_chat_id: params
                        .conversation
                        .external_chat_id
                        .clone()
                        .filter(|id| !id.is_empty())
                        .unwrap_or_else(|| "default".to_string()),
                    function_name: function_name.clone(),
                    args: tool_args.clone(),
                    workspace_cwd: params.workspace_cwd.clone(),
                    installed_functions: params.tool_context.installed_function_names.clone(),
                    tool_id: params
                        .tool_context
                        .function_to_skill_id
                        .get(&function_name)
                        .cloned(),
                    skip_approval_check: false,
                })
                .await;

            if let ToolExecutionResult::ApprovalRequired { prompt, pending } = &execution {
                let extra = map_of([
                    ("ok", json!(false)),
                    ("status", json!("approval_required")),
                    ("runtime", json!("model-hub")),
                    ("profileId", json!(profile_id)),
                    ("model", nullable(&result.model)),
                    ("provider", nullable(&result.provider)),
                ]);
                let metadata = tools.build_approval_metadata(pending, prompt, extra);
                return Ok(ModelOutcome {
                    content: prompt.clone(),
                    metadata: with_stats(metadata, executed, []),
                });
            }

            let (ok, output) = match &execution {
                ToolExecutionResult::Ok { output } => (true, output.clone()),
                ToolExecutionResult::Error { output } => (false, output.clone()),
                ToolExecutionResult::ApprovalRequired { .. } => unreachable!("handled above"),
            };

            if ok {
                failed_signature = None;
                consecutive_failed = 0;
            } else {
                if failed_signature.as_deref() == Some(args_hash.as_str()) {
                    consecutive_failed += 1;
                } else {
                    failed_signature = Some(args_hash.clone());
                    consecutive_failed = 1;
                }
            }

            if consecutive_failed >= MAX_REPEATED_FAILED_TOOL_CALLS {
                return Ok(ModelOutcome {
                    content: format!(
                        "Tool loop stopped: \"{function_name}\" failed {consecutive_failed} times in a row with the same arguments. I stopped to prevent an endless retry loop."
                    ),
                    metadata: with_stats(
                        base_metadata(&profile_id, &result, false),
                        executed,
                        [
                            ("status", json!("tool_stuck_repetition")),
                            ("requestedTool", json!(function_name)),
                            ("repeatedFailedToolCalls", json!(consecutive_failed)),
                            ("usage", usage_value(&result.usage)),
                        ],
                    ),
                });
            }

            emit_delta(&params, "\u{0}tc:");
            record_outcome(
                &mut loop_state,
                &function_name,
                &args_hash,
                &build_result_hash(&output),
            );
            let post_check: LoopDetectionResult =
                detect_loop(&loop_state, &function_name, &args_hash);
            if post_check.level == LoopLevel::Critical {
                return Ok(ModelOutcome {
                    content: post_check.message,
                    metadata: with_stats(
                        map_of([
                            ("ok", json!(false)),
                            ("status", json!("loop_detected_critical")),
                            ("runtime", json!("model-hub")),
                            ("profileId", json!(profile_id)),
                            ("model", Value::Null),
                            ("provider", Value::Null),
                        ]),
                        executed,
                        [],
                    ),
                });
            }
            let prefix = if post_check.level == LoopLevel::Warning {
                format!("{}\n\n", post_check.message)
            } else {
                String::new()
            };

            let tool_result_content = if ok {
                format!("{prefix}Tool \"{function_name}\" result:\n{output}")
            } else {
                format!("{prefix}Tool \"{function_name}\" failed:\n{output}")
            };
            messages.push(GatewayMessage::new(
                GatewayRole::Assistant,
                format!("[Tool call: {function_name}]"),
            ));
            messages.push(GatewayMessage::user(tool_result_content));
            executed += 1;
            continue;
        }

        let normalized = strip_gateway_prefix(&result.text).trim().to_string();
        if normalized.is_empty() {
            return Ok(ModelOutcome {
                content: "Model returned no text output. Execution ended without a final narrative response. Please retry or continue with the latest task state."
                    .to_string(),
                metadata: with_stats(
                    base_metadata(&profile_id, &result, false),
                    executed,
                    [
                        ("status", json!("empty_model_response")),
                        ("usage", usage_value(&result.usage)),
                    ],
                ),
            });
        }

        return Ok(ModelOutcome {
            content: normalized,
            metadata: with_stats(
                map_of([
                    ("ok", json!(true)),
                    ("runtime", json!("model-hub")),
                    ("profileId", json!(profile_id)),
                    ("model", json!(result.model)),
                    ("provider", json!(result.provider)),
                    ("usage", usage_value(&result.usage)),
                ]),
                executed,
                [],
            ),
        });
    }

    let message = format!("Tool loop exceeded maximum rounds ({max_tool_calls}).");
    Ok(ModelOutcome {
        content: message.clone(),
        metadata: with_stats(
            map_of([
                ("ok", json!(false)),
                ("runtime", json!("model-hub")),
                ("profileId", json!(profile_id)),
                ("error", json!(message)),
            ]),
            executed,
            [],
        ),
    })
}

/// `normalizeMaxToolCalls` (`runModelToolLoop.ts:244-249`): a missing value gives the
/// minimum of three rounds, and the result is kept between 3 and the hard cap.
fn normalize_max_tool_calls(requested: Option<i64>) -> i64 {
    match requested {
        None => MAX_TOOL_ROUNDS,
        Some(value) => value.clamp(MAX_TOOL_ROUNDS, TOOL_CALLS_HARD_CAP),
    }
}

/// `MODEL_HUB_GATEWAY_PREFIX_RE` replacement (`types.ts:8`).
fn strip_gateway_prefix(text: &str) -> &str {
    crate::channels::messages::service::types::MODEL_HUB_GATEWAY_PREFIX_RE
        .find(text)
        .map_or(text, |m| &text[m.end()..])
}

fn emit_delta(params: &RunModelToolLoopParams, delta: &str) {
    if let Some(callback) = &params.on_stream_delta {
        callback(delta);
    }
}

/// `ChannelType` of the conversation. An unknown stored value falls back to
/// `WebChat`, because the port carries a typed enum where TypeScript carries a string.
fn channel_of(params: &RunModelToolLoopParams) -> ChannelType {
    ChannelType::parse(&params.conversation.channel_type).unwrap_or(ChannelType::WebChat)
}

/// `{ ok, runtime, profileId, model, provider, usage }` for a dispatch result.
fn base_metadata(profile_id: &str, result: &GatewayResponse, ok: bool) -> OutcomeMetadata {
    map_of([
        ("ok", json!(ok)),
        ("runtime", json!("model-hub")),
        ("profileId", json!(profile_id)),
        ("model", nullable(&result.model)),
        ("provider", nullable(&result.provider)),
        ("usage", usage_value(&result.usage)),
    ])
}

/// `withToolStats`: adds `executedToolCalls` and any extra keys, last one wins.
fn with_stats<const N: usize>(
    mut metadata: OutcomeMetadata,
    executed: i64,
    extra: [(&str, Value); N],
) -> OutcomeMetadata {
    for (key, value) in extra {
        metadata.insert(key.to_string(), value);
    }
    metadata.insert("executedToolCalls".to_string(), json!(executed));
    metadata
}

fn map_of<const N: usize>(entries: [(&str, Value); N]) -> OutcomeMetadata {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.to_string(), value);
    }
    map
}

/// `x || null` for a string field.
fn nullable(value: &str) -> Value {
    if value.is_empty() {
        Value::Null
    } else {
        json!(value)
    }
}

/// `result.usage || null`.
fn usage_value(usage: &Option<GatewayUsage>) -> Value {
    match usage {
        Some(usage) => json!({
            "prompt_tokens": usage.prompt_tokens,
            "completion_tokens": usage.completion_tokens,
            "total_tokens": usage.total_tokens,
        }),
        None => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::dispatchers::ai::types::AuditContextExtras;
    use crate::channels::messages::service::execution::ports::PortError;
    use crate::channels::messages::service::ports::{
        BoxFuture, CommandPolicy, SkillDispatchContext, SkillRow, ToolBackend,
    };
    use crate::channels::messages::service::types::ResolvedToolContext;
    use crate::messages_store::types::Conversation;
    use crate::model_hub::types::GatewayFunctionCall;
    use serde_json::json;
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::sync::{Arc, Mutex};

    /// Model fake that replays scripted replies and records each request.
    struct ScriptedModel {
        script: Mutex<VecDeque<PortResult<GatewayResponse>>>,
        requests: Mutex<Vec<GatewayRequest>>,
    }

    impl ScriptedModel {
        fn new(script: Vec<PortResult<GatewayResponse>>) -> Self {
            Self {
                script: Mutex::new(script.into()),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn request(&self, index: usize) -> GatewayRequest {
            self.requests.lock().unwrap()[index].clone()
        }
    }

    impl ModelGateway for ScriptedModel {
        fn encryption_key(&self) -> PortResult<String> {
            Ok("test-key".to_string())
        }

        fn dispatch_with_fallback(
            &self,
            _profile_id: String,
            _encryption_key: String,
            request: GatewayRequest,
            _options: DispatchWithFallbackOptions,
        ) -> BoxFuture<'_, PortResult<GatewayResponse>> {
            self.requests.lock().unwrap().push(request);
            let next = self
                .script
                .lock()
                .unwrap()
                .pop_front()
                .expect("the script has a reply for every request");
            Box::pin(async move { next })
        }
    }

    /// Tool fake: echoes the arguments, or fails every call.
    struct FakeTools {
        fail: bool,
    }

    impl ToolBackend for FakeTools {
        fn list_skills(&self) -> BoxFuture<'_, PortResult<Vec<SkillRow>>> {
            Box::pin(async { Ok(vec![]) })
        }
        fn map_skills_to_tools(&self, _installed: &[SkillRow]) -> Vec<Value> {
            vec![]
        }
        fn evaluate_command_policy(&self, command: &str) -> CommandPolicy {
            CommandPolicy {
                allowed: true,
                normalized_command: command.to_string(),
                reason: None,
            }
        }
        fn is_command_approved(&self, _normalized: &str) -> bool {
            true
        }
        fn approve_command(&self, _command: &str) {}
        fn build_python_command(&self, code: &str) -> String {
            code.to_string()
        }
        fn resolve_playwright_tokens(&self, _args: &Value) -> PortResult<Vec<String>> {
            Ok(vec![])
        }
        fn build_playwright_cli_command(&self, _tokens: &[String]) -> String {
            String::new()
        }
        fn normalize_skill_args(&self, args: &Value) -> Value {
            args.clone()
        }
        fn dispatch_skill(
            &self,
            _function_name: String,
            args: Value,
            _context: SkillDispatchContext,
        ) -> BoxFuture<'_, PortResult<Value>> {
            let fail = self.fail;
            Box::pin(async move {
                if fail {
                    Err(PortError::from("tool exploded"))
                } else {
                    Ok(json!({ "echo": args }))
                }
            })
        }
    }

    fn manager(fail: bool) -> ToolManager {
        ToolManager::new(Arc::new(FakeTools { fail }), Box::new(|| false), None)
    }

    fn conversation() -> Conversation {
        Conversation {
            id: "c-1".into(),
            channel_type: "WebChat".into(),
            external_chat_id: Some("chat".into()),
            user_id: "u-1".into(),
            workspace_id: None,
            title: "t".into(),
            model_override: None,
            persona_id: None,
            created_at: "t0".into(),
            updated_at: "t0".into(),
        }
    }

    fn params(max_tool_calls: Option<i64>, installed: &[&str]) -> RunModelToolLoopParams {
        RunModelToolLoopParams {
            conversation: conversation(),
            messages: vec![GatewayMessage::user("hi")],
            model_hub_profile_id: "p1".into(),
            preferred_model_id: None,
            workspace_cwd: None,
            tool_context: ResolvedToolContext {
                tools: vec![],
                installed_function_names: installed
                    .iter()
                    .map(|s| s.to_string())
                    .collect::<HashSet<_>>(),
                function_to_skill_id: HashMap::new(),
            },
            max_tool_calls,
            abort_signal: None,
            on_stream_delta: None,
            audit_context_extras: AuditContextExtras::default(),
        }
    }

    fn response(
        ok: bool,
        text: &str,
        function: Option<(&str, Value)>,
        error: Option<&str>,
    ) -> GatewayResponse {
        GatewayResponse {
            ok,
            text: text.to_string(),
            model: "m".to_string(),
            provider: "p".to_string(),
            usage: None,
            function_calls: function.map(|(name, args)| {
                vec![GatewayFunctionCall {
                    name: name.to_string(),
                    args: Some(args),
                }]
            }),
            rate_limits: None,
            error: error.map(str::to_string),
        }
    }

    fn text(text: &str) -> PortResult<GatewayResponse> {
        Ok(response(true, text, None, None))
    }

    fn call(name: &str, args: Value) -> PortResult<GatewayResponse> {
        Ok(response(true, "", Some((name, args)), None))
    }

    #[tokio::test]
    async fn a_text_answer_ends_the_loop_and_drops_the_gateway_prefix() {
        let model = ScriptedModel::new(vec![text("[model-hub-gateway test] hello ")]);
        let outcome = run_model_tool_loop(&model, &manager(false), params(None, &[]))
            .await
            .expect("answer");
        assert_eq!(outcome.content, "hello");
        assert_eq!(outcome.metadata["ok"], json!(true));
        assert_eq!(outcome.metadata["executedToolCalls"], json!(0));
    }

    #[tokio::test]
    async fn a_tool_result_is_fed_back_before_the_final_answer() {
        let model = ScriptedModel::new(vec![call("calc_sum", json!({"a": 1})), text("done")]);
        let outcome = run_model_tool_loop(&model, &manager(false), params(None, &["calc_sum"]))
            .await
            .expect("answer");
        assert_eq!(outcome.content, "done");
        assert_eq!(outcome.metadata["executedToolCalls"], json!(1));

        let second = model.request(1);
        assert!(second
            .messages
            .iter()
            .any(|m| m.content == "[Tool call: calc_sum]"));
        assert!(second
            .messages
            .iter()
            .any(|m| m.content.starts_with("Tool \"calc_sum\" result:\n")));
    }

    #[tokio::test]
    async fn the_loop_stops_at_the_tool_limit() {
        let script = (0..5)
            .map(|n| call("calc_sum", json!({ "n": n })))
            .collect();
        let model = ScriptedModel::new(script);
        let outcome = run_model_tool_loop(&model, &manager(false), params(Some(3), &["calc_sum"]))
            .await
            .expect("outcome");
        assert_eq!(outcome.metadata["status"], json!("tool_limit_reached"));
        assert_eq!(outcome.metadata["executedToolCalls"], json!(3));
        assert_eq!(outcome.metadata["requestedTool"], json!("calc_sum"));
        assert!(outcome.content.contains("reached max tool calls (3)"));
    }

    /// Four failures in a row with the same arguments end the loop. The fourth call
    /// does not count as executed, because the source returns before the increment.
    /// The limit is raised to 10 here. At the default of 3 rounds the limit fires
    /// first, so the repetition guard is only reachable above three rounds. The
    /// TypeScript source behaves the same way (`MAX_TOOL_ROUNDS` < `MAX_REPEATED_FAILED_TOOL_CALLS`).
    #[tokio::test]
    async fn repeated_failures_with_the_same_arguments_stop_the_loop() {
        let script = (0..6)
            .map(|_| call("calc_sum", json!({ "a": 1 })))
            .collect();
        let model = ScriptedModel::new(script);
        let outcome = run_model_tool_loop(&model, &manager(true), params(Some(10), &["calc_sum"]))
            .await
            .expect("outcome");
        assert_eq!(outcome.metadata["status"], json!("tool_stuck_repetition"));
        assert_eq!(outcome.metadata["repeatedFailedToolCalls"], json!(4));
        assert_eq!(outcome.metadata["executedToolCalls"], json!(3));
    }

    #[tokio::test]
    async fn a_gateway_error_propagates_for_the_caller_to_report() {
        let model = ScriptedModel::new(vec![Err(PortError::Aborted)]);
        let error = run_model_tool_loop(&model, &manager(false), params(None, &[]))
            .await
            .expect_err("the error is not swallowed");
        assert_eq!(error, PortError::Aborted);
    }

    #[tokio::test]
    async fn a_rejected_dispatch_and_an_empty_answer_are_outcomes_not_errors() {
        let rejected =
            ScriptedModel::new(vec![Ok(response(false, "", None, Some("rate limited")))]);
        let outcome = run_model_tool_loop(&rejected, &manager(false), params(None, &[]))
            .await
            .expect("outcome");
        assert_eq!(outcome.content, "AI dispatch failed: rate limited");
        assert_eq!(outcome.metadata["error"], json!("rate limited"));

        let empty = ScriptedModel::new(vec![text("   ")]);
        let outcome = run_model_tool_loop(&empty, &manager(false), params(None, &[]))
            .await
            .expect("outcome");
        assert_eq!(outcome.metadata["status"], json!("empty_model_response"));
    }

    #[test]
    fn max_tool_calls_is_clamped_to_three_through_the_hard_cap() {
        assert_eq!(normalize_max_tool_calls(None), 3);
        assert_eq!(normalize_max_tool_calls(Some(1)), 3);
        assert_eq!(normalize_max_tool_calls(Some(120)), 120);
        assert_eq!(normalize_max_tool_calls(Some(9999)), 500);
    }
}
