package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/vibevalleyhq/vibevalley/internal/domain/agent"
	"github.com/vibevalleyhq/vibevalley/internal/domain/attachment"
	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/internal/domain/connector"
	"github.com/vibevalleyhq/vibevalley/internal/domain/game"
	"github.com/vibevalleyhq/vibevalley/internal/domain/issue"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

// Protocol wire DTOs matching packages/protocol/src/*/schema.ts exactly.

type ProtoStateFrame struct {
	Seq     int64             `json:"seq"`
	State   ProtoSpaceView    `json:"state"`
	Inbox   []ProtoInboxItem  `json:"inbox"`
	View    ProtoFarmView     `json:"view"`
	Effects []json.RawMessage `json:"effects"`
}

type ProtoSpaceView struct {
	Call       string                `json:"call"`
	CallReason string                `json:"callReason"`
	Media      []json.RawMessage     `json:"media,omitempty"`
	Chat       *ProtoChat            `json:"chat,omitempty"`
	Commits    *ProtoCommitCount     `json:"commits,omitempty"`
	Progress   *ProtoProgress        `json:"progress,omitempty"`
	Issues     []ProtoIssue          `json:"issues"`
	Connectors []ProtoConnectorState `json:"connectors"`
	Machines   []ProtoMachine        `json:"machines"`
	Sessions   []ProtoSessionView    `json:"sessions"`
	Crons      []ProtoCronView       `json:"crons"`
}

type ProtoSpaceState struct {
	Call       string                `json:"call"`
	CallReason string                `json:"callReason"`
	Media      []json.RawMessage     `json:"media,omitempty"`
	Chat       *ProtoChat            `json:"chat,omitempty"`
	Commits    *ProtoCommitCount     `json:"commits,omitempty"`
	Progress   *ProtoProgress        `json:"progress,omitempty"`
	Issues     []ProtoIssue          `json:"issues"`
	Connectors []ProtoConnectorState `json:"connectors"`
	Machines   []ProtoMachine        `json:"machines"`
	Sessions   []ProtoSession        `json:"sessions"`
	Crons      []ProtoCron           `json:"crons"`
}

type ProtoConnectorState = connector.ConnectorStatus

type ProtoMachine struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Here     bool   `json:"here"`
	Online   bool   `json:"online"`
	JoinedAt int64  `json:"joinedAt"`
}

type ProtoActor struct {
	Kind    string `json:"kind"`
	ID      string `json:"id"`
	Role    string `json:"role,omitempty"`
	Name    string `json:"name,omitempty"`
	ForUser *bool  `json:"forUser,omitempty"`
}

type ProtoSpent struct {
	Tokens int      `json:"tokens"`
	CNY    *float64 `json:"cny,omitempty"`
}

type ProtoReaction struct {
	Emoji string   `json:"emoji"`
	By    []string `json:"by"`
}

type ProtoEmbed struct {
	URL         string `json:"url"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Site        string `json:"site"`
	Image       string `json:"image"`
}

type ProtoArtifactCard struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Body    string `json:"body"`
	Version int    `json:"version"`
	Note    string `json:"note"`
	Display string `json:"display,omitempty"`
}

type ProtoQuotedBlock struct {
	ArtifactID string `json:"artifactId"`
	BlockID    string `json:"blockId"`
	Rev        int64  `json:"rev"`
	Title      string `json:"title"`
	Type       string `json:"type,omitempty"`
	Text       string `json:"text,omitempty"`
	NowRev     *int64 `json:"nowRev,omitempty"`
	Deleted    *bool  `json:"deleted,omitempty"`
}

type ProtoChatMessage struct {
	ID          string                  `json:"id"`
	Number      int64                   `json:"number"`
	Channel     string                  `json:"channel"`
	From        string                  `json:"from"`
	Actor       ProtoActor              `json:"actor"`
	Name        string                  `json:"name"`
	Agent       string                  `json:"agent,omitempty"`
	Kind        string                  `json:"kind"`
	Text        string                  `json:"text"`
	Mentions    []string                `json:"mentions"`
	Session     string                  `json:"session,omitempty"`
	Run         string                  `json:"run,omitempty"`
	Outcome     *string                 `json:"outcome"`
	Spent       *ProtoSpent             `json:"spent,omitempty"`
	Spoken      bool                    `json:"spoken"`
	SendKey     string                  `json:"sendKey,omitempty"`
	At          int64                   `json:"at"`
	Revision    int64                   `json:"revision"`
	ReplyTo     *int64                  `json:"replyTo,omitempty"`
	Edited      *int64                  `json:"edited,omitempty"`
	Deleted     *int64                  `json:"deleted,omitempty"`
	Pinned      *int64                  `json:"pinned,omitempty"`
	Reactions   []ProtoReaction         `json:"reactions"`
	Attachments []attachment.Attachment `json:"attachments"`
	Embeds      []ProtoEmbed            `json:"embeds"`
	Artifact    *ProtoArtifactCard      `json:"artifact,omitempty"`
	Blocks      []ProtoQuotedBlock      `json:"blocks,omitempty"`
}

type ProtoChannelLast struct {
	From string `json:"from"`
	Name string `json:"name"`
	Text string `json:"text"`
	At   int64  `json:"at"`
}

type ProtoChannel struct {
	ID           string            `json:"id"`
	Type         string            `json:"type"`
	Default      bool              `json:"default"`
	Peer         string            `json:"peer,omitempty"`
	Orchestrator string            `json:"orchestrator,omitempty"`
	Members      []string          `json:"members,omitempty"`
	Parent       string            `json:"parent,omitempty"`
	Category     string            `json:"category"`
	Position     *int              `json:"position,omitempty"`
	Archived     *int64            `json:"archived,omitempty"`
	Notify       string            `json:"notify"`
	Root         string            `json:"root,omitempty"`
	RootNumber   *int64            `json:"rootNumber,omitempty"`
	Name         string            `json:"name,omitempty"`
	Description  string            `json:"description"`
	Repo         string            `json:"repo,omitempty"`
	SubjectKind  *string           `json:"subjectKind"`
	SubjectID    string            `json:"subjectId,omitempty"`
	LastNumber   *int64            `json:"lastNumber,omitempty"`
	Replies      int               `json:"replies"`
	Read         *int64            `json:"read,omitempty"`
	Unread       *int              `json:"unread,omitempty"`
	Title        string            `json:"title"`
	Last         *ProtoChannelLast `json:"last,omitempty"`
	At           int64             `json:"at"`
}

type ProtoUserMention struct {
	Message ProtoChatMessage `json:"message"`
	Channel string           `json:"channel"`
	Address string           `json:"address"`
}

type ProtoChat struct {
	Channels     []ProtoChannel     `json:"channels"`
	UserMentions []ProtoUserMention `json:"userMentions"`
}

type ProtoIssueMandate struct {
	OriginTriggerID    string `json:"originTriggerId,omitempty"`
	Strength           string `json:"strength"`
	MaxBotReviewRounds int    `json:"maxBotReviewRounds"`
	AutoSubmitPR       bool   `json:"autoSubmitPr"`
}

type ProtoIssueConstraints struct {
	Check      string   `json:"check,omitempty"`
	Scope      []string `json:"scope"`
	Acceptance bool     `json:"acceptance"`
	Frozen     []string `json:"frozen"`
}

type ProtoConflict struct {
	Base  string   `json:"base"`
	Files []string `json:"files"`
}

type ProtoAssignmentExecution struct {
	Kind      string `json:"kind"`
	Session   string `json:"session"`
	StartedAt int64  `json:"startedAt"`
}

type ProtoAssignmentRecord struct {
	ID         string                     `json:"id"`
	Issue      string                     `json:"issue"`
	Agent      string                     `json:"agent"`
	AssignedAt int64                      `json:"assignedAt"`
	EndedAt    *int64                     `json:"endedAt,omitempty"`
	Executions []ProtoAssignmentExecution `json:"executions"`
}

type ProtoPullRequest struct {
	URL    string `json:"url"`
	Number int    `json:"number"`
	State  string `json:"state"`
}

type ProtoFinding struct {
	ID       string `json:"id"`
	Text     string `json:"text"`
	At       int64  `json:"at"`
	Resolved bool   `json:"resolved"`
}

type ProtoQuestion struct {
	Question string   `json:"question"`
	Options  []string `json:"options"`
}

type ProtoCriterionCheck struct {
	Criterion int    `json:"criterion"`
	Result    string `json:"result"`
	Proof     string `json:"proof"`
}

type ProtoIssueLastRun struct {
	StartedAt int64  `json:"startedAt"`
	EndedAt   *int64 `json:"endedAt,omitempty"`
	Outcome   string `json:"outcome,omitempty"`
}

type ProtoIssueAnswer struct {
	Conclusion string   `json:"conclusion"`
	Evidence   []string `json:"evidence"`
	Unsure     []string `json:"unsure"`
	Next       []string `json:"next"`
}

type ProtoIssueAction struct {
	Act    string `json:"act"`
	Does   string `json:"does"`
	Status string `json:"status,omitempty"`
	Words  string `json:"words,omitempty"`
}

type ProtoIssueStage struct {
	State string             `json:"state"`
	Since *int64             `json:"since,omitempty"`
	Stuck string             `json:"stuck,omitempty"`
	Lead  string             `json:"lead,omitempty"`
	Acts  []ProtoIssueAction `json:"acts"`
}

type ProtoIssue struct {
	Constraints *ProtoIssueConstraints  `json:"constraints,omitempty"`
	ID          string                  `json:"id"`
	Number      int                     `json:"number"`
	Title       string                  `json:"title"`
	Description string                  `json:"description"`
	Mandate     ProtoIssueMandate       `json:"mandate"`
	Conflict    *ProtoConflict          `json:"conflict,omitempty"`
	Repo        string                  `json:"repo,omitempty"`
	Assignments []ProtoAssignmentRecord `json:"assignments"`
	Priority    string                  `json:"priority"`
	Rank        *int                    `json:"rank,omitempty"`
	CreatedAt   int64                   `json:"createdAt"`
	QueuedAt    *int64                  `json:"queuedAt,omitempty"`
	ClosedAt    *int64                  `json:"closedAt,omitempty"`
	Delivered   string                  `json:"delivered,omitempty"`
	Canceled    string                  `json:"canceled,omitempty"`
	Parent      string                  `json:"parent,omitempty"`
	BlockedBy   []string                `json:"blockedBy"`
	Cron        string                  `json:"cron,omitempty"`
	Status      string                  `json:"status"`
	Moves       []string                `json:"moves"`
	PullRequest *ProtoPullRequest       `json:"pullRequest,omitempty"`
	Deliver     string                  `json:"deliver"`
	ReviewedAt  *int64                  `json:"reviewedAt,omitempty"`
	Findings    []ProtoFinding          `json:"findings"`
	Questions   []ProtoQuestion         `json:"questions"`
	Criteria    []string                `json:"criteria"`
	Checks      []ProtoCriterionCheck   `json:"checks"`
	LastRun     *ProtoIssueLastRun      `json:"lastRun,omitempty"`
	Answer      *ProtoIssueAnswer       `json:"answer,omitempty"`
	Stage       ProtoIssueStage         `json:"stage"`
}

type ProtoAppliedIssue struct {
	ProtoIssue
	Seq int64 `json:"seq"`
}

type ProtoMilestone struct {
	At   int64  `json:"at"`
	Kind string `json:"kind"`
	Who  string `json:"who,omitempty"`
	Text string `json:"text"`
}

type ProtoDoing struct {
	Action string `json:"action"`
	Label  string `json:"label"`
}

type ProtoDoingView struct {
	Action     string `json:"action"`
	Label      string `json:"label"`
	ActionText string `json:"actionText"`
}

type ProtoRetry struct {
	Attempt int  `json:"attempt"`
	Of      *int `json:"of,omitempty"`
}

type ProtoPhase struct {
	Tag        string      `json:"_tag"`
	Since      *int64      `json:"since,omitempty"`
	QuietSince *int64      `json:"quietSince,omitempty"`
	Retry      *ProtoRetry `json:"retry,omitempty"`
	Doing      *ProtoDoing `json:"doing,omitempty"`
	At         *int64      `json:"at,omitempty"`
	Closed     string      `json:"closed,omitempty"`
}

type ProtoPhaseView struct {
	Tag        string          `json:"_tag"`
	Since      *int64          `json:"since,omitempty"`
	QuietSince *int64          `json:"quietSince,omitempty"`
	Retry      *ProtoRetry     `json:"retry,omitempty"`
	Doing      *ProtoDoingView `json:"doing,omitempty"`
	At         *int64          `json:"at,omitempty"`
	Closed     string          `json:"closed,omitempty"`
}

type ProtoLastRun struct {
	Outcome string      `json:"outcome"`
	Summary string      `json:"summary"`
	At      int64       `json:"at"`
	Spent   *ProtoSpent `json:"spent,omitempty"`
}

type ProtoSessionScope struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

type ProtoToolConnection struct {
	Server string `json:"server"`
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}

type ProtoSession struct {
	ID              string                `json:"id"`
	Role            string                `json:"role"`
	Name            string                `json:"name"`
	Agent           string                `json:"agent"`
	Runtime         string                `json:"runtime"`
	Brief           string                `json:"brief"`
	Repo            string                `json:"repo,omitempty"`
	Branch          string                `json:"branch,omitempty"`
	Worktree        string                `json:"worktree,omitempty"`
	HiredAt         int64                 `json:"hiredAt"`
	Runs            int                   `json:"runs"`
	Phase           ProtoPhase            `json:"phase"`
	LastRun         *ProtoLastRun         `json:"lastRun,omitempty"`
	Spent           *ProtoSpent           `json:"spent,omitempty"`
	Channel         string                `json:"channel,omitempty"`
	Scope           *ProtoSessionScope    `json:"scope,omitempty"`
	ToolConnections []ProtoToolConnection `json:"toolConnections,omitempty"`
	Machine         string                `json:"machine,omitempty"`
}

type ProtoSessionView struct {
	ID              string                `json:"id"`
	Role            string                `json:"role"`
	Name            string                `json:"name"`
	Agent           string                `json:"agent"`
	Runtime         string                `json:"runtime"`
	Brief           string                `json:"brief"`
	Repo            string                `json:"repo,omitempty"`
	Branch          string                `json:"branch,omitempty"`
	Worktree        string                `json:"worktree,omitempty"`
	HiredAt         int64                 `json:"hiredAt"`
	Runs            int                   `json:"runs"`
	Phase           ProtoPhaseView        `json:"phase"`
	PhaseText       string                `json:"phaseText"`
	LastRun         *ProtoLastRun         `json:"lastRun,omitempty"`
	Spent           *ProtoSpent           `json:"spent,omitempty"`
	Channel         string                `json:"channel,omitempty"`
	Scope           *ProtoSessionScope    `json:"scope,omitempty"`
	ToolConnections []ProtoToolConnection `json:"toolConnections,omitempty"`
	Machine         string                `json:"machine,omitempty"`
}

type ProtoRunTrigger struct {
	Kind    string `json:"kind"`
	Message string `json:"message,omitempty"`
	Channel string `json:"channel,omitempty"`
	Cron    string `json:"cron,omitempty"`
	Missed  *bool  `json:"missed,omitempty"`
}

type ProtoRun struct {
	ID          string          `json:"id"`
	Session     string          `json:"session"`
	TriggeredBy ProtoRunTrigger `json:"triggeredBy"`
	Heard       []string        `json:"heard"`
	StartedAt   int64           `json:"startedAt"`
	EndedAt     *int64          `json:"endedAt,omitempty"`
	Outcome     string          `json:"outcome,omitempty"`
	Summary     string          `json:"summary"`
	Spent       *ProtoSpent     `json:"spent,omitempty"`
}

type ProtoSessionEvent struct {
	Seq        int64                `json:"seq"`
	Revision   int64                `json:"revision"`
	Time       int64                `json:"time"`
	Type       string               `json:"type"`
	Run        string               `json:"run,omitempty"`
	Call       *int                 `json:"call,omitempty"`
	Under      *int                 `json:"under,omitempty"`
	Text       string               `json:"text"`
	Action     string               `json:"action,omitempty"`
	ActionText string               `json:"actionText,omitempty"`
	Tool       string               `json:"tool,omitempty"`
	Input      string               `json:"input,omitempty"`
	Output     string               `json:"output,omitempty"`
	Ok         *bool                `json:"ok,omitempty"`
	Tokens     *ProtoEventTokens    `json:"tokens,omitempty"`
	Connection *ProtoToolConnection `json:"connection,omitempty"`
}

type ProtoEventTokens struct {
	Input     int `json:"input"`
	CacheRead int `json:"cacheRead"`
	Output    int `json:"output"`
}

type ProtoCron struct {
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	Text    string          `json:"text"`
	Channel string          `json:"channel"`
	Agent   string          `json:"agent,omitempty"`
	Repo    string          `json:"repo,omitempty"`
	When    json.RawMessage `json:"when"`
	TZ      string          `json:"tz"`
	Enabled bool            `json:"enabled"`
	Created int64           `json:"created"`
	LastRun *int64          `json:"lastRun,omitempty"`
	By      string          `json:"by"`
	Pending bool            `json:"pending"`
}

type ProtoCronView struct {
	ProtoCron
	WhenText string `json:"whenText"`
	NextText string `json:"nextText"`
}

type ProtoInboxFrom struct {
	Kind  string `json:"kind"`
	ID    string `json:"id,omitempty"`
	Name  string `json:"name,omitempty"`
	Agent string `json:"agent,omitempty"`
}

type ProtoInboxTarget struct {
	Kind    string `json:"kind"`
	ID      string `json:"id,omitempty"`
	Channel string `json:"channel,omitempty"`
}

type ProtoInboxWords struct {
	Label string `json:"label"`
	Title string `json:"title"`
	Body  string `json:"body"`
	Tray  string `json:"tray"`
}

type ProtoInboxItem struct {
	ID     string           `json:"id"`
	Kind   string           `json:"kind"`
	From   ProtoInboxFrom   `json:"from"`
	Who    string           `json:"who"`
	Text   string           `json:"text"`
	At     int64            `json:"at"`
	Target ProtoInboxTarget `json:"target"`
	Words  ProtoInboxWords  `json:"words"`
}

type ProtoFarmLevel struct {
	Level int `json:"level"`
	XP    int `json:"xp"`
	Need  int `json:"need"`
}

type ProtoPlotView struct {
	Crop  string      `json:"crop"`
	Badge *ProtoBadge `json:"badge,omitempty"`
}

type ProtoBadge struct {
	Text string `json:"text"`
	Tone string `json:"tone"`
}

type ProtoPlayActionView struct {
	At         int64  `json:"at"`
	Action     string `json:"action"`
	Label      string `json:"label"`
	ActionText string `json:"actionText"`
}

type ProtoSessionPlayView struct {
	Station      int                   `json:"station"`
	ToolsThisRun int                   `json:"toolsThisRun"`
	Counts       map[string]int        `json:"counts"`
	Files        []string              `json:"files"`
	Commands     []string              `json:"commands"`
	RunStartedAt *int64                `json:"runStartedAt,omitempty"`
	History      []ProtoPlayActionView `json:"history"`
}

type ProtoAchievementStanding struct {
	ID    string `json:"id"`
	Tier  int    `json:"tier"`
	Count int    `json:"count"`
	Next  *int   `json:"next,omitempty"`
}

type ProtoFarmView struct {
	Level        ProtoFarmLevel                  `json:"level"`
	Plots        map[string]ProtoPlotView        `json:"plots"`
	Plays        map[string]ProtoSessionPlayView `json:"plays"`
	Achievements []ProtoAchievementStanding      `json:"achievements"`
}

type ProtoRepo struct {
	Path    string `json:"path"`
	Commits int    `json:"commits"`
}

type ProtoCommitCount struct {
	Total int         `json:"total"`
	Repos []ProtoRepo `json:"repos"`
}

type ProtoUnlock struct {
	ID   string `json:"id"`
	Tier int    `json:"tier"`
	At   int64  `json:"at"`
}

type ProtoAgentTally struct {
	Hired     int `json:"hired"`
	Harvested int `json:"harvested"`
	Failed    int `json:"failed"`
}

type ProtoProgressTitle struct {
	ID   string `json:"id"`
	Tier int    `json:"tier"`
}

type ProtoProgress struct {
	Coins      int64                      `json:"coins"`
	Streak     int                        `json:"streak"`
	BestStreak int                        `json:"bestStreak"`
	Counts     map[string]int             `json:"counts"`
	Unlocked   []ProtoUnlock              `json:"unlocked"`
	Title      *ProtoProgressTitle        `json:"title,omitempty"`
	Agents     map[string]ProtoAgentTally `json:"agents"`
	Multiplier *float64                   `json:"multiplier,omitempty"`
}

type ProtoLook struct {
	Species      *string `json:"species"`
	Outfit       *string `json:"outfit"`
	Orchestrator *string `json:"orchestrator"`
	Build        string  `json:"build"`
	Head         string  `json:"head"`
	Body         string  `json:"body"`
	Trim         string  `json:"trim"`
	Hat          string  `json:"hat"`
	Eye          string  `json:"eye"`
}

type ProtoMCPServer struct {
	Type    string            `json:"type"`
	Name    string            `json:"name"`
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	URL     string            `json:"url,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

type ProtoAgentFrom struct {
	Template string `json:"template"`
	Version  int    `json:"version"`
}

type ProtoAgent struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	Role            string            `json:"role"`
	Duty            string            `json:"duty"`
	Enabled         bool              `json:"enabled"`
	Runtime         string            `json:"runtime"`
	Model           string            `json:"model"`
	Effort          string            `json:"effort"`
	Persona         string            `json:"persona"`
	PersonaMode     string            `json:"personaMode"`
	Skills          []string          `json:"skills"`
	MCPServers      []ProtoMCPServer  `json:"mcpServers"`
	DisallowedTools []string          `json:"disallowedTools"`
	Env             map[string]string `json:"env"`
	Workdir         string            `json:"workdir"`
	Worktree        bool              `json:"worktree"`
	Tags            []string          `json:"tags"`
	Look            ProtoLook         `json:"look"`
	From            *ProtoAgentFrom   `json:"from,omitempty"`
}

type ProtoRuntimePreset struct {
	ID    string    `json:"id"`
	Label string    `json:"label"`
	Blurb string    `json:"blurb"`
	Look  ProtoLook `json:"look"`
}

type ProtoRuntimeSupport struct {
	Steer        bool              `json:"steer"`
	Refused      map[string]string `json:"refused"`
	Capabilities []string          `json:"capabilities"`
	InProcess    bool              `json:"inProcess"`
}

type ProtoRuntimeSettings struct {
	Enabled       bool              `json:"enabled"`
	BinPath       string            `json:"binPath"`
	DefaultModel  string            `json:"defaultModel"`
	DefaultEffort string            `json:"defaultEffort"`
	Env           map[string]string `json:"env"`
	DailyBudget   *float64          `json:"dailyBudget,omitempty"`
	MaxWorking    *int              `json:"maxWorking,omitempty"`
}

type ProtoModelEntry struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	EffortLevels []string `json:"effortLevels"`
	IsDefault    bool     `json:"isDefault"`
}

type ProtoRuntimeInfo struct {
	ID           string               `json:"id"`
	Preset       ProtoRuntimePreset   `json:"preset"`
	Support      ProtoRuntimeSupport  `json:"support"`
	Installation map[string]any       `json:"installation"`
	Models       []ProtoModelEntry    `json:"models"`
	Usage        any                  `json:"usage"`
	Skills       any                  `json:"skills"`
	MCPServers   any                  `json:"mcpServers"`
	Tools        any                  `json:"tools"`
	Settings     ProtoRuntimeSettings `json:"settings"`
	SpentToday   *float64             `json:"spentToday,omitempty"`
	Quota        any                  `json:"quota,omitempty"`
	Stop         string               `json:"stop"`
	CheckedAt    int64                `json:"checkedAt"`
}

type ProtoGitHubStatus struct {
	Installed bool   `json:"installed"`
	Version   string `json:"version,omitempty"`
	LoggedIn  bool   `json:"loggedIn"`
	Account   string `json:"account,omitempty"`
	Reason    string `json:"reason"`
	CheckedAt int64  `json:"checkedAt"`
}

type ProtoMediaInput struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	Name      string  `json:"name"`
	Mime      string  `json:"mime"`
	Size      int64   `json:"size"`
	Phase     string  `json:"phase"`
	Hash      *string `json:"hash"`
	CreatedAt int64   `json:"createdAt"`
	ExpiresAt int64   `json:"expiresAt"`
	CanDelete bool    `json:"canDelete"`
}

type ProtoLibraryItem struct {
	Attachment attachment.Attachment `json:"attachment"`
	Origin     map[string]any        `json:"origin"`
	AddedAt    int64                 `json:"addedAt"`
	LastAt     int64                 `json:"lastAt"`
}

type ProtoPkmComment struct {
	ID        string `json:"id"`
	Page      string `json:"page"`
	Block     string `json:"block"`
	Span      string `json:"span,omitempty"`
	By        string `json:"by"`
	Body      string `json:"body"`
	Status    string `json:"status"`
	Suggested string `json:"suggested,omitempty"`
	Rationale string `json:"rationale,omitempty"`
	Created   int64  `json:"created"`
	Resolved  *int64 `json:"resolved,omitempty"`
}

func defaultLook(role, runtimeID string) ProtoLook {
	preset := agent.PresetOf(runtimeID)
	species := "fox"
	if role == "orchestrator" {
		species = "owl"
	}
	outfit := "farmer"
	var orch *string
	if role == "orchestrator" {
		o := "farmer"
		orch = &o
	}
	build := preset.Look.Build
	if build == "" {
		build = "biped"
	}
	head := preset.Look.Head
	if head == "" {
		head = "rounded"
	}
	return ProtoLook{
		Species:      &species,
		Outfit:       &outfit,
		Orchestrator: orch,
		Build:        build,
		Head:         head,
		Body:         firstNonEmpty(preset.Look.Body, "#f3e9da"),
		Trim:         firstNonEmpty(preset.Look.Trim, "#4f9a5a"),
		Hat:          firstNonEmpty(preset.Look.Hat, "#e8804f"),
		Eye:          firstNonEmpty(preset.Look.Eye, "#a6f4ff"),
	}
}

func mapProtocolIssueStatus(s contract.IssueStatus) string {
	switch s {
	case contract.IssueDraft:
		return "backlog"
	case contract.IssueQueued:
		return "todo"
	case contract.IssueInProgress:
		return "in_progress"
	case contract.IssueReview:
		return "in_review"
	case contract.IssueDone:
		return "done"
	case "canceled":
		return "canceled"
	default:
		return "backlog"
	}
}

func mapContractIssueStatus(s string) contract.IssueStatus {
	switch s {
	case "backlog":
		return contract.IssueDraft
	case "todo":
		return contract.IssueQueued
	case "in_progress":
		return contract.IssueInProgress
	case "in_review":
		return contract.IssueReview
	case "done":
		return contract.IssueDone
	case "canceled":
		return contract.IssueStatus("canceled")
	default:
		return contract.IssueStatus(s)
	}
}

func computeIssueStage(protoStatus string, iss issue.Issue, meta *issueOverlay) ProtoIssueStage {
	switch protoStatus {
	case "backlog":
		return ProtoIssueStage{
			State: "draft",
			Lead:  "start",
			Acts: []ProtoIssueAction{
				{Act: "start", Does: "move", Status: "todo", Words: "optional"},
				{Act: "close", Does: "move", Status: "canceled", Words: "none"},
			},
		}
	case "todo":
		return ProtoIssueStage{
			State: "queued",
			Acts: []ProtoIssueAction{
				{Act: "close", Does: "move", Status: "canceled", Words: "none"},
			},
		}
	case "in_progress":
		if strings.TrimSpace(iss.FailureReason) != "" {
			return ProtoIssueStage{
				State: "stuck",
				Stuck: "failed",
				Lead:  "resume",
				Acts: []ProtoIssueAction{
					{Act: "resume", Does: "move", Status: "todo", Words: "optional"},
					{Act: "close", Does: "move", Status: "canceled", Words: "none"},
				},
			}
		}
		if len(meta.Questions) > 0 {
			return ProtoIssueStage{
				State: "asking",
				Lead:  "answer",
				Acts: []ProtoIssueAction{
					{Act: "answer", Does: "say"},
					{Act: "close", Does: "move", Status: "canceled", Words: "none"},
				},
			}
		}
		acts := []ProtoIssueAction{
			{Act: "tell", Does: "say"},
			{Act: "close", Does: "move", Status: "canceled", Words: "none"},
		}
		if iss.SessionID != "" {
			acts = append([]ProtoIssueAction{{Act: "stop", Does: "stop"}}, acts...)
		}
		return ProtoIssueStage{
			State: "working",
			Since: &iss.UpdatedAtMs,
			Acts:  acts,
		}
	case "in_review":
		return ProtoIssueStage{
			State: "reviewing",
			Since: &iss.UpdatedAtMs,
			Lead:  "complete",
			Acts: []ProtoIssueAction{
				{Act: "complete", Does: "move", Status: "done", Words: "none"},
				{Act: "reject", Does: "move", Status: "todo", Words: "required"},
				{Act: "close", Does: "move", Status: "canceled", Words: "none"},
			},
		}
	case "done":
		return ProtoIssueStage{
			State: "done",
			Acts: []ProtoIssueAction{
				{Act: "reopen", Does: "move", Status: "todo", Words: "optional"},
			},
		}
	case "canceled":
		return ProtoIssueStage{
			State: "canceled",
			Acts: []ProtoIssueAction{
				{Act: "reopen", Does: "move", Status: "todo", Words: "optional"},
			},
		}
	default:
		return ProtoIssueStage{State: "draft", Acts: []ProtoIssueAction{}}
	}
}

func (h *gatewayHub) buildProtoIssue(iss issue.Issue) ProtoIssue {
	h.mu.Lock()
	meta := h.ensureIssueMetaLocked(iss.ID)
	metaCp := *meta
	h.mu.Unlock()

	protoStatus := mapProtocolIssueStatus(iss.Status)
	blockedBy := copyStrings(metaCp.BlockedBy)
	moves := copyStrings(metaCp.Moves)
	findings := append([]ProtoFinding{}, metaCp.Findings...)
	questions := append([]ProtoQuestion{}, metaCp.Questions...)
	criteria := copyStrings(metaCp.Criteria)
	if len(criteria) == 0 && iss.Rubric != nil && strings.TrimSpace(iss.Rubric.Markdown) != "" {
		for _, line := range strings.Split(iss.Rubric.Markdown, "\n") {
			t := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "- "))
			if t != "" {
				criteria = append(criteria, t)
			}
		}
	}
	checks := append([]ProtoCriterionCheck{}, metaCp.Checks...)
	assignments := append([]ProtoAssignmentRecord{}, metaCp.AgentHistory...)
	if len(assignments) == 0 && (iss.AssigneeID != "" || metaCp.AgentHint != "" || iss.SessionID != "") {
		ag := firstNonEmpty(iss.AssigneeID, metaCp.AgentHint, "worker")
		execs := []ProtoAssignmentExecution{}
		if iss.SessionID != "" {
			execs = append(execs, ProtoAssignmentExecution{
				Kind:      "worker",
				Session:   iss.SessionID,
				StartedAt: iss.CreatedAtMs,
			})
		}
		assignments = append(assignments, ProtoAssignmentRecord{
			ID:         "assign-" + iss.ID,
			Issue:      iss.ID,
			Agent:      ag,
			AssignedAt: iss.CreatedAtMs,
			Executions: execs,
		})
	}

	var pr *ProtoPullRequest
	if strings.TrimSpace(iss.PRURL) != "" {
		prState := "open"
		if protoStatus == "done" {
			prState = "merged"
		}
		pr = &ProtoPullRequest{URL: iss.PRURL, Number: metaCp.Number, State: prState}
	}

	strength := firstNonEmpty(metaCp.Strength, "explicit")
	deliver := firstNonEmpty(metaCp.Deliver, "change")
	priority := firstNonEmpty(metaCp.Priority, "medium")

	var lastRun *ProtoIssueLastRun
	if len(metaCp.Runs) > 0 {
		lr := metaCp.Runs[len(metaCp.Runs)-1]
		lastRun = &ProtoIssueLastRun{StartedAt: lr.StartedAt, EndedAt: lr.EndedAt, Outcome: lr.Outcome}
	}

	return ProtoIssue{
		Constraints: metaCp.Constraints,
		ID:          iss.ID,
		Number:      metaCp.Number,
		Title:       iss.Title,
		Description: firstNonEmpty(iss.Description, iss.Prompt),
		Mandate: ProtoIssueMandate{
			Strength:           strength,
			MaxBotReviewRounds: 0,
			AutoSubmitPR:       metaCp.AutoSubmitPR,
		},
		Repo:        iss.RepoID,
		Assignments: assignments,
		Priority:    priority,
		Rank:        metaCp.Rank,
		CreatedAt:   iss.CreatedAtMs,
		QueuedAt:    metaCp.QueuedAt,
		ClosedAt:    metaCp.ClosedAt,
		Delivered:   metaCp.Delivered,
		Canceled:    metaCp.Canceled,
		Parent:      metaCp.Parent,
		BlockedBy:   blockedBy,
		Cron:        metaCp.Cron,
		Status:      protoStatus,
		Moves:       moves,
		PullRequest: pr,
		Deliver:     deliver,
		ReviewedAt:  metaCp.ReviewedAt,
		Findings:    findings,
		Questions:   questions,
		Criteria:    criteria,
		Checks:      checks,
		LastRun:     lastRun,
		Answer:      metaCp.Answer,
		Stage:       computeIssueStage(protoStatus, iss, &metaCp),
	}
}

func (h *gatewayHub) buildChatMessage(ev channel.Event) ProtoChatMessage {
	msgID := formatMessageID(ev.ChannelID, ev.Seq)
	h.mu.RLock()
	meta := h.state.Channels[ev.ChannelID]
	var editRec *messageEditRecord
	var deletedAt *int64
	var pinnedAt *int64
	var reactions []ProtoReaction
	var attIDs []string
	if meta != nil {
		if e, ok := meta.Edits[msgID]; ok {
			cp := e
			editRec = &cp
		}
		if d, ok := meta.MsgDeletes[msgID]; ok {
			deletedAt = &d
		}
		if p, ok := meta.Pins[msgID]; ok {
			pinnedAt = &p
		}
		if rList, ok := meta.Reactions[msgID]; ok {
			reactions = append([]ProtoReaction{}, rList...)
		}
		if aList, ok := meta.Attachments[msgID]; ok {
			attIDs = copyStrings(aList)
		}
	}
	h.mu.RUnlock()

	if reactions == nil {
		reactions = []ProtoReaction{}
	}
	atts := []attachment.Attachment{}
	if h.st != nil && h.st.Attachments != nil && len(attIDs) > 0 && deletedAt == nil {
		if got, err := h.st.Attachments.Of(context.Background(), attIDs); err == nil && len(got) > 0 {
			atts = got
		}
	}

	kind := "chat"
	var outcome *string
	switch ev.Kind {
	case contract.ChannelEventReport:
		kind = "report"
		if ev.Report != nil && ev.Report.Outcome != "" {
			o := ev.Report.Outcome
			outcome = &o
		}
	case contract.ChannelEventQuestion:
		kind = "chat"
	case contract.ChannelEventReaction:
		kind = "notice"
	}

	actorKind := string(ev.ActorKind)
	if actorKind != "user" && actorKind != "agent" && actorKind != "system" {
		actorKind = "user"
	}
	actor := ProtoActor{
		Kind: actorKind,
		ID:   firstNonEmpty(ev.AuthorID, "user"),
		Name: firstNonEmpty(ev.AuthorID, "owner"),
	}
	if actorKind == "agent" {
		role := string(ev.ActorRole)
		if role != "orchestrator" && role != "worker" {
			role = "worker"
		}
		actor.Role = role
	}

	text := ev.Text
	var editedAt *int64
	rev := ev.Seq
	if editRec != nil {
		text = editRec.Text
		editedAt = &editRec.EditedAt
		if editRec.Revision > rev {
			rev = editRec.Revision
		}
	}
	if deletedAt != nil {
		text = ""
	}

	var agentField string
	if actorKind == "agent" {
		agentField = ev.AuthorID
	}

	return ProtoChatMessage{
		ID:          msgID,
		Number:      ev.Seq,
		Channel:     ev.ChannelID,
		From:        firstNonEmpty(ev.AuthorID, "user"),
		Actor:       actor,
		Name:        firstNonEmpty(ev.AuthorID, "owner"),
		Agent:       agentField,
		Kind:        kind,
		Text:        text,
		Mentions:    copyStrings(ev.Mentions),
		Session:     ev.SessionID,
		Outcome:     outcome,
		Spoken:      false,
		SendKey:     ev.SendKey,
		At:          ev.CreatedAtMs,
		Revision:    rev,
		Edited:      editedAt,
		Deleted:     deletedAt,
		Pinned:      pinnedAt,
		Reactions:   reactions,
		Attachments: atts,
		Embeds:      []ProtoEmbed{},
	}
}

func (h *gatewayHub) buildChannelDTO(ctx context.Context, ch channel.Channel) ProtoChannel {
	h.mu.Lock()
	meta := h.ensureChannelMetaLocked(ch.ID)
	metaCp := *meta
	defCh := h.state.DefaultChannel
	h.mu.Unlock()

	if metaCp.Deleted {
		return ProtoChannel{}
	}

	chType := string(ch.Type)
	if chType != "channel" && chType != "direct" && chType != "thread" {
		chType = "channel"
	}

	isDef := ch.IsDefault
	if metaCp.HasDefault {
		isDef = metaCp.Default
	}
	if defCh != "" {
		isDef = (ch.ID == defCh)
	}

	desc := ch.Topic
	if metaCp.HasDesc {
		desc = metaCp.Description
	}
	notify := firstNonEmpty(metaCp.Notify, ch.NotifyMode, "all")
	if notify != "all" && notify != "mentions" && notify != "none" {
		notify = "all"
	}

	var subjKind *string
	if metaCp.SubjectKind == "issue" || metaCp.SubjectKind == "talk" {
		sk := metaCp.SubjectKind
		subjKind = &sk
	} else if ch.IssueID != "" {
		sk := "issue"
		subjKind = &sk
	}

	events, _ := h.st.Channels.ListEvents(ctx, ch.ID, 0, 500)
	var lastNum *int64
	var last *ProtoChannelLast
	if len(events) > 0 {
		lastEv := events[len(events)-1]
		n := lastEv.Seq
		lastNum = &n
		msg := h.buildChatMessage(lastEv)
		last = &ProtoChannelLast{
			From: msg.From,
			Name: msg.Name,
			Text: msg.Text,
			At:   msg.At,
		}
	}

	readSeq := metaCp.ReadNum
	if cur, err := h.st.Channels.GetReadCursor(ctx, ch.ID, "user"); err == nil && cur.ReadSeq > 0 {
		r := cur.ReadSeq
		readSeq = &r
	}
	var unreadPtr *int
	if lastNum != nil {
		readVal := int64(0)
		if readSeq != nil {
			readVal = *readSeq
		}
		unreadCount := 0
		for _, ev := range events {
			if ev.Seq > readVal && ev.ActorKind != channel.ActorUser && ev.Kind != contract.ChannelEventReaction {
				unreadCount++
			}
		}
		if unreadCount > 0 {
			unreadPtr = &unreadCount
		}
	}

	name := firstNonEmpty(ch.Name, ch.ID)
	title := firstNonEmpty(metaCp.Title, name)
	members := copyStrings(metaCp.Members)
	if len(members) == 0 {
		if m, err := h.st.Channels.ListMembers(ctx, ch.ID); err == nil && len(m) > 0 {
			members = m
		}
	}
	var membersOut []string
	if len(members) > 0 {
		membersOut = members
	}

	var rootID string
	var rootNum *int64
	if chType == "thread" && ch.ParentChannelID != "" && ch.ParentEventSeq > 0 {
		rootID = formatMessageID(ch.ParentChannelID, ch.ParentEventSeq)
		rn := ch.ParentEventSeq
		rootNum = &rn
	}

	return ProtoChannel{
		ID:           ch.ID,
		Type:         chType,
		Default:      isDef,
		Peer:         ch.PeerID,
		Orchestrator: firstNonEmpty(metaCp.Orchestrator, ch.DefaultAgentID),
		Members:      membersOut,
		Parent:       ch.ParentChannelID,
		Category:     metaCp.Category,
		Position:     metaCp.Position,
		Archived:     metaCp.Archived,
		Notify:       notify,
		Root:         rootID,
		RootNumber:   rootNum,
		Name:         name,
		Description:  desc,
		Repo:         firstNonEmpty(metaCp.Repo, ch.RepoID),
		SubjectKind:  subjKind,
		SubjectID:    firstNonEmpty(metaCp.SubjectID, ch.IssueID),
		LastNumber:   lastNum,
		Replies:      len(events),
		Read:         readSeq,
		Unread:       unreadPtr,
		Title:        title,
		Last:         last,
		At:           maxInt64(ch.UpdatedAtMs, metaCp.LastAt),
	}
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func filterProtocolConnectors(list []ProtoConnectorState) []ProtoConnectorState {
	out := make([]ProtoConnectorState, 0, len(list))
	for _, c := range list {
		switch c.ID {
		case connector.ConnectorWeixin, connector.ConnectorFeishu, connector.ConnectorQQ:
			out = append(out, c)
		}
	}
	return out
}

func (h *gatewayHub) buildSpaceState(ctx context.Context) ProtoSpaceState {
	callState := "idle"
	callReason := ""
	if h.st != nil && h.st.Voice != nil {
		vs := h.st.Voice.State()
		callState = string(vs.State)
		callReason = vs.Reason
	}

	connectors := []ProtoConnectorState{}
	if h.st != nil && h.st.Connectors != nil {
		connectors = filterProtocolConnectors(h.st.Connectors.List())
	}

	nowMs := h.nowMs()
	machines := []ProtoMachine{
		{ID: "here", Name: "local", Here: true, Online: true, JoinedAt: nowMs},
	}
	if h.st != nil && h.st.Machines != nil {
		for _, id := range h.st.Machines.OnlineIDs() {
			if id == "here" || id == "" {
				continue
			}
			machines = append(machines, ProtoMachine{
				ID:       id,
				Name:     id,
				Here:     false,
				Online:   true,
				JoinedAt: nowMs,
			})
		}
	}

	issuesOut := []ProtoIssue{}
	if h.st != nil && h.st.Issues != nil {
		rawIssues, _ := h.st.Issues.ListIssues(ctx)
		for _, iss := range rawIssues {
			h.mu.RLock()
			del := h.state.Issues[iss.ID] != nil && h.state.Issues[iss.ID].Deleted
			h.mu.RUnlock()
			if del {
				continue
			}
			issuesOut = append(issuesOut, h.buildProtoIssue(iss))
		}
	}
	sort.SliceStable(issuesOut, func(i, j int) bool {
		return issuesOut[i].Number > issuesOut[j].Number
	})

	channelsOut := []ProtoChannel{}
	if h.st != nil && h.st.Channels != nil {
		rawChs, _ := h.st.Channels.ListChannels(ctx)
		for _, ch := range rawChs {
			dto := h.buildChannelDTO(ctx, ch)
			if dto.ID == "" {
				continue
			}
			channelsOut = append(channelsOut, dto)
		}
	}
	sort.SliceStable(channelsOut, func(i, j int) bool {
		if channelsOut[i].Default != channelsOut[j].Default {
			return channelsOut[i].Default
		}
		return channelsOut[i].ID < channelsOut[j].ID
	})

	cronsOut := []ProtoCron{}
	if h.st != nil && h.st.Issues != nil {
		rawCrons, _ := h.st.Issues.ListCrons(ctx)
		for _, c := range rawCrons {
			h.mu.RLock()
			cm := h.state.Crons[c.ID]
			h.mu.RUnlock()
			if cm != nil && cm.Deleted {
				continue
			}
			var lastRun *int64
			if c.LastRunAtMs > 0 {
				lr := c.LastRunAtMs
				lastRun = &lr
			}
			whenRaw := json.RawMessage(fmt.Sprintf(`{"kind":"cron","expr":%q}`, c.Expr))
			if cm != nil && len(cm.When) > 0 {
				whenRaw = cm.When
			}
			chName := defaultChannelID
			if cm != nil && cm.Channel != "" {
				chName = cm.Channel
			}
			tz := "UTC"
			if cm != nil && cm.TZ != "" {
				tz = cm.TZ
			}
			by := "user"
			if cm != nil && cm.By != "" {
				by = cm.By
			}
			pending := cm != nil && cm.Pending
			var agentID, repoID string
			if cm != nil {
				agentID = cm.Agent
				repoID = cm.Repo
			}
			cronsOut = append(cronsOut, ProtoCron{
				ID:      c.ID,
				Name:    firstNonEmpty(c.Name, c.ID),
				Text:    c.Prompt,
				Channel: chName,
				Agent:   agentID,
				Repo:    repoID,
				When:    whenRaw,
				TZ:      tz,
				Enabled: c.Enabled,
				Created: c.NextRunAtMs,
				LastRun: lastRun,
				By:      by,
				Pending: pending,
			})
		}
	}

	h.mu.RLock()
	sessionsOut := make([]ProtoSession, 0, len(h.state.Sessions))
	for _, s := range h.state.Sessions {
		if s != nil {
			sessionsOut = append(sessionsOut, *s)
		}
	}
	mediaList := make([]json.RawMessage, 0, len(h.state.MediaJobs))
	for _, job := range h.state.MediaJobs {
		if job != nil && len(job.Raw) > 0 {
			mediaList = append(mediaList, job.Raw)
		}
	}
	h.mu.RUnlock()
	sort.Slice(sessionsOut, func(i, j int) bool { return sessionsOut[i].ID < sessionsOut[j].ID })

	var prog *ProtoProgress
	if h.st != nil && h.st.Ledger != nil {
		p := h.st.Ledger.Progress()
		var titlePtr *ProtoProgressTitle
		if p.ActiveTitle != "" {
			titlePtr = &ProtoProgressTitle{ID: p.ActiveTitle, Tier: 1}
		}
		prog = &ProtoProgress{
			Coins:      p.Coins,
			Streak:     p.Streak,
			BestStreak: p.Streak,
			Counts:     map[string]int{"merged": p.MergedCount},
			Unlocked:   []ProtoUnlock{},
			Title:      titlePtr,
			Agents:     map[string]ProtoAgentTally{},
		}
	}

	return ProtoSpaceState{
		Call:       callState,
		CallReason: callReason,
		Media:      mediaList,
		Chat: &ProtoChat{
			Channels:     channelsOut,
			UserMentions: []ProtoUserMention{},
		},
		Commits:    &ProtoCommitCount{Total: 0, Repos: []ProtoRepo{}},
		Progress:   prog,
		Issues:     issuesOut,
		Connectors: connectors,
		Machines:   machines,
		Sessions:   sessionsOut,
		Crons:      cronsOut,
	}
}

func (h *gatewayHub) buildStateFrame(ctx context.Context) ProtoStateFrame {
	space := h.buildSpaceState(ctx)

	sessionViews := make([]ProtoSessionView, 0, len(space.Sessions))
	for _, s := range space.Sessions {
		pv := ProtoPhaseView{
			Tag:        s.Phase.Tag,
			Since:      s.Phase.Since,
			QuietSince: s.Phase.QuietSince,
			Retry:      s.Phase.Retry,
			At:         s.Phase.At,
			Closed:     s.Phase.Closed,
		}
		if s.Phase.Doing != nil {
			pv.Doing = &ProtoDoingView{
				Action:     s.Phase.Doing.Action,
				Label:      s.Phase.Doing.Label,
				ActionText: s.Phase.Doing.Action,
			}
		}
		sessionViews = append(sessionViews, ProtoSessionView{
			ID:              s.ID,
			Role:            s.Role,
			Name:            s.Name,
			Agent:           s.Agent,
			Runtime:         s.Runtime,
			Brief:           s.Brief,
			Repo:            s.Repo,
			Branch:          s.Branch,
			Worktree:        s.Worktree,
			HiredAt:         s.HiredAt,
			Runs:            s.Runs,
			Phase:           pv,
			PhaseText:       s.Phase.Tag,
			LastRun:         s.LastRun,
			Spent:           s.Spent,
			Channel:         s.Channel,
			Scope:           s.Scope,
			ToolConnections: s.ToolConnections,
			Machine:         s.Machine,
		})
	}

	cronViews := make([]ProtoCronView, 0, len(space.Crons))
	for _, c := range space.Crons {
		cronViews = append(cronViews, ProtoCronView{
			ProtoCron: c,
			WhenText:  "scheduled",
			NextText:  "pending",
		})
	}

	inboxItems := []ProtoInboxItem{}
	if h.st != nil && h.st.Watch != nil {
		rawInbox, _ := h.st.Watch.ListInboxItems(ctx, false)
		for _, it := range rawInbox {
			kind := mapInboxKind(it.Kind)
			target := ProtoInboxTarget{Kind: "issue", ID: firstNonEmpty(it.IssueID, it.ID)}
			if it.IssueID == "" && it.SessionID != "" {
				target = ProtoInboxTarget{Kind: "session", ID: it.SessionID}
			}
			from := ProtoInboxFrom{Kind: "orchestrator"}
			if it.SessionID != "" {
				from = ProtoInboxFrom{Kind: "session", ID: it.SessionID, Name: it.SessionID, Agent: "worker"}
			}
			inboxItems = append(inboxItems, ProtoInboxItem{
				ID:     it.ID,
				Kind:   kind,
				From:   from,
				Who:    firstNonEmpty(it.SessionID, "orchestrator"),
				Text:   firstNonEmpty(it.Summary, it.Title),
				At:     it.CreatedAtMs,
				Target: target,
				Words: ProtoInboxWords{
					Label: it.Title,
					Title: it.Title,
					Body:  firstNonEmpty(it.Summary, it.Title),
					Tray:  it.Title,
				},
			})
		}
	}

	lvl := game.LevelForCommits(0)
	if space.Commits != nil {
		lvl = game.LevelForCommits(space.Commits.Total)
	}
	plots := make(map[string]ProtoPlotView, len(space.Issues))
	for _, iss := range space.Issues {
		plots[iss.ID] = ProtoPlotView{Crop: cropForIssueStatus(iss.Status)}
	}

	seq := int64(1)
	if h.st != nil {
		seq = h.st.StateSeq()
	}

	return ProtoStateFrame{
		Seq: seq,
		State: ProtoSpaceView{
			Call:       space.Call,
			CallReason: space.CallReason,
			Media:      space.Media,
			Chat:       space.Chat,
			Commits:    space.Commits,
			Progress:   space.Progress,
			Issues:     space.Issues,
			Connectors: space.Connectors,
			Machines:   space.Machines,
			Sessions:   sessionViews,
			Crons:      cronViews,
		},
		Inbox: inboxItems,
		View: ProtoFarmView{
			Level: ProtoFarmLevel{
				Level: lvl.Level,
				XP:    lvl.XP,
				Need:  lvl.Need,
			},
			Plots:        plots,
			Plays:        map[string]ProtoSessionPlayView{},
			Achievements: []ProtoAchievementStanding{},
		},
		Effects: []json.RawMessage{},
	}
}

func mapInboxKind(k contract.InboxItemKind) string {
	switch k {
	case contract.InboxMention:
		return "mention"
	case contract.InboxApproval:
		return "ask"
	case contract.InboxMountConflict:
		return "conflict"
	case contract.InboxBudgetReached:
		return "fix"
	case contract.InboxDreamProposal:
		return "review"
	default:
		return "mention"
	}
}

func cropForIssueStatus(status string) string {
	switch status {
	case "backlog":
		return "empty"
	case "todo":
		return "seeded"
	case "in_progress":
		return "sprout"
	case "in_review":
		return "wheat"
	case "done":
		return "harvested"
	case "canceled":
		return "withered"
	default:
		return "empty"
	}
}

func (h *gatewayHub) buildProtoAgent(p agent.Profile) ProtoAgent {
	h.mu.RLock()
	meta := h.state.Agents[p.ID]
	var metaCp agentOverlay
	if meta != nil {
		metaCp = *meta
	}
	h.mu.RUnlock()

	enabled := true
	if metaCp.HasEnabled {
		enabled = !metaCp.Disabled
	}
	look := defaultLook(string(p.Role), p.Runtime)
	if metaCp.Look != nil {
		look = *metaCp.Look
	}
	personaMode := string(p.PersonaMode)
	if personaMode == "" {
		personaMode = "append"
	}
	mcpServers := metaCp.MCPServers
	if mcpServers == nil {
		mcpServers = []ProtoMCPServer{}
	}
	env := p.Env
	if env == nil {
		env = map[string]string{}
	}

	return ProtoAgent{
		ID:              p.ID,
		Name:            firstNonEmpty(p.Name, p.ID),
		Role:            firstNonEmpty(string(p.Role), "worker"),
		Duty:            p.Duty,
		Enabled:         enabled,
		Runtime:         firstNonEmpty(p.Runtime, "claude"),
		Model:           p.Model,
		Effort:          p.Effort,
		Persona:         p.Persona,
		PersonaMode:     personaMode,
		Skills:          copyStrings(p.Skills),
		MCPServers:      mcpServers,
		DisallowedTools: copyStrings(p.DisallowedTools),
		Env:             env,
		Workdir:         metaCp.Workdir,
		Worktree:        p.UseWorktree,
		Tags:            copyStrings(p.Tags),
		Look:            look,
		From:            metaCp.From,
	}
}
