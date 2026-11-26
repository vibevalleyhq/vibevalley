use crate::encoded_attrs::{EncodedTokenAttributes, FontStyle, OptionalStandardTokenType, contains_rtl};

use super::attributes::{BalancedBracketSelectors, TokenTypeMatcher};
use super::types::{AttributedScopeStack, StateStack};

/// A single scope-annotated token on a line (`start_index..end_index` in UTF-8 bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub start_index: usize,
    pub end_index: usize,
    pub scopes: Vec<String>,
}

/// Variable font span produced when a theme specifies `fontFamily`, `fontSize`, or `lineHeight`.
#[derive(Debug, Clone, PartialEq)]
pub struct FontInfo {
    pub start_index: usize,
    pub end_index: usize,
    pub font_family: Option<String>,
    pub font_size_multiplier: Option<f64>,
    pub line_height_multiplier: Option<f64>,
}

impl FontInfo {
    fn options_equal(&self, other: &Self) -> bool {
        self.font_family == other.font_family
            && self.font_size_multiplier == other.font_size_multiplier
            && self.line_height_multiplier == other.line_height_multiplier
    }
}

/// Output of [`super::Grammar::tokenize_line`].
#[derive(Debug, Clone)]
pub struct TokenizeLineResult {
    pub tokens: Vec<Token>,
    pub fonts: Vec<FontInfo>,
    pub rule_stack: StateStack,
    pub stopped_early: bool,
}

/// Output of [`super::Grammar::tokenize_line2`]: packed `(start_index, EncodedTokenAttributes)` pairs.
#[derive(Debug, Clone)]
pub struct TokenizeLineResult2 {
    /// Pairs of `[start_byte_offset, encoded_attributes]` (length is `2 * token_count`).
    pub tokens: Vec<u32>,
    pub fonts: Vec<FontInfo>,
    pub rule_stack: StateStack,
    pub stopped_early: bool,
}

pub(crate) struct TokenHandler<'a> {
    emit_binary: bool,
    tokens: Vec<Token>,
    binary_tokens: Vec<u32>,
    last_token_end: usize,
    token_type_overrides: &'a [TokenTypeMatcher],
    balanced_brackets: Option<&'a BalancedBracketSelectors>,
    merge_consecutive_binary: bool,
    fonts: Vec<FontInfo>,
    last_font_end: usize,
}

impl<'a> TokenHandler<'a> {
    pub(super) fn new(
        emit_binary: bool,
        line_text: &str,
        token_type_overrides: &'a [TokenTypeMatcher],
        balanced_brackets: Option<&'a BalancedBracketSelectors>,
    ) -> Self {
        Self {
            emit_binary,
            tokens: Vec::new(),
            binary_tokens: Vec::new(),
            last_token_end: 0,
            token_type_overrides,
            balanced_brackets,
            merge_consecutive_binary: !contains_rtl(line_text),
            fonts: Vec::new(),
            last_font_end: 0,
        }
    }

    pub(crate) fn handle(&mut self, scopes: Option<&AttributedScopeStack>, end_index: usize) {
        self.produce_tokens(scopes, end_index);
        self.produce_fonts(scopes, end_index);
    }

    fn produce_tokens(&mut self, scopes: Option<&AttributedScopeStack>, end_index: usize) {
        if self.last_token_end >= end_index {
            return;
        }

        if self.emit_binary {
            let mut metadata = scopes.map_or(EncodedTokenAttributes::default(), AttributedScopeStack::token_attributes);
            let mut contains_brackets = self.balanced_brackets.is_some_and(BalancedBracketSelectors::matches_always);

            let needs_scopes = !self.token_type_overrides.is_empty() || self.balanced_brackets.is_some_and(|b| !b.matches_always() && !b.matches_never());

            if needs_scopes {
                let scope_names = scopes.map(AttributedScopeStack::scope_names).unwrap_or_default();
                for override_rule in self.token_type_overrides {
                    if override_rule.matcher.matches_scopes(&scope_names) {
                        metadata = metadata.set(0, override_rule.token_type.into(), None, FontStyle::NOT_SET, 0, 0);
                    }
                }
                if let Some(bb) = self.balanced_brackets {
                    contains_brackets = bb.matches(&scope_names);
                }
            }

            if contains_brackets {
                metadata = metadata.set(0, OptionalStandardTokenType::NotSet, Some(true), FontStyle::NOT_SET, 0, 0);
            }

            let raw_meta = metadata.to_raw();
            if self.merge_consecutive_binary && self.binary_tokens.last().copied() == Some(raw_meta) {
                self.last_token_end = end_index;
                return;
            }

            self.binary_tokens.push(self.last_token_end as u32);
            self.binary_tokens.push(raw_meta);
            self.last_token_end = end_index;
            return;
        }

        let scope_names = scopes.map(AttributedScopeStack::scope_names).unwrap_or_default();
        self.tokens.push(Token {
            start_index: self.last_token_end,
            end_index,
            scopes: scope_names,
        });
        self.last_token_end = end_index;
    }

    fn produce_fonts(&mut self, scopes: Option<&AttributedScopeStack>, end_index: usize) {
        let Some(font_attrs) = scopes.map(AttributedScopeStack::font_attributes) else {
            self.last_font_end = end_index;
            return;
        };
        if font_attrs.font_family.is_none() && font_attrs.font_size.is_none() && font_attrs.line_height.is_none() {
            self.last_font_end = end_index;
            return;
        }
        let info = FontInfo {
            start_index: self.last_font_end,
            end_index,
            font_family: font_attrs.font_family.clone(),
            font_size_multiplier: font_attrs.font_size,
            line_height_multiplier: font_attrs.line_height,
        };
        if let Some(last) = self.fonts.last_mut()
            && last.end_index == self.last_font_end
            && last.options_equal(&info)
        {
            last.end_index = info.end_index;
        } else {
            self.fonts.push(info);
        }
        self.last_font_end = end_index;
    }

    pub(super) fn finish_tokens(mut self, stack: &StateStack, line_length: usize) -> (Vec<Token>, Vec<FontInfo>) {
        let orig_len = line_length.saturating_sub(1);
        if self.tokens.last().is_some_and(|t| t.start_index == orig_len) {
            self.tokens.pop();
        }
        if self.tokens.is_empty() {
            let scopes = stack.content_name_scopes().map(AttributedScopeStack::scope_names).unwrap_or_default();
            self.tokens.push(Token {
                start_index: 0,
                end_index: orig_len,
                scopes,
            });
        } else {
            for tok in &mut self.tokens {
                if tok.end_index > orig_len {
                    tok.end_index = orig_len;
                }
            }
        }
        let fonts = clamp_fonts(self.fonts, orig_len);
        (self.tokens, fonts)
    }

    pub(super) fn finish_binary(mut self, stack: &StateStack, line_length: usize) -> (Vec<u32>, Vec<FontInfo>) {
        let orig_len = line_length.saturating_sub(1);
        let len = self.binary_tokens.len();
        if len >= 2 && self.binary_tokens[len - 2] == orig_len as u32 {
            self.binary_tokens.pop();
            self.binary_tokens.pop();
        }
        if self.binary_tokens.is_empty() {
            self.last_token_end = 0;
            self.produce_tokens(stack.content_name_scopes(), line_length);
            if let Some(first) = self.binary_tokens.first_mut() {
                *first = 0;
            }
        }
        let fonts = clamp_fonts(self.fonts, orig_len);
        (self.binary_tokens, fonts)
    }
}

fn clamp_fonts(fonts: Vec<FontInfo>, orig_len: usize) -> Vec<FontInfo> {
    fonts
        .into_iter()
        .filter_map(|mut f| {
            f.end_index = f.end_index.min(orig_len);
            if f.start_index < f.end_index { Some(f) } else { None }
        })
        .collect()
}
