package gateway

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/agent"
	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/internal/domain/stack"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

const (
	overlayScopeKind = store.ScopeGlobal
	overlayScopeID   = "gateway"
	overlayDocKind   = "gateway.overlay"

	defaultChannelID   = "general"
	defaultChannelName = "general"
)

// issueOverlay holds protocol Issue fields not stored directly on internal/domain/issue.Issue.
type issueOverlay struct {
	Number         int                     `json:"number"`
	Parent         string                  `json:"parent,omitempty"`
	BlockedBy      []string                `json:"blockedBy,omitempty"`
	Priority       string                  `json:"priority,omitempty"`
	Rank           *int                    `json:"rank,omitempty"`
	Deliver        string                  `json:"deliver,omitempty"`
	AutoSubmitPR   bool                    `json:"autoSubmitPr,omitempty"`
	Strength       string                  `json:"strength,omitempty"`
	Criteria       []string                `json:"criteria,omitempty"`
	Moves          []string                `json:"moves,omitempty"`
	Findings       []ProtoFinding          `json:"findings,omitempty"`
	Questions      []ProtoQuestion         `json:"questions,omitempty"`
	Checks         []ProtoCriterionCheck   `json:"checks,omitempty"`
	Constraints    *ProtoIssueConstraints  `json:"constraints,omitempty"`
	QueuedAt       *int64                  `json:"queuedAt,omitempty"`
	ClosedAt       *int64                  `json:"closedAt,omitempty"`
	Delivered      string                  `json:"delivered,omitempty"`
	Canceled       string                  `json:"canceled,omitempty"`
	ReviewedAt     *int64                  `json:"reviewedAt,omitempty"`
	Cron           string                  `json:"cron,omitempty"`
	Deleted        bool                    `json:"deleted,omitempty"`
	Milestones     []ProtoMilestone        `json:"milestones,omitempty"`
	Answer         *ProtoIssueAnswer       `json:"answer,omitempty"`
	AgentHistory   []ProtoAssignmentRecord `json:"agentHistory,omitempty"`
	Runs           []ProtoRun              `json:"runs,omitempty"`
	AgentHint      string                  `json:"agentHint,omitempty"`
	Refining       *ProtoIssueRefining     `json:"refining,omitempty"`
	WorktreePath   string                  `json:"worktreePath,omitempty"`
	Branch         string                  `json:"branch,omitempty"`
	BaseBranch     string                  `json:"baseBranch,omitempty"`
	LastRunOutcome string                  `json:"lastRunOutcome,omitempty"`
	Conflict       *ProtoConflict          `json:"conflict,omitempty"`
}

type channelOverlay struct {
	Default       bool                          `json:"default,omitempty"`
	HasDefault    bool                          `json:"hasDefault,omitempty"`
	Name          string                        `json:"name,omitempty"`
	Category      string                        `json:"category,omitempty"`
	Position      *int                          `json:"position,omitempty"`
	Archived      *int64                        `json:"archived,omitempty"`
	Notify        string                        `json:"notify,omitempty"`
	Orchestrator  string                        `json:"orchestrator,omitempty"`
	HasMembers    bool                          `json:"hasMembers,omitempty"`
	Members       []string                      `json:"members,omitempty"`
	Description   string                        `json:"description,omitempty"`
	HasDesc       bool                          `json:"hasDesc,omitempty"`
	Repo          string                        `json:"repo,omitempty"`
	Deleted       bool                          `json:"deleted,omitempty"`
	Title         string                        `json:"title,omitempty"`
	SubjectKind   string                        `json:"subjectKind,omitempty"`
	SubjectID     string                        `json:"subjectId,omitempty"`
	HasReadNum    bool                          `json:"hasReadNum,omitempty"`
	ReadNum       *int64                        `json:"readNum,omitempty"`
	LastAt        int64                         `json:"lastAt,omitempty"`
	Pins          map[string]int64              `json:"pins,omitempty"`
	Edits         map[string]messageEditRecord  `json:"edits,omitempty"`
	MsgDeletes    map[string]int64              `json:"msgDeletes,omitempty"`
	Reactions     map[string][]ProtoReaction    `json:"reactions,omitempty"`
	Attachments   map[string][]string           `json:"attachments,omitempty"`
	ReplyTo       map[string]int64              `json:"replyTo,omitempty"`
	Revisions     map[string]int64              `json:"revisions,omitempty"`
	ArtifactCards map[string]ProtoArtifactCard  `json:"artifactCards,omitempty"`
	QuotedBlocks  map[string][]ProtoQuotedBlock `json:"quotedBlocks,omitempty"`
	MsgKinds      map[string]string             `json:"msgKinds,omitempty"`
	ExtraMsgs     []ProtoChatMessage            `json:"extraMsgs,omitempty"`
}

type messageEditRecord struct {
	Text        string   `json:"text"`
	EditedAt    int64    `json:"editedAt"`
	Revision    int64    `json:"revision"`
	Attachments []string `json:"attachments,omitempty"`
	HasAtts     bool     `json:"hasAtts,omitempty"`
}

type agentOverlay struct {
	Disabled   bool             `json:"disabled,omitempty"`
	HasEnabled bool             `json:"hasEnabled,omitempty"`
	Workdir    string           `json:"workdir,omitempty"`
	MCPServers []ProtoMCPServer `json:"mcpServers,omitempty"`
	Look       *ProtoLook       `json:"look,omitempty"`
	From       *ProtoAgentFrom  `json:"from,omitempty"`
	Deleted    bool             `json:"deleted,omitempty"`
}

type agentTemplateRecord struct {
	ID          string    `json:"id"`
	Version     int       `json:"version"`
	Role        string    `json:"role"`
	Name        string    `json:"name"`
	Duty        string    `json:"duty"`
	Tags        []string  `json:"tags"`
	Runtime     string    `json:"runtime"`
	Model       string    `json:"model"`
	Effort      string    `json:"effort"`
	PersonaMode string    `json:"personaMode"`
	Worktree    bool      `json:"worktree"`
	Look        ProtoLook `json:"look"`
	Persona     string    `json:"persona"`
	Source      string    `json:"source"`
	Skills      []string  `json:"skills"`
	Installed   []string  `json:"installed"`
}

type artifactOverlay struct {
	ID          string         `json:"id"`
	Title       string         `json:"title"`
	Body        string         `json:"body"` // "blocks" | "html"
	Display     string         `json:"display,omitempty"`
	Channel     string         `json:"channel,omitempty"`
	SaidCh      string         `json:"saidCh,omitempty"`
	SaidNum     int64          `json:"saidNum,omitempty"`
	Issue       string         `json:"issue,omitempty"`
	By          string         `json:"by"`
	ByName      string         `json:"byName"`
	Deleted     bool           `json:"deleted,omitempty"`
	At          int64          `json:"at"`
	Updated     int64          `json:"updated"`
	RawNotes    map[int]string `json:"rawNotes,omitempty"`
	VersionMsgs map[int]int64  `json:"versionMsgs,omitempty"`
}

type mediaInputRecord struct {
	ProtoMediaInput
	Bytes []byte `json:"bytes,omitempty"`
}

type mediaJobRecord struct {
	Kind string          `json:"kind"`
	Raw  json.RawMessage `json:"raw"`
}

type pkmPageExtra struct {
	Slug     string            `json:"slug"`
	Title    string            `json:"title"`
	Tier     string            `json:"tier"`
	RelPath  string            `json:"relPath"`
	Markdown string            `json:"markdown"`
	Props    map[string]string `json:"props,omitempty"`
	Updated  int64             `json:"updated"`
}

type pkmUndoRecord struct {
	Page     string `json:"page"`
	RelPath  string `json:"relPath"`
	Markdown string `json:"markdown"`
	What     string `json:"what"`
	Existed  bool   `json:"existed"`
}

type cronOverlay struct {
	Channel string          `json:"channel"`
	Agent   string          `json:"agent,omitempty"`
	Repo    string          `json:"repo,omitempty"`
	TZ      string          `json:"tz"`
	By      string          `json:"by"`
	Pending bool            `json:"pending,omitempty"`
	When    json.RawMessage `json:"when,omitempty"`
	Deleted bool            `json:"deleted,omitempty"`
}

type overlayState struct {
	NextIssueNumber  int                              `json:"nextIssueNumber"`
	NextMsgSeq       int64                            `json:"nextMsgSeq"`
	DefaultChannel   string                           `json:"defaultChannel,omitempty"`
	StartersSeeded   bool                             `json:"startersSeeded,omitempty"`
	Issues           map[string]*issueOverlay         `json:"issues"`
	Channels         map[string]*channelOverlay       `json:"channels"`
	Agents           map[string]*agentOverlay         `json:"agents"`
	Templates        map[string]*agentTemplateRecord  `json:"templates"`
	DeletedSkills    map[string]bool                  `json:"deletedSkills"`
	RuntimeSettings  map[string]*ProtoRuntimeSettings `json:"runtimeSettings"`
	RuntimeCheckedAt map[string]int64                 `json:"runtimeCheckedAt,omitempty"`
	Crons            map[string]*cronOverlay          `json:"crons"`
	Artifacts        map[string]*artifactOverlay      `json:"artifacts"`
	Library          []ProtoLibraryItem               `json:"library"`
	MediaInputs      map[string]*mediaInputRecord     `json:"mediaInputs"`
	MediaJobs        map[string]*mediaJobRecord       `json:"mediaJobs"`
	PKMPages         map[string]*pkmPageExtra         `json:"pkmPages"`
	PKMComments      []ProtoPkmComment                `json:"pkmComments"`
	PKMClips         map[string]string                `json:"pkmClips"` // url -> page slug
	PKMUndo          *pkmUndoRecord                   `json:"pkmUndo,omitempty"`
	RequestKeys      map[string]string                `json:"requestKeys"`
	Sessions         map[string]*ProtoSession         `json:"sessions"`
	SessionEvents    map[string][]ProtoSessionEvent   `json:"sessionEvents"`
	OrchNoKeySent    map[string]bool                  `json:"orchNoKeySent,omitempty"`
	FailedRuns       map[string]bool                  `json:"failedRuns,omitempty"`
	GitHub           *ProtoGitHubStatus               `json:"github,omitempty"`
}

type gatewayHub struct {
	st *stack.Stack

	mu    sync.RWMutex
	state overlayState

	liveMu   sync.Mutex
	liveSubs map[uint64]chan json.RawMessage
	liveSeq  atomic.Uint64

	eventsMu   sync.Mutex
	eventsSubs map[uint64]chan json.RawMessage
	eventsSeq  atomic.Uint64

	chanMu   sync.Mutex
	chanSubs map[uint64]chan channelBroadcast
	chanSeq  atomic.Uint64

	artMu   sync.Mutex
	artSubs map[uint64]chan artifactBroadcast
	artSeq  atomic.Uint64
}

type channelBroadcast struct {
	ChannelID string
	Revision  int64
	Message   ProtoChatMessage
}

type artifactBroadcast struct {
	ArtifactID  string
	Suggestions bool
	Seq         int64
}

func newGatewayHub(st *stack.Stack) *gatewayHub {
	h := &gatewayHub{
		st:         st,
		liveSubs:   make(map[uint64]chan json.RawMessage),
		eventsSubs: make(map[uint64]chan json.RawMessage),
		chanSubs:   make(map[uint64]chan channelBroadcast),
		artSubs:    make(map[uint64]chan artifactBroadcast),
	}
	h.state = emptyOverlayState()
	if st != nil && st.Store != nil {
		if doc, err := st.Store.GetDocument(context.Background(), overlayScopeKind, overlayScopeID, overlayDocKind); err == nil && len(doc.StateJSON) > 0 {
			var loaded overlayState
			if json.Unmarshal(doc.StateJSON, &loaded) == nil {
				normalizeLoadedOverlay(&loaded)
				h.state = loaded
			}
		}
		h.seedDefaults()
	}
	return h
}

func emptyOverlayState() overlayState {
	st := overlayState{
		NextIssueNumber: 1,
		NextMsgSeq:      100,
	}
	normalizeLoadedOverlay(&st)
	return st
}

func normalizeLoadedOverlay(s *overlayState) {
	if s.NextIssueNumber <= 0 {
		s.NextIssueNumber = 1
	}
	if s.NextMsgSeq <= 0 {
		s.NextMsgSeq = 100
	}
	if s.Issues == nil {
		s.Issues = make(map[string]*issueOverlay)
	}
	if s.Channels == nil {
		s.Channels = make(map[string]*channelOverlay)
	}
	if s.Agents == nil {
		s.Agents = make(map[string]*agentOverlay)
	}
	if s.Templates == nil {
		s.Templates = make(map[string]*agentTemplateRecord)
	}
	if s.DeletedSkills == nil {
		s.DeletedSkills = make(map[string]bool)
	}
	if s.RuntimeSettings == nil {
		s.RuntimeSettings = make(map[string]*ProtoRuntimeSettings)
	}
	if s.RuntimeCheckedAt == nil {
		s.RuntimeCheckedAt = make(map[string]int64)
	}
	if s.Crons == nil {
		s.Crons = make(map[string]*cronOverlay)
	}
	if s.Artifacts == nil {
		s.Artifacts = make(map[string]*artifactOverlay)
	}
	if s.Library == nil {
		s.Library = []ProtoLibraryItem{}
	}
	if s.MediaInputs == nil {
		s.MediaInputs = make(map[string]*mediaInputRecord)
	}
	if s.MediaJobs == nil {
		s.MediaJobs = make(map[string]*mediaJobRecord)
	}
	if s.PKMPages == nil {
		s.PKMPages = make(map[string]*pkmPageExtra)
	}
	if s.PKMComments == nil {
		s.PKMComments = []ProtoPkmComment{}
	}
	if s.PKMClips == nil {
		s.PKMClips = make(map[string]string)
	}
	if s.RequestKeys == nil {
		s.RequestKeys = make(map[string]string)
	}
	if s.Sessions == nil {
		s.Sessions = make(map[string]*ProtoSession)
	}
	if s.SessionEvents == nil {
		s.SessionEvents = make(map[string][]ProtoSessionEvent)
	}
	if s.OrchNoKeySent == nil {
		s.OrchNoKeySent = make(map[string]bool)
	}
	if s.FailedRuns == nil {
		s.FailedRuns = make(map[string]bool)
	}
}

func (h *gatewayHub) seedDefaults() {
	if h.st == nil {
		return
	}
	ctx := context.Background()
	if h.st.Channels != nil {
		chs, err := h.st.Channels.ListChannels(ctx)
		if err == nil {
			hasDefault := false
			hasOrchDM := false
			for _, ch := range chs {
				if ch.ID == defaultChannelID || ch.IsDefault {
					hasDefault = true
				}
				if ch.Type == channel.TypeDirect && ch.PeerID == "orchestrator" {
					hasOrchDM = true
				}
			}
			if !hasDefault {
				_, _, _ = h.st.Channels.EnsureChannel(ctx, channel.Channel{
					ID:             defaultChannelID,
					Type:           channel.TypePublic,
					Name:           defaultChannelName,
					DefaultAgentID: "orchestrator",
					IsDefault:      true,
				})
				h.mu.Lock()
				if h.state.DefaultChannel == "" {
					h.state.DefaultChannel = defaultChannelID
				}
				chMeta := h.ensureChannelMetaLocked(defaultChannelID)
				chMeta.Default = true
				chMeta.HasDefault = true
				if !chMeta.HasMembers {
					chMeta.Members = []string{"orchestrator"}
					chMeta.HasMembers = true
					chMeta.Orchestrator = "orchestrator"
				}
				h.mu.Unlock()
			} else {
				h.mu.Lock()
				chMeta := h.ensureChannelMetaLocked(defaultChannelID)
				if !chMeta.HasMembers {
					chMeta.Members = []string{"orchestrator"}
					chMeta.HasMembers = true
					if chMeta.Orchestrator == "" {
						chMeta.Orchestrator = "orchestrator"
					}
				}
				h.mu.Unlock()
			}
			if !hasOrchDM {
				_, _, _ = h.st.Channels.EnsureChannel(ctx, channel.Channel{
					ID:             "dm:orchestrator",
					Type:           channel.TypeDirect,
					Name:           "orchestrator",
					PeerID:         "orchestrator",
					DefaultAgentID: "orchestrator",
				})
				h.mu.Lock()
				dmMeta := h.ensureChannelMetaLocked("dm:orchestrator")
				dmMeta.Title = "orchestrator"
				dmMeta.Orchestrator = "orchestrator"
				h.mu.Unlock()
			}
		}
	}
	h.mu.Lock()
	seeded := h.state.StartersSeeded
	if len(h.state.Templates) == 0 {
		for _, def := range builtinStarters {
			rec := def.record("zh")
			if def.id == "orchestrator" {
				rec.Installed = []string{"orchestrator"}
			}
			cp := rec
			h.state.Templates[def.id] = &cp
		}
	}
	h.mu.Unlock()

	if !seeded {
		locale := "zh"
		if h.st.Setting != nil && h.st.Setting.Get().Locale == "en" {
			locale = "en"
		}
		if h.st.Agents != nil {
			if orchDef, ok := findBuiltinStarter("orchestrator"); ok {
				rec := orchDef.record(locale)
				if existing, err := h.st.Agents.GetProfile(ctx, "orchestrator"); err == nil && (existing.Name == "Orchestrator" || existing.Name == "" || existing.Name == "orchestrator") {
					_, _ = h.st.Agents.SaveProfile(ctx, agent.Profile{
						ID:          "orchestrator",
						Name:        rec.Name,
						Role:        agent.RoleOrchestrator,
						Duty:        rec.Duty,
						Tags:        copyStrings(rec.Tags),
						Runtime:     "vibevalley",
						Persona:     rec.Persona,
						PersonaMode: agent.PersonaAppend,
						Skills:      copyStrings(rec.Skills),
						UseWorktree: rec.Worktree,
					})
				}
				h.mu.Lock()
				meta := h.ensureAgentMetaLocked("orchestrator")
				if meta.Look == nil {
					lk := rec.Look
					meta.Look = &lk
				}
				if meta.From == nil {
					meta.From = &ProtoAgentFrom{Template: "orchestrator", Version: rec.Version}
				}
				h.mu.Unlock()
			}
			if rawStarters := strings.TrimSpace(os.Getenv("VIBEVALLEY_AGENT_STARTERS")); rawStarters != "" {
				for _, part := range strings.Split(rawStarters, ",") {
					tid := strings.TrimSpace(part)
					if tid == "" {
						continue
					}
					def, ok := findBuiltinStarter(tid)
					if !ok {
						continue
					}
					if _, existsErr := h.st.Agents.GetProfile(ctx, tid); existsErr == nil {
						continue
					}
					rec := def.record(locale)
					saved, sErr := h.st.Agents.SaveProfile(ctx, agent.Profile{
						ID:          tid,
						Name:        firstNonEmpty(rec.Name, tid),
						Role:        agent.Role(firstNonEmpty(rec.Role, "worker")),
						Duty:        rec.Duty,
						Tags:        copyStrings(rec.Tags),
						Runtime:     firstNonEmpty(rec.Runtime, "claude"),
						Model:       rec.Model,
						Effort:      rec.Effort,
						Persona:     rec.Persona,
						PersonaMode: agent.PersonaMode(firstNonEmpty(rec.PersonaMode, "append")),
						Skills:      copyStrings(rec.Skills),
						UseWorktree: rec.Worktree,
					})
					if sErr == nil {
						h.mu.Lock()
						meta := h.ensureAgentMetaLocked(saved.ID)
						lk := rec.Look
						meta.Look = &lk
						meta.From = &ProtoAgentFrom{Template: tid, Version: rec.Version}
						if tpl := h.state.Templates[tid]; tpl != nil {
							if !slices.Contains(tpl.Installed, saved.ID) {
								tpl.Installed = append(tpl.Installed, saved.ID)
							}
						}
						h.mu.Unlock()
					}
				}
			}
		}
		h.mu.Lock()
		h.state.StartersSeeded = true
		h.mu.Unlock()
	}
	_ = h.persist()
}

func (h *gatewayHub) persist() error {
	if h.st == nil || h.st.Store == nil {
		return nil
	}
	h.mu.RLock()
	raw, err := json.Marshal(h.state)
	h.mu.RUnlock()
	if err != nil {
		return err
	}
	_, err = h.st.Store.PutDocument(context.Background(), overlayScopeKind, overlayScopeID, overlayDocKind, raw)
	return err
}

func (h *gatewayHub) nowMs() int64 {
	return time.Now().UnixMilli()
}

func (h *gatewayHub) getOrInitRuntimeCheckedAt(id string) int64 {
	h.mu.RLock()
	ts := h.state.RuntimeCheckedAt[id]
	h.mu.RUnlock()
	if ts > 0 {
		return ts
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if ts = h.state.RuntimeCheckedAt[id]; ts > 0 {
		return ts
	}
	ts = h.nowMs()
	if h.state.RuntimeCheckedAt == nil {
		h.state.RuntimeCheckedAt = make(map[string]int64)
	}
	h.state.RuntimeCheckedAt[id] = ts
	return ts
}

func (h *gatewayHub) refreshRuntimeCheckedAt(id string) int64 {
	ts := h.nowMs()
	h.mu.Lock()
	if h.state.RuntimeCheckedAt == nil {
		h.state.RuntimeCheckedAt = make(map[string]int64)
	}
	h.state.RuntimeCheckedAt[id] = ts
	h.mu.Unlock()
	return ts
}

func (h *gatewayHub) notifyAllState() {
	if h.st != nil {
		h.st.NotifyStateChange()
	}
}

func (h *gatewayHub) emitLiveEvent(ev any) {
	raw, err := json.Marshal(ev)
	if err != nil {
		return
	}
	h.liveMu.Lock()
	for _, ch := range h.liveSubs {
		select {
		case ch <- raw:
		default:
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- raw:
			default:
			}
		}
	}
	h.liveMu.Unlock()
	h.emitServerEventRaw(raw)
}

func (h *gatewayHub) emitServerEventRaw(raw []byte) {
	h.eventsMu.Lock()
	for _, ch := range h.eventsSubs {
		select {
		case ch <- json.RawMessage(raw):
		default:
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- json.RawMessage(raw):
			default:
			}
		}
	}
	h.eventsMu.Unlock()
}

func (h *gatewayHub) emitServerEvent(ev any) {
	raw, err := json.Marshal(ev)
	if err != nil {
		return
	}
	h.emitServerEventRaw(raw)
}

func (h *gatewayHub) emitChannelMessage(chID string, rev int64, msg ProtoChatMessage) {
	b := channelBroadcast{ChannelID: chID, Revision: rev, Message: msg}
	h.chanMu.Lock()
	for _, ch := range h.chanSubs {
		select {
		case ch <- b:
		default:
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- b:
			default:
			}
		}
	}
	h.chanMu.Unlock()
	h.emitServerEvent(map[string]any{
		"type":    "messageChanged",
		"at":      msg.At,
		"message": msg,
	})
}

func (h *gatewayHub) emitArtifactChange(id string, suggestions bool, seq int64) {
	b := artifactBroadcast{ArtifactID: id, Suggestions: suggestions, Seq: seq}
	h.artMu.Lock()
	for _, ch := range h.artSubs {
		select {
		case ch <- b:
		default:
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- b:
			default:
			}
		}
	}
	h.artMu.Unlock()
}

func (h *gatewayHub) subscribeLive() (<-chan json.RawMessage, func()) {
	ch := make(chan json.RawMessage, 64)
	id := h.liveSeq.Add(1)
	h.liveMu.Lock()
	h.liveSubs[id] = ch
	h.liveMu.Unlock()
	return ch, func() {
		h.liveMu.Lock()
		delete(h.liveSubs, id)
		h.liveMu.Unlock()
	}
}

func (h *gatewayHub) subscribeEvents() (<-chan json.RawMessage, func()) {
	ch := make(chan json.RawMessage, 64)
	id := h.eventsSeq.Add(1)
	h.eventsMu.Lock()
	h.eventsSubs[id] = ch
	h.eventsMu.Unlock()
	return ch, func() {
		h.eventsMu.Lock()
		delete(h.eventsSubs, id)
		h.eventsMu.Unlock()
	}
}

func (h *gatewayHub) subscribeChannel() (<-chan channelBroadcast, func()) {
	ch := make(chan channelBroadcast, 64)
	id := h.chanSeq.Add(1)
	h.chanMu.Lock()
	h.chanSubs[id] = ch
	h.chanMu.Unlock()
	return ch, func() {
		h.chanMu.Lock()
		delete(h.chanSubs, id)
		h.chanMu.Unlock()
	}
}

func (h *gatewayHub) subscribeArtifact() (<-chan artifactBroadcast, func()) {
	ch := make(chan artifactBroadcast, 64)
	id := h.artSeq.Add(1)
	h.artMu.Lock()
	h.artSubs[id] = ch
	h.artMu.Unlock()
	return ch, func() {
		h.artMu.Lock()
		delete(h.artSubs, id)
		h.artMu.Unlock()
	}
}

func (h *gatewayHub) ensureIssueMetaLocked(issueID string) *issueOverlay {
	if m, ok := h.state.Issues[issueID]; ok && m != nil {
		return m
	}
	num := h.state.NextIssueNumber
	h.state.NextIssueNumber++
	m := &issueOverlay{
		Number:   num,
		Priority: "medium",
		Deliver:  "change",
		Strength: "explicit",
	}
	h.state.Issues[issueID] = m
	return m
}

func (h *gatewayHub) ensureChannelMetaLocked(channelID string) *channelOverlay {
	if m, ok := h.state.Channels[channelID]; ok && m != nil {
		if m.Pins == nil {
			m.Pins = make(map[string]int64)
		}
		if m.Edits == nil {
			m.Edits = make(map[string]messageEditRecord)
		}
		if m.MsgDeletes == nil {
			m.MsgDeletes = make(map[string]int64)
		}
		if m.Reactions == nil {
			m.Reactions = make(map[string][]ProtoReaction)
		}
		if m.Attachments == nil {
			m.Attachments = make(map[string][]string)
		}
		if m.ReplyTo == nil {
			m.ReplyTo = make(map[string]int64)
		}
		if m.Revisions == nil {
			m.Revisions = make(map[string]int64)
		}
		if m.ArtifactCards == nil {
			m.ArtifactCards = make(map[string]ProtoArtifactCard)
		}
		if m.QuotedBlocks == nil {
			m.QuotedBlocks = make(map[string][]ProtoQuotedBlock)
		}
		if m.MsgKinds == nil {
			m.MsgKinds = make(map[string]string)
		}
		return m
	}
	m := &channelOverlay{
		Notify:        "all",
		Pins:          make(map[string]int64),
		Edits:         make(map[string]messageEditRecord),
		MsgDeletes:    make(map[string]int64),
		Reactions:     make(map[string][]ProtoReaction),
		Attachments:   make(map[string][]string),
		ReplyTo:       make(map[string]int64),
		Revisions:     make(map[string]int64),
		ArtifactCards: make(map[string]ProtoArtifactCard),
		QuotedBlocks:  make(map[string][]ProtoQuotedBlock),
		MsgKinds:      make(map[string]string),
	}
	h.state.Channels[channelID] = m
	return m
}

func (h *gatewayHub) allocMsgRevLocked(curSeq int64) int64 {
	if h.state.NextMsgSeq <= curSeq {
		h.state.NextMsgSeq = curSeq + 1
	}
	seq := h.state.NextMsgSeq
	h.state.NextMsgSeq++
	return seq
}

func (h *gatewayHub) ensureAgentMetaLocked(agentID string) *agentOverlay {
	if m, ok := h.state.Agents[agentID]; ok && m != nil {
		return m
	}
	m := &agentOverlay{}
	h.state.Agents[agentID] = m
	return m
}

func (h *gatewayHub) allocMsgSeqLocked() int64 {
	seq := h.state.NextMsgSeq
	h.state.NextMsgSeq++
	return seq
}

func randomID(prefix string) string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	if prefix == "" {
		return hex.EncodeToString(b[:])
	}
	return prefix + "-" + hex.EncodeToString(b[:])
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func defaultPKMDir(st *stack.Stack) string {
	if st == nil {
		return ""
	}
	if st.Setting != nil {
		stInfo := st.Setting.Status()
		if strings.TrimSpace(stInfo.Paths.PKM) != "" {
			return stInfo.Paths.PKM
		}
	}
	if strings.TrimSpace(st.WorkRoot()) != "" {
		return filepath.Join(st.WorkRoot(), "pkm")
	}
	return ""
}

func ensureVaultDirIfConfigured(st *stack.Stack) string {
	dir := defaultPKMDir(st)
	if dir != "" {
		_ = os.MkdirAll(dir, 0o755)
	}
	return dir
}

func copyStrings(in []string) []string {
	if len(in) == 0 {
		return []string{}
	}
	return slices.Clone(in)
}

func errMsg(err error) string {
	if err == nil {
		return ""
	}
	var be *BizError
	if errors.As(err, &be) {
		return be.Message
	}
	return err.Error()
}

func formatMessageID(chID string, seq int64) string {
	return fmt.Sprintf("%s:%d", chID, seq)
}

func parseMessageID(id string) (string, int64, bool) {
	idx := strings.LastIndex(id, ":")
	if idx <= 0 || idx >= len(id)-1 {
		return "", 0, false
	}
	chID := id[:idx]
	var seq int64
	for _, ch := range id[idx+1:] {
		if ch < '0' || ch > '9' {
			return "", 0, false
		}
		seq = seq*10 + int64(ch-'0')
	}
	return chID, seq, seq > 0
}
