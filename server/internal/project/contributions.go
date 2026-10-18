package project

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"vibevalley/internal/protocol"
)

const repoDepth = 3

var skipDirs = map[string]bool{"node_modules": true, ".git": true, ".venv": true, "vendor": true, "dist": true, "build": true, "target": true, ".next": true}

func repoDirs(root string, depth int) []string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	for _, e := range entries {
		if e.Name() == ".git" {
			return []string{root}
		}
	}
	if depth == 0 {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() && !skipDirs[e.Name()] {
			out = append(out, repoDirs(filepath.Join(root, e.Name()), depth-1)...)
		}
	}
	return out
}

// Contributions observes author commits once per repository, including its worktree branches.
func (p *Service) Contributions(ctx context.Context, extra []string) []protocol.Repo {
	global := strings.ToLower(gitQuiet("", "config", "--global", "user.email"))
	seen := map[string]bool{}
	out := []protocol.Repo{}
	for _, dir := range repoDirs(p.root, repoDepth) {
		if ctx.Err() != nil {
			break
		}
		// Worktrees share their repository's history: one count per repository.
		common := gitQuiet("", "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
		if common == "" || seen[common] {
			continue
		}
		seen[common] = true
		mine := map[string]bool{}
		for _, e := range append([]string{global, strings.ToLower(gitQuiet("", "-C", dir, "config", "user.email"))}, extra...) {
			if e != "" {
				mine[e] = true
			}
		}
		n := int64(0)
		for _, email := range strings.Split(gitQuiet("", "-C", dir, "log", "--all", "--format=%ae"), "\n") {
			if email != "" && mine[strings.ToLower(email)] {
				n++
			}
		}
		top := gitQuiet("", "-C", dir, "rev-parse", "--show-toplevel")
		if top == "" {
			top = dir
		}
		out = append(out, protocol.Repo{Path: top, Commits: n})
	}
	return out
}
