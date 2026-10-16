package tickets

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("tickets", fx.Provide(
		base.Run[*Issues](r, newIssues),
		base.Run[*Dispatch](r, newDispatch),
		base.Run[*Merges](r, newMerges),
		base.Run[*PlaybookLog](r, newPlaybookLog),
		base.Run[*Playbooks](r, newPlaybooks),
		base.Run[*Schedules](r, newSchedules),
		base.Run[*Heartbeat](r, newHeartbeat),
	))
}
