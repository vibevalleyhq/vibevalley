package runtime

import (
	"context"
	"vibevalley/internal/protocol"
)

// Assessment pairs dispatch eligibility with the runtime snapshot that explains it.
type Assessment struct {
	Agent    protocol.Agent
	Info     *protocol.RuntimeInfo
	Issues   []protocol.AgentIssue
	Blocking []protocol.AgentIssue
}

func (a Assessment) Usable() bool { return a.Agent.Enabled && len(a.Blocking) == 0 }

func (r *Service) Assess(ctx context.Context, agent protocol.Agent) Assessment {
	info := r.Info(ctx, agent.Runtime)
	assessment := Assessment{Agent: agent, Info: info, Issues: agentIssues(agent, info)}
	for _, issue := range assessment.Issues {
		if issue.Level == protocol.AgentIssueLevelError {
			assessment.Blocking = append(assessment.Blocking, issue)
		}
	}
	return assessment
}
