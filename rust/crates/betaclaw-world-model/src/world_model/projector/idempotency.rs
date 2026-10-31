//! Port of `src/server/world-model/projector/idempotency.ts:1-38`.

use sha2::{Digest, Sha256};

use crate::world_model::scope::WorldModelScope;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdempotencyParts<'a> {
    pub scope: &'a WorldModelScope,
    pub source_message_seq: i64,
    pub kind: &'a str,
    pub content: &'a str,
}

/// `deriveArtifactKey` — `idempotency.ts:17-31`.
pub fn derive_artifact_key(parts: &IdempotencyParts<'_>) -> String {
    let scope = parts.scope.parts();
    let source = format!(
        "{}|{}|{}|{}|{}|{}",
        scope.user_id,
        scope.persona_id,
        scope.workspace_id,
        parts.kind,
        parts.source_message_seq,
        parts.content
    );
    let digest = Sha256::digest(source.as_bytes());
    hex_prefix(&digest, 32)
}

/// `stableDedupKey` — `idempotency.ts:33-35`.
pub fn stable_dedup_key(parts: &IdempotencyParts<'_>, seed: &str) -> String {
    let content = format!("{seed}:{}", parts.content);
    let key = derive_artifact_key(&IdempotencyParts {
        scope: parts.scope,
        source_message_seq: parts.source_message_seq,
        kind: parts.kind,
        content: &content,
    });
    format!("projected:{key}")
}

/// `textFingerprint` — `idempotency.ts:37-43`.
pub fn text_fingerprint(text: &str) -> String {
    let normalized = text.trim().to_lowercase();
    let digest = sha1(normalized.as_bytes());
    hex_prefix(&digest, 16)
}

fn hex_prefix(bytes: &[u8], digits: usize) -> String {
    let mut output = String::with_capacity(digits);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(output, "{byte:02x}");
        if output.len() >= digits {
            output.truncate(digits);
            break;
        }
    }
    output
}

// The workspace does not carry a SHA-1 crate; the persisted key contract does.
fn sha1(input: &[u8]) -> [u8; 20] {
    let mut message = input.to_vec();
    let bit_len = (message.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    let mut h = [
        0x6745_2301_u32,
        0xefcd_ab89,
        0x98ba_dcfe,
        0x1032_5476,
        0xc3d2_e1f0,
    ];
    for chunk in message.chunks_exact(64) {
        let mut words = [0_u32; 80];
        for (index, bytes) in chunk.chunks_exact(4).enumerate() {
            words[index] = u32::from_be_bytes(bytes.try_into().expect("four bytes"));
        }
        for index in 16..80 {
            words[index] =
                (words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16])
                    .rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (index, word) in words.into_iter().enumerate() {
            let (f, k) = match index {
                0..=19 => ((b & c) | ((!b) & d), 0x5a82_7999),
                20..=39 => (b ^ c ^ d, 0x6ed9_eba1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1b_bcdc),
                _ => (b ^ c ^ d, 0xca62_c1d6),
            };
            let next = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = next;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut digest = [0_u8; 20];
    for (chunk, value) in digest.chunks_exact_mut(4).zip(h) {
        chunk.copy_from_slice(&value.to_be_bytes());
    }
    digest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_match_sha1_over_trimmed_lowercase_utf8() {
        assert_eq!(text_fingerprint(""), "da39a3ee5e6b4b0d");
        assert_eq!(text_fingerprint("  Hello  "), "aaf4c61ddcc5e8a2");
        assert_eq!(text_fingerprint("HELLO"), text_fingerprint("hello"));
    }

    #[test]
    fn artifact_keys_are_stable_and_scope_bound() {
        let scope = WorldModelScope::new("u1", "p1", Some("w1".into()));
        let parts = IdempotencyParts {
            scope: &scope,
            source_message_seq: 7,
            kind: "event",
            content: "Film",
        };
        let key = derive_artifact_key(&parts);
        assert_eq!(key.len(), 32);
        assert_eq!(key, derive_artifact_key(&parts));
        assert_eq!(
            stable_dedup_key(&parts, "seed"),
            format!(
                "projected:{}",
                derive_artifact_key(&IdempotencyParts {
                    content: "seed:Film",
                    ..parts.clone()
                })
            )
        );
        let other = WorldModelScope::new("u2", "p1", Some("w1".into()));
        assert_ne!(
            key,
            derive_artifact_key(&IdempotencyParts {
                scope: &other,
                ..parts
            })
        );
    }
}
