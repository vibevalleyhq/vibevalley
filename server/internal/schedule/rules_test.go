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

func TestNeedsOK(t *testing.T) {
	once := protocol.ScheduleWhen{Value: protocol.ScheduleWhenOnce{At: at("2026-10-12T12:00:00")}}
	daily := protocol.ScheduleWhen{Value: protocol.ScheduleWhenDaily{Time: "09:00"}}
	for _, c := range []struct {
		name       string
		req        protocol.ScheduleRequest
		by         protocol.ScheduleBy
		ownerInRun bool
		want       bool
	}{
		{"the owner's own", protocol.ScheduleRequest{When: daily, Agent: ptr.To("lab")}, protocol.ScheduleByOwner, false, false},
		{"the manager's, the owner asking", protocol.ScheduleRequest{When: daily, Agent: ptr.To("lab")}, protocol.ScheduleByManager, true, false},
		{"the manager's own follow-up", protocol.ScheduleRequest{When: once}, protocol.ScheduleByManager, false, false},
		{"the manager's, again and again", protocol.ScheduleRequest{When: daily}, protocol.ScheduleByManager, false, true},
		{"the manager's, sending a helper", protocol.ScheduleRequest{When: once, Agent: ptr.To("lab")}, protocol.ScheduleByManager, false, true},
		{"the manager's, a blank helper", protocol.ScheduleRequest{When: once, Agent: ptr.To(" ")}, protocol.ScheduleByManager, false, false},
	} {
		testkit.Eq(t, needsOK(c.req, c.by, c.ownerInRun), c.want, c.name)
	}
	// Every member is answered: needsOK panics on one it does not know.
	for _, by := range protocol.ScheduleByValues {
		needsOK(protocol.ScheduleRequest{When: daily}, by, false)
	}
}
