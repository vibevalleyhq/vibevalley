package repo_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/vibevalleyhq/vibevalley/internal/domain/repo"
)

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestScanLanguagesTrackedAndFallbackWalk(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	dir := t.TempDir()
	gitExec(t, dir, "init", "-b", "main")

	writeTestFile(t, filepath.Join(dir, "main.go"), "package main\n\n// entry point\n/* multi\n   comment */\nfunc main() {}\n")
	writeTestFile(t, filepath.Join(dir, "web/app.ts"), "// ts comment\nexport const x = 1;\n\nexport const y = 2;\n")
	writeTestFile(t, filepath.Join(dir, "db/schema.sql"), "-- schema\nCREATE TABLE t (id INT);\n")
	writeTestFile(t, filepath.Join(dir, "README.md"), "# Title\n\nSome prose\n")
	writeTestFile(t, filepath.Join(dir, "config.json"), "{\n  \"ok\": true\n}\n")
	writeTestFile(t, filepath.Join(dir, "ci.yaml"), "# workflow\nname: ci\n")
	writeTestFile(t, filepath.Join(dir, "styles.css"), "/* reset */\nbody { margin: 0; }\n")
	writeTestFile(t, filepath.Join(dir, "index.html"), "<!-- head -->\n<html></html>\n")
	writeTestFile(t, filepath.Join(dir, "scripts/build.sh"), "#!/bin/sh\n# build\necho ok\n")
	writeTestFile(t, filepath.Join(dir, "ml/train.py"), "# train\nprint('ok')\n")
	writeTestFile(t, filepath.Join(dir, "core/lib.rs"), "// rust\npub fn hi() {}\n")

	// Ignored directories + untracked files must not pollute tracked scan.
	writeTestFile(t, filepath.Join(dir, "node_modules/pkg/index.js"), "console.log('ignored');\n")
	writeTestFile(t, filepath.Join(dir, "dist/bundle.js"), "console.log('ignored');\n")
	writeTestFile(t, filepath.Join(dir, "vendor/dep.go"), "package dep\n")
	writeTestFile(t, filepath.Join(dir, "untracked.py"), "print('untracked')\n")

	gitExec(t, dir, "add", "main.go", "web/app.ts", "db/schema.sql", "README.md", "config.json", "ci.yaml", "styles.css", "index.html", "scripts/build.sh", "ml/train.py", "core/lib.rs")

	scan, err := repo.ScanLanguages(ctx, dir)
	if err != nil {
		t.Fatalf("ScanLanguages: %v", err)
	}
	if scan.TotalFiles != 11 {
		t.Fatalf("expected 11 tracked files, got %d (langs=%+v)", scan.TotalFiles, scan.Languages)
	}

	byName := make(map[string]repo.LanguageStat, len(scan.Languages))
	for _, l := range scan.Languages {
		byName[l.Name] = l
		if l.Color == "" || !strings.HasPrefix(l.Color, "#") {
			t.Fatalf("language %q missing color hex: %+v", l.Name, l)
		}
	}

	goStat := byName["Go"]
	if goStat.Files != 1 || goStat.Code != 2 || goStat.Comments != 3 || goStat.Blanks != 1 || goStat.Color != "#00add8" {
		t.Fatalf("unexpected Go stat: %+v", goStat)
	}
	tsStat := byName["TypeScript"]
	if tsStat.Files != 1 || tsStat.Code != 2 || tsStat.Comments != 1 || tsStat.Blanks != 1 || tsStat.Color != "#3178c6" {
		t.Fatalf("unexpected TypeScript stat: %+v", tsStat)
	}
	for _, want := range []string{"Go", "TypeScript", "SQL", "Markdown", "JSON", "YAML", "CSS", "HTML", "Shell", "Python", "Rust"} {
		if _, ok := byName[want]; !ok {
			t.Fatalf("missing language %q in scan: %+v", want, scan.Languages)
		}
	}

	// Fallback directory walk when directory is not a git repo (still skips node_modules, dist, vendor, .git).
	plainDir := t.TempDir()
	writeTestFile(t, filepath.Join(plainDir, "app.py"), "# py\nx = 1\n")
	writeTestFile(t, filepath.Join(plainDir, "node_modules/x.js"), "var a = 1;\n")
	writeTestFile(t, filepath.Join(plainDir, "dist/x.js"), "var b = 1;\n")
	writeTestFile(t, filepath.Join(plainDir, "vendor/x.go"), "package x\n")
	plainScan, err := repo.ScanLanguages(ctx, plainDir)
	if err != nil {
		t.Fatalf("ScanLanguages fallback: %v", err)
	}
	if plainScan.TotalFiles != 1 || len(plainScan.Languages) != 1 || plainScan.Languages[0].Name != "Python" {
		t.Fatalf("unexpected fallback scan: %+v", plainScan)
	}
}

func TestScanActivityCommitsAuthorsBranchAndDirtyCount(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	dir := t.TempDir()
	gitExec(t, dir, "init", "-b", "main")

	writeTestFile(t, filepath.Join(dir, "a.go"), "package a\n")
	gitExec(t, dir, "add", "a.go")
	gitExec(t, dir, "-c", "user.name=Alice", "-c", "user.email=alice@local", "commit", "-m", "first")

	writeTestFile(t, filepath.Join(dir, "b.go"), "package a\n")
	gitExec(t, dir, "add", "b.go")
	gitExec(t, dir, "-c", "user.name=Alice", "-c", "user.email=alice@local", "commit", "-m", "second")

	writeTestFile(t, filepath.Join(dir, "c.go"), "package a\n")
	gitExec(t, dir, "add", "c.go")
	gitExec(t, dir, "-c", "user.name=Bob", "-c", "user.email=bob@local", "commit", "-m", "third")

	// Dirty tracked + untracked files.
	writeTestFile(t, filepath.Join(dir, "a.go"), "package a\n// modified\n")
	writeTestFile(t, filepath.Join(dir, "untracked.txt"), "dirty\n")

	act, err := repo.ScanActivity(ctx, dir, 30)
	if err != nil {
		t.Fatalf("ScanActivity: %v", err)
	}
	if act.Branch != "main" || act.HeadCommit == "" || act.TotalCommits != 3 || act.DirtyCount != 2 {
		t.Fatalf("unexpected activity summary: %+v", act)
	}
	if len(act.Days) != 1 || act.Days[0].Commits != 3 {
		t.Fatalf("unexpected daily aggregation: %+v", act.Days)
	}
	if len(act.Authors) != 2 || act.Authors[0].Name != "Alice" || act.Authors[0].Commits != 2 || act.Authors[1].Name != "Bob" {
		t.Fatalf("unexpected authors aggregation: %+v", act.Authors)
	}
}

func installFakeGH(t *testing.T, scriptBody string) string {
	t.Helper()
	binDir := t.TempDir()
	ghPath := filepath.Join(binDir, "gh")
	if err := os.WriteFile(ghPath, []byte("#!/bin/sh\n"+scriptBody), 0o755); err != nil {
		t.Fatalf("write fake gh: %v", err)
	}
	return binDir
}

func TestProbeGitHubCLIMissingUnauthenticatedAndLoggedIn(t *testing.T) {
	ctx := context.Background()

	// 1. Missing gh executable in PATH -> graceful un-installed report.
	t.Setenv("PATH", t.TempDir())
	missing := repo.ProbeGitHubCLI(ctx, "")
	if missing.Installed || missing.LoggedIn || missing.Reason == "" {
		t.Fatalf("expected missing gh status, got %+v", missing)
	}

	// 2. Installed but unauthenticated (gh auth status exits 1 writing to stderr).
	unauthBin := installFakeGH(t, `
if [ "$1" = "--version" ]; then
  echo "gh version 2.65.0 (2026-01-01)"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo "You are not logged into any GitHub hosts." >&2
  exit 1
fi
exit 1
`)
	t.Setenv("PATH", unauthBin)
	unauth := repo.ProbeGitHubCLI(ctx, "")
	if !unauth.Installed || unauth.Version != "2.65.0" || unauth.LoggedIn || !strings.Contains(unauth.Reason, "not logged") {
		t.Fatalf("unexpected unauthenticated gh status: %+v", unauth)
	}

	// 3. Authenticated gh.
	authBin := installFakeGH(t, `
if [ "$1" = "--version" ]; then
  echo "gh version 2.65.0 (2026-01-01)"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo "github.com"
  echo "  ✓ Logged in to github.com account octocat (keyring)" >&2
  exit 0
fi
exit 1
`)
	t.Setenv("PATH", authBin)
	authed := repo.ProbeGitHubCLI(ctx, "")
	if !authed.Installed || !authed.LoggedIn || authed.Account != "octocat" || authed.Version != "2.65.0" || authed.Reason != "" {
		t.Fatalf("unexpected authenticated gh status: %+v", authed)
	}
}

func TestSubmitPullRequestDryRunAndLivePushWithFakeGH(t *testing.T) {
	ctx := context.Background()
	tmp := t.TempDir()
	remoteDir := filepath.Join(tmp, "remote.git")
	localDir := filepath.Join(tmp, "local")
	argsLog := filepath.Join(tmp, "gh-args.txt")

	gitExec(t, tmp, "init", "--bare", "-b", "main", remoteDir)
	gitExec(t, tmp, "init", "-b", "main", localDir)
	gitExec(t, localDir, "remote", "add", "origin", remoteDir)

	writeTestFile(t, filepath.Join(localDir, "README.md"), "# Seed\n")
	gitExec(t, localDir, "add", "README.md")
	gitExec(t, localDir, "-c", "user.name=Dev", "-c", "user.email=dev@local", "commit", "-m", "initial")
	gitExec(t, localDir, "push", "-u", "origin", "main")

	// Feature branch with 2 commits ahead of main.
	gitExec(t, localDir, "checkout", "-b", "feat/weather")
	writeTestFile(t, filepath.Join(localDir, "weather.go"), "package main\nfunc rain() {}\n")
	gitExec(t, localDir, "add", "weather.go")
	gitExec(t, localDir, "-c", "user.name=Dev", "-c", "user.email=dev@local", "commit", "-m", "add weather")
	writeTestFile(t, filepath.Join(localDir, "weather.go"), "package main\nfunc rain() int { return 1 }\n")
	gitExec(t, localDir, "add", "weather.go")
	gitExec(t, localDir, "-c", "user.name=Dev", "-c", "user.email=dev@local", "commit", "-m", "return int")

	// Install fake gh alongside system git by keeping existing PATH after fake binDir.
	ghBin := installFakeGH(t, `
echo "$*" > "`+argsLog+`"
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  echo "https://github.com/vibevalleyhq/demo/pull/42"
  exit 0
fi
exit 1
`)
	t.Setenv("PATH", ghBin+string(os.PathListSeparator)+os.Getenv("PATH"))

	// 1. DryRun: computes commits ahead + diffstat + planned args without pushing or invoking gh.
	dry, err := repo.SubmitPullRequest(ctx, repo.PRRequest{
		RepoPath: localDir,
		Base:     "main",
		Title:    "Add weather helper",
		Body:     "Automated PR body",
		DryRun:   true,
	})
	if err != nil {
		t.Fatalf("SubmitPullRequest dryRun: %v", err)
	}
	if !dry.DryRun || dry.Pushed || dry.Branch != "feat/weather" || dry.Base != "main" || dry.CommitsAhead != 2 || !strings.Contains(dry.DiffStat, "weather.go") {
		t.Fatalf("unexpected dryRun result: %+v", dry)
	}
	if !slices.Contains(dry.PlannedArgs, "create") || !slices.Contains(dry.PlannedArgs, "Add weather helper") {
		t.Fatalf("unexpected dryRun PlannedArgs: %v", dry.PlannedArgs)
	}
	if _, statErr := os.Stat(argsLog); !os.IsNotExist(statErr) {
		t.Fatalf("fake gh must not run during DryRun")
	}

	// 2. Live PR submission: pushes branch to bare remote and calls fake `gh pr create`.
	live, err := repo.SubmitPullRequest(ctx, repo.PRRequest{
		RepoPath: localDir,
		Base:     "main",
		Title:    "Add weather helper",
		Body:     "Automated PR body",
		DryRun:   false,
	})
	if err != nil {
		t.Fatalf("SubmitPullRequest live: %v", err)
	}
	if live.DryRun || !live.Pushed || live.Number != 42 || live.URL != "https://github.com/vibevalleyhq/demo/pull/42" {
		t.Fatalf("unexpected live PR result: %+v", live)
	}

	// Verify bare remote now contains refs/heads/feat/weather!
	refCheck := exec.Command("git", "-C", remoteDir, "show-ref", "--verify", "refs/heads/feat/weather")
	if out, rErr := refCheck.CombinedOutput(); rErr != nil {
		t.Fatalf("expected pushed branch on bare remote: %v (%s)", rErr, string(out))
	}
	recordedArgs, err := os.ReadFile(argsLog)
	if err != nil || !strings.Contains(string(recordedArgs), "pr create --head feat/weather --base main") {
		t.Fatalf("unexpected fake gh args: %q err=%v", string(recordedArgs), err)
	}
}

func TestScanActivityEmptyRepoGraceful(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	gitExec(t, dir, "init", "-b", "main")
	writeTestFile(t, filepath.Join(dir, "draft.txt"), "hello\n")

	act, err := repo.ScanActivity(context.Background(), dir, 7)
	if err != nil {
		t.Fatalf("ScanActivity on unborn HEAD: %v", err)
	}
	if act.Branch != "main" || act.HeadCommit != "" || act.TotalCommits != 0 || act.DirtyCount != 1 {
		t.Fatalf("unexpected unborn repo activity: %+v", act)
	}
}
