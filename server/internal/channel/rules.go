package channel

// Who hears a message and how it is put to them: the chat's rules, over the recorded cases (testdata/rules.jsonl.gz).

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/str"
)

var chatNamed = map[string]string{"管家": protocol.ManagerAgent, "主人": "user", "所有人": protocol.Everyone}

var mentionOf = map[string]string{protocol.ManagerAgent: "@管家", "user": "@主人", protocol.Everyone: "@所有人"}

var (
	chatFence   = regexp.MustCompile("(?s)```.*?```")
	chatTick    = regexp.MustCompile("`[^`\\n]*`")
	chatMention = regexp.MustCompile(`(^|[^\p{L}\p{N}_@])@(w[0-9]+|管家|主人|所有人)`)
)

// Code is not prose: a mention inside backticks or a fence names no one. A name ends where its token ends, so `@w3你看` names w3.
func mentionsIn(text string) []string {
	prose := chatTick.ReplaceAllLiteralString(chatFence.ReplaceAllLiteralString(text, " "), " ")
	found := []string{}
	for _, m := range chatMention.FindAllStringSubmatch(prose, -1) {
		id := m[2]
		if named, ok := chatNamed[id]; ok {
			id = named
		}
		if !slices.Contains(found, id) {
			found = append(found, id)
		}
	}
	return found
}

// No #, : or spaces, so an address reads back.
var channelNamePattern = regexp.MustCompile(`^[\p{L}\p{N}_-]{1,24}$`)

var chatThreadTarget = regexp.MustCompile(`^[\p{L}\p{N}_-]{1,24}:([0-9]+)$`)

func channelNameProblem(name string, taken []string) string {
	if !channelNamePattern.MatchString(name) {
		return "频道名只能是字母、数字、汉字、- 和 _，最多 24 个字"
	}
	if slices.Contains(taken, name) {
		return "已经有叫 " + name + " 的频道了"
	}
	return ""
}

type chatTargetKind string

const (
	targetChannel chatTargetKind = "channel"
	targetThread  chatTargetKind = "thread"
)

type chatTarget struct {
	Kind   chatTargetKind `json:"kind"`
	Name   string         `json:"name,omitzero"`
	Parent int64          `json:"parent,omitzero"`
}

// A number past int64 is not one.
func parseChatTarget(target string) *chatTarget {
	t := strings.TrimPrefix(str.Trim(target), "#")
	if m := chatThreadTarget.FindStringSubmatch(t); m != nil {
		parent, err := strconv.ParseInt(m[1], 10, 64)
		if err != nil {
			return nil
		}
		return &chatTarget{Kind: targetThread, Parent: parent}
	}
	if channelNamePattern.MatchString(t) {
		return &chatTarget{Kind: targetChannel, Name: t}
	}
	return nil
}

type chatDeliveryReason string

const (
	reasonMention   chatDeliveryReason = "mention"
	reasonEveryone  chatDeliveryReason = "everyone"
	reasonOwnThread chatDeliveryReason = "own_thread"
	reasonFollower  chatDeliveryReason = "follower"
	reasonGeneral   chatDeliveryReason = "general"
	reasonDispatch  chatDeliveryReason = "dispatch"
	reasonAddressed chatDeliveryReason = "addressed"
	reasonPlaybook  chatDeliveryReason = "playbook"
)

type chatHeldBy string

const (
	heldByHopLimit    chatHeldBy = "hop_limit"
	heldByCooldown    chatHeldBy = "cooldown"
	heldByWakeBreaker chatHeldBy = "wake_breaker"
)

type chatDelivery struct {
	Recipient string             `json:"recipient"`
	Reason    chatDeliveryReason `json:"reason"`
	Wakes     bool               `json:"wakes"`
	HeldBy    chatHeldBy         `json:"heldBy,omitzero"`
}

type chatAudienceInput struct {
	From     string               `json:"from"`
	FromKind protocol.SenderKind  `json:"fromKind"`
	Kind     protocol.MessageKind `json:"kind"`
	Mentions []string             `json:"mentions"`
	// Only its Kind, SubjectKind and SubjectID are read.
	Conversation protocol.Conversation `json:"conversation"`
	Sessions     []string              `json:"sessions"`
	// Sessions when nil.
	OnFarm      []string          `json:"onFarm"`
	Followers   []string          `json:"followers"`
	Hops        int64             `json:"hops"`
	Cooling     []string          `json:"cooling"`
	Broken      []string          `json:"broken"`
	Outcome     *protocol.Outcome `json:"outcome,omitzero"`
	ForPlaybook bool              `json:"forPlaybook,omitzero"`
	Spoken      bool              `json:"spoken,omitzero"`
}

func chatAudience(i chatAudienceInput) []chatDelivery {
	out := []chatDelivery{}
	if i.Kind == protocol.MessageKindNotice || i.Kind == protocol.MessageKindDispatch || i.FromKind == protocol.SenderKindSystem || i.Spoken {
		return out
	}
	byAgent := i.FromKind == protocol.SenderKindAgent || i.FromKind == protocol.SenderKindManager
	onFarm := i.OnFarm
	if onFarm == nil {
		onFarm = i.Sessions
	}
	hops := i.Hops
	add := func(recipient string, reason chatDeliveryReason, wakes bool) {
		if recipient == i.From || slices.ContainsFunc(out, func(d chatDelivery) bool { return d.Recipient == recipient }) {
			return
		}
		if recipient != protocol.ManagerAgent && !slices.Contains(onFarm, recipient) {
			return
		}
		var heldBy chatHeldBy
		switch {
		case wakes && byAgent && hops >= protocol.HopLimit:
			heldBy = heldByHopLimit
		case wakes && byAgent && recipient != protocol.ManagerAgent && slices.Contains(i.Cooling, recipient):
			heldBy = heldByCooldown
		case wakes && i.FromKind != protocol.SenderKindUser && slices.Contains(i.Broken, recipient):
			heldBy = heldByWakeBreaker
		}
		if wakes && byAgent && heldBy == "" {
			hops++
		}
		out = append(out, chatDelivery{Recipient: recipient, Reason: reason, Wakes: wakes, HeldBy: heldBy})
	}

	if i.Kind == protocol.MessageKindReport {
		if !i.ForPlaybook {
			add(protocol.ManagerAgent, reasonAddressed, i.Outcome != nil && *i.Outcome == protocol.OutcomeFailed)
		}
		return out
	}
	// Named first: the strongest reason wins.
	for _, m := range i.Mentions {
		if m == protocol.Everyone {
			if i.FromKind == protocol.SenderKindUser {
				for _, h := range i.Sessions {
					add(h, reasonEveryone, true)
				}
			}
		} else if m != "user" {
			add(m, reasonMention, true)
		}
	}
	thread := i.Conversation.Kind == protocol.ConversationKindThread
	owner := ""
	if thread && i.Conversation.SubjectKind != nil && *i.Conversation.SubjectKind == protocol.SubjectKindIssue && i.Conversation.SubjectID != nil {
		owner = *i.Conversation.SubjectID
	}
	if i.FromKind == protocol.SenderKindUser {
		if owner != "" {
			add(owner, reasonOwnThread, true)
		}
		if thread {
			for _, f := range i.Followers {
				add(f, reasonFollower, true)
			}
		} else {
			if !slices.ContainsFunc(i.Mentions, func(m string) bool { return m != "user" }) {
				add(protocol.ManagerAgent, reasonAddressed, true)
			}
			for _, h := range i.Sessions {
				add(h, reasonGeneral, false)
			}
		}
	} else if owner != "" {
		add(owner, reasonOwnThread, true)
	}
	return out
}

func hopLimitText(limit int) string {
	return fmt.Sprintf("帮工之间已经来回 %d 次了，先停一停：等主人说一句再接着叫人。", limit)
}

type chatUnreadRow struct {
	Target      string `json:"target"`
	Unread      int64  `json:"unread"`
	MentionsYou bool   `json:"mentionsYou"`
	Latest      string `json:"latest,omitzero"`
}

func chatRowText(r chatUnreadRow) string {
	s := fmt.Sprintf("%s %d 条", r.Target, r.Unread)
	if r.MentionsYou {
		s += "（提到了你）"
	}
	if r.Latest != "" {
		s += "，最后是 " + r.Latest
	}
	return s
}

func wakeInput(messages []protocol.InboxMessage, others []chatUnreadRow) string {
	shown := messages[max(0, len(messages)-protocol.WakeMessages):]
	more := ""
	if len(messages) > len(shown) {
		more = fmt.Sprintf("（这里是最新的 %d 条）", len(shown))
	}
	lines := []string{fmt.Sprintf("[%s消息] 有 %d 条给你的新消息%s：", protocol.GeneralName, len(messages), more)}
	for _, m := range shown {
		lines = append(lines, protocol.MessageLine(m))
	}
	if len(others) > 0 {
		lines = append(lines, "", "别处还有没读的（只读不回，除非直接问到你）：")
		for _, r := range others[:min(len(others), protocol.SummaryConversations)] {
			lines = append(lines, "- "+chatRowText(r))
		}
	}
	lines = append(lines, "", "要回就用 channel_say，target 照抄；要看前面的上下文用 channel_read。不用回的就不回。")
	return strings.Join(lines, "\n")
}

func busyNotice(rows []chatUnreadRow) string {
	texts := make([]string, 0, min(len(rows), protocol.SummaryConversations))
	for _, r := range rows[:min(len(rows), protocol.SummaryConversations)] {
		texts = append(texts, chatRowText(r))
	}
	return fmt.Sprintf("[%s提示] 有新消息还没读：%s。方便的时候用 channel_read 读；不读不代表没事。", protocol.GeneralName, strings.Join(texts, "；"))
}
