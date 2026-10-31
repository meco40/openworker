//! Port of `src/server/knowledge/ingestion/emotionTracker.ts` (1-21).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `EmotionDetectionResult` (`:4`, alias of `EmotionalState`) | [`EmotionalState`] |
//! | `detectDominantEmotion` (`:9-20`) | [`detect_dominant_emotion`] |
//! | re-exports `detectEmotion`, `EmotionalState` (`:23-26`) | [`detect_emotion`], [`EmotionalState`] |

use crate::knowledge::ingestion_cursor::IngestionWindow;

pub use crate::knowledge::emotion_tracker::{detect_emotion, EmotionalState};

/// `export type EmotionDetectionResult = EmotionalState` (`emotionTracker.ts:4`).
pub type EmotionDetectionResult = EmotionalState;

/// `detectDominantEmotion(window)` (`emotionTracker.ts:9-20`): the most intense
/// emotion of any message in the window. A later message only replaces the
/// current pick when it is strictly more intense.
pub fn detect_dominant_emotion(window: &IngestionWindow) -> Option<EmotionalState> {
    let mut dominant: Option<EmotionalState> = None;
    for message in &window.messages {
        let Some(detected) = detect_emotion(&message.content) else {
            continue;
        };
        let replace = match &dominant {
            None => true,
            Some(current) => detected.intensity > current.intensity,
        };
        if replace {
            dominant = Some(detected);
        }
    }
    dominant
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages_store::StoredMessage;

    fn message(content: &str) -> StoredMessage {
        StoredMessage {
            id: content.to_string(),
            conversation_id: "c".into(),
            seq: Some(1),
            role: "user".into(),
            content: content.into(),
            platform: "web".into(),
            external_msg_id: None,
            sender_name: None,
            metadata: None,
            created_at: String::new(),
        }
    }

    fn window(messages: Vec<StoredMessage>) -> IngestionWindow {
        IngestionWindow {
            conversation_id: "c".into(),
            user_id: "u".into(),
            persona_id: "p".into(),
            workspace_id: None,
            from_seq_exclusive: 0,
            to_seq_inclusive: 1,
            messages,
        }
    }

    #[test]
    fn a_window_without_emotion_has_no_dominant_emotion() {
        assert_eq!(
            detect_dominant_emotion(&window(vec![message("Der Bus fährt um acht")])),
            None
        );
    }

    #[test]
    fn the_dominant_emotion_is_the_first_of_the_highest_intensity() {
        let messages = vec![
            message("ich bin traurig"),
            message("ich bin traurig"),
            message("Kaffee"),
        ];
        let dominant = detect_dominant_emotion(&window(messages.clone())).expect("emotion");
        let first = detect_emotion(&messages[0].content).expect("emotion");
        assert_eq!(dominant, first);
    }
}
