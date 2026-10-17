package runtime

import (
	"testing"

	"vibevalley/internal/golden"
	"vibevalley/internal/protocol"
)

// Whether a runtime takes work now, what is left of its quota, and what stops a profile, over the recorded cases (testdata/rules.jsonl.gz).
func TestRulesGolden(t *testing.T) {
	seen := golden.Rules(t, "testdata/rules.jsonl.gz", func(c golden.Case) any {
		switch c.Fn {
		case "moneyStop":
			var info *protocol.RuntimeInfo
			c.Decode(t, c.In, &info)
			return golden.Null(moneyStop(info))
		case "quota":
			var usage protocol.AccountUsage
			c.Decode(t, c.In, &usage)
			var left any
			if l, ok := quotaLeft(usage); ok {
				left = l
			}
			return map[string]any{"left": left, "text": quotaText(usage)}
		case "agentIssues":
			var in struct {
				Agent   protocol.Agent        `json:"agent"`
				Runtime *protocol.RuntimeInfo `json:"runtime"`
			}
			c.Decode(t, c.In, &in)
			return agentIssues(in.Agent, in.Runtime)
		}
		t.Fatalf("line %d: unknown fn %q", c.Line, c.Fn)
		return nil
	})
	if len(seen) != 3 {
		t.Fatalf("rules seen: %v", seen)
	}
}
