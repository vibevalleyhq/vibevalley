package tool

import (
	"context"

	"go.uber.org/fx"

	"vibevalley/internal/agent"
	"vibevalley/internal/channel"
	"vibevalley/internal/core"
	"vibevalley/internal/issue"
	"vibevalley/internal/memory"
	"vibevalley/internal/project"
	"vibevalley/internal/runtime"
	"vibevalley/internal/schedule"
	"vibevalley/internal/session"
	"vibevalley/internal/task"
)

// The package's one service: the tools agents call, defined once, handed to the manager in process and to sessions over /mcp.
// A tool's rule lives in the service that owns it; a tool reads its arguments, says who is calling, and words the answer.
type Service struct {
	core     *core.Service
	agents   *agent.Service
	projects *project.Service
	memory   *memory.Service
	runtimes *runtime.Service
	run      *session.Service
	chat     *channel.Service
	schedule *schedule.Service
	issue    *issue.Service
	tasks    *task.Service
}

type serviceIn struct {
	fx.In
	Core      *core.Service
	Agent     *agent.Service
	Project   *project.Service
	Memory    *memory.Service
	Runtime   *runtime.Service
	Run       *session.Service
	Channel   *channel.Service
	Schedule  *schedule.Service
	Issue     *issue.Service
	TaskGraph *task.Service
}

func newService(in serviceIn) (*Service, error) {
	return &Service{
		core: in.Core, agents: in.Agent, projects: in.Project, memory: in.Memory, runtimes: in.Runtime, run: in.Run,
		chat: in.Channel, schedule: in.Schedule, issue: in.Issue, tasks: in.TaskGraph,
	}, nil
}

func (*Service) OnStart(context.Context) error { return nil }
func (*Service) OnStop()                       {}
