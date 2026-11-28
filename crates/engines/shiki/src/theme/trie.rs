use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use rustc_hash::FxHashMap;

use super::color::{ColorMap, is_valid_hex_color};
use super::raw::{RawTheme, ScopePatternList};
use crate::encoded_attrs::FontStyle;

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
