use std::time::Duration;

use rustc_hash::FxHashMap;

use crate::error::RegexError;
use crate::regex_engine::RegexEngine;
use crate::theme::Theme;

use super::tokenize::{ActiveStack, tokenize_string};
use super::tokens::{TokenHandler, TokenizeLineResult, TokenizeLineResult2};
use super::types::{Grammar, StateStack};

impl<E: RegexEngine> Grammar<E> {
    /// Tokenizes a single line (without trailing `\n`) into scope-annotated tokens using
    /// the registry's currently active theme.
    pub fn tokenize_line(&self, line_text: &str, prev_state: Option<&StateStack>, time_limit: Option<Duration>) -> Result<TokenizeLineResult, RegexError> {
        let theme = self.current_theme();
        self.tokenize_line_with_theme(line_text, prev_state, &theme, time_limit)
    }

    /// Tokenizes a single line into bit-packed binary tokens using the registry's active theme.
    pub fn tokenize_line2(&self, line_text: &str, prev_state: Option<&StateStack>, time_limit: Option<Duration>) -> Result<TokenizeLineResult2, RegexError> {
        let theme = self.current_theme();
        self.tokenize_line2_with_theme(line_text, prev_state, &theme, time_limit)
    }

    /// Tokenizes a single line into scope-annotated tokens against an explicit `Theme`
    /// without mutating shared registry state.
    pub fn tokenize_line_with_theme(
        &self,
        line_text: &str,
        prev_state: Option<&StateStack>,
        theme: &Theme,
        time_limit: Option<Duration>,
    ) -> Result<TokenizeLineResult, RegexError> {
        let (line_length, handler, rule_stack, stopped_early) = self.tokenize_inner(line_text, prev_state, theme, false, time_limit)?;
        let (tokens, fonts) = handler.finish_tokens(&rule_stack, line_length);
        Ok(TokenizeLineResult {
            tokens,
            fonts,
            rule_stack,
            stopped_early,
        })
    }

    /// Tokenizes a single line into bit-packed binary tokens against an explicit `Theme`.
    pub fn tokenize_line2_with_theme(
        &self,
        line_text: &str,
        prev_state: Option<&StateStack>,
        theme: &Theme,
        time_limit: Option<Duration>,
    ) -> Result<TokenizeLineResult2, RegexError> {
        let (line_length, handler, rule_stack, stopped_early) = self.tokenize_inner(line_text, prev_state, theme, true, time_limit)?;
        let (tokens, fonts) = handler.finish_binary(&rule_stack, line_length);
        Ok(TokenizeLineResult2 {
            tokens,
            fonts,
            rule_stack,
            stopped_early,
        })
    }

    fn tokenize_inner(
        &self,
        line_text: &str,
        prev_state: Option<&StateStack>,
        theme: &Theme,
        emit_binary: bool,
        time_limit: Option<Duration>,
    ) -> Result<(usize, TokenHandler<'_>, StateStack, bool), RegexError> {
        let (is_first_line, initial_stack) = match prev_state {
            None => (true, self.make_initial_state(theme)),
            Some(st) if st.is_initial() => (true, self.make_initial_state(theme)),
            Some(st) => (false, st.clone()),
        };

        let mut with_newline = String::with_capacity(line_text.len() + 1);
        with_newline.push_str(line_text);
        with_newline.push('\n');
        let line_length = with_newline.len();

        let mut token_handler = TokenHandler::new(emit_binary, &with_newline, self.token_type_matchers(), self.balanced_bracket_selectors());
        let engine_string = self.engine().create_string(with_newline);
        let mut scanner_caches = FxHashMap::default();
        let active = ActiveStack::from_initial(initial_stack);

        let result = tokenize_string(
            self,
            theme,
            &engine_string,
            is_first_line,
            0,
            active,
            &mut token_handler,
            true,
            time_limit,
            &mut scanner_caches,
        )?;

        Ok((line_length, token_handler, result.stack, result.stopped_early))
    }
}
