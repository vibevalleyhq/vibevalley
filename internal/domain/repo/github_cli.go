package repo

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const defaultGHTimeout = 15 * time.Second

var (
	ghVersionRe = regexp.MustCompile(`(?m)gh version ([0-9]+\.[0-9]+\.[0-9]+)`)
	ghAccountRe = regexp.MustCompile(`(?i)Logged in to [^\s]+ (?:account|as) ([A-Za-z0-9_.-]+)`)
	ghPRURLRe   = regexp.MustCompile(`https?://[^\s]+/pull/([0-9]+)`)
)

// GitHubCLIStatus describes local `gh` installation and authentication state.
type GitHubCLIStatus struct {
	Installed bool   `json:"installed"`
	Version   string `json:"version,omitempty"`
	LoggedIn  bool   `json:"loggedIn"`
	Account   string `json:"account,omitempty"`
	Reason    string `json:"reason"`
	CheckedAt int64  `json:"checkedAt"`
}

// PRRequest configures Pull Request creation (or dry-run preview) via `git` and `gh`.
type PRRequest struct {
	RepoPath string `json:"repoPath"`
	WorkDir  string `json:"workDir,omitempty"`
	Branch   string `json:"branch,omitempty"`
	Base     string `json:"base,omitempty"`
	Title    string `json:"title"`
	Body     string `json:"body,omitempty"`
	Remote   string `json:"remote,omitempty"`
	Draft    bool   `json:"draft,omitempty"`
	DryRun   bool   `json:"dryRun,omitempty"`
}

// PRResult reports the preview or created Pull Request output.
type PRResult struct {
	DryRun       bool     `json:"dryRun"`
	Branch       string   `json:"branch"`
	Base         string   `json:"base"`
	HeadSHA      string   `json:"headSha,omitempty"`
	CommitsAhead int      `json:"commitsAhead"`
	DiffStat     string   `json:"diffStat,omitempty"`
	PlannedArgs  []string `json:"plannedArgs,omitempty"`
	Pushed       bool     `json:"pushed"`
	URL          string   `json:"url,omitempty"`
	Number       int      `json:"number,omitempty"`
	Output       string   `json:"output,omitempty"`
}

// ProbeGitHubCLI inspects `gh --version` and `gh auth status`, returning a structured status
// without crashing when `gh` is missing or unauthenticated.
func ProbeGitHubCLI(ctx context.Context, workDir string) GitHubCLIStatus {
	nowMs := time.Now().UnixMilli()
	out := GitHubCLIStatus{
		Installed: false,
		LoggedIn:  false,
		Reason:    "gh CLI not installed",
		CheckedAt: nowMs,
	}

	verOut, verOK, verMissing := runGHCommand(ctx, workDir, "--version")
	if verMissing {
		return out
	}
	if !verOK {
		out.Installed = true
		out.Reason = "gh --version failed"
		return out
	}

	out.Installed = true
	if m := ghVersionRe.FindStringSubmatch(verOut); len(m) == 2 {
		out.Version = m[1]
	}

	authOut, authOK, _ := runGHCommand(ctx, workDir, "auth", "status", "--hostname", "github.com")
	if !authOK {
		out.Reason = summarizeGHReason(authOut, "not logged in")
		return out
	}
	if m := ghAccountRe.FindStringSubmatch(authOut); len(m) == 2 {
		out.LoggedIn = true
		out.Account = m[1]
		out.Reason = ""
		return out
	}
	out.Reason = summarizeGHReason(authOut, "no logged-in GitHub account detected")
	return out
}

// SubmitPullRequest computes PR metadata and either returns a DryRun preview (`DryRun: true`)
// or pushes the branch (`git push -u origin HEAD`) and invokes `gh pr create` (`DryRun: false`).
func SubmitPullRequest(ctx context.Context, req PRRequest) (PRResult, error) {
	if err := ctx.Err(); err != nil {
		return PRResult{}, err
	}
	dirInput := strings.TrimSpace(req.RepoPath)
	if dirInput == "" {
		dirInput = strings.TrimSpace(req.WorkDir)
	}
	dir, err := ensureDir(dirInput)
	if err != nil {
		return PRResult{}, err
	}

	remote := strings.TrimSpace(req.Remote)
	if remote == "" {
		remote = "origin"
	}

	branch := strings.TrimSpace(req.Branch)
	if branch == "" {
		cur, stderr, _, bErr := runGit(ctx, dir, "rev-parse", "--abbrev-ref", "HEAD")
		if bErr != nil || cur == "" || cur == "HEAD" {
			return PRResult{}, fmt.Errorf("%w: unable to determine current branch (%s)", ErrInvalidArgument, stderr)
		}
		branch = cur
	}
	if strings.HasPrefix(branch, "-") {
		return PRResult{}, fmt.Errorf("%w: invalid branch %q", ErrInvalidArgument, branch)
	}

	base := strings.TrimSpace(req.Base)
	if base == "" {
		switch {
		case gitBranchExists(ctx, dir, "main"):
			base = "main"
		case gitBranchExists(ctx, dir, "master"):
			base = "master"
		default:
			base = "main"
		}
	}
	if strings.HasPrefix(base, "-") {
		return PRResult{}, fmt.Errorf("%w: invalid base branch %q", ErrInvalidArgument, base)
	}

	title := strings.TrimSpace(req.Title)
	if !req.DryRun && title == "" {
		return PRResult{}, fmt.Errorf("%w: pull request title is required", ErrInvalidArgument)
	}
	if title == "" {
		if subj, _, sCode, _ := runGit(ctx, dir, "log", "-1", "--format=%s"); sCode == 0 && subj != "" {
			title = subj
		} else {
			title = branch
		}
	}

	headSHA, _ := gitHeadSHA(ctx, dir)
	compareBase := resolveCompareBaseRef(ctx, dir, remote, base)

	commitsAhead := 0
	var diffStat string
	if compareBase != "" {
		if countOut, _, cCode, _ := runGit(ctx, dir, "rev-list", "--count", compareBase+".."+branch); cCode == 0 {
			if n, convErr := strconv.Atoi(strings.TrimSpace(countOut)); convErr == nil {
				commitsAhead = n
			}
		}
		if statOut, _, dCode, _ := runGit(ctx, dir, "diff", "--stat", compareBase+"..."+branch); dCode == 0 {
			diffStat = statOut
		} else if statOut, _, dCode, _ := runGit(ctx, dir, "diff", "--stat", compareBase+".."+branch); dCode == 0 {
			diffStat = statOut
		}
	}

	plannedArgs := []string{
		"pr", "create",
		"--head", branch,
		"--base", base,
		"--title", title,
		"--body", req.Body,
	}
	if req.Draft {
		plannedArgs = append(plannedArgs, "--draft")
	}

	if req.DryRun {
		return PRResult{
			DryRun:       true,
			Branch:       branch,
			Base:         base,
			HeadSHA:      headSHA,
			CommitsAhead: commitsAhead,
			DiffStat:     diffStat,
			PlannedArgs:  plannedArgs,
			Pushed:       false,
		}, nil
	}

	if _, stderr, _, pushErr := runGit(ctx, dir, "push", "-u", remote, "HEAD"); pushErr != nil {
		return PRResult{}, fmt.Errorf("git push -u %s HEAD: %v (%s)", remote, pushErr, stderr)
	}

	out, ok, missing := runGHCommand(ctx, dir, plannedArgs...)
	trimmedOut := strings.TrimSpace(out)
	if missing {
		return PRResult{
			DryRun:       false,
			Branch:       branch,
			Base:         base,
			HeadSHA:      headSHA,
			CommitsAhead: commitsAhead,
			DiffStat:     diffStat,
			PlannedArgs:  plannedArgs,
			Pushed:       true,
			Output:       trimmedOut,
		}, errors.New("gh CLI not installed")
	}
	if !ok {
		return PRResult{
			DryRun:       false,
			Branch:       branch,
			Base:         base,
			HeadSHA:      headSHA,
			CommitsAhead: commitsAhead,
			DiffStat:     diffStat,
			PlannedArgs:  plannedArgs,
			Pushed:       true,
			Output:       trimmedOut,
		}, fmt.Errorf("gh pr create failed: %s", trimmedOut)
	}

	prURL, prNum := parsePRCreateOutput(trimmedOut)
	return PRResult{
		DryRun:       false,
		Branch:       branch,
		Base:         base,
		HeadSHA:      headSHA,
		CommitsAhead: commitsAhead,
		DiffStat:     diffStat,
		PlannedArgs:  plannedArgs,
		Pushed:       true,
		URL:          prURL,
		Number:       prNum,
		Output:       trimmedOut,
	}, nil
}

func resolveCompareBaseRef(ctx context.Context, dir, remote, base string) string {
	if gitBranchExists(ctx, dir, base) {
		return base
	}
	remoteRef := remote + "/" + base
	if _, _, code, err := runGit(ctx, dir, "show-ref", "--verify", "--quiet", "refs/remotes/"+remoteRef); err == nil && code == 0 {
		return remoteRef
	}
	return ""
}

func parsePRCreateOutput(out string) (string, int) {
	if m := ghPRURLRe.FindStringSubmatch(out); len(m) == 2 {
		num, _ := strconv.Atoi(m[1])
		return m[0], num
	}
	for line := range strings.SplitSeq(out, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "https://") || strings.HasPrefix(trimmed, "http://") {
			idx := strings.LastIndex(trimmed, "/")
			if idx >= 0 && idx+1 < len(trimmed) {
				if num, err := strconv.Atoi(trimmed[idx+1:]); err == nil {
					return trimmed, num
				}
			}
			return trimmed, 0
		}
	}
	return "", 0
}

func runGHCommand(ctx context.Context, workDir string, args ...string) (combined string, ok bool, missing bool) {
	if ctx == nil {
		ctx = context.Background()
	}
	runCtx := ctx
	var cancel context.CancelFunc
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		runCtx, cancel = context.WithTimeout(ctx, defaultGHTimeout)
		defer cancel()
	}

	cmd := exec.CommandContext(runCtx, "gh", args...)
	if strings.TrimSpace(workDir) != "" {
		cmd.Dir = workDir
	}
	cmd.Env = append(os.Environ(),
		"GH_HOST=github.com",
		"GH_PROMPT_DISABLED=1",
		"LC_ALL=C",
	)
	var outBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &outBuf
	err := cmd.Run()
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return "", false, true
		}
		var pathErr *os.PathError
		if errors.As(err, &pathErr) && errors.Is(pathErr.Err, os.ErrNotExist) {
			return "", false, true
		}
		return outBuf.String(), false, false
	}
	return outBuf.String(), true, false
}

func summarizeGHReason(raw, fallback string) string {
	for line := range strings.SplitSeq(raw, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			if len(trimmed) > 200 {
				return trimmed[:200]
			}
			return trimmed
		}
	}
	return fallback
}
