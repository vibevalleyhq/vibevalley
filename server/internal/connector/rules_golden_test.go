package connector

import (
	"testing"

	"vibevalley/internal/golden"
	"vibevalley/internal/protocol"
)

// The connector's text rules over their recorded cases (testdata/rules.jsonl.gz).
func TestRulesGolden(t *testing.T) {
	seen := golden.Rules(t, "testdata/rules.jsonl.gz", func(c golden.Case) any {
		switch c.Fn {
		case "plainText":
			var s string
			c.Decode(t, c.In, &s)
			return plainText(s)
		case "splitText":
			var in struct {
				Text string `json:"text"`
				Max  int    `json:"max"`
			}
			c.Decode(t, c.In, &in)
			return splitText(in.Text, in.Max)
		case "flushText":
			var lines []string
			c.Decode(t, c.In, &lines)
			if got := flushText(lines); got != nil {
				return got
			}
			return []string{}
		case "isPairing":
			var in struct{ Text, Code string }
			c.Decode(t, c.In, &in)
			return isPairing(in.Text, in.Code)
		case "shortId":
			var s string
			c.Decode(t, c.In, &s)
			return shortID(s)
		case "ownerLine":
			var in struct {
				M     protocol.ChatMessage   `json:"m"`
				Where *protocol.Conversation `json:"where"`
			}
			c.Decode(t, c.In, &in)
			return map[string]any{"line": ownerLine(in.M, in.Where), "forOwner": forOwner(in.M)}
		}
		t.Fatalf("line %d: unknown fn %q", c.Line, c.Fn)
		return nil
	})
	if len(seen) != 6 {
		t.Fatalf("rules seen: %v", seen)
	}
}
