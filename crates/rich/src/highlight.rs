//! Pure-Rust syntax highlighting powered by `vibevalley-shiki` (`vibevalley-onig`).
//!
//! Serves three consumers from one shared grammar/theme registry:
//! 1. `VvCodeBlock` (full color + font-style spans reacting to light/dark mode, with LRU cache).
//! 2. `nsh_base::editor` (`<Editor>` and `<DiffView>`) via [`ShikiEditorHighlighter`] registered
//!    in [`register_shiki_editor_highlighters`], keeping highlighting 100% functional even with
//!    `nsh-base/highlight` (`syntect`/`two-face`/`onig_sys`) disabled.
//! 3. Theme-independent line tokenization via [`tokenize_scopes`] for viewers that map scopes
//!    to palette tokens at render time.

use std::collections::BTreeMap;
use std::ops::Range;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use nsh_base::editor::{EditorHighlighter, EditorText, EditorTextEdit, EditorToken, EditorTokens, register_highlighter, register_language};
use vibevalley_shiki::{
    FontStyle, Grammar, Highlighter, OnigEngine, RawGrammar, RawTheme, Rgba, ShikiError, StateStack, StyledSpan, Theme, is_plain_lang, parse_grammar_json,
    parse_theme_json, split_lines,
};

use crate::cache::{CacheStats, LruCache, hash_str};
use crate::grammars::{BUNDLED_GRAMMARS, MERMAID_LANGUAGE};
use crate::theme::{SHIKI_DARK_THEME, SHIKI_LIGHT_THEME, vv_shiki_dark_theme, vv_shiki_light_theme};

/// Per-line tokenization time cap so pathological inputs never stall the engine or editor thread.
const LINE_TIME_LIMIT: Duration = Duration::from_millis(250);
/// Save an incremental grammar `StateStack` checkpoint every N lines for fast local re-tokenization.
const CHECKPOINT_INTERVAL: usize = 64;
/// Maximum number of highlighted code blocks kept in the process-wide LRU cache.
const CODE_CACHE_CAPACITY: usize = 128;
/// Number of fallback background threads used when no ambient Tokio runtime is active.
const OFFLOAD_WORKERS: usize = 2;

type OffloadJob = Box<dyn FnOnce() + Send + 'static>;

fn offload_sender() -> &'static std::sync::mpsc::Sender<OffloadJob> {
    static SENDER: OnceLock<std::sync::mpsc::Sender<OffloadJob>> = OnceLock::new();
    SENDER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<OffloadJob>();
        let rx = Arc::new(Mutex::new(rx));
        for _ in 0..OFFLOAD_WORKERS {
            let worker_rx = Arc::clone(&rx);
            std::thread::Builder::new()
                .name("vv-rich-offload".to_owned())
                .spawn(move || {
                    loop {
                        let job = {
                            let guard = worker_rx.lock().unwrap_or_else(|p| p.into_inner());
                            guard.recv()
                        };
                        match job {
                            Ok(job) => job(),
                            Err(_) => break,
                        }
                    }
                })
                .expect("spawn vv-rich-offload worker thread");
        }
        tx
    })
}

/// Runs `f` on a background worker thread without requiring an ambient Tokio runtime.
///
/// Uses `Handle::spawn_blocking` inside Tokio and otherwise dispatches onto the `"vv-rich-offload"`
/// OS thread pool awaited through a runtime-agnostic oneshot channel.
pub(crate) async fn run_offloaded<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        return handle.spawn_blocking(f).await.expect("vibevalley-rich offloaded task panicked");
    }

    let (tx, rx) = tokio::sync::oneshot::channel::<std::thread::Result<T>>();
    let job: OffloadJob = Box::new(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        let _ = tx.send(result);
    });
    offload_sender().send(job).expect("vv-rich-offload worker pool closed");
    match rx.await.expect("vv-rich-offload worker exited without completing task") {
        Ok(value) => value,
        Err(payload) => std::panic::resume_unwind(payload),
    }
}

/// Highlighted representation of a code block ready for `nsh_core::element::text` rendering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HighlightedCode {
    /// Original line slices (without trailing line breaks) paired with their styled spans.
    pub lines: Vec<HighlightedLine>,
    /// Resolved theme name used to produce these spans.
    pub theme_name: String,
    /// Resolved default foreground color of the theme, if available.
    pub fg: Option<Rgba>,
    /// Resolved default background color of the theme, if available.
    pub bg: Option<Rgba>,
    /// Whether a grammar actively tokenized the block (false for plain text or unknown languages).
    pub highlighted: bool,
}

/// One line of highlighted code with UTF-8 byte-range spans.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HighlightedLine {
    pub text: String,
    pub spans: Vec<CodeSpan>,
}

/// A single styled byte range inside a [`HighlightedLine`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeSpan {
    pub range: Range<usize>,
    pub fg: Option<Rgba>,
    pub bg: Option<Rgba>,
    pub font_style: FontStyle,
}

impl From<StyledSpan> for CodeSpan {
    fn from(span: StyledSpan) -> Self {
        Self {
            range: span.range,
            fg: span.fg,
            bg: span.bg,
            font_style: span.font_style,
        }
    }
}

struct ShikiEngine {
    highlighter: Highlighter<OnigEngine>,
    grammars: BTreeMap<String, Arc<Grammar<OnigEngine>>>,
    editor_theme: Arc<Theme>,
}

impl ShikiEngine {
    fn new() -> Self {
        let mut highlighter = Highlighter::with_default_engine();
        let light_raw = vv_shiki_light_theme();
        let dark_raw = vv_shiki_dark_theme();
        let editor_theme = Arc::new(Theme::create_from_raw_theme(&light_raw, None));
        highlighter.load_theme(light_raw);
        highlighter.load_theme(dark_raw);

        let mut engine = Self {
            highlighter,
            grammars: BTreeMap::new(),
            editor_theme,
        };

        for bundled in BUNDLED_GRAMMARS {
            match parse_grammar_json(bundled.json) {
                Ok(raw) => {
                    if let Err(err) = engine.register_raw_grammar_inner(raw, bundled.aliases) {
                        eprintln!("vibevalley-rich: failed to compile bundled grammar {}: {err}", bundled.canonical);
                    }
                }
                Err(err) => {
                    eprintln!("vibevalley-rich: failed to parse bundled grammar {}: {err}", bundled.canonical);
                }
            }
        }
        engine
    }

    fn register_raw_grammar_inner(&mut self, raw: RawGrammar, aliases: &[&str]) -> Result<String, ShikiError> {
        let scope_name = raw.scope_name.clone();
        let canonical = self.highlighter.load_grammar_with_aliases(raw, aliases)?;
        let grammar = self.highlighter.registry_mut().load_grammar(&scope_name)?;
        self.grammars.insert(canonical.clone(), grammar);
        Ok(canonical)
    }

    fn resolve_grammar(&self, language: &str) -> Option<Arc<Grammar<OnigEngine>>> {
        let resolved = self.highlighter.resolve_lang_alias(language);
        if is_plain_lang(&resolved) {
            return None;
        }
        self.grammars.get(&resolved).cloned()
    }

    fn highlight_code(&self, code: &str, language: Option<&str>, dark: bool) -> HighlightedCode {
        let theme_name = if dark { SHIKI_DARK_THEME } else { SHIKI_LIGHT_THEME };
        let theme_meta = self.highlighter.get_theme(theme_name);
        let fg = theme_meta.and_then(|t| Rgba::from_hex(&t.fg));
        let bg = theme_meta.and_then(|t| Rgba::from_hex(&t.bg));

        let raw_lines = split_lines(code);
        let lang = language.unwrap_or("").trim();
        let resolved = self.highlighter.resolve_lang_alias(lang);

        if lang.is_empty() || is_plain_lang(&resolved) || !self.grammars.contains_key(&resolved) {
            let lines = raw_lines
                .into_iter()
                .map(|(line, _)| HighlightedLine {
                    text: line.to_owned(),
                    spans: Vec::new(),
                })
                .collect();
            return HighlightedCode {
                lines,
                theme_name: theme_name.to_owned(),
                fg,
                bg,
                highlighted: false,
            };
        }

        match self.highlighter.code_to_spans(code, &resolved, theme_name) {
            Ok(per_line_spans) => {
                let mut lines = Vec::with_capacity(raw_lines.len());
                for (idx, (line_str, _)) in raw_lines.into_iter().enumerate() {
                    let spans = per_line_spans
                        .get(idx)
                        .map(|line_spans| {
                            line_spans
                                .iter()
                                .filter(|s| {
                                    s.range.start < s.range.end
                                        && s.range.end <= line_str.len()
                                        && line_str.is_char_boundary(s.range.start)
                                        && line_str.is_char_boundary(s.range.end)
                                })
                                .cloned()
                                .map(CodeSpan::from)
                                .collect()
                        })
                        .unwrap_or_default();
                    lines.push(HighlightedLine {
                        text: line_str.to_owned(),
                        spans,
                    });
                }
                HighlightedCode {
                    lines,
                    theme_name: theme_name.to_owned(),
                    fg,
                    bg,
                    highlighted: true,
                }
            }
            Err(_) => {
                let lines = raw_lines
                    .into_iter()
                    .map(|(line, _)| HighlightedLine {
                        text: line.to_owned(),
                        spans: Vec::new(),
                    })
                    .collect();
                HighlightedCode {
                    lines,
                    theme_name: theme_name.to_owned(),
                    fg,
                    bg,
                    highlighted: false,
                }
            }
        }
    }
}

fn engine() -> &'static RwLock<ShikiEngine> {
    static ENGINE: OnceLock<RwLock<ShikiEngine>> = OnceLock::new();
    ENGINE.get_or_init(|| RwLock::new(ShikiEngine::new()))
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct CodeCacheKey {
    hash: u64,
    dark: bool,
    language: String,
    code: String,
}

fn code_cache() -> &'static Mutex<LruCache<CodeCacheKey, HighlightedCode>> {
    static CACHE: OnceLock<Mutex<LruCache<CodeCacheKey, HighlightedCode>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(LruCache::new(CODE_CACHE_CAPACITY)))
}

/// Registers an additional or replacement TextMate grammar from JSON into the shared Shiki engine.
///
/// Clears the code-block highlight cache so subsequent renders pick up the newly registered grammar.
pub fn register_grammar_json(json: &str, aliases: &[&str]) -> Result<String, ShikiError> {
    let raw = parse_grammar_json(json)?;
    register_raw_grammar(raw, aliases)
}

/// Registers an additional or replacement [`RawGrammar`] into the shared Shiki engine.
pub fn register_raw_grammar(raw: RawGrammar, aliases: &[&str]) -> Result<String, ShikiError> {
    let canonical = engine().write().unwrap_or_else(|p| p.into_inner()).register_raw_grammar_inner(raw, aliases)?;
    clear_code_highlight_cache();
    Ok(canonical)
}

/// Registers a custom VS Code / TextMate theme JSON into the shared Shiki engine.
pub fn register_theme_json(json: &str) -> Result<String, ShikiError> {
    let raw = parse_theme_json(json)?;
    Ok(register_raw_theme(raw))
}

/// Registers a custom [`RawTheme`] into the shared Shiki engine.
pub fn register_raw_theme(raw: RawTheme) -> String {
    let name = engine().write().unwrap_or_else(|p| p.into_inner()).highlighter.load_theme(raw);
    clear_code_highlight_cache();
    name
}

/// Lists all canonical language names currently loaded in the shared Shiki engine.
pub fn loaded_languages() -> Vec<String> {
    engine().read().unwrap_or_else(|p| p.into_inner()).grammars.keys().cloned().collect()
}

/// Looks up a previously highlighted code block in the LRU cache without running tokenization.
pub fn cached_highlight_code(code: &str, language: Option<&str>, dark: bool) -> Option<HighlightedCode> {
    let key = make_code_cache_key(code, language, dark);
    code_cache().lock().unwrap_or_else(|p| p.into_inner()).get(&key)
}

/// Highlights `code` in `language` using VibeValley's warm light or dark Shiki theme (LRU-cached).
pub fn highlight_code(code: &str, language: Option<&str>, dark: bool) -> HighlightedCode {
    let key = make_code_cache_key(code, language, dark);
    if let Some(hit) = code_cache().lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
        return hit;
    }
    let result = engine().read().unwrap_or_else(|p| p.into_inner()).highlight_code(code, language, dark);
    code_cache().lock().unwrap_or_else(|p| p.into_inner()).insert(key, result.clone());
    result
}

/// Returns hit/miss/eviction metrics for the code-block highlight LRU cache.
pub fn code_highlight_cache_stats() -> CacheStats {
    code_cache().lock().unwrap_or_else(|p| p.into_inner()).stats()
}

/// Clears all entries from the code-block highlight LRU cache.
pub fn clear_code_highlight_cache() {
    code_cache().lock().unwrap_or_else(|p| p.into_inner()).clear();
}

fn make_code_cache_key(code: &str, language: Option<&str>, dark: bool) -> CodeCacheKey {
    let normalized_lang = language.unwrap_or("").trim().to_ascii_lowercase();
    let hash = hash_str(code) ^ hash_str(&normalized_lang).rotate_left(17);
    CodeCacheKey {
        hash,
        dark,
        language: normalized_lang,
        code: code.to_owned(),
    }
}

/// Resolves the innermost TextMate scope stack into an `nsh_base::editor::EditorToken`.
pub fn editor_token_from_scopes(scopes: &[String]) -> Option<EditorToken> {
    scopes.iter().rev().find_map(|scope| EditorToken::from_scope(scope))
}

/// One tokenized byte range on a line, carrying its TextMate scope stack from outermost to innermost.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopedSpan {
    pub range: Range<usize>,
    pub scopes: Vec<String>,
}

/// Tokenizes `code` line-by-line in `language` (propagating TextMate state across lines)
/// and returns theme-independent scope stacks per line.
pub fn tokenize_scopes(code: &str, language: &str) -> Vec<Vec<ScopedSpan>> {
    let (grammar, theme) = {
        let guard = engine().read().unwrap_or_else(|p| p.into_inner());
        (guard.resolve_grammar(language), Arc::clone(&guard.editor_theme))
    };
    let Some(grammar) = grammar else {
        return Vec::new();
    };
    let mut state: Option<StateStack> = None;
    let mut out = Vec::new();
    for (line, _) in split_lines(code) {
        let Ok(res) = grammar.tokenize_line_with_theme(line, state.as_ref(), &theme, Some(LINE_TIME_LIMIT)) else {
            out.push(Vec::new());
            continue;
        };
        let content_len = line.len();
        let mut spans = Vec::with_capacity(res.tokens.len());
        for tok in res.tokens {
            let start = tok.start_index.min(content_len);
            let end = tok.end_index.min(content_len);
            if start >= end || !line.is_char_boundary(start) || !line.is_char_boundary(end) {
                continue;
            }
            spans.push(ScopedSpan {
                range: start..end,
                scopes: tok.scopes,
            });
        }
        out.push(spans);
        state = Some(res.rule_stack);
    }
    out
}

#[derive(Default)]
struct LineRecord {
    /// Byte length of this line including trailing `\n` (if present).
    len: usize,
    /// Whether this line has been tokenized since the last edit affecting it.
    done: bool,
    /// Saved `StateStack` at the start of this line (always present on line 0 and checkpoints).
    start: Option<StateStack>,
}

/// Incremental line-by-line [`EditorHighlighter`] backed by `vibevalley-shiki` and `vibevalley-onig`.
///
/// Works on `<Editor>` and `<DiffView>` off the engine thread with zero `syntect`/`onig_sys` dependency.
pub struct ShikiEditorHighlighter {
    grammar: Option<Arc<Grammar<OnigEngine>>>,
    theme: Arc<Theme>,
    lines: Vec<LineRecord>,
    parsed: usize,
    offset: usize,
    state: Option<StateStack>,
    line_buf: String,
}

impl ShikiEditorHighlighter {
    /// Builds an incremental editor highlighter for `language` (canonical name, alias, or extension).
    pub fn for_language(language: &str) -> Self {
        let guard = engine().read().unwrap_or_else(|p| p.into_inner());
        let grammar = guard.resolve_grammar(language);
        let theme = Arc::clone(&guard.editor_theme);
        drop(guard);

        let lines = vec![LineRecord {
            len: 0,
            done: false,
            start: Some(StateStack::initial()),
        }];

        Self {
            grammar,
            theme,
            lines,
            parsed: 0,
            offset: 0,
            state: None,
            line_buf: String::new(),
        }
    }

    /// Returns whether a TextMate grammar was resolved for this highlighter.
    pub fn has_grammar(&self) -> bool {
        self.grammar.is_some()
    }

    /// Tokenizes a single line (without trailing `\n`) into `(byte_range, EditorToken)` spans
    /// and returns the resulting end-of-line [`StateStack`].
    pub fn tokenize_single_line(&self, line_without_newline: &str, prev_state: Option<&StateStack>) -> (Vec<(Range<usize>, EditorToken)>, StateStack) {
        let Some(grammar) = &self.grammar else {
            return (Vec::new(), prev_state.cloned().unwrap_or_else(StateStack::initial));
        };
        let Ok(res) = grammar.tokenize_line_with_theme(line_without_newline, prev_state, &self.theme, Some(LINE_TIME_LIMIT)) else {
            return (Vec::new(), prev_state.cloned().unwrap_or_else(StateStack::initial));
        };
        let content_len = line_without_newline.len();
        let mut out = Vec::with_capacity(res.tokens.len());
        for tok in res.tokens {
            let start = tok.start_index.min(content_len);
            let end = tok.end_index.min(content_len);
            if start >= end || !line_without_newline.is_char_boundary(start) || !line_without_newline.is_char_boundary(end) {
                continue;
            }
            if let Some(kind) = editor_token_from_scopes(&tok.scopes) {
                out.push((start..end, kind));
            }
        }
        (out, res.rule_stack)
    }

    /// Tokenizes an entire multi-line string sequentially, propagating TextMate [`StateStack`]
    /// across lines (e.g. multi-line block comments and raw strings).
    pub fn tokenize_document(&self, text: &str) -> Vec<Vec<(Range<usize>, EditorToken)>> {
        let mut state: Option<StateStack> = None;
        let mut out = Vec::new();
        for (line, _) in split_lines(text) {
            let (tokens, next_state) = self.tokenize_single_line(line, state.as_ref());
            out.push(tokens);
            state = Some(next_state);
        }
        out
    }

    fn current(&self, last_line: usize) -> bool {
        self.parsed > last_line || self.parsed >= self.lines.len()
    }

    fn apply_line_edit(&mut self, first: usize, old_count: usize, new_count: usize) {
        if first >= self.lines.len() {
            return;
        }
        if self.parsed > first {
            let mut at = first;
            while at > 0 && self.lines[at].start.is_none() {
                at -= 1;
            }
            self.offset = if self.parsed - at < at {
                self.offset.saturating_sub(self.lines[at..self.parsed].iter().map(|l| l.len).sum::<usize>())
            } else {
                self.lines[..at].iter().map(|l| l.len).sum()
            };
            self.parsed = at;
            self.state = None;
        }

        let preserved_start = self.lines[first].start.take();
        let clamped_old = old_count.min(self.lines.len().saturating_sub(first));
        self.lines.splice(first..first + clamped_old, (0..new_count).map(|_| LineRecord::default()));
        if self.lines.len() == first {
            self.lines.push(LineRecord::default());
        }
        let line = &mut self.lines[first];
        line.start = preserved_start.or_else(|| (first == 0).then(StateStack::initial));
        line.done = false;
    }
}

impl EditorHighlighter for ShikiEditorHighlighter {
    fn edited(&mut self, edit: &EditorTextEdit) {
        self.apply_line_edit(edit.first_line, edit.old_line_count, edit.new_line_count);
    }

    fn highlight(&mut self, text: &EditorText, last_line: usize, budget: Duration, tokens: &mut EditorTokens) -> bool {
        if self.grammar.is_none() {
            return true;
        }
        let started = Instant::now();
        while self.parsed < self.lines.len() && self.parsed <= last_line {
            if self.offset > text.len() {
                self.lines.truncate(self.parsed.max(1));
                self.parsed = self.parsed.min(self.lines.len().saturating_sub(1));
                break;
            }
            let index = self.parsed;
            let has_newline = text.read_line(self.offset, &mut self.line_buf);
            let raw_len = self.line_buf.len();
            let content_len = raw_len.saturating_sub(usize::from(has_newline));
            let content = &self.line_buf[..content_len];

            let prev_state = match self.state.take() {
                Some(st) => st,
                None => self.lines[index].start.clone().unwrap_or_else(StateStack::initial),
            };
            let (line_tokens, next_state) = self.tokenize_single_line(content, Some(&prev_state));
            tokens.line(index, line_tokens);

            let record = &mut self.lines[index];
            record.done = true;
            record.len = raw_len;
            self.parsed = index + 1;
            self.offset += raw_len;

            if !has_newline {
                self.lines.truncate(index + 1);
                break;
            }

            let next = index + 1;
            if next == self.lines.len() {
                self.lines.push(LineRecord::default());
            }
            let next_record = &mut self.lines[next];
            if next_record.done && next_record.start.as_ref() == Some(&next_state) {
                while self.lines.get(self.parsed).is_some_and(|l| l.done) {
                    self.offset += self.lines[self.parsed].len;
                    self.parsed += 1;
                }
                if self.parsed < self.lines.len() {
                    while self.parsed > 0 && self.lines[self.parsed].start.is_none() {
                        self.parsed -= 1;
                        self.offset = self.offset.saturating_sub(self.lines[self.parsed].len);
                    }
                }
            } else {
                if next_record.start.is_some() || next.is_multiple_of(CHECKPOINT_INTERVAL) {
                    next_record.start = Some(next_state.clone());
                }
                self.state = Some(next_state);
            }

            if started.elapsed() >= budget {
                break;
            }
        }
        self.current(last_line)
    }

    fn frontier(&self) -> usize {
        self.parsed
    }

    fn guess(&mut self, text: &EditorText, first_line: usize, offset: usize, last_line: usize, tokens: &mut EditorTokens) -> bool {
        if self.grammar.is_none() {
            return false;
        }
        let mut state = StateStack::initial();
        let mut cursor = offset;
        for index in first_line..=last_line {
            if cursor > text.len() {
                break;
            }
            let has_newline = text.read_line(cursor, &mut self.line_buf);
            let raw_len = self.line_buf.len();
            let content_len = raw_len.saturating_sub(usize::from(has_newline));
            let content = &self.line_buf[..content_len];
            let (line_tokens, next_state) = self.tokenize_single_line(content, Some(&state));
            tokens.line(index, line_tokens);
            state = next_state;
            cursor += raw_len;
            if !has_newline {
                break;
            }
        }
        true
    }
}

/// Registers VibeValley's pure-Rust Shiki highlighters and custom languages into the current
/// `nsh` engine (`nsh_base::editor::register_language` + `register_highlighter`).
///
/// Called automatically by [`crate::registry`]'s `.setup(...)` hook when mounted in `apps/mac`
/// or in any `nsh_core::Core`.
pub fn register_shiki_editor_highlighters() {
    // Ensure the shared Shiki engine is initialized before editors request grammars.
    let _ = engine();
    register_language(&MERMAID_LANGUAGE);

    for bundled in BUNDLED_GRAMMARS {
        let canonical = bundled.canonical;
        for &editor_name in bundled.editor_names {
            register_highlighter(editor_name, move || Box::new(ShikiEditorHighlighter::for_language(canonical)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on_without_tokio<F: std::future::Future>(future: F) -> F::Output {
        use std::pin::pin;
        use std::task::{Context, Poll, Wake, Waker};

        struct ThreadUnparker(std::thread::Thread);

        impl Wake for ThreadUnparker {
            fn wake(self: Arc<Self>) {
                self.0.unpark();
            }

            fn wake_by_ref(self: &Arc<Self>) {
                self.0.unpark();
            }
        }

        let waker = Waker::from(Arc::new(ThreadUnparker(std::thread::current())));
        let mut cx = Context::from_waker(&waker);
        let mut fut = pin!(future);

        loop {
            match fut.as_mut().poll(&mut cx) {
                Poll::Ready(out) => return out,
                Poll::Pending => std::thread::park(),
            }
        }
    }

    #[test]
    fn run_offloaded_executes_on_worker_thread_outside_tokio_runtime() {
        assert!(
            tokio::runtime::Handle::try_current().is_err(),
            "test must run outside any ambient Tokio runtime"
        );
        let caller_thread = std::thread::current().id();

        let (worker_thread, worker_name, highlighted) = block_on_without_tokio(run_offloaded(move || {
            let current = std::thread::current();
            let highlighted = highlight_code("pub fn offload_ok() -> u8 { 1 }", Some("rust"), false);
            (current.id(), current.name().map(str::to_owned), highlighted)
        }));

        assert_ne!(worker_thread, caller_thread, "run_offloaded must execute on a background thread");
        assert_eq!(worker_name.as_deref(), Some("vv-rich-offload"));
        assert!(highlighted.highlighted);
        assert_eq!(highlighted.lines.len(), 1);
    }

    #[test]
    fn run_offloaded_recovers_worker_pool_after_task_panic() {
        assert!(tokio::runtime::Handle::try_current().is_err());

        let panicked = std::panic::catch_unwind(|| {
            block_on_without_tokio(run_offloaded(|| -> usize {
                panic!("simulated worker panic");
            }))
        });
        assert!(panicked.is_err(), "panic in offloaded closure should propagate to caller");

        let caller_thread = std::thread::current().id();
        for i in 0..4 {
            let (worker_thread, val) = block_on_without_tokio(run_offloaded(move || (std::thread::current().id(), i * 2)));
            assert_ne!(worker_thread, caller_thread);
            assert_eq!(val, i * 2);
        }
    }
}
