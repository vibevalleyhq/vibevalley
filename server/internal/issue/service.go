package issue

import (
	"context"
	"sync"
	"time"

	"vibevalley/internal/base"
)

// The package's one service: its parts' exported methods are its own.
type Service struct {
	*issues
	*dispatch
	*merges
	*drafts
	parts      base.Parts
	prMu       sync.Mutex
	poll       time.Duration
	pollCancel context.CancelFunc
	pollDone   chan struct{}
}

func newService(a *issues, b *dispatch, c *merges, d *drafts, cfg base.Config) (*Service, error) {
	return &Service{issues: a, dispatch: b, merges: c, drafts: d, parts: base.Parts{a, b, c, d}, poll: time.Duration(cfg.GitHub.PRPollSeconds) * time.Second}, nil
}

func (s *Service) OnStart(ctx context.Context) error {
	if err := s.parts.OnStart(ctx); err != nil {
		return err
	}
	life, cancel := context.WithCancel(ctx)
	s.pollCancel = cancel
	s.pollDone = make(chan struct{})
	go func() { defer close(s.pollDone); s.pollPullRequests(life) }()
	return nil
}
func (s *Service) OnStop() {
	if s.pollCancel != nil {
		s.pollCancel()
		<-s.pollDone
	}
	s.parts.OnStop()
}
