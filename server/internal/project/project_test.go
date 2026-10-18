package project

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/x/ptr"
)

// The test that runs tokei itself is skipped on a machine without it.

// root is the projects folder, as projectsDir makes it; the work root is its parent.
func projects(t *testing.T, root string, change ...func(*base.Config)) *Service {
	t.Helper()
	cfg := fixture.Config("", filepath.Dir(root), "")
	for _, f := range change {
		f(&cfg)
	}
	p, err := newService(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSessionsProjectNamesAndAddresses(t *testing.T) {
	name, url, ok := githubRepository(" https://github.com/botiverse/raft-source.git/ ")
	testkit.Eq(t, []any{name, url, ok}, []any{"raft-source", "https://github.com/botiverse/raft-source.git", true}, "github")
	for _, github := range []string{"file:///tmp/repo", "https://github.com.evil/x/y", "https://u:secret@github.com/x/y", "https://github.com/x/y/tree/main", "--upload-pack=bad", "https://github.com/x/.."} {
		if projectProblem(protocol.NewProject{Name: "ok", Github: &github}) == "" {
			t.Fatalf("%s should be refused", github)
		}
	}
	for _, name := range []string{"../bad", "/tmp/bad", ".hidden", "-option", "a/b"} {
		if projectProblem(protocol.NewProject{Name: name}) == "" {
			t.Fatalf("%s should be refused", name)
		}
	}
}

func TestSessionsNewProjectsAndDuplicates(t *testing.T) {
	root := projectsDir(t)
	os.Mkdir(filepath.Join(root, "existing"), 0o755)
	os.WriteFile(filepath.Join(root, "existing", "keep"), []byte("mine"), 0o644)
	p := projects(t, root)
	made, err := p.Create(protocol.NewProject{Name: "garden"})
	if err != nil || !made.Git {
		t.Fatalf("made: %+v %v", made, err)
	}
	if testkit.Git(t, made.Path, "rev-parse", "HEAD") == "" {
		t.Fatal("a first commit")
	}
	if _, err := p.Create(protocol.NewProject{Name: "existing"}); err == nil {
		t.Fatal("an existing folder is refused")
	}
	var group sync.WaitGroup
	results := make([]error, 2)
	for i := range results {
		group.Go(func() { _, results[i] = p.Create(protocol.NewProject{Name: "same"}) })
	}
	group.Wait()
	testkit.Eq(t, (results[0] == nil) != (results[1] == nil), true, "one of two")
	body, _ := os.ReadFile(filepath.Join(root, "existing", "keep"))
	testkit.Eq(t, string(body), "mine", "existing folder untouched")
}

func TestSessionsCloneOffline(t *testing.T) {
	root := projectsDir(t)
	source := filepath.Join(root, ".source")
	os.Mkdir(source, 0o755)
	testkit.Git(t, root, "init", "-q", "-b", "main", source)
	os.WriteFile(filepath.Join(source, "README.md"), []byte("seed"), 0o644)
	testkit.Git(t, source, "add", ".")
	testkit.Git(t, source, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "seed")
	config := filepath.Join(root, "gitconfig")
	os.WriteFile(config, []byte(fmt.Sprintf("[url \"file://%s\"]\n insteadOf = https://github.com/test/source.git\n[url \"file://%s/.missing\"]\n insteadOf = https://github.com/test/missing.git\n[protocol \"file\"]\n allow = always\n", source, root)), 0o644)
	t.Setenv("GIT_CONFIG_GLOBAL", config)
	p := projects(t, root)
	cloned, err := p.Create(protocol.NewProject{Name: "visit", Github: ptr.To("https://github.com/test/source")})
	if err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, testkit.Git(t, cloned.Path, "log", "-1", "--format=%s"), "seed", "history")
	testkit.Eq(t, testkit.Git(t, cloned.Path, "config", "--get", "remote.origin.url"), "https://github.com/test/source.git", "origin")
	if _, err := p.Create(protocol.NewProject{Name: "retry", Github: ptr.To("https://github.com/test/missing")}); err == nil {
		t.Fatal("a missing repository fails")
	}
	if slices.ContainsFunc(p.List(), func(x Project) bool { return x.Name == "retry" }) {
		t.Fatal("a failed clone is cleaned up")
	}
	if _, err := p.Create(protocol.NewProject{Name: "retry"}); err != nil {
		t.Fatalf("and can be retried: %v", err)
	}
}

func TestSessionsTaskBranchMerges(t *testing.T) {
	root := projectsDir(t)
	p := projects(t, root)
	if err := p.OpenBranch("task", "vibevalley/task-1"); err != nil {
		t.Fatal(err)
	}
	place, err := p.Workplace("task", "w1", true, "vibevalley/task-1")
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(place.Cwd, "a.txt"), []byte("a\n"), 0o644)
	brought, err := p.MergeInto(place, "vibevalley/task-1")
	if err != nil || len(brought.Hashes) != 1 {
		t.Fatalf("merged: %v %v", brought, err)
	}
	changes, err := p.BranchChanges("task", "vibevalley/task-1")
	if err != nil || len(changes.Files) != 1 || changes.Files[0].Path != "a.txt" {
		t.Fatalf("changes: %+v %v", changes, err)
	}
	said, err := p.MergeBranch("task", "vibevalley/task-1")
	if err != nil {
		t.Fatal(err)
	}
	testkit.Match(t, said, `1 个提交合进了 task 的 main`, "merged")
	ok, out := p.Run(context.Background(), filepath.Join(root, "task"), "cat a.txt && exit 3")
	testkit.Eq(t, []any{ok, out}, []any{false, "a"}, "run")
}

func TestSessionsChangedFilesSinceTheBase(t *testing.T) {
	root := projectsDir(t)
	p := projects(t, root)
	if err := p.OpenBranch("task", "vibevalley/task-1"); err != nil {
		t.Fatal(err)
	}
	work := func(id string, files ...string) Workplace {
		place, err := p.Workplace("task", id, true, "vibevalley/task-1")
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range files {
			os.WriteFile(filepath.Join(place.Cwd, f), []byte(id+"\n"), 0o644)
		}
		return place
	}
	if _, err := p.MergeInto(work("w1", "a.txt", "b.txt"), "vibevalley/task-1"); err != nil {
		t.Fatal(err)
	}
	mine := work("w2", "a.txt")
	testkit.Git(t, mine.Cwd, "-c", "user.name=t", "-c", "user.email=t@vibevalley.test", "commit", "-qam", "a")
	testkit.Git(t, mine.Cwd, "mv", "b.txt", "c.txt")
	os.WriteFile(filepath.Join(mine.Cwd, "new.txt"), []byte("new\n"), 0o644)
	if _, err := p.MergeInto(work("w3", "later.txt"), "vibevalley/task-1"); err != nil {
		t.Fatal(err)
	}
	got, err := p.ChangedFiles(mine.Cwd, "vibevalley/task-1")
	testkit.Eq(t, []any{got, err}, []any{[]string{"a.txt", "b.txt", "c.txt", "new.txt"}, nil}, "changed")
}

func TestSessionsTokeiOutput(t *testing.T) {
	report := func(name string) map[string]any {
		return map[string]any{"name": name, "stats": map[string]any{"blanks": 0, "code": 1, "comments": 0, "blobs": map[string]any{}}}
	}
	lang := func(blanks, code, comments int, reports ...map[string]any) map[string]any {
		if reports == nil {
			reports = []map[string]any{}
		}
		return map[string]any{"blanks": blanks, "code": code, "comments": comments, "inaccurate": false, "reports": reports, "children": map[string]any{}}
	}
	body, _ := json.Marshal(map[string]any{
		"TypeScript": lang(30, 400, 50, report("a.ts"), report("b.ts")),
		"Markdown":   lang(10, 0, 600, report("README.md")),
		"Go":         lang(5, 440, 0, report("main.go")),
		"Text":       lang(9, 0, 0, report("empty.txt")),
		"Total":      lang(54, 850, 650),
	})
	counts, ok := countsOf(string(body))
	testkit.Eq(t, ok, true, "read")
	testkit.Eq(t, counts, []protocol.LanguageCount{
		{Name: "Markdown", Files: 1, Code: 0, Comments: 600, Blanks: 10},
		{Name: "TypeScript", Files: 2, Code: 400, Comments: 50, Blanks: 30},
		{Name: "Go", Files: 1, Code: 440, Comments: 0, Blanks: 5},
	}, "counts")
	if _, ok := countsOf("not json"); ok {
		t.Fatal("not json")
	}
	if _, ok := countsOf(`{"TypeScript":{"code":"many"}}`); ok {
		t.Fatal("not tokei's")
	}
	args := tokeiArgs("/work/app")
	testkit.Eq(t, args[:2], []string{"--output", "json"}, "json")
	testkit.Eq(t, args[len(args)-1], "/work/app", "path last")
	for _, pattern := range []string{"pnpm-lock.yaml", "package-lock.json", "Cargo.lock", "*.min.js", "node_modules/"} {
		if !slices.Contains(args, pattern) {
			t.Fatalf("%s left out", pattern)
		}
	}
}

func TestSessionsActivityOf(t *testing.T) {
	at := func(iso string) int64 { tm, _ := time.Parse(time.RFC3339, iso); return tm.Unix() }
	day := func(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02") }
	log := strings.Join([]string{
		fmt.Sprintf("%d\tMe", at("2026-10-02T09:00:00Z")),
		fmt.Sprintf("%d\tMe", at("2026-10-01T10:00:00Z")),
		fmt.Sprintf("%d\tColleague", at("2026-10-02T20:00:00Z")),
		"", "garbage",
		fmt.Sprintf("%d\t", at("2026-10-02T21:00:00Z")),
	}, "\n")
	days, authors := activityOf(log, day)
	testkit.Eq(t, days, []protocol.DayCount{{Day: "2026-10-01", Commits: 1}, {Day: "2026-10-02", Commits: 3}}, "days")
	testkit.Eq(t, authors, []protocol.Author{{Name: "Me", Commits: 2}, {Name: "Colleague", Commits: 1}, {Name: "无名", Commits: 1}}, "authors")
}

func workRoot(t *testing.T) string {
	root := projectsDir(t)
	app := filepath.Join(root, "app")
	os.Mkdir(app, 0o755)
	testkit.Git(t, app, "init", "-q", "-b", "main")
	testkit.Git(t, app, "config", "user.email", "me@vibevalley.test")
	testkit.Git(t, app, "config", "user.name", "Me")
	os.WriteFile(filepath.Join(app, "main.ts"), []byte("export const a = 1\n// a comment\n\nexport const b = 2\n"), 0o644)
	os.WriteFile(filepath.Join(app, "pnpm-lock.yaml"), []byte(strings.Repeat("lockfileVersion: 9\n", 500)), 0o644)
	testkit.Git(t, app, "add", ".")
	dated := func(date string, args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = app
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	dated("2026-10-01T10:00:00", "commit", "-q", "-m", "first")
	testkit.Git(t, app, "checkout", "-q", "-b", "side")
	dated("2026-10-02T10:00:00", "commit", "-q", "--allow-empty", "-m", "second", "--author", "Colleague <c@vibevalley.test>")
	testkit.Git(t, app, "checkout", "-q", "main")
	testkit.Git(t, app, "merge", "-q", "--no-ff", "-m", "merge side", "side")
	os.Mkdir(filepath.Join(root, "notes"), 0o755)
	return root
}

func TestSessionsProjectsWithTheirNewestCommit(t *testing.T) {
	root := workRoot(t)
	list := projects(t, root).Summaries(context.Background())
	byName := map[string]protocol.ProjectSummary{}
	for _, p := range list {
		byName[p.Name] = p
	}
	if !byName["app"].Git || byName["app"].Last == nil || *byName["app"].Last <= 0 {
		t.Fatalf("app: %+v", byName["app"])
	}
	real, _ := filepath.EvalSymlinks(root)
	testkit.Eq(t, byName["notes"].Path, filepath.Join(real, "notes"), "where it is")
	testkit.Eq(t, byName["notes"], protocol.ProjectSummary{PullRequest: protocol.PullRequestCapability{Reason: "尚未检测项目，请刷新 GitHub 状态"}, Name: "notes", Path: byName["notes"].Path, Git: false, Slots: 3}, "notes")
}

func TestSessionsSlotsAreTheProjectLimitWithinTheBeds(t *testing.T) {
	for limit, slots := range map[int]int64{3: 3, 1: 1, 0: protocol.MaxRunning, 9: protocol.MaxRunning} {
		testkit.Eq(t, (&Service{perProject: limit}).Slots(), slots, fmt.Sprint("limit ", limit))
	}
}

func TestSessionsAYearOfCommits(t *testing.T) {
	c := projects(t, workRoot(t))
	activity := c.Activity(context.Background(), "app")
	if activity == nil {
		t.Fatal("app")
	}
	testkit.Eq(t, activity.Total, int64(2), "two commits; the merge does not count")
	testkit.Eq(t, []string{activity.Days[0].Day, activity.Days[1].Day}, []string{"2026-10-01", "2026-10-02"}, "days")
	testkit.Eq(t, activity.Authors, []protocol.Author{{Name: "Colleague", Commits: 1}, {Name: "Me", Commits: 1}}, "authors")
	first, _ := time.ParseInLocation("2006-01-02T15:04:05", "2026-10-01T10:00:00", time.Local)
	testkit.Eq(t, *activity.First, first.UnixMilli(), "first")
	notes := c.Activity(context.Background(), "notes")
	testkit.Eq(t, []any{len(notes.Days), notes.Total}, []any{0, int64(0)}, "notes")
	if c.Activity(context.Background(), "../etc") != nil {
		t.Fatal("only a folder the work directory has")
	}
}

func TestSessionsWithoutTokei(t *testing.T) {
	_, err := projects(t, workRoot(t), func(c *base.Config) { c.Tokei = "/nowhere/tokei" }).Languages(context.Background(), "app")
	if err == nil || err.Error() != noTokei {
		t.Fatalf("refused with how to get it: %v", err)
	}
}

func TestSessionsTokeiCounts(t *testing.T) {
	if _, err := exec.LookPath("tokei"); err != nil {
		t.Skip("tokei is not installed")
	}
	c := projects(t, workRoot(t))
	counted, err := c.Languages(context.Background(), "app")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, l := range counted.Languages {
		got = append(got, fmt.Sprintf("%s %d %d %d", l.Name, l.Files, l.Code, l.Comments))
	}
	testkit.Eq(t, got, []string{"TypeScript 1 2 1"}, "the lock file left out")
	if none, _ := c.Languages(context.Background(), "nothing-here"); none != nil {
		t.Fatal("no such project")
	}
}

func TestSessionsLeftOversCommittedWithoutCaches(t *testing.T) {
	dir := t.TempDir()
	testkit.Repo(t, dir, 1, 0)
	os.MkdirAll(filepath.Join(dir, "__pycache__"), 0o755)
	os.WriteFile(filepath.Join(dir, "__pycache__", "greet.cpython-312.pyc"), []byte("cache"), 0o644)
	if err := commitLeft(dir, "补交"); err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, testkit.Git(t, dir, "log", "--format=%s", "-1"), "mine 0", "nothing committed")
	os.WriteFile(filepath.Join(dir, "greet.py"), []byte("def greet(): pass\n"), 0o644)
	if err := commitLeft(dir, "补交"); err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, testkit.Git(t, dir, "log", "--format=%s", "-1"), "补交", "the work committed")
	testkit.Eq(t, testkit.Git(t, dir, "ls-files"), "greet.py", "without the cache")
}

func TestCheckSaysWhatCreateWouldRefuse(t *testing.T) {
	var p Service
	testkit.Eq(t, p.Check(protocol.NewProject{Name: "ok-name_1.2"}).Problem, "")
	testkit.Match(t, p.Check(protocol.NewProject{Name: "-bad"}).Problem, `项目名`)
	testkit.Match(t, p.Check(protocol.NewProject{Name: "x", Github: ptr.To("https://gitlab.com/a/b")}).Problem, `GitHub`)
}

func TestPublishedMergeKeepsReceiptWhenWorktreeCleanupFails(t *testing.T) {
	for _, intoTask := range []bool{false, true} {
		t.Run(fmt.Sprint(intoTask), func(t *testing.T) {
			root := projectsDir(t)
			p := projects(t, root)
			target := "main"
			if intoTask {
				target = "task"
				if err := p.OpenBranch("demo", target); err != nil {
					t.Fatal(err)
				}
			}
			place, err := p.Workplace("demo", "w1", true, target)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(place.Cwd, "result.txt"), []byte("kept"), 0600); err != nil {
				t.Fatal(err)
			}
			repo := filepath.Join(root, "demo")
			testkit.Git(t, repo, "worktree", "lock", place.Cwd)
			var merged Merged
			if intoTask {
				merged, err = p.MergeInto(place, target)
			} else {
				merged, err = p.Merge(place)
			}
			if err != nil || merged.Commits != 1 || merged.Warning == "" {
				t.Fatalf("publication receipt: %+v %v", merged, err)
			}
			if content := testkit.Git(t, repo, "show", target+":result.txt"); content != "kept" {
				t.Fatalf("target lost changes: %s", content)
			}
			if _, err := os.Stat(place.Cwd); err != nil {
				t.Fatal("warning must name resources actually retained", err)
			}
		})
	}
}

func projectsDir(t *testing.T) string {
	root := filepath.Join(t.TempDir(), "projects")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestMergeRunsProjectCheck(t *testing.T) {
	for _, into := range []bool{false, true} {
		for _, check := range []string{"absent", "pass", "fail"} {
			t.Run(fmt.Sprintf("into=%v/%s", into, check), func(t *testing.T) {
				root := projectsDir(t)
				p := projects(t, root)
				target := "main"
				if into {
					target = "vibevalley/task-1"
					if err := p.OpenBranch("checked", target); err != nil {
						t.Fatal(err)
					}
				}
				place, err := p.Workplace("checked", "w1", true, target)
				if err != nil {
					t.Fatal(err)
				}
				path := filepath.Join(root, "checked")
				before := testkit.Git(t, path, "rev-parse", target)
				if err := os.WriteFile(filepath.Join(place.Cwd, "work.txt"), []byte("work"), 0o644); err != nil {
					t.Fatal(err)
				}
				if check != "absent" {
					if err := os.MkdirAll(filepath.Join(place.Cwd, ".vibevalley"), 0o755); err != nil {
						t.Fatal(err)
					}
					body := "#!/bin/sh\nset -eu\ntest -f work.txt\ntest -z \"$(git status --porcelain)\"\necho check-stdout\necho check-stderr >&2\n"
					if check == "fail" {
						body += "exit 7\n"
					}
					if err := os.WriteFile(filepath.Join(place.Cwd, ".vibevalley/check"), []byte(body), 0o755); err != nil {
						t.Fatal(err)
					}
				}
				if into {
					_, err = p.MergeInto(place, target)
				} else {
					_, err = p.Merge(place)
				}
				if check == "fail" {
					if err == nil || !strings.Contains(err.Error(), "check-stdout") || !strings.Contains(err.Error(), "check-stderr") {
						t.Fatalf("check must refuse with output: %v", err)
					}
					testkit.Eq(t, testkit.Git(t, path, "rev-parse", target), before, "target unchanged")
					if _, err := os.Stat(place.Cwd); err != nil {
						t.Fatal(err)
					}
					testkit.Git(t, path, "rev-parse", "--verify", place.Branch)
				} else {
					if err != nil {
						t.Fatal(err)
					}
					testkit.Eq(t, testkit.Git(t, path, "show", target+":work.txt"), "work", "published")
				}
			})
		}
	}
}

func TestMergeCheckTimeoutAndOutputTail(t *testing.T) {
	root := projectsDir(t)
	p := projects(t, root, func(c *base.Config) { c.Project.CheckTimeoutSeconds = 3 })
	place, err := p.Workplace("timeout", "w1", true, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(place.Cwd, ".vibevalley"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := "#!/bin/sh\necho discarded-first-line\ni=0\nwhile [ $i -lt 60 ]; do echo line-$i; i=$((i+1)); done\nsleep 30\n"
	if err := os.WriteFile(filepath.Join(place.Cwd, ".vibevalley/check"), []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	_, err = p.Merge(place)
	if err == nil || !strings.Contains(err.Error(), "超时") || !strings.Contains(err.Error(), "line-59") || strings.Contains(err.Error(), "discarded-first-line") {
		t.Fatalf("timeout with last output lines: %v", err)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatal("check children outlived timeout")
	}
	if _, err := os.Stat(place.Cwd); err != nil {
		t.Fatal(err)
	}
}

func TestMergeCheckMustBeExecutable(t *testing.T) {
	root := projectsDir(t)
	p := projects(t, root)
	place, err := p.Workplace("permissions", "w1", true, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(place.Cwd, ".vibevalley"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(place.Cwd, ".vibevalley/check"), []byte("#!/bin/sh\nexit 0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err = p.Merge(place)
	failure, ok := err.(MergeFailure)
	if !ok || failure.Kind != "check" {
		t.Fatalf("non-executable check must refuse: %v", err)
	}
	if _, err := os.Stat(place.Cwd); err != nil {
		t.Fatal(err)
	}
}
