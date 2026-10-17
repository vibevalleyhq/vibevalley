package channel

import (
	"vibevalley/internal/protocol"
)

type Info struct {
	ID          int64
	Name        string
	Description string
	Project     string
}

type Spoken struct {
	Kind      string // sent, held, confirm
	Message   protocol.ChatMessage
	Target    string
	NotOnFarm []string
	Shown     []protocol.InboxMessage
	More      int
	LastRead  string
}

type SpeakOptions struct {
	Target  string
	Anyway  bool
	Confirm bool
}

type ReadOptions struct {
	Target string
	Unread bool
	Before int64
	Limit  int64
}

type ReadResult struct {
	Target   string
	Messages []protocol.InboxMessage
	Older    bool
}

type ManagerNews struct {
	Conversation int64
	Target       string
	Messages     []protocol.InboxMessage
}
