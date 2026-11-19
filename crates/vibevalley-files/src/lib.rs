//! File tree, watching, fuzzy file finding, content search, and loading +
//! syntax-highlighting files for the read-only viewer. No GPUI dependency.
//! All functions block; callers run them on background threads.
//!
//! CONTRACT: the items in this file are the public API other crates compile
//! against. The owner may add items; do not rename or remove existing ones.

use std::ops::Range;
use std::path::{Path, PathBuf};

mod fuzzy;
mod load;
mod search;
mod walk;
mod watch;

#[derive(Debug, thiserror::Error)]
pub enum FilesError {
    #[error("io: {0}")]
    Io(String),
    #[error("watch: {0}")]
    Watch(String),
    #[error("invalid search pattern: {0}")]
    Pattern(String),
}

pub type Result<T> = std::result::Result<T, FilesError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    Dir,
    File,
    Symlink,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// `dir` joined with the name: absolute when `root` is.
    pub path: PathBuf,
    pub name: String,
    pub kind: EntryKind,
    /// Matched by .gitignore (only returned when `show_ignored` is set).
    pub ignored: bool,
    pub hidden: bool,
}

/// Children of one directory: directories first, then files, each sorted
/// case-insensitively. `.git` is never returned. `dir` may be absolute or
/// relative to `root`. Ignore rules come from every `.gitignore` between
/// the enclosing repository root and `dir`, `.git/info/exclude` and the
/// user's global excludes file.
pub fn list_dir(root: &Path, dir: &Path, show_ignored: bool) -> Result<Vec<Entry>> {
    walk::list_dir(root, dir, show_ignored)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsChangeKind {
    Created,
    Modified,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsChange {
    pub path: PathBuf,
    pub kind: FsChangeKind,
}

/// Watches a directory tree. Changes are debounced and delivered in batches
/// on a background thread. Dropping the watcher stops it.
///
/// Paths are reported under `root` as it was given. Build output (cargo
/// target directories, `node_modules`), paths ignored by the root
/// `.gitignore` and git's internals are not reported, with one exception:
/// the files inside `.git` whose change means git status, the current branch
/// or the branch list changed (`index`, `HEAD`, `refs/...`, `MERGE_HEAD`,
/// ...) are reported as changes to those paths. For a linked worktree those
/// files live in the main repository and are reported with their real path
/// there.
pub struct Watcher {
    _inner: watch::Inner,
}

impl Watcher {
    pub fn new(root: &Path, on_change: impl Fn(Vec<FsChange>) + Send + 'static) -> Result<Watcher> {
        Ok(Watcher {
            _inner: watch::Inner::start(root, Box::new(on_change))?,
        })
    }

    /// True for a path inside a `.git` directory that the watcher reports,
    /// i.e. one whose change should make the app re-read git status.
    pub fn is_git_state_path(path: &Path) -> bool {
        watch::is_git_state_path(path)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FuzzyMatch {
    /// Relative to the index root.
    pub path: PathBuf,
    pub score: u32,
    /// Char indices of `path` (as a string) that matched, for highlighting.
    pub indices: Vec<u32>,
}

/// All non-ignored files under a root, for fuzzy "go to file".
pub struct FileIndex {
    inner: fuzzy::Index,
}

impl FileIndex {
    pub fn build(root: &Path) -> Result<FileIndex> {
        Ok(FileIndex {
            inner: fuzzy::Index::build(root)?,
        })
    }

    /// An index over paths that are already known (relative, `/`-separated).
    pub fn from_paths(paths: impl IntoIterator<Item = String>) -> FileIndex {
        FileIndex {
            inner: fuzzy::Index::from_paths(paths.into_iter().collect()),
        }
    }

    pub fn len(&self) -> usize {
        self.inner.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Best matches first. An empty query returns the first `limit` files.
    /// Matches in the file name outrank matches spread over directories;
    /// space-separated words must all match.
    pub fn query(&self, query: &str, limit: usize) -> Vec<FuzzyMatch> {
        self.inner.query(query, limit)
    }
}

#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    /// Stop after this many hits. `0` means no limit.
    pub max_results: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    /// `root` joined with the file's relative path.
    pub path: PathBuf,
    /// 1-based.
    pub line_no: u32,
    /// Without the line terminator. Very long lines are cut short.
    pub line: String,
    /// Byte ranges of `line` that matched.
    pub ranges: Vec<Range<usize>>,
}

/// Searches file contents under `root`, honoring .gitignore. Calls `on_hit`
/// as results are found; return `false` from it to stop early. Files are
/// searched in parallel: hits of one file arrive together and in line
/// order, the order of files is not defined. Binary files are skipped.
pub fn search(root: &Path, pattern: &str, opts: &SearchOptions, on_hit: &mut dyn FnMut(SearchHit) -> bool) -> Result<()> {
    search::search(root, pattern, opts, on_hit)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileContent {
    Text { text: String, language: Option<Language> },
    Image { path: PathBuf },
    Binary { size: u64 },
    TooLarge { size: u64 },
}

/// Classifies and loads a file for the viewer. Images (by extension, SVG
/// included) are not read. Text is decoded as UTF-8, or UTF-16 when it has a
/// byte-order mark, with invalid sequences replaced.
pub fn load_file(path: &Path, max_bytes: u64) -> Result<FileContent> {
    load::load_file(path, max_bytes)
}

/// A language the highlighter knows, e.g. "rust", "typescript", "markdown".
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Language(pub String);

impl Language {
    pub fn from_path(path: &Path) -> Option<Language> {
        load::language_from_path(path).map(|name| Language(name.to_string()))
    }

    /// Canonical names of the languages `highlight` supports.
    pub fn supported() -> &'static [&'static str] {
        SUPPORTED
    }
}

pub const SUPPORTED: &[&str] = &[
    "rust",
    "typescript",
    "tsx",
    "javascript",
    "json",
    "toml",
    "yaml",
    "markdown",
    "python",
    "go",
    "bash",
    "html",
    "css",
    "c",
    "cpp",
    "zig",
    "swift",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HighlightKind {
    Keyword,
    Function,
    Type,
    Variable,
    Property,
    Constant,
    String,
    Number,
    Comment,
    Operator,
    Punctuation,
    Attribute,
    Tag,
    Heading,
    Emphasis,
    Link,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HighlightSpan {
    /// Byte range within its line.
    pub range: Range<usize>,
    pub kind: HighlightKind,
}
