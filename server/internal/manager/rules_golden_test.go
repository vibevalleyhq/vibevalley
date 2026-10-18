package manager

import (
	"testing"

	"vibevalley/internal/golden"
	"vibevalley/internal/protocol"
)

// What the manager's patrol finds, over the recorded cases (testdata/rules.jsonl.gz).
func TestRulesGolden(t *testing.T) {
	seen := golden.Rules(t, "testdata/rules.jsonl.gz", func(c golden.Case) any {
		switch c.Fn {
		case "patrol":
			// Every fifth round the farm is empty: what was hanging is forgotten.
			var in struct {
				State protocol.CoreState `json:"state"`
				Nows  []int64            `json:"nows"`
			}
			c.Decode(t, c.In, &in)
			memory, rounds := emptyPatrol(), []map[string]any{}
			for r, now := range in.Nows {
				state := in.State
				if r%5 == 4 {
					state = protocol.EmptyCoreState()
				}
				var report []patrolNote
				report, memory = patrolStep(state, now, memory)
				rounds = append(rounds, map[string]any{"now": now, "report": report, "firstSeen": memory.FirstSeen, "reported": memory.Reported})
			}
			return rounds
		}
		t.Fatalf("line %d: unknown fn %q", c.Line, c.Fn)
		return nil
	})
	if len(seen) != 1 {
		t.Fatalf("rules seen: %v", seen)
	}
}
