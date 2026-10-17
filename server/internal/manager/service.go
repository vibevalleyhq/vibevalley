package manager

import (
	"context"

	"vibevalley/internal/base"
)

// The package's one service: its parts' exported methods are its own.
type Service struct {
	*manager
	*patrol
	parts base.Parts
}

func newService(a *patrol, b *manager) (*Service, error) {
	b.patrol = a
	return &Service{b, a, base.Parts{a, b}}, nil
}

func (s *Service) OnStart(ctx context.Context) error { return s.parts.OnStart(ctx) }
func (s *Service) OnStop()                           { s.parts.OnStop() }
