use crate::agent::ai::types::Usage;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelSpec {
    pub id: &'static str,
    pub display_name: &'static str,
    pub context_window: usize,
    pub effort_levels: &'static [&'static str],
    pub price: Price,
    pub is_default: bool,
}

pub const DEFAULT_MODEL: &str = "deepseek-flash";

const CATALOG: [ModelSpec; 4] = [
    ModelSpec {
        id: "deepseek-flash",
        display_name: "DeepSeek Flash",
        context_window: 128_000,
        effort_levels: &["high", "max"],
        price: Price {
            input: 0.14,
            output: 0.28,
            cache_read: 0.028,
        },
        is_default: true,
    },
    ModelSpec {
        id: "deepseek-v4-pro",
        display_name: "DeepSeek V4 Pro",
        context_window: 128_000,
        effort_levels: &["high", "max"],
        price: Price {
            input: 1.74,
            output: 3.48,
            cache_read: 0.145,
        },
        is_default: false,
    },
    ModelSpec {
        id: "deepseek-chat",
        display_name: "DeepSeek Chat",
        context_window: 128_000,
        effort_levels: &[],
        price: Price {
            input: 0.14,
            output: 0.28,
            cache_read: 0.028,
        },
        is_default: false,
    },
    ModelSpec {
        id: "deepseek-reasoner",
        display_name: "DeepSeek Reasoner",
        context_window: 128_000,
        effort_levels: &[],
        price: Price {
            input: 0.55,
            output: 2.19,
            cache_read: 0.14,
        },
        is_default: false,
    },
];

pub fn catalog() -> &'static [ModelSpec] {
    &CATALOG
}

pub fn find_model(id: &str) -> Option<&'static ModelSpec> {
    let id = id.strip_prefix("deepseek-official/").unwrap_or(id);
    let id = if id.is_empty() { DEFAULT_MODEL } else { id };
    CATALOG.iter().find(|spec| spec.id == id)
}

pub fn deepseek_price(model: &str) -> Option<Price> {
    find_model(model).map(|spec| spec.price)
}

/// US dollars for `usage`; cache hits are part of `usage.input`.
pub fn charge_usd(price: Price, usage: Usage) -> f64 {
    let fresh = usage.input.saturating_sub(usage.cache_read) as f64;
    (fresh * price.input + usage.output as f64 * price.output + usage.cache_read as f64 * price.cache_read) / 1_000_000.0
}
