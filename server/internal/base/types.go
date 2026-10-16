package base

// Refusals are plain errors whose text is for the person (Chinese, the farm's words); the API turns them into FarmRefused.

import "vibevalley/internal/protocol"

type Workplace struct {
	Project string `json:"project"`
	Cwd     string `json:"cwd"`
	// Branch is empty when it works in the project folder itself.
	Branch string `json:"branch,omitzero"`
}

type Project struct {
	Name string
	Path string
	Git  bool
}

type Harvested struct {
	Text    string
	Commits int
}

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

type Roster struct {
	Helper   protocol.Helper
	Place    Workplace
	LastText string
}

type Hired struct {
	Helper  *protocol.Helper
	Evicted string
	Refused string
}

type HireOptions struct {
	// Base is the branch its own branch starts from; empty: the project's main branch.
	Base     string
	Worktree *bool
	Playbook *protocol.HelperPlaybook
	Channel  *int64
	// Empty: Dispatch makes one from the job.
	Issue string
}

type Delivered struct {
	Kind    string // turn, steered, queued, refused
	Session string
	Woke    bool
	Reason  string
}

type SessionActivity struct {
	Kind    string // spoke, ended, closed, compacting
	ID      string
	Session string
	Outcome protocol.Outcome
	Spoke   bool
	On      bool
}

type ChannelInfo struct {
	ID          int64
	Name        string
	Description string
	Project     string
}

type InboxMessage = protocol.InboxMessage

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

type UnreadRow = protocol.UnreadRow

type ForemanNews struct {
	Conversation int64
	Target       string
	Messages     []InboxMessage
}

type FinishedTurn struct {
	Agent   string
	Helper  string
	Project string
	Job     string
	Outcome protocol.Outcome
	Said    string
	Summary string
}

type RecallCue struct {
	Agent   string
	Helper  string
	Project string
	Text    string
	Skip    map[string]bool
}

type Due struct {
	Schedule protocol.FarmSchedule
	Missed   bool
}

type PatrolNews struct {
	Channel int64
	Text    string
}

// Per million tokens, in dollars.
type Price struct {
	Input      float64
	Output     float64
	CacheRead  float64
	CacheWrite float64
}

type VoiceKeys struct {
	ASRKey string
	LLMKey string
	TTSKey string
}

type CallLine struct {
	ID  string
	URL string
	Key string
}

type ToolStart struct {
	Text   string
	Action protocol.ToolAction
	Tool   string
	Input  string
}

// Empty is the agent itself, else the lineage of a sub-agent it started.
type From []string

type Journal interface {
	Steps() []protocol.WorkStep
	Asked(text string, from From)
	Said(text string, from From)
	Thought(text string, from From)
	ToolStarted(callID string, start ToolStart, from From)
	ToolInput(callID, input, text string, from From)
	ToolEnded(callID, output string, ok bool, from From)
	Note(kind protocol.StepKind, text string, from From)
	Close()
}
