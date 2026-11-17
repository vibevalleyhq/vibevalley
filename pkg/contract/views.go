package contract

// IssueStatus tracks lifecycle progression of a tracked issue in the workbench.
type IssueStatus string

const (
	IssueDraft      IssueStatus = "draft"
	IssueQueued     IssueStatus = "queued"
	IssueInProgress IssueStatus = "in_progress"
	IssueReview     IssueStatus = "review"
	IssueDone       IssueStatus = "done"
)

// IssueView projects the current issue state for web, CLI, and desktop notch island views.
type IssueView struct {
	ID          string      `json:"id"`
	Title       string      `json:"title"`
	Status      IssueStatus `json:"status"`
	RepoID      string      `json:"repoId"`
	AssigneeID  string      `json:"assigneeId,omitempty"`
	SessionID   string      `json:"sessionId,omitempty"`
	Rubric      *RubricSpec `json:"rubric,omitempty"`
	UpdatedAtMs int64       `json:"updatedAtMs"`
}

// ChannelEventKind classifies immutable social facts committed to a channel stream.
type ChannelEventKind string

const (
	ChannelEventMessage  ChannelEventKind = "message"
	ChannelEventQuestion ChannelEventKind = "question"
	ChannelEventReport   ChannelEventKind = "report"
	ChannelEventReaction ChannelEventKind = "reaction"
)

// ChannelEventView represents a public channel timeline entry separated from internal execution traces.
type ChannelEventView struct {
	ChannelID   string           `json:"channelId"`
	Seq         int64            `json:"seq"`
	Kind        ChannelEventKind `json:"kind"`
	AuthorID    string           `json:"authorId"`
	Text        string           `json:"text"`
	SessionID   string           `json:"sessionId,omitempty"`
	CreatedAtMs int64            `json:"createdAtMs"`
}

// InboxItemKind classifies attention items surfaced to the owner by watch, governance, or mount sync.
type InboxItemKind string

const (
	InboxMention       InboxItemKind = "mention"
	InboxApproval      InboxItemKind = "approval"
	InboxBudgetReached InboxItemKind = "budget_reached"
	InboxDreamProposal InboxItemKind = "dream_proposal"
	InboxMountConflict InboxItemKind = "mount_conflict"
)

// InboxItemView projects an actionable owner inbox entry.
type InboxItemView struct {
	ID          string        `json:"id"`
	Kind        InboxItemKind `json:"kind"`
	Title       string        `json:"title"`
	Summary     string        `json:"summary"`
	SessionID   string        `json:"sessionId,omitempty"`
	IssueID     string        `json:"issueId,omitempty"`
	Resolved    bool          `json:"resolved"`
	CreatedAtMs int64         `json:"createdAtMs"`
}

// ArtifactDisplayMode specifies how an HTML or rich deliverable is framed in the workbench.
type ArtifactDisplayMode string

const (
	ArtifactDisplayPage       ArtifactDisplayMode = "page"
	ArtifactDisplaySlides     ArtifactDisplayMode = "slides"
	ArtifactDisplayMotion     ArtifactDisplayMode = "motion"
	ArtifactDisplayCanvas     ArtifactDisplayMode = "canvas"
	ArtifactDisplayDashboard  ArtifactDisplayMode = "dashboard"
	ArtifactDisplayWhiteboard ArtifactDisplayMode = "whiteboard"
)

// ArtifactCardView summarizes a versioned deliverable announced in channels, issues, or the library.
type ArtifactCardView struct {
	ID          string              `json:"id"`
	Title       string              `json:"title"`
	Body        string              `json:"body"`
	Display     ArtifactDisplayMode `json:"display"`
	Version     int                 `json:"version"`
	SHA256      string              `json:"sha256"`
	ChannelID   string              `json:"channelId,omitempty"`
	IssueID     string              `json:"issueId,omitempty"`
	UpdatedAtMs int64               `json:"updatedAtMs"`
}

// BacklinkView records an exact AST/CST byte-span backlink reference in PARA knowledge notes.
type BacklinkView struct {
	SourcePath  string `json:"sourcePath"`
	TargetTitle string `json:"targetTitle"`
	BlockID     string `json:"blockId,omitempty"`
	Line        int    `json:"line"`
	ByteStart   int    `json:"byteStart"`
	ByteEnd     int    `json:"byteEnd"`
	Snippet     string `json:"snippet"`
}

// ApprovalPromptView projects a parked always_ask tool authorization waiting on owner confirmation.
type ApprovalPromptView struct {
	TaskID        string           `json:"taskId"`
	SessionID     string           `json:"sessionId"`
	ToolName      string           `json:"toolName"`
	Policy        PermissionPolicy `json:"policy"`
	Summary       string           `json:"summary"`
	RequestedAtMs int64            `json:"requestedAtMs"`
}

// DreamProposalView summarizes an offline memory consolidation proposal awaiting review.
type DreamProposalView struct {
	ProposalID        string `json:"proposalId"`
	BaseVersion       int64  `json:"baseVersion"`
	CandidateVersion  int64  `json:"candidateVersion"`
	DeduplicatedCount int    `json:"deduplicatedCount"`
	Summary           string `json:"summary"`
	Status            string `json:"status"`
	CreatedAtMs       int64  `json:"createdAtMs"`
}

// SpaceView holds the top-level reactive workspace snapshot synchronized over Chord Link.
type SpaceView struct {
	Rev            int64                `json:"rev"`
	Issues         []IssueView          `json:"issues"`
	Inbox          []InboxItemView      `json:"inbox"`
	Approvals      []ApprovalPromptView `json:"approvals"`
	Dreams         []DreamProposalView  `json:"dreams"`
	OnlineMachines []string             `json:"onlineMachines"`
}
