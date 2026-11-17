package repo

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var validRepoNamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// ValidateRepoName checks repository directory safety (max 64 chars, no traversal).
func ValidateRepoName(name string) error {
	if !validRepoNamePattern.MatchString(name) || name == "." || name == ".." {
		return fmt.Errorf("%w: %q", ErrInvalidRepoName, name)
	}
	return nil
}

// ValidatePathInside checks that target stays strictly inside root without symlink escape.
func ValidatePathInside(root, target string) error {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return err
	}
	if realRoot, err := filepath.EvalSymlinks(absRoot); err == nil {
		absRoot = realRoot
	}
	if realTarget, err := filepath.EvalSymlinks(absTarget); err == nil {
		absTarget = realTarget
	} else if parentReal, pErr := filepath.EvalSymlinks(filepath.Dir(absTarget)); pErr == nil {
		absTarget = filepath.Join(parentReal, filepath.Base(absTarget))
	}
	rel, err := filepath.Rel(absRoot, absTarget)
	if err != nil {
		return err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("%w: %s outside %s", ErrSymlinkEscape, absTarget, absRoot)
	}
	return nil
}

func runGit(ctx context.Context, dir string, args ...string) (string, string, int, error) {
	fullArgs := make([]string, 0, len(args)+2)
	if dir != "" {
		fullArgs = append(fullArgs, "-C", dir)
	}
	fullArgs = append(fullArgs, args...)

	cmd := exec.CommandContext(ctx, "git", fullArgs...)
	cmd.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"LC_ALL=C",
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitCode()
		} else {
			code = -1
		}
	}
	return strings.TrimSpace(stdout.String()), strings.TrimSpace(stderr.String()), code, err
}

func gitInitWithInitialCommit(ctx context.Context, repoDir, defaultBranch string) error {
	if defaultBranch == "" {
		defaultBranch = "main"
	}
	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		return err
	}
	if _, stderr, _, err := runGit(ctx, repoDir, "init", "-b", defaultBranch); err != nil {
		return fmt.Errorf("git init: %v (%s)", err, stderr)
	}
	_, _, _, err := runGit(ctx, repoDir, "rev-parse", "--verify", "HEAD")
	if err == nil {
		return nil
	}
	if _, stderr, _, err := runGit(ctx, repoDir,
		"-c", "user.name=VibeValley",
		"-c", "user.email=vibevalley@local",
		"commit", "--allow-empty", "-m", "Initial commit",
	); err != nil {
		return fmt.Errorf("git initial commit: %v (%s)", err, stderr)
	}
	return nil
}

func gitHeadSHA(ctx context.Context, dir string) (string, error) {
	out, stderr, _, err := runGit(ctx, dir, "rev-parse", "HEAD")
	if err != nil {
		return "", fmt.Errorf("git rev-parse HEAD: %v (%s)", err, stderr)
	}
	return out, nil
}

func gitBranchExists(ctx context.Context, repoDir, branch string) bool {
	_, _, code, err := runGit(ctx, repoDir, "show-ref", "--verify", "--quiet", "refs/heads/"+branch)
	return err == nil && code == 0
}

func gitStatusClean(ctx context.Context, dir string) (WorktreeCleanStatus, error) {
	out, stderr, _, err := runGit(ctx, dir, "status", "--porcelain")
	if err != nil {
		return WorktreeCleanStatus{}, fmt.Errorf("git status: %v (%s)", err, stderr)
	}
	sha, _ := gitHeadSHA(ctx, dir)
	if strings.TrimSpace(out) == "" {
		return WorktreeCleanStatus{Clean: true, HeadSHA: sha}, nil
	}
	lines := strings.Split(out, "\n")
	changed := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimRight(line, "\r")
		if len(line) > 3 {
			changed = append(changed, strings.TrimSpace(line[3:]))
		} else if strings.TrimSpace(line) != "" {
			changed = append(changed, strings.TrimSpace(line))
		}
	}
	return WorktreeCleanStatus{
		Clean:        false,
		ChangedFiles: changed,
		HeadSHA:      sha,
	}, nil
}

func gitMergeTreeCheck(ctx context.Context, repoDir, baseBranch, branch string) (ConflictCheckResult, error) {
	stdout, stderr, code, err := runGit(ctx, repoDir, "merge-tree", "--write-tree", baseBranch, branch)
	if err == nil && code == 0 {
		treeSHA := ""
		if lines := strings.Split(stdout, "\n"); len(lines) > 0 {
			treeSHA = strings.TrimSpace(lines[0])
		}
		return ConflictCheckResult{
			HasConflict: false,
			TreeSHA:     treeSHA,
		}, nil
	}
	if code == 1 {
		var conflicts []string
		combined := stdout + "\n" + stderr
		for line := range strings.SplitSeq(combined, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "CONFLICT") {
				conflicts = append(conflicts, line)
			}
		}
		if len(conflicts) == 0 && strings.TrimSpace(combined) != "" {
			conflicts = append(conflicts, strings.TrimSpace(combined))
		}
		return ConflictCheckResult{
			HasConflict:   true,
			ConflictFiles: conflicts,
		}, nil
	}
	return ConflictCheckResult{}, fmt.Errorf("git merge-tree: %v (%s)", err, stderr)
}
