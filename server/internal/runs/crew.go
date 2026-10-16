package runs

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"maps"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/fx"

	"vibevalley/internal/base"
	"vibevalley/internal/memory"
	"vibevalley/internal/projects"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/smith/agents"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// smith runs sessions without permission prompts or a sandbox: the only fence is where a helper starts, inside VIBEVALLEY_WORK_ROOT in its own
// worktree. The chat calls Deliver holding its own lock, so nothing here calls back into the chat. smith's spawn takes only model, effort, env and
// cwd, and its runtime registry is fixed once made, so each session gets a Subagents of its own over a one-runtime registry that carries the agent's
// persona, MCP servers and disallowed tools (crewWithOptions).

const (
	// A burst of changes is one write.
	crewSaveCrewAfter = 300 * time.Millisecond
	// A report waits at most this long for its turn's last events (what it spent).
	crewReportWait = 2 * time.Second
	crewCloseWait  = 15 * time.Second
)

type crewSaved struct {
	Hired int64           `json:"hired"`
	Hands []crewSavedHand `json:"hands"`
}

type crewSavedHand struct {
	ID        string         `json:"id"`
	Place     base.Workplace `json:"place"`
	SessionID string         `json:"sessionId,omitzero"`
	LastText  string         `json:"lastText,omitzero"`
	// A resumed session is not reminded of these again.
	Recalled []string `json:"recalled,omitzero"`
}

// Applied only once the session's events up to last are read.
type crewReport struct {
	report agents.SubagentReport
	until  int64
}

type crewSession struct {
	subagents *agents.Subagents
	agent     *agents.Subagent
	processed atomic.Int64
	detached  atomic.Bool

	mu      sync.Mutex
	reports []crewReport
	wake    chan struct{}
	stop    func()
}

func (s *crewSession) received(report agents.SubagentReport) {
	until := int64(-1)
	if a := s.subagents.Get(report.ID); a != nil {
		if records := a.Session.Records(); len(records) > 0 {
			until = records[len(records)-1].Seq
		}
	}
	s.mu.Lock()
	s.reports = append(s.reports, crewReport{report, until})
	close(s.wake)
	s.wake = make(chan struct{})
	s.mu.Unlock()
}

func (s *crewSession) next(done <-chan struct{}) (crewReport, bool) {
	for {
		s.mu.Lock()
		if len(s.reports) > 0 {
			r := s.reports[0]
			s.reports = s.reports[1:]
			s.mu.Unlock()
			return r, true
		}
		wake := s.wake
		s.mu.Unlock()
		select {
		case <-wake:
		case <-done:
			return crewReport{}, false
		}
	}
}

type crewHand struct {
	id      string
	place   base.Workplace
	journal base.Journal

	mu        sync.Mutex
	sess      *crewSession
	sessionID string
	lastText  string
	tracking  crewTracking
	// As the chat names it: <id>#<n>; "" when it has none.
	session  string
	spoke    bool
	recalled map[string]bool
	released chan struct{}
}

type Crew struct {
	site         *base.Site
	store        *base.Store
	tokens       *Tokens
	trajectories *Trajectories
	memories     *memory.Memories
	projects     *projects.Projects
	runtimes     *Runtimes
	root         string
	file         string
	logDir       string
	farmURL      string
	stallMs      int64
	activity     *base.Hub[base.SessionActivity]
	disk         *base.FileWriter

	mu       sync.Mutex
	hands    map[string]*crewHand
	hired    int64
	launches int64
	closing  bool
	pending  *time.Timer
}

type crewIn struct {
	fx.In
	Config       base.Config
	Site         *base.Site
	Store        *base.Store
	Tokens       *Tokens
	Trajectories *Trajectories
	Memories     *memory.Memories
	Projects     *projects.Projects
	Runtimes     *Runtimes
}

func newCrew(in crewIn) (*Crew, error) {
	root, err := filepath.Abs(in.Config.WorkRoot)
	if err != nil {
		return nil, err
	}
	host, port := os.Getenv("HOST"), os.Getenv("PORT")
	if host == "" {
		host = "127.0.0.1"
	}
	if port == "" {
		port = "8787"
	}
	c := &Crew{
		site: in.Site, store: in.Store, tokens: in.Tokens, trajectories: in.Trajectories, memories: in.Memories,
		projects: in.Projects, runtimes: in.Runtimes,
		root:     root,
		file:     filepath.Join(in.Config.Home, "crew.json"),
		farmURL:  "http://" + host + ":" + port + "/mcp",
		logDir:   filepath.Join(in.Config.Home, "logs"),
		stallMs:  int64(base.EnvNumber("VIBEVALLEY_STALL_SECONDS", 240) * 1000),
		activity: base.NewHub[base.SessionActivity](),
		hands:    map[string]*crewHand{},
	}
	c.disk = base.NewFileWriter(c.file, 0o644)
	return c, nil
}

// For a farm listening on a free port (PORT=0): sessions opened from now on reach /mcp there.
func (c *Crew) SetAddress(addr string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.farmURL = "http://" + addr + "/mcp"
}

func (c *Crew) FarmURL() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.farmURL
}

func (*Crew) OnStart(context.Context) error { return nil }

func (c *Crew) OnReady(context.Context) { c.restore() }

// The sessions are let go first: a turn cut off by the shutdown is reported when the farm comes back (restore), not on the way out.
func (c *Crew) OnStop() {
	c.mu.Lock()
	c.closing = true
	if c.pending != nil {
		c.pending.Stop()
	}
	hands := slices.Collect(maps.Values(c.hands))
	c.mu.Unlock()
	if err := c.disk.Write(c.body); err != nil {
		log.Printf("vibevalley: could not save crew.json: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), crewCloseWait)
	defer cancel()
	var group sync.WaitGroup
	for _, h := range hands {
		h.journal.Close()
		h.mu.Lock()
		s := h.sess
		c.releaseLocked(h)
		h.mu.Unlock()
		if s != nil {
			group.Go(func() { _ = s.subagents.Close(ctx) })
		}
	}
	group.Wait()
}

func (c *Crew) helpers() []protocol.Helper { return c.site.State().Helpers }

func (c *Crew) working(id string) bool {
	if h := c.site.Helper(id); h != nil {
		_, ok := h.Phase.Value.(protocol.PhaseWorking)
		return ok
	}
	return false
}

func (c *Crew) hand(id string) *crewHand {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.hands[id]
}

func (c *Crew) Activity() *base.Hub[base.SessionActivity] { return c.activity }

func (c *Crew) signal(a base.SessionActivity) { c.activity.Publish(a) }

// Called with h.mu held.
func (c *Crew) closedLocked(h *crewHand) {
	if h.session != "" {
		c.signal(base.SessionActivity{Kind: "closed", ID: h.id, Session: h.session})
	}
	h.session = ""
}

func (c *Crew) closed(h *crewHand) {
	h.mu.Lock()
	defer h.mu.Unlock()
	c.closedLocked(h)
}

func (c *Crew) trajectoryOf(helper protocol.Helper) base.Journal {
	head := protocol.TrajectoryHead{ID: helper.ID, Name: helper.Name, StartedAt: helper.HiredAt}
	agent, runtime, job := helper.Agent, helper.Runtime, helper.Task
	head.Agent, head.Runtime, head.Job = &agent, &runtime, &job
	if helper.Project != nil {
		project := *helper.Project
		head.Project = &project
	}
	if helper.Playbook != nil {
		playbook := *helper.Playbook
		head.Playbook = &playbook
	}
	head.Issue = helper.Issue
	return c.trajectories.Open(head, 0)
}

func (c *Crew) body() ([]byte, error) {
	c.mu.Lock()
	saved := crewSaved{Hired: c.hired, Hands: []crewSavedHand{}}
	hands := slices.Collect(maps.Values(c.hands))
	c.mu.Unlock()
	slices.SortFunc(hands, func(a, b *crewHand) int { return strings.Compare(a.id, b.id) })
	for _, h := range hands {
		h.mu.Lock()
		s := crewSavedHand{ID: h.id, Place: h.place, SessionID: h.sessionID, LastText: h.lastText, Recalled: slices.Sorted(maps.Keys(h.recalled))}
		if h.sess != nil {
			if id := h.sess.agent.Info().SessionID; id != "" {
				s.SessionID = id
			}
		}
		h.mu.Unlock()
		saved.Hands = append(saved.Hands, s)
	}
	return json.Marshal(saved)
}

func (c *Crew) save() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closing {
		return
	}
	if c.pending != nil {
		c.pending.Stop()
	}
	c.pending = time.AfterFunc(crewSaveCrewAfter, func() {
		if err := c.disk.Write(c.body); err != nil {
			log.Printf("vibevalley: could not save crew.json: %v", err)
		}
	})
}

func (c *Crew) restore() {
	saved := crewSaved{}
	if body, err := os.ReadFile(c.file); err == nil {
		if json.Unmarshal(body, &saved) != nil {
			saved = crewSaved{}
		}
	}
	// Numbering goes on from the highest id seen, so a new helper never takes an old one's steps.
	c.hired = saved.Hired
	for _, h := range c.helpers() {
		if n, err := strconv.ParseInt(strings.TrimPrefix(h.ID, "w"), 10, 64); err == nil && n > c.hired {
			c.hired = n
		}
	}
	for _, helper := range c.helpers() {
		i := slices.IndexFunc(saved.Hands, func(s crewSavedHand) bool { return s.ID == helper.ID })
		var s *crewSavedHand
		if i >= 0 {
			s = &saved.Hands[i]
		}
		if s == nil || !crewExists(s.Place.Cwd) {
			lost := protocol.IssueCloseLost
			c.site.Apply(protocol.FactLeft{ID: helper.ID, Closed: &lost})
			c.trajectories.Finish(helper.ID, protocol.IssueCloseLost, &helper)
			where := ""
			if s != nil {
				where = "（" + s.Place.Cwd + "）"
			}
			c.site.Notice(protocol.NoticeLevelWarn, fmt.Sprintf("%s 干活的目录不见了%s，没接回来", helper.Name, where))
			continue
		}
		recalled := map[string]bool{}
		for _, id := range s.Recalled {
			recalled[id] = true
		}
		c.hands[helper.ID] = &crewHand{id: helper.ID, place: s.Place, journal: c.trajectoryOf(helper), sessionID: s.SessionID, lastText: s.LastText, recalled: recalled}
		if protocol.IsBusy(helper) {
			c.site.Apply(protocol.FactReport{ID: helper.ID, Outcome: protocol.OutcomeInterrupted, Summary: "VibeValley 重启了，这一轮停在了半路", Turns: helper.Turns})
			c.site.Notice(protocol.NoticeLevelInfo, fmt.Sprintf("VibeValley 重启过，%s 那一轮停下了；给它带句话就能接着干", helper.Name))
		}
	}
	if len(c.hands) > 0 {
		log.Printf("vibevalley: 接回 %d 个帮工", len(c.hands))
	}
}

func crewExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func (c *Crew) NoRoom(runtime, project string) string {
	return crewNoRoom(c.helpers(), runtime, base.Trim(project), c.limits(runtime), "")
}

func (c *Crew) limits(runtime string) crewLimits {
	l := crewLimits{Farm: protocol.MaxRunning, PerProject: c.projects.Limit()}
	if s := c.store.Settings(runtime); s.MaxWorking != nil {
		l.PerRuntime = int(*s.MaxWorking)
	}
	return l
}

func (c *Crew) watch(h *crewHand, s *crewSession, runtime string) oar.EventObserver {
	return func(event oar.Event) {
		if s.detached.Load() {
			return
		}
		var signals []base.SessionActivity
		h.mu.Lock()
		if h.session != "" && h.sess == s {
			switch event.Body.(type) {
			case oar.TurnStarted:
				h.spoke = false
			case oar.Reasoning, oar.TextDelta, oar.ToolCallStarted:
				if !h.spoke {
					h.spoke = true
					signals = append(signals, base.SessionActivity{Kind: "spoke", ID: h.id, Session: h.session})
				}
			case oar.CompactionStarted:
				signals = append(signals, base.SessionActivity{Kind: "compacting", ID: h.id, On: true})
			case oar.CompactionEnded:
				signals = append(signals, base.SessionActivity{Kind: "compacting", ID: h.id, On: false})
			}
		}
		reaction := crewSessionFacts(event, c.site.Helper(h.id), h.tracking, crewSessionContext{ID: h.id, Runtime: runtime, Cwd: h.place.Cwd, CnyPerUsd: c.runtimes.CnyPerUsd()})
		h.tracking = reaction.Tracking
		if reaction.Model != "" {
			h.tracking.Price = c.runtimes.Price(runtime, reaction.Model)
		}
		h.mu.Unlock()
		for _, a := range signals {
			c.signal(a)
		}
		for _, op := range reaction.Journal {
			crewRecord(h.journal, op)
		}
		for _, fact := range reaction.Facts {
			c.site.Apply(fact)
		}
		if reaction.SpentCny != 0 {
			c.runtimes.Spend(runtime, reaction.SpentCny)
		}
		if reaction.Warn != "" {
			c.site.Notice(protocol.NoticeLevelWarn, reaction.Warn)
		}
		if _, exited := event.Body.(oar.Exited); exited {
			c.closed(h)
		}
	}
}

func (c *Crew) applyReport(h *crewHand, report agents.SubagentReport) {
	helper := c.site.Helper(h.id)
	if helper == nil {
		return
	}
	read := crewReadReport(report.Outcome, report.Text)
	h.mu.Lock()
	var spent *protocol.Spent
	if helper.Spent != nil {
		spent = crewSince(*helper.Spent, h.tracking.TurnFrom)
	}
	h.lastText = read.Text
	h.tracking.TurnFrom = nil
	session, spoke := h.session, h.spoke
	h.mu.Unlock()
	c.site.Apply(protocol.FactReport{ID: h.id, Outcome: read.Outcome, Summary: read.Summary, Turns: int64(report.Turn), Spent: spent})
	project := h.place.Project
	go c.memories.Keep(base.FinishedTurn{Agent: helper.Agent, Helper: h.id, Project: project, Job: helper.Task, Outcome: read.Outcome, Said: read.Text, Summary: read.Summary})
	if read.NeedsYou {
		c.site.Notice(protocol.NoticeLevelError, fmt.Sprintf("%s 停下了：%s", helper.Name, read.Failure))
	}
	if session != "" {
		c.signal(base.SessionActivity{Kind: "ended", ID: h.id, Session: session, Outcome: read.Outcome, Spoke: spoke})
	}
	c.runtimes.UsageSoon(helper.Runtime)
	c.save()
}

// Each report waits until its turn's events are read: what the turn spent arrives in the same frame as its end.
func (c *Crew) reports(h *crewHand, s *crewSession, released <-chan struct{}) {
	for {
		r, ok := s.next(released)
		if !ok {
			return
		}
		deadline := time.Now().Add(crewReportWait)
		for s.processed.Load() < r.until && time.Now().Before(deadline) && !s.detached.Load() {
			time.Sleep(5 * time.Millisecond)
		}
		if s.detached.Load() {
			return
		}
		c.applyReport(h, r.report)
	}
}

func (c *Crew) stalled(h *crewHand, silentForMs int64) {
	helper := c.site.Helper(h.id)
	if helper == nil {
		return
	}
	working, ok := helper.Phase.Value.(protocol.PhaseWorking)
	if !ok {
		return
	}
	h.mu.Lock()
	h.tracking.Quiet = true
	h.mu.Unlock()
	c.site.Apply(protocol.FactQuiet{ID: h.id, Since: base.NowMs() - silentForMs})
	quiet := fmt.Sprintf("%d 分钟", int64(math.Round(float64(silentForMs)/60_000)))
	if silentForMs < 60_000 {
		quiet = fmt.Sprintf("%d 秒", int64(math.Round(float64(silentForMs)/1000)))
	}
	last := ""
	if label := working.Doing.Label; label != "" {
		last = "（最后在：" + label + "）"
	}
	h.journal.Note(protocol.StepKindProblem, fmt.Sprintf("已经 %s没动静了%s。可能在跑很久的命令，也可能卡住了", quiet, last), nil)
	c.site.Notice(protocol.NoticeLevelWarn, fmt.Sprintf("%s 已经 %s没动静了%s：点它的地看看过程，不对就叫停", helper.Name, quiet, last))
}

// smith's ObserveStalls only arms on records it sees live and misses a turn that went quiet before it subscribed, so the status is polled.
func (c *Crew) watchStalls(h *crewHand, s *crewSession, released <-chan struct{}) {
	every := time.Duration(max(100, min(c.stallMs/4, 15_000))) * time.Millisecond
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	flagged := int64(-1)
	for {
		select {
		case <-released:
			return
		case <-ticker.C:
		}
		stall := observe.StallOf(s.agent.Session.Status().Value, base.NowMs(), c.stallMs)
		if stall == nil || stall.SinceSeq == flagged || s.detached.Load() {
			continue
		}
		flagged = stall.SinceSeq
		c.stalled(h, stall.SilentForMs)
	}
}

func (c *Crew) attach(h *crewHand, s *crewSession, runtime string) {
	c.mu.Lock()
	c.launches++
	launch := c.launches
	c.mu.Unlock()
	h.mu.Lock()
	old := h.sess
	if old != nil {
		c.releaseLocked(h)
	}
	released := make(chan struct{})
	h.sess, h.released = s, released
	h.session = fmt.Sprintf("%s#%d", h.id, launch)
	h.spoke = false
	if id := s.agent.Info().SessionID; id != "" {
		h.sessionID = id
	}
	h.tracking.SessionTokens = nil
	h.mu.Unlock()
	if old != nil {
		go func() { _ = old.subagents.Close(context.Background()) }()
	}
	// From the session's first record: its turn may have started (or ended) before this line runs.
	reader := observe.EventsReader(c.watch(h, s, runtime))
	stopEvents := s.agent.Session.RawEvents(func(record oar.RawEvent) {
		reader(record)
		s.processed.Store(record.Seq)
	}, &oar.Cursor{SessionID: s.agent.Session.ID(), AfterSeq: -1})
	s.mu.Lock()
	s.stop = stopEvents
	s.mu.Unlock()
	go c.watchStalls(h, s, released)
	go c.reports(h, s, released)
	c.save()
}

// Called with h.mu held.
func (c *Crew) releaseLocked(h *crewHand) {
	s := h.sess
	if s == nil {
		return
	}
	s.detached.Store(true)
	s.mu.Lock()
	if s.stop != nil {
		s.stop()
	}
	s.mu.Unlock()
	if h.released != nil {
		close(h.released)
		h.released = nil
	}
}

func (c *Crew) open(ctx context.Context, agent protocol.AgentProfile, id string, place base.Workplace, input, resume string) (*crewSession, string) {
	base, ok := c.runtimes.Runtime(agent.Runtime)
	if !ok {
		return nil, "oar 驱动不了 " + agent.Runtime
	}
	info := c.runtimes.Info(ctx, agent.Runtime)
	settings := c.store.Settings(agent.Runtime)
	text := strings.Join(slices.DeleteFunc([]string{crewInstructions(agent, c.store.Skills()), crewFarmRules(place, c.projects.HouseRules(), id)}, func(s string) bool { return s == "" }), "\n\n")
	c.mu.Lock()
	farmURL := c.farmURL
	c.mu.Unlock()
	farm := oar.McpServer{Name: "farm", Type: "http", URL: farmURL, Headers: map[string]string{"authorization": "Bearer " + c.tokens.Issue(id)}}
	extra := crewExtra{MCPServers: []oar.McpServer{farm}}
	for _, m := range agent.MCPServers {
		extra.MCPServers = append(extra.MCPServers, crewToOarMcp(m))
	}
	if text != "" && agent.PersonaMode == protocol.PersonaModeAppend {
		extra.AppendSystemPrompt = &text
	}
	if text != "" && agent.PersonaMode == protocol.PersonaModeReplace {
		extra.SystemPrompt = &text
	}
	if len(agent.DisallowedTools) > 0 {
		extra.DisallowedTools = agent.DisallowedTools
	}
	registry, err := oar.NewRuntimeRegistry(crewWithOptions(base, extra))
	if err != nil {
		return nil, err.Error()
	}
	s := &crewSession{wake: make(chan struct{}), subagents: agents.New(agents.Options{Runtimes: registry, MaxRunning: protocol.MaxRunning, MaxDepth: 1, Cwd: c.root, LogDir: c.logDir})}
	s.subagents.OnReport(func(report agents.SubagentReport) error {
		s.received(report)
		return nil
	})
	// A model the runtime does not list would fail the session: fall back to the runtime's default.
	wanted := agent.Model
	if wanted == "" {
		wanted = settings.DefaultModel
	}
	known := wanted == "" || info == nil || info.Models == nil || slices.ContainsFunc(info.Models, func(m protocol.ModelEntry) bool { return m.ID == wanted })
	if !known {
		c.site.Notice(protocol.NoticeLevelWarn, fmt.Sprintf("%s 没有 %s 这个模型，%s 先用默认模型", protocol.RuntimeLabel(agent.Runtime), wanted, agent.Name))
	}
	model := ""
	if known {
		model = wanted
	}
	effort := agent.Effort
	if effort == "" {
		effort = settings.DefaultEffort
	}
	env := map[string]*string{}
	for _, vars := range []map[string]string{settings.Env, agent.Env} {
		for k, v := range vars {
			env[k] = &v
		}
	}
	task := input
	if text != "" && agent.PersonaMode == protocol.PersonaModePrompt {
		task = text + JobBreak + input
	}
	result, err := s.subagents.Spawn(ctx, agents.SpawnOptions{Runtime: base.ID, Name: id, Task: task, Cwd: place.Cwd, Model: model, Effort: effort, Resume: resume, Env: env})
	if err == nil && result.Kind != "spawned" {
		err = fmt.Errorf("%s（%s）", result.Reason, result.Code)
	}
	if err != nil {
		_ = s.subagents.Close(context.WithoutCancel(ctx))
		return nil, err.Error()
	}
	s.agent = result.Agent
	verb, how, where := "派", "，runtime 默认模型", place.Project
	if resume != "" {
		verb = "叫醒"
	}
	if model != "" {
		how = "，模型 " + model
	}
	if place.Branch != "" {
		where += " 的 " + place.Branch
	}
	log.Printf("vibevalley: %s %s（%s）：%s%s，在 %s", verb, id, agent.Name, agent.Runtime, how, where)
	return s, ""
}

func (c *Crew) leave(h *crewHand, closed protocol.IssueClose, merged int64) {
	h.mu.Lock()
	c.releaseLocked(h)
	h.mu.Unlock()
	c.trajectories.Finish(h.id, closed, c.site.Helper(h.id))
	c.closed(h)
	c.tokens.Revoke(h.id)
	c.mu.Lock()
	delete(c.hands, h.id)
	c.mu.Unlock()
	left := protocol.FactLeft{ID: h.id, Closed: &closed}
	if merged > 0 {
		left.Merged = &merged
	}
	c.site.Apply(left)
	c.save()
}

func (c *Crew) closeSession(h *crewHand) {
	h.mu.Lock()
	s := h.sess
	h.mu.Unlock()
	if s != nil {
		_ = s.subagents.Close(context.Background())
	}
}

func (c *Crew) rest(h *crewHand) {
	h.mu.Lock()
	s := h.sess
	if s == nil {
		h.mu.Unlock()
		return
	}
	if id := s.agent.Info().SessionID; id != "" {
		h.sessionID = id
	}
	c.releaseLocked(h)
	h.sess = nil
	c.closedLocked(h)
	h.mu.Unlock()
	_ = s.subagents.Close(context.Background())
	c.save()
}

func (c *Crew) Dismiss(id string) bool {
	h := c.hand(id)
	if h == nil {
		return false
	}
	name := id
	if helper := c.site.Helper(id); helper != nil {
		name = helper.Name
	}
	c.closeSession(h)
	c.leave(h, protocol.IssueCloseDismissed, 0)
	if kept := c.projects.Release(h.place); kept != "" {
		c.site.Notice(protocol.NoticeLevelInfo, fmt.Sprintf("%s 收工了：%s", name, kept))
	}
	return true
}

func (c *Crew) Place(id string) (base.Workplace, bool) {
	h := c.hand(id)
	if h == nil {
		return base.Workplace{}, false
	}
	return h.place, true
}

func (c *Crew) Rest(id string) {
	if h := c.hand(id); h != nil {
		c.rest(h)
	}
}

func (c *Crew) Leave(id string, closed protocol.IssueClose, merged int64) {
	if h := c.hand(id); h != nil {
		c.leave(h, closed, merged)
	}
}

func (c *Crew) DismissAll() {
	c.mu.Lock()
	ids := slices.Sorted(maps.Keys(c.hands))
	c.mu.Unlock()
	for _, id := range ids {
		c.Dismiss(id)
	}
}

func (c *Crew) remind(agent, helper, project, input string, h *crewHand, recalled map[string]bool) string {
	if h != nil {
		h.mu.Lock()
		recalled = maps.Clone(h.recalled)
		h.mu.Unlock()
	}
	found := c.memories.Recall(base.RecallCue{Agent: agent, Helper: helper, Project: project, Text: input, Skip: maps.Clone(recalled)})
	if h != nil {
		h.mu.Lock()
		for _, m := range found {
			h.recalled[m.ID] = true
		}
		h.mu.Unlock()
		if len(found) > 0 {
			c.save()
		}
	} else {
		for _, m := range found {
			recalled[m.ID] = true
		}
	}
	return crewRecallBlock(found, project)
}

func (c *Crew) wake(h *crewHand, helper protocol.Helper, input, recall string) base.Delivered {
	agent := c.store.Agent(helper.Agent)
	if agent == nil {
		return base.Delivered{Kind: "refused", Reason: helper.Name + " 的 agent 已经删掉了，叫不醒"}
	}
	h.mu.Lock()
	resume := h.sessionID
	h.mu.Unlock()
	ctx := context.Background()
	s, refused := c.open(ctx, *agent, h.id, h.place, crewWithRecall(recall, input), resume)
	if s == nil && resume != "" {
		h.mu.Lock()
		h.recalled = map[string]bool{}
		h.mu.Unlock()
		recall = c.remind(helper.Agent, h.id, h.place.Project, input, h, nil)
		s, refused = c.open(ctx, *agent, h.id, h.place, crewWithRecall(recall, "（VibeValley 重启过，之前的会话接不上了。你在这个分支上做过的事看 git log。）\n\n"+input), "")
	}
	if s == nil {
		return base.Delivered{Kind: "refused", Reason: fmt.Sprintf("%s 叫不醒：%s", helper.Name, refused)}
	}
	c.attach(h, s, helper.Runtime)
	h.mu.Lock()
	session := h.session
	h.mu.Unlock()
	if session == "" {
		session = h.id
	}
	return base.Delivered{Kind: "turn", Session: session, Woke: true}
}

func (c *Crew) Deliver(id, text string) base.Delivered {
	h, helper := c.hand(id), c.site.Helper(id)
	if h == nil || helper == nil {
		return base.Delivered{Kind: "refused", Reason: fmt.Sprintf("没有 %s 这个帮工", id)}
	}
	starts := !protocol.IsBusy(*helper)
	recall := ""
	if starts {
		if full := crewNoRoom(c.helpers(), helper.Runtime, h.place.Project, c.limits(helper.Runtime), id); full != "" {
			return base.Delivered{Kind: "refused", Reason: fmt.Sprintf("%s 先不接着干：%s", helper.Name, full)}
		}
		recall = c.remind(helper.Agent, id, h.place.Project, text, h, nil)
	}
	h.mu.Lock()
	s, session := h.sess, h.session
	h.mu.Unlock()
	if s == nil || session == "" {
		return c.wake(h, *helper, text, recall)
	}
	sent, err := s.agent.Send(context.Background(), crewWithRecall(recall, text), "followup")
	if err != nil {
		return base.Delivered{Kind: "refused", Reason: fmt.Sprintf("%s 没收到：%s", helper.Name, err.Error())}
	}
	if sent.Kind == "rejected" {
		return base.Delivered{Kind: "refused", Reason: fmt.Sprintf("%s 没收到：%s", helper.Name, sent.Reason)}
	}
	switch sent.Landed {
	case "steered":
		return base.Delivered{Kind: "steered", Session: session}
	case "queued":
		return base.Delivered{Kind: "queued", Session: session}
	}
	return base.Delivered{Kind: "turn", Session: session}
}

func (c *Crew) Tell(id, text string) string {
	d := c.Deliver(id, text)
	name := id
	if helper := c.site.Helper(id); helper != nil {
		name = helper.Name
	}
	switch d.Kind {
	case "steered":
		return name + " 正在干，话已经插进去了"
	case "queued":
		return name + " 这一轮做完再看这句话"
	case "turn":
		if d.Woke {
			return name + " 醒了，开始新的一轮"
		}
		return name + " 开始新的一轮"
	}
	return d.Reason
}

func (c *Crew) Send(ctx context.Context, agent protocol.AgentProfile, task, where string, opt base.HireOptions) base.Hired {
	c.mu.Lock()
	c.hired++
	id := fmt.Sprintf("w%d", c.hired)
	c.mu.Unlock()
	worktree := agent.Worktree
	if opt.Worktree != nil {
		worktree = *opt.Worktree
	}
	place, err := c.projects.Workplace(where, id, worktree, opt.Base)
	if err != nil {
		return base.Hired{Refused: fmt.Sprintf("%s 没地方干活：%s", agent.Name, err.Error())}
	}
	recalled := map[string]bool{}
	recall := c.remind(agent.ID, id, place.Project, task, nil, recalled)
	s, refused := c.open(ctx, agent, id, place, crewWithRecall(recall, task), "")
	if s == nil {
		return base.Hired{Refused: fmt.Sprintf("%s 派不出去：%s", agent.Name, refused)}
	}

	projectName := place.Project
	helper := protocol.Helper{ID: id, Name: crewHelperName(c.helpers(), agent.ID, agent.Name), Agent: agent.ID, Runtime: agent.Runtime, Task: task, Project: &projectName,
		HiredAt: base.NowMs(), Phase: protocol.Phase{Value: protocol.PhaseArriving{}}, Playbook: opt.Playbook, Channel: opt.Channel}
	if opt.Issue != "" {
		issue := opt.Issue
		helper.Issue = &issue
	}
	if place.Branch != "" {
		branch, cwd := place.Branch, place.Cwd
		helper.Branch, helper.Worktree = &branch, &cwd
	}
	h := &crewHand{id: id, place: place, journal: c.trajectoryOf(helper), recalled: recalled}
	c.mu.Lock()
	c.hands[id] = h
	c.mu.Unlock()
	c.site.Apply(protocol.FactHired{Helper: helper})
	c.attach(h, s, agent.Runtime)
	return base.Hired{Helper: &helper}
}

func (c *Crew) Stop(id string) bool {
	h := c.hand(id)
	if h == nil {
		return false
	}
	h.mu.Lock()
	s := h.sess
	h.mu.Unlock()
	if s == nil || !c.working(id) {
		return false
	}
	_, _ = s.agent.Interrupt(context.Background())
	return true
}

func (c *Crew) view(h *crewHand) *base.Roster {
	helper := c.site.Helper(h.id)
	if helper == nil {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return &base.Roster{Helper: *helper, Place: h.place, LastText: h.lastText}
}

func (c *Crew) Roster() []base.Roster {
	c.mu.Lock()
	hands := slices.Collect(maps.Values(c.hands))
	c.mu.Unlock()
	slices.SortFunc(hands, func(a, b *crewHand) int { return strings.Compare(a.id, b.id) })
	out := []base.Roster{}
	for _, h := range hands {
		if r := c.view(h); r != nil {
			out = append(out, *r)
		}
	}
	return out
}

func (c *Crew) Find(id string) *base.Roster {
	if h := c.hand(id); h != nil {
		return c.view(h)
	}
	return nil
}

func (c *Crew) Steps(id string) ([]protocol.WorkStep, bool) {
	h := c.hand(id)
	if h == nil {
		return nil, false
	}
	return h.journal.Steps(), true
}
