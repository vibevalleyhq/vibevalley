//! Design-system token parser, alias resolver, CSS custom property compiler,
//! and WCAG 2.1 contrast helper (`tokens.ts`).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
enum ThemedString {
    Single(String),
    ByTheme(BTreeMap<String, String>),
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ColorTokenInput {
    id: String,
    group: Option<String>,
    note: Option<String>,
    value: ThemedString,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypeFamilyInput {
    id: String,
    value: String,
    note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypeScaleItemInput {
    id: String,
    value: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
enum NumOrString {
    Num(f64),
    Str(String),
}

impl NumOrString {
    fn as_css_string(&self) -> String {
        match self {
            NumOrString::Num(n) => format_js_number(*n),
            NumOrString::Str(s) => s.clone(),
        }
    }
}

fn format_js_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        n.to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypeStyleInput {
    id: String,
    family: String,
    size: String,
    weight: NumOrString,
    line_height: Option<NumOrString>,
    letter_spacing: Option<String>,
    sample: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimpleTokenInput {
    id: String,
    value: ThemedString,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypeSectionInput {
    families: Option<Vec<TypeFamilyInput>>,
    scale: Option<Vec<TypeScaleItemInput>>,
    styles: Option<Vec<TypeStyleInput>>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokensSpecInput {
    themes: Option<Vec<String>>,
    default_theme: Option<String>,
    color: Option<Vec<ColorTokenInput>>,
    r#type: Option<TypeSectionInput>,
    space: Option<Vec<SimpleTokenInput>>,
    radius: Option<Vec<SimpleTokenInput>>,
    shadow: Option<Vec<SimpleTokenInput>>,
    border: Option<Vec<SimpleTokenInput>>,
    motion: Option<Vec<SimpleTokenInput>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedColorSwatch {
    pub id: String,
    pub group: String,
    pub light: String,
    pub dark: String,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedTypeStyle {
    pub id: String,
    pub family: String,
    pub size: String,
    pub weight: String,
    pub line_height: String,
    pub letter_spacing: String,
    pub sample: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFamily {
    pub id: String,
    pub value: String,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedTokenValue {
    pub id: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedTokensSpec {
    pub themes: Vec<String>,
    pub default_theme: String,
    pub colors: Vec<ParsedColorSwatch>,
    pub families: Vec<ParsedFamily>,
    pub scale: Vec<ParsedTokenValue>,
    pub styles: Vec<ParsedTypeStyle>,
    pub space: Vec<ParsedTokenValue>,
    pub radius: Vec<ParsedTokenValue>,
    pub css: String,
}

fn empty_spec() -> ParsedTokensSpec {
    ParsedTokensSpec {
        themes: vec!["light".to_string(), "dark".to_string()],
        default_theme: "light".to_string(),
        colors: vec![],
        families: vec![],
        scale: vec![],
        styles: vec![],
        space: vec![],
        radius: vec![],
        css: String::new(),
    }
}

fn safe_css_ident(id: &str) -> String {
    id.trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
        .collect()
}

static SEMI_WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r";\s*").expect("regex"));
static ALIAS_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{([a-zA-Z0-9_.-]+)\}").expect("regex"));

fn safe_css_value(val: &str) -> String {
    let stripped: String = val.chars().filter(|c| !matches!(c, '{' | '}' | '<' | '>' | '\\')).collect();
    SEMI_WS.replace_all(&stripped, " ").trim().to_string()
}

fn pick_theme_value<'a>(val: &'a ThemedString, theme: &str, fallback_theme: &str) -> &'a str {
    match val {
        ThemedString::Single(s) => s.as_str(),
        ThemedString::ByTheme(map) => map
            .get(theme)
            .or_else(|| map.get(fallback_theme))
            .or_else(|| map.values().next())
            .map_or("", String::as_str),
    }
}

fn resolve_aliases(raw: &str, map: &HashMap<String, String>, seen: &BTreeSet<String>) -> String {
    ALIAS_REF
        .replace_all(raw, |caps: &regex::Captures<'_>| {
            let r = &caps[1];
            if seen.contains(r) {
                return String::new();
            }
            let Some(target) = map.get(r) else {
                return format!("var(--{})", safe_css_ident(r));
            };
            let mut next = seen.clone();
            next.insert(r.to_string());
            resolve_aliases(target, map, &next)
        })
        .into_owned()
}

pub fn parse_tokens_spec(raw_json: &str) -> ParsedTokensSpec {
    let Ok(decoded) = serde_json::from_str::<Value>(raw_json) else {
        return empty_spec();
    };
    let Ok(spec) = serde_json::from_value::<TokensSpecInput>(decoded) else {
        return empty_spec();
    };

    let themes = match spec.themes {
        Some(t) if !t.is_empty() => t,
        _ => vec!["light".to_string(), "dark".to_string()],
    };
    let default_theme = spec
        .default_theme
        .unwrap_or_else(|| themes.first().cloned().unwrap_or_else(|| "light".to_string()));

    let mut theme_maps: HashMap<String, HashMap<String, String>> = HashMap::new();
    for th in &themes {
        theme_maps.entry(th.clone()).or_default();
    }

    let add_themed = |theme_maps: &mut HashMap<String, HashMap<String, String>>, prefix: &str, items: &[(String, &ThemedString)]| {
        for (id, value) in items {
            let clean_id = safe_css_ident(id);
            for th in &themes {
                let raw = pick_theme_value(value, th, &default_theme).to_string();
                let m = theme_maps.entry(th.clone()).or_default();
                m.insert(format!("{prefix}.{clean_id}"), raw.clone());
                m.insert(format!("{prefix}-{clean_id}"), raw.clone());
                m.entry(clean_id.clone()).or_insert(raw);
            }
        }
    };

    let color_pairs: Vec<(String, &ThemedString)> = spec.color.as_deref().unwrap_or(&[]).iter().map(|c| (c.id.clone(), &c.value)).collect();
    add_themed(&mut theme_maps, "color", &color_pairs);

    fn to_pairs(items: Option<&[SimpleTokenInput]>) -> Vec<(String, &ThemedString)> {
        items.unwrap_or(&[]).iter().map(|i| (i.id.clone(), &i.value)).collect()
    }
    add_themed(&mut theme_maps, "space", &to_pairs(spec.space.as_deref()));
    add_themed(&mut theme_maps, "radius", &to_pairs(spec.radius.as_deref()));
    add_themed(&mut theme_maps, "shadow", &to_pairs(spec.shadow.as_deref()));
    add_themed(&mut theme_maps, "border", &to_pairs(spec.border.as_deref()));
    add_themed(&mut theme_maps, "motion", &to_pairs(spec.motion.as_deref()));

    let families: Vec<ParsedFamily> = spec
        .r#type
        .as_ref()
        .and_then(|t| t.families.as_deref())
        .unwrap_or(&[])
        .iter()
        .map(|f| ParsedFamily {
            id: safe_css_ident(&f.id),
            value: safe_css_value(&f.value),
            note: f.note.clone().unwrap_or_default(),
        })
        .collect();

    let scale: Vec<ParsedTokenValue> = spec
        .r#type
        .as_ref()
        .and_then(|t| t.scale.as_deref())
        .unwrap_or(&[])
        .iter()
        .map(|s| ParsedTokenValue {
            id: safe_css_ident(&s.id),
            value: safe_css_value(&s.value),
        })
        .collect();

    for th in &themes {
        let m = theme_maps.entry(th.clone()).or_default();
        for f in &families {
            m.insert(f.id.clone(), f.value.clone());
            m.insert(format!("font-{}", f.id), f.value.clone());
        }
        for s in &scale {
            m.insert(s.id.clone(), s.value.clone());
            m.insert(format!("text-{}", s.id), s.value.clone());
        }
    }

    let empty_map = HashMap::new();
    let emit_vars_for_theme = |th: &str| -> String {
        let m = theme_maps.get(th).unwrap_or(&empty_map);
        let mut decls: Vec<String> = Vec::new();
        let mut push_category = |prefix: &str, items: &[(String, &ThemedString)]| {
            for (id, value) in items {
                let name = safe_css_ident(id);
                let raw = pick_theme_value(value, th, &default_theme);
                let resolved = safe_css_value(&resolve_aliases(raw, m, &BTreeSet::new()));
                decls.push(format!("--{prefix}-{name}:{resolved};"));
                if prefix == "color" {
                    decls.push(format!("--{name}:{resolved};"));
                }
            }
        };
        push_category("color", &color_pairs);
        push_category("space", &to_pairs(spec.space.as_deref()));
        push_category("radius", &to_pairs(spec.radius.as_deref()));
        push_category("shadow", &to_pairs(spec.shadow.as_deref()));
        push_category("border", &to_pairs(spec.border.as_deref()));
        push_category("motion", &to_pairs(spec.motion.as_deref()));
        for f in &families {
            decls.push(format!("--font-{}:{};", f.id, f.value));
        }
        for s in &scale {
            decls.push(format!("--text-{}:{};", s.id, s.value));
        }
        decls.concat()
    };

    let mut css_blocks: Vec<String> = Vec::new();
    css_blocks.push(format!(":root{{{}}}", emit_vars_for_theme(&default_theme)));
    for th in &themes {
        let scheme = if th == "dark" { "dark" } else { "light" };
        css_blocks.push(format!(
            "[data-theme=\"{}\"]{{color-scheme:{scheme};{}}}",
            safe_css_ident(th),
            emit_vars_for_theme(th)
        ));
    }

    let default_map = theme_maps.get(&default_theme).unwrap_or(&empty_map);
    let styles: Vec<ParsedTypeStyle> = spec
        .r#type
        .as_ref()
        .and_then(|t| t.styles.as_deref())
        .unwrap_or(&[])
        .iter()
        .map(|st| {
            let id = safe_css_ident(&st.id);
            let family = safe_css_value(&resolve_aliases(&st.family, default_map, &BTreeSet::new()));
            let size = safe_css_value(&resolve_aliases(&st.size, default_map, &BTreeSet::new()));
            let weight = safe_css_value(&st.weight.as_css_string());
            let line_height = safe_css_value(&st.line_height.as_ref().map_or_else(|| "1.3".to_string(), NumOrString::as_css_string));
            let letter_spacing = safe_css_value(st.letter_spacing.as_deref().unwrap_or("0em"));
            css_blocks.push(format!(
                ".type-{id}{{font-family:{family};font-size:{size};font-weight:{weight};line-height:{line_height};letter-spacing:{letter_spacing};}}"
            ));
            ParsedTypeStyle {
                id,
                family,
                size,
                weight,
                line_height,
                letter_spacing,
                sample: st
                    .sample
                    .clone()
                    .unwrap_or_else(|| "The quick brown fox jumps over the lazy dog 0123".to_string()),
            }
        })
        .collect();

    let light_map = theme_maps.get("light").unwrap_or(default_map);
    let dark_map = theme_maps.get("dark").unwrap_or(default_map);
    let colors: Vec<ParsedColorSwatch> = spec
        .color
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|c| ParsedColorSwatch {
            id: safe_css_ident(&c.id),
            group: c.group.clone().unwrap_or_else(|| "core".to_string()),
            light: safe_css_value(&resolve_aliases(
                pick_theme_value(&c.value, "light", &default_theme),
                light_map,
                &BTreeSet::new(),
            )),
            dark: safe_css_value(&resolve_aliases(pick_theme_value(&c.value, "dark", &default_theme), dark_map, &BTreeSet::new())),
            note: c.note.clone().unwrap_or_default(),
        })
        .collect();

    let space: Vec<ParsedTokenValue> = spec
        .space
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|s| ParsedTokenValue {
            id: safe_css_ident(&s.id),
            value: safe_css_value(&resolve_aliases(
                pick_theme_value(&s.value, &default_theme, &default_theme),
                default_map,
                &BTreeSet::new(),
            )),
        })
        .collect();

    let radius: Vec<ParsedTokenValue> = spec
        .radius
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|r| ParsedTokenValue {
            id: safe_css_ident(&r.id),
            value: safe_css_value(&resolve_aliases(
                pick_theme_value(&r.value, &default_theme, &default_theme),
                default_map,
                &BTreeSet::new(),
            )),
        })
        .collect();

    ParsedTokensSpec {
        themes,
        default_theme,
        colors,
        families,
        scale,
        styles,
        space,
        radius,
        css: css_blocks.join("\n"),
    }
}

pub fn compile_tokens_css(raw_json: &str) -> String {
    parse_tokens_spec(raw_json).css
}

fn parse_hex_rgb(color: &str) -> Option<[u8; 3]> {
    let trimmed = color.trim();
    let hex = trimmed.strip_prefix('#')?;
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    match hex.len() {
        3 => {
            let r = u8::from_str_radix(&hex[0..1], 16).ok()?;
            let g = u8::from_str_radix(&hex[1..2], 16).ok()?;
            let b = u8::from_str_radix(&hex[2..3], 16).ok()?;
            Some([r * 17, g * 17, b * 17])
        }
        6 => {
            let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
            let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
            let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
            Some([r, g, b])
        }
        _ => None,
    }
}

fn relative_luminance(rgb: [u8; 3]) -> f64 {
    let channel = |v: u8| {
        let s = f64::from(v) / 255.0;
        if s <= 0.03928 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
    };
    0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}

/// WCAG 2.1 contrast ratio (1..21) for 3/6-digit hex colors.
pub fn contrast_ratio(fg: &str, bg: &str) -> Option<f64> {
    let a = parse_hex_rgb(fg)?;
    let b = parse_hex_rgb(bg)?;
    let l1 = relative_luminance(a);
    let l2 = relative_luminance(b);
    let lighter = l1.max(l2);
    let darker = l1.min(l2);
    Some((((lighter + 0.05) / (darker + 0.05)) * 100.0).round() / 100.0)
}
