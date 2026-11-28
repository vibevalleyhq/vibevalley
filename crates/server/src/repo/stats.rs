use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tracing::Instrument;
use tracing::instrument::WithSubscriber;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, Author, DayCount, Issue, IssueTemplate, JsNumber, LanguageCount, RepoActivity, RepoLanguages, RepoStack, RepoTemplates, TemplateBlank,
    TemplateKind,
};

use super::local::{REPO_CONCURRENCY, Repo, git_quiet, is_dir_or_dir_symlink_async, refused, repo_ref, seconds_of};
use crate::context::error::{LookIn, missing};
use crate::context::now;

const YEAR_DAYS: i64 = 53 * 7;

/// Folders `repo_dirs` skips.
const SKIP_DIRS: [&str; 8] = ["node_modules", ".git", ".venv", "vendor", "dist", "build", "target", ".next"];

const STACK_FILES: [&str; 11] = [
    "go.mod",
    "Cargo.toml",
    "pubspec.yaml",
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "bun.lock",
    "bun.lockb",
    "pnpm-lock.yaml",
    "yarn.lock",
];

fn local_day(ms: i64) -> String {
    jiff::Timestamp::from_millisecond(ms)
        .map(|ts| ts.to_zoned_datetime(jiff::tz::TimeZone::system()).strftime("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// Case-insensitive comparison with byte-order tiebreaker.
fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b))
}

/// Commits per day and per author from `%at\t%aN` lines.
pub fn activity_of(log: &str, day_of: impl Fn(i64) -> String) -> (Vec<DayCount>, Vec<Author>) {
    let mut by_day: HashMap<String, i64> = HashMap::new();
    let mut by_author: HashMap<String, i64> = HashMap::new();
    for line in log.lines() {
        let Some((at, name)) = line.split_once('\t') else { continue };
        let Ok(seconds) = at.trim().parse::<f64>() else { continue };
        if !seconds.is_finite() || seconds <= 0.0 {
            continue;
        }
        *by_day.entry(day_of((seconds * 1000.0) as i64)).or_default() += 1;
        let name = if name.trim().is_empty() {
            t("server.repo.noName", &[])
        } else {
            name.trim().to_string()
        };
        *by_author.entry(name).or_default() += 1;
    }
    let mut days: Vec<DayCount> = by_day.into_iter().map(|(day, commits)| DayCount { day, commits }).collect();
    days.sort_by(|a, b| a.day.cmp(&b.day));
    let mut authors: Vec<Author> = by_author.into_iter().map(|(name, commits)| Author { name, commits }).collect();
    authors.sort_by(|a, b| b.commits.cmp(&a.commits).then_with(|| locale_compare(&a.name, &b.name)));
    (days, authors)
}

impl Repo {
    pub async fn languages_async(&self, name: &str) -> Result<Option<RepoLanguages>, ApiError> {
        let Some(p) = self.find_async(name).await else { return Ok(None) };
        let path = p.path;
        let stats = crate::log::spawn_blocking_traced(move || vibevalley_files::count_loc(&path))
            .await
            .map_err(|e| refused(e.to_string()))?
            .map_err(|e| refused(e.to_string()))?;
        let languages = stats
            .into_iter()
            .map(|s| LanguageCount {
                name: s.name.to_string(),
                files: i64::try_from(s.files).unwrap_or(i64::MAX),
                code: i64::try_from(s.code).unwrap_or(i64::MAX),
                comments: i64::try_from(s.comments).unwrap_or(i64::MAX),
                blanks: i64::try_from(s.blanks).unwrap_or(i64::MAX),
            })
            .collect();
        Ok(Some(RepoLanguages {
            repo: name.into(),
            at: now(),
            languages,
        }))
    }

    pub async fn activity_async(&self, name: &str) -> Option<RepoActivity> {
        let p = self.find_async(name).await?;
        let name = name.to_string();
        crate::log::spawn_blocking_traced(move || {
            let at = now();
            let mut out = RepoActivity {
                repo: name,
                at,
                ..Default::default()
            };
            if !p.git {
                return out;
            }
            let since = jiff::Timestamp::from_millisecond(at - YEAR_DAYS * 86_400_000)
                .map(|t| t.to_string())
                .unwrap_or_default();
            let log = git_quiet(&p.path, &["log", "--all", "--no-merges", &format!("--since={since}"), "--format=%at%x09%aN"]);
            let total = git_quiet(&p.path, &["rev-list", "--all", "--no-merges", "--count"]);
            let roots = git_quiet(&p.path, &["log", "--all", "--max-parents=0", "--format=%at"]);
            let last = seconds_of(&git_quiet(&p.path, &["log", "--all", "-1", "--format=%at"]));
            let (days, authors) = activity_of(&log, local_day);
            out.days = days;
            out.authors = authors;
            out.total = total.trim().parse().unwrap_or(0);
            out.first = roots.lines().map(seconds_of).filter(|x| *x > 0).min();
            out.last = (last > 0).then_some(last);
            out
        })
        .await
        .ok()
    }

    /// The user's commits per repository under the root and mounted external repositories.
    pub async fn contributions_async(&self, extra: Vec<String>) -> Vec<vibevalley_protocol::Repo> {
        let mut dirs = repo_dirs_async(self.root(), 3).await;
        for folder in self.list_async().await {
            if folder.git {
                dirs.push(folder.path);
            }
        }
        contributions_for_dirs_async(dirs, extra).await
    }

    pub async fn languages_endpoint_async(&self, id: &str) -> Result<RepoLanguages, ApiError> {
        self.languages_async(id).await?.ok_or_else(|| repo_ref(id))
    }

    pub async fn activity_endpoint_async(&self, id: &str) -> Result<RepoActivity, ApiError> {
        self.activity_async(id).await.ok_or_else(|| repo_ref(id))
    }

    /// `repo.template.list`: detected stack, recent issue titles, and filled template catalog.
    pub async fn templates_async(&self, id: &str, issues: &[Issue], is_orchestrator: impl Fn(&str) -> bool) -> Result<RepoTemplates, ApiError> {
        let name = id.to_string();
        let stack = self
            .stack_async(&name)
            .await
            .ok_or_else(|| missing(t("server.issue.repoRef", &[("name", name.clone().into())]), LookIn::Repo))?;
        let mut mine: Vec<Issue> = issues
            .iter()
            .filter(|i| {
                i.repo.as_deref() == Some(name.as_str())
                    && i.was_sent()
                    && i.parent.is_none()
                    && i.cron.is_none()
                    && !i.assigned_agent().is_some_and(&is_orchestrator)
            })
            .cloned()
            .collect();
        mine.sort_by_key(|i| std::cmp::Reverse(i.created_at));
        let mut recent: Vec<String> = Vec::new();
        for i in mine {
            let title = i.title.split_whitespace().collect::<Vec<_>>().join(" ");
            if title.is_empty() || title.chars().count() > 60 || recent.contains(&title) {
                continue;
            }
            recent.push(title);
            if recent.len() == 5 {
                break;
            }
        }
        let kinds = catalog()
            .kinds
            .iter()
            .map(|k| TemplateKind {
                id: k.id.clone(),
                name: k.name.clone(),
                icon: k.icon.clone(),
                templates: k.templates.iter().map(|s| filled_template(s, &stack)).collect(),
            })
            .collect();
        Ok(RepoTemplates {
            repo: name,
            stack,
            recent,
            kinds,
        })
    }

    /// Detects the project stack for `name`, returning `None` when no such repo exists.
    pub async fn stack_async(&self, name: &str) -> Option<RepoStack> {
        let p = self.find_async(name).await?;
        let mut owned: Vec<(&'static str, String)> = Vec::new();
        for f in STACK_FILES {
            if let Ok(body) = tokio::fs::read_to_string(p.path.join(f)).await {
                owned.push((f, body));
            }
        }
        let files: HashMap<&str, String> = owned.into_iter().collect();
        Some(stack_of(&files))
    }
}

/// Finds git repositories under `dir` up to `depth` folders deep without descending into a repo.
async fn repo_dirs_async(root: &Path, max_depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut visited = HashSet::new();
    let mut stack = vec![(root.to_path_buf(), max_depth)];
    while let Some((dir, depth)) = stack.pop() {
        let canon = tokio::fs::canonicalize(&dir).await.unwrap_or_else(|_| dir.clone());
        if !visited.insert(canon) {
            continue;
        }
        let Ok(mut rd) = tokio::fs::read_dir(&dir).await else { continue };
        let mut entries = Vec::new();
        while let Ok(Some(e)) = rd.next_entry().await {
            entries.push(e);
        }
        if entries.iter().any(|e| e.file_name() == ".git") {
            out.push(dir);
            continue;
        }
        if depth == 0 {
            continue;
        }
        for e in entries {
            let name = e.file_name();
            if is_dir_or_dir_symlink_async(&e).await && !SKIP_DIRS.iter().any(|s| name == *s) {
                stack.push((e.path(), depth - 1));
            }
        }
    }
    out.sort();
    out
}

fn global_email() -> String {
    vibevalley_git::read::global_config_value("user", "email")
        .ok()
        .flatten()
        .map(|e| e.trim().to_lowercase())
        .unwrap_or_default()
}

/// Counts the user's commits in each repository under `root`
/// (matching global `user.email`, repo `user.email`, and `extra`).
pub async fn contributions_of_async(root: PathBuf, extra: Vec<String>) -> Vec<vibevalley_protocol::Repo> {
    let dirs = repo_dirs_async(&root, 3).await;
    contributions_for_dirs_async(dirs, extra).await
}

async fn contributions_for_dirs_async(dirs: Vec<PathBuf>, extra: Vec<String>) -> Vec<vibevalley_protocol::Repo> {
    if dirs.is_empty() {
        return vec![];
    }
    let global = global_email();
    let extra_lower: Arc<Vec<String>> = Arc::new(extra.into_iter().map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()).collect());

    let sem = Arc::new(Semaphore::new(REPO_CONCURRENCY));
    let mut set = JoinSet::new();
    for (idx, dir) in dirs.into_iter().enumerate() {
        let sem = sem.clone();
        set.spawn(
            async move {
                let Ok(_permit) = sem.acquire_owned().await else { return None };
                crate::log::spawn_blocking_traced(move || {
                    let common = vibevalley_git::read::git_common_dir(&dir).ok()?;
                    Some((idx, dir, common))
                })
                .await
                .ok()
                .flatten()
            }
            .in_current_span()
            .with_current_subscriber(),
        );
    }
    let mut commons = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(Some(item)) = joined {
            commons.push(item);
        }
    }
    commons.sort_by_key(|(idx, _, _)| *idx);

    // Worktrees share their repository's history: one count per repository.
    let mut seen = HashSet::new();
    let unique: Vec<(usize, PathBuf)> = commons
        .into_iter()
        .filter_map(|(idx, dir, common)| seen.insert(common).then_some((idx, dir)))
        .collect();

    let sem = Arc::new(Semaphore::new(REPO_CONCURRENCY));
    let mut set = JoinSet::new();
    for (idx, dir) in unique {
        let sem = sem.clone();
        let global = global.clone();
        let extra_lower = extra_lower.clone();
        set.spawn(
            async move {
                let Ok(_permit) = sem.acquire_owned().await else { return None };
                crate::log::spawn_blocking_traced(move || {
                    let own = git_quiet(&dir, &["config", "user.email"]).to_lowercase();
                    let mine: HashSet<String> = [global, own].into_iter().chain(extra_lower.iter().cloned()).filter(|e| !e.is_empty()).collect();
                    let emails = git_quiet(&dir, &["log", "--all", "--format=%ae"]);
                    let commits = emails.lines().filter(|e| !e.is_empty() && mine.contains(&e.to_lowercase())).count() as i64;
                    let top = vibevalley_git::read::discover_root(&dir).ok().flatten();
                    (
                        idx,
                        vibevalley_protocol::Repo {
                            path: top.unwrap_or(dir).display().to_string(),
                            commits,
                        },
                    )
                })
                .await
                .ok()
            }
            .in_current_span()
            .with_current_subscriber(),
        );
    }
    let mut out = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(Some(item)) = joined {
            out.push(item);
        }
    }
    out.sort_by_key(|(idx, _)| *idx);
    out.into_iter().map(|(_, repo)| repo).collect()
}

fn stack(name: &str, label: String, test: &str, lint: &str, build: &str) -> RepoStack {
    let some = |s: &str| Some(s.to_string()).filter(|s| !s.is_empty());
    RepoStack {
        name: name.into(),
        label,
        test: some(test),
        lint: some(lint),
        build: some(build),
    }
}

/// Detects stack commands from root marker files (first match wins).
pub fn stack_of(files: &HashMap<&str, String>) -> RepoStack {
    let has = |n: &str| files.contains_key(n);
    if has("go.mod") {
        return stack("go", "Go".into(), "go test ./...", "go vet ./...", "go build ./...");
    }
    if has("Cargo.toml") {
        return stack("rust", "Rust".into(), "cargo test", "cargo clippy", "cargo build");
    }
    if let Some(pubspec) = files.get("pubspec.yaml") {
        return if pubspec.contains("flutter") {
            stack("flutter", "Flutter".into(), "flutter test", "flutter analyze", "")
        } else {
            stack("dart", "Dart".into(), "dart test", "dart analyze", "")
        };
    }
    if let Some(pkg) = files.get("package.json") {
        let pm = if has("bun.lock") || has("bun.lockb") {
            "bun"
        } else if has("pnpm-lock.yaml") {
            "pnpm"
        } else if has("yarn.lock") {
            "yarn"
        } else {
            "npm"
        };
        let scripts: HashMap<String, String> = serde_json::from_str::<serde_json::Value>(pkg)
            .ok()
            .and_then(|v| serde_json::from_value(v["scripts"].clone()).ok())
            .unwrap_or_default();
        let run = |s: &str| {
            if scripts.get(s).is_some_and(|v| !v.trim().is_empty()) {
                format!("{pm} run {s}")
            } else {
                String::new()
            }
        };
        let label = t("shared.join.aside", &[("text", "Node".into()), ("aside", pm.into())]);
        return stack("node", label, &run("test"), &run("lint"), &run("build"));
    }
    let pyproject = files.get("pyproject.toml");
    if pyproject.is_some() || has("requirements.txt") || has("setup.py") {
        let lint = if pyproject.is_some_and(|p| p.contains("ruff")) { "ruff check ." } else { "" };
        return stack("python", "Python".into(), "pytest", lint, "");
    }
    RepoStack {
        name: String::new(),
        label: String::new(),
        test: None,
        lint: None,
        build: None,
    }
}

#[derive(serde::Deserialize)]
struct WrittenTemplate {
    id: String,
    title: String,
    done: String,
}

#[derive(serde::Deserialize)]
struct WrittenKind {
    id: String,
    name: String,
    icon: String,
    templates: Vec<WrittenTemplate>,
}

#[derive(serde::Deserialize)]
struct Catalog {
    kinds: Vec<WrittenKind>,
}

fn catalog() -> Catalog {
    let body = if vibevalley_i18n::locale().starts_with("en") {
        include_str!("../../assets/agent/template_catalog.en.json")
    } else {
        include_str!("../../assets/agent/template_catalog.json")
    };
    serde_json::from_str(body).expect("template_catalog.json")
}

/// Fills `{test}`, `{lint}`, and `{build}` placeholders with the stack's commands or localized labels.
fn filled_template(s: &WrittenTemplate, stack: &RepoStack) -> IssueTemplate {
    static HOLES: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let holes = HOLES.get_or_init(|| regex::Regex::new(r"\s?\{(test|lint|build)\}\s?").expect("regex"));
    let done = holes
        .replace_all(&s.done, |c: &regex::Captures| {
            let hole = &c[0];
            let name = &c[1];
            let command = match name {
                "test" => stack.test.as_deref(),
                "lint" => stack.lint.as_deref(),
                _ => stack.build.as_deref(),
            };
            match command {
                Some(cmd) => hole.replace(&format!("{{{name}}}"), &format!("`{cmd}`")),
                None => vibevalley_i18n::maybe(&format!("server.issue.template.commands.{name}")).unwrap_or_else(|| hole.to_string()),
            }
        })
        .into_owned();
    let text = t(
        "server.issue.template.done",
        &[("title", s.title.clone().into()), ("done", done.clone().into())],
    );
    let blank = text.find('〔').and_then(|start| {
        let end = start + text[start..].find('〕')? + '〕'.len_utf8();
        let units = |b: usize| text[..b].encode_utf16().count() as f64;
        Some(TemplateBlank {
            start: JsNumber::from(units(start)),
            end: JsNumber::from(units(end)),
        })
    });
    IssueTemplate {
        id: s.id.clone(),
        title: s.title.clone(),
        done,
        text,
        blank,
    }
}

#[cfg(test)]
mod tests {
    use vibevalley_protocol::NewRepo;

    use super::*;

    #[test]
    fn activity_counts() {
        let (days, authors) = activity_of("100\tAnn\n200\tbob\n86500\tAnn\nbad\n", |ms| (ms / 86_400_000).to_string());
        assert_eq!(days.iter().map(|d| (d.day.as_str(), d.commits)).collect::<Vec<_>>(), vec![("0", 2), ("1", 1)]);
        assert_eq!(authors[0].name, "Ann");
    }

    #[tokio::test]
    async fn regression_pyproject_toml_detects_python_stack_and_ruff() {
        let mut with_ruff = HashMap::new();
        with_ruff.insert("pyproject.toml", "[tool.ruff]\nline-length = 100\n".to_string());
        let py = stack_of(&with_ruff);
        assert_eq!(py.name, "python");
        assert_eq!(py.test.as_deref(), Some("pytest"));
        assert_eq!(py.lint.as_deref(), Some("ruff check ."));

        let mut no_ruff = HashMap::new();
        no_ruff.insert("pyproject.toml", "[project]\nname = \"demo\"\n".to_string());
        let plain = stack_of(&no_ruff);
        assert_eq!(plain.name, "python");
        assert_eq!(plain.test.as_deref(), Some("pytest"));
        assert_eq!(plain.lint, None);

        let mut typo = HashMap::new();
        typo.insert("pyrepo.toml", "[tool.ruff]\n".to_string());
        assert_eq!(stack_of(&typo).name, "");

        let work = tempfile::tempdir().unwrap();
        let repo_dir = work.path().join("repos/pyapp");
        std::fs::create_dir_all(&repo_dir).unwrap();
        let init = std::process::Command::new("git").args(["init", "-q"]).current_dir(&repo_dir).status().unwrap();
        assert!(init.success());
        std::fs::write(repo_dir.join("pyproject.toml"), "[tool.ruff]\n").unwrap();
        let repo = Repo::open_async(work.path(), 3).await.unwrap();
        let detected = repo.stack_async("pyapp").await.unwrap();
        assert_eq!(detected.name, "python");
        assert_eq!(detected.lint.as_deref(), Some("ruff check ."));
        repo.close_async().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn async_repo_handlers_and_contributions_run_on_repo() {
        let work = tempfile::tempdir().unwrap();
        let repo = Repo::open_async(work.path(), 3).await.unwrap();

        let created = repo
            .create_repo_async(&NewRepo {
                name: "alpha".into(),
                github: None,
            })
            .await
            .unwrap();
        assert_eq!(created.name, "alpha");
        assert!(created.git);

        let _beta = repo
            .create_repo_async(&NewRepo {
                name: "beta".into(),
                github: None,
            })
            .await
            .unwrap();

        let listed = repo.list_summaries_async().await;
        assert_eq!(listed.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["alpha", "beta"]);

        let activity = repo.activity_endpoint_async("alpha").await.unwrap();
        assert_eq!(activity.repo, "alpha");
        assert!(activity.total >= 1);

        let langs = repo.languages_endpoint_async("alpha").await.unwrap();
        assert_eq!(langs.repo, "alpha");
        assert_eq!(langs.languages.len(), 1);
        assert_eq!(langs.languages[0].name, "Markdown");

        let contribs = repo.contributions_async(vec!["vibevalley@localhost".into()]).await;
        assert_eq!(contribs.len(), 2);

        repo.close_async().await;
    }
}
