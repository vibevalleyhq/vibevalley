package protocol

// The group chat's rules that the core state needs (packages/protocol/src/chat.ts).

import (
	"cmp"
	"slices"
)

// How many messages and conversations the state keeps; the database keeps them all.
const (
	KeepMessages      = 300
	KeepConversations = 100
)

func IsChannel(c Conversation) bool { return c.Kind != ConversationKindThread }

func MessagesIn(chat *Chat, conversation int64) []ChatMessage {
	if chat == nil {
		return nil
	}
	var out []ChatMessage
	for _, m := range chat.Messages {
		if m.Conversation == conversation {
			out = append(out, m)
		}
	}
	return out
}

// WithMessage is the chat with m in it: a new message at its place, or a growing one replaced; the oldest drop off.
func WithMessage(chat *Chat, m ChatMessage) Chat {
	base := Chat{Conversations: []Conversation{}, Messages: []ChatMessage{}}
	if chat != nil {
		base = *chat
	}
	messages := slices.Clone(base.Messages)
	if i := slices.IndexFunc(messages, func(x ChatMessage) bool { return x.Seq == m.Seq }); i >= 0 {
		messages[i] = m
	} else {
		messages = append(messages, m)
		slices.SortStableFunc(messages, func(a, b ChatMessage) int { return cmp.Compare(a.Seq, b.Seq) })
	}
	base.Messages = lastN(messages, KeepMessages)
	return base
}

// WithConversation is the chat with c in it, new or changed; beyond KeepConversations the quietest go (never a channel).
func WithConversation(chat *Chat, c Conversation) Chat {
	base := Chat{Conversations: []Conversation{}, Messages: []ChatMessage{}}
	if chat != nil {
		base = *chat
	}
	all := slices.DeleteFunc(slices.Clone(base.Conversations), func(x Conversation) bool { return x.ID == c.ID })
	all = append(all, c)
	byID := func(a, b Conversation) int { return cmp.Compare(a.ID, b.ID) }
	if len(all) <= KeepConversations {
		slices.SortStableFunc(all, byID)
		base.Conversations = all
		return base
	}
	ranked := slices.Clone(all)
	channel := func(x Conversation) int {
		if IsChannel(x) {
			return 1
		}
		return 0
	}
	last := func(x Conversation) int64 {
		if x.LastSeq != nil {
			return *x.LastSeq
		}
		return 0
	}
	slices.SortStableFunc(ranked, func(a, b Conversation) int {
		if d := channel(b) - channel(a); d != 0 {
			return d
		}
		return cmp.Compare(last(b), last(a))
	})
	keep := map[int64]bool{}
	for _, x := range ranked[:KeepConversations] {
		keep[x.ID] = true
	}
	all = slices.DeleteFunc(all, func(x Conversation) bool { return !keep[x.ID] })
	slices.SortStableFunc(all, byID)
	base.Conversations = all
	return base
}
