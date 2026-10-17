package game

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/core"
	"vibevalley/internal/project"
	"vibevalley/internal/protocol"
)

// A repository with several worktrees counts once. "Yours" is by author email (git's global and each repository's user.email, and
// git_emails in the configuration); sessions commit as you, so their commits count.

const (
	repoDepth     = 3
	countEvery    = 2 * time.Minute
	countAfterRun = 15 * time.Second
)

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

type commits struct {
	cfg   base.Config
	core  *core.Service
	extra []string

	counting sync.Mutex
	mu       sync.Mutex
	pending  *time.Timer
	closed   bool
	stop     func()
	asked    int
}

func newCommits(cfg base.Config, core *core.Service) (*commits, error) {
	c := &commits{cfg: cfg, core: core}
	for _, e := range cfg.GitEmails {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			c.extra = append(c.extra, e)
		}
	}
	return c, nil
}

func (c *commits) OnStart(ctx context.Context) error {
	events, stop := c.core.Facts()
	c.mu.Lock()
	c.stop = stop
	c.mu.Unlock()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case e, ok := <-events:
				if !ok {
					return
				}
				if _, ended := e.Value.(protocol.FactReport); ended {
					c.Soon()
				}
			}
		}
	}()
	return nil
}

func (c *commits) OnReady(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(countEvery)
		defer ticker.Stop()
		for {
			c.refresh(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

func (c *commits) OnStop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	if c.pending != nil {
		c.pending.Stop()
	}
	if c.stop != nil {
		c.stop()
	}
}

// The ticker and a run's end both count: one at a time, so an older count never lands after a newer one.
func (c *commits) refresh(ctx context.Context) {
	c.counting.Lock()
	defer c.counting.Unlock()
	count := c.Count(ctx)
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if !closed && ctx.Err() == nil {
		c.core.SetCommits(count)
	}
}

func (c *commits) Count(ctx context.Context) protocol.CommitCount {
	global := strings.ToLower(project.GitQuiet("", "config", "--global", "user.email"))
	seen := map[string]bool{}
	out := protocol.CommitCount{Repos: []protocol.Repo{}}
	for _, dir := range repoDirs(c.cfg.WorkRoot, repoDepth) {
		if ctx.Err() != nil {
			break
		}
		// Worktrees share their repository's history: one count per repository.
		common := project.GitQuiet("", "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
		if common == "" || seen[common] {
			continue
		}
		seen[common] = true
		mine := map[string]bool{}
		for _, e := range append([]string{global, strings.ToLower(project.GitQuiet("", "-C", dir, "config", "user.email"))}, c.extra...) {
			if e != "" {
				mine[e] = true
			}
		}
		n := int64(0)
		for _, email := range strings.Split(project.GitQuiet("", "-C", dir, "log", "--all", "--format=%ae"), "\n") {
			if email != "" && mine[strings.ToLower(email)] {
				n++
			}
		}
		top := project.GitQuiet("", "-C", dir, "rev-parse", "--show-toplevel")
		if top == "" {
			top = dir
		}
		out.Repos = append(out.Repos, protocol.Repo{Path: top, Commits: n})
		out.Total += n
	}
	return out
}

func (c *commits) Asked() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.asked
}

// Several runs share one count.
func (c *commits) Soon() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.asked++
	if c.closed || c.pending != nil {
		return
	}
	c.pending = time.AfterFunc(countAfterRun, func() {
		c.mu.Lock()
		c.pending = nil
		c.mu.Unlock()
		c.refresh(context.Background())
	})
}
