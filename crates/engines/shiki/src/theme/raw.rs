use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use rustc_hash::FxHashMap;
use serde::Deserialize;

use super::trie::Theme;
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
