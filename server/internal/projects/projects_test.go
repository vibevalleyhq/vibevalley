package projects

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
	"vibevalley/internal/farmtest"
	"vibevalley/internal/protocol"
)

// Projects and the code base on throwaway folders and real git repositories (project-create.test.ts,
// codebase.test.ts). Offline; the test that runs
// tokei itself is skipped on a machine without it.

// ── Projects ─────────────────────────────────────────────────────────────────

func crewProjects(t *testing.T, root string) *Projects {
	t.Helper()
	p, err := newProjects(base.Config{WorkRoot: root})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestCrewProjectNamesAndAddresses(t *testing.T) {
	name, url, ok := crewGithubRepository(" https://github.com/botiverse/raft-source.git/ ")
	farmtest.Eq(t, []any{name, url, ok}, []any{"raft-source", "https://github.com/botiverse/raft-source.git", true}, "github")
	for _, github := range []string{"file:///tmp/repo", "https://github.com.evil/x/y", "https://u:secret@github.com/x/y", "https://github.com/x/y/tree/main", "--upload-pack=bad", "https://github.com/x/.."} {
		if crewProjectProblem(protocol.NewProject{Name: "ok", Github: &github}) == "" {
			t.Fatalf("%s should be refused", github)
		}
	}
	for _, name := range []string{"../bad", "/tmp/bad", ".hidden", "-option", "a/b"} {
		if crewProjectProblem(protocol.NewProject{Name: name}) == "" {
			t.Fatalf("%s should be refused", name)
		}
	}
}

func TestCrewNewProjectsAndDuplicates(t *testing.T) {
	root := t.TempDir()
	os.Mkdir(filepath.Join(root, "existing"), 0o755)
	os.WriteFile(filepath.Join(root, "existing", "keep"), []byte("mine"), 0o644)
	p := crewProjects(t, root)
	made, err := p.Create(protocol.NewProject{Name: "garden"})
	if err != nil || !made.Git {
		t.Fatalf("made: %+v %v", made, err)
	}
	if farmtest.Git(t, made.Path, "rev-parse", "HEAD") == "" {
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
	farmtest.Eq(t, (results[0] == nil) != (results[1] == nil), true, "one of two")
	body, _ := os.ReadFile(filepath.Join(root, "existing", "keep"))
	farmtest.Eq(t, string(body), "mine", "existing folder untouched")
}

func TestCrewCloneOffline(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, ".source")
	os.Mkdir(source, 0o755)
	farmtest.Git(t, root, "init", "-q", "-b", "main", source)
	os.WriteFile(filepath.Join(source, "README.md"), []byte("seed"), 0o644)
	farmtest.Git(t, source, "add", ".")
	farmtest.Git(t, source, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "seed")
	config := filepath.Join(root, "gitconfig")
	os.WriteFile(config, []byte(fmt.Sprintf("[url \"file://%s\"]\n insteadOf = https://github.com/test/source.git\n[url \"file://%s/.missing\"]\n insteadOf = https://github.com/test/missing.git\n[protocol \"file\"]\n allow = always\n", source, root)), 0o644)
	t.Setenv("GIT_CONFIG_GLOBAL", config)
	p := crewProjects(t, root)
	cloned, err := p.Create(protocol.NewProject{Name: "visit", Github: farmtest.Ptr("https://github.com/test/source")})
	if err != nil {
		t.Fatal(err)
	}
	farmtest.Eq(t, farmtest.Git(t, cloned.Path, "log", "-1", "--format=%s"), "seed", "history")
	farmtest.Eq(t, farmtest.Git(t, cloned.Path, "config", "--get", "remote.origin.url"), "https://github.com/test/source.git", "origin")
	if _, err := p.Create(protocol.NewProject{Name: "retry", Github: farmtest.Ptr("https://github.com/test/missing")}); err == nil {
		t.Fatal("a missing repository fails")
	}
	if slices.ContainsFunc(p.List(), func(x base.Project) bool { return x.Name == "retry" }) {
		t.Fatal("a failed clone is cleaned up")
	}
	if _, err := p.Create(protocol.NewProject{Name: "retry"}); err != nil {
		t.Fatalf("and can be retried: %v", err)
	}
}

func TestCrewPlaybookBranchMerges(t *testing.T) {
	root := t.TempDir()
	p := crewProjects(t, root)
	if err := p.OpenBranch("plan", "vibevalley/plan-1"); err != nil {
		t.Fatal(err)
	}
	place, err := p.Workplace("plan", "w1", true, "vibevalley/plan-1")
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(place.Cwd, "a.txt"), []byte("a\n"), 0o644)
	// Left uncommitted: MergeInto commits it rather than lose it.
	brought, err := p.MergeInto(place, "vibevalley/plan-1")
	if err != nil || len(brought) != 1 {
		t.Fatalf("merged: %v %v", brought, err)
	}
	changes, err := p.BranchChanges("plan", "vibevalley/plan-1")
	if err != nil || len(changes.Files) != 1 || changes.Files[0].Path != "a.txt" {
		t.Fatalf("changes: %+v %v", changes, err)
	}
	said, err := p.HarvestBranch("plan", "vibevalley/plan-1")
	if err != nil {
		t.Fatal(err)
	}
	farmtest.Match(t, said, `1 个提交合进了 plan 的 main`, "harvested")
	ok, out := p.Run(context.Background(), filepath.Join(root, "plan"), "cat a.txt && exit 3")
	farmtest.Eq(t, []any{ok, out}, []any{false, "a"}, "run")
}

// ChangedFiles is a step's own work: committed or not, new files too, and not what reached the base after it forked.
func TestCrewChangedFilesSinceTheBase(t *testing.T) {
	root := t.TempDir()
	p := crewProjects(t, root)
	if err := p.OpenBranch("plan", "vibevalley/plan-1"); err != nil {
		t.Fatal(err)
	}
	work := func(id string, files ...string) base.Workplace {
		place, err := p.Workplace("plan", id, true, "vibevalley/plan-1")
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range files {
			os.WriteFile(filepath.Join(place.Cwd, f), []byte(id+"\n"), 0o644)
		}
		return place
	}
	if _, err := p.MergeInto(work("w1", "a.txt", "b.txt"), "vibevalley/plan-1"); err != nil {
		t.Fatal(err)
	}
	mine := work("w2", "a.txt")
	farmtest.Git(t, mine.Cwd, "-c", "user.name=t", "-c", "user.email=t@vibevalley.test", "commit", "-qam", "a")
	farmtest.Git(t, mine.Cwd, "mv", "b.txt", "c.txt")
	os.WriteFile(filepath.Join(mine.Cwd, "new.txt"), []byte("new\n"), 0o644)
	if _, err := p.MergeInto(work("w3", "later.txt"), "vibevalley/plan-1"); err != nil {
		t.Fatal(err)
	}
	got, err := p.ChangedFiles(mine.Cwd, "vibevalley/plan-1")
	farmtest.Eq(t, []any{got, err}, []any{[]string{"a.txt", "b.txt", "c.txt", "new.txt"}, nil}, "changed")
}

// ── The code base ────────────────────────────────────────────────────────────

func TestCrewTokeiOutput(t *testing.T) {
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
	counts, ok := crewCountsOf(string(body))
	farmtest.Eq(t, ok, true, "read")
	farmtest.Eq(t, counts, []protocol.LanguageCount{
		{Name: "Markdown", Files: 1, Code: 0, Comments: 600, Blanks: 10},
		{Name: "TypeScript", Files: 2, Code: 400, Comments: 50, Blanks: 30},
		{Name: "Go", Files: 1, Code: 440, Comments: 0, Blanks: 5},
	}, "counts")
	if _, ok := crewCountsOf("not json"); ok {
		t.Fatal("not json")
	}
	if _, ok := crewCountsOf(`{"TypeScript":{"code":"many"}}`); ok {
		t.Fatal("not tokei's")
	}
	args := crewTokeiArgs("/work/app")
	farmtest.Eq(t, args[:2], []string{"--output", "json"}, "json")
	farmtest.Eq(t, args[len(args)-1], "/work/app", "path last")
	for _, pattern := range []string{"pnpm-lock.yaml", "package-lock.json", "Cargo.lock", "*.min.js", "node_modules/"} {
		if !slices.Contains(args, pattern) {
			t.Fatalf("%s left out", pattern)
		}
	}
}

func TestCrewActivityOf(t *testing.T) {
	at := func(iso string) int64 { tm, _ := time.Parse(time.RFC3339, iso); return tm.Unix() }
	day := func(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02") }
	log := strings.Join([]string{
		fmt.Sprintf("%d\tMe", at("2026-10-02T09:00:00Z")),
		fmt.Sprintf("%d\tMe", at("2026-10-01T10:00:00Z")),
		fmt.Sprintf("%d\tColleague", at("2026-10-02T20:00:00Z")),
		"", "garbage",
		fmt.Sprintf("%d\t", at("2026-10-02T21:00:00Z")),
	}, "\n")
	days, authors := crewActivityOf(log, day)
	farmtest.Eq(t, days, []protocol.DayCount{{Day: "2026-10-01", Commits: 1}, {Day: "2026-10-02", Commits: 3}}, "days")
	farmtest.Eq(t, authors, []protocol.Author{{Name: "Me", Commits: 2}, {Name: "Colleague", Commits: 1}, {Name: "无名", Commits: 1}}, "authors")
}

// crewWorkRoot is a work directory with project app (two commits a day apart, one by someone else, and a merge) and folder notes.
func crewWorkRoot(t *testing.T) string {
	root := t.TempDir()
	app := filepath.Join(root, "app")
	os.Mkdir(app, 0o755)
	farmtest.Git(t, app, "init", "-q", "-b", "main")
	farmtest.Git(t, app, "config", "user.email", "me@vibevalley.test")
	farmtest.Git(t, app, "config", "user.name", "Me")
	os.WriteFile(filepath.Join(app, "main.ts"), []byte("export const a = 1\n// a comment\n\nexport const b = 2\n"), 0o644)
	os.WriteFile(filepath.Join(app, "pnpm-lock.yaml"), []byte(strings.Repeat("lockfileVersion: 9\n", 500)), 0o644)
	farmtest.Git(t, app, "add", ".")
	dated := func(date string, args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = app
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	dated("2026-10-01T10:00:00", "commit", "-q", "-m", "first")
	farmtest.Git(t, app, "checkout", "-q", "-b", "side")
	dated("2026-10-02T10:00:00", "commit", "-q", "--allow-empty", "-m", "second", "--author", "Colleague <c@vibevalley.test>")
	farmtest.Git(t, app, "checkout", "-q", "main")
	farmtest.Git(t, app, "merge", "-q", "--no-ff", "-m", "merge side", "side")
	os.Mkdir(filepath.Join(root, "notes"), 0o755)
	return root
}

func crewCodebase(t *testing.T, root string) *Codebase {
	c, _ := newCodebase(crewProjects(t, root))
	return c
}

func TestCrewProjectsWithTheirNewestCommit(t *testing.T) {
	root := crewWorkRoot(t)
	list := crewCodebase(t, root).List(context.Background())
	byName := map[string]protocol.ProjectSummary{}
	for _, p := range list {
		byName[p.Name] = p
	}
	if !byName["app"].Git || byName["app"].Last == nil || *byName["app"].Last <= 0 {
		t.Fatalf("app: %+v", byName["app"])
	}
	real, _ := filepath.EvalSymlinks(root)
	farmtest.Eq(t, byName["notes"].Path, filepath.Join(real, "notes"), "where it is")
	farmtest.Eq(t, byName["notes"], protocol.ProjectSummary{Name: "notes", Path: byName["notes"].Path, Git: false, Slots: 3}, "notes")
}

func TestCrewSlotsAreTheProjectLimitWithinTheBeds(t *testing.T) {
	for limit, slots := range map[int]int64{3: 3, 1: 1, 0: protocol.MaxRunning, 9: protocol.MaxRunning} {
		farmtest.Eq(t, (&Projects{perProject: limit}).Slots(), slots, fmt.Sprint("limit ", limit))
	}
}

func TestCrewAYearOfCommits(t *testing.T) {
	c := crewCodebase(t, crewWorkRoot(t))
	activity := c.Activity(context.Background(), "app")
	if activity == nil {
		t.Fatal("app")
	}
	farmtest.Eq(t, activity.Total, int64(2), "two commits; the merge does not count")
	farmtest.Eq(t, []string{activity.Days[0].Day, activity.Days[1].Day}, []string{"2026-10-01", "2026-10-02"}, "days")
	farmtest.Eq(t, activity.Authors, []protocol.Author{{Name: "Colleague", Commits: 1}, {Name: "Me", Commits: 1}}, "authors")
	first, _ := time.ParseInLocation("2006-01-02T15:04:05", "2026-10-01T10:00:00", time.Local)
	farmtest.Eq(t, *activity.First, first.UnixMilli(), "first")
	notes := c.Activity(context.Background(), "notes")
	farmtest.Eq(t, []any{len(notes.Days), notes.Total}, []any{0, int64(0)}, "notes")
	if c.Activity(context.Background(), "../etc") != nil {
		t.Fatal("only a folder the work directory has")
	}
}

func TestCrewWithoutTokei(t *testing.T) {
	t.Setenv("VIBEVALLEY_TOKEI", "/nowhere/tokei")
	_, err := crewCodebase(t, crewWorkRoot(t)).Languages(context.Background(), "app")
	if err == nil || err.Error() != crewNoTokei {
		t.Fatalf("refused with how to get it: %v", err)
	}
}

func TestCrewTokeiCounts(t *testing.T) {
	if _, err := exec.LookPath("tokei"); err != nil {
		t.Skip("tokei is not installed")
	}
	c := crewCodebase(t, crewWorkRoot(t))
	counted, err := c.Languages(context.Background(), "app")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, l := range counted.Languages {
		got = append(got, fmt.Sprintf("%s %d %d %d", l.Name, l.Files, l.Code, l.Comments))
	}
	farmtest.Eq(t, got, []string{"TypeScript 1 2 1"}, "the lock file left out")
	if none, _ := c.Languages(context.Background(), "nothing-here"); none != nil {
		t.Fatal("no such project")
	}
}

func TestCrewLeftOversCommittedWithoutCaches(t *testing.T) {
	dir := t.TempDir()
	farmtest.Repo(t, dir, 1, 0)
	os.MkdirAll(filepath.Join(dir, "__pycache__"), 0o755)
	os.WriteFile(filepath.Join(dir, "__pycache__", "greet.cpython-312.pyc"), []byte("cache"), 0o644)
	// Only a cache left: nothing is committed.
	if err := crewCommitLeft(dir, "补交"); err != nil {
		t.Fatal(err)
	}
	farmtest.Eq(t, farmtest.Git(t, dir, "log", "--format=%s", "-1"), "mine 0", "nothing committed")
	os.WriteFile(filepath.Join(dir, "greet.py"), []byte("def greet(): pass\n"), 0o644)
	if err := crewCommitLeft(dir, "补交"); err != nil {
		t.Fatal(err)
	}
	farmtest.Eq(t, farmtest.Git(t, dir, "log", "--format=%s", "-1"), "补交", "the work committed")
	farmtest.Eq(t, farmtest.Git(t, dir, "ls-files"), "greet.py", "without the cache")
}
