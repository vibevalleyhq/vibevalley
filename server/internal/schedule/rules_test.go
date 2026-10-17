package schedule

import (
	"testing"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

func at(iso string) int64 {
	t, err := time.Parse(time.RFC3339, iso+"+08:00")
	if err != nil {
		panic(err)
	}
	return t.UnixMilli()
}

func TestDueOnceMissedAndRun(t *testing.T) {
	s := protocol.Schedule{ID: "x1", Name: "测试", Text: "跑一遍测试", Channel: "c1", When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenDaily{Time: "09:00"}},
		TZ: "Asia/Shanghai", Enabled: true, Created: at("2026-10-01T08:00:00"), LastRun: ptr.To(at("2026-10-09T09:00:00"))}
	now := at("2026-10-12T11:00:00")
	testkit.Eq(t, dueSchedules([]protocol.Schedule{s}, now), []protocol.Schedule{s}, "three missed days are one run")
	testkit.Eq(t, isMissed(s, now), true)
	ran := afterRun(s, now)
	testkit.Eq(t, dueSchedules([]protocol.Schedule{ran}, now), []protocol.Schedule{}, "ran")
	testkit.Eq(t, isMissed(s, at("2026-10-10T09:00:20")), false, "twenty seconds late is on time")
	once := s
	once.When = protocol.ScheduleWhen{Value: protocol.ScheduleWhenOnce{At: at("2026-10-12T12:00:00")}}
	testkit.Eq(t, afterRun(once, now).Enabled, false, "a one-off is off once it ran")
}
