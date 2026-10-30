//! Port of `app/api/master/reminders/route.ts` (GET, POST, PATCH, DELETE),
//! `app/api/master/reminders/[id]/route.ts` (GET, PATCH, DELETE) and
//! `app/api/master/reminders/[id]/fire/route.ts` (POST) over
//! `src/server/master/reminders.ts`.
//!
//! Every write syncs the cron scheduler through [`CronBridge`], which writes the
//! automation rules of `src/server/master/cronBridge.ts`. A failed rule write answers
//! `400` with its message, as the TypeScript `catch` does. The collection `PATCH` and
//! `DELETE` read the reminder id from the body, as the source does.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Extension, Path};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::Json;
use betaclaw_core::master::http::QueryParams;
use betaclaw_core::master::reminders::{
    FireReminderInput, MasterReminderCreateInput, MasterRemindersService,
    MasterRemindersServiceOptions, ReminderSchedulerBridge,
};
use betaclaw_core::master::repository::reminders_store::ReminderPatch;
use chrono::Utc;
use serde_json::{json, Value};

use super::automation::CronBridge;
use super::support::{
    bad_request, filled_field, json_body, query_of, scope_body, string_field, user_or_401,
    ApiError, Reply,
};
use super::Services;

/// The reminder service options: the cron bridge, the family bus and the clock.
fn options<'a>(
    bridge: &'a CronBridge<'a>,
    services: &'a Services,
) -> MasterRemindersServiceOptions<'a> {
    MasterRemindersServiceOptions {
        scheduler: Some(bridge as &dyn ReminderSchedulerBridge),
        publisher: &services.events,
        now: Utc::now,
    }
}

/// The first failed cron write of a request, as the `400` of the TypeScript `catch`.
fn cron_failure(bridge: &CronBridge<'_>) -> Result<(), ApiError> {
    match bridge.take_failure() {
        Some(error) => Err(bad_request(error)),
        None => Ok(()),
    }
}

/// `GET /api/master/reminders` (`reminders/route.ts:22-35`).
pub(super) async fn list(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
) -> Reply {
    let user = user_or_401(&headers)?;
    let repos = services.repos().await;
    let scope = repos.scope(&query_of(&uri), &user, None)?;
    let reminders = MasterRemindersService::new(&*repos.master)
        .list(&scope)
        .map_err(bad_request)?;
    Ok(Json(json!({ "ok": true, "reminders": reminders })).into_response())
}

/// `GET /api/master/reminders/{id}` (`reminders/[id]/route.ts:28-45`).
pub(super) async fn get_reminder(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> Reply {
    let user = user_or_401(&headers)?;
    let repos = services.repos().await;
    let scope = repos.scope(&query_of(&uri), &user, None)?;
    let reminder = MasterRemindersService::new(&*repos.master)
        .get(&scope, &id)
        .map_err(bad_request)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Reminder not found"))?;
    Ok(Json(json!({ "ok": true, "reminder": reminder })).into_response())
}

/// `POST /api/master/reminders` (`reminders/route.ts:37-65`).
pub(super) async fn create(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Reply {
    let user = user_or_401(&headers)?;
    let body = json_body(&body)?;
    let (Some(title), Some(message), Some(remind_at)) = (
        filled_field(&body, "title"),
        filled_field(&body, "message"),
        filled_field(&body, "remindAt"),
    ) else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "title, message and remindAt are required",
        ));
    };
    let repos = services.repos().await;
    let scope = repos.scope(&query_of(&uri), &user, Some(&scope_body(&body)))?;
    let bridge = CronBridge::new(&*services.automation);
    let reminder =
        MasterRemindersService::with_options(&*repos.master, options(&bridge, &services))
            .create(
                &scope,
                &MasterReminderCreateInput {
                    title,
                    message,
                    remind_at,
                    cron_expression: string_field(&body, "cronExpression"),
                },
            )
            .map_err(bad_request)?;
    cron_failure(&bridge)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "ok": true, "reminder": reminder })),
    )
        .into_response())
}

/// `PATCH /api/master/reminders` (`reminders/route.ts:67-96`): the id is in the body.
pub(super) async fn patch_collection(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Reply {
    let user = user_or_401(&headers)?;
    let body = json_body(&body)?;
    let id = filled_field(&body, "reminderId")
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "reminderId is required"))?;
    update(&services, &user, &query_of(&uri), &body, &id).await
}

/// `PATCH /api/master/reminders/{id}` (`reminders/[id]/route.ts:47-71`).
pub(super) async fn patch_one(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
    body: Bytes,
) -> Reply {
    let user = user_or_401(&headers)?;
    let body = json_body(&body)?;
    update(&services, &user, &query_of(&uri), &body, &id).await
}

/// The update both `PATCH` routes share. A `null` cron expression is left alone, as
/// the source turns it into `undefined`.
async fn update(
    services: &Services,
    user: &str,
    query: &QueryParams,
    body: &Value,
    id: &str,
) -> Reply {
    let repos = services.repos().await;
    let scope = repos.scope(query, user, Some(&scope_body(body)))?;
    let bridge = CronBridge::new(&*services.automation);
    let patch = ReminderPatch {
        title: string_field(body, "title"),
        message: string_field(body, "message"),
        remind_at: string_field(body, "remindAt"),
        cron_expression: string_field(body, "cronExpression").map(Some),
        status: string_field(body, "status"),
    };
    let reminder = MasterRemindersService::with_options(&*repos.master, options(&bridge, services))
        .update(&scope, id, &patch)
        .map_err(bad_request)?;
    cron_failure(&bridge)?;
    let reminder =
        reminder.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Reminder not found"))?;
    Ok(Json(json!({ "ok": true, "reminder": reminder })).into_response())
}

/// `DELETE /api/master/reminders` (`reminders/route.ts:98-118`): the id is in the body.
pub(super) async fn delete_collection(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Reply {
    let user = user_or_401(&headers)?;
    let body = json_body(&body)?;
    let id = filled_field(&body, "reminderId")
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "reminderId is required"))?;
    remove(&services, &user, &query_of(&uri), Some(&body), &id).await
}

/// `DELETE /api/master/reminders/{id}` (`reminders/[id]/route.ts:73-87`). No body.
pub(super) async fn delete_one(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> Reply {
    let user = user_or_401(&headers)?;
    remove(&services, &user, &query_of(&uri), None, &id).await
}

async fn remove(
    services: &Services,
    user: &str,
    query: &QueryParams,
    body: Option<&Value>,
    id: &str,
) -> Reply {
    let repos = services.repos().await;
    let scope = repos.scope(query, user, body.map(scope_body).as_ref())?;
    let bridge = CronBridge::new(&*services.automation);
    let deleted = MasterRemindersService::with_options(&*repos.master, options(&bridge, services))
        .delete(&scope, id)
        .map_err(bad_request)?;
    cron_failure(&bridge)?;
    Ok(Json(json!({ "ok": true, "deleted": deleted })).into_response())
}

/// `POST /api/master/reminders/{id}/fire` (`reminders/[id]/fire/route.ts:20-47`).
pub(super) async fn fire(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
    body: Bytes,
) -> Reply {
    let user = user_or_401(&headers)?;
    let body = json_body(&body)?;
    let repos = services.repos().await;
    let scope = repos.scope(&query_of(&uri), &user, Some(&scope_body(&body)))?;
    let bridge = CronBridge::new(&*services.automation);
    let result = MasterRemindersService::with_options(&*repos.master, options(&bridge, &services))
        .fire(
            &scope,
            &id,
            &FireReminderInput {
                fired_at: string_field(&body, "firedAt"),
                source: string_field(&body, "source"),
                summary: string_field(&body, "summary"),
                automation_rule_id: string_field(&body, "automationRuleId"),
            },
        )
        .map_err(bad_request)?;
    cron_failure(&bridge)?;
    let result =
        result.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Reminder not found"))?;
    Ok(Json(json!({
        "ok": true,
        "reminder": result.reminder,
        "firedAt": result.fired_at,
        "duplicate": result.duplicate,
    }))
    .into_response())
}

#[cfg(test)]
mod tests {
    use axum::http::{Method, StatusCode};
    use serde_json::json;

    use crate::families::master::automation::AutomationRuntimePort;
    use crate::families::master::test_support::{Harness, OWNER, SCOPE};

    const REMIND_AT: &str = "2030-01-01T09:00:00.000Z";

    fn create_body(cron: Option<&str>) -> String {
        let mut body = json!({ "title": "Call", "message": "Ring back", "remindAt": REMIND_AT });
        if let Some(cron) = cron {
            body["cronExpression"] = json!(cron);
        }
        body.to_string()
    }

    #[tokio::test]
    async fn reminder_reads_are_native() {
        let harness = Harness::new();
        let (status, body) = harness
            .send(
                Method::GET,
                &format!("/api/master/reminders{SCOPE}"),
                Some(OWNER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["reminders"], json!([]));

        let (status, body) = harness
            .send(
                Method::GET,
                &format!("/api/master/reminders/nope{SCOPE}"),
                Some(OWNER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Reminder not found");

        let (status, body) = harness
            .send(
                Method::GET,
                &format!("/api/master/reminders{SCOPE}"),
                None,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Unauthorized");
    }

    #[tokio::test]
    async fn a_reminder_without_title_is_refused_before_any_write() {
        let harness = Harness::new();
        let (status, body) = harness
            .send(
                Method::POST,
                &format!("/api/master/reminders{SCOPE}"),
                Some(OWNER),
                Some(r#"{"title":"","message":"m","remindAt":"2030-01-01T00:00:00.000Z"}"#),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "title, message and remindAt are required");
    }

    #[tokio::test]
    async fn a_cron_reminder_writes_its_rule_and_follows_status_and_delete() {
        let harness = Harness::new();
        let (status, body) = harness
            .send(
                Method::POST,
                &format!("/api/master/reminders{SCOPE}"),
                Some(OWNER),
                Some(&create_body(Some("0 9 * * *"))),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED);
        let id = body["reminder"]["id"]
            .as_str()
            .expect("reminder id")
            .to_string();

        // The rule is named after the workspace the scope resolved to, as cronBridge.ts does.
        let workspace = body["reminder"]["workspaceId"]
            .as_str()
            .expect("workspace id");
        let rule_name = format!("master-reminder:{workspace}:{id}");
        let rules = harness
            .services
            .automation
            .list_rules(OWNER)
            .expect("rules");
        let names: Vec<String> = rules.iter().map(|rule| rule.name.clone()).collect();
        let rule = rules
            .iter()
            .find(|rule| rule.name == rule_name)
            .unwrap_or_else(|| panic!("cron rule {rule_name} among {names:?}; create {body}"));
        assert!(rule.enabled);

        let (status, _) = harness
            .send(
                Method::PATCH,
                &format!("/api/master/reminders/{id}{SCOPE}"),
                Some(OWNER),
                Some(r#"{"status":"paused"}"#),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        let rules = harness
            .services
            .automation
            .list_rules(OWNER)
            .expect("rules");
        let rule = rules
            .iter()
            .find(|rule| rule.name == rule_name)
            .expect("rule kept");
        assert!(!rule.enabled, "a paused reminder pauses its rule");

        let (status, body) = harness
            .send(
                Method::DELETE,
                &format!("/api/master/reminders{SCOPE}"),
                Some(OWNER),
                Some(&json!({ "reminderId": id }).to_string()),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deleted"], true);
        let rules = harness
            .services
            .automation
            .list_rules(OWNER)
            .expect("rules");
        assert!(
            rules.iter().all(|rule| rule.name != rule_name),
            "the rule is removed"
        );
    }

    #[tokio::test]
    async fn firing_a_reminder_twice_with_one_timestamp_is_a_duplicate() {
        let harness = Harness::new();
        let (_, created) = harness
            .send(
                Method::POST,
                &format!("/api/master/reminders{SCOPE}"),
                Some(OWNER),
                Some(&create_body(None)),
            )
            .await;
        let id = created["reminder"]["id"]
            .as_str()
            .expect("reminder id")
            .to_string();
        let fire = json!({ "firedAt": "2030-01-01T09:00:01.000Z", "source": "api" }).to_string();

        let (status, first) = harness
            .send(
                Method::POST,
                &format!("/api/master/reminders/{id}/fire{SCOPE}"),
                Some(OWNER),
                Some(&fire),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(first["duplicate"], false);
        assert_eq!(first["reminder"]["status"], "fired");

        let (status, second) = harness
            .send(
                Method::POST,
                &format!("/api/master/reminders/{id}/fire{SCOPE}"),
                Some(OWNER),
                Some(&fire),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(second["duplicate"], true);
    }

    #[tokio::test]
    async fn a_failed_rule_write_answers_400_with_its_message() {
        let harness = Harness::with_automation(std::sync::Arc::new(BrokenAutomation));
        let (status, body) = harness
            .send(
                Method::POST,
                &format!("/api/master/reminders{SCOPE}"),
                Some(OWNER),
                Some(&create_body(Some("0 9 * * *"))),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "cron backend unavailable");
    }

    /// An automation port whose every call fails.
    struct BrokenAutomation;

    impl AutomationRuntimePort for BrokenAutomation {
        fn list_rules(
            &self,
            _user_id: &str,
        ) -> Result<Vec<betaclaw_core::automation::types::AutomationRule>, String> {
            Err("cron backend unavailable".to_string())
        }

        fn create_rule(
            &self,
            _input: &betaclaw_core::automation::types::CreateAutomationRuleInput,
        ) -> Result<betaclaw_core::automation::types::AutomationRule, String> {
            Err("cron backend unavailable".to_string())
        }

        fn update_rule(
            &self,
            _rule_id: &str,
            _user_id: &str,
            _patch: &betaclaw_core::automation::types::UpdateAutomationRuleInput,
        ) -> Result<Option<betaclaw_core::automation::types::AutomationRule>, String> {
            Err("cron backend unavailable".to_string())
        }

        fn delete_rule(&self, _rule_id: &str, _user_id: &str) -> Result<bool, String> {
            Err("cron backend unavailable".to_string())
        }
    }
}
