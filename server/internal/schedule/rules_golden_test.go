package schedule

import (
	"testing"

	"vibevalley/internal/golden"
	"vibevalley/internal/protocol"
)

// Whether a schedule is due and was missed, over the recorded cases (testdata/rules.jsonl.gz).
func TestRulesGolden(t *testing.T) {
	seen := golden.Rules(t, "testdata/rules.jsonl.gz", func(c golden.Case) any {
		switch c.Fn {
		case "due":
			var in struct {
				S   protocol.Schedule `json:"s"`
				Now int64             `json:"now"`
			}
			c.Decode(t, c.In, &in)
			return map[string]any{"due": len(dueSchedules([]protocol.Schedule{in.S}, in.Now)), "missed": isMissed(in.S, in.Now)}
		}
		t.Fatalf("line %d: unknown fn %q", c.Line, c.Fn)
		return nil
	})
	if len(seen) != 1 {
		t.Fatalf("rules seen: %v", seen)
	}
}
