use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;

use super::*;

/// Applied to every git process the crate spawns under test, so nothing
/// depends on (or runs hooks/signing from) the developer's own git config.
pub(crate) const ISOLATED_ENV: &[(&str, &str)] = &[
    ("GIT_CONFIG_GLOBAL", "/dev/null"),
    ("GIT_CONFIG_SYSTEM", "/dev/null"),
    ("GIT_CONFIG_NOSYSTEM", "1"),
    ("GIT_AUTHOR_NAME", "Test Author"),
    ("GIT_AUTHOR_EMAIL", "author@example.com"),
    ("GIT_COMMITTER_NAME", "Test Committer"),
    ("GIT_COMMITTER_EMAIL", "committer@example.com"),
];

const SPACED: &str = "dir with space/my file.txt";
const CHINESE: &str = "文档/读我 说明.md";

fn git_in(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(["-c", "core.quotepath=off"])
        .args(args)
        .envs(ISOLATED_ENV.iter().copied())
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

struct Fixture {
    _dir: TempDir,
    repo: Repo,
}

impl Fixture {
    /// An initialised repository with no commits.
    fn empty() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        fs::create_dir(&root).unwrap();
        git_in(&root, &["init", "-q", "-b", "main"]);
        let repo = Repo::discover(&root).unwrap().expect("repository");
        assert_eq!(repo.root(), root.canonicalize().unwrap());
        Fixture { _dir: dir, repo }
    }

    /// A repository with one commit holding a few files.
    fn new() -> Fixture {
        let f = Fixture::empty();
        f.write("a.txt", numbered(30));
        f.write(SPACED, "one\ntwo\nthree\n");
        f.write(CHINESE, "第一行\n第二行\n");
        f.git(&["add", "-A"]);
        f.git(&["commit", "-q", "-m", "initial"]);
        f
    }

    fn root(&self) -> &Path {
        self.repo.root()
    }

    fn git(&self, args: &[&str]) -> String {
        git_in(self.root(), args)
    }

    fn write(&self, path: &str, content: impl AsRef<[u8]>) {
        let full = self.root().join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, content).unwrap();
    }

    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.root().join(path)).unwrap()
    }

    fn exists(&self, path: &str) -> bool {
        self.root().join(path).exists()
    }

    fn entry(&self, path: &str) -> Option<StatusEntry> {
        self.repo.status().unwrap().entries.into_iter().find(|e| e.path == Path::new(path))
    }

    fn states(&self) -> Vec<(String, Change, Change)> {
        let mut all: Vec<_> = self
            .repo
            .status()
            .unwrap()
            .entries
            .into_iter()
            .map(|e| (e.path.to_string_lossy().into_owned(), e.index, e.worktree))
            .collect();
        all.sort_by(|a, b| a.0.cmp(&b.0));
        all
    }
}

fn numbered(n: usize) -> String {
    (1..=n).map(|i| format!("line {i}\n")).collect()
}

fn paths(list: &[&str]) -> Vec<PathBuf> {
    list.iter().map(PathBuf::from).collect()
}

fn one(mut diffs: Vec<FileDiff>) -> FileDiff {
    assert_eq!(diffs.len(), 1, "{diffs:#?}");
    diffs.remove(0)
}

fn texts(hunk: &Hunk, kind: LineKind) -> Vec<&str> {
    hunk.lines.iter().filter(|l| l.kind == kind).map(|l| l.text.as_str()).collect()
}

#[test]
fn discover() {
    let outside = tempfile::tempdir().unwrap();
    assert_eq!(Repo::discover(outside.path()).unwrap(), None);
    assert_eq!(Repo::discover(&outside.path().join("missing/deeper")).unwrap(), None);

    let f = Fixture::new();
    let root = f.root().to_path_buf();
    for inside in [root.clone(), root.join("文档"), root.join(SPACED), root.join("new-file.rs")] {
        assert_eq!(Repo::discover(&inside).unwrap().unwrap().root(), root, "{inside:?}");
    }
    assert_eq!(Repo::discover(&root.join(".git")).unwrap(), None);
}

#[test]
fn status_before_first_commit() {
    let f = Fixture::empty();
    let status = f.repo.status().unwrap();
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert_eq!(status.head, None);
    assert!(status.entries.is_empty());

    f.write(CHINESE, "内容\n");
    f.write("staged.txt", "x\n");
    f.repo.stage(&paths(&["staged.txt"])).unwrap();
    assert_eq!(
        f.states(),
        vec![
            ("staged.txt".to_string(), Change::Added, Change::Unmodified),
            (CHINESE.to_string(), Change::Unmodified, Change::Untracked),
        ]
    );
    assert_eq!(f.repo.head().unwrap(), None);
    assert!(f.repo.log(None, 0, 10).unwrap().is_empty());

    f.repo.unstage(&paths(&["staged.txt"])).unwrap();
    assert_eq!(f.entry("staged.txt").unwrap().worktree, Change::Untracked);
}

#[test]
fn status_reports_every_kind_of_change() {
    let f = Fixture::new();
    let status = f.repo.status().unwrap();
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert_eq!(status.head, f.repo.head().unwrap());
    assert_eq!(status.upstream, None);
    assert!(status.entries.is_empty());

    f.write("a.txt", "changed\n");
    f.write(SPACED, "one\ntwo\nthree\nfour\n");
    f.repo.stage(&paths(&[SPACED])).unwrap();
    f.write(SPACED, "one\ntwo\nthree\nfour\nfive\n");
    f.git(&["mv", CHINESE, "文档/改名 后.md"]);
    f.write("新 文件.txt", "untracked\n");
    f.write("gone.txt", "x\n");
    f.git(&["add", "gone.txt"]);
    f.git(&["commit", "-q", "-m", "add gone", "--", "gone.txt"]);
    fs::remove_file(f.root().join("gone.txt")).unwrap();

    assert_eq!(
        f.states(),
        vec![
            ("a.txt".to_string(), Change::Unmodified, Change::Modified),
            (SPACED.to_string(), Change::Modified, Change::Modified),
            ("gone.txt".to_string(), Change::Unmodified, Change::Deleted),
            ("文档/改名 后.md".to_string(), Change::Renamed, Change::Unmodified),
            ("新 文件.txt".to_string(), Change::Unmodified, Change::Untracked),
        ]
    );
    let renamed = f.entry("文档/改名 后.md").unwrap();
    assert_eq!(renamed.orig_path, Some(PathBuf::from(CHINESE)));
}

#[test]
fn status_detached_head_and_upstream_counts() {
    let f = Fixture::new();
    let head = f.repo.head().unwrap().unwrap();
    f.git(&["checkout", "-q", "--detach"]);
    let status = f.repo.status().unwrap();
    assert_eq!(status.branch, None);
    assert_eq!(status.head.as_deref(), Some(head.as_str()));
    f.git(&["checkout", "-q", "main"]);

    let clone_dir = tempfile::tempdir().unwrap();
    let clone_path = clone_dir.path().join("clone");
    git_in(clone_dir.path(), &["clone", "-q", f.root().to_str().unwrap(), clone_path.to_str().unwrap()]);
    let clone = Repo::discover(&clone_path).unwrap().unwrap();
    fs::write(clone_path.join("local.txt"), "x\n").unwrap();
    clone.stage(&paths(&["local.txt"])).unwrap();
    clone.commit("local work").unwrap();
    f.write("upstream1.txt", "x\n");
    f.git(&["add", "-A"]);
    f.git(&["commit", "-q", "-m", "upstream 1"]);
    f.write("upstream2.txt", "x\n");
    f.git(&["add", "-A"]);
    f.git(&["commit", "-q", "-m", "upstream 2"]);
    git_in(&clone_path, &["fetch", "-q"]);

    let status = clone.status().unwrap();
    assert_eq!(status.upstream.as_deref(), Some("origin/main"));
    assert_eq!((status.ahead, status.behind), (1, 2));

    let branches = clone.branches().unwrap();
    let names: Vec<_> = branches.iter().map(|b| (b.name.as_str(), b.is_remote, b.is_head)).collect();
    assert_eq!(names, vec![("main", false, true), ("origin/main", true, false)]);
    assert_eq!(branches[0].upstream.as_deref(), Some("origin/main"));
    assert_eq!(branches[1].tip, f.repo.head().unwrap().unwrap());
}

#[test]
fn diff_unstaged_and_staged_line_numbers() {
    let f = Fixture::new();
    let mut text = numbered(30);
    text = text.replace("line 5\n", "line five\n").replace("line 25\n", "line 25\nextra\n");
    f.write("a.txt", text);

    let file = one(f.repo.diff(&DiffTarget::Unstaged, None).unwrap());
    assert_eq!(file.old_path.as_deref(), Some(Path::new("a.txt")));
    assert_eq!(file.new_path.as_deref(), Some(Path::new("a.txt")));
    assert_eq!(file.change, Change::Modified);
    assert!(!file.binary);
    assert_eq!((file.added, file.removed), (2, 1));
    assert_eq!(file.hunks.len(), 2);

    let first = &file.hunks[0];
    assert_eq!((first.old_start, first.old_lines, first.new_start, first.new_lines), (2, 7, 2, 7));
    assert!(first.header.starts_with("@@ -2,7 +2,7 @@"));
    let removed = first.lines.iter().find(|l| l.kind == LineKind::Removed).unwrap();
    let added = first.lines.iter().find(|l| l.kind == LineKind::Added).unwrap();
    assert_eq!((removed.old_no, removed.new_no, removed.text.as_str()), (Some(5), None, "line 5"));
    assert_eq!((added.old_no, added.new_no, added.text.as_str()), (None, Some(5), "line five"));
    assert_eq!(removed.emphasis, vec![5..6]);
    assert_eq!(added.emphasis, vec![5..9]);
    let context = &first.lines[0];
    assert_eq!((context.kind, context.old_no, context.new_no), (LineKind::Context, Some(2), Some(2)));

    let second = &file.hunks[1];
    let extra = second.lines.iter().find(|l| l.kind == LineKind::Added).unwrap();
    assert_eq!((extra.new_no, extra.text.as_str()), (Some(26), "extra"));
    assert!(extra.emphasis.is_empty());
    let after = second.lines.iter().find(|l| l.text == "line 26").unwrap();
    assert_eq!((after.old_no, after.new_no), (Some(26), Some(27)));

    assert!(f.repo.diff(&DiffTarget::Staged, None).unwrap().is_empty());
    f.repo.stage(&paths(&["a.txt"])).unwrap();
    assert!(f.repo.diff(&DiffTarget::Unstaged, None).unwrap().is_empty());
    assert_eq!(one(f.repo.diff(&DiffTarget::Staged, None).unwrap()), file);
}

#[test]
fn diff_new_deleted_renamed_binary_and_no_newline() {
    let f = Fixture::new();
    f.write("bin.dat", [0u8, 159, 146, 150, 0, 1, 2, 3]);
    f.git(&["add", "-A"]);
    f.git(&["commit", "-q", "-m", "binary"]);

    f.write("bin.dat", [9u8, 0, 0, 7, 255, 254]);
    f.write("新 文件.txt", "alpha\nbeta");
    fs::remove_file(f.root().join("a.txt")).unwrap();
    f.git(&["mv", SPACED, "dir with space/renamed file.txt"]);
    f.write("dir with space/renamed file.txt", "one\ntwo\nthree\nfour");
    f.write(CHINESE, "第一行\n第二行改\n");
    f.git(&["add", "-A"]);

    let diffs = f.repo.diff(&DiffTarget::Staged, None).unwrap();
    let by_change = |change: Change| diffs.iter().find(|d| d.change == change).unwrap();
    assert_eq!(diffs.len(), 5);

    let added = by_change(Change::Added);
    assert_eq!(added.old_path, None);
    assert_eq!(added.new_path.as_deref(), Some(Path::new("新 文件.txt")));
    assert_eq!((added.added, added.removed), (2, 0));
    let kinds: Vec<_> = added.hunks[0].lines.iter().map(|l| l.kind).collect();
    assert_eq!(kinds, vec![LineKind::Added, LineKind::Added, LineKind::NoNewline]);
    assert_eq!(added.hunks[0].lines[1].new_no, Some(2));
    assert_eq!((added.hunks[0].old_start, added.hunks[0].old_lines), (0, 0));

    let deleted = by_change(Change::Deleted);
    assert_eq!(deleted.old_path.as_deref(), Some(Path::new("a.txt")));
    assert_eq!(deleted.new_path, None);
    assert_eq!((deleted.added, deleted.removed), (0, 30));
    assert_eq!(deleted.hunks[0].lines[29].old_no, Some(30));

    let renamed = by_change(Change::Renamed);
    assert_eq!(renamed.old_path.as_deref(), Some(Path::new(SPACED)));
    assert_eq!(renamed.new_path.as_deref(), Some(Path::new("dir with space/renamed file.txt")));
    assert_eq!(texts(&renamed.hunks[0], LineKind::Added), vec!["four"]);
    assert_eq!(renamed.hunks[0].lines.last().unwrap().kind, LineKind::NoNewline);

    let binary = diffs.iter().find(|d| d.binary).unwrap();
    assert_eq!(binary.new_path.as_deref(), Some(Path::new("bin.dat")));
    assert_eq!(binary.change, Change::Modified);
    assert!(binary.hunks.is_empty());

    let chinese = diffs.iter().find(|d| d.new_path.as_deref() == Some(Path::new(CHINESE))).unwrap();
    let hunk = &chinese.hunks[0];
    assert_eq!(texts(hunk, LineKind::Removed), vec!["第二行"]);
    assert_eq!(texts(hunk, LineKind::Added), vec!["第二行改"]);
    let added_line = hunk.lines.iter().find(|l| l.kind == LineKind::Added).unwrap();
    assert_eq!(&added_line.text[added_line.emphasis[0].clone()], "改");

    // A pure rename has no hunks at all.
    f.git(&["commit", "-q", "-m", "changes"]);
    f.git(&["mv", CHINESE, "文档/新名字.md"]);
    let pure = one(f.repo.diff(&DiffTarget::Staged, None).unwrap());
    assert_eq!(pure.change, Change::Renamed);
    assert_eq!(pure.old_path.as_deref(), Some(Path::new(CHINESE)));
    assert_eq!(pure.new_path.as_deref(), Some(Path::new("文档/新名字.md")));
    assert!(pure.hunks.is_empty());
}

#[test]
fn diff_uncommitted_includes_untracked_files() {
    let f = Fixture::new();
    f.write(".gitignore", "ignored/\n");
    f.git(&["add", ".gitignore"]);
    f.git(&["commit", "-q", "-m", "ignore"]);

    f.write("a.txt", numbered(30).replace("line 10\n", "LINE 10\n"));
    f.write(SPACED, "one\ntwo\nthree\nstaged\n");
    f.repo.stage(&paths(&[SPACED])).unwrap();
    f.write("新目录/未跟踪 文件.txt", "甲\n乙\n丙\n");
    f.write("untracked.bin", [0u8, 1, 2, 0, 255]);
    f.write("empty.txt", "");
    f.write("ignored/skip.txt", "never shown\n");
    let index_before = fs::read(f.root().join(".git/index")).unwrap();
    let status_before = f.git(&["status", "--porcelain"]);

    let diffs = f.repo.diff(&DiffTarget::Uncommitted, None).unwrap();
    let find = |p: &str| {
        diffs
            .iter()
            .find(|d| d.new_path.as_deref() == Some(Path::new(p)))
            .unwrap_or_else(|| panic!("no diff for {p}: {diffs:#?}"))
    };
    assert_eq!(diffs.len(), 5);
    assert_eq!(find("a.txt").change, Change::Modified);
    assert_eq!(texts(&find(SPACED).hunks[0], LineKind::Added), vec!["staged"]);

    let untracked = find("新目录/未跟踪 文件.txt");
    assert_eq!(untracked.change, Change::Added);
    assert_eq!(untracked.old_path, None);
    assert_eq!((untracked.added, untracked.removed), (3, 0));
    assert_eq!(texts(&untracked.hunks[0], LineKind::Added), vec!["甲", "乙", "丙"]);
    assert_eq!(untracked.hunks[0].lines[2].new_no, Some(3));

    let binary = find("untracked.bin");
    assert!(binary.binary && binary.hunks.is_empty());
    assert_eq!(binary.change, Change::Added);
    assert_eq!(find("empty.txt").change, Change::Added);

    // The user's index and status are exactly as before.
    assert_eq!(fs::read(f.root().join(".git/index")).unwrap(), index_before);
    assert_eq!(f.git(&["status", "--porcelain"]), status_before);
    let leftovers: Vec<_> = fs::read_dir(f.root().join(".git"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("vibevalley-index"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");

    // Limited to one path.
    let only = one(f.repo.diff(&DiffTarget::Uncommitted, Some(Path::new("新目录/未跟踪 文件.txt"))).unwrap());
    assert_eq!(&only, untracked);
    let only = one(f.repo.diff(&DiffTarget::Uncommitted, Some(Path::new("a.txt"))).unwrap());
    assert_eq!(only.change, Change::Modified);
}

#[test]
fn diff_uncommitted_before_first_commit() {
    let f = Fixture::empty();
    f.write("staged.txt", "s\n");
    f.repo.stage(&paths(&["staged.txt"])).unwrap();
    f.write("loose.txt", "l\n");
    let diffs = f.repo.diff(&DiffTarget::Uncommitted, None).unwrap();
    let mut names: Vec<_> = diffs.iter().map(|d| d.new_path.clone().unwrap()).collect();
    names.sort();
    assert_eq!(names, paths(&["loose.txt", "staged.txt"]));
    assert!(diffs.iter().all(|d| d.change == Change::Added && d.added == 1));
    assert_eq!(one(f.repo.diff(&DiffTarget::Staged, None).unwrap()).change, Change::Added);
}

#[test]
fn diff_commit_and_range() {
    let f = Fixture::new();
    let first = f.repo.head().unwrap().unwrap();

    // The root commit is diffed against nothing.
    let root = f.repo.diff(&DiffTarget::Commit(first.clone()), None).unwrap();
    assert_eq!(root.len(), 3);
    assert!(root.iter().all(|d| d.change == Change::Added));

    f.write("a.txt", numbered(30).replace("line 3\n", ""));
    f.write("b.txt", "new\n");
    f.repo.stage(&paths(&["a.txt", "b.txt"])).unwrap();
    let second = f.repo.commit("second").unwrap();

    let diffs = f.repo.diff(&DiffTarget::Commit("HEAD".into()), None).unwrap();
    assert_eq!(diffs.len(), 2);
    assert_eq!(texts(&diffs[0].hunks[0], LineKind::Removed), vec!["line 3"]);
    assert_eq!(diffs[1].change, Change::Added);

    let range = DiffTarget::Range {
        from: first.clone(),
        to: second.clone(),
    };
    assert_eq!(f.repo.diff(&range, None).unwrap(), diffs);
    let only_b = one(f.repo.diff(&range, Some(Path::new("b.txt"))).unwrap());
    assert_eq!(only_b.new_path.as_deref(), Some(Path::new("b.txt")));
    let reverse = DiffTarget::Range { from: second, to: first };
    let back = f.repo.diff(&reverse, Some(Path::new("b.txt"))).unwrap();
    assert_eq!(one(back).change, Change::Deleted);

    // A merge commit is shown against its first parent.
    f.git(&["checkout", "-q", "-b", "side", "HEAD~1"]);
    f.write("side.txt", "side\n");
    f.git(&["add", "-A"]);
    f.git(&["commit", "-q", "-m", "side"]);
    f.git(&["checkout", "-q", "main"]);
    f.git(&["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    let merge = one(f.repo.diff(&DiffTarget::Commit("HEAD".into()), None).unwrap());
    assert_eq!(merge.new_path.as_deref(), Some(Path::new("side.txt")));

    assert!(matches!(
        f.repo.diff(&DiffTarget::Commit("no-such-rev".into()), None),
        Err(GitError::Command { .. })
    ));
    assert!(f.repo.diff(&DiffTarget::Commit("--output=/tmp/x".into()), None).is_err());
}

#[test]
fn stage_unstage_discard_paths() {
    let f = Fixture::new();
    f.write(SPACED, "edited\n");
    f.write(CHINESE, "改\n");
    f.write("新目录/新 文件.txt", "new\n");
    fs::remove_file(f.root().join("a.txt")).unwrap();
    let all = paths(&[SPACED, CHINESE, "新目录/新 文件.txt", "a.txt"]);

    f.repo.stage(&all).unwrap();
    assert_eq!(
        f.states(),
        vec![
            ("a.txt".to_string(), Change::Deleted, Change::Unmodified),
            (SPACED.to_string(), Change::Modified, Change::Unmodified),
            (CHINESE.to_string(), Change::Modified, Change::Unmodified),
            ("新目录/新 文件.txt".to_string(), Change::Added, Change::Unmodified),
        ]
    );

    f.repo.unstage(&all).unwrap();
    assert_eq!(
        f.states(),
        vec![
            ("a.txt".to_string(), Change::Unmodified, Change::Deleted),
            (SPACED.to_string(), Change::Unmodified, Change::Modified),
            (CHINESE.to_string(), Change::Unmodified, Change::Modified),
            ("新目录/新 文件.txt".to_string(), Change::Unmodified, Change::Untracked),
        ]
    );

    // Discard keeps what is staged and drops the rest.
    f.repo.stage(&paths(&[CHINESE])).unwrap();
    f.write(CHINESE, "改了又改\n");
    f.repo.discard(&all).unwrap();
    assert_eq!(f.read(SPACED), "one\ntwo\nthree\n");
    assert_eq!(f.read("a.txt"), numbered(30));
    assert_eq!(f.read(CHINESE), "改\n");
    assert!(!f.exists("新目录"));
    assert_eq!(f.states(), vec![(CHINESE.to_string(), Change::Modified, Change::Unmodified)]);

    // Glob characters in names are literal.
    f.write("star*.txt", "x\n");
    f.write("starry.txt", "y\n");
    f.repo.stage(&paths(&["star*.txt"])).unwrap();
    assert_eq!(f.entry("star*.txt").unwrap().index, Change::Added);
    assert_eq!(f.entry("starry.txt").unwrap().worktree, Change::Untracked);
    f.repo.stage(&[]).unwrap();
    f.repo.unstage(&[]).unwrap();
    f.repo.discard(&[]).unwrap();
}

fn two_hunk_edit(f: &Fixture, path: &str) -> FileDiff {
    f.write(path, numbered(30));
    f.git(&["add", "-A"]);
    f.git(&["commit", "-q", "--allow-empty", "-m", "base for hunks"]);
    f.write(
        path,
        numbered(30).replace("line 3\n", "line three\n").replace("line 27\n", "line 27\nadded 27b\n"),
    );
    let file = one(f.repo.diff(&DiffTarget::Unstaged, Some(Path::new(path))).unwrap());
    assert_eq!(file.hunks.len(), 2);
    file
}

#[test]
fn hunk_stage_unstage_discard_round_trip() {
    for path in ["a.txt", SPACED, CHINESE] {
        let f = Fixture::new();
        let file = two_hunk_edit(&f, path);
        let full_patch = f.git(&["diff", "--", path]);

        // Stage only the second hunk.
        f.repo.stage_hunk(&file, &file.hunks[1]).unwrap();
        let cached = f.git(&["diff", "--cached", "--", path]);
        assert!(cached.contains("+added 27b"), "{cached}");
        assert!(!cached.contains("line three"), "{cached}");
        let unstaged = f.git(&["diff", "--", path]);
        assert!(unstaged.contains("+line three") && unstaged.contains("-line 3\n"));
        assert!(!unstaged.contains("added 27b"), "{unstaged}");
        assert_eq!(f.entry(path).unwrap().index, Change::Modified);
        assert_eq!(f.entry(path).unwrap().worktree, Change::Modified);

        // The staged content is exactly HEAD plus that hunk.
        let staged_blob = f.repo.show_file(None, Path::new(path)).unwrap();
        assert_eq!(
            String::from_utf8(staged_blob).unwrap(),
            numbered(30).replace("line 27\n", "line 27\nadded 27b\n")
        );

        // The hunk is gone from the unstaged diff, so it cannot be staged twice.
        assert!(matches!(f.repo.stage_hunk(&file, &file.hunks[1]), Err(GitError::Command { .. })));

        // Unstage it again: back to the starting diff, byte for byte.
        let staged = one(f.repo.diff(&DiffTarget::Staged, Some(Path::new(path))).unwrap());
        assert_eq!(staged.hunks.len(), 1);
        f.repo.unstage_hunk(&staged, &staged.hunks[0]).unwrap();
        assert_eq!(f.git(&["diff", "--cached", "--", path]), "");
        assert_eq!(f.git(&["diff", "--", path]), full_patch);

        // Discard the first hunk: only the second change stays on disk.
        let fresh = one(f.repo.diff(&DiffTarget::Unstaged, Some(Path::new(path))).unwrap());
        assert_eq!(fresh, file);
        f.repo.discard_hunk(&fresh, &fresh.hunks[0]).unwrap();
        assert_eq!(f.read(path), numbered(30).replace("line 27\n", "line 27\nadded 27b\n"));
        let rest = f.git(&["diff", "--", path]);
        assert!(rest.contains("+added 27b") && !rest.contains("line three"));
        assert_eq!(f.git(&["diff", "--cached"]), "");
    }
}

#[test]
fn hunks_of_new_deleted_and_renamed_files() {
    let f = Fixture::new();

    // Unstaging the only hunk of a staged new file leaves it untracked.
    f.write("新 文件.txt", "a\nb\n");
    f.repo.stage(&paths(&["新 文件.txt"])).unwrap();
    let staged = one(f.repo.diff(&DiffTarget::Staged, None).unwrap());
    assert_eq!(staged.change, Change::Added);
    f.repo.unstage_hunk(&staged, &staged.hunks[0]).unwrap();
    assert_eq!(f.entry("新 文件.txt").unwrap().worktree, Change::Untracked);
    assert_eq!(f.read("新 文件.txt"), "a\nb\n");
    fs::remove_file(f.root().join("新 文件.txt")).unwrap();

    // A deletion: stage its hunk, unstage it, then discard it (file returns).
    fs::remove_file(f.root().join(SPACED)).unwrap();
    let deleted = one(f.repo.diff(&DiffTarget::Unstaged, None).unwrap());
    assert_eq!(deleted.change, Change::Deleted);
    f.repo.stage_hunk(&deleted, &deleted.hunks[0]).unwrap();
    assert_eq!(f.entry(SPACED).unwrap().index, Change::Deleted);
    let staged = one(f.repo.diff(&DiffTarget::Staged, None).unwrap());
    f.repo.unstage_hunk(&staged, &staged.hunks[0]).unwrap();
    assert_eq!(f.entry(SPACED).unwrap().worktree, Change::Deleted);
    let deleted = one(f.repo.diff(&DiffTarget::Unstaged, None).unwrap());
    f.repo.discard_hunk(&deleted, &deleted.hunks[0]).unwrap();
    assert_eq!(f.read(SPACED), "one\ntwo\nthree\n");
    assert!(f.repo.status().unwrap().entries.is_empty());

    // A staged rename with an edit: unstaging the hunk keeps the rename.
    f.git(&["mv", "a.txt", "moved 文件.txt"]);
    f.write("moved 文件.txt", numbered(30).replace("line 15\n", "line fifteen\n"));
    f.repo.stage(&paths(&["moved 文件.txt"])).unwrap();
    let renamed = one(f.repo.diff(&DiffTarget::Staged, None).unwrap());
    assert_eq!(renamed.change, Change::Renamed);
    f.repo.unstage_hunk(&renamed, &renamed.hunks[0]).unwrap();
    let after = one(f.repo.diff(&DiffTarget::Staged, None).unwrap());
    assert_eq!(after.change, Change::Renamed);
    assert!(after.hunks.is_empty());
    assert_eq!(f.entry("moved 文件.txt").unwrap().worktree, Change::Modified);
}

#[test]
fn hunks_with_bytes_that_are_not_utf8_and_without_context() {
    let f = Fixture::new();
    // GBK-encoded text: not valid UTF-8, but not binary to git either.
    let gbk_old: &[u8] = b"head\n\xc4\xe3\xba\xc3\ntail\n";
    let gbk_new: &[u8] = b"head\n\xd4\xd9\xbc\xfb\ntail\n";
    f.write("gbk.txt", gbk_old);
    f.git(&["add", "-A"]);
    f.git(&["commit", "-q", "-m", "gbk"]);
    f.write("gbk.txt", gbk_new);

    let file = one(f.repo.diff(&DiffTarget::Unstaged, None).unwrap());
    assert!(!file.binary);
    f.repo.stage_hunk(&file, &file.hunks[0]).unwrap();
    assert_eq!(f.repo.show_file(None, Path::new("gbk.txt")).unwrap(), gbk_new);
    assert_eq!(f.repo.show_file(Some("HEAD"), Path::new("gbk.txt")).unwrap(), gbk_old);
    let staged = one(f.repo.diff(&DiffTarget::Staged, None).unwrap());
    f.repo.unstage_hunk(&staged, &staged.hunks[0]).unwrap();
    assert_eq!(f.repo.show_file(None, Path::new("gbk.txt")).unwrap(), gbk_old);
    f.repo.discard_hunk(&file, &file.hunks[0]).unwrap();
    assert_eq!(fs::read(f.root().join("gbk.txt")).unwrap(), gbk_old);

    // With diff.context=0 hunks carry no context lines.
    f.git(&["config", "diff.context", "0"]);
    f.write("a.txt", numbered(30).replace("line 8\n", "line eight\n").replace("line 20\n", ""));
    let file = one(f.repo.diff(&DiffTarget::Unstaged, None).unwrap());
    assert_eq!(file.hunks.len(), 2);
    assert!(file.hunks.iter().all(|h| h.lines.iter().all(|l| l.kind != LineKind::Context)));
    f.repo.stage_hunk(&file, &file.hunks[1]).unwrap();
    assert_eq!(
        String::from_utf8(f.repo.show_file(None, Path::new("a.txt")).unwrap()).unwrap(),
        numbered(30).replace("line 20\n", "")
    );
}

#[test]
fn commit_log_branches_checkout_show_file() {
    let f = Fixture::new();
    let first = f.repo.head().unwrap().unwrap();

    f.write("a.txt", "v2\n");
    f.repo.stage(&paths(&["a.txt"])).unwrap();
    let message = "第二次 commit: subject\n\nBody line one.\n# not a comment\nBody line three.";
    let second = f.repo.commit(message).unwrap();
    assert_eq!(second.len(), 40);
    assert_eq!(f.repo.head().unwrap().unwrap(), second);
    assert!(f.repo.status().unwrap().entries.is_empty());
    // Nothing staged: git refuses, and says why.
    assert!(matches!(f.repo.commit("empty"), Err(GitError::Command { .. })));

    let log = f.repo.log(None, 0, 10).unwrap();
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].id, second);
    assert!(second.starts_with(&log[0].short_id) && log[0].short_id.len() >= 7);
    assert_eq!(log[0].parents, vec![first.clone()]);
    assert_eq!(log[0].author_name, "Test Author");
    assert_eq!(log[0].author_email, "author@example.com");
    assert_eq!(log[0].summary, "第二次 commit: subject");
    assert_eq!(log[0].body, "Body line one.\n# not a comment\nBody line three.");
    assert!(log[0].time > 1_600_000_000);
    assert_eq!(log[1].id, first);
    assert!(log[1].parents.is_empty());
    assert_eq!(log[1].body, "");

    assert_eq!(f.repo.log(None, 1, 10).unwrap(), log[1..].to_vec());
    assert_eq!(f.repo.log(None, 0, 1).unwrap(), log[..1].to_vec());
    assert_eq!(f.repo.log(Some(&first), 0, 10).unwrap(), log[1..].to_vec());
    assert!(f.repo.log(Some("nope"), 0, 10).is_err());

    f.repo.create_branch("feature/一", None).unwrap();
    f.repo.create_branch("old", Some(&first)).unwrap();
    assert!(f.repo.create_branch("old", None).is_err());
    let branches = f.repo.branches().unwrap();
    let summary: Vec<_> = branches.iter().map(|b| (b.name.as_str(), b.is_head, b.tip.as_str())).collect();
    assert_eq!(
        summary,
        vec![
            ("feature/一", false, second.as_str()),
            ("main", true, second.as_str()),
            ("old", false, first.as_str()),
        ]
    );

    f.repo.checkout("old").unwrap();
    assert_eq!(f.repo.status().unwrap().branch.as_deref(), Some("old"));
    assert_eq!(f.read("a.txt"), numbered(30));
    assert!(f.repo.checkout("missing-branch").is_err());
    f.repo.checkout("main").unwrap();

    f.write(CHINESE, "staged 版本\n");
    f.repo.stage(&paths(&[CHINESE])).unwrap();
    f.write(CHINESE, "worktree 版本\n");
    let chinese = Path::new(CHINESE);
    assert_eq!(f.repo.show_file(None, chinese).unwrap(), "staged 版本\n".as_bytes());
    assert_eq!(f.repo.show_file(Some("HEAD"), chinese).unwrap(), "第一行\n第二行\n".as_bytes());
    assert_eq!(f.repo.show_file(Some(&first), Path::new("a.txt")).unwrap(), numbered(30).as_bytes());
    assert_eq!(f.repo.show_file(Some("HEAD"), Path::new(SPACED)).unwrap(), b"one\ntwo\nthree\n");
    assert!(f.repo.show_file(Some("HEAD"), Path::new("missing.txt")).is_err());
}

#[test]
fn worktrees_add_list_remove() {
    let f = Fixture::new();
    let head = f.repo.head().unwrap().unwrap();
    let only = f.repo.worktrees().unwrap();
    assert_eq!(only.len(), 1);
    assert_eq!(only[0].path, f.root());
    assert_eq!(only[0].branch.as_deref(), Some("main"));
    assert_eq!(only[0].head, head);
    assert!(only[0].is_main && !only[0].locked);

    let parent = tempfile::tempdir().unwrap();
    let wt_path = parent.path().join("工作树 one");
    let wt = f.repo.worktree_add(&wt_path, "task/一", None).unwrap();
    assert_eq!(wt.root(), wt_path.canonicalize().unwrap());
    assert_eq!(wt.status().unwrap().branch.as_deref(), Some("task/一"));
    assert_eq!(fs::read_to_string(wt.root().join(SPACED)).unwrap(), "one\ntwo\nthree\n");
    assert_eq!(Repo::discover(&wt_path).unwrap().unwrap(), wt);

    f.write("b.txt", "b\n");
    f.repo.stage(&paths(&["b.txt"])).unwrap();
    f.repo.commit("b").unwrap();
    let based = f.repo.worktree_add(&parent.path().join("based"), "from-first", Some(&head)).unwrap();
    assert_eq!(based.head().unwrap().unwrap(), head);
    assert!(!based.root().join("b.txt").exists());
    f.git(&["worktree", "lock", based.root().to_str().unwrap()]);

    let list = f.repo.worktrees().unwrap();
    assert_eq!(list.len(), 3);
    assert_eq!(list.iter().filter(|w| w.is_main).count(), 1);
    let found = list.iter().find(|w| w.path == wt.root()).unwrap();
    assert_eq!(found.branch.as_deref(), Some("task/一"));
    assert!(!found.is_main && !found.locked);
    assert!(list.iter().find(|w| w.path == based.root()).unwrap().locked);
    // The list is the same seen from inside a linked worktree.
    assert_eq!(wt.worktrees().unwrap(), list);

    // Snapshots and uncommitted diffs work in a linked worktree too.
    fs::write(wt.root().join("untracked.txt"), "u\n").unwrap();
    let diff = one(wt.diff(&DiffTarget::Uncommitted, None).unwrap());
    assert_eq!(diff.change, Change::Added);
    wt.snapshot("in worktree").unwrap();

    // A dirty worktree needs force.
    assert!(f.repo.worktree_remove(wt.root(), false).is_err());
    f.repo.worktree_remove(wt.root(), true).unwrap();
    assert!(!wt_path.exists());
    assert_eq!(f.repo.worktrees().unwrap().len(), 2);
    assert!(f.repo.worktree_add(&parent.path().join("dup"), "main", None).is_err());
}

fn conflicting_branches(f: &Fixture) {
    f.git(&["checkout", "-q", "-b", "theirs"]);
    f.write(SPACED, "one\nTHEIRS\nthree\n");
    f.write(CHINESE, "第一行\n他们的\n");
    f.write("only-theirs.txt", "t\n");
    f.git(&["add", "-A"]);
    f.git(&["commit", "-q", "-m", "theirs"]);
    f.git(&["checkout", "-q", "main"]);
    f.write(SPACED, "one\nOURS\nthree\n");
    f.write(CHINESE, "第一行\n我们的\n");
    f.git(&["add", "-A"]);
    f.git(&["commit", "-q", "-m", "ours"]);
}

#[test]
fn merge_check_and_merge() {
    let f = Fixture::new();
    f.repo.create_branch("same", None).unwrap();
    assert_eq!(f.repo.merge_check("same").unwrap(), MergeCheck::UpToDate);
    let head = f.repo.head().unwrap().unwrap();
    assert_eq!(f.repo.merge("same", None).unwrap(), head);
    assert!(f.repo.merge_check("no-such-branch").is_err());

    // Fast-forward.
    f.git(&["checkout", "-q", "-b", "ahead"]);
    f.write("ahead.txt", "x\n");
    f.git(&["add", "-A"]);
    f.git(&["commit", "-q", "-m", "ahead"]);
    let ahead = f.repo.head().unwrap().unwrap();
    f.git(&["checkout", "-q", "main"]);
    assert_eq!(f.repo.merge_check("ahead").unwrap(), MergeCheck::Clean);
    assert!(!f.exists("ahead.txt"));
    assert_eq!(f.repo.merge("ahead", None).unwrap(), ahead);
    assert!(f.exists("ahead.txt"));
    assert_eq!(f.repo.merge_check("ahead").unwrap(), MergeCheck::UpToDate);

    // A true merge of diverged, non-conflicting branches.
    f.git(&["checkout", "-q", "-b", "side", "HEAD~1"]);
    f.write("a.txt", numbered(30).replace("line 30\n", "line thirty\n"));
    f.git(&["add", "-A"]);
    f.git(&["commit", "-q", "-m", "side"]);
    let side = f.repo.head().unwrap().unwrap();
    f.git(&["checkout", "-q", "main"]);
    assert_eq!(f.repo.merge_check("side").unwrap(), MergeCheck::Clean);
    assert_eq!(f.read("a.txt"), numbered(30));
    let merged = f.repo.merge("side", Some("合并 side")).unwrap();
    let log = f.repo.log(None, 0, 1).unwrap();
    assert_eq!(log[0].id, merged);
    assert_eq!(log[0].parents, vec![ahead, side]);
    assert_eq!(log[0].summary, "合并 side");
    assert!(f.read("a.txt").contains("line thirty"));
    assert!(f.repo.status().unwrap().entries.is_empty());
}

#[test]
fn merge_conflicts_are_detected_without_touching_anything() {
    let f = Fixture::new();
    conflicting_branches(&f);
    f.write("scratch.txt", "untracked\n");
    let head = f.repo.head().unwrap().unwrap();
    let status_before = f.git(&["status", "--porcelain=v2", "--branch"]);
    let index_before = fs::read(f.root().join(".git/index")).unwrap();

    assert_eq!(f.repo.merge_check("theirs").unwrap(), MergeCheck::Conflicts(paths(&[SPACED, CHINESE])));
    let err = f.repo.merge("theirs", None).unwrap_err();
    assert!(
        matches!(&err, GitError::Command { command, stderr }
        if command == "merge" && stderr.contains("my file.txt")),
        "{err}"
    );

    assert_eq!(f.repo.head().unwrap().unwrap(), head);
    assert_eq!(f.git(&["status", "--porcelain=v2", "--branch"]), status_before);
    assert_eq!(fs::read(f.root().join(".git/index")).unwrap(), index_before);
    assert_eq!(f.read(SPACED), "one\nOURS\nthree\n");
    assert!(!f.root().join(".git/MERGE_HEAD").exists());
    assert!(!f.exists("only-theirs.txt"));
}

#[test]
fn conflicted_working_tree_status_and_diff() {
    let f = Fixture::new();
    conflicting_branches(&f);
    let out = Command::new("git")
        .current_dir(f.root())
        .args(["merge", "-q", "theirs"])
        .envs(ISOLATED_ENV.iter().copied())
        .output()
        .unwrap();
    assert!(!out.status.success());

    assert_eq!(
        f.states(),
        vec![
            (SPACED.to_string(), Change::Conflicted, Change::Conflicted),
            ("only-theirs.txt".to_string(), Change::Added, Change::Unmodified),
            (CHINESE.to_string(), Change::Conflicted, Change::Conflicted),
        ]
    );
    let unstaged = f.repo.diff(&DiffTarget::Unstaged, None).unwrap();
    assert_eq!(unstaged.len(), 2);
    assert!(unstaged.iter().all(|d| d.change == Change::Conflicted && d.hunks.is_empty()));
    assert_eq!(unstaged[0].new_path.as_deref(), Some(Path::new(SPACED)));
    // Against HEAD the conflict markers are an ordinary diff.
    let uncommitted = f.repo.diff(&DiffTarget::Uncommitted, Some(Path::new(SPACED))).unwrap();
    assert!(texts(&one(uncommitted).hunks[0], LineKind::Added).contains(&"THEIRS"));

    // Resolving and staging clears the conflict.
    f.write(SPACED, "one\nBOTH\nthree\n");
    f.repo.stage(&paths(&[SPACED])).unwrap();
    assert_eq!(f.entry(SPACED).unwrap().index, Change::Modified);
}

#[test]
fn snapshot_and_restore_round_trip() {
    let f = Fixture::new();
    f.write(".gitignore", "build/\n*.log\n");
    f.git(&["add", ".gitignore"]);
    f.git(&["commit", "-q", "-m", "ignore"]);

    // A mix of staged, unstaged, deleted, untracked and ignored state.
    f.write("a.txt", "staged edit\n");
    f.repo.stage(&paths(&["a.txt"])).unwrap();
    f.write("a.txt", "staged edit\nplus unstaged\n");
    fs::remove_file(f.root().join(SPACED)).unwrap();
    f.write("未跟踪/新 文件.txt", "untracked 内容\n");
    f.write("untracked.bin", [0u8, 200, 100, 0]);
    f.write("build/out.o", "ignored artefact\n");
    f.write("debug.log", "ignored log\n");

    let head = f.repo.head().unwrap().unwrap();
    let status_before = f.git(&["status", "--porcelain=v2", "--branch", "--untracked-files=all"]);
    let index_before = fs::read(f.root().join(".git/index")).unwrap();
    let staged_before = f.git(&["diff", "--cached"]);

    let id = f.repo.snapshot("before agent: 任务/1").unwrap();

    // Taking the snapshot changed nothing the user can see.
    assert_eq!(f.repo.head().unwrap().unwrap(), head);
    assert_eq!(fs::read(f.root().join(".git/index")).unwrap(), index_before);
    assert_eq!(f.git(&["status", "--porcelain=v2", "--branch", "--untracked-files=all"]), status_before);
    assert_eq!(f.read("a.txt"), "staged edit\nplus unstaged\n");

    // The snapshot commit holds tracked + untracked, not ignored, files.
    let listing = f.git(&["ls-tree", "-r", "--name-only", &id]);
    let mut files: Vec<&str> = listing.lines().collect();
    files.sort();
    assert_eq!(files, vec![".gitignore", "a.txt", "untracked.bin", CHINESE, "未跟踪/新 文件.txt"]);
    assert_eq!(f.git(&["rev-parse", &format!("{id}^")]).trim(), head);
    let snapshots = f.repo.snapshots().unwrap();
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].id, id);
    assert_eq!(snapshots[0].label, "before agent: 任务/1");
    assert!(snapshots[0].ref_name.starts_with("refs/vibevalley/snapshots/"));
    assert!(snapshots[0].time > 1_600_000_000);
    assert_eq!(f.git(&["branch", "--list"]).lines().count(), 1);

    // An agent makes a mess.
    f.write("a.txt", "clobbered\n");
    f.write(SPACED, "resurrected\n");
    f.write(CHINESE, "改坏了\n");
    fs::remove_dir_all(f.root().join("未跟踪")).unwrap();
    f.write("untracked.bin", "now text\n");
    f.write("agent/created 新.txt", "should go away\n");
    f.write("build/out.o", "rebuilt\n");
    f.write("build/new.o", "new ignored file\n");

    f.repo.restore_snapshot(&id).unwrap();

    assert_eq!(f.read("a.txt"), "staged edit\nplus unstaged\n");
    assert!(!f.exists(SPACED));
    assert_eq!(f.read(CHINESE), "第一行\n第二行\n");
    assert_eq!(f.read("未跟踪/新 文件.txt"), "untracked 内容\n");
    assert_eq!(fs::read(f.root().join("untracked.bin")).unwrap(), [0u8, 200, 100, 0]);
    assert!(!f.exists("agent"));
    // Ignored files are not part of the snapshot and are left alone.
    assert_eq!(f.read("build/out.o"), "rebuilt\n");
    assert_eq!(f.read("build/new.o"), "new ignored file\n");
    assert_eq!(f.read("debug.log"), "ignored log\n");

    // HEAD and the index are where the user left them.
    assert_eq!(f.repo.head().unwrap().unwrap(), head);
    assert_eq!(f.git(&["diff", "--cached"]), staged_before);
    assert_eq!(f.git(&["status", "--porcelain=v2", "--branch", "--untracked-files=all"]), status_before);
    // Restoring is idempotent, and the snapshot of the restored tree is the
    // same tree.
    f.repo.restore_snapshot(&id).unwrap();
    let again = f.repo.snapshot("again").unwrap();
    assert_eq!(
        f.git(&["rev-parse", &format!("{again}^{{tree}}")]),
        f.git(&["rev-parse", &format!("{id}^{{tree}}")])
    );
    assert_eq!(f.repo.snapshots().unwrap().len(), 2);

    f.repo.delete_snapshot(&id).unwrap();
    let left = f.repo.snapshots().unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].id, again);
    assert!(f.repo.restore_snapshot("not-a-commit").is_err());
}

#[test]
fn snapshot_before_first_commit() {
    let f = Fixture::empty();
    f.write("first 文件.txt", "hello\n");
    let id = f.repo.snapshot("").unwrap();
    assert_eq!(f.repo.head().unwrap(), None);
    assert_eq!(f.entry("first 文件.txt").unwrap().worktree, Change::Untracked);
    f.write("first 文件.txt", "changed\n");
    f.write("extra.txt", "x\n");
    f.repo.restore_snapshot(&id).unwrap();
    assert_eq!(f.read("first 文件.txt"), "hello\n");
    assert!(!f.exists("extra.txt"));
    assert_eq!(f.entry("first 文件.txt").unwrap().worktree, Change::Untracked);
}

#[test]
fn errors_are_reported_not_panicked() {
    let f = Fixture::new();
    let root = f.root().to_path_buf();
    let gone = Repo {
        root: root.join("does-not-exist"),
    };
    assert!(matches!(gone.status(), Err(GitError::Io(_))));

    let plain = tempfile::tempdir().unwrap();
    let not_repo = Repo {
        root: plain.path().to_path_buf(),
    };
    let err = not_repo.status().unwrap_err();
    assert!(
        matches!(&err, GitError::Command { command, stderr }
        if command == "status" && stderr.contains("not a git repository")),
        "{err}"
    );
}

#[test]
fn commit_all_takes_new_changed_and_deleted_files_but_not_ignored_ones() {
    let f = Fixture::new();
    assert_eq!(f.repo.commit_all("nothing").unwrap(), None);
    f.write(".gitignore", "*.log\n");
    f.write("new.txt", "new\n");
    f.write("a.txt", "changed\n");
    f.write("debug.log", "noise\n");
    fs::remove_file(f.root().join(CHINESE)).unwrap();
    let id = f.repo.commit_all("everything").unwrap().expect("a commit");
    assert_eq!(f.repo.head().unwrap().as_deref(), Some(id.as_str()));
    assert!(f.states().iter().all(|(path, _, _)| path == "debug.log"), "{:?}", f.states());
    assert_eq!(f.git(&["log", "-1", "--format=%s"]).trim(), "everything");
}

#[test]
fn merge_check_between_and_merge_into_a_branch_that_is_not_checked_out() {
    let f = Fixture::new();
    // parent and child branches off main; main stays checked out.
    f.git(&["branch", "parent"]);
    f.git(&["checkout", "-q", "-b", "child"]);
    f.write("child.txt", "child work\n");
    f.git(&["add", "child.txt"]);
    f.git(&["commit", "-q", "-m", "child work"]);
    f.git(&["checkout", "-q", "main"]);
    let main_before = f.repo.head().unwrap().unwrap();

    assert_eq!(f.repo.merge_check_between("parent", "child").unwrap(), MergeCheck::Clean);
    assert_eq!(f.repo.merge_check_between("child", "parent").unwrap(), MergeCheck::UpToDate);

    // Fast-forward into a branch that is not checked out.
    let tip = f.repo.merge_into("parent", "child", "Merge child").unwrap();
    assert_eq!(f.git(&["rev-parse", "parent"]).trim(), tip);
    assert_eq!(f.git(&["rev-parse", "child"]).trim(), tip);
    assert_eq!(f.repo.head().unwrap().unwrap(), main_before, "HEAD untouched");
    assert!(!f.exists("child.txt"), "working tree untouched");

    // A real merge commit when both sides moved.
    f.git(&["checkout", "-q", "-b", "other", &main_before]);
    f.write("other.txt", "other\n");
    f.git(&["add", "other.txt"]);
    f.git(&["commit", "-q", "-m", "other work"]);
    f.git(&["checkout", "-q", "main"]);
    let merged = f.repo.merge_into("parent", "other", "Merge other into parent").unwrap();
    let parents = f.git(&["rev-list", "--parents", "-n", "1", &merged]);
    assert_eq!(parents.split_whitespace().count(), 3, "a merge commit with two parents");
    assert_eq!(f.git(&["log", "-1", "--format=%s", "parent"]).trim(), "Merge other into parent");
    assert!(f.git(&["ls-tree", "-r", "--name-only", "parent"]).contains("child.txt"));
    assert!(f.git(&["ls-tree", "-r", "--name-only", "parent"]).contains("other.txt"));

    // Conflicts are refused and the branch does not move.
    f.git(&["checkout", "-q", "-b", "c1", &main_before]);
    f.write("a.txt", "one side\n");
    f.git(&["commit", "-q", "-am", "c1"]);
    f.git(&["checkout", "-q", "-b", "c2", &main_before]);
    f.write("a.txt", "other side\n");
    f.git(&["commit", "-q", "-am", "c2"]);
    f.git(&["checkout", "-q", "main"]);
    let c1 = f.git(&["rev-parse", "c1"]);
    assert!(matches!(f.repo.merge_check_between("c1", "c2").unwrap(), MergeCheck::Conflicts(p) if p == vec![PathBuf::from("a.txt")]));
    assert!(f.repo.merge_into("c1", "c2", "x").is_err());
    assert_eq!(f.git(&["rev-parse", "c1"]), c1);

    // A branch checked out somewhere is merged there, not behind its back.
    let err = f.repo.merge_into("main", "c1", "x").unwrap_err();
    assert!(err.to_string().contains("checked out"), "{err}");
}

#[test]
fn init_clone_log_all_and_raw_commands() {
    let dir = tempfile::tempdir().unwrap();
    let origin = crate::init(&dir.path().join("origin"), Some("trunk")).unwrap();
    std::fs::write(origin.root().join("a.txt"), "a\n").unwrap();
    origin.commit_all("first").unwrap();
    git_in(origin.root(), &["branch", "side"]);
    git_in(origin.root(), &["switch", "-q", "side"]);
    std::fs::write(origin.root().join("b.txt"), "b\n").unwrap();
    origin.commit_all("on side").unwrap();
    git_in(origin.root(), &["switch", "-q", "trunk"]);

    assert_eq!(origin.log(None, 0, 10).unwrap().len(), 1);
    let all: Vec<String> = origin.log_all(0, 10).unwrap().into_iter().map(|c| c.summary).collect();
    assert_eq!(all, ["on side", "first"]);

    let raw = origin.run(&["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
    assert!(raw.ok());
    assert_eq!(raw.text(), "trunk");
    assert!(!origin.run(&["rev-parse", "--verify", "nope"]).unwrap().ok());

    let copy = crate::clone(origin.root().to_str().unwrap(), &dir.path().join("nested/copy")).unwrap();
    assert!(copy.root().join("a.txt").exists());
    assert!(crate::clone("--upload-pack=evil", &dir.path().join("x")).is_err());

    let empty = crate::init(&dir.path().join("empty"), None).unwrap();
    assert!(empty.log_all(0, 10).unwrap().is_empty());
}

#[test]
fn regression_verified_merge_rechecks_a_new_target_and_publishes_the_exact_commit() {
    let f = Fixture::new();
    f.git(&["switch", "-qc", "issue"]);
    f.write("jobs", "2");
    f.git(&["add", "jobs"]);
    f.git(&["commit", "-qm", "increase jobs"]);
    f.git(&["switch", "-q", "main"]);
    let hook = f.root().join(".git/hooks/post-receive");
    fs::write(&hook, "#!/bin/sh\ntouch deploy-fired\n").unwrap();
    fs::set_permissions(&hook, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let mut checked = Vec::new();
    let result = f
        .repo
        .merge_verified(
            "main",
            "issue",
            "deliver",
            |work| {
                checked.push(git_in(work, &["rev-parse", "HEAD"]).trim().to_owned());
                if checked.len() == 1 {
                    f.write("capacity", "3");
                    f.git(&["add", "capacity"]);
                    f.git(&["commit", "-qm", "set capacity"]);
                } else {
                    assert_eq!(fs::read_to_string(work.join("capacity")).unwrap(), "3");
                }
                fs::write(work.join("scratch"), "check output").unwrap();
                Ok(true)
            },
            |_, _| Ok::<_, GitError>(()),
        )
        .unwrap();
    let head = f.repo.head().unwrap().unwrap();
    assert_eq!(checked.len(), 2);
    assert_eq!(checked[1], head);
    assert_eq!(result, VerifiedMerge::Merged(head));
    assert_eq!(f.read("jobs"), "2");
    assert_eq!(f.read("capacity"), "3");
    assert!(!f.exists("scratch"));
    assert!(!f.root().join(".git/deploy-fired").exists());
    assert!(!f.exists("deploy-fired"));
    assert_eq!(f.repo.worktrees().unwrap().len(), 1);
}

#[test]
fn regression_verified_merge_leaves_user_edits_intact() {
    let f = Fixture::new();
    let base = f.repo.head().unwrap();
    f.git(&["switch", "-qc", "issue"]);
    f.write("a.txt", "agent");
    f.git(&["commit", "-qam", "agent"]);
    f.git(&["switch", "-q", "main"]);
    f.write("a.txt", "user edit");
    assert!(
        f.repo
            .merge_verified("main", "issue", "deliver", |_| Ok(true), |_, _| Ok::<_, GitError>(()))
            .is_err()
    );
    assert_eq!(f.repo.head().unwrap(), base);
    assert_eq!(f.read("a.txt"), "user edit");
    assert_eq!(f.repo.worktrees().unwrap().len(), 1);
}

#[test]
fn regression_verified_merge_preserves_an_ignored_file_that_would_be_overwritten() {
    let f = Fixture::new();
    f.write(".gitignore", "settings.local\n");
    f.git(&["add", ".gitignore"]);
    f.git(&["commit", "-qm", "ignore local settings"]);
    let base = f.repo.head().unwrap();
    f.git(&["switch", "-qc", "issue"]);
    f.write("settings.local", "from the issue");
    f.git(&["add", "-f", "settings.local"]);
    f.git(&["commit", "-qm", "track settings"]);
    f.git(&["switch", "-q", "main"]);
    f.write("settings.local", "user settings");
    let err = f
        .repo
        .merge_verified("main", "issue", "deliver", |_| Ok(true), |_, _| Ok::<_, GitError>(()))
        .unwrap_err();
    assert!(err.to_string().contains("settings.local"), "{err}");
    assert_eq!(f.repo.head().unwrap(), base);
    assert_eq!(f.read("settings.local"), "user settings");
}

#[test]
fn regression_a_project_check_that_rewrites_a_tracked_file_cannot_publish() {
    let f = Fixture::new();
    let base = f.repo.head().unwrap();
    f.git(&["switch", "-qc", "issue"]);
    f.write("work", "original");
    f.git(&["add", "work"]);
    f.git(&["commit", "-qm", "work"]);
    f.git(&["switch", "-q", "main"]);
    let result = f
        .repo
        .merge_verified(
            "main",
            "issue",
            "deliver",
            |dir| {
                fs::write(dir.join("work"), "auto-fixed").unwrap();
                Ok(true)
            },
            |_, receipt| {
                assert!(receipt.is_err());
                Ok::<_, GitError>(())
            },
        )
        .unwrap();
    assert!(matches!(result, VerifiedMerge::CheckFailed(_)));
    assert_eq!(f.repo.head().unwrap(), base);
}

#[test]
fn stash_push_captures_tracked_and_untracked_changes_and_skips_clean_trees() {
    let f = Fixture::new();
    assert!(!f.repo.has_uncommitted().unwrap());
    assert_eq!(f.repo.stash_push("nothing").unwrap(), None);

    f.write("a.txt", "modified content\n");
    f.write("untracked_handoff.txt", "draft work\n");
    assert!(f.repo.has_uncommitted().unwrap());

    let stash = f.repo.stash_push("handoff stash").unwrap();
    assert!(stash.is_some());
    assert!(!f.repo.has_uncommitted().unwrap());
    assert!(!f.root().join("untracked_handoff.txt").exists());
}
