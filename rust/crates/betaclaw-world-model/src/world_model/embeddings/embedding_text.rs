//! Port of `src/server/world-model/embeddings/embeddingText.ts:1-33`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbeddingTargetType {
    Assertion,
    Event,
    Task,
    Entity,
    Episode,
    Memory,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddingText {
    pub text: String,
    pub text_hash: String,
    pub projection_version: String,
}

pub fn build_embedding_text(
    _target_type: EmbeddingTargetType,
    content: &[String],
    projection_version: Option<&str>,
) -> EmbeddingText {
    let text = content
        .iter()
        .filter(|part| !part.is_empty() && !part.trim().is_empty())
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_owned();
    EmbeddingText {
        text_hash: hash_text(&text),
        text,
        projection_version: projection_version.unwrap_or("v1").to_owned(),
    }
}

/// JavaScript iterates UTF-16 code units here; `encode_utf16` preserves that hash.
pub fn hash_text(text: &str) -> String {
    let hash = text.encode_utf16().fold(0_i32, |hash, unit| {
        hash.wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(i32::from(unit))
    }) as u32;
    base36(hash)
}

fn base36(mut value: u32) -> String {
    if value == 0 {
        return "0".to_owned();
    }
    let mut digits = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        digits.push(if digit < 10 {
            b'0' + digit
        } else {
            b'a' + digit - 10
        });
        value /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).expect("base36 digits are ASCII")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_filters_blank_parts_and_defaults_version() {
        let result = build_embedding_text(
            EmbeddingTargetType::Assertion,
            &[
                " Mira ".into(),
                "".into(),
                "  ".into(),
                "goes cinema".into(),
            ],
            None,
        );
        assert_eq!(result.text, "Mira  goes cinema");
        assert_eq!(result.projection_version, "v1");
        assert_eq!(result.text_hash, hash_text("Mira  goes cinema"));
    }

    #[test]
    fn hash_uses_unsigned_base36_of_wrapping_utf16_hash() {
        assert_eq!(hash_text(""), "0");
        assert_eq!(hash_text("a"), "2p");
    }
}
