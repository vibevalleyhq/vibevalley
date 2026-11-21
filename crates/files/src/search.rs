use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::Lossy;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::WalkState;

use crate::walk::{io_error, walker};
use crate::{FilesError, Result, SearchHit, SearchOptions};

/// Longer lines (minified bundles, data files) are cut to this many bytes.
const MAX_LINE_BYTES: usize = 2000;

fn build_matcher(pattern: &str, opts: &SearchOptions) -> Result<RegexMatcher> {
    RegexMatcherBuilder::new()
        .case_insensitive(!opts.case_sensitive)
        .word(opts.whole_word)
        .fixed_strings(!opts.regex)
        .line_terminator(Some(b'\n'))
        .build(pattern)
        .map_err(|e| FilesError::Pattern(e.to_string()))
}

fn search_file(matcher: &RegexMatcher, path: &Path, stop: &AtomicBool) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    let mut searcher = SearcherBuilder::new().binary_detection(BinaryDetection::quit(0)).line_number(true).build();
    let sink = Lossy(|line_no, line: &str| {
        let mut line = line.trim_end_matches(['\n', '\r']);
        if line.len() > MAX_LINE_BYTES {
            let mut cut = MAX_LINE_BYTES;
            while !line.is_char_boundary(cut) {
                cut -= 1;
            }
            line = &line[..cut];
        }
        let mut ranges = Vec::new();
        let _ = matcher.find_iter(line.as_bytes(), |m| {
            if !m.is_empty() {
                ranges.push(m.start()..m.end());
            }
            true
        });
        hits.push(SearchHit {
            path: path.to_path_buf(),
            line_no: u32::try_from(line_no).unwrap_or(u32::MAX),
            line: line.to_string(),
            ranges,
        });
        Ok(!stop.load(Ordering::Relaxed))
    });
    // Unreadable files are simply not part of the results.
    let _ = searcher.search_path(matcher, path, sink);
    hits
}

pub(crate) fn search(root: &Path, pattern: &str, opts: &SearchOptions, on_hit: &mut dyn FnMut(SearchHit) -> bool) -> Result<()> {
    if !root.is_dir() {
        return Err(io_error(root, "not a directory"));
    }
    if pattern.is_empty() {
        return Ok(());
    }
    let matcher = build_matcher(pattern, opts)?;
    let stop = AtomicBool::new(false);
    // Bounded, so workers do not race far ahead of a slow consumer.
    let (sender, receiver) = mpsc::sync_channel::<Vec<SearchHit>>(64);

    std::thread::scope(|scope| {
        let (matcher, stop) = (&matcher, &stop);
        scope.spawn(move || {
            walker(root).build_parallel().run(|| {
                let sender = sender.clone();
                Box::new(move |entry| {
                    if stop.load(Ordering::Relaxed) {
                        return WalkState::Quit;
                    }
                    let Ok(entry) = entry else { return WalkState::Continue };
                    if !entry.file_type().is_some_and(|t| t.is_file()) {
                        return WalkState::Continue;
                    }
                    let hits = search_file(matcher, entry.path(), stop);
                    if !hits.is_empty() && sender.send(hits).is_err() {
                        return WalkState::Quit;
                    }
                    WalkState::Continue
                })
            });
        });

        let mut delivered = 0usize;
        'files: for hits in receiver.iter() {
            for hit in hits {
                delivered += 1;
                let wants_more = on_hit(hit);
                if !wants_more || (opts.max_results != 0 && delivered >= opts.max_results) {
                    stop.store(true, Ordering::Relaxed);
                    break 'files;
                }
            }
        }
        // Dropping the receiver unblocks any worker waiting to send.
        drop(receiver);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;

    fn tree() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for dir in [".git", "src", "target", "文档 目录"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        fs::write(root.join(".gitignore"), "target/\n").unwrap();
        fs::write(root.join(".git/config"), "needle in git internals\n").unwrap();
        fs::write(root.join("target/out.txt"), "needle in build output\n").unwrap();
        fs::write(
            root.join("src/main.rs"),
            "fn main() {\n    let needle = find_needle();\n    // Needle, NEEDLE\r\n}\n",
        )
        .unwrap();
        fs::write(root.join("src/lib.rs"), "pub fn needles() {}\nfn a.b() {}\n").unwrap();
        fs::write(root.join("文档 目录/说明.md"), "第一行\n这里有 needle 和 针\n").unwrap();
        fs::write(root.join("data.bin"), b"needle\0binary").unwrap();
        fs::write(root.join(".hidden.txt"), "hidden needle\n").unwrap();
        tmp
    }

    fn run(root: &Path, pattern: &str, opts: SearchOptions) -> Vec<SearchHit> {
        let mut hits = Vec::new();
        search(root, pattern, &opts, &mut |hit| {
            hits.push(hit);
            true
        })
        .unwrap();
        hits.sort_by(|a, b| (&a.path, a.line_no).cmp(&(&b.path, b.line_no)));
        hits
    }

    fn at(root: &Path, hits: &[SearchHit]) -> Vec<(String, u32)> {
        hits.iter()
            .map(|h| (h.path.strip_prefix(root).unwrap().to_string_lossy().into_owned(), h.line_no))
            .collect()
    }

    #[test]
    fn literal_search_honors_gitignore_and_reports_ranges() {
        let tmp = tree();
        let root = tmp.path();
        let hits = run(root, "needle", SearchOptions::default());
        assert_eq!(
            at(root, &hits),
            vec![
                (".hidden.txt".to_string(), 1),
                ("src/lib.rs".to_string(), 1),
                ("src/main.rs".to_string(), 2),
                ("src/main.rs".to_string(), 3),
                ("文档 目录/说明.md".to_string(), 2),
            ]
        );
        let line2 = &hits[2];
        assert_eq!(line2.path, root.join("src/main.rs"));
        assert_eq!(line2.line, "    let needle = find_needle();");
        assert_eq!(line2.ranges, vec![8..14, 22..28]);
        // Case-insensitive by default; the CR of a CRLF line is not kept.
        assert_eq!(hits[3].line, "    // Needle, NEEDLE");
        assert_eq!(hits[3].ranges.len(), 2);
        let chinese = &hits[4];
        assert_eq!(&chinese.line[chinese.ranges[0].clone()], "needle");

        let chinese = run(root, "针", SearchOptions::default());
        assert_eq!(chinese.len(), 1);
        assert_eq!(&chinese[0].line[chinese[0].ranges[0].clone()], "针");
    }

    #[test]
    fn options_case_word_regex() {
        let tmp = tree();
        let root = tmp.path();

        let sensitive = run(
            root,
            "NEEDLE",
            SearchOptions {
                case_sensitive: true,
                ..Default::default()
            },
        );
        assert_eq!(at(root, &sensitive), vec![("src/main.rs".to_string(), 3)]);
        assert_eq!(sensitive[0].ranges, vec![15..21]);

        let words = run(
            root,
            "needle",
            SearchOptions {
                whole_word: true,
                ..Default::default()
            },
        );
        assert!(!at(root, &words).contains(&("src/lib.rs".to_string(), 1)));
        assert_eq!(
            words.iter().find(|h| h.line_no == 2 && h.path.ends_with("main.rs")).unwrap().ranges,
            vec![8..14]
        );

        let regex = run(
            root,
            r"fn \w+\(\)",
            SearchOptions {
                regex: true,
                case_sensitive: true,
                ..Default::default()
            },
        );
        assert_eq!(at(root, &regex), vec![("src/lib.rs".to_string(), 1), ("src/main.rs".to_string(), 1)]);
        assert_eq!(&regex[0].line[regex[0].ranges[0].clone()], "fn needles()");

        // Without `regex`, metacharacters are literal.
        let literal = run(root, "a.b()", SearchOptions::default());
        assert_eq!(at(root, &literal), vec![("src/lib.rs".to_string(), 2)]);
        assert!(run(root, r"\w+", SearchOptions::default()).is_empty());

        assert!(run(root, "", SearchOptions::default()).is_empty());
        let bad = search(
            root,
            "(unclosed",
            &SearchOptions {
                regex: true,
                ..Default::default()
            },
            &mut |_| true,
        );
        assert!(matches!(bad, Err(FilesError::Pattern(_))));
        let missing = search(&root.join("nope"), "x", &SearchOptions::default(), &mut |_| true);
        assert!(matches!(missing, Err(FilesError::Io(_))));
    }

    #[test]
    fn stops_early_on_callback_and_on_max_results() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for n in 0..200 {
            fs::write(root.join(format!("f{n}.txt")), "hit\n".repeat(50)).unwrap();
        }

        let mut seen = 0;
        search(root, "hit", &SearchOptions::default(), &mut |_| {
            seen += 1;
            seen < 7
        })
        .unwrap();
        assert_eq!(seen, 7);

        let limited = run(
            root,
            "hit",
            SearchOptions {
                max_results: 120,
                ..Default::default()
            },
        );
        assert_eq!(limited.len(), 120);
        // Hits of one file stay together and in order.
        let first: PathBuf = limited[0].path.clone();
        let lines: Vec<u32> = limited.iter().filter(|h| h.path == first).map(|h| h.line_no).collect();
        assert!(lines.windows(2).all(|w| w[0] + 1 == w[1]), "{lines:?}");

        assert_eq!(run(root, "hit", SearchOptions::default()).len(), 200 * 50);
    }

    #[test]
    fn long_lines_are_truncated() {
        let tmp = tempfile::tempdir().unwrap();
        let line = format!("start needle {} needle end\n", "é".repeat(3000));
        fs::write(tmp.path().join("min.js"), line).unwrap();
        let hits = run(tmp.path(), "needle", SearchOptions::default());
        assert_eq!(hits.len(), 1);
        assert!(hits[0].line.len() <= MAX_LINE_BYTES);
        assert_eq!(hits[0].ranges, vec![6..12]);
    }
}
