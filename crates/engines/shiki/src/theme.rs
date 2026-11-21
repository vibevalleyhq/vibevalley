use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use rustc_hash::FxHashMap;
use serde::Deserialize;

use crate::encoded_attrs::FontStyle;
use crate::error::ShikiError;
use crate::jsonc::strip_jsonc;
use crate::plist::from_plist_str;

const VSCODE_FALLBACK_EDITOR_FG_LIGHT: &str = "#333333";
const VSCODE_FALLBACK_EDITOR_FG_DARK: &str = "#bbbbbb";
const VSCODE_FALLBACK_EDITOR_BG_LIGHT: &str = "#fffffe";
const VSCODE_FALLBACK_EDITOR_BG_DARK: &str = "#1e1e1e";

/// Theme polarity matching VS Code and Shiki theme metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeType {
    Light,
    #[default]
    Dark,
    #[serde(alias = "hc")]
    HcLight,
    #[serde(alias = "hc-black")]
    HcDark,
}

impl ThemeType {
    pub const fn is_light(self) -> bool {
        matches!(self, Self::Light | Self::HcLight)
    }
}

/// Scope field in a VS Code / TextMate theme rule: either a single comma-delimited string
/// or a list of scope selectors.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum ScopePatternList {
    Single(String),
    Multiple(Vec<String>),
}

/// Semantic token color entry in VS Code themes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum SemanticTokenStyle {
    Color(String),
    Rule {
        #[serde(default)]
        foreground: Option<String>,
        #[serde(rename = "fontStyle", default)]
        font_style: Option<String>,
        #[serde(default)]
        bold: Option<bool>,
        #[serde(default)]
        italic: Option<bool>,
        #[serde(default)]
        underline: Option<bool>,
        #[serde(default)]
        strikethrough: Option<bool>,
    },
}

/// Style payload inside a single theme rule.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawTokenSettings {
    #[serde(default)]
    pub font_style: Option<String>,
    #[serde(default)]
    pub foreground: Option<String>,
    #[serde(default)]
    pub background: Option<String>,
    #[serde(default)]
    pub font_family: Option<String>,
    #[serde(default)]
    pub font_size: Option<f64>,
    #[serde(default)]
    pub line_height: Option<f64>,
}

/// A single entry in `settings` or `tokenColors` of a VS Code / TextMate theme.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct RawThemeSetting {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub scope: Option<ScopePatternList>,
    #[serde(default)]
    pub settings: Option<RawTokenSettings>,
}

/// Typed VS Code / TextMate theme decoded from JSON/JSONC or `.tmTheme` XML plist.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawTheme {
    #[serde(default)]
    pub name: Option<String>,

    #[serde(default)]
    pub display_name: Option<String>,

    #[serde(rename = "type", default)]
    pub theme_type: Option<ThemeType>,

    #[serde(default)]
    pub include: Option<String>,

    #[serde(default)]
    pub colors: BTreeMap<String, String>,

    #[serde(default)]
    pub token_colors: Option<Vec<RawThemeSetting>>,

    #[serde(default)]
    pub settings: Option<Vec<RawThemeSetting>>,

    #[serde(default)]
    pub semantic_highlighting: Option<bool>,

    #[serde(default)]
    pub semantic_token_colors: BTreeMap<String, SemanticTokenStyle>,

    #[serde(default)]
    pub fg: Option<String>,

    #[serde(default)]
    pub bg: Option<String>,

    #[serde(default)]
    pub color_replacements: BTreeMap<String, String>,
}

impl RawTheme {
    /// Returns the effective token color entries (`settings` takes precedence over `tokenColors`).
    pub fn effective_settings(&self) -> &[RawThemeSetting] {
        if let Some(settings) = &self.settings {
            settings.as_slice()
        } else if let Some(token_colors) = &self.token_colors {
            token_colors.as_slice()
        } else {
            &[]
        }
    }
}

/// Normalized Shiki theme ready for `Theme::create_from_raw_theme` and highlighting.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedTheme {
    pub name: String,
    pub display_name: Option<String>,
    pub theme_type: ThemeType,
    pub fg: String,
    pub bg: String,
    pub semantic_highlighting: bool,
    pub semantic_token_colors: BTreeMap<String, SemanticTokenStyle>,
    pub colors: BTreeMap<String, String>,
    pub settings: Vec<RawThemeSetting>,
    pub color_replacements: BTreeMap<String, String>,
}

impl ResolvedTheme {
    pub fn as_raw_theme(&self) -> RawTheme {
        RawTheme {
            name: Some(self.name.clone()),
            display_name: self.display_name.clone(),
            theme_type: Some(self.theme_type),
            include: None,
            colors: self.colors.clone(),
            token_colors: None,
            settings: Some(self.settings.clone()),
            semantic_highlighting: Some(self.semantic_highlighting),
            semantic_token_colors: self.semantic_token_colors.clone(),
            fg: Some(self.fg.clone()),
            bg: Some(self.bg.clone()),
            color_replacements: self.color_replacements.clone(),
        }
    }

    pub fn compile(&self) -> Theme {
        Theme::create_from_raw_theme(&self.as_raw_theme(), None)
    }
}

/// Decodes a VS Code theme from JSON/JSONC text.
pub fn parse_theme_json(content: &str) -> Result<RawTheme, ShikiError> {
    let stripped = strip_jsonc(content);
    serde_json::from_str(&stripped).map_err(|err| ShikiError::ThemeParse(err.to_string()))
}

/// Decodes a TextMate `.tmTheme` XML plist.
pub fn parse_theme_plist(content: &str) -> Result<RawTheme, ShikiError> {
    from_plist_str(content)
}

/// Parses a theme from JSON/JSONC or `.tmTheme` XML plist based on path or leading content.
pub fn parse_raw_theme(content: &str, file_path: Option<&str>) -> Result<RawTheme, ShikiError> {
    let is_json = match file_path {
        Some(path) if path.ends_with(".json") => true,
        Some(path) if path.ends_with(".tmTheme") || path.ends_with(".plist") || path.ends_with(".xml") => false,
        _ => content.trim_start_matches('\u{feff}').trim_start().starts_with('{'),
    };
    if is_json { parse_theme_json(content) } else { parse_theme_plist(content) }
}

/// Loads a VS Code / TextMate theme from disk, recursively resolving any `include` chain.
pub fn load_theme_from_file(path: &Path) -> Result<RawTheme, ShikiError> {
    let mut visited = HashSet::new();
    load_theme_file_recursive(path, &mut visited)
}

fn load_theme_file_recursive(path: &Path, visited: &mut HashSet<PathBuf>) -> Result<RawTheme, ShikiError> {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if !visited.insert(canonical.clone()) {
        return Err(ShikiError::ThemeIncludeCycle(canonical.display().to_string()));
    }

    let content = std::fs::read_to_string(path)?;
    let mut theme = parse_raw_theme(&content, path.to_str())?;

    if let Some(include_rel) = theme.include.take() {
        let base_dir = path.parent().unwrap_or_else(|| Path::new("."));
        let parent_path = base_dir.join(&include_rel);
        let parent = load_theme_file_recursive(&parent_path, visited)?;
        theme = merge_included_theme(parent, theme);
    }

    visited.remove(&canonical);
    Ok(theme)
}

/// Resolves theme `include` inheritance using a caller-supplied loader (for in-memory themes).
pub fn resolve_theme_includes(theme: RawTheme, loader: &mut impl FnMut(&str) -> Result<RawTheme, ShikiError>) -> Result<RawTheme, ShikiError> {
    let mut visited = HashSet::new();
    resolve_theme_includes_rec(theme, loader, &mut visited)
}

fn resolve_theme_includes_rec(
    mut theme: RawTheme,
    loader: &mut impl FnMut(&str) -> Result<RawTheme, ShikiError>,
    visited: &mut HashSet<String>,
) -> Result<RawTheme, ShikiError> {
    if let Some(include_key) = theme.include.take() {
        if !visited.insert(include_key.clone()) {
            return Err(ShikiError::ThemeIncludeCycle(include_key));
        }
        let parent = loader(&include_key)?;
        let resolved_parent = resolve_theme_includes_rec(parent, loader, visited)?;
        visited.remove(&include_key);
        theme = merge_included_theme(resolved_parent, theme);
    }
    Ok(theme)
}

fn merge_included_theme(parent: RawTheme, child: RawTheme) -> RawTheme {
    let mut merged_colors = parent.colors;
    for (k, v) in child.colors {
        merged_colors.insert(k, v);
    }

    let mut merged_semantic = parent.semantic_token_colors;
    for (k, v) in child.semantic_token_colors {
        merged_semantic.insert(k, v);
    }

    let mut merged_replacements = parent.color_replacements;
    for (k, v) in child.color_replacements {
        merged_replacements.insert(k, v);
    }

    let parent_rules = if let Some(s) = parent.settings {
        s
    } else {
        parent.token_colors.unwrap_or_default()
    };
    let child_rules = if let Some(s) = child.settings {
        s
    } else {
        child.token_colors.unwrap_or_default()
    };
    let mut merged_settings = parent_rules;
    merged_settings.extend(child_rules);

    RawTheme {
        name: child.name.or(parent.name),
        display_name: child.display_name.or(parent.display_name),
        theme_type: child.theme_type.or(parent.theme_type),
        include: None,
        colors: merged_colors,
        token_colors: None,
        settings: Some(merged_settings),
        semantic_highlighting: child.semantic_highlighting.or(parent.semantic_highlighting),
        semantic_token_colors: merged_semantic,
        fg: child.fg.or(parent.fg),
        bg: child.bg.or(parent.bg),
        color_replacements: merged_replacements,
    }
}

/// Normalizes a raw VS Code / TextMate theme following Shiki's `normalizeTheme` rules:
/// - Unifies `tokenColors` into `settings`.
/// - Resolves default `fg` and `bg` from global settings, `colors["editor.*"]`, or VS Code defaults.
/// - Prepends an unscoped default setting when absent.
/// - Maps non-hex colors (e.g. `var(--shiki-...)`) to synthetic hex placeholders in `color_replacements`.
pub fn normalize_theme(raw: &RawTheme) -> ResolvedTheme {
    let mut settings = raw.effective_settings().to_vec();
    let theme_type = raw.theme_type.unwrap_or(ThemeType::Dark);
    let mut color_replacements: BTreeMap<String, String> = raw.color_replacements.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.clone())).collect();
    let mut colors = raw.colors.clone();

    let mut fg = raw.fg.clone();
    let mut bg = raw.bg.clone();

    if fg.is_none() || bg.is_none() {
        let global_setting = settings.iter().find(|s| s.name.is_none() && s.scope.is_none());
        if let Some(gs) = global_setting
            && let Some(st) = &gs.settings
        {
            if fg.is_none() {
                fg = st.foreground.clone();
            }
            if bg.is_none() {
                bg = st.background.clone();
            }
        }
        if fg.is_none() {
            fg = colors.get("editor.foreground").cloned();
        }
        if bg.is_none() {
            bg = colors.get("editor.background").cloned();
        }
        if fg.is_none() {
            fg = Some(
                if theme_type.is_light() {
                    VSCODE_FALLBACK_EDITOR_FG_LIGHT
                } else {
                    VSCODE_FALLBACK_EDITOR_FG_DARK
                }
                .to_string(),
            );
        }
        if bg.is_none() {
            bg = Some(
                if theme_type.is_light() {
                    VSCODE_FALLBACK_EDITOR_BG_LIGHT
                } else {
                    VSCODE_FALLBACK_EDITOR_BG_DARK
                }
                .to_string(),
            );
        }
    }

    let fg = fg.unwrap_or_else(|| VSCODE_FALLBACK_EDITOR_FG_DARK.to_string());
    let bg = bg.unwrap_or_else(|| VSCODE_FALLBACK_EDITOR_BG_DARK.to_string());

    let has_leading_default = settings.first().is_some_and(|first| first.settings.is_some() && first.scope.is_none());
    if !has_leading_default {
        settings.insert(
            0,
            RawThemeSetting {
                name: None,
                scope: None,
                settings: Some(RawTokenSettings {
                    foreground: Some(fg.clone()),
                    background: Some(bg.clone()),
                    ..RawTokenSettings::default()
                }),
            },
        );
    }

    // Replace non-hex colors (such as CSS `var(--shiki-...)`) with synthetic hex keys
    // so `vscode-textmate`'s hex-validated `ColorMap` preserves them faithfully.
    let mut replacement_count: u32 = 0;
    let mut value_to_hex: FxHashMap<String, String> = FxHashMap::default();
    let mut alloc_placeholder = |value: &str, replacements: &mut BTreeMap<String, String>| -> String {
        if let Some(existing) = value_to_hex.get(value) {
            return existing.clone();
        }
        loop {
            replacement_count += 1;
            let hex = format!("#{replacement_count:08x}");
            if !replacements.contains_key(&hex) {
                replacements.insert(hex.clone(), value.to_string());
                value_to_hex.insert(value.to_string(), hex.clone());
                return hex;
            }
        }
    };

    for entry in &mut settings {
        let Some(st) = entry.settings.as_mut() else {
            continue;
        };
        if let Some(ref mut f) = st.foreground
            && !f.is_empty()
            && !f.starts_with('#')
        {
            *f = alloc_placeholder(f, &mut color_replacements);
        }
        if let Some(ref mut b) = st.background
            && !b.is_empty()
            && !b.starts_with('#')
        {
            *b = alloc_placeholder(b, &mut color_replacements);
        }
    }

    for (key, value) in &mut colors {
        if (key == "editor.foreground" || key == "editor.background" || key.starts_with("terminal.ansi")) && !value.is_empty() && !value.starts_with('#') {
            *value = alloc_placeholder(value, &mut color_replacements);
        }
    }

    ResolvedTheme {
        name: raw.name.clone().unwrap_or_default(),
        display_name: raw.display_name.clone(),
        theme_type,
        fg,
        bg,
        semantic_highlighting: raw.semantic_highlighting.unwrap_or(false),
        semantic_token_colors: raw.semantic_token_colors.clone(),
        colors,
        settings,
        color_replacements,
    }
}

/// Options for [`create_css_variables_theme`], matching Shiki's `CssVariablesThemeOptions`.
#[derive(Debug, Clone)]
pub struct CssVariablesThemeOptions {
    pub name: String,
    pub variable_prefix: String,
    pub variable_defaults: BTreeMap<String, String>,
    pub font_style: bool,
}

impl Default for CssVariablesThemeOptions {
    fn default() -> Self {
        Self {
            name: "css-variables".to_string(),
            variable_prefix: "--shiki-".to_string(),
            variable_defaults: BTreeMap::new(),
            font_style: true,
        }
    }
}

/// Builds a CSS-variables-driven `RawTheme` matching Shiki's `createCssVariablesTheme`.
pub fn create_css_variables_theme(options: CssVariablesThemeOptions) -> RawTheme {
    let var = |key: &str| -> String {
        if let Some(default) = options.variable_defaults.get(key) {
            format!("var({}{key}, {default})", options.variable_prefix)
        } else {
            format!("var({}{key})", options.variable_prefix)
        }
    };

    let mut colors = BTreeMap::new();
    for (ui_key, var_key) in [
        ("editor.foreground", "foreground"),
        ("editor.background", "background"),
        ("terminal.ansiBlack", "ansi-black"),
        ("terminal.ansiRed", "ansi-red"),
        ("terminal.ansiGreen", "ansi-green"),
        ("terminal.ansiYellow", "ansi-yellow"),
        ("terminal.ansiBlue", "ansi-blue"),
        ("terminal.ansiMagenta", "ansi-magenta"),
        ("terminal.ansiCyan", "ansi-cyan"),
        ("terminal.ansiWhite", "ansi-white"),
        ("terminal.ansiBrightBlack", "ansi-bright-black"),
        ("terminal.ansiBrightRed", "ansi-bright-red"),
        ("terminal.ansiBrightGreen", "ansi-bright-green"),
        ("terminal.ansiBrightYellow", "ansi-bright-yellow"),
        ("terminal.ansiBrightBlue", "ansi-bright-blue"),
        ("terminal.ansiBrightMagenta", "ansi-bright-magenta"),
        ("terminal.ansiBrightCyan", "ansi-bright-cyan"),
        ("terminal.ansiBrightWhite", "ansi-bright-white"),
    ] {
        colors.insert(ui_key.to_string(), var(var_key));
    }

    let make_rule = |scopes: &[&str], fg: Option<String>, font_style: Option<&str>| RawThemeSetting {
        name: None,
        scope: Some(if scopes.len() == 1 {
            ScopePatternList::Single(scopes[0].to_string())
        } else {
            ScopePatternList::Multiple(scopes.iter().map(|s| (*s).to_string()).collect())
        }),
        settings: Some(RawTokenSettings {
            foreground: fg,
            font_style: if options.font_style { font_style.map(str::to_string) } else { None },
            ..RawTokenSettings::default()
        }),
    };

    let token_colors = vec![
        make_rule(
            &[
                "keyword.operator.accessor",
                "meta.group.braces.round.function.arguments",
                "meta.template.expression",
                "markup.fenced_code meta.embedded.block",
            ],
            Some(var("foreground")),
            None,
        ),
        make_rule(&["emphasis"], None, Some("italic")),
        make_rule(&["strong", "markup.heading.markdown", "markup.bold.markdown"], None, Some("bold")),
        make_rule(&["markup.italic.markdown"], None, Some("italic")),
        make_rule(&["meta.link.inline.markdown"], Some(var("token-link")), Some("underline")),
        make_rule(&["string", "markup.fenced_code", "markup.inline"], Some(var("token-string")), None),
        make_rule(&["comment", "string.quoted.docstring.multi"], Some(var("token-comment")), None),
        make_rule(
            &[
                "constant.numeric",
                "constant.language",
                "constant.other.placeholder",
                "constant.character.format.placeholder",
                "variable.language.this",
                "variable.other.object",
                "variable.other.class",
                "variable.other.constant",
                "meta.property-name",
                "meta.property-value",
                "support",
            ],
            Some(var("token-constant")),
            None,
        ),
        make_rule(
            &[
                "keyword",
                "storage.modifier",
                "storage.type",
                "storage.control.clojure",
                "entity.name.function.clojure",
                "entity.name.tag.yaml",
                "support.function.node",
                "support.type.property-name.json",
                "punctuation.separator.key-value",
                "punctuation.definition.template-expression",
            ],
            Some(var("token-keyword")),
            None,
        ),
        make_rule(&["variable.parameter.function"], Some(var("token-parameter")), None),
        make_rule(
            &[
                "support.function",
                "entity.name.type",
                "entity.other.inherited-class",
                "meta.function-call",
                "meta.instance.constructor",
                "entity.other.attribute-name",
                "entity.name.function",
                "constant.keyword.clojure",
            ],
            Some(var("token-function")),
            None,
        ),
        make_rule(
            &[
                "entity.name.tag",
                "string.quoted",
                "string.regexp",
                "string.interpolated",
                "string.template",
                "string.unquoted.plain.out.yaml",
                "keyword.other.template",
            ],
            Some(var("token-string-expression")),
            None,
        ),
        make_rule(
            &[
                "punctuation.definition.arguments",
                "punctuation.definition.dict",
                "punctuation.separator",
                "meta.function-call.arguments",
            ],
            Some(var("token-punctuation")),
            None,
        ),
        make_rule(
            &["markup.underline.link", "punctuation.definition.metadata.markdown"],
            Some(var("token-link")),
            None,
        ),
        make_rule(&["beginning.punctuation.definition.list.markdown"], Some(var("token-string")), None),
        make_rule(
            &[
                "punctuation.definition.string.begin.markdown",
                "punctuation.definition.string.end.markdown",
                "string.other.link.title.markdown",
                "string.other.link.description.markdown",
            ],
            Some(var("token-keyword")),
            None,
        ),
        make_rule(
            &["markup.inserted", "meta.diff.header.to-file", "punctuation.definition.inserted"],
            Some(var("token-inserted")),
            None,
        ),
        make_rule(
            &["markup.deleted", "meta.diff.header.from-file", "punctuation.definition.deleted"],
            Some(var("token-deleted")),
            None,
        ),
        make_rule(&["markup.changed", "punctuation.definition.changed"], Some(var("token-changed")), None),
    ];

    RawTheme {
        name: Some(options.name),
        theme_type: Some(ThemeType::Dark),
        colors,
        token_colors: Some(token_colors),
        ..RawTheme::default()
    }
}

/// RGBA color parsed from a CSS hex string (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Rgba {
    pub fn from_hex(hex: &str) -> Option<Self> {
        let h = hex.strip_prefix('#')?;
        match h.len() {
            3 => {
                let r = u8::from_str_radix(&h[0..1], 16).ok()?;
                let g = u8::from_str_radix(&h[1..2], 16).ok()?;
                let b = u8::from_str_radix(&h[2..3], 16).ok()?;
                Some(Self {
                    r: r * 17,
                    g: g * 17,
                    b: b * 17,
                    a: 255,
                })
            }
            4 => {
                let r = u8::from_str_radix(&h[0..1], 16).ok()?;
                let g = u8::from_str_radix(&h[1..2], 16).ok()?;
                let b = u8::from_str_radix(&h[2..3], 16).ok()?;
                let a = u8::from_str_radix(&h[3..4], 16).ok()?;
                Some(Self {
                    r: r * 17,
                    g: g * 17,
                    b: b * 17,
                    a: a * 17,
                })
            }
            6 => Some(Self {
                r: u8::from_str_radix(&h[0..2], 16).ok()?,
                g: u8::from_str_radix(&h[2..4], 16).ok()?,
                b: u8::from_str_radix(&h[4..6], 16).ok()?,
                a: 255,
            }),
            8 => Some(Self {
                r: u8::from_str_radix(&h[0..2], 16).ok()?,
                g: u8::from_str_radix(&h[2..4], 16).ok()?,
                b: u8::from_str_radix(&h[4..6], 16).ok()?,
                a: u8::from_str_radix(&h[6..8], 16).ok()?,
            }),
            _ => None,
        }
    }

    pub fn to_hex(self) -> String {
        if self.a == 255 {
            format!("#{:02X}{:02X}{:02X}", self.r, self.g, self.b)
        } else {
            format!("#{:02X}{:02X}{:02X}{:02X}", self.r, self.g, self.b, self.a)
        }
    }
}

/// Validates `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` hex colors identically to `vscode-textmate`.
pub fn is_valid_hex_color(hex: &str) -> bool {
    let Some(rest) = hex.strip_prefix('#') else {
        return false;
    };
    matches!(rest.len(), 3 | 4 | 6 | 8) && rest.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Immutable linked stack of active TextMate scopes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeStack {
    inner: Arc<ScopeStackNode>,
}

#[derive(Debug, PartialEq, Eq)]
struct ScopeStackNode {
    parent: Option<ScopeStack>,
    scope_name: String,
}

impl ScopeStack {
    pub fn new(parent: Option<ScopeStack>, scope_name: impl Into<String>) -> Self {
        Self {
            inner: Arc::new(ScopeStackNode {
                parent,
                scope_name: scope_name.into(),
            }),
        }
    }

    pub fn from_segments<I, S>(segments: I) -> Option<Self>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut current: Option<Self> = None;
        for seg in segments {
            current = Some(Self::new(current, seg));
        }
        current
    }

    pub fn push(&self, scope_name: impl Into<String>) -> Self {
        Self::new(Some(self.clone()), scope_name)
    }

    pub fn push_many(mut path: Option<Self>, scopes: &[String]) -> Option<Self> {
        for scope in scopes {
            path = Some(Self::new(path, scope.clone()));
        }
        path
    }

    pub fn scope_name(&self) -> &str {
        &self.inner.scope_name
    }

    pub fn parent(&self) -> Option<&Self> {
        self.inner.parent.as_ref()
    }

    pub fn segments(&self) -> Vec<String> {
        let mut out = Vec::new();
        let mut cur = Some(self);
        while let Some(node) = cur {
            out.push(node.scope_name().to_string());
            cur = node.parent();
        }
        out.reverse();
        out
    }
}

/// Resolved style attributes returned by `Theme::match_scope`.
#[derive(Debug, Clone, PartialEq)]
pub struct StyleAttributes {
    pub font_style: FontStyle,
    pub foreground_id: u16,
    pub background_id: u16,
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
}

impl StyleAttributes {
    pub fn new(font_style: FontStyle, foreground_id: u16, background_id: u16, font_family: impl Into<String>, font_size: f64, line_height: f64) -> Self {
        Self {
            font_style,
            foreground_id,
            background_id,
            font_family: font_family.into(),
            font_size,
            line_height,
        }
    }
}

/// Parsed intermediate theme rule prior to trie resolution.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedThemeRule {
    pub scope: String,
    pub parent_scopes: Option<Vec<String>>,
    pub index: usize,
    pub font_style: FontStyle,
    pub foreground: Option<String>,
    pub background: Option<String>,
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
}

/// Parses a `RawTheme` into flat `ParsedThemeRule`s, matching `vscode-textmate`'s `parseTheme`.
pub fn parse_theme(source: &RawTheme) -> Vec<ParsedThemeRule> {
    let settings = source.effective_settings();
    let mut result = Vec::new();

    for (i, entry) in settings.iter().enumerate() {
        let Some(st) = &entry.settings else {
            continue;
        };

        let scopes: Vec<String> = match &entry.scope {
            Some(ScopePatternList::Single(s)) => {
                let trimmed = s.trim().trim_start_matches(',').trim_end_matches(',');
                trimmed.split(',').map(str::to_string).collect()
            }
            Some(ScopePatternList::Multiple(list)) => list.clone(),
            None => vec![String::new()],
        };

        let font_style = match &st.font_style {
            Some(fs) => {
                let mut mask = FontStyle::NONE;
                for segment in fs.split(' ') {
                    match segment {
                        "italic" => mask |= FontStyle::ITALIC,
                        "bold" => mask |= FontStyle::BOLD,
                        "underline" => mask |= FontStyle::UNDERLINE,
                        "strikethrough" => mask |= FontStyle::STRIKETHROUGH,
                        _ => {}
                    }
                }
                mask
            }
            None => FontStyle::NOT_SET,
        };

        let foreground = st.foreground.as_deref().filter(|c| is_valid_hex_color(c)).map(str::to_string);
        let background = st.background.as_deref().filter(|c| is_valid_hex_color(c)).map(str::to_string);
        let font_family = st.font_family.clone().unwrap_or_default();
        let font_size = st.font_size.unwrap_or(0.0);
        let line_height = st.line_height.unwrap_or(0.0);

        for raw_scope in scopes {
            let trimmed = raw_scope.trim();
            let segments: Vec<&str> = trimmed.split(' ').collect();
            let scope = segments.last().copied().unwrap_or("").to_string();
            let parent_scopes = if segments.len() > 1 {
                let mut parents: Vec<String> = segments[..segments.len() - 1].iter().map(|s| (*s).to_string()).collect();
                parents.reverse();
                Some(parents)
            } else {
                None
            };

            result.push(ParsedThemeRule {
                scope,
                parent_scopes,
                index: i,
                font_style,
                foreground: foreground.clone(),
                background: background.clone(),
                font_family: font_family.clone(),
                font_size,
                line_height,
            });
        }
    }

    result
}

/// 1-based color palette mapping hex color strings to compact numeric IDs (`0` = unset).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColorMap {
    is_frozen: bool,
    last_color_id: u16,
    id_to_color: Vec<String>,
    color_to_id: BTreeMap<String, u16>,
}

impl Default for ColorMap {
    fn default() -> Self {
        Self::new(None)
    }
}

impl ColorMap {
    pub fn new(preset: Option<&[String]>) -> Self {
        let mut id_to_color = Vec::new();
        let mut color_to_id = BTreeMap::new();
        let is_frozen;

        if let Some(colors) = preset {
            is_frozen = true;
            for (i, c) in colors.iter().enumerate() {
                id_to_color.push(c.clone());
                color_to_id.insert(c.clone(), i as u16);
            }
        } else {
            is_frozen = false;
            // Slot 0 is reserved for "unset / inherit" matching vscode-textmate's 1-based ids.
            id_to_color.push(String::new());
        }

        Self {
            is_frozen,
            last_color_id: 0,
            id_to_color,
            color_to_id,
        }
    }

    pub fn get_id(&mut self, color: Option<&str>) -> u16 {
        let Some(raw) = color else {
            return 0;
        };
        let upper = raw.to_ascii_uppercase();
        if let Some(&id) = self.color_to_id.get(&upper) {
            return id;
        }
        assert!(!self.is_frozen, "missing color in frozen color map: {upper}");
        self.last_color_id += 1;
        let id = self.last_color_id;
        self.color_to_id.insert(upper.clone(), id);
        if self.id_to_color.len() <= id as usize {
            self.id_to_color.resize(id as usize + 1, String::new());
        }
        self.id_to_color[id as usize] = upper;
        id
    }

    pub fn color_map(&self) -> &[String] {
        &self.id_to_color
    }

    pub fn get_color(&self, id: u16) -> Option<&str> {
        let s = self.id_to_color.get(id as usize)?;
        if s.is_empty() { None } else { Some(s.as_str()) }
    }
}

/// Rule stored inside a [`ThemeTrieElement`].
#[derive(Debug, Clone, PartialEq)]
pub struct ThemeTrieElementRule {
    pub scope_depth: usize,
    pub parent_scopes: Vec<String>,
    pub font_style: FontStyle,
    pub foreground: u16,
    pub background: u16,
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
}

impl ThemeTrieElementRule {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        scope_depth: usize,
        parent_scopes: Option<Vec<String>>,
        font_style: FontStyle,
        foreground: u16,
        background: u16,
        font_family: impl Into<String>,
        font_size: f64,
        line_height: f64,
    ) -> Self {
        Self {
            scope_depth,
            parent_scopes: parent_scopes.unwrap_or_default(),
            font_style,
            foreground,
            background,
            font_family: font_family.into(),
            font_size,
            line_height,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn accept_overwrite(
        &mut self,
        scope_depth: usize,
        font_style: FontStyle,
        foreground: u16,
        background: u16,
        font_family: &str,
        font_size: f64,
        line_height: f64,
    ) {
        if self.scope_depth <= scope_depth {
            self.scope_depth = scope_depth;
        }
        if !font_style.is_not_set() {
            self.font_style = font_style;
        }
        if foreground != 0 {
            self.foreground = foreground;
        }
        if background != 0 {
            self.background = background;
        }
        if !font_family.is_empty() {
            self.font_family = font_family.to_string();
        }
        if font_size != 0.0 {
            self.font_size = font_size;
        }
        if line_height != 0.0 {
            self.line_height = line_height;
        }
    }
}

/// Prefix trie over dot-separated scope segments matching `vscode-textmate`'s `ThemeTrieElement`.
#[derive(Debug, Clone, PartialEq)]
pub struct ThemeTrieElement {
    pub main_rule: ThemeTrieElementRule,
    pub rules_with_parent_scopes: Vec<ThemeTrieElementRule>,
    pub children: BTreeMap<String, ThemeTrieElement>,
}

impl ThemeTrieElement {
    pub fn new(main_rule: ThemeTrieElementRule, rules_with_parent_scopes: Vec<ThemeTrieElementRule>) -> Self {
        Self {
            main_rule,
            rules_with_parent_scopes,
            children: BTreeMap::new(),
        }
    }

    pub fn match_scope(&self, scope: &str) -> Vec<ThemeTrieElementRule> {
        if !scope.is_empty() {
            let (head, tail) = match scope.find('.') {
                Some(dot) => (&scope[..dot], &scope[dot + 1..]),
                None => (scope, ""),
            };
            if let Some(child) = self.children.get(head) {
                return child.match_scope(tail);
            }
        }

        let mut rules = self.rules_with_parent_scopes.clone();
        rules.push(self.main_rule.clone());
        rules.sort_by(cmp_rule_specificity);
        rules
    }

    #[allow(clippy::too_many_arguments)]
    pub fn insert(
        &mut self,
        scope_depth: usize,
        scope: &str,
        parent_scopes: Option<&[String]>,
        font_style: FontStyle,
        foreground: u16,
        background: u16,
        font_family: &str,
        font_size: f64,
        line_height: f64,
    ) {
        if scope.is_empty() {
            self.do_insert_here(
                scope_depth,
                parent_scopes,
                font_style,
                foreground,
                background,
                font_family,
                font_size,
                line_height,
            );
            return;
        }

        let (head, tail) = match scope.find('.') {
            Some(dot) => (&scope[..dot], &scope[dot + 1..]),
            None => (scope, ""),
        };

        let child = self
            .children
            .entry(head.to_string())
            .or_insert_with(|| ThemeTrieElement::new(self.main_rule.clone(), self.rules_with_parent_scopes.clone()));
        child.insert(
            scope_depth + 1,
            tail,
            parent_scopes,
            font_style,
            foreground,
            background,
            font_family,
            font_size,
            line_height,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn do_insert_here(
        &mut self,
        scope_depth: usize,
        parent_scopes: Option<&[String]>,
        mut font_style: FontStyle,
        mut foreground: u16,
        mut background: u16,
        font_family: &str,
        mut font_size: f64,
        mut line_height: f64,
    ) {
        let Some(parent_scopes) = parent_scopes else {
            self.main_rule
                .accept_overwrite(scope_depth, font_style, foreground, background, font_family, font_size, line_height);
            return;
        };

        for rule in &mut self.rules_with_parent_scopes {
            if str_slice_cmp(Some(&rule.parent_scopes), Some(parent_scopes)) == Ordering::Equal {
                rule.accept_overwrite(scope_depth, font_style, foreground, background, font_family, font_size, line_height);
                return;
            }
        }

        if font_style.is_not_set() {
            font_style = self.main_rule.font_style;
        }
        if foreground == 0 {
            foreground = self.main_rule.foreground;
        }
        if background == 0 {
            background = self.main_rule.background;
        }
        let resolved_font_family = if font_family.is_empty() {
            self.main_rule.font_family.as_str()
        } else {
            font_family
        };
        if font_size == 0.0 {
            font_size = self.main_rule.font_size;
        }
        if line_height == 0.0 {
            line_height = self.main_rule.line_height;
        }

        self.rules_with_parent_scopes.push(ThemeTrieElementRule::new(
            scope_depth,
            Some(parent_scopes.to_vec()),
            font_style,
            foreground,
            background,
            resolved_font_family,
            font_size,
            line_height,
        ));
    }
}

fn cmp_rule_specificity(a: &ThemeTrieElementRule, b: &ThemeTrieElementRule) -> Ordering {
    if a.scope_depth != b.scope_depth {
        return b.scope_depth.cmp(&a.scope_depth);
    }

    let mut a_idx = 0;
    let mut b_idx = 0;

    loop {
        if a.parent_scopes.get(a_idx).is_some_and(|s| s == ">") {
            a_idx += 1;
        }
        if b.parent_scopes.get(b_idx).is_some_and(|s| s == ">") {
            b_idx += 1;
        }
        if a_idx >= a.parent_scopes.len() || b_idx >= b.parent_scopes.len() {
            break;
        }
        let len_cmp = b.parent_scopes[b_idx].len().cmp(&a.parent_scopes[a_idx].len());
        if len_cmp != Ordering::Equal {
            return len_cmp;
        }
        a_idx += 1;
        b_idx += 1;
    }

    b.parent_scopes.len().cmp(&a.parent_scopes.len())
}

/// Compiled TextMate theme matching scope paths to [`StyleAttributes`].
#[derive(Debug)]
pub struct Theme {
    color_map: ColorMap,
    defaults: StyleAttributes,
    root: ThemeTrieElement,
    match_cache: RwLock<FxHashMap<String, Arc<[ThemeTrieElementRule]>>>,
}

impl Clone for Theme {
    fn clone(&self) -> Self {
        Self {
            color_map: self.color_map.clone(),
            defaults: self.defaults.clone(),
            root: self.root.clone(),
            match_cache: RwLock::new(FxHashMap::default()),
        }
    }
}

impl Theme {
    pub fn new(color_map: ColorMap, defaults: StyleAttributes, root: ThemeTrieElement) -> Self {
        Self {
            color_map,
            defaults,
            root,
            match_cache: RwLock::new(FxHashMap::default()),
        }
    }

    pub fn create_from_raw_theme(source: &RawTheme, color_map: Option<&[String]>) -> Self {
        Self::create_from_parsed_theme(parse_theme(source), color_map)
    }

    pub fn create_from_parsed_theme(mut parsed: Vec<ParsedThemeRule>, preset_color_map: Option<&[String]>) -> Self {
        parsed.sort_by(|a, b| {
            a.scope
                .cmp(&b.scope)
                .then_with(|| str_slice_cmp(a.parent_scopes.as_deref(), b.parent_scopes.as_deref()))
                .then_with(|| a.index.cmp(&b.index))
        });

        let mut default_font_style = FontStyle::NONE;
        let mut default_foreground = "#000000".to_string();
        let mut default_background = "#ffffff".to_string();
        let mut default_font_family = String::new();
        let mut default_font_size = 0.0;
        let mut default_line_height = 0.0;

        let mut start = 0;
        while start < parsed.len() && parsed[start].scope.is_empty() {
            let incoming = &parsed[start];
            if !incoming.font_style.is_not_set() {
                default_font_style = incoming.font_style;
            }
            if let Some(fg) = &incoming.foreground {
                default_foreground = fg.clone();
            }
            if let Some(bg) = &incoming.background {
                default_background = bg.clone();
            }
            default_font_family = incoming.font_family.clone();
            default_font_size = incoming.font_size;
            default_line_height = incoming.line_height;
            start += 1;
        }

        let mut color_map = ColorMap::new(preset_color_map);
        let defaults = StyleAttributes::new(
            default_font_style,
            color_map.get_id(Some(&default_foreground)),
            color_map.get_id(Some(&default_background)),
            default_font_family.clone(),
            default_font_size,
            default_line_height,
        );

        let mut root = ThemeTrieElement::new(
            ThemeTrieElementRule::new(0, None, FontStyle::NOT_SET, 0, 0, default_font_family, default_font_size, default_line_height),
            Vec::new(),
        );

        for rule in &parsed[start..] {
            let fg_id = color_map.get_id(rule.foreground.as_deref());
            let bg_id = color_map.get_id(rule.background.as_deref());
            root.insert(
                0,
                &rule.scope,
                rule.parent_scopes.as_deref(),
                rule.font_style,
                fg_id,
                bg_id,
                &rule.font_family,
                rule.font_size,
                rule.line_height,
            );
        }

        Self::new(color_map, defaults, root)
    }

    pub fn color_map(&self) -> &[String] {
        self.color_map.color_map()
    }

    pub fn color_map_ref(&self) -> &ColorMap {
        &self.color_map
    }

    pub fn defaults(&self) -> &StyleAttributes {
        &self.defaults
    }

    pub fn root(&self) -> &ThemeTrieElement {
        &self.root
    }

    pub fn match_scope(&self, scope_path: Option<&ScopeStack>) -> Option<StyleAttributes> {
        let Some(scope_path) = scope_path else {
            return Some(self.defaults.clone());
        };

        let scope_name = scope_path.scope_name();
        let candidates = self.cached_root_match(scope_name);
        let effective = candidates
            .iter()
            .find(|rule| scope_path_matches_parent_scopes(scope_path.parent(), &rule.parent_scopes))?;

        Some(StyleAttributes::new(
            effective.font_style,
            effective.foreground,
            effective.background,
            effective.font_family.clone(),
            effective.font_size,
            effective.line_height,
        ))
    }

    fn cached_root_match(&self, scope_name: &str) -> Arc<[ThemeTrieElementRule]> {
        if let Ok(guard) = self.match_cache.read()
            && let Some(hit) = guard.get(scope_name)
        {
            return Arc::clone(hit);
        }
        let matched: Arc<[ThemeTrieElementRule]> = self.root.match_scope(scope_name).into();
        if let Ok(mut guard) = self.match_cache.write() {
            guard.insert(scope_name.to_string(), Arc::clone(&matched));
        }
        matched
    }
}

fn scope_path_matches_parent_scopes(mut scope_path: Option<&ScopeStack>, parent_scopes: &[String]) -> bool {
    if parent_scopes.is_empty() {
        return true;
    }

    let mut index = 0;
    while index < parent_scopes.len() {
        let mut scope_pattern = parent_scopes[index].as_str();
        let mut scope_must_match = false;

        if scope_pattern == ">" {
            if index + 1 == parent_scopes.len() {
                return false;
            }
            index += 1;
            scope_pattern = parent_scopes[index].as_str();
            scope_must_match = true;
        }

        let mut matched_node = None;
        while let Some(node) = scope_path {
            if matches_scope_segment(node.scope_name(), scope_pattern) {
                matched_node = Some(node);
                break;
            }
            if scope_must_match {
                return false;
            }
            scope_path = node.parent();
        }

        let Some(node) = matched_node else {
            return false;
        };
        scope_path = node.parent();
        index += 1;
    }

    true
}

fn matches_scope_segment(scope_name: &str, scope_pattern: &str) -> bool {
    scope_pattern == scope_name
        || (scope_name.len() > scope_pattern.len() && scope_name.as_bytes()[scope_pattern.len()] == b'.' && scope_name.starts_with(scope_pattern))
}

/// Lexicographical comparison matching `vscode-textmate`'s `strArrCmp`:
/// `None < Some(&[]) < Some(&["a"])`, comparing length first when non-equal.
pub fn str_slice_cmp(a: Option<&[String]>, b: Option<&[String]>) -> Ordering {
    match (a, b) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some(a), Some(b)) => a.len().cmp(&b.len()).then_with(|| a.cmp(b)),
    }
}
