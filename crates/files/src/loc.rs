use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;

use ignore::WalkState;

use crate::walk::{io_error, walker};
use crate::{LocStat, Result};

const SNIFF_BYTES: usize = 8192;
const CHUNK_BYTES: usize = 64 * 1024;
const MAX_RETAINED_BUF: usize = 1024 * 1024;

const EXCLUDED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "vendor",
    "dist",
    "build",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    "coverage",
];

const EXCLUDED_FILES: &[&str] = &[
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "Cargo.lock",
    "go.sum",
    "poetry.lock",
    "uv.lock",
    "Pipfile.lock",
    "Gemfile.lock",
    "composer.lock",
];

const EXCLUDED_SUFFIXES: &[&str] = &[".min.js", ".min.css", ".map"];

#[derive(Clone, Copy)]
struct BlockComment {
    start: &'static str,
    end: &'static str,
    nested: bool,
    line_start_only: bool,
}

impl BlockComment {
    const fn new(start: &'static str, end: &'static str, nested: bool) -> Self {
        Self {
            start,
            end,
            nested,
            line_start_only: false,
        }
    }

    const fn line_start(start: &'static str, end: &'static str) -> Self {
        Self {
            start,
            end,
            nested: false,
            line_start_only: true,
        }
    }
}

const BLOCK_C: &[BlockComment] = &[BlockComment::new("/*", "*/", false)];
const BLOCK_C_NESTED: &[BlockComment] = &[BlockComment::new("/*", "*/", true)];
const BLOCK_HTML: &[BlockComment] = &[BlockComment::new("<!--", "-->", false)];
const BLOCK_VUE: &[BlockComment] = &[BlockComment::new("<!--", "-->", false), BlockComment::new("/*", "*/", false)];
const BLOCK_LUA: &[BlockComment] = &[BlockComment::new("--[[", "]]", false)];
const BLOCK_HASKELL: &[BlockComment] = &[BlockComment::new("{-", "-}", true)];
const BLOCK_ML: &[BlockComment] = &[BlockComment::new("(*", "*)", true)];
const BLOCK_JULIA: &[BlockComment] = &[BlockComment::new("#=", "=#", true)];
const BLOCK_POWERSHELL: &[BlockComment] = &[BlockComment::new("<#", "#>", false)];
const BLOCK_CMAKE: &[BlockComment] = &[BlockComment::new("#[[", "]]", false)];
const BLOCK_RUBY: &[BlockComment] = &[BlockComment::line_start("=begin", "=end")];
const BLOCK_PERL: &[BlockComment] = &[BlockComment::line_start("=pod", "=cut")];

#[derive(Clone, Copy)]
struct LangSpec {
    name: &'static str,
    extensions: &'static [&'static str],
    filenames: &'static [&'static str],
    line_comments: &'static [&'static str],
    blocks: &'static [BlockComment],
    double_quotes: bool,
    single_quotes: bool,
    char_literals: bool,
    backtick_quotes: bool,
    multiline_backtick: bool,
    backtick_escapes: bool,
    rust_raw_strings: bool,
    triple_quotes: bool,
    prose_is_comment: bool,
}

const fn lang(name: &'static str, extensions: &'static [&'static str]) -> LangSpec {
    LangSpec {
        name,
        extensions,
        filenames: &[],
        line_comments: &[],
        blocks: &[],
        double_quotes: false,
        single_quotes: false,
        char_literals: false,
        backtick_quotes: false,
        multiline_backtick: false,
        backtick_escapes: false,
        rust_raw_strings: false,
        triple_quotes: false,
        prose_is_comment: false,
    }
}

impl LangSpec {
    const fn names(mut self, filenames: &'static [&'static str]) -> Self {
        self.filenames = filenames;
        self
    }

    const fn line(mut self, line_comments: &'static [&'static str]) -> Self {
        self.line_comments = line_comments;
        self
    }

    const fn block(mut self, blocks: &'static [BlockComment]) -> Self {
        self.blocks = blocks;
        self
    }

    const fn quotes(mut self, double: bool, single: bool) -> Self {
        self.double_quotes = double;
        self.single_quotes = single;
        self
    }

    const fn char_lits(mut self) -> Self {
        self.char_literals = true;
        self
    }

    const fn backticks(mut self, multiline: bool, escapes: bool) -> Self {
        self.backtick_quotes = true;
        self.multiline_backtick = multiline;
        self.backtick_escapes = escapes;
        self
    }

    const fn rust_raw(mut self) -> Self {
        self.rust_raw_strings = true;
        self
    }

    const fn triple(mut self) -> Self {
        self.triple_quotes = true;
        self
    }

    const fn prose(mut self) -> Self {
        self.prose_is_comment = true;
        self
    }
}

const LANGUAGES: &[LangSpec] = &[
    lang("Rust", &["rs"]).line(&["//"]).block(BLOCK_C_NESTED).quotes(true, false).char_lits().rust_raw(),
    lang("TypeScript", &["ts", "mts", "cts"]).line(&["//"]).block(BLOCK_C).quotes(true, true).backticks(true, true),
    lang("TSX", &["tsx"]).line(&["//"]).block(BLOCK_C).quotes(true, true).backticks(true, true),
    lang("JavaScript", &["js", "mjs", "cjs"]).line(&["//"]).block(BLOCK_C).quotes(true, true).backticks(true, true),
    lang("JSX", &["jsx"]).line(&["//"]).block(BLOCK_C).quotes(true, true).backticks(true, true),
    lang("Python", &["py", "pyi", "pyw"]).line(&["#"]).quotes(true, true).triple(),
    lang("Go", &["go"]).line(&["//"]).block(BLOCK_C).quotes(true, false).char_lits().backticks(true, false),
    lang("Java", &["java"]).line(&["//"]).block(BLOCK_C).quotes(true, false).char_lits(),
    lang("Kotlin", &["kt", "kts"]).line(&["//"]).block(BLOCK_C_NESTED).quotes(true, false).char_lits(),
    lang("Swift", &["swift"]).line(&["//"]).block(BLOCK_C_NESTED).quotes(true, false),
    lang("C", &["c", "h"]).line(&["//"]).block(BLOCK_C).quotes(true, false).char_lits(),
    lang("C++", &["cpp", "cc", "cxx", "c++", "hpp", "hh", "hxx", "h++", "ipp", "inl"]).line(&["//"]).block(BLOCK_C).quotes(true, false).char_lits(),
    lang("Objective-C", &["m", "mm"]).line(&["//"]).block(BLOCK_C).quotes(true, false).char_lits(),
    lang("C#", &["cs", "csx"]).line(&["//"]).block(BLOCK_C).quotes(true, false).char_lits(),
    lang("Ruby", &["rb", "rake", "gemspec"]).names(&["Rakefile", "Gemfile"]).line(&["#"]).block(BLOCK_RUBY).quotes(true, true),
    lang("PHP", &["php", "phtml", "php3", "php4", "php5", "phps"]).line(&["//", "#"]).block(BLOCK_C).quotes(true, true),
    lang("Shell", &["sh", "bash", "zsh", "fish", "ksh", "dash", "command"])
        .names(&[".bashrc", ".bash_profile", ".bash_aliases", ".zshrc", ".zshenv", ".zprofile", ".profile", ".envrc", "PKGBUILD"])
        .line(&["#"])
        .quotes(true, true),
    lang("PowerShell", &["ps1", "psm1", "psd1"]).line(&["#"]).block(BLOCK_POWERSHELL).quotes(true, true),
    lang("SQL", &["sql", "ddl", "dml"]).line(&["--"]).block(BLOCK_C).quotes(true, true),
    lang("HTML", &["html", "htm", "xhtml"]).block(BLOCK_HTML).quotes(true, true),
    lang("XML", &["xml", "xsl", "xslt", "plist"]).block(BLOCK_HTML).quotes(true, true),
    lang("SVG", &["svg"]).block(BLOCK_HTML).quotes(true, true),
    lang("CSS", &["css"]).block(BLOCK_C).quotes(true, true),
    lang("Sass", &["scss", "sass"]).line(&["//"]).block(BLOCK_C).quotes(true, true),
    lang("Less", &["less"]).line(&["//"]).block(BLOCK_C).quotes(true, true),
    lang("JSON", &["json", "geojson", "webmanifest"]).names(&[".babelrc", ".eslintrc", ".prettierrc", "flake.lock"]).quotes(true, false),
    lang("JSONC", &["jsonc", "json5"]).line(&["//"]).block(BLOCK_C).quotes(true, true),
    lang("YAML", &["yaml", "yml"]).names(&[".clang-format", ".clang-tidy"]).line(&["#"]).quotes(true, true),
    lang("TOML", &["toml"]).names(&["Pipfile"]).line(&["#"]).quotes(true, true),
    lang("Markdown", &["md", "markdown", "mdx", "mdown", "mkd"]).block(BLOCK_HTML).prose(),
    lang("Dart", &["dart"]).line(&["//"]).block(BLOCK_C_NESTED).quotes(true, true),
    lang("Lua", &["lua", "luau"]).line(&["--"]).block(BLOCK_LUA).quotes(true, true),
    lang("Scala", &["scala", "sc"]).line(&["//"]).block(BLOCK_C_NESTED).quotes(true, false).char_lits(),
    lang("Elixir", &["ex", "exs"]).line(&["#"]).quotes(true, true),
    lang("Erlang", &["erl", "hrl"]).line(&["%"]).quotes(true, false),
    lang("Haskell", &["hs", "lhs"]).line(&["--"]).block(BLOCK_HASKELL).quotes(true, false).char_lits(),
    lang("Zig", &["zig", "zon"]).line(&["//"]).quotes(true, false).char_lits(),
    lang("R", &["r", "rmd"]).line(&["#"]).quotes(true, true),
    lang("Julia", &["jl"]).line(&["#"]).block(BLOCK_JULIA).quotes(true, false),
    lang("Vue", &["vue"]).line(&["//"]).block(BLOCK_VUE).quotes(true, true).backticks(true, true),
    lang("Svelte", &["svelte"]).line(&["//"]).block(BLOCK_VUE).quotes(true, true).backticks(true, true),
    lang("Astro", &["astro"]).line(&["//"]).block(BLOCK_VUE).quotes(true, true).backticks(true, true),
    lang("Dockerfile", &["dockerfile"]).names(&["Dockerfile", "dockerfile"]).line(&["#"]).quotes(true, true),
    lang("Makefile", &["mk", "mak"]).names(&["Makefile", "makefile", "GNUmakefile"]).line(&["#"]).quotes(true, true),
    lang("Terraform", &["tf", "tfvars", "hcl"]).line(&["#", "//"]).block(BLOCK_C).quotes(true, false),
    lang("Nix", &["nix"]).line(&["#"]).block(BLOCK_C).quotes(true, false),
    lang("Protocol Buffers", &["proto"]).line(&["//"]).block(BLOCK_C).quotes(true, true),
    lang("GraphQL", &["graphql", "gql"]).line(&["#"]).quotes(true, false),
    lang("Clojure", &["clj", "cljs", "cljc", "edn"]).line(&[";"]).quotes(true, false),
    lang("OCaml", &["ml", "mli"]).block(BLOCK_ML).quotes(true, false),
    lang("F#", &["fs", "fsi", "fsx"]).line(&["//"]).block(BLOCK_ML).quotes(true, false),
    lang("Perl", &["pl", "pm", "t"]).line(&["#"]).block(BLOCK_PERL).quotes(true, true),
    lang("Groovy", &["groovy", "gradle"]).line(&["//"]).block(BLOCK_C).quotes(true, true),
    lang("Solidity", &["sol"]).line(&["//"]).block(BLOCK_C).quotes(true, true),
    lang("WGSL", &["wgsl"]).line(&["//"]).block(BLOCK_C_NESTED).quotes(true, false),
    lang("GLSL", &["glsl", "vert", "frag", "comp"]).line(&["//"]).block(BLOCK_C).quotes(true, false),
    lang("CMake", &["cmake"]).names(&["CMakeLists.txt"]).line(&["#"]).block(BLOCK_CMAKE).quotes(true, false),
    lang("INI", &["ini", "cfg", "conf"]).line(&[";", "#"]).quotes(true, true),
    lang("Batch", &["bat", "cmd"]).line(&["::", "REM ", "rem "]).quotes(true, false),
    lang("Just", &["just"]).names(&["justfile", "Justfile"]).line(&["#"]).quotes(true, true),
    lang("Jupyter", &["ipynb"]).quotes(true, false),
];

#[derive(Default, Clone, Copy)]
struct LangAcc {
    files: usize,
    code: usize,
    comments: usize,
    blanks: usize,
}

#[derive(Default, Clone, Copy)]
struct FileCounts {
    code: usize,
    comments: usize,
    blanks: usize,
}

fn is_excluded_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    EXCLUDED_FILES.contains(&name) || EXCLUDED_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

fn language_index_for_path(path: &Path) -> Option<usize> {
    let name = path.file_name().and_then(|n| n.to_str())?;
    if let Some(idx) = LANGUAGES.iter().position(|spec| spec.filenames.contains(&name)) {
        return Some(idx);
    }
    let ext = path.extension().and_then(|e| e.to_str())?;
    LANGUAGES.iter().position(|spec| spec.extensions.iter().any(|cand| cand.eq_ignore_ascii_case(ext)))
}

fn read_text_file(path: &Path, buf: &mut Vec<u8>) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    buf.clear();

    let mut sniff = [0u8; SNIFF_BYTES];
    let mut sniffed = 0usize;
    while sniffed < SNIFF_BYTES {
        match file.read(&mut sniff[sniffed..]) {
            Ok(0) => break,
            Ok(n) => {
                if sniff[sniffed..sniffed + n].contains(&0) {
                    return false;
                }
                sniffed += n;
            }
            Err(_) => return false,
        }
    }
    buf.extend_from_slice(&sniff[..sniffed]);

    if sniffed == SNIFF_BYTES {
        let mut chunk = [0u8; CHUNK_BYTES];
        loop {
            match file.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    if chunk[..n].contains(&0) {
                        return false;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                Err(_) => return false,
            }
        }
    }
    true
}

fn block_matches_at(line: &[u8], pos: usize, marker: &[u8], line_start_only: bool) -> bool {
    if line_start_only && pos != 0 {
        return false;
    }
    if !line[pos..].starts_with(marker) {
        return false;
    }
    if !line_start_only {
        return true;
    }
    line.get(pos + marker.len()).is_none_or(|b| b.is_ascii_whitespace())
}

fn skip_quoted(line: &[u8], mut i: usize, quote: u8) -> usize {
    i += 1;
    while i < line.len() {
        if line[i] == b'\\' && i + 1 < line.len() {
            i += 2;
        } else if line[i] == quote {
            i += 1;
            break;
        } else {
            i += 1;
        }
    }
    i
}

fn try_rust_raw_string(line: &[u8], pos: usize) -> Option<(usize, usize)> {
    if line[pos] != b'r' {
        return None;
    }
    let mut j = pos + 1;
    let mut hashes = 0usize;
    while j < line.len() && line[j] == b'#' {
        hashes += 1;
        j += 1;
    }
    if j < line.len() && line[j] == b'"' {
        Some((j + 1, hashes))
    } else {
        None
    }
}

fn scan_rust_raw_string(line: &[u8], mut i: usize, hashes: usize) -> (usize, bool) {
    while i < line.len() {
        if line[i] == b'"' && line.len() - i > hashes && line[i + 1..i + 1 + hashes].iter().all(|&b| b == b'#') {
            return (i + 1 + hashes, false);
        }
        i += 1;
    }
    (i, true)
}

fn parse_fence(trimmed: &[u8]) -> Option<(u8, usize)> {
    let ch = *trimmed.first()?;
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let len = trimmed.iter().take_while(|&&b| b == ch).count();
    (len >= 3).then_some((ch, len))
}

fn count_markdown_lines(bytes: &[u8]) -> FileCounts {
    let mut counts = FileCounts::default();
    let mut in_fence: Option<(u8, usize)> = None;
    let mut in_html_comment = false;
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);

    for raw_line in body.split(|&b| b == b'\n') {
        let line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        if line.iter().all(|b| b.is_ascii_whitespace()) {
            counts.blanks += 1;
            continue;
        }

        if let Some((fence_ch, fence_len)) = in_fence {
            counts.code += 1;
            let trimmed = trim_ascii_start(line);
            if let Some((ch, len)) = parse_fence(trimmed)
                && ch == fence_ch
                && len >= fence_len
                && trimmed[len..].iter().all(|b| b.is_ascii_whitespace())
            {
                in_fence = None;
            }
            continue;
        }

        let trimmed = trim_ascii_start(line);
        if !in_html_comment && let Some((ch, len)) = parse_fence(trimmed) {
            counts.code += 1;
            if !trimmed[len..].contains(&ch) || ch == b'~' {
                in_fence = Some((ch, len));
            }
            continue;
        }

        // Prose and HTML comments in Markdown both count as comments.
        let mut i = 0usize;
        while i < line.len() {
            if in_html_comment {
                if line[i..].starts_with(b"-->") {
                    in_html_comment = false;
                    i += 3;
                } else {
                    i += 1;
                }
            } else if line[i..].starts_with(b"<!--") {
                in_html_comment = true;
                i += 4;
            } else {
                i += 1;
            }
        }
        counts.comments += 1;
    }
    counts
}

fn trim_ascii_start(bytes: &[u8]) -> &[u8] {
    let start = bytes.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(bytes.len());
    &bytes[start..]
}

fn count_code_lines(bytes: &[u8], spec: &LangSpec) -> FileCounts {
    let mut counts = FileCounts::default();
    let mut active_block: Option<usize> = None;
    let mut block_depth: usize = 0;
    let mut in_backtick = false;
    let mut rust_raw_hashes: Option<usize> = None;
    let mut triple_quote: Option<u8> = None;

    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);

    for raw_line in body.split(|&b| b == b'\n') {
        let line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        if line.iter().all(|b| b.is_ascii_whitespace()) {
            counts.blanks += 1;
            continue;
        }

        let mut has_code = false;
        let mut has_comment = false;
        let mut i = 0usize;

        while i < line.len() {
            if let Some(block_idx) = active_block {
                has_comment = true;
                let block = &spec.blocks[block_idx];
                if block_matches_at(line, i, block.end.as_bytes(), block.line_start_only) {
                    block_depth -= 1;
                    i += block.end.len();
                    if block_depth == 0 {
                        active_block = None;
                    }
                } else if block.nested && block_matches_at(line, i, block.start.as_bytes(), false) {
                    block_depth += 1;
                    i += block.start.len();
                } else {
                    i += 1;
                }
                continue;
            }

            if let Some(hashes) = rust_raw_hashes {
                has_code = true;
                let (next_i, still_open) = scan_rust_raw_string(line, i, hashes);
                i = next_i;
                if !still_open {
                    rust_raw_hashes = None;
                }
                continue;
            }

            if let Some(q) = triple_quote {
                has_code = true;
                let needle = [q, q, q];
                if line[i] == b'\\' && i + 1 < line.len() {
                    i += 2;
                } else if line[i..].starts_with(&needle) {
                    triple_quote = None;
                    i += 3;
                } else {
                    i += 1;
                }
                continue;
            }

            if in_backtick {
                has_code = true;
                if spec.backtick_escapes && line[i] == b'\\' && i + 1 < line.len() {
                    i += 2;
                } else if line[i] == b'`' {
                    in_backtick = false;
                    i += 1;
                } else {
                    i += 1;
                }
                continue;
            }

            if line[i].is_ascii_whitespace() {
                i += 1;
                continue;
            }

            // Check block comments before line comments so `--[[` and `#=` are not swallowed by `--` / `#`.
            if let Some((idx, block)) = spec
                .blocks
                .iter()
                .enumerate()
                .find(|(_, block)| block_matches_at(line, i, block.start.as_bytes(), block.line_start_only))
            {
                has_comment = true;
                active_block = Some(idx);
                block_depth = 1;
                i += block.start.len();
                continue;
            }

            if spec.line_comments.iter().any(|lc| line[i..].starts_with(lc.as_bytes())) {
                has_comment = true;
                break;
            }

            if spec.triple_quotes && (line[i..].starts_with(b"\"\"\"") || line[i..].starts_with(b"'''")) {
                has_code = true;
                triple_quote = Some(line[i]);
                i += 3;
                continue;
            }

            if spec.rust_raw_strings
                && let Some((after_open, hashes)) = try_rust_raw_string(line, i)
            {
                has_code = true;
                let (next_i, still_open) = scan_rust_raw_string(line, after_open, hashes);
                i = next_i;
                if still_open {
                    rust_raw_hashes = Some(hashes);
                }
                continue;
            }

            if spec.double_quotes && line[i] == b'"' {
                has_code = true;
                i = skip_quoted(line, i, b'"');
                continue;
            }

            if spec.single_quotes && line[i] == b'\'' {
                has_code = true;
                i = skip_quoted(line, i, b'\'');
                continue;
            }

            if spec.char_literals && line[i] == b'\'' {
                has_code = true;
                if i + 2 < line.len() && line[i + 1] != b'\\' && line[i + 2] == b'\'' {
                    i += 3;
                } else if i + 3 < line.len() && line[i + 1] == b'\\' && line[i + 3] == b'\'' {
                    i += 4;
                } else {
                    i += 1;
                }
                continue;
            }

            if spec.backtick_quotes && line[i] == b'`' {
                has_code = true;
                if spec.multiline_backtick {
                    in_backtick = true;
                    i += 1;
                } else {
                    i = skip_quoted(line, i, b'`');
                }
                continue;
            }

            has_code = true;
            i += 1;
        }

        if has_code {
            counts.code += 1;
        } else if has_comment {
            counts.comments += 1;
        }
    }

    counts
}

struct WorkerCollector<'a> {
    local: Vec<LangAcc>,
    shared: &'a Mutex<Vec<Vec<LangAcc>>>,
}

impl Drop for WorkerCollector<'_> {
    fn drop(&mut self) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.push(std::mem::take(&mut self.local));
        }
    }
}

pub(crate) fn count_loc(root: &Path) -> Result<Vec<LocStat>> {
    if !root.is_dir() {
        return Err(io_error(root, "not a directory"));
    }

    let shared = Mutex::new(Vec::new());
    let mut builder = walker(root);
    builder.filter_entry(|entry| {
        if entry.depth() == 0 {
            return true;
        }
        let Some(name) = entry.file_name().to_str() else {
            return true;
        };
        if name == ".git" {
            return false;
        }
        if entry.file_type().is_some_and(|t| t.is_dir()) {
            return !EXCLUDED_DIRS.contains(&name);
        }
        true
    });

    builder.build_parallel().run(|| {
        let mut collector = WorkerCollector {
            local: vec![LangAcc::default(); LANGUAGES.len()],
            shared: &shared,
        };
        let mut buf = Vec::with_capacity(SNIFF_BYTES);
        Box::new(move |entry| {
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }
            let path = entry.path();
            if is_excluded_file(path) {
                return WalkState::Continue;
            }
            let Some(lang_idx) = language_index_for_path(path) else {
                return WalkState::Continue;
            };
            if !read_text_file(path, &mut buf) {
                return WalkState::Continue;
            }
            let spec = &LANGUAGES[lang_idx];
            let counts = if spec.prose_is_comment {
                count_markdown_lines(&buf)
            } else {
                count_code_lines(&buf, spec)
            };
            if buf.capacity() > MAX_RETAINED_BUF {
                buf = Vec::with_capacity(SNIFF_BYTES);
            }
            let acc = &mut collector.local[lang_idx];
            acc.files += 1;
            acc.code += counts.code;
            acc.comments += counts.comments;
            acc.blanks += counts.blanks;
            WalkState::Continue
        })
    });

    let per_worker = shared.into_inner().unwrap_or_else(|e| e.into_inner());
    let mut totals = vec![LangAcc::default(); LANGUAGES.len()];
    for worker in per_worker {
        for (dst, src) in totals.iter_mut().zip(worker) {
            dst.files += src.files;
            dst.code += src.code;
            dst.comments += src.comments;
            dst.blanks += src.blanks;
        }
    }

    let mut out: Vec<LocStat> = totals
        .into_iter()
        .enumerate()
        .filter(|(_, acc)| acc.code + acc.comments > 0)
        .map(|(idx, acc)| LocStat {
            name: LANGUAGES[idx].name,
            files: acc.files,
            code: acc.code,
            comments: acc.comments,
            blanks: acc.blanks,
        })
        .collect();

    out.sort_by(|a, b| {
        (b.code + b.comments)
            .cmp(&(a.code + a.comments))
            .then_with(|| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()))
            .then_with(|| a.name.cmp(b.name))
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn counts_blanks_single_and_block_comments_and_strings() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(
            root.join("main.rs"),
            concat!(
                "// top comment\n",
                "\n",
                "/* block start\n",
                "   /* nested block */\n",
                "   block end */\n",
                "fn main<'a>(_s: &'a str) {\n",
                "    let url = \"https://example.com\";\n",
                "    let quote = '\"'; // inline comment\n",
                "    let raw = r#\"// not a comment\"#;\n",
                "    /* inline block */ let x = 1;\n",
                "}\n",
            ),
        )
        .unwrap();

        let stats = count_loc(root).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(
            stats[0],
            LocStat {
                name: "Rust",
                files: 1,
                code: 6,
                comments: 4,
                blanks: 1,
            }
        );
    }

    #[test]
    fn counts_multiple_comment_styles_and_markdown_prose() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        fs::write(
            root.join("app.py"),
            "# header\n\nmsg = \"\"\"\n# inside multiline string\n\"\"\"\nprint(msg) # inline\n",
        )
        .unwrap();
        fs::write(root.join("init.lua"), "-- line\n--[[\nblock\n]]\nlocal x = 1\n").unwrap();
        fs::write(root.join("page.html"), "<!-- comment\nstill comment -->\n<div>hi</div>\n\n").unwrap();
        fs::write(root.join("README.md"), "# Title\n\nSome prose\n```rust\nlet a = 1;\n```\n").unwrap();

        let stats = count_loc(root).unwrap();
        let by_name = |name: &str| stats.iter().find(|s| s.name == name).cloned().unwrap();

        assert_eq!(
            by_name("Python"),
            LocStat {
                name: "Python",
                files: 1,
                code: 4,
                comments: 1,
                blanks: 1,
            }
        );
        assert_eq!(
            by_name("Lua"),
            LocStat {
                name: "Lua",
                files: 1,
                code: 1,
                comments: 4,
                blanks: 0,
            }
        );
        assert_eq!(
            by_name("HTML"),
            LocStat {
                name: "HTML",
                files: 1,
                code: 1,
                comments: 2,
                blanks: 1,
            }
        );
        assert_eq!(
            by_name("Markdown"),
            LocStat {
                name: "Markdown",
                files: 1,
                code: 3,
                comments: 2,
                blanks: 1,
            }
        );
    }

    #[test]
    fn skips_binary_files_with_nul_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        fs::write(root.join("good.go"), "package main\nfunc main() {}\n").unwrap();
        fs::write(root.join("early_bin.c"), b"int main() {\0 return 0; }\n").unwrap();
        let mut late_nul = vec![b'a'; SNIFF_BYTES + 128];
        late_nul.push(b'\n');
        late_nul[SNIFF_BYTES + 10] = 0;
        fs::write(root.join("late_bin.c"), late_nul).unwrap();

        let stats = count_loc(root).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].name, "Go");
    }

    #[test]
    fn honors_gitignore_and_excluded_dirs_and_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        fs::create_dir_all(root.join(".git/hooks")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(root.join("target/debug")).unwrap();
        fs::create_dir_all(root.join("ignored_dir")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();

        fs::write(root.join(".gitignore"), "ignored_dir/\n*.gen.ts\n").unwrap();
        fs::write(root.join(".git/hooks/pre-commit.sh"), "echo hook\n").unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "export const x = 1;\n").unwrap();
        fs::write(root.join("target/debug/out.rs"), "fn skip() {}\n").unwrap();
        fs::write(root.join("ignored_dir/skip.py"), "x = 1\n").unwrap();
        fs::write(root.join("src/schema.gen.ts"), "export type T = string;\n").unwrap();
        fs::write(root.join("Cargo.lock"), "[[package]]\nname = \"demo\"\n").unwrap();
        fs::write(root.join("bundle.min.js"), "function a(){return 1}\n").unwrap();
        fs::write(root.join("src/app.ts"), "export const ok = true;\n").unwrap();

        let stats = count_loc(root).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(
            stats[0],
            LocStat {
                name: "TypeScript",
                files: 1,
                code: 1,
                comments: 0,
                blanks: 0,
            }
        );
    }

    #[test]
    fn sorts_descending_by_code_plus_comments_and_omits_blank_only() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        fs::write(root.join("a.rs"), "fn a() {}\n// c\n").unwrap();
        fs::write(root.join("b.ts"), "const a = 1;\nconst b = 2;\n// c\nconst d = 4;\n").unwrap();
        fs::write(root.join("c.go"), "package p\n// c\n").unwrap();
        fs::write(root.join("blank.py"), "\n   \n\t\n").unwrap();

        let stats = count_loc(root).unwrap();
        let names: Vec<&str> = stats.iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["TypeScript", "Go", "Rust"]);
    }

    #[test]
    fn errors_when_root_is_not_a_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("file.rs");
        fs::write(&file, "fn main() {}\n").unwrap();
        assert!(matches!(count_loc(&file), Err(crate::FilesError::Io(_))));
        assert!(matches!(count_loc(&tmp.path().join("missing")), Err(crate::FilesError::Io(_))));
    }
}
