package memory

import (
	"context"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
)

// The package's one service: its parts' exported methods are its own.
type Service struct {
	*providers
	*managerMemory
	parts base.Parts
}

func newService(a *providers, b *managerMemory) (*Service, error) {
	return &Service{a, b, base.Parts{a, b}}, nil
}

func (s *Service) OnStart(ctx context.Context) error { return s.parts.OnStart(ctx) }
func (s *Service) OnStop()                           { s.parts.OnStop() }

// The manager keeps its memories in its own MEMORY.md (agent manager); every other agent's are rows. These take either.

func (s *Service) MemoriesOf(agent string) protocol.MemoryList {
	if agent == protocol.ManagerAgent {
		return s.Manager()
	}
	return protocol.MemoryList{Memories: s.List(agent)}
}

func (s *Service) Remember(agent, text, project string) (protocol.Memory, error) {
	if agent == protocol.ManagerAgent {
		return s.WriteManager(text)
	}
	return s.Write(agent, text, project)
}

func (s *Service) ForgetOf(agent, id string) error {
	if agent == protocol.ManagerAgent {
		return s.ForgetManager(id)
	}
	return s.Forget(agent, id)
}

func (s *Service) RecallOf(agent, project, text string) (protocol.RecallPreview, error) {
	if agent == protocol.ManagerAgent {
		return protocol.RecallPreview{}, protocol.Refused{Reason: "管家不靠想起：它每次带着整份记性"}
	}
	return s.Preview(agent, project, text), nil
}
