package task

import (
	"context"

	"vibevalley/internal/base"
)

// The package's one service: its parts' exported methods are its own.
type Service struct {
	*taskLog
	*tasks
	parts base.Parts
}

func newService(a *taskLog, b *tasks) (*Service, error) {
	return &Service{a, b, base.Parts{a, b}}, nil
}

func (s *Service) OnStart(ctx context.Context) error { return s.parts.OnStart(ctx) }
func (s *Service) OnStop()                           { s.parts.OnStop() }
