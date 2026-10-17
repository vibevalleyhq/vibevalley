package manager

import (
	"fmt"
	"strconv"
	"strings"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/num"
	"vibevalley/pkg/x/str"
)

func wan(n int64) string {
	if n >= 10_000 {
		digits := 1
		if n >= 100_000 {
			digits = 0
		}
		return num.Fixed(float64(n)/10_000, digits) + " 万"
	}
	return strconv.FormatInt(n, 10)
}

func spentText(spent protocol.Spent) string {
	tokens := wan(spent.Tokens) + " token"
	if spent.CNY != nil {
		return "约 " + protocol.Yuan(*spent.CNY) + " · " + tokens
	}
	return tokens
}

// In UTF-16 units: enough for a report's conclusion; the rest stays in the chat for read_chat.
const managerLineMax = 800

// As protocol.InboxLines, but what others said past managerLineMax is cut, with where to read it whole. The owner's words stay whole.
func managerInboxLines(messages []protocol.InboxMessage) string {
	lines := make([]string, len(messages))
	for i, m := range messages {
		if text := str.Trim(m.Text); m.From != "user" && str.Units(text) > managerLineMax {
			m.Text = str.Head(text, managerLineMax) + fmt.Sprintf("…（这条有 %d 字，全文用 read_chat 读 %s）", str.Units(text), m.Target)
		}
		lines[i] = protocol.MessageLine(m)
	}
	return strings.Join(lines, "\n")
}
