package protocol

// The group chat's rules (chat_rules.go), as the removed TypeScript server's chat-rules.test.ts tested the TypeScript ones.

import (
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

func corePtr[T any](v T) *T { return &v }

func coreEqual(t *testing.T, got, want any, what ...any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s\n got %#v\nwant %#v", fmt.Sprint(what...), got, want)
	}
}

func coreMatches(t *testing.T, text, pattern string, what ...any) {
	t.Helper()
	if !regexp.MustCompile(pattern).MatchString(text) {
		t.Errorf("%s\n%q does not match %s", fmt.Sprint(what...), text, pattern)
	}
}

func coreJobOf(helper string) Conversation {
	return Conversation{Kind: ConversationKindThread, SubjectKind: corePtr(SubjectKindJob), SubjectID: corePtr(helper)}
}

var coreAudienceBase = AudienceInput{
	From:         "user",
	FromKind:     SenderKindUser,
	Kind:         MessageKindChat,
	Mentions:     []string{},
	Conversation: Conversation{Kind: ConversationKindSquare},
	Helpers:      []string{"w1", "w2", "w3"},
	Followers:    []string{},
	Cooling:      []string{},
	Broken:       []string{},
}

func coreAudience(change func(*AudienceInput)) [][4]any {
	i := coreAudienceBase
	change(&i)
	out := [][4]any{}
	for _, d := range AudienceOf(i) {
		out = append(out, [4]any{d.Recipient, string(d.Reason), d.Wakes, string(d.HeldBy)})
	}
	return out
}

func coreRow(recipient, reason string, wakes bool, held string) [4]any {
	return [4]any{recipient, reason, wakes, held}
}

func TestMentionsIn(t *testing.T) {
	coreEqual(t, MentionsIn("@w3 看看，@管家 也看看，@w3 别忘了"), []string{"w3", "foreman"})
	coreEqual(t, MentionsIn("@w3你看一下"), []string{"w3"}, "a name ends where its token ends")
	coreEqual(t, MentionsIn("@主人 @所有人"), []string{"user", "everyone"})
	coreEqual(t, MentionsIn("用 `@w3` 叫它，或者\n```\n@w2\n```"), []string{})
	coreEqual(t, MentionsIn("邮件 a@w3.com 不算"), []string{})
}

func TestTargets(t *testing.T) {
	coreEqual(t, TargetOf(Conversation{Kind: ConversationKindSquare}, nil), "#田头")
	coreEqual(t, TargetOf(Conversation{Kind: ConversationKindChannel, Name: corePtr("clock-in")}, nil), "#clock-in")
	coreEqual(t, TargetOf(Conversation{Kind: ConversationKindThread, Parent: corePtr[int64](4812)}, nil), "#田头:4812")
	coreEqual(t, TargetOf(Conversation{Kind: ConversationKindThread, Parent: corePtr[int64](9)}, corePtr("clock-in")), "#clock-in:9")
	coreEqual(t, ParseTarget("#田头"), &ChatTarget{Kind: TargetKindChannel, Name: "田头"})
	coreEqual(t, ParseTarget("clock-in"), &ChatTarget{Kind: TargetKindChannel, Name: "clock-in"})
	coreEqual(t, ParseTarget("#田头:4812"), &ChatTarget{Kind: TargetKindThread, Parent: 4812})
	coreEqual(t, ParseTarget("#clock-in:9"), &ChatTarget{Kind: TargetKindThread, Parent: 9})
	coreEqual(t, ParseTarget("#有 空格"), (*ChatTarget)(nil))
	coreEqual(t, ParseTarget("#a:b:c"), (*ChatTarget)(nil))
}

func TestChannelNameProblem(t *testing.T) {
	coreEqual(t, ChannelNameProblem("clock-in", []string{"田头"}), "")
	coreEqual(t, ChannelNameProblem("打卡", []string{"田头"}), "")
	coreMatches(t, ChannelNameProblem("有 空格", nil), "只能是")
	coreMatches(t, ChannelNameProblem("a:b", nil), "只能是")
	coreMatches(t, ChannelNameProblem("田头", []string{"田头"}), "已经有")
}

func TestAudienceInAChannel(t *testing.T) {
	channel := Conversation{Kind: ConversationKindChannel}
	in := func(mentions ...string) []Delivery {
		return AudienceOf(AudienceInput{From: "user", FromKind: SenderKindUser, Kind: MessageKindChat, Mentions: mentions, Conversation: channel, Helpers: []string{"w1"}, OnFarm: []string{"w1", "w2"}})
	}
	coreEqual(t, in(), []Delivery{{Recipient: "foreman", Reason: DeliveryReasonAddressed, Wakes: true}, {Recipient: "w1", Reason: DeliveryReasonSquare}})
	var who []string
	for _, d := range in("w2") {
		who = append(who, d.Recipient)
	}
	coreEqual(t, who, []string{"w2", "w1"})
}

func TestChannelsInTheChat(t *testing.T) {
	chat := WithConversation(nil, Conversation{ID: 1, Kind: ConversationKindSquare, Name: corePtr("田头")})
	chat = WithConversation(&chat, Conversation{ID: 5, Kind: ConversationKindChannel, Name: corePtr("clock-in"), Project: corePtr("clock")})
	chat = WithConversation(&chat, Conversation{ID: 7, Kind: ConversationKindThread, Parent: corePtr[int64](30), Channel: corePtr[int64](5)})
	var names []string
	for _, c := range ChannelsOf(&chat) {
		names = append(names, *c.Name)
	}
	coreEqual(t, names, []string{"田头", "clock-in"})
	coreEqual(t, *ChannelOf(&chat, ConversationOf(&chat, 7)).Name, "clock-in")
	coreEqual(t, AddressOf(&chat, *ConversationOf(&chat, 7)), "#clock-in:30")
	coreEqual(t, *ChannelOf(&chat, &Conversation{ID: 9, Kind: ConversationKindThread, Parent: corePtr[int64](3)}).Name, "田头")
}

func TestThePersonOnTheSquare(t *testing.T) {
	coreEqual(t, coreAudience(func(*AudienceInput) {}), [][4]any{
		coreRow("foreman", "addressed", true, ""),
		coreRow("w1", "square", false, ""),
		coreRow("w2", "square", false, ""),
		coreRow("w3", "square", false, ""),
	})
	coreEqual(t, coreAudience(func(i *AudienceInput) { i.Mentions = []string{"w2"} }), [][4]any{
		coreRow("w2", "mention", true, ""),
		coreRow("w1", "square", false, ""),
		coreRow("w3", "square", false, ""),
	})
	coreEqual(t, coreAudience(func(i *AudienceInput) { i.Mentions = []string{"everyone"} }), [][4]any{
		coreRow("w1", "everyone", true, ""),
		coreRow("w2", "everyone", true, ""),
		coreRow("w3", "everyone", true, ""),
	})
}

func TestThePersonInAJobThread(t *testing.T) {
	coreEqual(t, coreAudience(func(i *AudienceInput) { i.Conversation, i.Followers = coreJobOf("w1"), []string{"w1", "w2"} }), [][4]any{
		coreRow("w1", "own_thread", true, ""),
		coreRow("w2", "follower", true, ""),
	})
	coreEqual(t, coreAudience(func(i *AudienceInput) { i.Conversation, i.Mentions = coreJobOf("w1"), []string{"foreman"} }), [][4]any{
		coreRow("foreman", "mention", true, ""),
		coreRow("w1", "own_thread", true, ""),
	})
	coreEqual(t, coreAudience(func(i *AudienceInput) { i.Conversation = coreJobOf("w9") }), [][4]any{}, "a helper that left is no one's to wake")
}

func TestAgentsWakingAgents(t *testing.T) {
	byHelper := func(change func(*AudienceInput)) func(*AudienceInput) {
		return func(i *AudienceInput) {
			i.From, i.FromKind, i.Conversation = "w1", SenderKindHelper, coreJobOf("w1")
			change(i)
		}
	}
	coreEqual(t, coreAudience(byHelper(func(*AudienceInput) {})), [][4]any{}, "a helper in its own thread, naming no one, wakes no one")
	coreEqual(t, coreAudience(byHelper(func(i *AudienceInput) { i.Mentions = []string{"w2"} })), [][4]any{coreRow("w2", "mention", true, "")})
	coreEqual(t, coreAudience(byHelper(func(i *AudienceInput) { i.Mentions, i.Hops = []string{"w2", "w3"}, HopLimit-1 })), [][4]any{
		coreRow("w2", "mention", true, ""),
		coreRow("w3", "mention", true, "hop_limit"),
	})
	coreEqual(t, coreAudience(byHelper(func(i *AudienceInput) { i.Mentions, i.Cooling = []string{"w2"}, []string{"w2"} })), [][4]any{coreRow("w2", "mention", true, "cooldown")})
	coreEqual(t, coreAudience(byHelper(func(i *AudienceInput) { i.Mentions, i.Broken = []string{"w2"}, []string{"w2"} })), [][4]any{coreRow("w2", "mention", true, "wake_breaker")})
	// The person is not braked: their word wakes even a broken helper.
	coreEqual(t, coreAudience(func(i *AudienceInput) {
		i.Mentions, i.Broken, i.Hops, i.Cooling = []string{"w2"}, []string{"w2"}, 99, []string{"w2"}
	})[0], coreRow("w2", "mention", true, ""))
	// A helper cannot @所有人, and never wakes itself.
	coreEqual(t, coreAudience(byHelper(func(i *AudienceInput) { i.Mentions = []string{"everyone", "w1"} })), [][4]any{})
	// The manager in a helper's thread speaks to that helper.
	coreEqual(t, coreAudience(func(i *AudienceInput) {
		i.From, i.FromKind, i.Conversation = "foreman", SenderKindForeman, coreJobOf("w1")
	}), [][4]any{coreRow("w1", "own_thread", true, "")})
}

func TestReportsDispatchesNotices(t *testing.T) {
	report := func(outcome Outcome, forPlaybook bool) func(*AudienceInput) {
		return func(i *AudienceInput) {
			i.From, i.FromKind, i.Kind, i.Conversation, i.Outcome, i.ForPlaybook = "w1", SenderKindHelper, MessageKindReport, coreJobOf("w1"), &outcome, forPlaybook
		}
	}
	coreEqual(t, coreAudience(report(OutcomeCompleted, false)), [][4]any{coreRow("foreman", "addressed", false, "")})
	coreEqual(t, coreAudience(report(OutcomeFailed, false)), [][4]any{coreRow("foreman", "addressed", true, "")})
	coreEqual(t, coreAudience(report(OutcomeFailed, true)), [][4]any{})
	coreEqual(t, coreAudience(func(i *AudienceInput) {
		i.From, i.FromKind, i.Kind, i.Mentions = "foreman", SenderKindForeman, MessageKindDispatch, []string{"w1"}
	}), [][4]any{})
	coreEqual(t, coreAudience(func(i *AudienceInput) {
		i.From, i.FromKind, i.Kind, i.Mentions = "system", SenderKindSystem, MessageKindNotice, []string{"w1"}
	}), [][4]any{})
}

func TestWakeInputAndBusyNotice(t *testing.T) {
	var messages []InboxMessage
	for i := 1; i <= 4; i++ {
		m := InboxMessage{Seq: int64(10 + i), Target: "#田头:5", From: "w2", FromKind: SenderKindHelper, Name: "阿郑", Text: fmt.Sprintf("第 %d 句\n第二行", i)}
		if i%2 == 1 {
			m.From, m.FromKind, m.Name = "user", SenderKindUser, "主人"
		}
		messages = append(messages, m)
	}
	input := WakeInput(messages, []UnreadRow{{Target: "#田头", Unread: 2, Latest: "主人"}})
	coreMatches(t, input, `有 4 条给你的新消息（这里是最新的 3 条）`)
	if strings.Contains(input, "第 1 句") {
		t.Error("the oldest is summarised, not shown")
	}
	coreMatches(t, input, `\[target=#田头:5 msg=12 from=w2 阿郑\] 第 2 句\n {2}│ 第二行`)
	coreMatches(t, input, `- #田头 2 条，最后是 主人`)
	notice := BusyNotice([]UnreadRow{{Target: "#田头:5", Unread: 2, MentionsYou: true, Latest: "主人"}})
	coreMatches(t, notice, `#田头:5 2 条（提到了你），最后是 主人`)
	if strings.Contains(notice, "第 1 句") {
		t.Error("no words in a notice")
	}
}

func TestTheChatKeepsTheSquare(t *testing.T) {
	chat := WithConversation(nil, Conversation{ID: 1, Kind: ConversationKindSquare})
	for i := int64(2); i <= KeepConversations+5; i++ {
		chat = WithConversation(&chat, Conversation{ID: i, Kind: ConversationKindThread, Parent: corePtr(i), Replies: 1, LastSeq: corePtr(i), At: i})
	}
	coreEqual(t, len(chat.Conversations), KeepConversations)
	coreEqual(t, chat.Conversations[0].Kind, ConversationKindSquare, "the square is never dropped")
	if ConversationOf(&chat, 2) != nil {
		t.Error("the quietest thread went")
	}
}
