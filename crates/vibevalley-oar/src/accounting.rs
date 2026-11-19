use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Default, Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub reasoning_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_micros: Option<u64>,
}

fn count(v: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|k| v.get(k)?.as_u64())
}
fn cost(v: &Value) -> Option<u64> {
    v["costMicros"].as_u64().or_else(|| {
        ["costUSD", "cost_usd", "total_cost_usd"]
            .iter()
            .find_map(|key| v.get(key)?.as_f64().map(|s| (s * 1_000_000.0).round() as u64))
    })
}
impl TokenTotals {
    fn parse(v: &Value) -> Option<Self> {
        let v = v.get("total").or_else(|| v.get("usage")).unwrap_or(v);
        Some(Self {
            input_tokens: count(v, &["inputTokens", "input_tokens"])?,
            output_tokens: count(v, &["outputTokens", "output_tokens"])?,
            cache_read_tokens: count(
                v,
                &[
                    "cachedInputTokens",
                    "cacheReadInputTokens",
                    "cacheReadTokens",
                    "cacheRead",
                    "cache_read_input_tokens",
                ],
            )
            .unwrap_or(0),
            cache_write_tokens: count(
                v,
                &["cacheCreationInputTokens", "cacheWriteTokens", "cacheWrite", "cache_creation_input_tokens"],
            )
            .unwrap_or(0),
            reasoning_tokens: count(
                v,
                &[
                    "reasoningOutputTokens",
                    "reasoningTokens",
                    "reasoning",
                    "reasoning_output_tokens",
                    "reasoning_tokens",
                ],
            )
            .unwrap_or(0),
            cost_micros: cost(v),
        })
    }
    fn add(self, b: Self) -> Self {
        Self {
            input_tokens: self.input_tokens.saturating_add(b.input_tokens),
            output_tokens: self.output_tokens.saturating_add(b.output_tokens),
            cache_read_tokens: self.cache_read_tokens.saturating_add(b.cache_read_tokens),
            cache_write_tokens: self.cache_write_tokens.saturating_add(b.cache_write_tokens),
            reasoning_tokens: self.reasoning_tokens.saturating_add(b.reasoning_tokens),
            cost_micros: match (self.cost_micros, b.cost_micros) {
                (Some(a), Some(b)) => Some(a.saturating_add(b)),
                (None, c) if self == Self::default() => c,
                (c, None) if b == Self::default() => c,
                _ => None,
            },
        }
    }
    pub(crate) fn subtract(self, b: Self) -> Self {
        Self {
            input_tokens: self.input_tokens.saturating_sub(b.input_tokens),
            output_tokens: self.output_tokens.saturating_sub(b.output_tokens),
            cache_read_tokens: self.cache_read_tokens.saturating_sub(b.cache_read_tokens),
            cache_write_tokens: self.cache_write_tokens.saturating_sub(b.cache_write_tokens),
            reasoning_tokens: self.reasoning_tokens.saturating_sub(b.reasoning_tokens),
            cost_micros: self.cost_micros.zip(b.cost_micros).map(|(a, b)| a.saturating_sub(b)),
        }
    }
    pub(crate) fn native(self) -> crate::Usage {
        crate::Usage {
            input_tokens: Some(self.input_tokens),
            output_tokens: Some(self.output_tokens),
            cost_usd: self.cost_micros.map(|n| n as f64 / 1_000_000.0),
        }
    }
}

#[derive(Default)]
pub(crate) struct Meter {
    pub totals: Option<TokenTotals>,
    pub turn_local: Option<TokenTotals>,
    resumed: bool,
    seen_start: bool,
    base: Option<TokenTotals>,
    models: HashMap<String, TokenTotals>,
    unknown: &'static str,
    last_context: u64,
}

fn by_model(v: &Value) -> Option<&serde_json::Map<String, Value>> {
    ["modelUsage", "model_usage"].iter().find_map(|k| v[*k].as_object().filter(|m| !m.is_empty()))
}

impl Meter {
    pub fn resume(&mut self, reason: &'static str) {
        self.resumed = true;
        self.unknown = reason;
    }
    pub fn baseline(&mut self, v: &Value) {
        if let Some(models) = by_model(v) {
            self.models = models
                .iter()
                .map(|(k, v)| Some((k.clone(), TokenTotals::parse(v)?)))
                .collect::<Option<_>>()
                .unwrap_or_default();
        }
        self.base = TokenTotals::parse(v.get("tokenUsage").unwrap_or(v));
    }
    fn report(&mut self, tokens: Option<TokenTotals>, ctx: Option<(u64, u64)>, reason: &str) -> Value {
        self.totals = tokens;
        if tokens.is_none() {
            self.turn_local = None;
        }
        let mut usage = json!({"tokens":tokens});
        if let Some((used, window)) = ctx.filter(|&(a, b)| a > 0 && b > 0) {
            usage["context"] = json!({"tokens":used,"contextWindow":window,"percent":((used as f64/window as f64)*100.0).min(100.0)});
        }
        if tokens.is_none() && !reason.is_empty() {
            usage["unknownReason"] = json!(reason);
        }
        json!({"kind":"usage","usage":usage})
    }
    pub fn stream(&mut self, runtime: &str, frame: &Value) -> Option<Value> {
        if frame["type"] == "stream_event"
            && frame.pointer("/event/type") == Some(&json!("message_start"))
            && let Some(usage) = frame.pointer("/event/message/usage").and_then(TokenTotals::parse)
        {
            self.last_context = usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
        }
        if frame["type"] == "assistant"
            && let Some(t) = frame.pointer("/message/usage").and_then(TokenTotals::parse)
        {
            self.last_context = t.input_tokens + t.cache_read_tokens + t.output_tokens;
        }
        if frame["type"] != "result" {
            return None;
        }
        let models = by_model(frame);
        let window = models.and_then(|m| m.values().filter_map(|v| count(v, &["contextWindow", "context_window"])).max());
        let ctx = window.map(|w| (self.last_context, w));
        if runtime == "claude" && self.resumed && self.base.is_none() && self.models.is_empty() {
            return Some(self.report(None, ctx, self.unknown));
        }
        let mut tokens = None;
        if let Some(models) = models {
            if self.resumed && self.models.is_empty() {
                return Some(self.report(None, ctx, "cumulative_usage_without_baseline"));
            }
            for (k, v) in models {
                let Some(mut cur) = TokenTotals::parse(v) else {
                    return Some(self.report(None, ctx, "usage_not_reported"));
                };
                if let Some(base) = self.models.get(k) {
                    cur = cur.subtract(*base);
                }
                tokens = Some(tokens.map_or(cur, |sum: TokenTotals| sum.add(cur)));
            }
            if !self.resumed
                && let Some(t) = tokens.as_mut()
            {
                t.cost_micros = t.cost_micros.or_else(|| cost(frame));
            }
        } else if let Some(mut t) = TokenTotals::parse(&frame["usage"]) {
            t.cost_micros = t.cost_micros.or_else(|| cost(frame));
            tokens = match (runtime, self.resumed) {
                ("claude", true) => self.base.map(|b| t.subtract(b)),
                ("claude", false) => Some(t),
                _ => {
                    self.turn_local = Some(t);
                    Some(self.totals.map_or(t, |previous| previous.add(t)))
                }
            };
        }
        Some(self.report(tokens, ctx, if self.resumed { "missing_flat_resume_baseline" } else { "usage_not_reported" }))
    }
    pub fn codex(&mut self, method: &str, params: &Value, root: bool) -> Option<Value> {
        if method == "turn/started" && root {
            self.seen_start = true;
        }
        if method != "thread/tokenUsage/updated" {
            return None;
        }
        let usage = &params["tokenUsage"];
        let totals = TokenTotals::parse(usage);
        let last = &usage["last"];
        let used = count(last, &["inputTokens"]).unwrap_or(0) + count(last, &["cachedInputTokens"]).unwrap_or(0) + count(last, &["outputTokens"]).unwrap_or(0);
        let ctx = usage["modelContextWindow"].as_u64().map(|w| (used, w));
        if !root {
            let mut child = Self::default();
            return Some(child.report(totals, ctx, ""));
        }
        if self.resumed && self.base.is_none() && !self.seen_start && params.get("turnId").and_then(Value::as_str).is_none_or(str::is_empty) {
            self.base = totals;
            return None;
        }
        let result = if self.resumed {
            self.base.zip(totals).map(|(b, t)| t.subtract(b))
        } else {
            totals
        };
        Some(self.report(result, ctx, if self.resumed { "missing_codex_resume_baseline" } else { "" }))
    }
    pub fn acp(&mut self, u: &Value) -> Option<Value> {
        if u["sessionUpdate"] != "usage_update" {
            return None;
        }
        let raw = u.get("usage").or_else(|| u.get("content"))?;
        let t = TokenTotals::parse(raw)?;
        let tokens = if self.resumed {
            None
        } else {
            self.turn_local = Some(self.turn_local.map_or(t, |prev| prev.add(t)));
            Some(self.totals.map_or(t, |previous| previous.add(t)))
        };
        Some(self.report(tokens, None, "acp_resume_baseline_unknown"))
    }
}
