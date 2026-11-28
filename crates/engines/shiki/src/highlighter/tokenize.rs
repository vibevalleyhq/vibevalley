use rustc_hash::FxHashMap;

use super::engine::Highlighter;
use super::options::{
    ExplanationMode, GrammarState, HighlightOptions, ThemeInput, ThemedToken, ThemedTokenExplanation, ThemedTokenScopeExplanation, apply_color_replacement,
    is_plain_lang,
};
use crate::encoded_attrs::{EncodedTokenAttributes, FontStyle, OptionalStandardTokenType};
use crate::error::ShikiError;
use crate::grammar::{Grammar, StateStack};
use crate::regex_engine::RegexEngine;
use crate::theme::{RawThemeSetting, ResolvedTheme, ScopePatternList, ScopeStack, Theme};

impl<E: RegexEngine> Highlighter<E> {
    /// Single-scan multi-theme optimization matching Shiki's `tokenizeWithThemes`.
    #[allow(clippy::type_complexity)]
    pub(super) fn try_tokenize_multi_single_scan(
        &self,
        code: &str,
        lang: &str,
        themes: &[(String, ThemeInput)],
        options: &HighlightOptions,
    ) -> Result<Option<Vec<(Vec<Vec<ThemedToken>>, GrammarState, String)>>, ShikiError> {
        let resolved_lang = self.resolve_lang_alias(lang);
        if is_plain_lang(&resolved_lang) || options.include_explanation != ExplanationMode::Off {
            return Ok(None);
        }

        let mut loaded_themes = Vec::with_capacity(themes.len());
        for (_, input) in themes {
            let Some(pair) = self.resolve_theme_input(input)? else {
                return Ok(None);
            };
            loaded_themes.push(pair);
        }

        let language = self.lookup_language(&resolved_lang)?;
        if language.grammar.has_token_type_overrides() {
            return Ok(None);
        }

        if let Some(gs) = &options.grammar_state
            && (gs.lang != language.name || !loaded_themes.iter().all(|(r, _)| gs.stack_for(&r.name).is_some()))
        {
            return Ok(None);
        }

        let max_len = options.tokenize_max_line_length;
        let lines = split_lines(code);
        let context_lines = if options.grammar_state.is_none() {
            options.grammar_context_code.as_deref().map(split_lines).unwrap_or_default()
        } else {
            Vec::new()
        };

        let first_theme = &loaded_themes[0];
        let mut stack = if let Some(gs) = &options.grammar_state {
            gs.stack_for(&first_theme.0.name).cloned().unwrap_or_else(StateStack::initial)
        } else if !context_lines.is_empty() {
            let mut s = StateStack::initial();
            for (ctx_line, _) in &context_lines {
                if ctx_line.is_empty() || (max_len > 0 && ctx_line.len() >= max_len) {
                    continue;
                }
                let res = language
                    .grammar
                    .tokenize_line_with_theme(ctx_line, Some(&s), &first_theme.1, options.tokenize_time_limit)?;
                s = res.rule_stack;
            }
            s
        } else {
            StateStack::initial()
        };

        // Single grammar scan collecting raw scope tokens once for all themes.
        let mut scanned_lines: Vec<Option<Vec<(usize, Vec<String>)>>> = Vec::with_capacity(lines.len());
        for (line, _) in &lines {
            if line.is_empty() || (max_len > 0 && line.len() >= max_len) {
                scanned_lines.push(None);
                continue;
            }
            let res = language
                .grammar
                .tokenize_line_with_theme(line, Some(&stack), &first_theme.1, options.tokenize_time_limit)?;
            let line_tokens = res.tokens.into_iter().map(|t| (t.start_index, t.scopes)).collect();
            scanned_lines.push(Some(line_tokens));
            stack = res.rule_stack;
        }

        let brackets = language.grammar.balanced_bracket_selectors();
        let default_lang_id = language.grammar.default_basic_attributes().language_id;

        let mut outputs = Vec::with_capacity(loaded_themes.len());
        for (theme_idx, (resolved_theme, compiled_theme)) in loaded_themes.iter().enumerate() {
            let color_map = compiled_theme.color_map();
            let repl = options.color_replacements.resolve_for(resolved_theme);
            let defaults = compiled_theme.defaults();
            let root_attrs = EncodedTokenAttributes::default().set(
                default_lang_id,
                OptionalStandardTokenType::NotSet,
                None,
                defaults.font_style,
                defaults.foreground_id,
                defaults.background_id,
            );

            let mut scope_attr_cache: FxHashMap<Vec<String>, u32> = FxHashMap::default();
            let mut themed_lines = Vec::with_capacity(lines.len());

            for (i, (line, line_offset)) in lines.iter().enumerate() {
                let Some(line_tokens) = &scanned_lines[i] else {
                    if line.is_empty() {
                        themed_lines.push(Vec::new());
                    } else {
                        themed_lines.push(vec![ThemedToken {
                            content: (*line).to_string(),
                            offset: *line_offset,
                            color: Some(String::new()),
                            bg_color: None,
                            font_style: Some(FontStyle::NONE),
                            token_type: None,
                            html_style: None,
                            explanation: None,
                        }]);
                    }
                    continue;
                };

                let mut actual = Vec::new();
                let mut cur_start: Option<usize> = None;
                let mut cur_meta: u32 = 0;

                for (start_index, scopes) in line_tokens {
                    let meta = *scope_attr_cache.entry(scopes.clone()).or_insert_with(|| {
                        let mut attrs = root_attrs;
                        let mut path: Option<ScopeStack> = None;
                        for scope in scopes {
                            let basic = language.grammar.metadata_for_scope(scope);
                            path = Some(ScopeStack::new(path, scope.clone()));
                            let style = compiled_theme.match_scope(path.as_ref());
                            let (fs, fg, bg) = match style {
                                Some(st) => (st.font_style, st.foreground_id, st.background_id),
                                None => (FontStyle::NOT_SET, 0, 0),
                            };
                            attrs = attrs.set(basic.language_id, basic.token_type, None, fs, fg, bg);
                        }
                        if brackets.is_some_and(|b| b.matches_always() || b.matches(scopes)) {
                            attrs = attrs.set(0, OptionalStandardTokenType::NotSet, Some(true), FontStyle::NOT_SET, 0, 0);
                        }
                        attrs.to_raw()
                    });

                    if let Some(prev_start) = cur_start {
                        if meta == cur_meta {
                            continue;
                        }
                        if prev_start < *start_index {
                            actual.push(token_from_meta(
                                line,
                                *line_offset,
                                prev_start,
                                *start_index,
                                EncodedTokenAttributes(cur_meta),
                                color_map,
                                &repl,
                            ));
                        }
                    }
                    cur_start = Some(*start_index);
                    cur_meta = meta;
                }

                if let Some(prev_start) = cur_start
                    && prev_start < line.len()
                {
                    actual.push(token_from_meta(
                        line,
                        *line_offset,
                        prev_start,
                        line.len(),
                        EncodedTokenAttributes(cur_meta),
                        color_map,
                        &repl,
                    ));
                }
                themed_lines.push(actual);
            }

            let theme_stack = if theme_idx == 0 {
                stack.clone()
            } else {
                stack.restack_for_theme(&language.grammar, compiled_theme)
            };
            let state = GrammarState::new(language.name.clone(), resolved_theme.name.clone(), theme_stack);
            outputs.push((themed_lines, state, resolved_theme.name.clone()));
        }

        Ok(Some(outputs))
    }
}

pub(super) fn plain_token(line: &str, offset: usize) -> ThemedToken {
    ThemedToken {
        content: line.to_string(),
        offset,
        color: None,
        bg_color: None,
        font_style: None,
        token_type: None,
        html_style: None,
        explanation: None,
    }
}

fn token_from_meta(
    line: &str,
    line_offset: usize,
    start: usize,
    end: usize,
    attrs: EncodedTokenAttributes,
    color_map: &[String],
    repl: &FxHashMap<String, String>,
) -> ThemedToken {
    let fg_raw = color_map.get(attrs.foreground() as usize).map(String::as_str);
    let color = apply_color_replacement(fg_raw, repl);
    ThemedToken {
        content: line[start..end].to_string(),
        offset: line_offset + start,
        color,
        bg_color: None,
        font_style: Some(attrs.font_style()),
        token_type: None,
        html_style: None,
        explanation: None,
    }
}

pub(super) fn tokenize_with_single_theme<E: RegexEngine>(
    code: &str,
    grammar: &Grammar<E>,
    resolved_theme: &ResolvedTheme,
    compiled_theme: &Theme,
    options: &HighlightOptions,
) -> Result<(Vec<Vec<ThemedToken>>, StateStack), ShikiError> {
    let repl = options.color_replacements.resolve_for(resolved_theme);
    let color_map = compiled_theme.color_map();
    let lines = split_lines(code);

    let mut state_stack = if let Some(gs) = &options.grammar_state {
        gs.stack_for(&resolved_theme.name).cloned().unwrap_or_else(StateStack::initial)
    } else if let Some(ctx_code) = &options.grammar_context_code {
        let mut ctx_opts = options.clone();
        ctx_opts.grammar_state = None;
        ctx_opts.grammar_context_code = None;
        tokenize_with_single_theme(ctx_code, grammar, resolved_theme, compiled_theme, &ctx_opts)?.1
    } else {
        StateStack::initial()
    };

    let theme_selectors = if options.include_explanation == ExplanationMode::Full {
        build_theme_settings_selectors(&resolved_theme.settings)
    } else {
        Vec::new()
    };

    let mut final_lines = Vec::with_capacity(lines.len());

    for (line, line_offset) in lines {
        if line.is_empty() {
            final_lines.push(Vec::new());
            continue;
        }
        if options.tokenize_max_line_length > 0 && line.len() >= options.tokenize_max_line_length {
            final_lines.push(vec![ThemedToken {
                content: line.to_string(),
                offset: line_offset,
                color: Some(String::new()),
                bg_color: None,
                font_style: Some(FontStyle::NONE),
                token_type: None,
                html_style: None,
                explanation: None,
            }]);
            continue;
        }

        let need_scope_tokens = matches!(options.include_explanation, ExplanationMode::ScopeName | ExplanationMode::Full);
        let scope_tokens = if need_scope_tokens {
            Some(
                grammar
                    .tokenize_line_with_theme(line, Some(&state_stack), compiled_theme, options.tokenize_time_limit)?
                    .tokens,
            )
        } else {
            None
        };
        let mut scope_tok_idx = 0usize;

        let binary = grammar.tokenize_line2_with_theme(line, Some(&state_stack), compiled_theme, options.tokenize_time_limit)?;
        let token_count = binary.tokens.len() / 2;
        let mut actual = Vec::with_capacity(token_count);

        for j in 0..token_count {
            let start = binary.tokens[2 * j] as usize;
            let next_start = if j + 1 < token_count { binary.tokens[2 * j + 2] as usize } else { line.len() };
            if start >= next_start || start >= line.len() {
                continue;
            }
            let end = next_start.min(line.len());
            let attrs = EncodedTokenAttributes(binary.tokens[2 * j + 1]);
            let mut token = token_from_meta(line, line_offset, start, end, attrs, color_map, &repl);

            match options.include_explanation {
                ExplanationMode::Off => {}
                ExplanationMode::TokenType => {
                    token.token_type = Some(attrs.token_type());
                }
                ExplanationMode::ScopeName | ExplanationMode::Full => {
                    let mut explanations = Vec::new();
                    let mut covered = 0usize;
                    if let Some(s_tokens) = &scope_tokens {
                        while start + covered < end && scope_tok_idx < s_tokens.len() {
                            let st = &s_tokens[scope_tok_idx];
                            let piece = &line[st.start_index..st.end_index.min(line.len())];
                            covered += piece.len();
                            let scopes = if options.include_explanation == ExplanationMode::ScopeName {
                                st.scopes
                                    .iter()
                                    .map(|s| ThemedTokenScopeExplanation {
                                        scope_name: s.clone(),
                                        theme_matches: Vec::new(),
                                    })
                                    .collect()
                            } else {
                                explain_theme_scopes_full(&theme_selectors, &st.scopes)
                            };
                            explanations.push(ThemedTokenExplanation {
                                content: piece.to_string(),
                                scopes,
                            });
                            scope_tok_idx += 1;
                        }
                    }
                    token.explanation = Some(explanations);
                }
            }

            actual.push(token);
        }

        final_lines.push(actual);
        state_stack = binary.rule_stack;
    }

    Ok((final_lines, state_stack))
}

struct ThemeSettingsSelector {
    setting: RawThemeSetting,
    selectors: Vec<Vec<String>>,
}

fn build_theme_settings_selectors(settings: &[RawThemeSetting]) -> Vec<ThemeSettingsSelector> {
    let mut out = Vec::new();
    for setting in settings {
        let selectors: Vec<String> = match &setting.scope {
            Some(ScopePatternList::Single(s)) => s.split(',').map(|p| p.trim().to_string()).collect(),
            Some(ScopePatternList::Multiple(list)) => list.clone(),
            None => continue,
        };
        let parsed = selectors.into_iter().map(|sel| sel.split(' ').map(str::to_string).collect()).collect();
        out.push(ThemeSettingsSelector {
            setting: setting.clone(),
            selectors: parsed,
        });
    }
    out
}

fn explain_theme_scopes_full(selectors: &[ThemeSettingsSelector], scopes: &[String]) -> Vec<ThemedTokenScopeExplanation> {
    scopes
        .iter()
        .enumerate()
        .map(|(i, scope)| {
            let parents = &scopes[..i];
            let mut matches = Vec::new();
            for entry in selectors {
                if entry.selectors.iter().any(|pieces| scope_pieces_match(pieces, scope, parents)) {
                    matches.push(entry.setting.clone());
                }
            }
            ThemedTokenScopeExplanation {
                scope_name: scope.clone(),
                theme_matches: matches,
            }
        })
        .collect()
}

fn scope_pieces_match(pieces: &[String], scope: &str, parent_scopes: &[String]) -> bool {
    let Some(last) = pieces.last() else {
        return false;
    };
    if !matches_one_scope(last, scope) {
        return false;
    }
    if pieces.len() == 1 {
        return true;
    }
    let mut sel_idx: isize = pieces.len() as isize - 2;
    let mut par_idx: isize = parent_scopes.len() as isize - 1;
    while sel_idx >= 0 && par_idx >= 0 {
        if matches_one_scope(&pieces[sel_idx as usize], &parent_scopes[par_idx as usize]) {
            sel_idx -= 1;
        }
        par_idx -= 1;
    }
    sel_idx == -1
}

fn matches_one_scope(selector: &str, scope: &str) -> bool {
    selector == scope || (scope.len() > selector.len() && scope.as_bytes()[selector.len()] == b'.' && scope.starts_with(selector))
}

/// Splits `code` into `(line_slice, start_byte_offset)` pairs handling `\r\n`, `\n`, and `\r`,
/// matching Shiki's `splitLines`.
pub fn split_lines(code: &str) -> Vec<(&str, usize)> {
    let bytes = code.as_bytes();
    let len = bytes.len();
    let mut lines = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;

    while i < len {
        if bytes[i] == b'\r' {
            lines.push((&code[start..i], start));
            if i + 1 < len && bytes[i + 1] == b'\n' {
                i += 2;
            } else {
                i += 1;
            }
            start = i;
        } else if bytes[i] == b'\n' {
            lines.push((&code[start..i], start));
            i += 1;
            start = i;
        } else {
            i += 1;
        }
    }
    lines.push((&code[start..], start));
    lines
}
