package issue

import (
	"context"

	"vibevalley/internal/base"
)

// The package's one service: its parts' exported methods are its own.
type Service struct {
	*issues
	*dispatch
	*merges
	parts base.Parts
}

func newService(a *issues, b *dispatch, c *merges) (*Service, error) {
	return &Service{a, b, c, base.Parts{a, b, c}}, nil
}

func (s *Service) OnStart(ctx context.Context) error { return s.parts.OnStart(ctx) }
func (s *Service) OnStop()                           { s.parts.OnStop() }
