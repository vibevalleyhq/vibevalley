package schedule

import (
	"vibevalley/internal/protocol"
)

type Due struct {
	Schedule protocol.Schedule
	Missed   bool
}
