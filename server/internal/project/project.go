package project

import (
	"bytes"
	"cmp"
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
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

// A harvest that would conflict is not attempted: the session is asked to merge the main branch in and resolve it. Merging into a task's branch
// never checks it out: merge-tree writes the tree, commit-tree and update-ref put it on the branch.

const (
	// The end of a check's output is kept: a test run's verdict is there.
	checkTimeout = 10 * time.Minute
	checkOutput  = 3000
	patchLines   = 400
	patchesMax   = 400_000
	cloneTimeout = 3 * time.Minute
)

var projectName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)

var githubURL = regexp.MustCompile(`^https://github\.com/([A-Za-z0-9-]+)/([A-Za-z0-9_.-]+)/?$`)

// Only repository home URLs: never credentials, other git transports or command-line options.
func githubRepository(input string) (name, url string, ok bool) {
	m := githubURL.FindStringSubmatch(str.Trim(input))
	if m == nil {
		return "", "", false
	}
	name = strings.TrimSuffix(m[2], ".git")
	if name == "" || name == "." || name == ".." {
		return "", "", false
	}
	return name, "https://github.com/" + m[1] + "/" + name + ".git", true
}

// What Create would refuse first, for a page that asks as it is filled in.
func (p *Service) Check(req protocol.NewProject) protocol.ProjectCheck {
	return protocol.ProjectCheck{Problem: projectProblem(req)}
}

func projectProblem(req protocol.NewProject) string {
	if !projectName.MatchString(req.Name) {
		return "项目名用字母或数字开头，只含字母、数字、-、_、.，最多 64 个字符"
	}
	if req.Github != nil {
		if _, _, ok := githubRepository(*req.Github); !ok {
			return "请填公开 GitHub 仓库地址，例如 https://github.com/botiverse/raft-source"
		}
	}
	return ""
}

// gitignore is what a fresh repository ignores, so a first commit of an existing folder does not take its dependencies.
const gitignore = "node_modules/\ndist/\nbuild/\n.env\n.env.*\n!.env.example\n.DS_Store\n__pycache__/\n*.pyc\n.pytest_cache/\n.venv/\n"

// neverCommitted is what a session's left-over changes are committed without, whatever the project ignores: caches
// and installed packages a run leaves behind (pathspecs for git add).
var neverCommitted = []string{":(exclude,glob)**/__pycache__/**", ":(exclude,glob)**/*.pyc", ":(exclude,glob)**/.pytest_cache/**", ":(exclude,glob)**/node_modules/**", ":(exclude,glob)**/.DS_Store"}

type gitError struct {
	Code   int
	Stderr string
	Err    error
}

func (e *gitError) Error() string {
	if s := strings.TrimSpace(e.Stderr); s != "" {
		return s
	}
	return e.Err.Error()
}

func gitRun(ctx context.Context, cwd string, args ...string) (stdout string, code int, err error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = cwd
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	runErr := cmd.Run()
	var exit *exec.ExitError
	if errors.As(runErr, &exit) {
		return out.String(), exit.ExitCode(), &gitError{Code: exit.ExitCode(), Stderr: errOut.String(), Err: runErr}
	}
	if runErr != nil {
		return "", -1, runErr
	}
	return out.String(), 0, nil
}

func git(cwd string, args ...string) (string, error) {
	out, _, err := gitRun(context.Background(), cwd, args...)
	return strings.TrimSpace(out), err
}

func gitOk(cwd string, args ...string) bool {
	_, err := git(cwd, args...)
	return err == nil
}

// As vibevalley when the machine has no git user.
func commit(cwd, message string) error {
	if _, err := git(cwd, "commit", "-q", "-m", message); err == nil {
		return nil
	}
	_, err := git(cwd, "-c", "user.name=vibevalley", "-c", "user.email=vibevalley@localhost", "commit", "-q", "-m", message)
	return err
}

func mergeCommit(path, ours, theirs, message string) (string, error) {
	out, err := git(path, "merge-tree", "--write-tree", "--no-messages", ours, theirs)
	if err != nil {
		return "", err
	}
	tree, _, _ := strings.Cut(out, "\n")
	args := []string{"commit-tree", tree, "-p", ours, "-p", theirs, "-m", message}
	if hash, err := git(path, args...); err == nil {
		return hash, nil
	}
	return git(path, append([]string{"-c", "user.name=vibevalley", "-c", "user.email=vibevalley@localhost"}, args...)...)
}

func conflictsOf(path, baseBranch, branch string) ([]string, error) {
	out, code, err := gitRun(context.Background(), path, "merge-tree", "--write-tree", "--name-only", "--no-messages", baseBranch, branch)
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

func reason(err error) string {
	for _, line := range strings.Split(err.Error(), "\n") {
		if strings.TrimSpace(line) != "" {
			return line
		}
	}
	return err.Error()
}

type Service struct {
	root  string
	trees string
	// More than a few sessions in one project start changing the same files.
	perProject int

	tokei string

	mu      sync.Mutex
	queues  map[string]*sync.Mutex
	pending map[string]bool
}

func newService(cfg base.Config) (*Service, error) {
	root, err := filepath.Abs(cfg.WorkRoot)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	tokei := cmp.Or(cfg.Tokei, "tokei")
	return &Service{
		root: root, trees: filepath.Join(root, ".worktrees"), perProject: cfg.Project.MaxSessions, tokei: tokei,
		queues: map[string]*sync.Mutex{}, pending: map[string]bool{},
	}, nil
}

func (p *Service) Limit() int { return p.perProject }

func (p *Service) Slots() int64 {
	if p.perProject <= 0 || p.perProject > protocol.MaxRunning {
		return protocol.MaxRunning
	}
	return int64(p.perProject)
}

func (*Service) OnStart(context.Context) error { return nil }
func (*Service) OnStop()                       {}

func (p *Service) Root() string { return p.root }

// Two sessions sent to a new project at once must not both run git init, and two harvests must not merge into the same branch together.
func (p *Service) serially(project string) func() {
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

func (p *Service) ensure(name string) (string, error) {
	if !projectName.MatchString(name) {
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
	root, err := filepath.EvalSymlinks(p.root)
	if err != nil {
		return "", err
	}
	if filepath.Dir(path) != root {
		return "", errors.New("项目必须在工作目录里面，不能链接到外面")
	}
	top, _ := git(path, "rev-parse", "--show-toplevel")
	switch {
	case top != path:
		if _, err := git(path, "init", "-q", "-b", "main"); err != nil {
			return "", err
		}
		if _, err := os.Stat(filepath.Join(path, ".gitignore")); err != nil {
			if err := os.WriteFile(filepath.Join(path, ".gitignore"), []byte(gitignore), 0o644); err != nil {
				return "", err
			}
		}
		entries, _ := os.ReadDir(path)
		if len(slices.DeleteFunc(entries, func(e os.DirEntry) bool { return e.Name() == ".git" })) <= 1 {
			if err := os.WriteFile(filepath.Join(path, "README.md"), []byte("# "+name+"\n"), 0o644); err != nil {
				return "", err
			}
		}
		if _, err := git(path, "add", "-A"); err != nil {
			return "", err
		}
		if err := commit(path, "初始提交（VibeValley 建的项目）"); err != nil {
			return "", err
		}
	case !gitOk(path, "rev-parse", "--verify", "HEAD"):
		if _, err := git(path, "commit", "-q", "--allow-empty", "-m", "初始提交"); err != nil {
			if err := commit(path, "初始提交"); err != nil {
				return "", err
			}
		}
	}
	return path, nil
}

func (p *Service) Create(req protocol.NewProject) (Project, error) {
	defer p.serially(req.Name)()
	if problem := projectProblem(req); problem != "" {
		return Project{}, errors.New(problem)
	}
	path := filepath.Join(p.root, req.Name)
	// Exclusive creation also refuses existing empty folders and symlinks.
	if err := os.Mkdir(path, 0o755); err != nil {
		if errors.Is(err, os.ErrExist) {
			return Project{}, fmt.Errorf("「%s」已经存在，请换个项目名", req.Name)
		}
		return Project{}, errors.New(reason(err))
	}
	p.mu.Lock()
	p.pending[req.Name] = true
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		delete(p.pending, req.Name)
		p.mu.Unlock()
	}()
	fail := func(err error) (Project, error) {
		_ = os.RemoveAll(path)
		return Project{}, err
	}
	if req.Github != nil {
		_, url, _ := githubRepository(*req.Github)
		ctx, cancel := context.WithTimeout(context.Background(), cloneTimeout)
		defer cancel()
		cmd := exec.CommandContext(ctx, "git", "-c", "credential.helper=", "-c", "core.askPass=", "clone", "--", url, path)
		cmd.Dir = p.root
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_LFS_SKIP_SMUDGE=1")
		if err := cmd.Run(); err != nil {
			return fail(errors.New("下载失败：请确认仓库公开、地址正确且网络可用；超过 3 分钟会停止，可重试"))
		}
	} else if _, err := p.ensure(req.Name); err != nil {
		return fail(errors.New(reason(err)))
	}
	return Project{Name: req.Name, Path: path, Git: true}, nil
}

func (p *Service) List() []Project {
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
	var out []Project
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") || pending[e.Name()] {
			continue
		}
		path, err := filepath.EvalSymlinks(filepath.Join(p.root, e.Name()))
		if err != nil {
			continue
		}
		top, _ := git(path, "rev-parse", "--show-toplevel")
		out = append(out, Project{Name: e.Name(), Path: path, Git: top == path})
	}
	return out
}

func (p *Service) Workplace(project, session string, worktree bool, baseBranch string) (Workplace, error) {
	defer p.serially(project)()
	path, err := p.ensure(project)
	if err != nil {
		return Workplace{}, errors.New(reason(err))
	}
	if !worktree {
		return Workplace{Project: project, Cwd: path}, nil
	}
	stamp := strconv.FormatInt(clock.NowMs(), 36)
	branch := "vibevalley/" + session + "-" + stamp
	cwd := filepath.Join(p.trees, project+"-"+session+"-"+stamp)
	if err := os.MkdirAll(p.trees, 0o755); err != nil {
		return Workplace{}, err
	}
	if baseBranch == "" {
		baseBranch = "HEAD"
	}
	if _, err := git(path, "worktree", "add", "-q", "-b", branch, cwd, baseBranch); err != nil {
		return Workplace{}, errors.New(reason(err))
	}
	return Workplace{Project: project, Cwd: cwd, Branch: branch}, nil
}

func (p *Service) describe(project, cwd, branch string) (protocol.Changes, error) {
	path := filepath.Join(p.root, project)
	baseBranch, err := git(path, "symbolic-ref", "--short", "HEAD")
	if err != nil {
		return protocol.Changes{}, errors.New(reason(err))
	}
	uncommitted := []protocol.UncommittedItem{}
	if cwd != "" {
		status, _, _ := gitRun(context.Background(), cwd, "status", "--porcelain=v1", "-uall")
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
	logOut, err := git(path, "log", "--format=%h%x09%ct%x09%s", baseBranch+".."+branch)
	if err != nil {
		return protocol.Changes{}, errors.New(reason(err))
	}
	names, err := git(path, "diff", "--no-renames", "--name-status", rng)
	if err != nil {
		return protocol.Changes{}, errors.New(reason(err))
	}
	numbers, _ := git(path, "diff", "--no-renames", "--numstat", rng)
	patch, _, _ := gitRun(context.Background(), path, "diff", "--no-renames", "--no-color", rng)
	patch = strings.TrimSpace(patch)
	conflicts, err := conflictsOf(path, baseBranch, branch)
	if err != nil {
		return protocol.Changes{}, errors.New(reason(err))
	}
	behind, _ := git(path, "rev-list", "--count", branch+".."+baseBranch)

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
	var chunks []string
	if patch != "" {
		for i, c := range strings.Split(patch, "\ndiff --git ") {
			if i > 0 {
				c = "diff --git " + c
			}
			chunks = append(chunks, c)
		}
	}
	budget := patchesMax
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
				if len(lines) > patchLines {
					chunk = strings.Join(lines[:patchLines], "\n") + fmt.Sprintf("\n… 还有 %d 行没显示", len(lines)-patchLines)
				}
				if units := str.Units(chunk); units <= budget {
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

// Read-only.
func (p *Service) Changes(place Workplace) (protocol.Changes, error) {
	return p.describe(place.Project, place.Cwd, place.Branch)
}

// A renamed file counts under both its names.
func (p *Service) ChangedFiles(cwd, baseBranch string) ([]string, error) {
	fork, err := git(cwd, "merge-base", baseBranch, "HEAD")
	if err != nil {
		return nil, err
	}
	changed, err := git(cwd, "diff", "--name-only", "--no-renames", fork)
	if err != nil {
		return nil, err
	}
	added, err := git(cwd, "ls-files", "--others", "--exclude-standard")
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

func (p *Service) BranchChanges(project, branch string) (protocol.Changes, error) {
	return p.describe(project, "", branch)
}

func (p *Service) Conflict(place Workplace, baseBranch string) *protocol.Conflict {
	if place.Branch == "" {
		return nil
	}
	path := filepath.Join(p.root, place.Project)
	if baseBranch == "" {
		baseBranch, _ = git(path, "symbolic-ref", "--short", "HEAD")
	}
	if baseBranch == "" {
		return nil
	}
	files, err := conflictsOf(path, baseBranch, place.Branch)
	if err != nil || len(files) == 0 {
		return nil
	}
	return &protocol.Conflict{Base: baseBranch, Files: files}
}

func commitLeft(cwd, message string) error {
	if status, _ := git(cwd, "status", "--porcelain"); status == "" {
		return nil
	}
	if _, err := git(cwd, append([]string{"add", "-A", "--", "."}, neverCommitted...)...); err != nil {
		return err
	}
	if staged, _ := git(cwd, "diff", "--cached", "--name-only"); staged == "" {
		return nil
	}
	return commit(cwd, message)
}

func failed(err error) error {
	var failure MergeFailure
	if errors.As(err, &failure) {
		return failure
	}
	return MergeFailure{Kind: "error", Reason: reason(err)}
}

func (p *Service) mergeMain(path, branch, kept string) (main string, ahead int64, err error) {
	main, err = git(path, "symbolic-ref", "--short", "HEAD")
	if err != nil {
		return "", 0, err
	}
	// A merge that would conflict is not tried: the session resolves it on its branch first.
	conflicts, err := conflictsOf(path, main, branch)
	if err != nil {
		return "", 0, err
	}
	if len(conflicts) > 0 {
		return "", 0, MergeFailure{Kind: "conflict", Base: main, Files: conflicts}
	}
	count, err := git(path, "rev-list", "--count", main+".."+branch)
	if err != nil {
		return "", 0, err
	}
	ahead, _ = strconv.ParseInt(count, 10, 64)
	if ahead > 0 {
		if _, err := git(path, "merge", "--no-edit", branch); err != nil {
			if _, abort := git(path, "merge", "--abort"); abort != nil {
				return "", 0, fmt.Errorf("合并进 %s 没成功，%s：%s；退出合并也没成功（%s），%s 停在合并到一半，要手动收拾", main, kept, reason(err), reason(abort), main)
			}
			return "", 0, fmt.Errorf("合并进 %s 没成功，%s：%s", main, kept, reason(err))
		}
	}
	return main, ahead, nil
}

func (p *Service) Merge(place Workplace) (Merged, error) {
	defer p.serially(place.Project)()
	if place.Branch == "" {
		return Merged{Text: "它直接在项目里干活，没有要合并的分支"}, nil
	}
	path := filepath.Join(p.root, place.Project)
	// What it did not commit is still its work: commit it rather than lose it.
	if err := commitLeft(place.Cwd, "收获时把没提交的改动一并提交"); err != nil {
		return Merged{}, failed(err)
	}
	main, ahead, err := p.mergeMain(path, place.Branch, place.Branch+" 分支和 worktree 都留着")
	if err != nil {
		return Merged{}, failed(err)
	}
	merged := Merged{Text: "这一单没有新的提交", Commits: int(ahead), Warning: cleanupMerged(place, path)}
	if ahead > 0 {
		merged.Text = fmt.Sprintf("%d 个提交合进了 %s 的 %s", ahead, place.Project, main)
	}
	return merged, nil
}

// Cleanup cannot undo publication. Its warning must travel with the successful receipt, not replace it with a failure.
func cleanupMerged(place Workplace, path string) string {
	if _, err := git(path, "worktree", "remove", "--force", place.Cwd); err != nil {
		return fmt.Sprintf("改动已合并，worktree %s 和分支 %s 尚未清理：%s", place.Cwd, place.Branch, reason(err))
	}
	if _, err := git(path, "branch", "-D", place.Branch); err != nil {
		return fmt.Sprintf("改动已合并，分支 %s 尚未清理：%s", place.Branch, reason(err))
	}
	return ""
}

func (p *Service) Release(place Workplace) string {
	defer p.serially(place.Project)()
	if place.Branch == "" {
		return ""
	}
	path := filepath.Join(p.root, place.Project)
	// A worktree with changes stays where it is: removing it would lose them.
	if !gitOk(path, "worktree", "remove", place.Cwd) {
		return fmt.Sprintf("%s 还有没提交的改动，worktree 留在 %s", place.Branch, place.Cwd)
	}
	// A branch with nothing new on it is just clutter; one with commits is kept, so nothing is lost.
	main, err := git(path, "symbolic-ref", "--short", "HEAD")
	if err != nil {
		main = "main"
	}
	ahead := int64(1)
	if count, err := git(path, "rev-list", "--count", main+".."+place.Branch); err == nil {
		ahead, _ = strconv.ParseInt(count, 10, 64)
	}
	if ahead == 0 {
		_, _ = git(path, "branch", "-D", place.Branch)
		return ""
	}
	return fmt.Sprintf("%s 上有 %d 个没合的提交，分支留着，worktree 清掉了", place.Branch, ahead)
}

func (p *Service) OpenBranch(project, branch string) error {
	defer p.serially(project)()
	path, err := p.ensure(project)
	if err != nil {
		return errors.New(reason(err))
	}
	if _, err := git(path, "branch", branch, "HEAD"); err != nil {
		return errors.New(reason(err))
	}
	return nil
}

func (p *Service) MergeInto(place Workplace, target string) (Merged, error) {
	defer p.serially(place.Project)()
	path := filepath.Join(p.root, place.Project)
	if place.Branch == "" {
		return Merged{}, MergeFailure{Kind: "error", Reason: "它直接在项目里干活，没有分支可合"}
	}
	if err := commitLeft(place.Cwd, "合并前把没提交的改动一并提交"); err != nil {
		return Merged{}, failed(err)
	}
	conflicts, err := conflictsOf(path, target, place.Branch)
	if err != nil {
		return Merged{}, failed(err)
	}
	if len(conflicts) > 0 {
		return Merged{}, MergeFailure{Kind: "conflict", Base: target, Files: conflicts}
	}
	out, err := git(path, "log", "--reverse", "--format=%h", target+".."+place.Branch)
	if err != nil {
		return Merged{}, failed(err)
	}
	brought := slices.DeleteFunc(strings.Split(out, "\n"), func(s string) bool { return s == "" })
	if len(brought) > 0 {
		ours, err := git(path, "rev-parse", "refs/heads/"+target)
		if err != nil {
			return Merged{}, failed(err)
		}
		theirs, err := git(path, "rev-parse", place.Branch)
		if err != nil {
			return Merged{}, failed(err)
		}
		next := theirs
		if !gitOk(path, "merge-base", "--is-ancestor", ours, theirs) {
			if next, err = mergeCommit(path, ours, theirs, "合并 "+place.Branch); err != nil {
				return Merged{}, failed(err)
			}
		}
		// Only from where it was: a target moved meanwhile is not overwritten.
		if _, err := git(path, "update-ref", "refs/heads/"+target, next, ours); err != nil {
			return Merged{}, failed(err)
		}
	}
	return Merged{Commits: len(brought), Hashes: brought, Warning: cleanupMerged(place, path)}, nil
}

func (p *Service) MergeBranch(project, branch string) (string, error) {
	defer p.serially(project)()
	path := filepath.Join(p.root, project)
	main, ahead, err := p.mergeMain(path, branch, branch+" 分支留着")
	if err != nil {
		return "", failed(err)
	}
	said := "计划分支上没有新的提交"
	if ahead > 0 {
		said = fmt.Sprintf("%d 个提交合进了 %s 的 %s", ahead, project, main)
	}
	if _, err := git(path, "branch", "-D", branch); err != nil {
		said += fmt.Sprintf("；改动已合并，分支 %s 尚未清理：%s", branch, reason(err))
	}
	return said, nil
}

func (p *Service) Run(ctx context.Context, cwd, command string) (bool, string) {
	ctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	cmd.Dir = cwd
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	err := cmd.Run()
	output := str.TrimEnd(out.String() + errOut.String())
	if str.Units(output) > checkOutput {
		output = "…" + str.Slice(output, -checkOutput, str.Units(output))
	}
	return err == nil, output
}

func (p *Service) HouseRules() string {
	body, err := os.ReadFile(filepath.Join(p.root, "AGENTS.md"))
	if err != nil {
		return ""
	}
	return string(body)
}
