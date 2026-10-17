package game

import (
	"encoding/json"
	"reflect"
	"testing"

	"vibevalley/internal/golden"
	"vibevalley/internal/protocol"
)

// The ledger's fold step by step, and the entries each fact makes, over the recorded cases (testdata/rules.jsonl.gz).
func TestRulesGolden(t *testing.T) {
	seen := golden.Rules(t, "testdata/rules.jsonl.gz", func(c golden.Case) any {
		switch c.Fn {
		case "ledger":
			var in struct {
				Entries []protocol.LedgerEntry `json:"entries"`
			}
			c.Decode(t, c.In, &in)
			folded, steps := emptyFolded(), []map[string]any{}
			for _, e := range in.Entries {
				var news protocol.ProgressNews
				folded, news = progressStep(folded, e)
				p := folded.Progress
				steps = append(steps, map[string]any{"coins": p.Coins, "streak": p.Streak, "title": p.Title, "news": news})
			}
			if all := progressFold(in.Entries, emptyFolded()); !reflect.DeepEqual(all.Progress, folded.Progress) {
				t.Errorf("line %d: folding at once is not folding step by step", c.Line)
			}
			return map[string]any{"steps": steps, "progress": folded.Progress, "seen": folded.Seen}
		case "entries":
			var in struct {
				Before protocol.CoreState `json:"before"`
				Fact   protocol.Fact      `json:"fact"`
			}
			c.Decode(t, c.In, &in)
			after, _ := protocol.Reduce(in.Before, in.Fact)
			return map[string]any{"entries": withoutAt(entriesFor(in.Before, in.Fact, after)), "catchUp": withoutAt(catchUp(in.Before))}
		}
		t.Fatalf("line %d: unknown fn %q", c.Line, c.Fn)
		return nil
	})
	if len(seen) != 2 {
		t.Fatalf("rules seen: %v", seen)
	}
}

// The cases leave out when: it is the clock's, not the rule's.
func withoutAt(entries []protocol.LedgerEntry) []map[string]any {
	out := []map[string]any{}
	for _, e := range entries {
		var m map[string]any
		body, _ := json.Marshal(e)
		_ = json.Unmarshal(body, &m)
		delete(m, "at")
		out = append(out, m)
	}
	return out
}
