use rustc_hash::FxHashMap;

use super::options::{ColorsRendering, DefaultColor, ThemedToken, ThemedTokenWithVariants, TokenStyles, apply_color_replacement};
use super::tokenize::plain_token;
use crate::error::ShikiError;
use crate::theme::ResolvedTheme;

/// Aligns token boundaries across multiple theme tokenizations of the same code,
/// matching Shiki's `alignThemesTokenization`.
pub fn align_themes_tokenization(themes: &[Vec<Vec<ThemedToken>>]) -> Vec<Vec<Vec<ThemedToken>>> {
    let count = themes.len();
    if count == 0 {
        return Vec::new();
    }
    let line_count = themes[0].len();
    let mut out: Vec<Vec<Vec<ThemedToken>>> = (0..count).map(|_| Vec::with_capacity(line_count)).collect();

    for line_idx in 0..line_count {
        let mut out_lines: Vec<Vec<ThemedToken>> = (0..count).map(|_| Vec::new()).collect();
        let mut indexes = vec![0usize; count];
        let mut current: Vec<Option<ThemedToken>> = themes.iter().map(|t| t[line_idx].first().cloned()).collect();

        while current.iter().all(Option::is_some) {
            let min_len = current.iter().map(|t| t.as_ref().unwrap().content.len()).min().unwrap_or(0);
            if min_len == 0 {
                // Consume empty tokens cleanly to avoid spinning.
                for n in 0..count {
                    let tok = current[n].take().unwrap();
                    if tok.content.is_empty() {
                        out_lines[n].push(tok);
                        indexes[n] += 1;
                        current[n] = themes[n][line_idx].get(indexes[n]).cloned();
                    } else {
                        current[n] = Some(tok);
                    }
                }
                continue;
            }

            for n in 0..count {
                let tok = current[n].take().unwrap();
                if tok.content.len() == min_len {
                    out_lines[n].push(tok);
                    indexes[n] += 1;
                    current[n] = themes[n][line_idx].get(indexes[n]).cloned();
                } else {
                    let head = ThemedToken {
                        content: tok.content[..min_len].to_string(),
                        ..tok.clone()
                    };
                    let tail = ThemedToken {
                        content: tok.content[min_len..].to_string(),
                        offset: tok.offset + min_len,
                        ..tok
                    };
                    out_lines[n].push(head);
                    current[n] = Some(tail);
                }
            }
        }

        for n in 0..count {
            out[n].push(std::mem::take(&mut out_lines[n]));
        }
    }

    out
}

/// Flattens a multi-theme aligned token into a single [`ThemedToken`] with CSS variables
/// (or `light-dark()`), matching Shiki's `flatTokenVariants`.
pub fn flat_token_variants(
    merged: &ThemedTokenWithVariants,
    variants_order: &[String],
    css_variable_prefix: &str,
    default_color: &DefaultColor,
    colors_rendering: ColorsRendering,
) -> ThemedToken {
    let styles_per_variant: Vec<Vec<(String, String)>> = variants_order
        .iter()
        .map(|key| merged.variant(key).map(token_style_entries).unwrap_or_default())
        .collect();

    // Preserve first-seen CSS property key order across variants.
    let mut style_keys: Vec<String> = Vec::new();
    for entries in &styles_per_variant {
        for (k, _) in entries {
            if !style_keys.contains(k) {
                style_keys.push(k.clone());
            }
        }
    }

    let lookup_val = |entries: &[(String, String)], key: &str| -> String {
        entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .unwrap_or_else(|| "inherit".to_string())
    };

    let var_key = |idx: usize, key: &str| -> String {
        let suffix = match key {
            "color" => String::new(),
            "background-color" => "-bg".to_string(),
            other => format!("-{other}"),
        };
        format!("{css_variable_prefix}{}{suffix}", variants_order[idx])
    };

    let mut merged_styles: Vec<(String, String)> = Vec::new();

    for (idx, cur) in styles_per_variant.iter().enumerate() {
        for key in &style_keys {
            let value = lookup_val(cur, key);
            let is_color_key = matches!(key.as_str(), "color" | "background-color" | "font-style" | "font-weight" | "text-decoration");

            if idx == 0 && *default_color != DefaultColor::None && is_color_key {
                if *default_color == DefaultColor::LightDark && styles_per_variant.len() > 1 {
                    let light_idx = variants_order.iter().position(|k| k == "light").unwrap_or(0);
                    let dark_idx = variants_order.iter().position(|k| k == "dark").unwrap_or(1);
                    let light_val = lookup_val(&styles_per_variant[light_idx], key);
                    let dark_val = lookup_val(&styles_per_variant[dark_idx], key);
                    set_style_entry(&mut merged_styles, key.clone(), format!("light-dark({light_val}, {dark_val})"));
                    if colors_rendering == ColorsRendering::CssVars {
                        set_style_entry(&mut merged_styles, var_key(idx, key), value);
                    }
                } else {
                    set_style_entry(&mut merged_styles, key.clone(), value);
                }
            } else if colors_rendering == ColorsRendering::CssVars {
                set_style_entry(&mut merged_styles, var_key(idx, key), value);
            }
        }
    }

    ThemedToken {
        content: merged.content.clone(),
        offset: merged.offset,
        color: None,
        bg_color: None,
        font_style: None,
        token_type: None,
        html_style: Some(merged_styles),
        explanation: merged.explanation.clone(),
    }
}

fn set_style_entry(entries: &mut Vec<(String, String)>, key: String, val: String) {
    if let Some((_, existing)) = entries.iter_mut().find(|(k, _)| *k == key) {
        *existing = val;
    } else {
        entries.push((key, val));
    }
}

pub(super) fn map_theme_colors(
    variants_order: &[String],
    resolved: &[Option<ResolvedTheme>],
    replacements: &[FxHashMap<String, String>],
    css_variable_prefix: &str,
    default_color: &DefaultColor,
    is_bg: bool,
    colors_rendering: ColorsRendering,
) -> Result<String, ShikiError> {
    let get_val = |idx: usize| -> String {
        resolved[idx]
            .as_ref()
            .and_then(|t| {
                let raw = if is_bg { &t.bg } else { &t.fg };
                apply_color_replacement(Some(raw), &replacements[idx])
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "inherit".to_string())
    };

    let mut parts = Vec::new();
    for (idx, variant) in variants_order.iter().enumerate() {
        let value = get_val(idx);
        let suffix = if is_bg { "-bg" } else { "" };
        let css_var = format!("{css_variable_prefix}{variant}{suffix}:{value}");

        if idx == 0 && *default_color != DefaultColor::None {
            if *default_color == DefaultColor::LightDark && variants_order.len() > 1 {
                let light_idx = variants_order.iter().position(|k| k == "light").ok_or_else(|| {
                    ShikiError::InvalidOptions("When using `defaultColor: \"light-dark()\"`, you must provide both `light` and `dark` themes".to_string())
                })?;
                let dark_idx = variants_order.iter().position(|k| k == "dark").ok_or_else(|| {
                    ShikiError::InvalidOptions("When using `defaultColor: \"light-dark()\"`, you must provide both `light` and `dark` themes".to_string())
                })?;
                let light_val = get_val(light_idx);
                let dark_val = get_val(dark_idx);
                parts.push(format!("light-dark({light_val}, {dark_val});{css_var}"));
            } else {
                parts.push(value);
            }
        } else if colors_rendering == ColorsRendering::CssVars {
            parts.push(css_var);
        }
    }

    Ok(parts.join(";"))
}

/// Converts a token's foreground/background/fontStyle into ordered CSS property pairs.
pub fn token_style_entries(styles: &TokenStyles) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Some(color) = &styles.color
        && !color.is_empty()
    {
        out.push(("color".to_string(), color.clone()));
    }
    if let Some(bg) = &styles.bg_color
        && !bg.is_empty()
    {
        out.push(("background-color".to_string(), bg.clone()));
    }
    if let Some(fs) = styles.font_style
        && !fs.is_not_set()
    {
        if fs.is_italic() {
            out.push(("font-style".to_string(), "italic".to_string()));
        }
        if fs.is_bold() {
            out.push(("font-weight".to_string(), "bold".to_string()));
        }
        let mut decorations = Vec::new();
        if fs.is_underline() {
            decorations.push("underline");
        }
        if fs.is_strikethrough() {
            decorations.push("line-through");
        }
        if !decorations.is_empty() {
            out.push(("text-decoration".to_string(), decorations.join(" ")));
        }
    }
    out
}

pub(super) fn stringify_token_style(token: &ThemedToken) -> String {
    let owned;
    let entries: &[(String, String)] = if let Some(html_style) = &token.html_style {
        html_style.as_slice()
    } else {
        owned = token_style_entries(&TokenStyles {
            color: token.color.clone(),
            bg_color: token.bg_color.clone(),
            font_style: token.font_style,
        });
        &owned
    };
    entries.iter().map(|(k, v)| format!("{k}:{v}")).collect::<Vec<_>>().join(";")
}

fn is_decorated(token: &ThemedToken) -> bool {
    token.font_style.is_some_and(|fs| fs.is_underline() || fs.is_strikethrough())
}

fn is_whitespace_only(s: &str) -> bool {
    !s.is_empty() && s.chars().all(char::is_whitespace)
}

pub(super) fn merge_whitespace_tokens(tokens: Vec<Vec<ThemedToken>>) -> Vec<Vec<ThemedToken>> {
    tokens
        .into_iter()
        .map(|line| {
            let len = line.len();
            let mut new_line = Vec::with_capacity(len);
            let mut carry = String::new();
            let mut first_offset: Option<usize> = None;

            for (idx, mut token) in line.into_iter().enumerate() {
                let could_merge = !is_decorated(&token);
                if could_merge && is_whitespace_only(&token.content) && idx + 1 < len {
                    if first_offset.is_none() {
                        first_offset = Some(token.offset);
                    }
                    carry.push_str(&token.content);
                } else if !carry.is_empty() {
                    let carried = std::mem::take(&mut carry);
                    let carried_offset = first_offset.take().unwrap_or(token.offset);
                    if could_merge {
                        token.content = format!("{carried}{}", token.content);
                        token.offset = carried_offset;
                        new_line.push(token);
                    } else {
                        new_line.push(plain_token(&carried, carried_offset));
                        new_line.push(token);
                    }
                } else {
                    new_line.push(token);
                }
            }
            new_line
        })
        .collect()
}

pub(super) fn split_whitespace_tokens(tokens: Vec<Vec<ThemedToken>>) -> Vec<Vec<ThemedToken>> {
    tokens
        .into_iter()
        .map(|line| {
            let mut out = Vec::with_capacity(line.len());
            for token in line {
                if is_whitespace_only(&token.content) {
                    out.push(token);
                    continue;
                }
                let trimmed_start = token.content.trim_start();
                let leading_len = token.content.len() - trimmed_start.len();
                let trimmed = trimmed_start.trim_end();
                let trailing_len = trimmed_start.len() - trimmed.len();
                if leading_len == 0 && trailing_len == 0 {
                    out.push(token);
                    continue;
                }
                if leading_len > 0 {
                    out.push(plain_token(&token.content[..leading_len], token.offset));
                }
                out.push(ThemedToken {
                    content: trimmed.to_string(),
                    offset: token.offset + leading_len,
                    ..token.clone()
                });
                if trailing_len > 0 {
                    let trailing_start = leading_len + trimmed.len();
                    out.push(plain_token(&token.content[trailing_start..], token.offset + trailing_start));
                }
            }
            out
        })
        .collect()
}

pub(super) fn merge_adjacent_styled_tokens(tokens: Vec<Vec<ThemedToken>>) -> Vec<Vec<ThemedToken>> {
    tokens
        .into_iter()
        .map(|line| {
            let mut out: Vec<ThemedToken> = Vec::with_capacity(line.len());
            for token in line {
                if let Some(prev) = out.last_mut()
                    && !is_decorated(prev)
                    && !is_decorated(&token)
                    && stringify_token_style(prev) == stringify_token_style(&token)
                {
                    prev.content.push_str(&token.content);
                    continue;
                }
                out.push(token);
            }
            out
        })
        .collect()
}
