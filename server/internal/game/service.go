package game

import (
	"context"

	"vibevalley/internal/base"
)

// The package's one service: its parts' exported methods are its own.
type Service struct {
	*ledger
	*commits
	*beds
	parts base.Parts
}

func newService(a *ledger, b *commits, c *beds) (*Service, error) {
	return &Service{a, b, c, base.Parts{a, b, c}}, nil
}

func (s *Service) OnStart(ctx context.Context) error { return s.parts.OnStart(ctx) }
func (s *Service) OnStop()                           { s.parts.OnStop() }

func (s *Service) OnReady(ctx context.Context) { s.parts.OnReady(ctx) }
