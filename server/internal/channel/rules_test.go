package channel

import (
	"fmt"
	"strings"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
)

// A message in an issue's thread, owner the session working the issue now ("" for none).
func rulesJobOf(i *chatAudienceInput, owner string) {
	i.Conversation, i.ThreadOwner = protocol.Conversation{Kind: protocol.ConversationKindThread}, owner
}

var rulesAudienceBase = chatAudienceInput{
	From:         "user",
	FromKind:     protocol.SenderKindUser,
	Kind:         protocol.MessageKindChat,
	Mentions:     []string{},
	Conversation: protocol.Conversation{Kind: protocol.ConversationKindGeneral},
	Sessions:     []string{"w1", "w2", "w3"},
	Followers:    []string{},
	Cooling:      []string{},
	Broken:       []string{},
}

func rulesAudience(change func(*chatAudienceInput)) [][4]any {
	i := rulesAudienceBase
	change(&i)
	out := [][4]any{}
	for _, d := range chatAudience(i) {
		out = append(out, [4]any{d.Recipient, string(d.Reason), d.Wakes, string(d.HeldBy)})
	}
	return out
}

func rulesRow(recipient, reason string, wakes bool, held string) [4]any {
	return [4]any{recipient, reason, wakes, held}
}

func TestMentionsIn(t *testing.T) {
	testkit.Eq(t, mentionsIn("@w3 看看，@管家 也看看，@w3 别忘了"), []string{"w3", protocol.ManagerAgent})
	testkit.Eq(t, mentionsIn("@w3你看一下"), []string{"w3"}, "a name ends where its token ends")
	testkit.Eq(t, mentionsIn("@主人 @所有人"), []string{"user", "everyone"})
	testkit.Eq(t, mentionsIn("用 `@w3` 叫它，或者\n```\n@w2\n```"), []string{})
	testkit.Eq(t, mentionsIn("邮件 a@w3.com 不算"), []string{})
}

func TestChannelNameProblem(t *testing.T) {
	testkit.Eq(t, channelNameProblem("clock-in", []string{"田头"}), "")
	testkit.Eq(t, channelNameProblem("打卡", []string{"田头"}), "")
	testkit.Match(t, channelNameProblem("有 空格", nil), "只能是")
	testkit.Match(t, channelNameProblem("a:b", nil), "只能是")
	testkit.Match(t, channelNameProblem("田头", []string{"田头"}), "已经有")
}

func TestAudienceInAChannel(t *testing.T) {
	channel := protocol.Conversation{Kind: protocol.ConversationKindChannel}
	in := func(mentions ...string) []chatDelivery {
		return chatAudience(chatAudienceInput{From: "user", FromKind: protocol.SenderKindUser, Kind: protocol.MessageKindChat, Mentions: mentions, Conversation: channel, Sessions: []string{"w1"}, Present: []string{"w1", "w2"}})
	}
	testkit.Eq(t, in(), []chatDelivery{{Recipient: protocol.ManagerAgent, Reason: reasonAddressed, Wakes: true}, {Recipient: "w1", Reason: reasonGeneral}})
	var who []string
	for _, d := range in("w2") {
		who = append(who, d.Recipient)
	}
	testkit.Eq(t, who, []string{"w2", "w1"})
}

func TestThePersonOnTheGeneral(t *testing.T) {
	testkit.Eq(t, rulesAudience(func(*chatAudienceInput) {}), [][4]any{
		rulesRow(protocol.ManagerAgent, "addressed", true, ""),
		rulesRow("w1", "general", false, ""),
		rulesRow("w2", "general", false, ""),
		rulesRow("w3", "general", false, ""),
	})
	testkit.Eq(t, rulesAudience(func(i *chatAudienceInput) { i.Mentions = []string{"w2"} }), [][4]any{
		rulesRow("w2", "mention", true, ""),
		rulesRow("w1", "general", false, ""),
		rulesRow("w3", "general", false, ""),
	})
	testkit.Eq(t, rulesAudience(func(i *chatAudienceInput) { i.Mentions = []string{"everyone"} }), [][4]any{
		rulesRow("w1", "everyone", true, ""),
		rulesRow("w2", "everyone", true, ""),
		rulesRow("w3", "everyone", true, ""),
	})
}

func TestThePersonInAJobThread(t *testing.T) {
	testkit.Eq(t, rulesAudience(func(i *chatAudienceInput) { rulesJobOf(i, "w1"); i.Followers = []string{"w1", "w2"} }), [][4]any{
		rulesRow("w1", "own_thread", true, ""),
		rulesRow("w2", "follower", true, ""),
	})
	testkit.Eq(t, rulesAudience(func(i *chatAudienceInput) {
		rulesJobOf(i, "w1")
		i.Mentions = []string{protocol.ManagerAgent}
	}), [][4]any{
		rulesRow(protocol.ManagerAgent, "mention", true, ""),
		rulesRow("w1", "own_thread", true, ""),
	})
	testkit.Eq(t, rulesAudience(func(i *chatAudienceInput) { rulesJobOf(i, "w9") }), [][4]any{}, "a session that left is no one's to wake")
	testkit.Eq(t, rulesAudience(func(i *chatAudienceInput) { rulesJobOf(i, ""); i.Followers = []string{"w2"} }), [][4]any{
		rulesRow("w2", "follower", true, ""),
	}, "an issue no session works: only those who follow its thread hear the person")
	testkit.Eq(t, rulesAudience(func(i *chatAudienceInput) { rulesJobOf(i, "") }), [][4]any{}, "and with no one following, the words are only kept")
}

func TestAgentsWakingAgents(t *testing.T) {
	bySession := func(change func(*chatAudienceInput)) func(*chatAudienceInput) {
		return func(i *chatAudienceInput) {
			i.From, i.FromKind = "w1", protocol.SenderKindAgent
			rulesJobOf(i, "w1")
			change(i)
		}
	}
	testkit.Eq(t, rulesAudience(bySession(func(*chatAudienceInput) {})), [][4]any{}, "a session in its own thread, naming no one, wakes no one")
	testkit.Eq(t, rulesAudience(bySession(func(i *chatAudienceInput) { i.Mentions = []string{"w2"} })), [][4]any{rulesRow("w2", "mention", true, "")})
	testkit.Eq(t, rulesAudience(bySession(func(i *chatAudienceInput) { i.Mentions, i.Hops = []string{"w2", "w3"}, protocol.HopLimit-1 })), [][4]any{
		rulesRow("w2", "mention", true, ""),
		rulesRow("w3", "mention", true, "hop_limit"),
	})
	testkit.Eq(t, rulesAudience(bySession(func(i *chatAudienceInput) { i.Mentions, i.Cooling = []string{"w2"}, []string{"w2"} })), [][4]any{rulesRow("w2", "mention", true, "cooldown")})
	testkit.Eq(t, rulesAudience(bySession(func(i *chatAudienceInput) { i.Mentions, i.Broken = []string{"w2"}, []string{"w2"} })), [][4]any{rulesRow("w2", "mention", true, "wake_breaker")})
	testkit.Eq(t, rulesAudience(func(i *chatAudienceInput) {
		i.Mentions, i.Broken, i.Hops, i.Cooling = []string{"w2"}, []string{"w2"}, 99, []string{"w2"}
	})[0], rulesRow("w2", "mention", true, ""))
	testkit.Eq(t, rulesAudience(bySession(func(i *chatAudienceInput) { i.Mentions = []string{"everyone", "w1"} })), [][4]any{})
	testkit.Eq(t, rulesAudience(func(i *chatAudienceInput) {
		i.From, i.FromKind = protocol.ManagerAgent, protocol.SenderKindManager
		rulesJobOf(i, "w1")
	}), [][4]any{rulesRow("w1", "own_thread", true, "")})
}

func TestReportsDispatchesNotices(t *testing.T) {
	report := func(outcome protocol.Outcome, forTask bool) func(*chatAudienceInput) {
		return func(i *chatAudienceInput) {
			i.From, i.FromKind, i.Kind, i.Outcome, i.ForTask = "w1", protocol.SenderKindAgent, protocol.MessageKindReport, &outcome, forTask
			rulesJobOf(i, "w1")
		}
	}
	testkit.Eq(t, rulesAudience(report(protocol.OutcomeCompleted, false)), [][4]any{rulesRow(protocol.ManagerAgent, "addressed", false, "")})
	testkit.Eq(t, rulesAudience(report(protocol.OutcomeFailed, false)), [][4]any{rulesRow(protocol.ManagerAgent, "addressed", true, "")})
	testkit.Eq(t, rulesAudience(report(protocol.OutcomeFailed, true)), [][4]any{})
	testkit.Eq(t, rulesAudience(func(i *chatAudienceInput) {
		i.From, i.FromKind, i.Kind, i.Mentions = protocol.ManagerAgent, protocol.SenderKindManager, protocol.MessageKindDispatch, []string{"w1"}
	}), [][4]any{})
	testkit.Eq(t, rulesAudience(func(i *chatAudienceInput) {
		i.From, i.FromKind, i.Kind, i.Mentions = "system", protocol.SenderKindSystem, protocol.MessageKindNotice, []string{"w1"}
	}), [][4]any{})
}

func TestWakeInputAndBusyNotice(t *testing.T) {
	var messages []protocol.InboxMessage
	for i := 1; i <= 4; i++ {
		m := protocol.InboxMessage{ID: fmt.Sprintf("m%d", 10+i), Number: int64(10 + i), Target: "#田头:5", From: "w2", FromKind: protocol.SenderKindAgent, Name: "阿郑", Text: fmt.Sprintf("第 %d 句\n第二行", i)}
		if i%2 == 1 {
			m.From, m.FromKind, m.Name = "user", protocol.SenderKindUser, "主人"
		}
		messages = append(messages, m)
	}
	input := wakeInput(messages, []chatUnreadRow{{Target: "#田头", Unread: 2, Latest: "主人"}})
	testkit.Match(t, input, `有 4 条给你的新消息（这里是最新的 3 条）`)
	if strings.Contains(input, "第 1 句") {
		t.Error("the oldest is summarised, not shown")
	}
	testkit.Match(t, input, `\[target=#田头:5 msg=12 from=w2 阿郑\] 第 2 句\n {2}│ 第二行`)
	testkit.Match(t, input, `- #田头 2 条，最后是 主人`)
	notice := busyNotice([]chatUnreadRow{{Target: "#田头:5", Unread: 2, MentionsYou: true, Latest: "主人"}})
	testkit.Match(t, notice, `#田头:5 2 条（提到了你），最后是 主人`)
	if strings.Contains(notice, "第 1 句") {
		t.Error("no words in a notice")
	}
}

func TestParseTarget(t *testing.T) {
	testkit.Eq(t, parseChatTarget("#田头"), &chatTarget{Kind: targetChannel, Name: "田头"})
	testkit.Eq(t, parseChatTarget("clock-in"), &chatTarget{Kind: targetChannel, Name: "clock-in"})
	testkit.Eq(t, parseChatTarget("#田头:4812"), &chatTarget{Kind: targetThread, Parent: 4812})
	testkit.Eq(t, parseChatTarget("#clock-in:9"), &chatTarget{Kind: targetThread, Parent: 9})
	testkit.Eq(t, parseChatTarget("#有 空格"), (*chatTarget)(nil))
	testkit.Eq(t, parseChatTarget("#a:b:c"), (*chatTarget)(nil))
}
