package game

import (
	"context"
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
	countEvery    = 2 * time.Minute
	countAfterRun = 15 * time.Second
)

type commits struct {
	projects *project.Service
	core     *core.Service
	extra    []string

	counting sync.Mutex
	mu       sync.Mutex
	pending  *time.Timer
	closed   bool
	stop     func()
	asked    int
}

func newCommits(cfg base.Config, core *core.Service, projects *project.Service) (*commits, error) {
	c := &commits{projects: projects, core: core}
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
	repos := c.projects.Contributions(ctx, c.extra)
	out := protocol.CommitCount{Repos: repos}
	for _, repo := range repos {
		out.Total += repo.Commits
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
