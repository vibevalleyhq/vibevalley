use std::time::{Duration, Instant};

use rustc_hash::FxHashMap;

use crate::error::RegexError;
use crate::grammar::{AttributedScopeStack, Grammar, Injection, StateStack, TokenHandler};
use crate::matcher::InjectionPriority;
use crate::regex_engine::{CaptureIndex, FindOption, RegexEngine, RegexScanner, RegexString};
use crate::rule::{BeginWhileRule, CaptureRule, CompiledRule, MatchTarget, Rule, RuleId};
use crate::theme::Theme;

/// Per-line transient metadata tracked alongside immutable `StateStack` frames.
#[derive(Debug, Clone, Copy)]
pub(crate) struct FrameLineMeta {
    pub enter_pos: Option<usize>,
    pub anchor_pos: Option<usize>,
}

/// Active tokenization stack during a single line: pairs immutable `StateStack` with
/// per-line transient `enter_pos` / `anchor_pos` metadata (matching `vscode-textmate`'s
/// `prevState.reset()` without mutating prior snapshots).
#[derive(Clone)]
pub(crate) struct ActiveStack {
    pub state: StateStack,
    pub meta: Vec<FrameLineMeta>,
}

pub(crate) struct PushFrame {
    pub rule_id: RuleId,
    pub enter_pos: usize,
    pub anchor_pos: Option<usize>,
    pub begin_rule_captured_eol: bool,
    pub end_rule: Option<String>,
    pub name_scopes: AttributedScopeStack,
    pub content_name_scopes: AttributedScopeStack,
}

impl ActiveStack {
    pub fn from_initial(state: StateStack) -> Self {
        let depth = state.depth();
        Self {
            state,
            meta: vec![
                FrameLineMeta {
                    enter_pos: None,
                    anchor_pos: None,
                };
                depth
            ],
        }
    }

    pub fn push(&mut self, frame: PushFrame) {
        self.state = self.state.push(
            frame.rule_id,
            frame.begin_rule_captured_eol,
            frame.end_rule,
            frame.name_scopes,
            frame.content_name_scopes,
        );
        self.meta.push(FrameLineMeta {
            enter_pos: Some(frame.enter_pos),
            anchor_pos: frame.anchor_pos,
        });
    }

    pub fn pop(&mut self) -> Option<(StateStack, FrameLineMeta)> {
        let parent = self.state.parent()?.clone();
        let popped_state = std::mem::replace(&mut self.state, parent);
        let popped_meta = self.meta.pop().unwrap_or(FrameLineMeta {
            enter_pos: None,
            anchor_pos: None,
        });
        Some((popped_state, popped_meta))
    }

    pub fn restore(&mut self, state: StateStack, meta: FrameLineMeta) {
        self.state = state;
        self.meta.push(meta);
    }

    pub fn safe_pop(&mut self) {
        if let Some(parent) = self.state.parent().cloned() {
            self.state = parent;
            self.meta.pop();
        }
    }

    pub fn truncate_to(&mut self, target: StateStack) {
        let depth = target.depth();
        self.state = target;
        self.meta.truncate(depth);
    }

    /// Checks whether `before_push` already contains `rule_id` entered at `enter_pos`
    /// without advancing, matching `StateStackImpl::hasSameRuleAs`.
    pub fn has_same_rule_as(&self, rule_id: RuleId, enter_pos: usize) -> bool {
        let mut cursor = Some(&self.state);
        let mut idx = self.meta.len();
        while let Some(node) = cursor {
            if idx == 0 {
                break;
            }
            idx -= 1;
            if self.meta[idx].enter_pos != Some(enter_pos) {
                break;
            }
            if node.rule_id() == Some(rule_id) {
                return true;
            }
            cursor = node.parent();
        }
        false
    }
}

pub(crate) struct TokenizeStringResult {
    pub stack: StateStack,
    pub stopped_early: bool,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn tokenize_string<E: RegexEngine>(
    grammar: &Grammar<E>,
    theme: &Theme,
    line_text: &E::String,
    mut is_first_line: bool,
    mut line_pos: usize,
    mut stack: ActiveStack,
    token_handler: &mut TokenHandler,
    check_while_conditions: bool,
    time_limit: Option<Duration>,
    scanner_caches: &mut FxHashMap<u64, <E::Scanner as RegexScanner>::Cache>,
) -> Result<TokenizeStringResult, RegexError> {
    let line_length = line_text.content().len();
    let mut anchor_position: Option<usize> = None;

    if check_while_conditions {
        let while_res = check_while_conditions_loop(grammar, theme, line_text, is_first_line, line_pos, stack, token_handler, scanner_caches)?;
        stack = while_res.stack;
        line_pos = while_res.line_pos;
        is_first_line = while_res.is_first_line;
        anchor_position = while_res.anchor_position;
    }

    let started = time_limit.map(|_| Instant::now());

    loop {
        if let (Some(limit), Some(start)) = (time_limit, started)
            && !limit.is_zero()
            && start.elapsed() > limit
        {
            return Ok(TokenizeStringResult {
                stack: stack.state,
                stopped_early: true,
            });
        }

        let matched = match_rule_or_injections(grammar, line_text, is_first_line, line_pos, &stack.state, anchor_position, scanner_caches)?;

        let Some(r) = matched else {
            token_handler.handle(stack.state.content_name_scopes(), line_length);
            break;
        };

        let capture_indices = r.capture_indices;
        let full = capture_indices.first().copied().flatten().unwrap_or(CaptureIndex::new(line_pos, line_pos));
        let has_advanced = full.end > line_pos;

        match r.target {
            MatchTarget::End | MatchTarget::While => {
                let rule_id = stack.state.rule_id().expect("end match only occurs inside BeginEndRule");
                let Rule::BeginEnd(popped_rule) = grammar.get_rule(rule_id) else {
                    token_handler.handle(stack.state.content_name_scopes(), line_length);
                    break;
                };

                token_handler.handle(stack.state.content_name_scopes(), full.start);
                if let Some(name_scopes) = stack.state.name_scopes().cloned() {
                    stack.state = stack.state.with_content_name_scopes(name_scopes);
                }
                handle_captures(
                    grammar,
                    theme,
                    line_text,
                    is_first_line,
                    &stack,
                    token_handler,
                    &popped_rule.end_captures,
                    &capture_indices,
                    scanner_caches,
                )?;
                token_handler.handle(stack.state.content_name_scopes(), full.end);

                let Some((popped_state, popped_meta)) = stack.pop() else {
                    token_handler.handle(stack.state.content_name_scopes(), line_length);
                    break;
                };
                anchor_position = popped_meta.anchor_pos;

                if !has_advanced && popped_meta.enter_pos == Some(line_pos) {
                    // Grammar pushed and popped without advancing: assume intent was to keep state.
                    stack.restore(popped_state, popped_meta);
                    token_handler.handle(stack.state.content_name_scopes(), line_length);
                    break;
                }
            }
            MatchTarget::Rule(matched_rule_id) => {
                let rule = grammar.get_rule(matched_rule_id);
                let line_str = line_text.content();

                token_handler.handle(stack.state.content_name_scopes(), full.start);

                let before_push_has_same = stack.has_same_rule_as(matched_rule_id, line_pos);
                let scope_name = rule.name(Some(line_str), Some(&capture_indices));
                let name_scopes =
                    stack
                        .state
                        .content_name_scopes()
                        .expect("active stack has scope list")
                        .push_attributed(scope_name.as_deref(), grammar, theme);

                stack.push(PushFrame {
                    rule_id: matched_rule_id,
                    enter_pos: line_pos,
                    anchor_pos: anchor_position,
                    begin_rule_captured_eol: full.end == line_length,
                    end_rule: None,
                    name_scopes: name_scopes.clone(),
                    content_name_scopes: name_scopes.clone(),
                });

                match rule {
                    Rule::BeginEnd(pushed_rule) => {
                        handle_captures(
                            grammar,
                            theme,
                            line_text,
                            is_first_line,
                            &stack,
                            token_handler,
                            &pushed_rule.begin_captures,
                            &capture_indices,
                            scanner_caches,
                        )?;
                        token_handler.handle(stack.state.content_name_scopes(), full.end);
                        anchor_position = Some(full.end);

                        let content_name = pushed_rule.content_name.resolve(Some(line_str), Some(&capture_indices));
                        let content_name_scopes = name_scopes.push_attributed(content_name.as_deref(), grammar, theme);
                        stack.state = stack.state.with_content_name_scopes(content_name_scopes);

                        if pushed_rule.end_has_back_references {
                            let resolved_end = pushed_rule.end.resolve_back_references(line_str, &capture_indices);
                            stack.state = stack.state.with_end_rule(resolved_end);
                        }

                        if !has_advanced && before_push_has_same {
                            stack.pop();
                            token_handler.handle(stack.state.content_name_scopes(), line_length);
                            break;
                        }
                    }
                    Rule::BeginWhile(pushed_rule) => {
                        handle_captures(
                            grammar,
                            theme,
                            line_text,
                            is_first_line,
                            &stack,
                            token_handler,
                            &pushed_rule.begin_captures,
                            &capture_indices,
                            scanner_caches,
                        )?;
                        token_handler.handle(stack.state.content_name_scopes(), full.end);
                        anchor_position = Some(full.end);

                        let content_name = pushed_rule.content_name.resolve(Some(line_str), Some(&capture_indices));
                        let content_name_scopes = name_scopes.push_attributed(content_name.as_deref(), grammar, theme);
                        stack.state = stack.state.with_content_name_scopes(content_name_scopes);

                        if pushed_rule.while_has_back_references {
                            let resolved_while = pushed_rule.while_source.resolve_back_references(line_str, &capture_indices);
                            stack.state = stack.state.with_end_rule(resolved_while);
                        }

                        if !has_advanced && before_push_has_same {
                            stack.pop();
                            token_handler.handle(stack.state.content_name_scopes(), line_length);
                            break;
                        }
                    }
                    Rule::Match(matching_rule) => {
                        handle_captures(
                            grammar,
                            theme,
                            line_text,
                            is_first_line,
                            &stack,
                            token_handler,
                            &matching_rule.captures,
                            &capture_indices,
                            scanner_caches,
                        )?;
                        token_handler.handle(stack.state.content_name_scopes(), full.end);
                        stack.pop();

                        if !has_advanced {
                            stack.safe_pop();
                            token_handler.handle(stack.state.content_name_scopes(), line_length);
                            break;
                        }
                    }
                    Rule::IncludeOnly(_) | Rule::Capture(_) => {
                        stack.pop();
                        if !has_advanced {
                            stack.safe_pop();
                            token_handler.handle(stack.state.content_name_scopes(), line_length);
                            break;
                        }
                    }
                }
            }
        }

        if full.end > line_pos {
            line_pos = full.end;
            is_first_line = false;
        }
    }

    Ok(TokenizeStringResult {
        stack: stack.state,
        stopped_early: false,
    })
}

struct WhileCheckResult {
    stack: ActiveStack,
    line_pos: usize,
    anchor_position: Option<usize>,
    is_first_line: bool,
}

#[allow(clippy::too_many_arguments)]
fn check_while_conditions_loop<E: RegexEngine>(
    grammar: &Grammar<E>,
    theme: &Theme,
    line_text: &E::String,
    mut is_first_line: bool,
    mut line_pos: usize,
    mut stack: ActiveStack,
    token_handler: &mut TokenHandler,
    scanner_caches: &mut FxHashMap<u64, <E::Scanner as RegexScanner>::Cache>,
) -> Result<WhileCheckResult, RegexError> {
    let mut anchor_position = if stack.state.begin_rule_captured_eol() { Some(0) } else { None };

    let mut while_frames: Vec<(StateStack, &BeginWhileRule<E>)> = Vec::new();
    let mut cursor = Some(stack.state.clone());
    while let Some(node) = cursor {
        if let Some(rule_id) = node.rule_id()
            && let Rule::BeginWhile(while_rule) = grammar.get_rule(rule_id)
        {
            while_frames.push((node.clone(), while_rule));
        }
        cursor = node.parent().cloned();
    }

    while let Some((frame_stack, while_rule)) = while_frames.pop() {
        let allow_g = anchor_position == Some(line_pos);
        let (compiled, find_options) = prepare_rule_while_search(while_rule, grammar, frame_stack.end_rule(), is_first_line, allow_g)?;
        let cache = scanner_caches.entry(compiled.id).or_insert_with(|| compiled.create_cache());
        let matched = compiled.find_next_match(line_text, line_pos, find_options, cache);

        if let Some(r) = matched {
            if r.target != MatchTarget::While {
                if let Some(parent) = frame_stack.parent().cloned() {
                    stack.truncate_to(parent);
                }
                break;
            }
            if let Some(full) = r.capture_indices.first().copied().flatten() {
                token_handler.handle(frame_stack.content_name_scopes(), full.start);
                let temp_active = ActiveStack::from_initial(frame_stack.clone());
                handle_captures(
                    grammar,
                    theme,
                    line_text,
                    is_first_line,
                    &temp_active,
                    token_handler,
                    &while_rule.while_captures,
                    &r.capture_indices,
                    scanner_caches,
                )?;
                token_handler.handle(frame_stack.content_name_scopes(), full.end);
                anchor_position = Some(full.end);
                if full.end > line_pos {
                    line_pos = full.end;
                    is_first_line = false;
                }
            }
        } else {
            if let Some(parent) = frame_stack.parent().cloned() {
                stack.truncate_to(parent);
            }
            break;
        }
    }

    Ok(WhileCheckResult {
        stack,
        line_pos,
        anchor_position,
        is_first_line,
    })
}

struct MatchResult {
    target: MatchTarget,
    capture_indices: Vec<Option<CaptureIndex>>,
}

struct InjectionMatchResult {
    priority_match: bool,
    target: MatchTarget,
    capture_indices: Vec<Option<CaptureIndex>>,
}

fn match_rule_or_injections<E: RegexEngine>(
    grammar: &Grammar<E>,
    line_text: &E::String,
    is_first_line: bool,
    line_pos: usize,
    stack: &StateStack,
    anchor_position: Option<usize>,
    scanner_caches: &mut FxHashMap<u64, <E::Scanner as RegexScanner>::Cache>,
) -> Result<Option<MatchResult>, RegexError> {
    let match_result = match_rule(grammar, line_text, is_first_line, line_pos, stack, anchor_position, scanner_caches)?;

    let injections = grammar.injections();
    if injections.is_empty() {
        return Ok(match_result);
    }

    let injection_result = match_injections(injections, grammar, line_text, is_first_line, line_pos, stack, anchor_position, scanner_caches)?;

    let Some(inj) = injection_result else {
        return Ok(match_result);
    };
    let Some(normal) = match_result else {
        return Ok(Some(MatchResult {
            target: inj.target,
            capture_indices: inj.capture_indices,
        }));
    };

    let normal_score = normal.capture_indices.first().copied().flatten().map_or(usize::MAX, |c| c.start);
    let inj_score = inj.capture_indices.first().copied().flatten().map_or(usize::MAX, |c| c.start);

    if inj_score < normal_score || (inj.priority_match && inj_score == normal_score) {
        Ok(Some(MatchResult {
            target: inj.target,
            capture_indices: inj.capture_indices,
        }))
    } else {
        Ok(Some(normal))
    }
}

fn match_rule<E: RegexEngine>(
    grammar: &Grammar<E>,
    line_text: &E::String,
    is_first_line: bool,
    line_pos: usize,
    stack: &StateStack,
    anchor_position: Option<usize>,
    scanner_caches: &mut FxHashMap<u64, <E::Scanner as RegexScanner>::Cache>,
) -> Result<Option<MatchResult>, RegexError> {
    let Some(rule_id) = stack.rule_id() else {
        return Ok(None);
    };
    let rule = grammar.get_rule(rule_id);
    let allow_g = anchor_position == Some(line_pos);
    let (compiled, find_options) = prepare_rule_search(rule, grammar, stack.end_rule(), is_first_line, allow_g)?;
    let cache = scanner_caches.entry(compiled.id).or_insert_with(|| compiled.create_cache());
    let matched = compiled.find_next_match(line_text, line_pos, find_options, cache);
    Ok(matched.map(|m| MatchResult {
        target: m.target,
        capture_indices: m.capture_indices,
    }))
}

#[allow(clippy::too_many_arguments)]
fn match_injections<E: RegexEngine>(
    injections: &[Injection],
    grammar: &Grammar<E>,
    line_text: &E::String,
    is_first_line: bool,
    line_pos: usize,
    stack: &StateStack,
    anchor_position: Option<usize>,
    scanner_caches: &mut FxHashMap<u64, <E::Scanner as RegexScanner>::Cache>,
) -> Result<Option<InjectionMatchResult>, RegexError> {
    let scopes = stack.content_name_scopes().map(AttributedScopeStack::scope_names).unwrap_or_default();

    let mut best_rating = usize::MAX;
    let mut best_captures: Option<Vec<Option<CaptureIndex>>> = None;
    let mut best_target = MatchTarget::End;
    let mut best_priority = InjectionPriority::Default;
    let allow_g = anchor_position == Some(line_pos);

    for injection in injections {
        if !injection.matcher.matches_scopes(&scopes) {
            continue;
        }
        let rule = grammar.get_rule(injection.rule_id);
        let (compiled, find_options) = prepare_rule_search(rule, grammar, None, is_first_line, allow_g)?;
        let cache = scanner_caches.entry(compiled.id).or_insert_with(|| compiled.create_cache());
        let Some(matched) = compiled.find_next_match(line_text, line_pos, find_options, cache) else {
            continue;
        };

        let rating = matched.capture_indices.first().copied().flatten().map_or(usize::MAX, |c| c.start);
        if rating >= best_rating {
            continue;
        }

        best_rating = rating;
        best_captures = Some(matched.capture_indices);
        best_target = matched.target;
        best_priority = injection.priority;

        if best_rating == line_pos {
            break;
        }
    }

    Ok(best_captures.map(|capture_indices| InjectionMatchResult {
        priority_match: best_priority == InjectionPriority::Left,
        target: best_target,
        capture_indices,
    }))
}

fn prepare_rule_search<E: RegexEngine>(
    rule: &Rule<E>,
    grammar: &Grammar<E>,
    end_regex_source: Option<&str>,
    allow_a: bool,
    allow_g: bool,
) -> Result<(std::sync::Arc<CompiledRule<E>>, FindOption), RegexError> {
    let compiled = rule.compile_for_search(grammar.rules(), grammar.engine(), end_regex_source, allow_a, allow_g)?;
    let options = if grammar.engine().supports_find_options() {
        find_options_for(allow_a, allow_g)
    } else {
        FindOption::NONE
    };
    Ok((compiled, options))
}

fn prepare_rule_while_search<E: RegexEngine>(
    rule: &BeginWhileRule<E>,
    grammar: &Grammar<E>,
    while_regex_source: Option<&str>,
    allow_a: bool,
    allow_g: bool,
) -> Result<(std::sync::Arc<CompiledRule<E>>, FindOption), RegexError> {
    let compiled = rule.compile_while(grammar.engine(), while_regex_source, allow_a, allow_g)?;
    let options = if grammar.engine().supports_find_options() {
        find_options_for(allow_a, allow_g)
    } else {
        FindOption::NONE
    };
    Ok((compiled, options))
}

fn find_options_for(allow_a: bool, allow_g: bool) -> FindOption {
    let mut opts = FindOption::NONE;
    if !allow_a {
        opts |= FindOption::NOT_BEGIN_STRING;
    }
    if !allow_g {
        opts |= FindOption::NOT_BEGIN_POSITION;
    }
    opts
}

struct LocalStackElement {
    scopes: AttributedScopeStack,
    end_pos: usize,
}

#[allow(clippy::too_many_arguments)]
fn handle_captures<E: RegexEngine>(
    grammar: &Grammar<E>,
    theme: &Theme,
    line_text: &E::String,
    is_first_line: bool,
    stack: &ActiveStack,
    token_handler: &mut TokenHandler,
    captures: &[Option<CaptureRule>],
    capture_indices: &[Option<CaptureIndex>],
    scanner_caches: &mut FxHashMap<u64, <E::Scanner as RegexScanner>::Cache>,
) -> Result<(), RegexError> {
    if captures.is_empty() {
        return Ok(());
    }

    let line_str = line_text.content();
    let len = captures.len().min(capture_indices.len());
    let max_end = capture_indices.first().copied().flatten().map_or(0, |c| c.end);
    let mut local_stack: Vec<LocalStackElement> = Vec::new();

    for i in 0..len {
        let Some(capture_rule) = &captures[i] else {
            continue;
        };
        let Some(capture_index) = capture_indices[i] else {
            continue;
        };
        if capture_index.is_empty() {
            continue;
        }
        if capture_index.start > max_end {
            break;
        }

        while let Some(top) = local_stack.last()
            && top.end_pos <= capture_index.start
        {
            token_handler.handle(Some(&top.scopes), top.end_pos);
            local_stack.pop();
        }

        if let Some(top) = local_stack.last() {
            token_handler.handle(Some(&top.scopes), capture_index.start);
        } else {
            token_handler.handle(stack.state.content_name_scopes(), capture_index.start);
        }

        if let Some(retok_rule_id) = capture_rule.retokenize_captured_with_rule_id {
            let base_scopes = stack.state.content_name_scopes().expect("capture retokenization requires active scope list");
            let scope_name = capture_rule.name.resolve(Some(line_str), Some(capture_indices));
            let name_scopes = base_scopes.push_attributed(scope_name.as_deref(), grammar, theme);
            let content_name = capture_rule.content_name.resolve(Some(line_str), Some(capture_indices));
            let content_name_scopes = name_scopes.push_attributed(content_name.as_deref(), grammar, theme);

            let mut sub_stack = stack.clone();
            sub_stack.push(PushFrame {
                rule_id: retok_rule_id,
                enter_pos: capture_index.start,
                anchor_pos: None,
                begin_rule_captured_eol: false,
                end_rule: None,
                name_scopes,
                content_name_scopes,
            });
            let sub_str = grammar.engine().create_string(line_str[..capture_index.end].to_string());
            tokenize_string(
                grammar,
                theme,
                &sub_str,
                is_first_line && capture_index.start == 0,
                capture_index.start,
                sub_stack,
                token_handler,
                false,
                None,
                scanner_caches,
            )?;
            continue;
        }

        let capture_scope_name = capture_rule.name.resolve(Some(line_str), Some(capture_indices));
        if let Some(scope_name) = capture_scope_name {
            let base = local_stack
                .last()
                .map(|el| &el.scopes)
                .or_else(|| stack.state.content_name_scopes())
                .expect("capture push requires active scope list");
            let pushed = base.push_attributed(Some(&scope_name), grammar, theme);
            local_stack.push(LocalStackElement {
                scopes: pushed,
                end_pos: capture_index.end,
            });
        }
    }

    while let Some(top) = local_stack.pop() {
        token_handler.handle(Some(&top.scopes), top.end_pos);
    }

    Ok(())
}
