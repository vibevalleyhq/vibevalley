package game

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/projects"
	"vibevalley/internal/protocol"
)

// A repository with several worktrees counts once. "Yours" is by author email (git's global and each repository's user.email, and
// VIBEVALLEY_GIT_EMAILS); helpers commit as you, so their commits count.

const (
	crewRepoDepth      = 3
	crewCountEvery     = 2 * time.Minute
	crewCountAfterTurn = 15 * time.Second
)

var crewSkipDirs = map[string]bool{"node_modules": true, ".git": true, ".venv": true, "vendor": true, "dist": true, "build": true, "target": true, ".next": true}

func crewRepoDirs(root string, depth int) []string {
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
		if e.IsDir() && !crewSkipDirs[e.Name()] {
			out = append(out, crewRepoDirs(filepath.Join(root, e.Name()), depth-1)...)
		}
	}
	return out
}

type Commits struct {
	cfg   base.Config
	site  *base.Site
	extra []string

	mu      sync.Mutex
	pending *time.Timer
	closed  bool
	stop    func()
	asked   int
}

func newCommits(cfg base.Config, site *base.Site) (*Commits, error) {
	c := &Commits{cfg: cfg, site: site}
	for _, e := range strings.Split(os.Getenv("VIBEVALLEY_GIT_EMAILS"), ",") {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			c.extra = append(c.extra, e)
		}
	}
	return c, nil
}

func (c *Commits) OnStart(ctx context.Context) error {
	_, events, stop := c.site.Events()
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

func (c *Commits) OnReady(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(crewCountEvery)
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

func (c *Commits) OnStop() {
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

func (c *Commits) refresh(ctx context.Context) {
	count := c.Count(ctx)
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if !closed && ctx.Err() == nil {
		c.site.SetCommits(count)
	}
}

func (c *Commits) Count(ctx context.Context) protocol.CommitCount {
	global := strings.ToLower(projects.GitQuiet("", "config", "--global", "user.email"))
	seen := map[string]bool{}
	out := protocol.CommitCount{Repos: []protocol.Repo{}}
	for _, dir := range crewRepoDirs(c.cfg.WorkRoot, crewRepoDepth) {
		if ctx.Err() != nil {
			break
		}
		// Worktrees share their repository's history: one count per repository.
		common := projects.GitQuiet("", "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
		if common == "" || seen[common] {
			continue
		}
		seen[common] = true
		mine := map[string]bool{}
		for _, e := range append([]string{global, strings.ToLower(projects.GitQuiet("", "-C", dir, "config", "user.email"))}, c.extra...) {
			if e != "" {
				mine[e] = true
			}
		}
		n := int64(0)
		for _, email := range strings.Split(projects.GitQuiet("", "-C", dir, "log", "--all", "--format=%ae"), "\n") {
			if email != "" && mine[strings.ToLower(email)] {
				n++
			}
		}
		top := projects.GitQuiet("", "-C", dir, "rev-parse", "--show-toplevel")
		if top == "" {
			top = dir
		}
		out.Repos = append(out.Repos, protocol.Repo{Path: top, Commits: n})
		out.Total += n
	}
	return out
}

func (c *Commits) Asked() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.asked
}

// Several turns share one count.
func (c *Commits) Soon() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.asked++
	if c.closed || c.pending != nil {
		return
	}
	c.pending = time.AfterFunc(crewCountAfterTurn, func() {
		c.mu.Lock()
		c.pending = nil
		c.mu.Unlock()
		c.refresh(context.Background())
	})
}
