//! Port of `src/server/gateway/methods/sessions.ts` (S8): `sessions.delete`,
//! `sessions.reset` and `sessions.patch`.

use serde_json::{json, Value};

use crate::gateway::events::{CONVERSATION_DELETED, CONVERSATION_RESET};

use super::helpers::{emit_inbox_updated, required_raw, HandlerError};
use super::ports::{EventSink, MessageService};

/// `ChannelType.WEBCHAT` in `src/shared/domain/types.ts`.
const WEBCHAT_CHANNEL_TYPE: &str = "WebChat";

/// `sessions.delete`: deletes a conversation with all of its messages. The
/// events go out only when something was deleted.
pub fn delete(
    service: &dyn MessageService,
    events: &dyn EventSink,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let conversation_id = required_raw(params, "conversationId")?;
    let deleted = service.delete_conversation(&conversation_id, user_id)?;
    if deleted {
        events.broadcast_to_user(
            user_id,
            CONVERSATION_DELETED,
            json!({ "conversationId": conversation_id }),
        );
        emit_inbox_updated(events, user_id, "delete", &conversation_id, None);
    }
    Ok(json!({ "deleted": deleted }))
}

/// `sessions.reset`: opens a fresh WebChat conversation and announces it.
pub fn reset(
    service: &dyn MessageService,
    events: &dyn EventSink,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let title = params.get("title").and_then(Value::as_str);
    let external_id = format!("manual-{user_id}-{}", chrono::Utc::now().timestamp_millis());
    let conversation =
        service.get_or_create_conversation(WEBCHAT_CHANNEL_TYPE, &external_id, title, user_id)?;

    events.broadcast_to_user(
        user_id,
        CONVERSATION_RESET,
        json!({ "oldConversationId": null, "newConversationId": conversation.id }),
    );
    let item = json!({
        "conversationId": conversation.id,
        "channelType": conversation.channel_type,
        "title": conversation.title,
        "updatedAt": conversation.updated_at,
        "lastMessage": null,
    });
    emit_inbox_updated(events, user_id, "upsert", &conversation.id, Some(item));

    Ok(json!({ "conversationId": conversation.id }))
}

/// `sessions.patch`: sets or clears the model override. An empty value clears it.
pub fn patch(
    service: &dyn MessageService,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let conversation_id = required_raw(params, "conversationId")?;
    if let Some(raw) = params.get("modelOverride") {
        // `(params.modelOverride as string) || null`
        let model_override = raw.as_str().filter(|model| !model.is_empty());
        service.set_model_override(&conversation_id, model_override, user_id)?;
    }
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::super::test_support::Fake;
    use super::*;
    use crate::gateway::events::INBOX_UPDATED;

    #[test]
    fn delete_announces_only_a_real_deletion() {
        let fake = Fake::default();
        fake.state.lock().unwrap().delete_result = true;
        let payload = delete(&fake, &fake, "u1", &json!({"conversationId": "c1"})).unwrap();
        assert_eq!(payload, json!({"deleted": true}));
        {
            let state = fake.state.lock().unwrap();
            assert_eq!(state.broadcasts[0].1, CONVERSATION_DELETED);
            assert_eq!(state.broadcasts[0].2, json!({"conversationId": "c1"}));
            assert_eq!(state.broadcasts[1].1, INBOX_UPDATED);
            assert_eq!(state.broadcasts[1].2["action"], "delete");
            assert_eq!(state.broadcasts[1].2["item"], Value::Null);
        }

        fake.state.lock().unwrap().delete_result = false;
        let payload = delete(&fake, &fake, "u1", &json!({"conversationId": "c1"})).unwrap();
        assert_eq!(payload, json!({"deleted": false}));
        assert_eq!(fake.state.lock().unwrap().broadcasts.len(), 2);
    }

    #[test]
    fn delete_requires_a_conversation_id() {
        let fake = Fake::default();
        let err = delete(&fake, &fake, "u1", &json!({})).unwrap_err();
        assert_eq!(err, HandlerError::plain("conversationId is required"));
    }

    #[test]
    fn reset_opens_a_webchat_conversation_and_announces_it() {
        let fake = Fake::default();
        let payload = reset(&fake, &fake, "u1", &json!({"title": "New"})).unwrap();
        assert_eq!(payload, json!({"conversationId": "c-new"}));

        let state = fake.state.lock().unwrap();
        let (channel, external, title) = state.created[0].clone();
        assert_eq!(channel, "WebChat");
        assert!(external.starts_with("manual-u1-"));
        assert_eq!(title.as_deref(), Some("New"));
        assert_eq!(state.broadcasts[0].1, CONVERSATION_RESET);
        assert_eq!(
            state.broadcasts[0].2,
            json!({"oldConversationId": null, "newConversationId": "c-new"})
        );
        assert_eq!(state.broadcasts[1].2["action"], "upsert");
        assert_eq!(state.broadcasts[1].2["item"]["channelType"], "WebChat");
        assert_eq!(state.broadcasts[1].2["item"]["lastMessage"], Value::Null);
    }

    #[test]
    fn patch_treats_an_empty_override_as_a_clear_and_skips_an_absent_key() {
        let fake = Fake::default();
        let ok = json!({"ok": true});
        assert_eq!(
            patch(
                &fake,
                "u1",
                &json!({"conversationId": "c1", "modelOverride": ""})
            )
            .unwrap(),
            ok
        );
        patch(
            &fake,
            "u1",
            &json!({"conversationId": "c1", "modelOverride": "gpt"}),
        )
        .unwrap();
        patch(&fake, "u1", &json!({"conversationId": "c1"})).unwrap();
        assert_eq!(
            fake.state.lock().unwrap().model_overrides,
            vec![
                ("c1".to_string(), None),
                ("c1".to_string(), Some("gpt".to_string())),
            ]
        );
    }
}
