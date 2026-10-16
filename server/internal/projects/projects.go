package projects

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
)

// Projects (ported from the TypeScript server's projects.ts, removed): every folder directly under the work directory (VIBEVALLEY_WORK_ROOT) is one,
// and each is a git repository, made one (with a first commit) the first time a helper is sent there. A helper
// works in a worktree of its own under <root>/.worktrees, on a branch of its own; harvest merges that branch into
// the project's main branch. The house rules for every project are <root>/AGENTS.md: helpers get them whatever
// runtime they run on.
//
// Before a harvest, Changes says what it would bring in (commits, files with their diffs, what is not committed) and
// whether it merges cleanly: `git merge-tree` works that out without touching any checkout. A harvest that would
// conflict is not attempted; the helper is asked to merge the main branch in and resolve it.
//
// A playbook has a branch of its own (OpenBranch): its steps' worktrees start from it, and each finished step is
// merged into it (MergeInto) without checking it out anywhere: merge-tree writes the merged tree, commit-tree and
// update-ref put it on the branch. Harvesting the playbook (HarvestBranch) merges it into the main branch.

const (
	// A check command gets this long, and keeps this much of what it printed (its end: a test run's verdict).
	crewCheckTimeout = 10 * time.Minute
	crewCheckOutput  = 3000
	// A file's diff in the preview keeps this many lines; the whole preview keeps diffs up to this many characters.
	crewPatchLines   = 400
	crewPatchesMax   = 400_000
	crewCloneTimeout = 3 * time.Minute
)

// crewProjectName is a folder name a project can have: one plain name, no paths (protocol's PROJECT_NAME).
var crewProjectName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)

var crewGithubURL = regexp.MustCompile(`^https://github\.com/([A-Za-z0-9-]+)/([A-Za-z0-9_.-]+)/?$`)

// crewGithubRepository is a public repository's home URL as the URL to clone, and the repository's name; only
// repository home URLs, never credentials, arbitrary git transports or command-line options (protocol's
// githubRepository). ok false when it is not one.
func crewGithubRepository(input string) (name, url string, ok bool) {
	m := crewGithubURL.FindStringSubmatch(base.Trim(input))
	if m == nil {
		return "", "", false
	}
	name = strings.TrimSuffix(m[2], ".git")
	if name == "" || name == "." || name == ".." {
		return "", "", false
	}
	return name, "https://github.com/" + m[1] + "/" + name + ".git", true
}

// crewProjectProblem is what is wrong with a new project's request; "" when nothing (protocol's projectProblem).
func crewProjectProblem(req protocol.NewProject) string {
	if !crewProjectName.MatchString(req.Name) {
		return "项目名用字母或数字开头，只含字母、数字、-、_、.，最多 64 个字符"
	}
	if req.Github != nil {
		if _, _, ok := crewGithubRepository(*req.Github); !ok {
			return "请填公开 GitHub 仓库地址，例如 https://github.com/botiverse/raft-source"
		}
	}
	return ""
}

// crewGitignore is what a fresh repository ignores, so a first commit of an existing folder does not take its dependencies.
const crewGitignore = "node_modules/\ndist/\nbuild/\n.env\n.env.*\n!.env.example\n.DS_Store\n__pycache__/\n*.pyc\n.pytest_cache/\n.venv/\n"

// crewNeverCommitted is what a helper's left-over changes are committed without, whatever the project ignores: caches
// and installed packages a run leaves behind (pathspecs for git add).
var crewNeverCommitted = []string{":(exclude,glob)**/__pycache__/**", ":(exclude,glob)**/*.pyc", ":(exclude,glob)**/.pytest_cache/**", ":(exclude,glob)**/node_modules/**", ":(exclude,glob)**/.DS_Store"}

// crewGitError is git failing: its exit code and what it said.
type crewGitError struct {
	Code   int
	Stderr string
	Err    error
}

func (e *crewGitError) Error() string {
	if s := strings.TrimSpace(e.Stderr); s != "" {
		return s
	}
	return e.Err.Error()
}

// crewGitRun runs git in cwd: its output, and its exit code; err only when git could not run at all.
func crewGitRun(ctx context.Context, cwd string, args ...string) (stdout string, code int, err error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = cwd
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	runErr := cmd.Run()
	var exit *exec.ExitError
	if errors.As(runErr, &exit) {
		return out.String(), exit.ExitCode(), &crewGitError{Code: exit.ExitCode(), Stderr: errOut.String(), Err: runErr}
	}
	if runErr != nil {
		return "", -1, runErr
	}
	return out.String(), 0, nil
}

// crewGit runs git; its trimmed output, or an error with git's own message.
func crewGit(cwd string, args ...string) (string, error) {
	out, _, err := crewGitRun(context.Background(), cwd, args...)
	return strings.TrimSpace(out), err
}

func crewGitOk(cwd string, args ...string) bool {
	_, err := crewGit(cwd, args...)
	return err == nil
}

// crewCommit commits as the machine's git user, or as vibevalley when there is none configured.
func crewCommit(cwd, message string) error {
	if _, err := crewGit(cwd, "commit", "-q", "-m", message); err == nil {
		return nil
	}
	_, err := crewGit(cwd, "-c", "user.name=vibevalley", "-c", "user.email=vibevalley@localhost", "commit", "-q", "-m", message)
	return err
}

// crewMergeCommit is a merge commit of ours and theirs whose tree merge-tree worked out, made without a checkout.
func crewMergeCommit(path, ours, theirs, message string) (string, error) {
	out, err := crewGit(path, "merge-tree", "--write-tree", "--no-messages", ours, theirs)
	if err != nil {
		return "", err
	}
	tree, _, _ := strings.Cut(out, "\n")
	args := []string{"commit-tree", tree, "-p", ours, "-p", theirs, "-m", message}
	if hash, err := crewGit(path, args...); err == nil {
		return hash, nil
	}
	return crewGit(path, append([]string{"-c", "user.name=vibevalley", "-c", "user.email=vibevalley@localhost"}, args...)...)
}

// crewConflictsOf is the files that would conflict merging branch into base, worked out without touching a checkout.
func crewConflictsOf(path, baseBranch, branch string) ([]string, error) {
	out, code, err := crewGitRun(context.Background(), path, "merge-tree", "--write-tree", "--name-only", "--no-messages", baseBranch, branch)
	if code == 0 && err == nil {
		return nil, nil
	}
	if code != 1 {
		if code < 0 {
			return nil, err
		}
		return nil, fmt.Errorf("git merge-tree 出错（%d）", code)
	}
	// First line: the tree it would write; then each conflicted file.
	var files []string
	for _, line := range strings.Split(strings.TrimSpace(out), "\n")[1:] {
		if line != "" && !slices.Contains(files, line) {
			files = append(files, line)
		}
	}
	return files, nil
}

// crewReason is an error's first meaningful line, for the person.
func crewReason(err error) string {
	for _, line := range strings.Split(err.Error(), "\n") {
		if strings.TrimSpace(line) != "" {
			return line
		}
	}
	return err.Error()
}

type Projects struct {
	root  string
	trees string
	// perProject is how many helpers may work in one project at once ($VIBEVALLEY_MAX_PER_PROJECT, 3): more than a few
	// start changing the same files. 0: no limit of its own.
	perProject int

	mu      sync.Mutex
	queues  map[string]*sync.Mutex
	pending map[string]bool
}

func newProjects(cfg base.Config) (*Projects, error) {
	root, err := filepath.Abs(cfg.WorkRoot)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	return &Projects{
		root: root, trees: filepath.Join(root, ".worktrees"), perProject: int(base.EnvNumber("VIBEVALLEY_MAX_PER_PROJECT", 3)),
		queues: map[string]*sync.Mutex{}, pending: map[string]bool{},
	}, nil
}

// Limit is how many helpers may work in one project at once; 0 when a project has no limit of its own.
func (p *Projects) Limit() int { return p.perProject }

// Slots is how many helpers may work in one project at once: its limit, or the farm's beds when there is none or it is
// higher.
func (p *Projects) Slots() int64 {
	if p.perProject <= 0 || p.perProject > protocol.MaxRunning {
		return protocol.MaxRunning
	}
	return int64(p.perProject)
}

func (*Projects) OnStart(context.Context) error { return nil }
func (*Projects) OnStop()                       {}

func (p *Projects) Root() string { return p.root }

// serially runs one change to a project's repository at a time: two helpers sent to a new project at once must not
// both run git init, and two harvests must not merge into the same branch together.
func (p *Projects) serially(project string) func() {
	p.mu.Lock()
	q, ok := p.queues[project]
	if !ok {
		q = &sync.Mutex{}
		p.queues[project] = q
	}
	p.mu.Unlock()
	q.Lock()
	return q.Unlock
}

// ensure is the project's folder as a repository with at least one commit.
func (p *Projects) ensure(name string) (string, error) {
	if !crewProjectName.MatchString(name) {
		return "", fmt.Errorf("「%s」不能当项目名：用一个简单的英文文件夹名，比如 clock-in", name)
	}
	if err := os.MkdirAll(filepath.Join(p.root, name), 0o755); err != nil {
		return "", err
	}
	// git answers with real paths (on macOS /tmp is /private/tmp): compare like with like.
	path, err := filepath.EvalSymlinks(filepath.Join(p.root, name))
	if err != nil {
		return "", err
	}
	top, _ := crewGit(path, "rev-parse", "--show-toplevel")
	switch {
	case top != path:
		if _, err := crewGit(path, "init", "-q", "-b", "main"); err != nil {
			return "", err
		}
		if _, err := os.Stat(filepath.Join(path, ".gitignore")); err != nil {
			if err := os.WriteFile(filepath.Join(path, ".gitignore"), []byte(crewGitignore), 0o644); err != nil {
				return "", err
			}
		}
		entries, _ := os.ReadDir(path)
		if len(slices.DeleteFunc(entries, func(e os.DirEntry) bool { return e.Name() == ".git" })) <= 1 {
			if err := os.WriteFile(filepath.Join(path, "README.md"), []byte("# "+name+"\n"), 0o644); err != nil {
				return "", err
			}
		}
		if _, err := crewGit(path, "add", "-A"); err != nil {
			return "", err
		}
		if err := crewCommit(path, "初始提交（VibeValley 建的项目）"); err != nil {
			return "", err
		}
	case !crewGitOk(path, "rev-parse", "--verify", "HEAD"):
		if _, err := crewGit(path, "commit", "-q", "--allow-empty", "-m", "初始提交"); err != nil {
			if err := crewCommit(path, "初始提交"); err != nil {
				return "", err
			}
		}
	}
	return path, nil
}

// Create makes a project: a new folder with a first commit, or a clone of a public GitHub repository.
func (p *Projects) Create(req protocol.NewProject) (base.Project, error) {
	defer p.serially(req.Name)()
	if problem := crewProjectProblem(req); problem != "" {
		return base.Project{}, errors.New(problem)
	}
	path := filepath.Join(p.root, req.Name)
	// Exclusive creation also refuses existing empty folders and symlinks.
	if err := os.Mkdir(path, 0o755); err != nil {
		if errors.Is(err, os.ErrExist) {
			return base.Project{}, fmt.Errorf("「%s」已经存在，请换个项目名", req.Name)
		}
		return base.Project{}, errors.New(crewReason(err))
	}
	p.mu.Lock()
	p.pending[req.Name] = true
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		delete(p.pending, req.Name)
		p.mu.Unlock()
	}()
	fail := func(err error) (base.Project, error) {
		_ = os.RemoveAll(path)
		return base.Project{}, err
	}
	if req.Github != nil {
		_, url, _ := crewGithubRepository(*req.Github)
		ctx, cancel := context.WithTimeout(context.Background(), crewCloneTimeout)
		defer cancel()
		cmd := exec.CommandContext(ctx, "git", "-c", "credential.helper=", "-c", "core.askPass=", "clone", "--", url, path)
		cmd.Dir = p.root
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_LFS_SKIP_SMUDGE=1")
		if err := cmd.Run(); err != nil {
			return fail(errors.New("下载失败：请确认仓库公开、地址正确且网络可用；超过 3 分钟会停止，可重试"))
		}
	} else if _, err := p.ensure(req.Name); err != nil {
		return fail(errors.New(crewReason(err)))
	}
	return base.Project{Name: req.Name, Path: path, Git: true}, nil
}

// List is the projects: every folder under the work directory but the hidden ones and those being made.
func (p *Projects) List() []base.Project {
	entries, err := os.ReadDir(p.root)
	if err != nil {
		return nil
	}
	p.mu.Lock()
	pending := make(map[string]bool, len(p.pending))
	for k := range p.pending {
		pending[k] = true
	}
	p.mu.Unlock()
	var out []base.Project
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") || pending[e.Name()] {
			continue
		}
		path, err := filepath.EvalSymlinks(filepath.Join(p.root, e.Name()))
		if err != nil {
			continue
		}
		top, _ := crewGit(path, "rev-parse", "--show-toplevel")
		out = append(out, base.Project{Name: e.Name(), Path: path, Git: top == path})
	}
	return out
}

// Workplace is a place for one helper in a project, making the project (folder, repository, first commit) if needed.
func (p *Projects) Workplace(project, helper string, worktree bool, baseBranch string) (base.Workplace, error) {
	defer p.serially(project)()
	path, err := p.ensure(project)
	if err != nil {
		return base.Workplace{}, errors.New(crewReason(err))
	}
	if !worktree {
		return base.Workplace{Project: project, Cwd: path}, nil
	}
	stamp := strconv.FormatInt(base.NowMs(), 36)
	branch := "vibevalley/" + helper + "-" + stamp
	cwd := filepath.Join(p.trees, project+"-"+helper+"-"+stamp)
	if err := os.MkdirAll(p.trees, 0o755); err != nil {
		return base.Workplace{}, err
	}
	if baseBranch == "" {
		baseBranch = "HEAD"
	}
	if _, err := crewGit(path, "worktree", "add", "-q", "-b", branch, cwd, baseBranch); err != nil {
		return base.Workplace{}, errors.New(crewReason(err))
	}
	return base.Workplace{Project: project, Cwd: cwd, Branch: branch}, nil
}

// describe is what merging the place's branch into the main branch would bring in; cwd is where uncommitted work
// would be ("" for a branch with no worktree).
func (p *Projects) describe(project, cwd, branch string) (protocol.Changes, error) {
	path := filepath.Join(p.root, project)
	baseBranch, err := crewGit(path, "symbolic-ref", "--short", "HEAD")
	if err != nil {
		return protocol.Changes{}, errors.New(crewReason(err))
	}
	uncommitted := []protocol.UncommittedItem{}
	if cwd != "" {
		status, _, _ := crewGitRun(context.Background(), cwd, "status", "--porcelain=v1", "-uall")
		for _, line := range strings.Split(strings.TrimRight(status, "\n"), "\n") {
			if len(line) < 4 {
				continue
			}
			code := strings.TrimSpace(line[:2])
			letter := code
			if code == "??" {
				letter = "A"
			} else if code != "" {
				letter = code[:1]
			}
			uncommitted = append(uncommitted, protocol.UncommittedItem{Path: line[3:], Status: letter})
		}
	}
	changes := protocol.Changes{Project: project, Base: baseBranch, Commits: []protocol.Commit{}, Files: []protocol.ChangedFile{}, Uncommitted: uncommitted, Conflicts: []string{}}
	if branch == "" {
		return changes, nil
	}
	changes.Branch = &branch
	rng := baseBranch + "..." + branch
	logOut, err := crewGit(path, "log", "--format=%h%x09%ct%x09%s", baseBranch+".."+branch)
	if err != nil {
		return protocol.Changes{}, errors.New(crewReason(err))
	}
	names, err := crewGit(path, "diff", "--no-renames", "--name-status", rng)
	if err != nil {
		return protocol.Changes{}, errors.New(crewReason(err))
	}
	numbers, _ := crewGit(path, "diff", "--no-renames", "--numstat", rng)
	patch, _, _ := crewGitRun(context.Background(), path, "diff", "--no-renames", "--no-color", rng)
	patch = strings.TrimSpace(patch)
	conflicts, err := crewConflictsOf(path, baseBranch, branch)
	if err != nil {
		return protocol.Changes{}, errors.New(crewReason(err))
	}
	behind, _ := crewGit(path, "rev-list", "--count", branch+".."+baseBranch)

	type count struct{ added, removed int64 }
	counts := map[string]count{}
	for _, line := range strings.Split(numbers, "\n") {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) < 3 {
			continue
		}
		n := count{-1, -1}
		if parts[0] != "-" {
			n.added, _ = strconv.ParseInt(parts[0], 10, 64)
		}
		if parts[1] != "-" {
			n.removed, _ = strconv.ParseInt(parts[1], 10, 64)
		}
		counts[strings.Join(parts[2:], "\t")] = n
	}
	// The whole diff, cut at each file's header, then matched to its path.
	var chunks []string
	if patch != "" {
		for i, c := range strings.Split(patch, "\ndiff --git ") {
			if i > 0 {
				c = "diff --git " + c
			}
			chunks = append(chunks, c)
		}
	}
	budget := crewPatchesMax
	for _, line := range strings.Split(names, "\n") {
		if line == "" {
			continue
		}
		letter, file, _ := strings.Cut(line, "\t")
		n, ok := counts[file]
		if !ok {
			n = count{}
		}
		changed := protocol.ChangedFile{Path: file, Status: letter[:1], Added: n.added, Removed: n.removed}
		if n.added >= 0 {
			head := "diff --git a/" + file + " b/" + file + "\n"
			if i := slices.IndexFunc(chunks, func(c string) bool { return strings.HasPrefix(c, head) }); i >= 0 {
				chunk := chunks[i]
				// A chunk cut out of the middle of the diff lost its trailing newline to the split.
				if i < len(chunks)-1 {
					chunk += "\n"
				}
				lines := strings.Split(chunk, "\n")
				if len(lines) > crewPatchLines {
					chunk = strings.Join(lines[:crewPatchLines], "\n") + fmt.Sprintf("\n… 还有 %d 行没显示", len(lines)-crewPatchLines)
				}
				if units := base.Units(chunk); units <= budget {
					budget -= units
					changed.Patch = &chunk
				}
			}
		}
		changes.Files = append(changes.Files, changed)
	}
	for _, line := range strings.Split(logOut, "\n") {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		at := int64(0)
		if len(parts) > 1 {
			at, _ = strconv.ParseInt(parts[1], 10, 64)
		}
		subject := ""
		if len(parts) > 2 {
			subject = strings.Join(parts[2:], "\t")
		}
		changes.Commits = append(changes.Commits, protocol.Commit{Hash: parts[0], At: at * 1000, Subject: subject})
	}
	changes.Conflicts = append(changes.Conflicts, conflicts...)
	changes.Behind, _ = strconv.ParseInt(behind, 10, 64)
	return changes, nil
}

// Changes is what harvesting would bring in, and whether it merges cleanly. Changes nothing.
func (p *Projects) Changes(place base.Workplace) (protocol.Changes, error) {
	return p.describe(place.Project, place.Cwd, place.Branch)
}

// ChangedFiles is what the work in cwd changed since it branched off base: committed or not, new files too, a
// renamed file under both its names.
func (p *Projects) ChangedFiles(cwd, baseBranch string) ([]string, error) {
	fork, err := crewGit(cwd, "merge-base", baseBranch, "HEAD")
	if err != nil {
		return nil, err
	}
	changed, err := crewGit(cwd, "diff", "--name-only", "--no-renames", fork)
	if err != nil {
		return nil, err
	}
	added, err := crewGit(cwd, "ls-files", "--others", "--exclude-standard")
	if err != nil {
		return nil, err
	}
	var out []string
	for _, f := range strings.Split(changed+"\n"+added, "\n") {
		if f != "" && !slices.Contains(out, f) {
			out = append(out, f)
		}
	}
	slices.Sort(out)
	return out, nil
}

// BranchChanges is what merging branch (a playbook's, with no worktree) into the main branch would bring in.
func (p *Projects) BranchChanges(project, branch string) (protocol.Changes, error) {
	return p.describe(project, "", branch)
}

// Conflict is whether its branch would conflict with base (the main branch when "") now; nil when it merges
// cleanly (or cannot tell).
func (p *Projects) Conflict(place base.Workplace, baseBranch string) *protocol.Conflict {
	if place.Branch == "" {
		return nil
	}
	path := filepath.Join(p.root, place.Project)
	if baseBranch == "" {
		baseBranch, _ = crewGit(path, "symbolic-ref", "--short", "HEAD")
	}
	if baseBranch == "" {
		return nil
	}
	files, err := crewConflictsOf(path, baseBranch, place.Branch)
	if err != nil || len(files) == 0 {
		return nil
	}
	return &protocol.Conflict{Base: baseBranch, Files: files}
}

// commitLeft commits what a helper did not: it is still its work.
func crewCommitLeft(cwd, message string) error {
	if status, _ := crewGit(cwd, "status", "--porcelain"); status == "" {
		return nil
	}
	if _, err := crewGit(cwd, append([]string{"add", "-A", "--", "."}, crewNeverCommitted...)...); err != nil {
		return err
	}
	// Only caches were left: nothing to commit.
	if staged, _ := crewGit(cwd, "diff", "--cached", "--name-only"); staged == "" {
		return nil
	}
	return crewCommit(cwd, message)
}

func crewFailed(err error) error {
	var failure base.HarvestFailure
	if errors.As(err, &failure) {
		return failure
	}
	return base.HarvestFailure{Kind: "error", Reason: crewReason(err)}
}

// mergeMain merges branch into the main branch checked out in path, when it has commits the main branch lacks.
func (p *Projects) mergeMain(path, branch, kept string) (main string, ahead int64, err error) {
	main, err = crewGit(path, "symbolic-ref", "--short", "HEAD")
	if err != nil {
		return "", 0, err
	}
	// A merge that would conflict is not tried: the helper resolves it on its branch first.
	conflicts, err := crewConflictsOf(path, main, branch)
	if err != nil {
		return "", 0, err
	}
	if len(conflicts) > 0 {
		return "", 0, base.HarvestFailure{Kind: "conflict", Base: main, Files: conflicts}
	}
	count, err := crewGit(path, "rev-list", "--count", main+".."+branch)
	if err != nil {
		return "", 0, err
	}
	ahead, _ = strconv.ParseInt(count, 10, 64)
	if ahead > 0 {
		if _, err := crewGit(path, "merge", "--no-edit", branch); err != nil {
			_, _ = crewGit(path, "merge", "--abort")
			return "", 0, fmt.Errorf("合并进 %s 没成功，%s：%s", main, kept, crewReason(err))
		}
	}
	return main, ahead, nil
}

// Harvest takes a helper's work in: commits what it left, merges its branch into the main branch, removes its
// worktree and branch. A HarvestFailure when it cannot.
func (p *Projects) Harvest(place base.Workplace) (base.Harvested, error) {
	defer p.serially(place.Project)()
	if place.Branch == "" {
		return base.Harvested{Text: "它直接在项目里干活，没有要合并的分支"}, nil
	}
	path := filepath.Join(p.root, place.Project)
	// What it did not commit is still its work: commit it rather than lose it.
	if err := crewCommitLeft(place.Cwd, "收获时把没提交的改动一并提交"); err != nil {
		return base.Harvested{}, crewFailed(err)
	}
	main, ahead, err := p.mergeMain(path, place.Branch, place.Branch+" 分支和 worktree 都留着")
	if err != nil {
		return base.Harvested{}, crewFailed(err)
	}
	if _, err := crewGit(path, "worktree", "remove", "--force", place.Cwd); err != nil {
		return base.Harvested{}, crewFailed(err)
	}
	if _, err := crewGit(path, "branch", "-D", place.Branch); err != nil {
		return base.Harvested{}, crewFailed(err)
	}
	if ahead > 0 {
		return base.Harvested{Text: fmt.Sprintf("%d 个提交合进了 %s 的 %s", ahead, place.Project, main), Commits: int(ahead)}, nil
	}
	return base.Harvested{Text: "这一单没有新的提交"}, nil
}

// Release clears a helper's worktree away and keeps its branch, so nothing it did is lost: what was kept, in words.
func (p *Projects) Release(place base.Workplace) string {
	defer p.serially(place.Project)()
	if place.Branch == "" {
		return ""
	}
	path := filepath.Join(p.root, place.Project)
	// A worktree with changes stays where it is: removing it would lose them.
	if !crewGitOk(path, "worktree", "remove", place.Cwd) {
		return fmt.Sprintf("%s 还有没提交的改动，worktree 留在 %s", place.Branch, place.Cwd)
	}
	// A branch with nothing new on it is just clutter; one with commits is kept, so nothing is lost.
	main, err := crewGit(path, "symbolic-ref", "--short", "HEAD")
	if err != nil {
		main = "main"
	}
	ahead := int64(1)
	if count, err := crewGit(path, "rev-list", "--count", main+".."+place.Branch); err == nil {
		ahead, _ = strconv.ParseInt(count, 10, 64)
	}
	if ahead == 0 {
		_, _ = crewGit(path, "branch", "-D", place.Branch)
		return ""
	}
	return fmt.Sprintf("%s 上有 %d 个没合的提交，分支留着，worktree 清掉了", place.Branch, ahead)
}

// OpenBranch makes a new branch at the main branch's tip: a playbook's.
func (p *Projects) OpenBranch(project, branch string) error {
	defer p.serially(project)()
	path, err := p.ensure(project)
	if err != nil {
		return errors.New(crewReason(err))
	}
	if _, err := crewGit(path, "branch", branch, "HEAD"); err != nil {
		return errors.New(crewReason(err))
	}
	return nil
}

// MergeInto merges the helper's branch into target, a branch checked out nowhere (a playbook's), then removes its
// worktree and branch: the short hashes it brought, oldest first. A merge that would conflict is not tried.
func (p *Projects) MergeInto(place base.Workplace, target string) ([]string, error) {
	defer p.serially(place.Project)()
	path := filepath.Join(p.root, place.Project)
	if place.Branch == "" {
		return nil, base.HarvestFailure{Kind: "error", Reason: "它直接在项目里干活，没有分支可合"}
	}
	if err := crewCommitLeft(place.Cwd, "合并前把没提交的改动一并提交"); err != nil {
		return nil, crewFailed(err)
	}
	conflicts, err := crewConflictsOf(path, target, place.Branch)
	if err != nil {
		return nil, crewFailed(err)
	}
	if len(conflicts) > 0 {
		return nil, base.HarvestFailure{Kind: "conflict", Base: target, Files: conflicts}
	}
	out, err := crewGit(path, "log", "--reverse", "--format=%h", target+".."+place.Branch)
	if err != nil {
		return nil, crewFailed(err)
	}
	brought := slices.DeleteFunc(strings.Split(out, "\n"), func(s string) bool { return s == "" })
	if len(brought) > 0 {
		ours, err := crewGit(path, "rev-parse", "refs/heads/"+target)
		if err != nil {
			return nil, crewFailed(err)
		}
		theirs, err := crewGit(path, "rev-parse", place.Branch)
		if err != nil {
			return nil, crewFailed(err)
		}
		// Nothing new on the target since the step branched off: it simply moves up.
		next := theirs
		if !crewGitOk(path, "merge-base", "--is-ancestor", ours, theirs) {
			if next, err = crewMergeCommit(path, ours, theirs, "合并 "+place.Branch); err != nil {
				return nil, crewFailed(err)
			}
		}
		// Only from where it was: a target moved meanwhile is not overwritten.
		if _, err := crewGit(path, "update-ref", "refs/heads/"+target, next, ours); err != nil {
			return nil, crewFailed(err)
		}
	}
	if _, err := crewGit(path, "worktree", "remove", "--force", place.Cwd); err != nil {
		return nil, crewFailed(err)
	}
	if _, err := crewGit(path, "branch", "-D", place.Branch); err != nil {
		return nil, crewFailed(err)
	}
	return brought, nil
}

// HarvestBranch merges branch (a playbook's) into the main branch and deletes it.
func (p *Projects) HarvestBranch(project, branch string) (string, error) {
	defer p.serially(project)()
	path := filepath.Join(p.root, project)
	main, ahead, err := p.mergeMain(path, branch, branch+" 分支留着")
	if err != nil {
		return "", crewFailed(err)
	}
	if _, err := crewGit(path, "branch", "-D", branch); err != nil {
		return "", crewFailed(err)
	}
	if ahead > 0 {
		return fmt.Sprintf("%d 个提交合进了 %s 的 %s", ahead, project, main), nil
	}
	return "计划分支上没有新的提交", nil
}

// Run runs command in a shell in cwd: whether it passed, and the end of what it printed.
func (p *Projects) Run(ctx context.Context, cwd, command string) (bool, string) {
	ctx, cancel := context.WithTimeout(ctx, crewCheckTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	cmd.Dir = cwd
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	err := cmd.Run()
	output := base.TrimEnd(out.String() + errOut.String())
	if base.Units(output) > crewCheckOutput {
		output = "…" + base.Slice(output, -crewCheckOutput, base.Units(output))
	}
	return err == nil, output
}

// HouseRules is the house rules every helper gets: <root>/AGENTS.md, or empty.
func (p *Projects) HouseRules() string {
	body, err := os.ReadFile(filepath.Join(p.root, "AGENTS.md"))
	if err != nil {
		return ""
	}
	return string(body)
}
