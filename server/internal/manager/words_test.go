package manager

import (
	"strings"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
)

func TestManagerInboxLinesCutLongWords(t *testing.T) {
	line := func(from, text string) string {
		return managerInboxLines([]protocol.InboxMessage{{Number: 4, Target: "#田头:3", From: from, FromKind: protocol.SenderKindAgent, Name: "测试小吴", Text: text}})
	}
	head := "[target=#田头:3 msg=4 from=w1 测试小吴] "
	for _, c := range []struct {
		name, text, want string
	}{
		{"799", strings.Repeat("a", 799), strings.Repeat("a", 799)},
		{"800", strings.Repeat("字", 800), strings.Repeat("字", 800)},
		{"801", strings.Repeat("字", 801), strings.Repeat("字", 800) + "…（这条有 801 字，全文用 read_chat 读 #田头:3）"},
		{"an emoji is two units, never cut in half", strings.Repeat("a", 799) + "🌾🌾", strings.Repeat("a", 799) + "…（这条有 803 字，全文用 read_chat 读 #田头:3）"},
		{"spaces around do not count", "  " + strings.Repeat("a", 800) + "\n", strings.Repeat("a", 800)},
	} {
		testkit.Eq(t, line("w1", c.text), head+c.want, c.name)
	}
	owner := managerInboxLines([]protocol.InboxMessage{{Number: 4, Target: "#ops", From: "user", FromKind: protocol.SenderKindUser, Name: "主人", Text: strings.Repeat("字", 900)}})
	testkit.Eq(t, owner, "[target=#ops msg=4 from=主人] "+strings.Repeat("字", 900), "the owner's words stay whole")
}
