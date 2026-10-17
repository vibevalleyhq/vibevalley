package memory

import (
	"maps"
	"slices"
	"testing"

	"vibevalley/internal/golden"
	"vibevalley/internal/protocol"
)

// What a run recalls over the recorded cases (testdata/rules.jsonl.gz): the cue's terms, each memory's relevance (null:
// left out) and the pick.
func TestRulesGolden(t *testing.T) {
	seen := golden.Rules(t, "testdata/rules.jsonl.gz", func(c golden.Case) any {
		if c.Fn != "recall" {
			t.Fatalf("line %d: unknown fn %q", c.Line, c.Fn)
		}
		var in struct {
			Memories []protocol.Memory `json:"memories"`
			Cue      struct {
				pickCue
				Skip []string `json:"skip"`
			} `json:"cue"`
		}
		c.Decode(t, c.In, &in)
		cue := in.Cue.pickCue
		cue.Skip = map[string]bool{}
		for _, id := range in.Cue.Skip {
			cue.Skip[id] = true
		}
		terms := termsOf(cue.Text)
		out := map[string]any{"terms": append([]string{}, slices.Sorted(maps.Keys(terms))...), "relevance": []any{}, "pick": []string{}}
		for _, m := range in.Memories {
			if score, ok := relevance(m, cue, terms); ok {
				out["relevance"] = append(out["relevance"].([]any), score)
			} else {
				out["relevance"] = append(out["relevance"].([]any), nil)
			}
		}
		for _, m := range pick(in.Memories, cue) {
			out["pick"] = append(out["pick"].([]string), m.ID)
		}
		return out
	})
	if seen["recall"] == 0 {
		t.Fatal("no cases")
	}
}
