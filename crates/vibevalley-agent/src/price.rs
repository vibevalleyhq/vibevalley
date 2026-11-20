//! What a run costs: DeepSeek's models in US dollars per million tokens,
//! cache hits billed at the cache price.

use crate::model::Usage;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
}

pub const DEFAULT_MODEL: &str = "deepseek-flash";

pub fn deepseek_price(model: &str) -> Option<Price> {
    let model = model.strip_prefix("deepseek-official/").unwrap_or(model);
    match if model.is_empty() { DEFAULT_MODEL } else { model } {
        "deepseek-flash" => Some(Price {
            input: 0.14,
            output: 0.28,
            cache_read: 0.028,
        }),
        "deepseek-v4-pro" => Some(Price {
            input: 1.74,
            output: 3.48,
            cache_read: 0.145,
        }),
        _ => None,
    }
}

/// US dollars for `usage`; cache hits are part of `usage.input`.
pub fn charge_usd(price: Price, usage: Usage) -> f64 {
    let fresh = usage.input.saturating_sub(usage.cache_read) as f64;
    (fresh * price.input + usage.output as f64 * price.output + usage.cache_read as f64 * price.cache_read) / 1_000_000.0
}
