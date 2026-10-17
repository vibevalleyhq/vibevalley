package voice

import (
	"context"

	"vibevalley/internal/base"
)

// The package's one service: its parts' exported methods are its own.
type Service struct {
	*voiceLine
	*voice
	*dictation
	parts base.Parts
}

func newService(a *voiceLine, b *voice, c *dictation) (*Service, error) {
	return &Service{a, b, c, base.Parts{a, b, c}}, nil
}

func (s *Service) OnStart(ctx context.Context) error { return s.parts.OnStart(ctx) }
func (s *Service) OnStop()                           { s.parts.OnStop() }
