//! Port of `src/server/stats/xaiPricing.ts`. The price table is data, so this
//! module makes no network call.

use super::ModelPricing;

const TOKENS_PER_MILLION: f64 = 1_000_000.0;

/// `(model, prompt USD per 1M tokens, completion USD per 1M tokens)`.
const PRICES_PER_MILLION_USD: &[(&str, f64, f64)] = &[
    ("grok-4-1-fast-reasoning", 0.2, 0.5),
    ("grok-4-1-fast-non-reasoning", 0.2, 0.5),
    ("grok-code-fast-1", 0.2, 1.5),
    ("grok-4-fast-reasoning", 0.2, 0.5),
    ("grok-4-fast-non-reasoning", 0.2, 0.5),
    ("grok-4-0709", 3.0, 15.0),
    ("grok-3-mini", 0.3, 0.5),
    ("grok-3", 3.0, 15.0),
    ("grok-2-vision-1212", 2.0, 10.0),
];

const MODEL_ALIASES: &[(&str, &str)] = &[("grok-4", "grok-4-0709")];

/// Trims, lowercases, strips the `x-ai/` prefix and follows the alias. Returns
/// the canonical table key, or `None` when the model is not priced.
fn resolve_model_name(model_name: &str) -> Option<&'static str> {
    let normalized = model_name.trim().to_lowercase();
    let unprefixed = normalized
        .strip_prefix("x-ai/")
        .unwrap_or(normalized.as_str());
    let canonical = MODEL_ALIASES
        .iter()
        .find(|(alias, _)| *alias == unprefixed)
        .map_or(unprefixed, |(_, target)| *target);
    PRICES_PER_MILLION_USD
        .iter()
        .find(|(name, _, _)| *name == canonical)
        .map(|(name, _, _)| *name)
}

/// Per-token pricing of an xAI model; `None` when the model is not in the table.
pub fn get_xai_model_pricing(model_name: &str) -> Option<ModelPricing> {
    let resolved = resolve_model_name(model_name)?;
    let (_, prompt, completion) = PRICES_PER_MILLION_USD
        .iter()
        .find(|(name, _, _)| *name == resolved)?;
    Some(ModelPricing {
        prompt_price_per_token_usd: (prompt / TOKENS_PER_MILLION).max(0.0),
        completion_price_per_token_usd: (completion / TOKENS_PER_MILLION).max(0.0),
        request_price_usd: 0.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_are_converted_from_per_million() {
        let pricing = get_xai_model_pricing("grok-3").expect("grok-3 is priced");
        assert!((pricing.prompt_price_per_token_usd - 3.0e-6).abs() < 1e-18);
        assert!((pricing.completion_price_per_token_usd - 15.0e-6).abs() < 1e-18);
        assert_eq!(pricing.request_price_usd, 0.0);
    }

    #[test]
    fn alias_and_prefix_resolve_to_the_canonical_model() {
        let alias = get_xai_model_pricing("grok-4").expect("alias resolves");
        assert!((alias.prompt_price_per_token_usd - 3.0e-6).abs() < 1e-18);
        let prefixed = get_xai_model_pricing("  X-AI/Grok-3-mini ").expect("prefix resolves");
        assert!((prefixed.completion_price_per_token_usd - 0.5e-6).abs() < 1e-18);
    }

    #[test]
    fn unknown_and_empty_models_have_no_price() {
        assert!(get_xai_model_pricing("gpt-4").is_none());
        assert!(get_xai_model_pricing("").is_none());
        // The TypeScript table is a plain object, so `constructor` looked up a
        // prototype member and produced NaN prices. The port returns no price.
        assert!(get_xai_model_pricing("constructor").is_none());
    }
}
