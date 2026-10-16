package protocol

// The group chat's rules (田头) beyond the four the core state needs (chat.go), from packages/protocol/src/chat.ts:
// who a message names, who it goes to and whether it wakes them (with the brakes on agents waking agents), what a
// helper is handed when woken and told while busy, and how conversations are addressed and found.

import (
	"cmp"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

const (
	// HopLimit is how many agents agents may wake in one conversation since the person last spoke.
	HopLimit = 4
	// AgentWakeCooldownMs is how often, at most, another agent may wake a helper.
	AgentWakeCooldownMs = 60_000
	// WakeBreaker is how many wakes in a row may end before the helper said anything; then only the person wakes it.
	WakeBreaker = 3
	// NoticeBatchMs is how long a busy helper's notices are gathered into one.
	NoticeBatchMs = 3_000
	// WakeMessages is how many messages a woken helper is handed whole; the rest are a summary.
	WakeMessages = 3
	// SummaryConversations is how many conversations a summary of unread lists, at most.
	SummaryConversations = 20
	// RetryWindowMs: the same words from the same sender in the same place this soon again are a retry, not a new message.
	RetryWindowMs = 60_000
	// HeldShown is how many newer messages a held send shows, at most.
	HeldShown = 3
)

const (
	SquareName = "田头"
	Everyone   = "everyone"
)

// chatNamed are the names that are not a helper's id.
var chatNamed = map[string]string{"管家": "foreman", "主人": "user", "所有人": Everyone}

// MentionOf is how each of foreman, user and everyone is written.
var MentionOf = map[string]string{"foreman": "@管家", "user": "@主人", Everyone: "@所有人"}

var (
	chatFence   = regexp.MustCompile("(?s)```.*?```")
	chatTick    = regexp.MustCompile("`[^`\\n]*`")
	chatMention = regexp.MustCompile(`(^|[^\p{L}\p{N}_@])@(w[0-9]+|管家|主人|所有人)`)
)

// MentionsIn is who a message names: helper ids, foreman, user, everyone — each once, in order. Code is not prose: a
// mention inside backticks or a fence names no one. A name ends where its token ends, so `@w3你看` names w3.
func MentionsIn(text string) []string {
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

// ── Channels and addresses ───────────────────────────────────────────────────

// ChannelName is what a channel may be called: letters, digits, - and _, at most 24; no #, : or spaces, so an
// address reads back.
var ChannelName = regexp.MustCompile(`^[\p{L}\p{N}_-]{1,24}$`)

var chatThreadTarget = regexp.MustCompile(`^[\p{L}\p{N}_-]{1,24}:([0-9]+)$`)

// ChannelNameProblem is why a name cannot be a new channel's; empty when it can.
func ChannelNameProblem(name string, taken []string) string {
	if !ChannelName.MatchString(name) {
		return "频道名只能是字母、数字、汉字、- 和 _，最多 24 个字"
	}
	if slices.Contains(taken, name) {
		return "已经有叫 " + name + " 的频道了"
	}
	return ""
}

// TargetOf is how a conversation is addressed: a channel as #<name> (#田头), a thread as #<its channel>:<the seq of
// the message it hangs under>. channelName: a thread's channel's name; the square's when nil.
func TargetOf(c Conversation, channelName *string) string {
	if c.Kind == ConversationKindThread && c.Parent != nil {
		name := SquareName
		if channelName != nil {
			name = *channelName
		}
		return "#" + name + ":" + strconv.FormatInt(*c.Parent, 10)
	}
	if c.Name != nil {
		return "#" + *c.Name
	}
	return "#" + SquareName
}

// TargetKind is what a target names: a channel or a thread.
type TargetKind string

const (
	TargetKindChannel TargetKind = "channel"
	TargetKindThread  TargetKind = "thread"
)

// ChatTarget is a target as written, read back: a channel by Name, or a thread by its message's number (Parent).
type ChatTarget struct {
	Kind   TargetKind `json:"kind"`
	Name   string     `json:"name,omitzero"`
	Parent int64      `json:"parent,omitzero"`
}

// ParseTarget is a target as written, read back; nil when it is not one. A thread is found by its message's number
// alone. A number past int64 is not one (TypeScript would read it as an inexact float).
func ParseTarget(target string) *ChatTarget {
	t := strings.TrimPrefix(coreTrim(target), "#")
	if m := chatThreadTarget.FindStringSubmatch(t); m != nil {
		parent, err := strconv.ParseInt(m[1], 10, 64)
		if err != nil {
			return nil
		}
		return &ChatTarget{Kind: TargetKindThread, Parent: parent}
	}
	if ChannelName.MatchString(t) {
		return &ChatTarget{Kind: TargetKindChannel, Name: t}
	}
	return nil
}

// ── Who a message goes to ────────────────────────────────────────────────────

// DeliveryReason is why a message is someone's: they were named, it is their job's thread, they follow it…
type DeliveryReason string

const (
	DeliveryReasonMention   DeliveryReason = "mention"
	DeliveryReasonEveryone  DeliveryReason = "everyone"
	DeliveryReasonOwnThread DeliveryReason = "own_thread"
	DeliveryReasonFollower  DeliveryReason = "follower"
	DeliveryReasonSquare    DeliveryReason = "square"
	DeliveryReasonDispatch  DeliveryReason = "dispatch"
	DeliveryReasonAddressed DeliveryReason = "addressed"
	DeliveryReasonPlaybook  DeliveryReason = "playbook"
)

// HeldBy is why a message that should have woken someone did not; empty when nothing held it.
type HeldBy string

const (
	HeldByHopLimit    HeldBy = "hop_limit"
	HeldByCooldown    HeldBy = "cooldown"
	HeldByWakeBreaker HeldBy = "wake_breaker"
)

type Delivery struct {
	Recipient string         `json:"recipient"`
	Reason    DeliveryReason `json:"reason"`
	// Wakes an idle recipient (a new turn). Otherwise only a notice while busy, or a summary when next woken.
	Wakes bool `json:"wakes"`
	// HeldBy: it should have woken them, but a brake held it: recorded, not acted on.
	HeldBy HeldBy `json:"heldBy,omitzero"`
}

type AudienceInput struct {
	From     string      `json:"from"`
	FromKind SenderKind  `json:"fromKind"`
	Kind     MessageKind `json:"kind"`
	Mentions []string    `json:"mentions"`
	// Conversation: only its Kind, SubjectKind and SubjectID are read.
	Conversation Conversation `json:"conversation"`
	// Helpers on the farm now: those of the message's channel when it is a channel's; anyone named must be one.
	Helpers []string `json:"helpers"`
	// OnFarm: helpers that may be named from here (on the farm, any channel); Helpers when nil.
	OnFarm []string `json:"onFarm"`
	// Followers: who follows this thread (helpers, the manager).
	Followers []string `json:"followers"`
	// Hops: agents woken by agents in this conversation since the person last spoke.
	Hops int64 `json:"hops"`
	// Cooling: helpers an agent woke less than AgentWakeCooldownMs ago.
	Cooling []string `json:"cooling"`
	// Broken: helpers whose wakes keep failing (WakeBreaker).
	Broken []string `json:"broken"`
	// Outcome: a report's, how the turn went.
	Outcome *Outcome `json:"outcome,omitzero"`
	// ForPlaybook: a report from a playbook's helper; the playbook hears it, not the manager.
	ForPlaybook bool `json:"forPlaybook,omitzero"`
}

// AudienceOf is who a message goes to, why, and whether it wakes them.
//
//   - The person: whoever they name wakes; in a thread, its job's helper and its followers wake; in a channel the
//     manager answers (unless someone else was named) and the channel's helpers hear it without being woken.
//   - An agent (the manager, a helper): whoever it names wakes; in a helper's job thread, that helper wakes.
//   - Agents waking agents are braked: at most HopLimit since the person last spoke in the conversation, a helper at
//     most once per AgentWakeCooldownMs, and none for a helper whose wakes keep failing (the person still can).
//   - A report goes to the manager, waking it only when the turn failed; a playbook's helper reports to the playbook.
//   - Dispatches, notices and the farm's own messages go to no one.
func AudienceOf(i AudienceInput) []Delivery {
	out := []Delivery{}
	if i.Kind == MessageKindNotice || i.Kind == MessageKindDispatch || i.FromKind == SenderKindSystem {
		return out
	}
	byAgent := i.FromKind == SenderKindHelper || i.FromKind == SenderKindForeman
	onFarm := i.OnFarm
	if onFarm == nil {
		onFarm = i.Helpers
	}
	hops := i.Hops
	add := func(recipient string, reason DeliveryReason, wakes bool) {
		if recipient == i.From || slices.ContainsFunc(out, func(d Delivery) bool { return d.Recipient == recipient }) {
			return
		}
		if recipient != "foreman" && !slices.Contains(onFarm, recipient) {
			return
		}
		var heldBy HeldBy
		switch {
		case wakes && byAgent && hops >= HopLimit:
			heldBy = HeldByHopLimit
		case wakes && byAgent && recipient != "foreman" && slices.Contains(i.Cooling, recipient):
			heldBy = HeldByCooldown
		case wakes && i.FromKind != SenderKindUser && slices.Contains(i.Broken, recipient):
			heldBy = HeldByWakeBreaker
		}
		if wakes && byAgent && heldBy == "" {
			hops++
		}
		out = append(out, Delivery{Recipient: recipient, Reason: reason, Wakes: wakes, HeldBy: heldBy})
	}

	if i.Kind == MessageKindReport {
		if !i.ForPlaybook {
			add("foreman", DeliveryReasonAddressed, i.Outcome != nil && *i.Outcome == OutcomeFailed)
		}
		return out
	}
	// Named first: the strongest reason wins.
	for _, m := range i.Mentions {
		if m == Everyone {
			if i.FromKind == SenderKindUser {
				for _, h := range i.Helpers {
					add(h, DeliveryReasonEveryone, true)
				}
			}
		} else if m != "user" {
			add(m, DeliveryReasonMention, true)
		}
	}
	thread := i.Conversation.Kind == ConversationKindThread
	owner := ""
	if thread && i.Conversation.SubjectKind != nil && *i.Conversation.SubjectKind == SubjectKindJob && i.Conversation.SubjectID != nil {
		owner = *i.Conversation.SubjectID
	}
	if i.FromKind == SenderKindUser {
		if owner != "" {
			add(owner, DeliveryReasonOwnThread, true)
		}
		if thread {
			for _, f := range i.Followers {
				add(f, DeliveryReasonFollower, true)
			}
		} else {
			if !slices.ContainsFunc(i.Mentions, func(m string) bool { return m != "user" }) {
				add("foreman", DeliveryReasonAddressed, true)
			}
			for _, h := range i.Helpers {
				add(h, DeliveryReasonSquare, false)
			}
		}
	} else if owner != "" {
		add(owner, DeliveryReasonOwnThread, true)
	}
	return out
}

// HopLimitText is what a held wake says on the thread, once per run of agents talking among themselves (limit:
// HopLimit, usually).
func HopLimitText(limit int) string {
	return fmt.Sprintf("帮工之间已经来回 %d 次了，先停一停：等主人说一句再接着叫人。", limit)
}

// ── What a helper is told ────────────────────────────────────────────────────

// InboxMessage is a message as an agent reads it: where to reply, its number, who said it, then the words.
type InboxMessage struct {
	Seq      int64      `json:"seq"`
	Target   string     `json:"target"`
	From     string     `json:"from"`
	FromKind SenderKind `json:"fromKind"`
	Name     string     `json:"name"`
	Text     string     `json:"text"`
}

// MessageLine is one line per message; the words' own line breaks are marked, so no message can pass for a header.
func MessageLine(m InboxMessage) string {
	from := m.Name
	if m.FromKind == SenderKindHelper {
		from = m.From + " " + m.Name
	}
	return fmt.Sprintf("[target=%s msg=%d from=%s] %s", m.Target, m.Seq, from, strings.ReplaceAll(coreTrim(m.Text), "\n", "\n  │ "))
}

type UnreadRow struct {
	Target      string `json:"target"`
	Unread      int64  `json:"unread"`
	MentionsYou bool   `json:"mentionsYou"`
	// Latest: who said the newest of them; empty when not known.
	Latest string `json:"latest,omitzero"`
}

func chatRowText(r UnreadRow) string {
	s := fmt.Sprintf("%s %d 条", r.Target, r.Unread)
	if r.MentionsYou {
		s += "（提到了你）"
	}
	if r.Latest != "" {
		s += "，最后是 " + r.Latest
	}
	return s
}

// WakeInput is a turn for a helper woken by messages: the ones for it, in full; what else is unread, as a summary.
func WakeInput(messages []InboxMessage, others []UnreadRow) string {
	shown := lastN(messages, WakeMessages)
	more := ""
	if len(messages) > len(shown) {
		more = fmt.Sprintf("（这里是最新的 %d 条）", len(shown))
	}
	lines := []string{fmt.Sprintf("[%s消息] 有 %d 条给你的新消息%s：", SquareName, len(messages), more)}
	for _, m := range shown {
		lines = append(lines, MessageLine(m))
	}
	if len(others) > 0 {
		lines = append(lines, "", "别处还有没读的（只读不回，除非直接问到你）：")
		for _, r := range others[:min(len(others), SummaryConversations)] {
			lines = append(lines, "- "+chatRowText(r))
		}
	}
	lines = append(lines, "", "要回就用 farm_say，target 照抄；要看前面的上下文用 farm_read。不用回的就不回。")
	return strings.Join(lines, "\n")
}

// BusyNotice is a notice slipped into a busy helper's turn: where there is something new, no words; it reads when
// it chooses.
func BusyNotice(rows []UnreadRow) string {
	texts := make([]string, 0, min(len(rows), SummaryConversations))
	for _, r := range rows[:min(len(rows), SummaryConversations)] {
		texts = append(texts, chatRowText(r))
	}
	return fmt.Sprintf("[%s提示] 有新消息还没读：%s。方便的时候用 farm_read 读；不读不代表没事。", SquareName, strings.Join(texts, "；"))
}

// ── The chat in the core state ───────────────────────────────────────────────

// EmptyChat is a chat with nothing in it.
func EmptyChat() Chat { return Chat{Conversations: []Conversation{}, Messages: []ChatMessage{}} }

func SquareOf(chat *Chat) *Conversation {
	if chat == nil {
		return nil
	}
	for i := range chat.Conversations {
		if chat.Conversations[i].Kind == ConversationKindSquare {
			return &chat.Conversations[i]
		}
	}
	return nil
}

// ChannelsOf is the channels, the square first, then by when they were opened.
func ChannelsOf(chat *Chat) []Conversation {
	out := []Conversation{}
	if chat == nil {
		return out
	}
	for _, c := range chat.Conversations {
		if IsChannel(c) {
			out = append(out, c)
		}
	}
	slices.SortStableFunc(out, func(a, b Conversation) int {
		if a.Kind == ConversationKindSquare {
			return -1
		}
		if b.Kind == ConversationKindSquare {
			return 1
		}
		return cmp.Compare(a.ID, b.ID)
	})
	return out
}

// ChannelOf is the channel a conversation is in: itself, or a thread's channel (the square when unknown, or when c
// is nil).
func ChannelOf(chat *Chat, c *Conversation) *Conversation {
	if c == nil {
		return SquareOf(chat)
	}
	if IsChannel(*c) {
		return c
	}
	channel := int64(-1)
	if c.Channel != nil {
		channel = *c.Channel
	}
	if found := ConversationOf(chat, channel); found != nil {
		return found
	}
	return SquareOf(chat)
}

// AddressOf is a conversation's address, its channel looked up in the chat.
func AddressOf(chat *Chat, c Conversation) string {
	var name *string
	if channel := ChannelOf(chat, &c); channel != nil {
		name = channel.Name
	}
	return TargetOf(c, name)
}

func ConversationOf(chat *Chat, id int64) *Conversation {
	if chat == nil {
		return nil
	}
	for i := range chat.Conversations {
		if chat.Conversations[i].ID == id {
			return &chat.Conversations[i]
		}
	}
	return nil
}

// ThreadUnder is the thread hanging under a message.
func ThreadUnder(chat *Chat, seq int64) *Conversation {
	if chat == nil {
		return nil
	}
	for i := range chat.Conversations {
		c := &chat.Conversations[i]
		if c.Kind == ConversationKindThread && c.Parent != nil && *c.Parent == seq {
			return c
		}
	}
	return nil
}

// JobThreadOf is a helper's job thread: the newest one about it.
func JobThreadOf(chat *Chat, helper string) *Conversation {
	if chat == nil {
		return nil
	}
	for i := len(chat.Conversations) - 1; i >= 0; i-- {
		c := &chat.Conversations[i]
		if c.SubjectKind != nil && *c.SubjectKind == SubjectKindJob && c.SubjectID != nil && *c.SubjectID == helper {
			return c
		}
	}
	return nil
}

// UnreadIn is what is unread for the person: messages in it after their read position, final, not their own, not
// notices.
func UnreadIn(chat *Chat, c Conversation) int {
	read := int64(0)
	if c.Read != nil {
		read = *c.Read
	}
	n := 0
	for _, m := range MessagesIn(chat, c.ID) {
		if m.Seq > read && m.From != "user" && m.Kind != MessageKindNotice && m.Final {
			n++
		}
	}
	return n
}
