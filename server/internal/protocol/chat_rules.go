package protocol

import (
	"fmt"
	"strconv"
	"strings"

	"vibevalley/pkg/x/str"
)

const (
	// Counted since the person last spoke in the conversation.
	HopLimit            = 4
	AgentWakeCooldownMs = 60_000
	// Past this, only the person wakes the session.
	WakeBreaker          = 3
	NoticeBatchMs        = 3_000
	WakeMessages         = 3
	SummaryConversations = 20
	// The same words from the same sender in the same place this soon again are a retry, not a new message.
	RetryWindowMs = 60_000
	HeldShown     = 3
)

// A channel is #<name> (#田头), a thread #<its channel>:<the number of the message it hangs under>. channelName nil: the general channel.
func TargetOf(c Conversation, channelName *string) string {
	if c.Kind == ConversationKindThread && c.ParentNumber != nil {
		name := GeneralName
		if channelName != nil {
			name = *channelName
		}
		return "#" + name + ":" + strconv.FormatInt(*c.ParentNumber, 10)
	}
	if c.Name != nil {
		return "#" + *c.Name
	}
	return "#" + GeneralName
}

type InboxMessage struct {
	ID       string     `json:"id"`
	Number   int64      `json:"number"`
	Target   string     `json:"target"`
	From     string     `json:"from"`
	FromKind SenderKind `json:"fromKind"`
	Name     string     `json:"name"`
	Text     string     `json:"text"`
}

// The words' own line breaks are marked, so no message can pass for a header.
// One line each, in order: how the manager and a session read what came to them.
func InboxLines(messages []InboxMessage) string {
	lines := make([]string, len(messages))
	for i, m := range messages {
		lines[i] = MessageLine(m)
	}
	return strings.Join(lines, "\n")
}

func MessageLine(m InboxMessage) string {
	from := m.Name
	if m.FromKind == SenderKindAgent {
		from = m.From + " " + m.Name
	}
	return fmt.Sprintf("[target=%s msg=%d from=%s] %s", m.Target, m.Number, from, strings.ReplaceAll(str.Trim(m.Text), "\n", "\n  │ "))
}

func GeneralOf(chat *Chat) *Conversation {
	if chat == nil {
		return nil
	}
	for i := range chat.Conversations {
		if chat.Conversations[i].Kind == ConversationKindGeneral {
			return &chat.Conversations[i]
		}
	}
	return nil
}

func ChannelOf(chat *Chat, c *Conversation) *Conversation {
	if c == nil {
		return GeneralOf(chat)
	}
	if IsChannel(*c) {
		return c
	}
	channel := ""
	if c.Channel != nil {
		channel = *c.Channel
	}
	if found := ConversationOf(chat, channel); found != nil {
		return found
	}
	return GeneralOf(chat)
}

func AddressOf(chat *Chat, c Conversation) string {
	var name *string
	if channel := ChannelOf(chat, &c); channel != nil {
		name = channel.Name
	}
	return TargetOf(c, name)
}

func ConversationOf(chat *Chat, id string) *Conversation {
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
