package channel

import (
	"testing"

	"vibevalley/internal/golden"
	"vibevalley/internal/protocol"
)

// Who hears a message, how a target and a mention are read, how a woken worker is told, over the recorded cases
// (testdata/rules.jsonl.gz).
func TestRulesGolden(t *testing.T) {
	seen := golden.Rules(t, "testdata/rules.jsonl.gz", func(c golden.Case) any {
		switch c.Fn {
		case "mentionsIn":
			var s string
			c.Decode(t, c.In, &s)
			return mentionsIn(s)
		case "parseTarget":
			var s string
			c.Decode(t, c.In, &s)
			return parseChatTarget(s)
		case "channelNameProblem":
			var in struct {
				Name  string   `json:"name"`
				Taken []string `json:"taken"`
			}
			c.Decode(t, c.In, &in)
			return golden.Null(channelNameProblem(in.Name, in.Taken))
		case "audienceOf":
			var in chatAudienceInput
			c.Decode(t, c.In, &in)
			return chatAudience(in)
		case "wakeInput":
			var in struct {
				Messages []protocol.InboxMessage `json:"messages"`
				Others   []chatUnreadRow         `json:"others"`
			}
			c.Decode(t, c.In, &in)
			return wakeInput(in.Messages, in.Others)
		case "busyNotice":
			var rows []chatUnreadRow
			c.Decode(t, c.In, &rows)
			return busyNotice(rows)
		}
		t.Fatalf("line %d: unknown fn %q", c.Line, c.Fn)
		return nil
	})
	if len(seen) != 6 {
		t.Fatalf("rules seen: %v", seen)
	}
}
