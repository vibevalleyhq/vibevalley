use std::path::{Path, PathBuf};
use std::sync::Mutex;

use ignore::WalkState;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};

use crate::walk::{io_error, walker};
use crate::{FuzzyMatch, Result};

/// Added when the whole query matches inside the file name, so `main` finds
/// `src/main.rs` before `domain/a/index.rs`.
const FILE_NAME_BONUS: u32 = 64;
/// Below this many files a query is faster on one thread than spread out.
const PARALLEL_THRESHOLD: usize = 16_384;

struct Item {
    /// Relative to the root, `/`-separated.
    path: Box<str>,
    /// Byte offset of the file name within `path`.
    name_at: u32,
}

impl Item {
    fn new(path: String) -> Item {
        let name_at = path.rfind('/').map_or(0, |at| at + 1) as u32;
        Item {
            path: path.into_boxed_str(),
            name_at,
        }
    }
}

pub(crate) struct Index {
    items: Vec<Item>,
}

/// Hands a worker's paths to the shared list when the worker finishes.
struct Collector<'a> {
    local: Vec<String>,
    shared: &'a Mutex<Vec<Vec<String>>>,
}

impl Drop for Collector<'_> {
    fn drop(&mut self) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.push(std::mem::take(&mut self.local));
        }
    }
}

/// The haystack as nucleo wants it. Built by hand rather than with
/// `Utf32Str::new`, which merges grapheme clusters: indices must stay plain
/// char indices.
fn haystack<'a>(text: &'a str, buf: &'a mut Vec<char>) -> Utf32Str<'a> {
    if text.is_ascii() {
        Utf32Str::Ascii(text.as_bytes())
    } else {
        buf.clear();
        buf.extend(text.chars());
        Utf32Str::Unicode(buf)
    }
}

struct Scorer {
    pattern: Pattern,
    /// A query with a `/` is about directories; the file-name pass is moot.
    try_name: bool,
    matcher: Matcher,
    buf: Vec<char>,
}

impl Scorer {
    fn new(query: &str) -> Scorer {
        Scorer {
            pattern: Pattern::parse(query, CaseMatching::Smart, Normalization::Smart),
            try_name: !query.contains('/'),
            matcher: Matcher::new(Config::DEFAULT.match_paths()),
            buf: Vec::new(),
        }
    }

    fn score(&mut self, item: &Item) -> Option<u32> {
        let full = self.pattern.score(haystack(&item.path, &mut self.buf), &mut self.matcher)?;
        if self.try_name {
            let name = &item.path[item.name_at as usize..];
            if let Some(score) = self.pattern.score(haystack(name, &mut self.buf), &mut self.matcher) {
                return Some(score + FILE_NAME_BONUS);
            }
        }
        Some(full)
    }

    fn indices(&mut self, item: &Item) -> Vec<u32> {
        let mut indices = Vec::new();
        let name = &item.path[item.name_at as usize..];
        let in_name = self.try_name && self.pattern.indices(haystack(name, &mut self.buf), &mut self.matcher, &mut indices).is_some();
        if in_name {
            let offset = item.path[..item.name_at as usize].chars().count() as u32;
            indices.iter_mut().for_each(|i| *i += offset);
        } else {
            indices.clear();
            self.pattern.indices(haystack(&item.path, &mut self.buf), &mut self.matcher, &mut indices);
        }
        indices.sort_unstable();
        indices.dedup();
        indices
    }
}

impl Index {
    pub fn build(root: &Path) -> Result<Index> {
        if !root.is_dir() {
            return Err(io_error(root, "not a directory"));
        }
        let shared = Mutex::new(Vec::new());
        walker(root).build_parallel().run(|| {
            let mut collector = Collector {
                local: Vec::new(),
                shared: &shared,
            };
            Box::new(move |entry| {
                let Ok(entry) = entry else { return WalkState::Continue };
                if entry.file_type().is_none_or(|t| t.is_dir()) {
                    return WalkState::Continue;
                }
                if let Ok(relative) = entry.path().strip_prefix(root)
                    && let Some(text) = relative.to_str()
                {
                    collector.local.push(text.to_string());
                }
                WalkState::Continue
            })
        });
        let paths = shared.into_inner().unwrap_or_else(|e| e.into_inner());
        Ok(Index::from_paths(paths.into_iter().flatten().collect()))
    }

    pub fn from_paths(mut paths: Vec<String>) -> Index {
        // Sorted so the empty query, and ties, come out the same every time.
        paths.sort_unstable();
        paths.dedup();
        Index {
            items: paths.into_iter().map(Item::new).collect(),
        }
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// `(score, item index)` of every match in `items`, whose first element
    /// has index `base`.
    fn score_all(query: &str, items: &[Item], base: usize) -> Vec<(u32, u32)> {
        let mut scorer = Scorer::new(query);
        let mut out = Vec::new();
        for (offset, item) in items.iter().enumerate() {
            if let Some(score) = scorer.score(item) {
                out.push((score, (base + offset) as u32));
            }
        }
        out
    }

    pub fn query(&self, query: &str, limit: usize) -> Vec<FuzzyMatch> {
        let query = query.trim();
        if limit == 0 {
            return Vec::new();
        }
        if query.is_empty() {
            return self
                .items
                .iter()
                .take(limit)
                .map(|item| FuzzyMatch {
                    path: PathBuf::from(&*item.path),
                    score: 0,
                    indices: Vec::new(),
                })
                .collect();
        }

        let threads = std::thread::available_parallelism().map_or(1, |n| n.get()).min(8);
        let mut scored: Vec<(u32, u32)> = if self.items.len() < PARALLEL_THRESHOLD || threads == 1 {
            Self::score_all(query, &self.items, 0)
        } else {
            let chunk = self.items.len().div_ceil(threads);
            std::thread::scope(|scope| {
                let workers: Vec<_> = self
                    .items
                    .chunks(chunk)
                    .enumerate()
                    .map(|(n, items)| scope.spawn(move || Self::score_all(query, items, n * chunk)))
                    .collect();
                workers.into_iter().flat_map(|w| w.join().unwrap_or_default()).collect()
            })
        };

        // Best score first; among equals the shorter file name (so `main`
        // puts `main.rs` before `maintainers.md`), then the shorter path,
        // then path order.
        let rank = |&(score, index): &(u32, u32)| {
            let item = &self.items[index as usize];
            let name_len = item.path.len() - item.name_at as usize;
            (std::cmp::Reverse(score), name_len, item.path.len(), index)
        };
        if scored.len() > limit {
            scored.select_nth_unstable_by_key(limit, rank);
            scored.truncate(limit);
        }
        scored.sort_unstable_by_key(rank);

        let mut scorer = Scorer::new(query);
        scored
            .into_iter()
            .map(|(score, index)| {
                let item = &self.items[index as usize];
                FuzzyMatch {
                    path: PathBuf::from(&*item.path),
                    score,
                    indices: scorer.indices(item),
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::Instant;

    use crate::FileIndex;

    fn index(paths: &[&str]) -> FileIndex {
        FileIndex::from_paths(paths.iter().map(|p| p.to_string()))
    }

    fn top(index: &FileIndex, query: &str) -> Vec<String> {
        index.query(query, 10).into_iter().map(|m| m.path.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn builds_from_disk_honoring_gitignore() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for dir in [".git", "src/ui", "target/debug", "文档", ".github"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        fs::write(root.join(".gitignore"), "target/\n*.tmp\n").unwrap();
        for file in [
            ".git/config",
            "src/main.rs",
            "src/ui/panel view.rs",
            "target/debug/app",
            "scratch.tmp",
            "文档/设计 说明.md",
            ".github/ci.yml",
        ] {
            fs::write(root.join(file), "").unwrap();
        }

        let index = FileIndex::build(root).unwrap();
        assert_eq!(
            top(&index, ""),
            vec![".github/ci.yml", ".gitignore", "src/main.rs", "src/ui/panel view.rs", "文档/设计 说明.md"]
        );
        assert_eq!(index.len(), 5);
        assert!(!index.is_empty());
        assert_eq!(index.query("", 2).len(), 2);
        assert!(index.query("main", 0).is_empty());
        assert!(FileIndex::build(&root.join("missing")).is_err());
        assert!(FileIndex::from_paths(Vec::new()).is_empty());
    }

    #[test]
    fn ranking_prefers_file_names_and_tight_matches() {
        let index = index(&[
            "crates/domain/src/admin/index.rs",
            "crates/app/src/main.rs",
            "docs/maintainers.md",
            "crates/app/src/main_menu.rs",
            "crates/term/src/lib.rs",
            "crates/files/src/lib.rs",
            "README.md",
        ]);
        let main = top(&index, "main");
        assert_eq!(main[0], "crates/app/src/main.rs");
        assert_eq!(main[1], "crates/app/src/main_menu.rs");
        assert_eq!(main.last().unwrap(), "crates/domain/src/admin/index.rs");

        // Directory words narrow the match; every word must match.
        assert_eq!(top(&index, "files lib"), vec!["crates/files/src/lib.rs"]);
        assert_eq!(top(&index, "term/lib")[0], "crates/term/src/lib.rs");
        // A fuzzy matcher also finds r-e-a-d-m-e scattered through a long
        // path; only the order is promised.
        assert_eq!(top(&index, "readme")[0], "README.md");
        assert!(top(&index, "zzzz").is_empty());
        // Smart case: an upper-case letter makes the query case-sensitive.
        assert!(top(&index, "Readme").is_empty());

        let scores: Vec<u32> = index.query("main", 10).iter().map(|m| m.score).collect();
        assert!(scores.windows(2).all(|w| w[0] >= w[1]), "{scores:?}");
    }

    #[test]
    fn indices_are_char_positions_in_the_path() {
        let index = index(&["文档/设计 说明.md", "src/ui/panel view.rs", "cafe\u{301}/menu.txt"]);

        let hit = &index.query("panel", 10)[0];
        assert_eq!(hit.indices, vec![7, 8, 9, 10, 11]);
        let chars: Vec<char> = hit.path.to_str().unwrap().chars().collect();
        let matched: String = hit.indices.iter().map(|i| chars[*i as usize]).collect();
        assert_eq!(matched, "panel");

        let hit = &index.query("说明", 10)[0];
        assert_eq!(hit.path.to_str().unwrap(), "文档/设计 说明.md");
        assert_eq!(hit.indices, vec![6, 7]);

        // A match across directories.
        let hit = &index.query("ui/view", 10)[0];
        let chars: Vec<char> = hit.path.to_str().unwrap().chars().collect();
        let matched: String = hit.indices.iter().map(|i| chars[*i as usize]).collect();
        assert_eq!(matched, "ui/view");

        // The combining accent is its own char and shifts what follows.
        let hit = &index.query("menu", 10)[0];
        assert_eq!(hit.indices, vec![6, 7, 8, 9]);
    }

    /// Benchmark-style: a generated tree of 100k files. Run with
    /// `--nocapture` to see the timings; the assertions are loose upper
    /// bounds so a busy machine does not fail the suite.
    #[test]
    fn hundred_thousand_files_build_and_query_quickly() {
        const FILES: usize = 100_000;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        fs::create_dir(root.join("ignored")).unwrap();
        fs::write(root.join("ignored/skip.rs"), "").unwrap();

        let words = ["render", "layout", "session", "terminal", "agent", "store", "diff", "index"];
        std::thread::scope(|scope| {
            for worker in 0..8 {
                scope.spawn(move || {
                    for n in (worker..FILES - 2).step_by(8) {
                        let dir = root.join(format!("pkg{:02}/{}/mod{:03}", n % 40, words[n % words.len()], (n / 40) % 125));
                        if !dir.exists() {
                            let _ = fs::create_dir_all(&dir);
                        }
                        let name = format!("{}_{n}.rs", words[(n / 7) % words.len()]);
                        fs::write(dir.join(name), "").unwrap();
                    }
                });
            }
        });
        fs::create_dir_all(root.join("apps/mac/src")).unwrap();
        fs::write(root.join("apps/mac/src/workbench_panel.rs"), "").unwrap();

        let started = Instant::now();
        let index = FileIndex::build(root).unwrap();
        let build = started.elapsed();
        assert_eq!(index.len(), FILES);

        let mut worst = std::time::Duration::ZERO;
        let mut report = Vec::new();
        for query in ["wbpanel", "terminal", "pkg07 session 4242", "mod099/agent", "zzqqxx", "e"] {
            // Warm once, then take the best of a few runs.
            index.query(query, 50);
            let best = (0..5)
                .map(|_| {
                    let started = Instant::now();
                    let hits = index.query(query, 50);
                    (started.elapsed(), hits.len())
                })
                .min()
                .unwrap();
            worst = worst.max(best.0);
            report.push(format!("{query:?}: {:?} ({} hits)", best.0, best.1));
        }
        println!("index build over {FILES} files: {build:?}");
        println!("queries: {}", report.join(", "));

        assert_eq!(index.query("wbpanel", 5)[0].path.to_str().unwrap(), "apps/mac/src/workbench_panel.rs");
        assert_eq!(index.query("terminal", 50).len(), 50);
        assert!(build.as_millis() < 2_000, "build took {build:?}");
        assert!(worst.as_millis() < 50, "slowest query took {worst:?}");
    }
}
