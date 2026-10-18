package task

import (
	"testing"

	"vibevalley/internal/golden"
	"vibevalley/internal/protocol"
)

// Reading a task from a splitter's answer, editing its steps, what a step is told and which start, over the recorded cases
// (testdata/rules.jsonl.gz).
func TestRulesGolden(t *testing.T) {
	seen := golden.Rules(t, "testdata/rules.jsonl.gz", func(c golden.Case) any {
		switch c.Fn {
		case "task":
			var in struct {
				TaskGraph protocol.TaskGraph `json:"task"`
				Edit      protocol.TaskEdit  `json:"edit"`
				ID        string             `json:"id"`
				Output    string             `json:"output"`
				Index     int                `json:"index"`
			}
			c.Decode(t, c.In, &in)
			graph := in.TaskGraph
			ids := []string{}
			for _, n := range startable(graph) {
				ids = append(ids, n.ID)
			}
			var task any
			if in.Index < len(graph.Tasks) {
				task = taskBrief(graph, graph.Tasks[in.Index])
			}
			touched := [][]string{}
			for _, n := range graph.Tasks {
				touched = append(touched, frozenTouched(graph, n, []string{"test/a_test.go", "src/x.ts", "README.md"}))
			}
			return map[string]any{
				"startable": ids, "settled": allSettled(graph), "brief": task, "checkFailed": checkFailedText("pnpm test", in.Output),
				"frozenTouched": touched, "acceptancePassed": acceptancePassedText(in.Output),
				"frozenText": frozenTouchedText([]string{"test/a_test.go", in.Output}),
				"edited":     editedCase(editTask(graph, in.ID, in.Edit)), "removed": editedCase(removeTask(graph, in.ID)),
			}
		case "split":
			var text string
			c.Decode(t, c.In, &text)
			got := parseSplit(text)
			if !got.OK {
				return map[string]any{"ok": false, "problems": got.Problems}
			}
			out := map[string]any{"ok": true, "tasks": got.Tasks}
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
		return map[string]any{"ok": true, "task": e.TaskGraph}
	}
	return map[string]any{"ok": false, "problem": e.Problem}
}
