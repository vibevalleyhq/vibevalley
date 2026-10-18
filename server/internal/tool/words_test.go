package tool

import (
	"strings"
	"testing"

	"vibevalley/internal/golden"
	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

func TestMoneyWords(t *testing.T) {
	testkit.Eq(t, spentText(protocol.Spent{Tokens: 26_000, CNY: ptr.To(0.03)}), "约 ¥0.03 · 2.6 万 token")
	testkit.Eq(t, spentText(protocol.Spent{Tokens: 12_500}), "1.3 万 token", "toFixed rounds halves up")
}

// How what was spent is worded, over the recorded cases (testdata/rules.jsonl.gz).
func TestRulesGolden(t *testing.T) {
	seen := golden.Rules(t, "testdata/rules.jsonl.gz", func(c golden.Case) any {
		if c.Fn == "spentText" {
			var spent protocol.Spent
			c.Decode(t, c.In, &spent)
			return spentText(spent)
		}
		t.Fatalf("line %d: unknown fn %q", c.Line, c.Fn)
		return nil
	})
	if len(seen) != 1 {
		t.Fatalf("rules seen: %v", seen)
	}
}

func TestToolStart(t *testing.T) {
	s := &Service{}
	start := s.Start("dispatch", []byte(`{ "brief": "加个 README", "project": "demo" }`))
	if start.Text != "派活：demo" || start.Input != `{"brief":"加个 README","project":"demo"}` || start.Action != protocol.ToolActionOther {
		t.Fatalf("%+v", start)
	}
	long := s.Start("graph_split", []byte(`{"goal":"`+strings.Repeat("长", 50)+`"}`))
	if long.Text != "拆计划："+strings.Repeat("长", 40)+"…" {
		t.Fatalf("%q", long.Text)
	}
	if s.Start("unknown", nil).Text != "unknown" {
		t.Fatal("an unknown tool is named by its name")
	}
}
