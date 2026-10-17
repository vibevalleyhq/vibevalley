package worker

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"maps"
	"math"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/fx"

	"vibevalley/internal/agent"
	"vibevalley/internal/base"
	"vibevalley/internal/core"
	"vibevalley/internal/memory"
	"vibevalley/internal/project"
	"vibevalley/internal/protocol"
	"vibevalley/internal/runtime"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/smith/agents"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

// smith runs sessions without permission prompts or a sandbox: the only fence is where a worker starts, inside VIBEVALLEY_WORK_ROOT in its own
// worktree. The chat calls Deliver holding its own lock, so nothing here calls back into the chat. smith's spawn takes only model, effort, env and
// cwd, and its runtime registry is fixed once made, so each session gets a Subagents of its own over a one-runtime registry that carries the agent's
// persona, MCP servers and disallowed tools (withOptions).

const (
	// A burst of changes is one write.
	saveAfter = 300 * time.Millisecond
	// A report waits at most this long for its turn's last events (what it spent).
	reportWait = 2 * time.Second
	closeWait  = 15 * time.Second
)

type workerSaved struct {
	Hired int64       `json:"hired"`
	Hands []savedHand `json:"hands"`
}

type savedHand struct {
	ID        string            `json:"id"`
	Place     project.Workplace `json:"place"`
	SessionID string            `json:"sessionId,omitzero"`
	LastText  string            `json:"lastText,omitzero"`
	// A resumed session is not reminded of these again.
	Recalled []string `json:"recalled,omitzero"`
}

// Applied only once the session's events up to last are read.
type pendingReport struct {
	report agents.SubagentReport
	until  int64
}

type oarSession struct {
	subagents *agents.Subagents
	agent     *agents.Subagent
	processed atomic.Int64
	detached  atomic.Bool

	mu      sync.Mutex
	reports []pendingReport
	wake    chan struct{}
	stop    func()
}

func (s *oarSession) received(report agents.SubagentReport) {
	until := int64(-1)
	if a := s.subagents.Get(report.ID); a != nil {
		if records := a.Session.Records(); len(records) > 0 {
			until = records[len(records)-1].Seq
		}
	}
	s.mu.Lock()
	s.reports = append(s.reports, pendingReport{report, until})
	close(s.wake)
	s.wake = make(chan struct{})
	s.mu.Unlock()
}

func (s *oarSession) next(done <-chan struct{}) (pendingReport, bool) {
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
			return pendingReport{}, false
		}
	}
}

type hand struct {
	id      string
	place   project.Workplace
	journal Journal

	mu        sync.Mutex
	sess      *oarSession
	sessionID string
	lastText  string
	tracking  tracking
	// As the chat names it: <id>#<n>; "" when it has none.
	session  string
	spoke    bool
	recalled map[string]bool
	released chan struct{}
	// The triggers of the turns asked for and not opened yet, oldest first; the run of the open turn and what it heard (runs.go).
	triggers []protocol.RunTrigger
	run      int64
	heard    []int64
}

type workers struct {
	core         *core.Service
	store        *agent.Service
	tokens       *tokens
	trajectories *trajectories
	memories     *memory.Service
	projects     *project.Service
	runtimes     *runtime.Service
	root         string
	file         string
	logDir       string
	farmURL      string
	stallMs      int64
	activity     *base.Hub[SessionActivity]
	disk         *base.FileWriter
	q            *generated.Queries

	mu       sync.Mutex
	hands    map[string]*hand
	hired    int64
	launches int64
	closing  bool
	pending  *time.Timer
}

type workersIn struct {
	fx.In
	Config       base.Config
	DB           *sql.DB
	Core         *core.Service
	Store        *agent.Service
	Tokens       *tokens
	Trajectories *trajectories
	Memories     *memory.Service
	Projects     *project.Service
	Runtimes     *runtime.Service
}

func newWorkers(in workersIn) (*workers, error) {
	root, err := filepath.Abs(in.Config.WorkRoot)
	if err != nil {
		return nil, err
	}
	c := &workers{
		core: in.Core, store: in.Store, tokens: in.Tokens, trajectories: in.Trajectories, memories: in.Memories,
		projects: in.Projects, runtimes: in.Runtimes,
		root:     root,
		file:     filepath.Join(in.Config.Home, "workers.json"),
		farmURL:  "http://" + net.JoinHostPort(in.Config.Host, strconv.Itoa(in.Config.Port)) + "/mcp",
		logDir:   filepath.Join(in.Config.Home, "logs"),
		stallMs:  int64(in.Config.Worker.StallSeconds * 1000),
		activity: base.NewHub[SessionActivity](),
		hands:    map[string]*hand{},
		q:        generated.New(in.DB),
	}
	c.disk = base.NewFileWriter(c.file, 0o644)
	return c, nil
}

// For a farm listening on a free port (port 0): sessions opened from now on reach /mcp there.
func (c *workers) SetAddress(addr string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.farmURL = "http://" + addr + "/mcp"
}

func (c *workers) FarmURL() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.farmURL
}

func (*workers) OnStart(context.Context) error { return nil }

func (c *workers) OnReady(context.Context) { c.restore() }

// The sessions are let go first: a turn cut off by the shutdown is reported when the farm comes back (restore), not on the way out.
func (c *workers) OnStop() {
	c.mu.Lock()
	c.closing = true
	if c.pending != nil {
		c.pending.Stop()
	}
	hands := slices.Collect(maps.Values(c.hands))
	c.mu.Unlock()
	if err := c.disk.Write(c.body); err != nil {
		log.Printf("vibevalley: could not save workers.json: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), closeWait)
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

func (c *workers) onFarm() []protocol.Worker { return c.core.State().Workers }

func (c *workers) working(id string) bool {
	if h := c.core.Worker(id); h != nil {
		_, ok := h.Phase.Value.(protocol.PhaseWorking)
		return ok
	}
	return false
}

func (c *workers) hand(id string) *hand {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.hands[id]
}

func (c *workers) Activity() *base.Hub[SessionActivity] { return c.activity }

func (c *workers) signal(a SessionActivity) { c.activity.Publish(a) }

// Called with h.mu held.
func (c *workers) closedLocked(h *hand) {
	if h.session != "" {
		c.signal(SessionActivity{Kind: "closed", ID: h.id, Session: h.session})
	}
	h.session = ""
}

func (c *workers) closed(h *hand) {
	h.mu.Lock()
	defer h.mu.Unlock()
	c.closedLocked(h)
}

func (c *workers) trajectoryOf(worker protocol.Worker) Journal {
	head := protocol.TrajectoryHead{ID: worker.ID, Name: worker.Name, StartedAt: worker.HiredAt}
	agent, runtime, job := worker.Agent, worker.Runtime, worker.Task
	head.Agent, head.Runtime, head.Job = &agent, &runtime, &job
	if worker.Project != nil {
		project := *worker.Project
		head.Project = &project
	}
	if worker.Playbook != nil {
		playbook := *worker.Playbook
		head.Playbook = &playbook
	}
	head.Issue = worker.Issue
	return c.trajectories.Open(head, 0)
}

func (c *workers) body() ([]byte, error) {
	c.mu.Lock()
	saved := workerSaved{Hired: c.hired, Hands: []savedHand{}}
	hands := slices.Collect(maps.Values(c.hands))
	c.mu.Unlock()
	slices.SortFunc(hands, func(a, b *hand) int { return strings.Compare(a.id, b.id) })
	for _, h := range hands {
		h.mu.Lock()
		s := savedHand{ID: h.id, Place: h.place, SessionID: h.sessionID, LastText: h.lastText, Recalled: slices.Sorted(maps.Keys(h.recalled))}
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

func (c *workers) save() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closing {
		return
	}
	if c.pending != nil {
		c.pending.Stop()
	}
	c.pending = time.AfterFunc(saveAfter, func() {
		if err := c.disk.Write(c.body); err != nil {
			log.Printf("vibevalley: could not save workers.json: %v", err)
		}
	})
}

func (c *workers) restore() {
	c.endOpenRuns()
	saved := workerSaved{}
	if body, err := os.ReadFile(c.file); err == nil {
		if json.Unmarshal(body, &saved) != nil {
			saved = workerSaved{}
		}
	}
	// Numbering goes on from the highest id seen, so a new worker never takes an old one's steps.
	c.hired = saved.Hired
	for _, h := range c.onFarm() {
		if n, err := strconv.ParseInt(strings.TrimPrefix(h.ID, "w"), 10, 64); err == nil && n > c.hired {
			c.hired = n
		}
	}
	for _, worker := range c.onFarm() {
		i := slices.IndexFunc(saved.Hands, func(s savedHand) bool { return s.ID == worker.ID })
		var s *savedHand
		if i >= 0 {
			s = &saved.Hands[i]
		}
		if s == nil || !exists(s.Place.Cwd) {
			lost := protocol.IssueCloseLost
			c.core.Apply(protocol.FactLeft{ID: worker.ID, Closed: &lost})
			c.trajectories.Finish(worker.ID, protocol.IssueCloseLost, &worker)
			where := ""
			if s != nil {
				where = "（" + s.Place.Cwd + "）"
			}
			c.core.Notice(protocol.NoticeLevelWarn, fmt.Sprintf("%s 干活的目录不见了%s，没接回来", worker.Name, where))
			continue
		}
		recalled := map[string]bool{}
		for _, id := range s.Recalled {
			recalled[id] = true
		}
		c.hands[worker.ID] = &hand{id: worker.ID, place: s.Place, journal: c.trajectoryOf(worker), sessionID: s.SessionID, lastText: s.LastText, recalled: recalled}
		if protocol.IsBusy(worker) {
			c.core.Apply(protocol.FactReport{ID: worker.ID, Outcome: protocol.OutcomeInterrupted, Summary: "VibeValley 重启了，这一轮停在了半路", Runs: worker.Runs})
			c.core.Notice(protocol.NoticeLevelInfo, fmt.Sprintf("VibeValley 重启过，%s 那一轮停下了；给它带句话就能接着干", worker.Name))
		}
	}
	if len(c.hands) > 0 {
		log.Printf("vibevalley: 接回 %d 个帮工", len(c.hands))
	}
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func (c *workers) NoRoom(runtime, project string) string {
	return noRoom(c.onFarm(), runtime, str.Trim(project), c.limits(runtime), "")
}

func (c *workers) limits(runtime string) workerLimits {
	l := workerLimits{Workspace: protocol.MaxRunning, PerProject: c.projects.Limit()}
	if s := c.store.Settings(runtime); s.MaxWorking != nil {
		l.PerRuntime = int(*s.MaxWorking)
	}
	return l
}

func (c *workers) watch(h *hand, s *oarSession, runtime string) oar.EventObserver {
	return func(event oar.Event) {
		if s.detached.Load() {
			return
		}
		opened := false
		var signals []SessionActivity
		h.mu.Lock()
		if h.session != "" && h.sess == s {
			switch event.Body.(type) {
			case oar.TurnStarted:
				h.spoke = false
				opened = true
			case oar.Reasoning, oar.TextDelta, oar.ToolCallStarted:
				if !h.spoke {
					h.spoke = true
					signals = append(signals, SessionActivity{Kind: "spoke", ID: h.id, Session: h.session})
				}
			case oar.CompactionStarted:
				signals = append(signals, SessionActivity{Kind: "compacting", ID: h.id, On: true})
			case oar.CompactionEnded:
				signals = append(signals, SessionActivity{Kind: "compacting", ID: h.id, On: false})
			}
		}
		reaction := sessionFacts(event, c.core.Worker(h.id), h.tracking, sessionContext{ID: h.id, Runtime: runtime, Cwd: h.place.Cwd, CnyPerUsd: c.runtimes.CnyPerUsd()})
		h.tracking = reaction.Tracking
		if reaction.Model != "" {
			h.tracking.Price = c.runtimes.Price(runtime, reaction.Model)
		}
		h.mu.Unlock()
		if opened {
			c.startRun(h)
		}
		for _, a := range signals {
			c.signal(a)
		}
		for _, op := range reaction.Journal {
			record(h.journal, op)
		}
		for _, fact := range reaction.Facts {
			c.core.Apply(fact)
			if r, ok := fact.(protocol.FactReport); ok {
				c.endRun(h, r.Outcome, r.Summary, r.Spent)
			}
		}
		if reaction.SpentCny != 0 {
			c.runtimes.Spend(runtime, reaction.SpentCny)
		}
		if reaction.Warn != "" {
			c.core.Notice(protocol.NoticeLevelWarn, reaction.Warn)
		}
		if _, exited := event.Body.(oar.Exited); exited {
			c.closed(h)
		}
	}
}

func (c *workers) applyReport(h *hand, report agents.SubagentReport) {
	worker := c.core.Worker(h.id)
	if worker == nil {
		return
	}
	read := readReport(report.Outcome, report.Text)
	h.mu.Lock()
	var spent *protocol.Spent
	if worker.Spent != nil {
		spent = since(*worker.Spent, h.tracking.RunFrom)
	}
	h.lastText = read.Text
	h.tracking.RunFrom = nil
	session, spoke := h.session, h.spoke
	h.mu.Unlock()
	c.core.Apply(protocol.FactReport{ID: h.id, Outcome: read.Outcome, Summary: read.Summary, Runs: int64(report.Turn), Spent: spent})
	c.endRun(h, read.Outcome, read.Summary, spent)
	project := h.place.Project
	go c.memories.Keep(memory.FinishedRun{Agent: worker.Agent, Worker: h.id, Project: project, Job: worker.Task, Outcome: read.Outcome, Said: read.Text, Summary: read.Summary})
	if read.NeedsYou {
		c.core.Notice(protocol.NoticeLevelError, fmt.Sprintf("%s 停下了：%s", worker.Name, read.Failure))
	}
	if session != "" {
		c.signal(SessionActivity{Kind: "ended", ID: h.id, Session: session, Outcome: read.Outcome, Spoke: spoke})
	}
	c.runtimes.UsageSoon(worker.Runtime)
	c.save()
}

// Each report waits until its turn's events are read: what the turn spent arrives in the same frame as its end.
func (c *workers) reports(h *hand, s *oarSession, released <-chan struct{}) {
	for {
		r, ok := s.next(released)
		if !ok {
			return
		}
		deadline := time.Now().Add(reportWait)
		for s.processed.Load() < r.until && time.Now().Before(deadline) && !s.detached.Load() {
			time.Sleep(5 * time.Millisecond)
		}
		if s.detached.Load() {
			return
		}
		c.applyReport(h, r.report)
	}
}

func (c *workers) stalled(h *hand, silentForMs int64) {
	worker := c.core.Worker(h.id)
	if worker == nil {
		return
	}
	working, ok := worker.Phase.Value.(protocol.PhaseWorking)
	if !ok {
		return
	}
	h.mu.Lock()
	h.tracking.Quiet = true
	h.mu.Unlock()
	c.core.Apply(protocol.FactQuiet{ID: h.id, Since: clock.NowMs() - silentForMs})
	quiet := fmt.Sprintf("%d 分钟", int64(math.Round(float64(silentForMs)/60_000)))
	if silentForMs < 60_000 {
		quiet = fmt.Sprintf("%d 秒", int64(math.Round(float64(silentForMs)/1000)))
	}
	last := ""
	if label := working.Doing.Label; label != "" {
		last = "（最后在：" + label + "）"
	}
	h.journal.Note(protocol.ActivityKindError, fmt.Sprintf("已经 %s没动静了%s。可能在跑很久的命令，也可能卡住了", quiet, last), nil)
	c.core.Notice(protocol.NoticeLevelWarn, fmt.Sprintf("%s 已经 %s没动静了%s：点它的地看看过程，不对就叫停", worker.Name, quiet, last))
}

// smith's ObserveStalls only arms on records it sees live and misses a turn that went quiet before it subscribed, so the status is polled.
func (c *workers) watchStalls(h *hand, s *oarSession, released <-chan struct{}) {
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
		stall := observe.StallOf(s.agent.Session.Status().Value, clock.NowMs(), c.stallMs)
		if stall == nil || stall.SinceSeq == flagged || s.detached.Load() {
			continue
		}
		flagged = stall.SinceSeq
		c.stalled(h, stall.SilentForMs)
	}
}

func (c *workers) attach(h *hand, s *oarSession, runtime string) {
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
func (c *workers) releaseLocked(h *hand) {
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

func (c *workers) open(ctx context.Context, agent protocol.Agent, id string, place project.Workplace, input, resume string) (*oarSession, string) {
	base, ok := c.runtimes.Runtime(agent.Runtime)
	if !ok {
		return nil, "oar 驱动不了 " + agent.Runtime
	}
	info := c.runtimes.Info(ctx, agent.Runtime)
	settings := c.store.Settings(agent.Runtime)
	text := strings.Join(slices.DeleteFunc([]string{instructions(agent, c.store.Skills()), farmRules(place, c.projects.HouseRules(), id)}, func(s string) bool { return s == "" }), "\n\n")
	c.mu.Lock()
	farmURL := c.farmURL
	c.mu.Unlock()
	farm := oar.McpServer{Name: "farm", Type: "http", URL: farmURL, Headers: map[string]string{"authorization": "Bearer " + c.tokens.Issue(id)}}
	extra := extra{MCPServers: []oar.McpServer{farm}}
	for _, m := range agent.MCPServers {
		extra.MCPServers = append(extra.MCPServers, toOarMcp(m))
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
	registry, err := oar.NewRuntimeRegistry(withOptions(base, extra))
	if err != nil {
		return nil, err.Error()
	}
	s := &oarSession{wake: make(chan struct{}), subagents: agents.New(agents.Options{Runtimes: registry, MaxRunning: protocol.MaxRunning, MaxDepth: 1, Cwd: c.root, LogDir: c.logDir})}
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
		c.core.Notice(protocol.NoticeLevelWarn, fmt.Sprintf("%s 没有 %s 这个模型，%s 先用默认模型", protocol.RuntimeLabel(agent.Runtime), wanted, agent.Name))
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

func (c *workers) leave(h *hand, closed protocol.IssueClose, merged int64) {
	h.mu.Lock()
	c.releaseLocked(h)
	h.mu.Unlock()
	c.trajectories.Finish(h.id, closed, c.core.Worker(h.id))
	c.closed(h)
	c.tokens.Revoke(h.id)
	c.mu.Lock()
	delete(c.hands, h.id)
	c.mu.Unlock()
	left := protocol.FactLeft{ID: h.id, Closed: &closed}
	if merged > 0 {
		left.Merged = &merged
	}
	c.core.Apply(left)
	c.save()
}

func (c *workers) closeSession(h *hand) {
	h.mu.Lock()
	s := h.sess
	h.mu.Unlock()
	if s != nil {
		_ = s.subagents.Close(context.Background())
	}
}

func (c *workers) rest(h *hand) {
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

func (c *workers) Dismiss(id string) bool {
	h := c.hand(id)
	if h == nil {
		return false
	}
	name := id
	if worker := c.core.Worker(id); worker != nil {
		name = worker.Name
	}
	c.closeSession(h)
	c.leave(h, protocol.IssueCloseDismissed, 0)
	if kept := c.projects.Release(h.place); kept != "" {
		c.core.Notice(protocol.NoticeLevelInfo, fmt.Sprintf("%s 收工了：%s", name, kept))
	}
	return true
}

func (c *workers) Place(id string) (project.Workplace, bool) {
	h := c.hand(id)
	if h == nil {
		return project.Workplace{}, false
	}
	return h.place, true
}

func (c *workers) Rest(id string) {
	if h := c.hand(id); h != nil {
		c.rest(h)
	}
}

func (c *workers) Leave(id string, closed protocol.IssueClose, merged int64) {
	if h := c.hand(id); h != nil {
		c.leave(h, closed, merged)
	}
}

func (c *workers) DismissAll() {
	c.mu.Lock()
	ids := slices.Sorted(maps.Keys(c.hands))
	c.mu.Unlock()
	for _, id := range ids {
		c.Dismiss(id)
	}
}

func (c *workers) remind(agent, worker, project, input string, h *hand, recalled map[string]bool) string {
	if h != nil {
		h.mu.Lock()
		recalled = maps.Clone(h.recalled)
		h.mu.Unlock()
	}
	found := c.memories.Recall(memory.RecallCue{Agent: agent, Worker: worker, Project: project, Text: input, Skip: maps.Clone(recalled)})
	if h != nil {
		h.mu.Lock()
		for _, id := range found.IDs {
			h.recalled[id] = true
		}
		h.mu.Unlock()
		if len(found.IDs) > 0 {
			c.save()
		}
	} else {
		for _, id := range found.IDs {
			recalled[id] = true
		}
	}
	return recallBlock(found.Lines)
}

func (c *workers) wake(h *hand, worker protocol.Worker, input, recall string) Delivered {
	agent := c.store.Agent(worker.Agent)
	if agent == nil {
		return Delivered{Kind: "refused", Reason: worker.Name + " 的 agent 已经删掉了，叫不醒"}
	}
	h.mu.Lock()
	resume := h.sessionID
	h.mu.Unlock()
	ctx := context.Background()
	s, refused := c.open(ctx, *agent, h.id, h.place, withRecall(recall, input), resume)
	if s == nil && resume != "" {
		h.mu.Lock()
		h.recalled = map[string]bool{}
		h.mu.Unlock()
		recall = c.remind(worker.Agent, h.id, h.place.Project, input, h, nil)
		s, refused = c.open(ctx, *agent, h.id, h.place, withRecall(recall, "（VibeValley 重启过，之前的会话接不上了。你在这个分支上做过的事看 git log。）\n\n"+input), "")
	}
	if s == nil {
		return Delivered{Kind: "refused", Reason: fmt.Sprintf("%s 叫不醒：%s", worker.Name, refused)}
	}
	c.attach(h, s, worker.Runtime)
	h.mu.Lock()
	session := h.session
	h.mu.Unlock()
	if session == "" {
		session = h.id
	}
	return Delivered{Kind: "run", Session: session, Woke: true}
}

func (c *workers) Deliver(id, text string, by protocol.RunTrigger) Delivered {
	h, worker := c.hand(id), c.core.Worker(id)
	if h == nil || worker == nil {
		return Delivered{Kind: "refused", Reason: fmt.Sprintf("没有 %s 这个帮工", id)}
	}
	starts := !protocol.IsBusy(*worker)
	recall := ""
	if starts {
		if full := noRoom(c.onFarm(), worker.Runtime, h.place.Project, c.limits(worker.Runtime), id); full != "" {
			return Delivered{Kind: "refused", Reason: fmt.Sprintf("%s 先不接着干：%s", worker.Name, full)}
		}
		recall = c.remind(worker.Agent, id, h.place.Project, text, h, nil)
	}
	h.mu.Lock()
	s, session := h.sess, h.session
	h.mu.Unlock()
	if s == nil || session == "" {
		c.expect(h, by)
		d := c.wake(h, *worker, text, recall)
		if d.Kind == "refused" {
			c.unexpect(h)
		}
		return d
	}
	if starts {
		c.expect(h, by)
	}
	sent, err := s.agent.Send(context.Background(), withRecall(recall, text), "followup")
	if err == nil && sent.Kind != "rejected" && sent.Landed == "prompted" {
		return Delivered{Kind: "run", Session: session}
	}
	if starts {
		c.unexpect(h)
	}
	if err != nil {
		return Delivered{Kind: "refused", Reason: fmt.Sprintf("%s 没收到：%s", worker.Name, err.Error())}
	}
	if sent.Kind == "rejected" {
		return Delivered{Kind: "refused", Reason: fmt.Sprintf("%s 没收到：%s", worker.Name, sent.Reason)}
	}
	if sent.Landed == "queued" {
		c.expect(h, by)
		return Delivered{Kind: "queued", Session: session}
	}
	if by.Message != nil {
		c.heardInRun(h, *by.Message)
	}
	return Delivered{Kind: "steered", Session: session}
}

func (c *workers) Tell(id, text string, by protocol.RunTrigger) string {
	d := c.Deliver(id, text, by)
	name := id
	if worker := c.core.Worker(id); worker != nil {
		name = worker.Name
	}
	switch d.Kind {
	case "steered":
		return name + " 正在干，话已经插进去了"
	case "queued":
		return name + " 这一轮做完再看这句话"
	case "run":
		if d.Woke {
			return name + " 醒了，开始新的一轮"
		}
		return name + " 开始新的一轮"
	}
	return d.Reason
}

func (c *workers) Send(ctx context.Context, agent protocol.Agent, task, where string, opt HireOptions) Hired {
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
		return Hired{Refused: fmt.Sprintf("%s 没地方干活：%s", agent.Name, err.Error())}
	}
	recalled := map[string]bool{}
	recall := c.remind(agent.ID, id, place.Project, task, nil, recalled)
	s, refused := c.open(ctx, agent, id, place, withRecall(recall, task), "")
	if s == nil {
		return Hired{Refused: fmt.Sprintf("%s 派不出去：%s", agent.Name, refused)}
	}

	projectName := place.Project
	worker := protocol.Worker{ID: id, Name: workerName(c.onFarm(), agent.ID, agent.Name), Agent: agent.ID, Runtime: agent.Runtime, Task: task, Project: &projectName,
		HiredAt: clock.NowMs(), Phase: protocol.Phase{Value: protocol.PhaseArriving{}}, Playbook: opt.Playbook, Channel: opt.Channel}
	if opt.Issue != "" {
		issue := opt.Issue
		worker.Issue = &issue
	}
	if place.Branch != "" {
		branch, cwd := place.Branch, place.Cwd
		worker.Branch, worker.Worktree = &branch, &cwd
	}
	first := protocol.RunTrigger{Kind: protocol.RunTriggerKindIssue}
	if opt.Trigger != nil {
		first = *opt.Trigger
	}
	h := &hand{id: id, place: place, journal: c.trajectoryOf(worker), recalled: recalled, triggers: []protocol.RunTrigger{first}}
	c.mu.Lock()
	c.hands[id] = h
	c.mu.Unlock()
	if opt.Hiring != nil {
		opt.Hiring(worker)
	}
	c.core.Apply(protocol.FactHired{Worker: worker})
	c.attach(h, s, agent.Runtime)
	return Hired{Worker: &worker}
}

func (c *workers) Stop(id string) bool {
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
	if _, err := s.agent.Interrupt(context.Background()); err != nil {
		log.Printf("vibevalley: %s did not take the stop: %v", id, err)
		return false
	}
	return true
}

func (c *workers) view(h *hand) *Roster {
	worker := c.core.Worker(h.id)
	if worker == nil {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return &Roster{Worker: *worker, Place: h.place, LastText: h.lastText}
}

func (c *workers) Roster() []Roster {
	c.mu.Lock()
	hands := slices.Collect(maps.Values(c.hands))
	c.mu.Unlock()
	slices.SortFunc(hands, func(a, b *hand) int { return strings.Compare(a.id, b.id) })
	out := []Roster{}
	for _, h := range hands {
		if r := c.view(h); r != nil {
			out = append(out, *r)
		}
	}
	return out
}

func (c *workers) Find(id string) *Roster {
	if h := c.hand(id); h != nil {
		return c.view(h)
	}
	return nil
}

// What the worker is told for a comment on step n of its trajectory: the step, then the comment. A step gone (only the
// latest are kept) is Missing.
func (c *workers) Comment(id string, n int64, comment string) (string, error) {
	steps, _ := c.Activities(id)
	i := slices.IndexFunc(steps, func(s protocol.Activity) bool { return s.N == n })
	if i < 0 {
		return "", protocol.Missing{What: fmt.Sprintf("第 %d 步（太早的步骤不再保留）", n)}
	}
	return CommentText(steps[i], comment), nil
}

func (c *workers) Activities(id string) ([]protocol.Activity, bool) {
	h := c.hand(id)
	if h == nil {
		return nil, false
	}
	return h.journal.Activities(), true
}
