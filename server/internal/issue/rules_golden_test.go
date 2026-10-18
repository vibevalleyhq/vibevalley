package issue

import (
	"testing"

	"vibevalley/internal/golden"
	"vibevalley/internal/protocol"
)

// The next task's id among the tasks a state has, over the recorded cases (testdata/rules.jsonl.gz).
func TestRulesGolden(t *testing.T) {
	seen := golden.Rules(t, "testdata/rules.jsonl.gz", func(c golden.Case) any {
		switch c.Fn {
		case "nextTaskID":
			var in struct {
				State protocol.CoreState `json:"state"`
			}
			c.Decode(t, c.In, &in)
			ids := []string{}
			for _, graph := range protocol.GraphsOf(in.State) {
				ids = append(ids, graph.ID)
			}
			return nextTaskID(ids)
		}
		t.Fatalf("line %d: unknown fn %q", c.Line, c.Fn)
		return nil
	})
	if len(seen) != 1 {
		t.Fatalf("rules seen: %v", seen)
	}
}
