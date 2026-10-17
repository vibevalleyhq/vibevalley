package playbook

import (
	"testing"

	"vibevalley/internal/golden"
	"vibevalley/internal/protocol"
)

// Reading a plan from a planner's answer, editing its steps, what a step is told and which start, over the recorded cases
// (testdata/rules.jsonl.gz).
func TestRulesGolden(t *testing.T) {
	seen := golden.Rules(t, "testdata/rules.jsonl.gz", func(c golden.Case) any {
		switch c.Fn {
		case "playbook":
			var in struct {
				PB     protocol.Playbook `json:"pb"`
				Edit   protocol.NodeEdit `json:"edit"`
				ID     string            `json:"id"`
				Output string            `json:"output"`
				Index  int               `json:"index"`
			}
			c.Decode(t, c.In, &in)
			pb := in.PB
			ids := []string{}
			for _, n := range startable(pb) {
				ids = append(ids, n.ID)
			}
			var task any
			if in.Index < len(pb.Nodes) {
				task = nodeTask(pb, pb.Nodes[in.Index])
			}
			touched := [][]string{}
			for _, n := range pb.Nodes {
				touched = append(touched, frozenTouched(pb, n, []string{"test/a_test.go", "src/x.ts", "README.md"}))
			}
			return map[string]any{
				"startable": ids, "settled": allSettled(pb), "task": task, "checkFailed": checkFailedText("pnpm test", in.Output),
				"frozenTouched": touched, "acceptancePassed": acceptancePassedText(in.Output),
				"frozenText": frozenTouchedText([]string{"test/a_test.go", in.Output}),
				"edited":     editedCase(editNode(pb, in.ID, in.Edit)), "removed": editedCase(removeNode(pb, in.ID)),
			}
		case "plan":
			var text string
			c.Decode(t, c.In, &text)
			got := parsePlan(text)
			if !got.OK {
				return map[string]any{"ok": false, "problems": got.Problems}
			}
			out := map[string]any{"ok": true, "nodes": got.Nodes}
			if got.Title != nil {
				out["title"] = *got.Title
			}
			return out
		}
		t.Fatalf("line %d: unknown fn %q", c.Line, c.Fn)
		return nil
	})
	if len(seen) != 2 {
		t.Fatalf("rules seen: %v", seen)
	}
}

func editedCase(e editResult) map[string]any {
	if e.OK {
		return map[string]any{"ok": true, "playbook": e.Playbook}
	}
	return map[string]any{"ok": false, "problem": e.Problem}
}
