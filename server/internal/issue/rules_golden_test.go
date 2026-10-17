package issue

import (
	"testing"

	"vibevalley/internal/golden"
	"vibevalley/internal/protocol"
)

// The next plan's id among the plans a state has, over the recorded cases (testdata/rules.jsonl.gz).
func TestRulesGolden(t *testing.T) {
	seen := golden.Rules(t, "testdata/rules.jsonl.gz", func(c golden.Case) any {
		switch c.Fn {
		case "nextPlaybookID":
			var in struct {
				State protocol.CoreState `json:"state"`
			}
			c.Decode(t, c.In, &in)
			ids := []string{}
			for _, pb := range protocol.PlaybooksOf(in.State) {
				ids = append(ids, pb.ID)
			}
			return nextPlaybookID(ids)
		}
		t.Fatalf("line %d: unknown fn %q", c.Line, c.Fn)
		return nil
	})
	if len(seen) != 1 {
		t.Fatalf("rules seen: %v", seen)
	}
}
