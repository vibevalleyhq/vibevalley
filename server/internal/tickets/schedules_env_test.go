package tickets

import (
	"testing"
	"time"
)

func TestPlanHeartbeatAndScheduleEnv(t *testing.T) {
	for _, c := range []struct {
		set       bool
		value     string
		heartbeat time.Duration
		tick      time.Duration
	}{
		{set: false, heartbeat: 10 * time.Minute, tick: 20 * time.Second},
		{set: true, value: "", heartbeat: 0, tick: 0},
		{set: true, value: "0", heartbeat: 0, tick: 0},
		{set: true, value: "abc", heartbeat: 0, tick: 20 * time.Second},
		{set: true, value: " 2 ", heartbeat: 2 * time.Minute, tick: 2 * time.Millisecond},
		{set: true, value: "0.5", heartbeat: 30 * time.Second, tick: 500 * time.Microsecond},
	} {
		if c.set {
			t.Setenv("VIBEVALLEY_HEARTBEAT_MINUTES", c.value)
			t.Setenv("VIBEVALLEY_SCHEDULE_TICK_MS", c.value)
		}
		if got := planHeartbeatEvery(); got != c.heartbeat {
			t.Errorf("heartbeat %q: %v, want %v", c.value, got, c.heartbeat)
		}
		if got := planTickEvery(); got != c.tick {
			t.Errorf("tick %q: %v, want %v", c.value, got, c.tick)
		}
	}
}
