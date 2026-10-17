package connector

import (
	"strings"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

func coreMsg(change func(*protocol.ChatMessage)) protocol.ChatMessage {
	m := protocol.ChatMessage{Seq: 1, Conversation: 1, From: protocol.ManagerAgent, FromKind: protocol.SenderKindManager, Name: "管家", Kind: protocol.MessageKindChat, Text: "好", Final: true}
	change(&m)
	return m
}

func TestForOwner(t *testing.T) {
	testkit.Eq(t, forOwner(coreMsg(func(*protocol.ChatMessage) {})), true)
	testkit.Eq(t, forOwner(coreMsg(func(m *protocol.ChatMessage) { m.Final = false })), false, "not while the manager is still speaking")
	testkit.Eq(t, forOwner(coreMsg(func(m *protocol.ChatMessage) { m.From, m.FromKind = "user", protocol.SenderKindUser })), false)
	testkit.Eq(t, forOwner(coreMsg(func(m *protocol.ChatMessage) {
		m.Kind, m.From, m.FromKind = protocol.MessageKindNotice, "system", protocol.SenderKindSystem
	})), false)
	testkit.Eq(t, forOwner(coreMsg(func(m *protocol.ChatMessage) {
		m.Kind, m.From, m.FromKind = protocol.MessageKindReport, "w1", protocol.SenderKindWorker
	})), true)
	testkit.Eq(t, forOwner(coreMsg(func(m *protocol.ChatMessage) { m.Kind = protocol.MessageKindDispatch })), true)
	testkit.Eq(t, forOwner(coreMsg(func(m *protocol.ChatMessage) {
		m.From, m.FromKind, m.Mentions = "w1", protocol.SenderKindWorker, []string{"w2"}
	})), false, "workers among themselves")
	testkit.Eq(t, forOwner(coreMsg(func(m *protocol.ChatMessage) {
		m.From, m.FromKind, m.Mentions = "w1", protocol.SenderKindWorker, []string{"user"}
	})), true)
}

func TestPlainText(t *testing.T) {
	testkit.Eq(t, plainText("## 结论\n**改好了**，见 [PR](https://x/1)\n- 一\n- 二\n```ts\nconst a = 1\n```"), "结论\n改好了，见 PR (https://x/1)\n· 一\n· 二\nconst a = 1")
	testkit.Eq(t, plainText("a *b* c\r# h - x"), "a b c\rh · x", "JavaScript's line ends")
}

func TestOwnerLine(t *testing.T) {
	testkit.Eq(t, ownerLine(coreMsg(func(m *protocol.ChatMessage) { m.Text = "好的" }), &protocol.Conversation{Kind: protocol.ConversationKindGeneral}), "【管家】\n好的")
	testkit.Eq(t, ownerLine(coreMsg(func(m *protocol.ChatMessage) {
		m.Kind, m.From, m.FromKind, m.Name, m.Outcome, m.Text = protocol.MessageKindReport, "w1", protocol.SenderKindWorker, "后端老周", ptr.To(protocol.OutcomeFailed), "测试挂了"
	}), &protocol.Conversation{Kind: protocol.ConversationKindThread}), "【后端老周 · 没做成】\n测试挂了")
	testkit.Eq(t, ownerLine(coreMsg(func(m *protocol.ChatMessage) {
		m.From, m.FromKind, m.Name, m.Mentions, m.Text = "w1", protocol.SenderKindWorker, "后端老周", []string{"user"}, "@主人 用哪个库？"
	}), &protocol.Conversation{Kind: protocol.ConversationKindThread}), "【后端老周 · 在工单串里】\n@主人 用哪个库？")
}

func TestSplitText(t *testing.T) {
	testkit.Eq(t, splitText("短", 1800), []string{"短"})
	long := strings.Repeat("甲", 60) + "\n" + strings.Repeat("乙", 60)
	testkit.Eq(t, splitText(long, 80), []string{strings.Repeat("甲", 60), strings.Repeat("乙", 60)})
	testkit.Eq(t, len(splitText(strings.Repeat("丙", 200), 80)), 3)
}

func TestFlushText(t *testing.T) {
	testkit.Eq(t, flushText([]string{"【管家】\n一", "【管家】\n二"}), []string{"【管家】\n一", "【管家】\n二"})
	digest := flushText([]string{"【管家】\n一", "【管家】\n二", "【老周 · 做完了】\n三", "【管家】\n四"})
	testkit.Eq(t, len(digest), 1)
	testkit.Match(t, digest[0], `^你不在的时候有 4 条消息：\n【管家】 一\n`)
}

func TestIsPairing(t *testing.T) {
	testkit.Eq(t, isPairing("482913", "482913"), true)
	testkit.Eq(t, isPairing(" 482 913 ", "482913"), true)
	testkit.Eq(t, isPairing("配对 482913", "482913"), true)
	testkit.Eq(t, isPairing("482914", "482913"), false)
	testkit.Eq(t, isPairing("你好 482913", "482913"), false)
	testkit.Eq(t, shortID("o9cq80wWj3kD8bq"), "o9cq…D8bq")
	testkit.Eq(t, shortID("short"), "short")
}
