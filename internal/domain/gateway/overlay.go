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
	Number       int                     `json:"number"`
	Parent       string                  `json:"parent,omitempty"`
	BlockedBy    []string                `json:"blockedBy,omitempty"`
	Priority     string                  `json:"priority,omitempty"`
	Rank         *int                    `json:"rank,omitempty"`
	Deliver      string                  `json:"deliver,omitempty"`
	AutoSubmitPR bool                    `json:"autoSubmitPr,omitempty"`
	Strength     string                  `json:"strength,omitempty"`
	Criteria     []string                `json:"criteria,omitempty"`
	Moves        []string                `json:"moves,omitempty"`
	Findings     []ProtoFinding          `json:"findings,omitempty"`
	Questions    []ProtoQuestion         `json:"questions,omitempty"`
	Checks       []ProtoCriterionCheck   `json:"checks,omitempty"`
	Constraints  *ProtoIssueConstraints  `json:"constraints,omitempty"`
	QueuedAt     *int64                  `json:"queuedAt,omitempty"`
	ClosedAt     *int64                  `json:"closedAt,omitempty"`
	Delivered    string                  `json:"delivered,omitempty"`
	Canceled     string                  `json:"canceled,omitempty"`
	ReviewedAt   *int64                  `json:"reviewedAt,omitempty"`
	Cron         string                  `json:"cron,omitempty"`
	Deleted      bool                    `json:"deleted,omitempty"`
	Milestones   []ProtoMilestone        `json:"milestones,omitempty"`
	Answer       *ProtoIssueAnswer       `json:"answer,omitempty"`
	AgentHistory []ProtoAssignmentRecord `json:"agentHistory,omitempty"`
	Runs         []ProtoRun              `json:"runs,omitempty"`
	AgentHint    string                  `json:"agentHint,omitempty"`
}

type channelOverlay struct {
	Default      bool                         `json:"default,omitempty"`
	HasDefault   bool                         `json:"hasDefault,omitempty"`
	Category     string                       `json:"category,omitempty"`
	Position     *int                         `json:"position,omitempty"`
	Archived     *int64                       `json:"archived,omitempty"`
	Notify       string                       `json:"notify,omitempty"`
	Orchestrator string                       `json:"orchestrator,omitempty"`
	Members      []string                     `json:"members,omitempty"`
	Description  string                       `json:"description,omitempty"`
	HasDesc      bool                         `json:"hasDesc,omitempty"`
	Repo         string                       `json:"repo,omitempty"`
	Deleted      bool                         `json:"deleted,omitempty"`
	Title        string                       `json:"title,omitempty"`
	SubjectKind  string                       `json:"subjectKind,omitempty"`
	SubjectID    string                       `json:"subjectId,omitempty"`
	ReadNum      *int64                       `json:"readNum,omitempty"`
	LastAt       int64                        `json:"lastAt,omitempty"`
	Pins         map[string]int64             `json:"pins,omitempty"`
	Edits        map[string]messageEditRecord `json:"edits,omitempty"`
	MsgDeletes   map[string]int64             `json:"msgDeletes,omitempty"`
	Reactions    map[string][]ProtoReaction   `json:"reactions,omitempty"`
	Attachments  map[string][]string          `json:"attachments,omitempty"`
	ExtraMsgs    []ProtoChatMessage           `json:"extraMsgs,omitempty"`
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
	ID       string         `json:"id"`
	Title    string         `json:"title"`
	Body     string         `json:"body"` // "blocks" | "html"
	Display  string         `json:"display,omitempty"`
	Channel  string         `json:"channel,omitempty"`
	SaidCh   string         `json:"saidCh,omitempty"`
	SaidNum  int64          `json:"saidNum,omitempty"`
	Issue    string         `json:"issue,omitempty"`
	By       string         `json:"by"`
	ByName   string         `json:"byName"`
	Deleted  bool           `json:"deleted,omitempty"`
	At       int64          `json:"at"`
	Updated  int64          `json:"updated"`
	RawNotes map[int]string `json:"rawNotes,omitempty"`
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
	NextIssueNumber int                              `json:"nextIssueNumber"`
	NextMsgSeq      int64                            `json:"nextMsgSeq"`
	DefaultChannel  string                           `json:"defaultChannel,omitempty"`
	Issues          map[string]*issueOverlay         `json:"issues"`
	Channels        map[string]*channelOverlay       `json:"channels"`
	Agents          map[string]*agentOverlay         `json:"agents"`
	Templates       map[string]*agentTemplateRecord  `json:"templates"`
	DeletedSkills   map[string]bool                  `json:"deletedSkills"`
	RuntimeSettings map[string]*ProtoRuntimeSettings `json:"runtimeSettings"`
	Crons           map[string]*cronOverlay          `json:"crons"`
	Artifacts       map[string]*artifactOverlay      `json:"artifacts"`
	Library         []ProtoLibraryItem               `json:"library"`
	MediaInputs     map[string]*mediaInputRecord     `json:"mediaInputs"`
	MediaJobs       map[string]*mediaJobRecord       `json:"mediaJobs"`
	PKMPages        map[string]*pkmPageExtra         `json:"pkmPages"`
	PKMComments     []ProtoPkmComment                `json:"pkmComments"`
	PKMClips        map[string]string                `json:"pkmClips"` // url -> page slug
	PKMUndo         *pkmUndoRecord                   `json:"pkmUndo,omitempty"`
	RequestKeys     map[string]string                `json:"requestKeys"`
	Sessions        map[string]*ProtoSession         `json:"sessions"`
	SessionEvents   map[string][]ProtoSessionEvent   `json:"sessionEvents"`
	GitHub          *ProtoGitHubStatus               `json:"github,omitempty"`
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
}

func (h *gatewayHub) seedDefaults() {
	if h.st == nil {
		return
	}
	ctx := context.Background()
	if h.st.Channels != nil {
		chs, err := h.st.Channels.ListChannels(ctx)
		if err == nil && len(chs) == 0 {
			_, _, _ = h.st.Channels.EnsureChannel(ctx, channel.Channel{
				ID:        defaultChannelID,
				Type:      channel.TypePublic,
				Name:      defaultChannelName,
				IsDefault: true,
			})
			h.mu.Lock()
			if h.state.DefaultChannel == "" {
				h.state.DefaultChannel = defaultChannelID
			}
			chMeta := h.ensureChannelMetaLocked(defaultChannelID)
			chMeta.Default = true
			chMeta.HasDefault = true
			h.mu.Unlock()
		}
	}
	h.mu.Lock()
	if len(h.state.Templates) == 0 {
		h.state.Templates["builtin-orchestrator"] = &agentTemplateRecord{
			ID:          "builtin-orchestrator",
			Version:     1,
			Role:        "orchestrator",
			Name:        "Farm Assistant",
			Duty:        "Coordinate farm tasks, dispatch worker sessions, and report results.",
			Tags:        []string{"assistant", "coordinator"},
			Runtime:     "vibevalley",
			Model:       "deepseek-chat",
			Effort:      "medium",
			PersonaMode: "append",
			Worktree:    false,
			Look:        defaultLook("orchestrator", "vibevalley"),
			Persona:     "Coordinate VibeValley work cleanly.",
			Source:      "builtIn",
			Skills:      []string{},
			Installed:   []string{"orchestrator"},
		}
		h.state.Templates["builtin-coder"] = &agentTemplateRecord{
			ID:          "builtin-coder",
			Version:     1,
			Role:        "worker",
			Name:        "Coder",
			Duty:        "Write, refactor, and test code in repository worktrees.",
			Tags:        []string{"coding", "testing"},
			Runtime:     "claude",
			Model:       "",
			Effort:      "high",
			PersonaMode: "append",
			Worktree:    true,
			Look:        defaultLook("worker", "claude"),
			Persona:     "Ship well-tested changes.",
			Source:      "builtIn",
			Skills:      []string{"vibevalley"},
			Installed:   []string{},
		}
	}
	h.mu.Unlock()
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
		return m
	}
	m := &channelOverlay{
		Notify:      "all",
		Pins:        make(map[string]int64),
		Edits:       make(map[string]messageEditRecord),
		MsgDeletes:  make(map[string]int64),
		Reactions:   make(map[string][]ProtoReaction),
		Attachments: make(map[string][]string),
	}
	h.state.Channels[channelID] = m
	return m
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
