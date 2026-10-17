package worker

import (
	"context"

	"vibevalley/internal/base"
)

// The package's one service: its parts' exported methods are its own.
type Service struct {
	*tokens
	*trajectories
	*workers
	parts base.Parts
}

func newService(a *tokens, b *trajectories, c *workers) (*Service, error) {
	return &Service{a, b, c, base.Parts{a, b, c}}, nil
}

func (s *Service) OnStart(ctx context.Context) error { return s.parts.OnStart(ctx) }
func (s *Service) OnStop()                           { s.parts.OnStop() }

func (s *Service) OnReady(ctx context.Context) { s.parts.OnReady(ctx) }
