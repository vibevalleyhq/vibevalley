package base

// Shapes the services hand each other (the TypeScript server's exported interfaces beside each service). Refusals
// are plain errors whose text is for the person (Chinese, the farm's words); the API turns them into FarmRefused.

import "vibevalley/internal/protocol"

// Workplace is where a helper works: the project, the folder (its worktree, or the project folder), its branch.
type Workplace struct {
	Project string `json:"project"`
	Cwd     string `json:"cwd"`
	// Branch is empty when it works in the project folder itself.
	Branch string `json:"branch,omitzero"`
}

// Project is a folder under the work directory.
type Project struct {
	Name string
	Path string
	Git  bool
}

// Harvested is what taking a helper's work in brought: what to say, and its commits.
type Harvested struct {
	Text    string
	Commits int
}

// HarvestFailure is why a merge did not happen: it conflicts (Kind "conflict", Base and Files), or failed (Reason).
type HarvestFailure struct {
	Kind   string // conflict, error
	Base   string
	Files  []string
	Reason string
}

func (h HarvestFailure) Error() string {
	if h.Kind == "conflict" {
		return "合进 " + h.Base + " 有冲突"
	}
	return h.Reason
}

// Roster is a helper on the farm with where it works and the last thing it said.
type Roster struct {
	Helper   protocol.Helper
	Place    Workplace
	LastText string
}

// Hired is a hire's outcome: the helper (and who was sent home to make room), or why not.
type Hired struct {
	Helper  *protocol.Helper
	Evicted string
	Refused string
}

type HireOptions struct {
	// Base is the branch its own branch starts from; empty: the project's main branch.
	Base string
	// Worktree overrides the agent's own choice.
	Worktree *bool
	Playbook *protocol.HelperPlaybook
	Channel  *int64
	// Issue is the issue the run works; empty: Dispatch makes one from the job.
	Issue string
}

// Delivered is what became of words for a helper: a new turn (woke: it had been resting), steered into the turn
// under way, queued for after it, or refused.
type Delivered struct {
	Kind    string // turn, steered, queued, refused
	Session string
	Woke    bool
	Reason  string
}

// SessionActivity is what a helper's session did, for those waiting on it (the chat's deliveries).
type SessionActivity struct {
	Kind    string // spoke, ended, closed, compacting
	ID      string
	Session string
	Outcome protocol.Outcome
	Spoke   bool
	On      bool
}

// ChannelInfo is a channel: its conversation id, name, what it is for and its default project.
type ChannelInfo struct {
	ID          int64
	Name        string
	Description string
	Project     string
}

// InboxMessage is a message as an agent reads it.
type InboxMessage = protocol.InboxMessage

// Spoken is what became of something an agent said in the chat: sent; held (unread messages there first); or
// waiting for it to confirm.
type Spoken struct {
	Kind      string // sent, held, confirm
	Message   protocol.ChatMessage
	Target    string
	NotOnFarm []string
	Shown     []InboxMessage
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
	Messages []InboxMessage
	Older    bool
}

// UnreadRow is a conversation with something unread, for an agent's inbox.
type UnreadRow = protocol.UnreadRow

// ForemanNews is messages for the manager, from one conversation.
type ForemanNews struct {
	Conversation int64
	Target       string
	Messages     []InboxMessage
}

// FinishedTurn is a helper's turn as its agent's memory keeps it.
type FinishedTurn struct {
	Agent   string
	Helper  string
	Project string
	Job     string
	Outcome protocol.Outcome
	Said    string
	Summary string
}

// RecallCue is what a turn is about, for picking the memories that bear on it.
type RecallCue struct {
	Agent   string
	Helper  string
	Project string
	Text    string
	Skip    map[string]bool
}

// Due is a schedule come due; Missed when its time passed while the farm was off.
type Due struct {
	Schedule protocol.FarmSchedule
	Missed   bool
}

// PatrolNews is what the heartbeat found worth saying in a channel.
type PatrolNews struct {
	Channel int64
	Text    string
}

// Price is a model's price per million tokens, in dollars.
type Price struct {
	Input      float64
	Output     float64
	CacheRead  float64
	CacheWrite float64
}

// VoiceKeys are the keys of the voice vendors that need their own.
type VoiceKeys struct {
	ASRKey string
	LLMKey string
	TTSKey string
}

// CallLine is the voice line for one call: its id, the URL Agora reaches it on, and its key.
type CallLine struct {
	ID  string
	URL string
	Key string
}

// ToolStart is a tool call as a step shows it.
type ToolStart struct {
	Text   string
	Action protocol.ToolAction
	Tool   string
	Input  string
}

// From is which agent a step is from: empty is the agent itself, else the lineage of a sub-agent it started.
type From []string

// Journal writes one trajectory's steps (steps.ts): sent to the pages as they grow, kept in its file.
type Journal interface {
	Steps() []protocol.WorkStep
	Asked(text string, from From)
	Said(text string, from From)
	Thought(text string, from From)
	ToolStarted(callID string, start ToolStart, from From)
	ToolInput(callID, input, text string, from From)
	ToolEnded(callID, output string, ok bool, from From)
	// Note is a recalled, retry or problem step.
	Note(kind protocol.StepKind, text string, from From)
	Close()
}
