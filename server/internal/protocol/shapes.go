package protocol

// The shapes are the one source: tool/shapegen writes gen.go and the Flutter client's lib/gen/vibevalley.dart from them; its doc says what the
// vibevalley: directives and the vibevalley:"null" tag mean.

type CallState string

const (
	CallStateIdle       CallState = "idle"
	CallStateConnecting CallState = "connecting"
	CallStateLive       CallState = "live"
	CallStateEnding     CallState = "ending"
	CallStateError      CallState = "error"
)

type ForemanState string

const (
	ForemanStateIdle      ForemanState = "idle"
	ForemanStateListening ForemanState = "listening"
	ForemanStateThinking  ForemanState = "thinking"
	ForemanStateSpeaking  ForemanState = "speaking"
)

type SenderKind string

const (
	SenderKindUser    SenderKind = "user"
	SenderKindForeman SenderKind = "foreman"
	SenderKindHelper  SenderKind = "helper"
	SenderKindSystem  SenderKind = "system"
)

type MessageKind string

const (
	MessageKindChat     MessageKind = "chat"
	MessageKindDispatch MessageKind = "dispatch"
	MessageKindReport   MessageKind = "report"
	MessageKindNotice   MessageKind = "notice"
)

type Outcome string

const (
	OutcomeCompleted   Outcome = "completed"
	OutcomeFailed      Outcome = "failed"
	OutcomeInterrupted Outcome = "interrupted"
)

type Spent struct {
	Tokens int64    `json:"tokens"`
	CNY    *float64 `json:"cny,omitzero"`
}

type ChatMessage struct {
	Seq          int64       `json:"seq"`
	Conversation int64       `json:"conversation"`
	From         string      `json:"from"`
	FromKind     SenderKind  `json:"fromKind"`
	Name         string      `json:"name"`
	Agent        *string     `json:"agent,omitzero"`
	Kind         MessageKind `json:"kind"`
	Text         string      `json:"text"`
	Final        bool        `json:"final"`
	Mentions     []string    `json:"mentions,omitzero"`
	Helper       *string     `json:"helper,omitzero"`
	Outcome      *Outcome    `json:"outcome,omitzero"`
	Spent        *Spent      `json:"spent,omitzero"`
	At           int64       `json:"at"`
}

type ConversationKind string

const (
	ConversationKindSquare  ConversationKind = "square"
	ConversationKindChannel ConversationKind = "channel"
	ConversationKindThread  ConversationKind = "thread"
)

type SubjectKind string

const (
	SubjectKindJob      SubjectKind = "job"
	SubjectKindPlaybook SubjectKind = "playbook"
	SubjectKindTalk     SubjectKind = "talk"
)

type Conversation struct {
	ID          int64            `json:"id"`
	Kind        ConversationKind `json:"kind"`
	Parent      *int64           `json:"parent,omitzero"`
	Name        *string          `json:"name,omitzero"`
	Description *string          `json:"description,omitzero"`
	Project     *string          `json:"project,omitzero"`
	Channel     *int64           `json:"channel,omitzero"`
	SubjectKind *SubjectKind     `json:"subjectKind,omitzero"`
	SubjectID   *string          `json:"subjectId,omitzero"`
	LastSeq     *int64           `json:"lastSeq,omitzero"`
	Replies     int64            `json:"replies"`
	Read        *int64           `json:"read,omitzero"`
	At          int64            `json:"at"`
}

type Conflict struct {
	Base  string   `json:"base"`
	Files []string `json:"files"`
}

type WorkerAction string

const (
	WorkerActionRunCommand   WorkerAction = "run_command"
	WorkerActionReadFile     WorkerAction = "read_file"
	WorkerActionEditFile     WorkerAction = "edit_file"
	WorkerActionSearch       WorkerAction = "search"
	WorkerActionWeb          WorkerAction = "web"
	WorkerActionMCP          WorkerAction = "mcp"
	WorkerActionWait         WorkerAction = "wait"
	WorkerActionOther        WorkerAction = "other"
	WorkerActionThinking     WorkerAction = "thinking"
	WorkerActionSpeakingText WorkerAction = "speaking_text"
	WorkerActionNone         WorkerAction = "none"
)

type Doing struct {
	Action WorkerAction `json:"action"`
	Label  string       `json:"label"`
}

//vibevalley:union _tag
type Phase struct{ Value PhaseValue }

type LastTurn struct {
	Outcome Outcome `json:"outcome"`
	Summary string  `json:"summary"`
	At      int64   `json:"at"`
	Spent   *Spent  `json:"spent,omitzero"`
}

type HelperPlaybook struct {
	ID   string  `json:"id"`
	Node *string `json:"node,omitzero"`
}

type ActionStep struct {
	At     int64        `json:"at"`
	Action WorkerAction `json:"action"`
	Label  string       `json:"label"`
}

type HelperPlay struct {
	Station       int64            `json:"station"`
	History       []ActionStep     `json:"history"`
	ToolsThisTurn int64            `json:"toolsThisTurn"`
	Counts        map[string]int64 `json:"counts"`
	Files         []string         `json:"files"`
	Commands      []string         `json:"commands"`
	TurnStartedAt *int64           `json:"turnStartedAt,omitzero"`
}

type Helper struct {
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Agent    string          `json:"agent"`
	Runtime  string          `json:"runtime"`
	Task     string          `json:"task"`
	Project  *string         `json:"project,omitzero"`
	Branch   *string         `json:"branch,omitzero"`
	Worktree *string         `json:"worktree,omitzero"`
	Conflict *Conflict       `json:"conflict,omitzero"`
	HiredAt  int64           `json:"hiredAt"`
	Turns    int64           `json:"turns"`
	Phase    Phase           `json:"phase"`
	Last     *LastTurn       `json:"last,omitzero"`
	Spent    *Spent          `json:"spent,omitzero"`
	Playbook *HelperPlaybook `json:"playbook,omitzero"`
	Channel  *int64          `json:"channel,omitzero"`
	Play     *HelperPlay     `json:"play,omitzero"`
	Issue    *string         `json:"issue,omitzero"`
}

type CommitCount struct {
	Total int64  `json:"total"`
	Repos []Repo `json:"repos"`
}

type PlaybookState string

const (
	PlaybookStatePlanning  PlaybookState = "planning"
	PlaybookStateDraft     PlaybookState = "draft"
	PlaybookStateRunning   PlaybookState = "running"
	PlaybookStatePaused    PlaybookState = "paused"
	PlaybookStateRipe      PlaybookState = "ripe"
	PlaybookStateDone      PlaybookState = "done"
	PlaybookStateAbandoned PlaybookState = "abandoned"
)

type NodeState string

const (
	NodeStateWaiting NodeState = "waiting"
	NodeStateWorking NodeState = "working"
	NodeStateMerged  NodeState = "merged"
	NodeStateFailed  NodeState = "failed"
	NodeStateSkipped NodeState = "skipped"
)

type PlaybookNode struct {
	ID         string    `json:"id"`
	Title      string    `json:"title"`
	Task       string    `json:"task"`
	Needs      []string  `json:"needs"`
	Agent      *string   `json:"agent,omitzero"`
	Check      *string   `json:"check,omitzero"`
	Scope      []string  `json:"scope,omitzero"`
	Acceptance *bool     `json:"acceptance,omitzero"`
	Frozen     []string  `json:"frozen,omitzero"`
	State      NodeState `json:"state"`
	Helper     *string   `json:"helper,omitzero"`
	Conclusion *string   `json:"conclusion,omitzero"`
	Commits    []string  `json:"commits,omitzero"`
	Spent      *Spent    `json:"spent,omitzero"`
	Tries      int64     `json:"tries"`
	// A retry starts Tries over, not this.
	Failures int64 `json:"failures,omitzero"`
}

type Playbook struct {
	ID        string         `json:"id"`
	Title     string         `json:"title"`
	Goal      string         `json:"goal"`
	Project   string         `json:"project"`
	Branch    *string        `json:"branch,omitzero"`
	State     PlaybookState  `json:"state"`
	Nodes     []PlaybookNode `json:"nodes"`
	Parallel  int64          `json:"parallel"`
	Note      *string        `json:"note,omitzero"`
	CreatedAt int64          `json:"createdAt"`
}

type Unlock struct {
	ID   string `json:"id"`
	Tier int64  `json:"tier"`
	At   int64  `json:"at"`
}

type AgentTally struct {
	Hired     int64 `json:"hired"`
	Harvested int64 `json:"harvested"`
	Failed    int64 `json:"failed"`
}

type Progress struct {
	Coins      int64                 `json:"coins"`
	Streak     int64                 `json:"streak"`
	BestStreak int64                 `json:"bestStreak"`
	Counts     map[string]int64      `json:"counts"`
	Unlocked   []Unlock              `json:"unlocked"`
	Title      *ProgressTitle        `json:"title,omitzero"`
	Agents     map[string]AgentTally `json:"agents,omitzero"`
}

type ProgressNews struct {
	Coins    *int64   `json:"coins,omitzero"`
	Helper   *string  `json:"helper,omitzero"`
	Unlocked []Unlock `json:"unlocked,omitzero"`
}

//vibevalley:union kind
type ScheduleWhen struct{ Value ScheduleWhenValue }

type FarmSchedule struct {
	ID      int64        `json:"id"`
	Name    string       `json:"name"`
	Text    string       `json:"text"`
	Channel int64        `json:"channel"`
	Agent   *string      `json:"agent,omitzero"`
	Project *string      `json:"project,omitzero"`
	When    ScheduleWhen `json:"when"`
	TZ      string       `json:"tz"`
	Enabled bool         `json:"enabled"`
	Created int64        `json:"created"`
	LastRun *int64       `json:"lastRun,omitzero"`
}

type Chat struct {
	Conversations []Conversation `json:"conversations"`
	Messages      []ChatMessage  `json:"messages"`
}

type FarmState struct {
	Call       CallState      `json:"call"`
	CallReason *string        `json:"callReason,omitzero"`
	Foreman    ForemanState   `json:"foreman"`
	Helpers    []Helper       `json:"helpers"`
	Chat       *Chat          `json:"chat,omitzero"`
	Commits    *CommitCount   `json:"commits,omitzero"`
	Progress   *Progress      `json:"progress,omitzero"`
	Schedules  []FarmSchedule `json:"schedules,omitzero"`
	// The open issues and the latest closed (KeepClosedIssues); the database keeps them all.
	Issues []Issue `json:"issues,omitzero"`
}

type StepKind string

const (
	StepKindAsked    StepKind = "asked"
	StepKindRecalled StepKind = "recalled"
	StepKindThought  StepKind = "thought"
	StepKindSaid     StepKind = "said"
	StepKindTool     StepKind = "tool"
	StepKindRetry    StepKind = "retry"
	StepKindProblem  StepKind = "problem"
)

type ToolAction string

const (
	ToolActionRunCommand ToolAction = "run_command"
	ToolActionReadFile   ToolAction = "read_file"
	ToolActionEditFile   ToolAction = "edit_file"
	ToolActionSearch     ToolAction = "search"
	ToolActionWeb        ToolAction = "web"
	ToolActionMCP        ToolAction = "mcp"
	ToolActionWait       ToolAction = "wait"
	ToolActionOther      ToolAction = "other"
)

type WorkStep struct {
	N      int64       `json:"n"`
	At     int64       `json:"at"`
	Kind   StepKind    `json:"kind"`
	Under  *int64      `json:"under,omitzero"`
	Text   string      `json:"text"`
	Action *ToolAction `json:"action,omitzero"`
	Tool   *string     `json:"tool,omitzero"`
	Input  *string     `json:"input,omitzero"`
	Output *string     `json:"output,omitzero"`
	Ok     *bool       `json:"ok,omitzero"`
	On     *int64      `json:"on,omitzero"`
}

type NoticeLevel string

const (
	NoticeLevelInfo  NoticeLevel = "info"
	NoticeLevelWarn  NoticeLevel = "warn"
	NoticeLevelError NoticeLevel = "error"
)

//vibevalley:union status
type Installation struct{ Value InstallationValue }

type ModelEntry struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	EffortLevels []string `json:"effortLevels"`
	IsDefault    bool     `json:"isDefault"`
}

type UsageWindow struct {
	Label       string  `json:"label"`
	UsedPercent float64 `json:"usedPercent"`
	ResetsAt    *int64  `json:"resetsAt"`
}

type Balance struct {
	Currency string  `json:"currency"`
	Amount   float64 `json:"amount"`
}

//vibevalley:union status
type AccountUsage struct{ Value AccountUsageValue }

type InventoryEntry struct {
	Name        string  `json:"name"`
	Description *string `json:"description,omitzero"`
	Source      *string `json:"source,omitzero"`
	Enabled     *bool   `json:"enabled,omitzero"`
}

type RuntimeSettings struct {
	Enabled       bool              `json:"enabled"`
	BinPath       string            `json:"binPath"`
	DefaultModel  string            `json:"defaultModel"`
	DefaultEffort string            `json:"defaultEffort"`
	Env           map[string]string `json:"env"`
	DailyBudget   *float64          `json:"dailyBudget,omitzero"`
	MaxWorking    *int64            `json:"maxWorking,omitzero"`
}

type RuntimeInfo struct {
	ID           string           `json:"id"`
	Installation Installation     `json:"installation"`
	Models       []ModelEntry     `json:"models" vibevalley:"null"`
	Usage        AccountUsage     `json:"usage" vibevalley:"null"`
	Update       *Update          `json:"update"`
	Skills       []InventoryEntry `json:"skills" vibevalley:"null"`
	MCPServers   []InventoryEntry `json:"mcpServers" vibevalley:"null"`
	Tools        []InventoryEntry `json:"tools" vibevalley:"null"`
	Settings     RuntimeSettings  `json:"settings"`
	SpentToday   *float64         `json:"spentToday,omitzero"`
	CheckedAt    int64            `json:"checkedAt"`
}

type FarmLevel struct {
	Level int64 `json:"level"`
	Xp    int64 `json:"xp"`
	Need  int64 `json:"need"`
}

type InboxKind string

const (
	InboxKindHarvest    InboxKind = "harvest"
	InboxKindFix        InboxKind = "fix"
	InboxKindConflict   InboxKind = "conflict"
	InboxKindQuiet      InboxKind = "quiet"
	InboxKindPlanDraft  InboxKind = "plan-draft"
	InboxKindPlanRipe   InboxKind = "plan-ripe"
	InboxKindPlanFailed InboxKind = "plan-failed"
	InboxKindMention    InboxKind = "mention"
)

//vibevalley:union kind
type InboxFrom struct{ Value InboxFromValue }

//vibevalley:union kind
type InboxTarget struct{ Value InboxTargetValue }

// The id stays while the same thing stands.
type InboxItem struct {
	ID     string      `json:"id"`
	Kind   InboxKind   `json:"kind"`
	From   InboxFrom   `json:"from"`
	Text   string      `json:"text"`
	At     int64       `json:"at"`
	Target InboxTarget `json:"target"`
}

type Crop string

const (
	CropEmpty     Crop = "empty"
	CropSeeded    Crop = "seeded"
	CropSprout    Crop = "sprout"
	CropLeafy     Crop = "leafy"
	CropFlowering Crop = "flowering"
	CropWheat     Crop = "wheat"
	CropCarrot    Crop = "carrot"
	CropWithered  Crop = "withered"
	CropWeeds     Crop = "weeds"
	CropDry       Crop = "dry"
	CropHarvested Crop = "harvested"
	CropLocked    Crop = "locked"
)

type BadgeTone string

const (
	BadgeToneRipe  BadgeTone = "ripe"
	BadgeToneBug   BadgeTone = "bug"
	BadgeToneStuck BadgeTone = "stuck"
	BadgeToneRest  BadgeTone = "rest"
)

type PlotView struct {
	Crop  Crop   `json:"crop"`
	Badge *Badge `json:"badge,omitzero"`
}

type FarmView struct {
	Level FarmLevel           `json:"level"`
	Plots map[string]PlotView `json:"plots"`
}

//vibevalley:union kind
type GameEffect struct{ Value GameEffectValue }

type SiteFrame struct {
	State   FarmState    `json:"state"`
	Inbox   []InboxItem  `json:"inbox"`
	Plans   []Playbook   `json:"plans"`
	View    FarmView     `json:"view"`
	Effects []GameEffect `json:"effects"`
}

//vibevalley:union kind
type LedgerEntry struct{ Value LedgerEntryValue }

type PlaybookEventKind string

const (
	PlaybookEventKindPlanning     PlaybookEventKind = "planning"
	PlaybookEventKindDrafted      PlaybookEventKind = "drafted"
	PlaybookEventKindStarted      PlaybookEventKind = "started"
	PlaybookEventKindPaused       PlaybookEventKind = "paused"
	PlaybookEventKindResumed      PlaybookEventKind = "resumed"
	PlaybookEventKindRipe         PlaybookEventKind = "ripe"
	PlaybookEventKindHarvested    PlaybookEventKind = "harvested"
	PlaybookEventKindAbandoned    PlaybookEventKind = "abandoned"
	PlaybookEventKindNoted        PlaybookEventKind = "noted"
	PlaybookEventKindNodeStarted  PlaybookEventKind = "node_started"
	PlaybookEventKindNodeSentBack PlaybookEventKind = "node_sent_back"
	PlaybookEventKindNodeMerged   PlaybookEventKind = "node_merged"
	PlaybookEventKindNodeFailed   PlaybookEventKind = "node_failed"
	PlaybookEventKindNodeRetried  PlaybookEventKind = "node_retried"
	PlaybookEventKindNodeRequeued PlaybookEventKind = "node_requeued"
	PlaybookEventKindNodeSkipped  PlaybookEventKind = "node_skipped"
	PlaybookEventKindNodeEdited   PlaybookEventKind = "node_edited"
	PlaybookEventKindNodeAdded    PlaybookEventKind = "node_added"
	PlaybookEventKindNodeRemoved  PlaybookEventKind = "node_removed"
)

type PlaybookActor string

const (
	PlaybookActorUser    PlaybookActor = "user"
	PlaybookActorForeman PlaybookActor = "foreman"
	PlaybookActorFarm    PlaybookActor = "farm"
)

type NodeFieldChange struct {
	Field string `json:"field"`
	From  string `json:"from"`
	To    string `json:"to"`
}

type PlaybookEvent struct {
	Seq      int64             `json:"seq"`
	Playbook string            `json:"playbook"`
	Node     *string           `json:"node,omitzero"`
	Kind     PlaybookEventKind `json:"kind"`
	Actor    PlaybookActor     `json:"actor"`
	Helper   *string           `json:"helper,omitzero"`
	Detail   *string           `json:"detail,omitzero"`
	Changes  []NodeFieldChange `json:"changes,omitzero"`
	Commits  []string          `json:"commits,omitzero"`
	At       int64             `json:"at"`
}

type LanDevice struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	PairedAt int64  `json:"pairedAt"`
	LastSeen *int64 `json:"lastSeen,omitzero"`
}

type LanPaired struct {
	Device string `json:"device"`
	Key    string `json:"key"`
	Farm   string `json:"farm"`
}

type LanPairRequest struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

type LanStatus struct {
	Open    bool        `json:"open"`
	Farm    string      `json:"farm"`
	URL     *string     `json:"url,omitzero"`
	Problem *string     `json:"problem,omitzero"`
	Pairing *LanPairing `json:"pairing,omitzero"`
	Devices []LanDevice `json:"devices"`
}

type LanPairing struct {
	Code      string  `json:"code"`
	Link      string  `json:"link"`
	ExpiresAt int64   `json:"expiresAt"`
	Asking    *string `json:"asking,omitzero"`
}

type ConnectorStatus struct {
	ID          ConnectorID    `json:"id"`
	State       ConnectorState `json:"state"`
	Qr          *string        `json:"qr,omitzero"`
	PairCode    *string        `json:"pairCode,omitzero"`
	Channel     *string        `json:"channel,omitzero"`
	Owner       *string        `json:"owner,omitzero"`
	Since       *int64         `json:"since,omitzero"`
	LastInbound *int64         `json:"lastInbound,omitzero"`
	PausedUntil *int64         `json:"pausedUntil,omitzero"`
	Pending     int64          `json:"pending"`
	Error       *string        `json:"error,omitzero"`
}

type ConnectorState string

const (
	ConnectorStateOff       ConnectorState = "off"
	ConnectorStateWaiting   ConnectorState = "waiting"
	ConnectorStateScanned   ConnectorState = "scanned"
	ConnectorStateVerify    ConnectorState = "verify"
	ConnectorStatePairing   ConnectorState = "pairing"
	ConnectorStateConnected ConnectorState = "connected"
	ConnectorStatePaused    ConnectorState = "paused"
)

type ConnectorLogin struct {
	Force  *bool   `json:"force,omitzero"`
	AppID  *string `json:"appId,omitzero"`
	Secret *string `json:"secret,omitzero"`
}

type VoiceAgent struct {
	AgentID string `json:"agentId"`
}

type VoiceCaptions string

const (
	VoiceCaptionsRtm        VoiceCaptions = "rtm"
	VoiceCaptionsDatastream VoiceCaptions = "datastream"
)

type VoiceSession struct {
	AppID   string `json:"appId"`
	Channel string `json:"channel"`
	UID     string `json:"uid"`
	Token   string `json:"token"`
}

type ProjectActivity struct {
	Project string     `json:"project"`
	At      int64      `json:"at"`
	Days    []DayCount `json:"days"`
	Authors []Author   `json:"authors"`
	Total   int64      `json:"total"`
	First   *int64     `json:"first,omitzero"`
	Last    *int64     `json:"last,omitzero"`
}

type DayCount struct {
	Day     string `json:"day"`
	Commits int64  `json:"commits"`
}

type ProjectLanguages struct {
	Project   string          `json:"project"`
	At        int64           `json:"at"`
	Languages []LanguageCount `json:"languages"`
}

type LanguageCount struct {
	Name     string `json:"name"`
	Files    int64  `json:"files"`
	Code     int64  `json:"code"`
	Comments int64  `json:"comments"`
	Blanks   int64  `json:"blanks"`
}

type ProjectSummary struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Git  bool   `json:"git"`
	Last *int64 `json:"last,omitzero"`
	// Never more than the farm's beds.
	Slots int64 `json:"slots"`
}

type NewProject struct {
	Name   string  `json:"name"`
	Github *string `json:"github,omitzero"`
}

type Skill struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Body        string `json:"body"`
}

type ArchiveListing struct {
	Files []ArchiveFile `json:"files"`
	Hits  []ArchiveHit  `json:"hits"`
}

type ArchiveHit struct {
	File string `json:"file"`
	Line int64  `json:"line"`
	Text string `json:"text"`
}

type ArchiveFile struct {
	Name  string `json:"name"`
	At    int64  `json:"at"`
	Chars int64  `json:"chars"`
}

type Memory struct {
	ID         string     `json:"id"`
	Agent      string     `json:"agent"`
	Kind       MemoryKind `json:"kind"`
	Text       string     `json:"text"`
	Project    *string    `json:"project,omitzero"`
	Helper     *string    `json:"helper,omitzero"`
	At         int64      `json:"at"`
	Recalled   int64      `json:"recalled"`
	RecalledAt *int64     `json:"recalledAt,omitzero"`
}

type MemoryKind string

const (
	MemoryKindNote MemoryKind = "note"
	MemoryKindJob  MemoryKind = "job"
)

type MemoryRequest struct {
	Text    string  `json:"text"`
	Project *string `json:"project,omitzero"`
}

type ManagerMemory struct {
	Runtime  Runtime  `json:"runtime"`
	File     string   `json:"file"`
	Memories []Memory `json:"memories"`
	Carried  int64    `json:"carried"`
}

type AgentProfile struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	Role            string            `json:"role"`
	Enabled         bool              `json:"enabled"`
	Runtime         string            `json:"runtime"`
	Model           string            `json:"model"`
	Effort          string            `json:"effort"`
	Persona         string            `json:"persona"`
	PersonaMode     PersonaMode       `json:"personaMode"`
	Skills          []string          `json:"skills"`
	MCPServers      []MCPServer       `json:"mcpServers"`
	DisallowedTools []string          `json:"disallowedTools"`
	Env             map[string]string `json:"env"`
	Workdir         string            `json:"workdir"`
	Worktree        bool              `json:"worktree"`
	Tags            []string          `json:"tags"`
	Look            Look              `json:"look"`
}

type Look struct {
	Species *Species `json:"species,omitzero"`
	Outfit  *Outfit  `json:"outfit,omitzero"`
	Build   Build    `json:"build"`
	Head    Head     `json:"head"`
	Body    string   `json:"body"`
	Trim    string   `json:"trim"`
	Hat     string   `json:"hat"`
	Eye     string   `json:"eye"`
}

type Head string

const (
	HeadRounded  Head = "rounded"
	HeadTerminal Head = "terminal"
	HeadDome     Head = "dome"
	HeadOrb      Head = "orb"
	HeadSaucer   Head = "saucer"
)

type Build string

const (
	BuildBiped  Build = "biped"
	BuildTreads Build = "treads"
	BuildWheel  Build = "wheel"
	BuildHopper Build = "hopper"
	BuildHover  Build = "hover"
)

type Outfit string

const (
	OutfitFarmer   Outfit = "farmer"
	OutfitGardener Outfit = "gardener"
	OutfitRain     Outfit = "rain"
	OutfitWinter   Outfit = "winter"
)

type Species string

const (
	SpeciesBear     Species = "bear"
	SpeciesRabbit   Species = "rabbit"
	SpeciesFox      Species = "fox"
	SpeciesCat      Species = "cat"
	SpeciesOwl      Species = "owl"
	SpeciesHedgehog Species = "hedgehog"
	SpeciesRaccoon  Species = "raccoon"
)

type PersonaMode string

const (
	PersonaModeAppend  PersonaMode = "append"
	PersonaModeReplace PersonaMode = "replace"
	PersonaModePrompt  PersonaMode = "prompt"
)

type Changes struct {
	Project     string            `json:"project"`
	Base        string            `json:"base"`
	Branch      *string           `json:"branch,omitzero"`
	Commits     []Commit          `json:"commits"`
	Files       []ChangedFile     `json:"files"`
	Uncommitted []UncommittedItem `json:"uncommitted"`
	Conflicts   []string          `json:"conflicts"`
	Behind      int64             `json:"behind"`
}

type ChangedFile struct {
	Path    string  `json:"path"`
	Status  string  `json:"status"`
	Added   int64   `json:"added"`
	Removed int64   `json:"removed"`
	Patch   *string `json:"patch,omitzero"`
}

type NodeAction string

const (
	NodeActionRetry NodeAction = "retry"
	NodeActionSkip  NodeAction = "skip"
)

type PlaybookAction string

const (
	PlaybookActionStart   PlaybookAction = "start"
	PlaybookActionPause   PlaybookAction = "pause"
	PlaybookActionResume  PlaybookAction = "resume"
	PlaybookActionAbandon PlaybookAction = "abandon"
	PlaybookActionHarvest PlaybookAction = "harvest"
)

type NodeEdit struct {
	Title *string  `json:"title,omitzero"`
	Task  *string  `json:"task,omitzero"`
	Needs []string `json:"needs,omitzero"`
	Agent *string  `json:"agent,omitzero"`
	Check *string  `json:"check,omitzero"`
	Scope []string `json:"scope,omitzero"`
}

type PlanRequest struct {
	Goal    string  `json:"goal"`
	Project string  `json:"project"`
	Agent   *string `json:"agent,omitzero"`
}

type Dispatched struct {
	Helper *string `json:"helper,omitzero"`
	Queued *string `json:"queued,omitzero"`
}

type Issue struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Description string   `json:"description,omitzero"`
	Project     *string  `json:"project,omitzero"`
	Agent       *string  `json:"agent,omitzero"`
	Priority    Priority `json:"priority"`
	// First lowest.
	Rank      int64       `json:"rank,omitzero"`
	CreatedAt int64       `json:"createdAt"`
	QueuedAt  *int64      `json:"queuedAt,omitzero"`
	Runs      []string    `json:"runs"`
	ClosedAt  *int64      `json:"closedAt,omitzero"`
	Closed    *IssueClose `json:"closed,omitzero"`
	Parent    *string     `json:"parent,omitzero"`
	BlockedBy []string    `json:"blockedBy,omitzero"`
	Plan      *IssuePlan  `json:"plan,omitzero"`
	Step      *IssueStep  `json:"step,omitzero"`
	Schedule  *int64      `json:"schedule,omitzero"`
	Status    IssueStatus `json:"status"`
}

type IssuePlan struct {
	State    PlaybookState `json:"state"`
	Branch   *string       `json:"branch,omitzero"`
	Parallel int64         `json:"parallel"`
	Note     *string       `json:"note,omitzero"`
}

type IssueStep struct {
	Key        string    `json:"key"`
	State      NodeState `json:"state"`
	Check      *string   `json:"check,omitzero"`
	Scope      []string  `json:"scope,omitzero"`
	Acceptance *bool     `json:"acceptance,omitzero"`
	Frozen     []string  `json:"frozen,omitzero"`
	Helper     *string   `json:"helper,omitzero"`
	Conclusion *string   `json:"conclusion,omitzero"`
	Commits    []string  `json:"commits,omitzero"`
	Spent      *Spent    `json:"spent,omitzero"`
	Tries      int64     `json:"tries"`
	Failures   int64     `json:"failures,omitzero"`
}

type IssueStatus string

const (
	IssueStatusTodo    IssueStatus = "todo"
	IssueStatusQueued  IssueStatus = "queued"
	IssueStatusWorking IssueStatus = "working"
	IssueStatusWaiting IssueStatus = "waiting"
	IssueStatusClosed  IssueStatus = "closed"
)

type Priority string

const (
	PriorityUrgent Priority = "urgent"
	PriorityHigh   Priority = "high"
	PriorityNormal Priority = "normal"
	PriorityLow    Priority = "low"
)

type IssueRequest struct {
	Title       string    `json:"title"`
	Description string    `json:"description,omitzero"`
	Project     *string   `json:"project,omitzero"`
	Agent       *string   `json:"agent,omitzero"`
	Priority    *Priority `json:"priority,omitzero"`
}

type Trajectory struct {
	Head  TrajectoryHead `json:"head"`
	Steps []WorkStep     `json:"steps"`
}

type TrajectoryHead struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Agent        *string         `json:"agent,omitzero"`
	Runtime      *string         `json:"runtime,omitzero"`
	Project      *string         `json:"project,omitzero"`
	Job          *string         `json:"job,omitzero"`
	StartedAt    int64           `json:"startedAt"`
	EndedAt      *int64          `json:"endedAt,omitzero"`
	Closed       *IssueClose     `json:"closed,omitzero"`
	Outcome      *Outcome        `json:"outcome,omitzero"`
	Summary      *string         `json:"summary,omitzero"`
	Turns        *int64          `json:"turns,omitzero"`
	CNY          *float64        `json:"cny,omitzero"`
	ReopenedFrom *string         `json:"reopenedFrom,omitzero"`
	ReopenedAs   *string         `json:"reopenedAs,omitzero"`
	Playbook     *HelperPlaybook `json:"playbook,omitzero"`
	// ReopenedFrom and ReopenedAs are how runs told it before issues.
	Issue *string `json:"issue,omitzero"`
}

type IssueClose string

const (
	IssueCloseHarvested IssueClose = "harvested"
	IssueCloseMerged    IssueClose = "merged"
	IssueCloseDismissed IssueClose = "dismissed"
	IssueCloseLost      IssueClose = "lost"
)

type TellRequest struct {
	Text string `json:"text"`
	On   *int64 `json:"on,omitzero"`
}

type SayRequest struct {
	Text         string  `json:"text"`
	Bed          *int64  `json:"bed,omitzero"`
	Conversation *int64  `json:"conversation,omitzero"`
	Agent        *string `json:"agent,omitzero"`
}

type ChannelUpdate struct {
	Description *string `json:"description,omitzero"`
	Project     *string `json:"project,omitzero"`
}

type ScheduleRequest struct {
	Name    string       `json:"name"`
	Text    string       `json:"text"`
	Channel *int64       `json:"channel,omitzero"`
	Agent   *string      `json:"agent,omitzero"`
	Project *string      `json:"project,omitzero"`
	When    ScheduleWhen `json:"when"`
	TZ      *string      `json:"tz,omitzero"`
}

type ChannelRequest struct {
	Name        string  `json:"name"`
	Description *string `json:"description,omitzero"`
	Project     *string `json:"project,omitzero"`
}

type SettingsStatus struct {
	File                string        `json:"file"`
	DeepseekAPIKey      KeyStatus     `json:"deepseekApiKey"`
	AgoraAppID          AgoraAppID    `json:"agoraAppId"`
	AgoraAppCertificate KeyStatus     `json:"agoraAppCertificate"`
	Voice               VoiceSettings `json:"voice"`
	VoiceDefaults       VoiceSettings `json:"voiceDefaults"`
	ASRKey              KeyStatus     `json:"asrKey"`
	LLMKey              KeyStatus     `json:"llmKey"`
	TTSKey              KeyStatus     `json:"ttsKey"`
}

type KeyStatus struct {
	Source *KeySource `json:"source,omitzero"`
	Hint   *string    `json:"hint,omitzero"`
}

type KeySource string

const (
	KeySourceSettings KeySource = "settings"
	KeySourceEnv      KeySource = "env"
	KeySourcePi       KeySource = "pi"
)

type VoiceSettings struct {
	Area           Area     `json:"area"`
	Language       Language `json:"language"`
	ASR            VoiceASR `json:"asr"`
	LLM            VoiceLLM `json:"llm"`
	TTS            VoiceTTS `json:"tts"`
	Persona        string   `json:"persona"`
	Greeting       string   `json:"greeting"`
	FailureMessage string   `json:"failureMessage"`
	SilenceMs      int64    `json:"silenceMs"`
	InterruptMs    int64    `json:"interruptMs"`
	IdleSeconds    int64    `json:"idleSeconds"`
}

type SettingsUpdate struct {
	DeepseekAPIKey      *string              `json:"deepseekApiKey,omitzero"`
	AgoraAppID          *string              `json:"agoraAppId,omitzero"`
	AgoraAppCertificate *string              `json:"agoraAppCertificate,omitzero"`
	Voice               *SettingsUpdateVoice `json:"voice,omitzero"`
	ASRKey              *string              `json:"asrKey,omitzero"`
	LLMKey              *string              `json:"llmKey,omitzero"`
	TTSKey              *string              `json:"ttsKey,omitzero"`
}

type Health struct {
	Ok      bool   `json:"ok"`
	Version string `json:"version"`
}

//vibevalley:member Phase arriving
type PhaseArriving struct {
}

type Retry struct {
	Attempt int64  `json:"attempt"`
	Of      *int64 `json:"of,omitzero"`
}

//vibevalley:member Phase working
type PhaseWorking struct {
	Since      int64  `json:"since"`
	Doing      Doing  `json:"doing"`
	QuietSince *int64 `json:"quietSince,omitzero"`
	Retry      *Retry `json:"retry,omitzero"`
}

//vibevalley:member Phase ripe
type PhaseRipe struct {
}

//vibevalley:member Phase failed
type PhaseFailed struct {
}

//vibevalley:member Phase resting
type PhaseResting struct {
}

type Repo struct {
	Path    string `json:"path"`
	Commits int64  `json:"commits"`
}

type ProgressTitle struct {
	ID   string `json:"id"`
	Tier int64  `json:"tier"`
}

//vibevalley:member ScheduleWhen once
type ScheduleWhenOnce struct {
	At int64 `json:"at"`
}

//vibevalley:member ScheduleWhen every
type ScheduleWhenEvery struct {
	Minutes float64 `json:"minutes"`
}

//vibevalley:member ScheduleWhen daily
type ScheduleWhenDaily struct {
	Time string `json:"time"`
}

//vibevalley:member ScheduleWhen weekly
type ScheduleWhenWeekly struct {
	Days []int64 `json:"days"`
	Time string  `json:"time"`
}

type Via string

const (
	ViaExecutable Via = "executable"
	ViaBundled    Via = "bundled"
)

//vibevalley:member Installation available
type InstallationAvailable struct {
	Via     Via     `json:"via"`
	Command string  `json:"command"`
	Version *string `json:"version"`
}

//vibevalley:member Installation not_found
type InstallationNotFound struct {
}

//vibevalley:member Installation unsupported
type InstallationUnsupported struct {
	Reason string `json:"reason"`
}

//vibevalley:member AccountUsage ok
type AccountUsageOk struct {
	Plan    *string       `json:"plan"`
	Windows []UsageWindow `json:"windows"`
}

//vibevalley:member AccountUsage balance
type AccountUsageBalance struct {
	Provider  string    `json:"provider"`
	Available bool      `json:"available"`
	Balances  []Balance `json:"balances"`
}

//vibevalley:member AccountUsage login_required
type AccountUsageLoginRequired struct {
}

//vibevalley:member AccountUsage unavailable
type AccountUsageUnavailable struct {
	Reason string `json:"reason"`
}

type Update struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Available bool   `json:"available"`
}

//vibevalley:member InboxFrom helper
type InboxFromHelper struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Agent string `json:"agent"`
}

//vibevalley:member InboxFrom manager
type InboxFromManager struct {
}

//vibevalley:member InboxTarget worker
type InboxTargetWorker struct {
	ID string `json:"id"`
}

//vibevalley:member InboxTarget plans
type InboxTargetPlans struct {
	Playbook string `json:"playbook"`
}

//vibevalley:member InboxTarget chat
type InboxTargetChat struct {
	Conversation int64 `json:"conversation"`
}

//vibevalley:dart PlotViewBadge
type Badge struct {
	Text string    `json:"text"`
	Tone BadgeTone `json:"tone"`
}

//vibevalley:member GameEffect reward
type GameEffectReward struct {
	WorkerID string `json:"workerId"`
	Coins    int64  `json:"coins"`
	Streak   int64  `json:"streak"`
}

//vibevalley:member GameEffect penalty
type GameEffectPenalty struct {
	WorkerID string `json:"workerId"`
}

//vibevalley:member GameEffect levelUp
type GameEffectLevelUp struct {
	Level int64 `json:"level"`
}

//vibevalley:member GameEffect achievement
type GameEffectAchievement struct {
	Achievement string `json:"achievement"`
	Tier        int64  `json:"tier"`
}

//vibevalley:member LedgerEntry harvested
type LedgerEntryHarvested struct {
	At      int64    `json:"at"`
	Helper  string   `json:"helper"`
	Agent   *string  `json:"agent,omitzero"`
	Project string   `json:"project"`
	Runtime string   `json:"runtime"`
	Commits int64    `json:"commits"`
	CNY     *float64 `json:"cny,omitzero"`
	Turns   int64    `json:"turns"`
}

//vibevalley:member LedgerEntry failed
type LedgerEntryFailed struct {
	At     int64   `json:"at"`
	Helper string  `json:"helper"`
	Agent  *string `json:"agent,omitzero"`
}

//vibevalley:member LedgerEntry conflicted
type LedgerEntryConflicted struct {
	At     int64  `json:"at"`
	Helper string `json:"helper"`
}

//vibevalley:member LedgerEntry told
type LedgerEntryTold struct {
	At     int64  `json:"at"`
	Helper string `json:"helper"`
}

//vibevalley:member LedgerEntry reviewed
type LedgerEntryReviewed struct {
	At     int64  `json:"at"`
	Helper string `json:"helper"`
}

//vibevalley:member LedgerEntry playbook
type LedgerEntryPlaybook struct {
	At       int64  `json:"at"`
	Playbook string `json:"playbook"`
	Merged   int64  `json:"merged"`
	Parallel bool   `json:"parallel"`
}

//vibevalley:member LedgerEntry handoff
type LedgerEntryHandoff struct {
	At     int64  `json:"at"`
	Helper string `json:"helper"`
	To     string `json:"to"`
}

//vibevalley:member LedgerEntry called
type LedgerEntryCalled struct {
	At     int64  `json:"at"`
	Helper string `json:"helper"`
}

//vibevalley:member LedgerEntry hired
type LedgerEntryHired struct {
	At     int64   `json:"at"`
	Helper string  `json:"helper"`
	Agent  *string `json:"agent,omitzero"`
}

type LedgerEntryOpenedPlannedVoiceBusy6Kind string

const (
	LedgerEntryOpenedPlannedVoiceBusy6KindOpened  LedgerEntryOpenedPlannedVoiceBusy6Kind = "opened"
	LedgerEntryOpenedPlannedVoiceBusy6KindPlanned LedgerEntryOpenedPlannedVoiceBusy6Kind = "planned"
	LedgerEntryOpenedPlannedVoiceBusy6KindVoice   LedgerEntryOpenedPlannedVoiceBusy6Kind = "voice"
	LedgerEntryOpenedPlannedVoiceBusy6KindBusy6   LedgerEntryOpenedPlannedVoiceBusy6Kind = "busy6"
)

//vibevalley:member LedgerEntry opened planned voice busy6
type LedgerEntryOpenedPlannedVoiceBusy6 struct {
	Kind LedgerEntryOpenedPlannedVoiceBusy6Kind `json:"kind"`
	At   int64                                  `json:"at"`
}

//vibevalley:member LedgerEntry level
type LedgerEntryLevel struct {
	At    int64 `json:"at"`
	Level int64 `json:"level"`
}

//vibevalley:member LedgerEntry titled
type LedgerEntryTitled struct {
	At          int64   `json:"at"`
	Achievement *string `json:"achievement,omitzero"`
	Tier        *int64  `json:"tier,omitzero"`
}

//vibevalley:member LedgerEntry carried
type LedgerEntryCarried struct {
	At    int64 `json:"at"`
	Coins int64 `json:"coins"`
}

type ConnectorID string

const (
	ConnectorIDWeixin ConnectorID = "weixin"
	ConnectorIDFeishu ConnectorID = "feishu"
	ConnectorIDQq     ConnectorID = "qq"
)

type Author struct {
	Name    string `json:"name"`
	Commits int64  `json:"commits"`
}

type Runtime string

const (
	RuntimeVibeValley Runtime = "vibevalley"
	RuntimePi         Runtime = "pi"
)

//vibevalley:union type
type MCPServer struct{ Value MCPServerValue }

//vibevalley:member MCPServer stdio
type MCPServerStdio struct {
	Name    string            `json:"name"`
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
}

//vibevalley:member MCPServer http
type MCPServerHTTP struct {
	Name    string            `json:"name"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
}

type Commit struct {
	Hash    string `json:"hash"`
	Subject string `json:"subject"`
	At      int64  `json:"at"`
}

type UncommittedItem struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

type AgoraAppID struct {
	Source *KeySource `json:"source,omitzero"`
	Value  *string    `json:"value,omitzero"`
}

type Area string

const (
	AreaUS Area = "US"
	AreaEU Area = "EU"
	AreaAP Area = "AP"
	AreaCN Area = "CN"
)

type Language string

const (
	LanguageZhCN Language = "zh-CN"
	LanguageZhHK Language = "zh-HK"
	LanguageZhTW Language = "zh-TW"
	LanguageEnUS Language = "en-US"
	LanguageJaJP Language = "ja-JP"
	LanguageKoKR Language = "ko-KR"
)

//vibevalley:union vendor
type VoiceASR struct{ Value VoiceASRValue }

//vibevalley:member VoiceASR ares
type VoiceASRAres struct {
}

type Model string

const (
	ModelNova2 Model = "nova-2"
	ModelNova3 Model = "nova-3"
)

//vibevalley:member VoiceASR deepgram
type VoiceASRDeepgram struct {
	Model Model `json:"model"`
}

//vibevalley:member VoiceASR microsoft
type VoiceASRMicrosoft struct {
	Region string `json:"region"`
}

//vibevalley:union vendor
type VoiceLLM struct{ Value VoiceLLMValue }

//vibevalley:member VoiceLLM vibevalley
type VoiceLLMVibeValley struct {
}

type VoiceLLMAgoraModel string

const (
	VoiceLLMAgoraModelGpt4oMini VoiceLLMAgoraModel = "gpt-4o-mini"
	VoiceLLMAgoraModelGpt41Mini VoiceLLMAgoraModel = "gpt-4.1-mini"
	VoiceLLMAgoraModelGpt5Nano  VoiceLLMAgoraModel = "gpt-5-nano"
	VoiceLLMAgoraModelGpt5Mini  VoiceLLMAgoraModel = "gpt-5-mini"
)

//vibevalley:member VoiceLLM agora
type VoiceLLMAgora struct {
	Model VoiceLLMAgoraModel `json:"model"`
}

//vibevalley:member VoiceLLM deepseek
type VoiceLLMDeepseek struct {
	Model string `json:"model"`
}

//vibevalley:member VoiceLLM openai
type VoiceLLMOpenai struct {
	URL   string `json:"url"`
	Model string `json:"model"`
}

//vibevalley:union vendor
type VoiceTTS struct{ Value VoiceTTSValue }

type VoiceTTSMinimaxModel string

const (
	VoiceTTSMinimaxModelSpeech26Turbo VoiceTTSMinimaxModel = "speech_2_6_turbo"
	VoiceTTSMinimaxModelSpeech28Turbo VoiceTTSMinimaxModel = "speech_2_8_turbo"
)

//vibevalley:member VoiceTTS minimax
type VoiceTTSMinimax struct {
	Model   VoiceTTSMinimaxModel `json:"model"`
	VoiceID string               `json:"voiceId"`
}

type Voice string

const (
	VoiceAlloy   Voice = "alloy"
	VoiceEcho    Voice = "echo"
	VoiceFable   Voice = "fable"
	VoiceOnyx    Voice = "onyx"
	VoiceNova    Voice = "nova"
	VoiceShimmer Voice = "shimmer"
)

//vibevalley:member VoiceTTS openai
type VoiceTTSOpenai struct {
	Voice Voice `json:"voice"`
}

//vibevalley:member VoiceTTS microsoft
type VoiceTTSMicrosoft struct {
	Region    string `json:"region"`
	VoiceName string `json:"voiceName"`
}

type SettingsUpdateVoice struct {
	Area           *Area     `json:"area,omitzero"`
	Language       *Language `json:"language,omitzero"`
	ASR            VoiceASR  `json:"asr,omitzero"`
	LLM            VoiceLLM  `json:"llm,omitzero"`
	TTS            VoiceTTS  `json:"tts,omitzero"`
	Persona        *string   `json:"persona,omitzero"`
	Greeting       *string   `json:"greeting,omitzero"`
	FailureMessage *string   `json:"failureMessage,omitzero"`
	SilenceMs      *int64    `json:"silenceMs,omitzero"`
	InterruptMs    *int64    `json:"interruptMs,omitzero"`
	IdleSeconds    *int64    `json:"idleSeconds,omitzero"`
}

type Site struct {
	Fact          Fact          `json:"fact"`
	Event         SiteEvent     `json:"event"`
	Frame         SiteFrame     `json:"frame"`
	Ledger        LedgerEntry   `json:"ledger"`
	PlaybookEvent PlaybookEvent `json:"playbookEvent"`
}

//vibevalley:union type
type Fact struct{ Value FactValue }

//vibevalley:member Fact call
//vibevalley:member SiteEvent call
type FactCall struct {
	At     int64     `json:"at"`
	State  CallState `json:"state"`
	Reason *string   `json:"reason,omitzero"`
}

//vibevalley:member Fact foreman
//vibevalley:member SiteEvent foreman
type FactForeman struct {
	At    int64        `json:"at"`
	State ForemanState `json:"state"`
}

//vibevalley:member Fact message
//vibevalley:member SiteEvent message
type FactMessage struct {
	At      int64       `json:"at"`
	Message ChatMessage `json:"message"`
	Thread  *string     `json:"thread,omitzero"`
	// One that named its speaker in the conversation since the speaker last spoke there.
	Answers *string `json:"answers,omitzero"`
}

//vibevalley:member Fact conversation
//vibevalley:member SiteEvent conversation
type FactConversation struct {
	At           int64        `json:"at"`
	Conversation Conversation `json:"conversation"`
}

//vibevalley:member Fact hired
//vibevalley:member SiteEvent hired
type FactHired struct {
	At      int64  `json:"at"`
	Helper  Helper `json:"helper"`
	Station *int64 `json:"station,omitzero"`
}

//vibevalley:member Fact turn
//vibevalley:member SiteEvent turn
type FactTurn struct {
	At   int64   `json:"at"`
	ID   string  `json:"id"`
	Task *string `json:"task,omitzero"`
}

//vibevalley:member Fact doing
//vibevalley:member SiteEvent doing
type FactDoing struct {
	At     int64        `json:"at"`
	ID     string       `json:"id"`
	Action WorkerAction `json:"action"`
	Label  string       `json:"label"`
}

//vibevalley:member Fact quiet
//vibevalley:member SiteEvent quiet
type FactQuiet struct {
	At    int64  `json:"at"`
	ID    string `json:"id"`
	Since int64  `json:"since"`
}

//vibevalley:member Fact retry
//vibevalley:member SiteEvent retry
type FactRetry struct {
	At      int64  `json:"at"`
	ID      string `json:"id"`
	Attempt int64  `json:"attempt"`
	Of      *int64 `json:"of,omitzero"`
}

//vibevalley:member Fact spent
//vibevalley:member SiteEvent spent
type FactSpent struct {
	At    int64  `json:"at"`
	ID    string `json:"id"`
	Spent Spent  `json:"spent"`
}

//vibevalley:member Fact report
//vibevalley:member SiteEvent report
type FactReport struct {
	At      int64   `json:"at"`
	ID      string  `json:"id"`
	Outcome Outcome `json:"outcome"`
	Summary string  `json:"summary"`
	Turns   int64   `json:"turns"`
	Spent   *Spent  `json:"spent,omitzero"`
}

//vibevalley:member Fact conflict
//vibevalley:member SiteEvent conflict
type FactConflict struct {
	At       int64     `json:"at"`
	ID       string    `json:"id"`
	Conflict *Conflict `json:"conflict,omitzero"`
}

//vibevalley:member Fact left
//vibevalley:member SiteEvent left
type FactLeft struct {
	At     int64       `json:"at"`
	ID     string      `json:"id"`
	Closed *IssueClose `json:"closed,omitzero"`
	Merged *int64      `json:"merged,omitzero"`
}

//vibevalley:member Fact commits
//vibevalley:member SiteEvent commits
type FactCommits struct {
	At      int64       `json:"at"`
	Commits CommitCount `json:"commits"`
}

//vibevalley:member Fact issue
//vibevalley:member SiteEvent issue
type FactIssue struct {
	At    int64 `json:"at"`
	Issue Issue `json:"issue"`
}

//vibevalley:member Fact issueGone
//vibevalley:member SiteEvent issueGone
type FactIssueGone struct {
	At int64  `json:"at"`
	ID string `json:"id"`
}

//vibevalley:member Fact progress
//vibevalley:member SiteEvent progress
type FactProgress struct {
	At       int64         `json:"at"`
	Progress Progress      `json:"progress"`
	News     *ProgressNews `json:"news,omitzero"`
}

//vibevalley:member Fact schedule
//vibevalley:member SiteEvent schedule
type FactSchedule struct {
	At       int64        `json:"at"`
	Schedule FarmSchedule `json:"schedule"`
}

//vibevalley:member Fact unschedule
//vibevalley:member SiteEvent unschedule
type FactUnschedule struct {
	At int64 `json:"at"`
	ID int64 `json:"id"`
}

//vibevalley:union type
type SiteEvent struct{ Value SiteEventValue }

//vibevalley:member SiteEvent snapshot
type SiteEventSnapshot struct {
	At    int64     `json:"at"`
	State FarmState `json:"state"`
}

//vibevalley:member SiteEvent step
type SiteEventStep struct {
	At   int64    `json:"at"`
	ID   string   `json:"id"`
	Step WorkStep `json:"step"`
}

//vibevalley:member SiteEvent notice
type SiteEventNotice struct {
	At    int64       `json:"at"`
	Level NoticeLevel `json:"level"`
	Text  string      `json:"text"`
}

//vibevalley:member SiteEvent runtime
type SiteEventRuntime struct {
	At   int64       `json:"at"`
	Info RuntimeInfo `json:"info"`
}

type ToggleScheduleRequest struct {
	Enabled bool `json:"enabled"`
}

type MoveIssueRequest struct {
	Before *string `json:"before,omitzero"`
}

type QueueIssueRequest struct {
	Queued bool `json:"queued"`
}

type ReopenRequest struct {
	Text string `json:"text"`
}

type PlaybookActRequest struct {
	Action PlaybookAction `json:"action"`
}

type NodeActRequest struct {
	Action NodeAction `json:"action"`
}

type ChatReadRequest struct {
	Seq int64 `json:"seq"`
}

type CarryCoinsRequest struct {
	Coins int64 `json:"coins"`
}

type CarryCoinsResult struct {
	Carried bool `json:"carried"`
}

type ChooseTitleRequest struct {
	Achievement *string `json:"achievement,omitzero"`
	Tier        *int64  `json:"tier,omitzero"`
}

type RenewRequest struct {
	Channel string `json:"channel"`
	UID     string `json:"uid"`
}

type StartRequest struct {
	Channel  string         `json:"channel"`
	UID      string         `json:"uid"`
	Captions *VoiceCaptions `json:"captions,omitzero"`
}

type VerifyRequest struct {
	Code string `json:"code"`
}

type ConnectorsChannelRequest struct {
	Channel string `json:"channel"`
}

type SetOpenRequest struct {
	Open bool `json:"open"`
}

type AnswerPairingRequest struct {
	Allow bool `json:"allow"`
}

//vibevalley:error 409
type FarmRefused struct {
	Reason string `json:"reason"`
}

//vibevalley:error 404
type FarmMissing struct {
	What string `json:"what"`
}

//vibevalley:error 503
type VoiceUnavailable struct {
	Reason string `json:"reason"`
}

//vibevalley:error 502
type VoiceAgentFailed struct {
	Reason string `json:"reason"`
}

//vibevalley:error 409
type ConnectorRefused struct {
	Reason string `json:"reason"`
}

//vibevalley:error 403
type LanRefused struct {
	Reason string `json:"reason"`
}
