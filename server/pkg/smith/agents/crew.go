package agents

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
	"vibevalley/pkg/smith/voyage"
)

// Subagents is a crew of child sessions (agents/crew.ts createSubagents).
// All methods are safe for concurrent use.
type Subagents struct {
	registry   *oar.RuntimeRegistry
	maxRunning int
	maxDepth   int
	cwd        string
	logDir     string
	env        map[string]*string

	// emitMu orders task events and their observers; never taken under mu.
	emitMu sync.Mutex

	mu             sync.Mutex
	agents         *observe.OrderedMap[*Subagent]
	reserved       map[string]int
	wake           chan struct{}
	taskObservers  map[int]func(SubagentTaskEvent)
	reportHandlers map[int]ReportHandler
	nextHandle     int
	unread         []SubagentReport
	tasks          observe.TaskMap
	starting       int
	closed         bool
	inFlight       sync.WaitGroup
}

// New starts an empty crew.
func New(options Options) *Subagents {
	crew := &Subagents{
		registry:       options.Runtimes,
		maxRunning:     options.MaxRunning,
		maxDepth:       options.MaxDepth,
		cwd:            options.Cwd,
		logDir:         options.LogDir,
		env:            options.Env,
		agents:         observe.NewOrderedMap[*Subagent](),
		reserved:       map[string]int{},
		wake:           make(chan struct{}),
		taskObservers:  map[int]func(SubagentTaskEvent){},
		reportHandlers: map[int]ReportHandler{},
		tasks:          observe.InitialTasks(),
	}
	if crew.maxRunning == 0 {
		crew.maxRunning = 4
	}
	if crew.maxDepth == 0 {
		crew.maxDepth = 1
	}
	return crew
}

// runningLocked counts children starting or running a turn.
func (c *Subagents) runningLocked() int {
	running := c.starting
	for _, agent := range c.agents.Values() {
		if agent.stateNow() == "running" {
			running++
		}
	}
	return running
}

func (c *Subagents) wakeLocked() {
	close(c.wake)
	c.wake = make(chan struct{})
}

func (c *Subagents) wakeAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.wakeLocked()
}

func (c *Subagents) emitTask(body oar.EventBody) {
	c.emitMu.Lock()
	defer c.emitMu.Unlock()
	at := time.Now().UnixMilli()
	c.mu.Lock()
	c.tasks = observe.ApplyTaskEvent(c.tasks, body, observe.TaskEventOrigin{SessionID: "", AgentPath: []string{}, ReceivedAt: at})
	observers := make([]func(SubagentTaskEvent), 0, len(c.taskObservers))
	for _, handle := range sortedHandles(c.taskObservers) {
		observers = append(observers, c.taskObservers[handle])
	}
	c.mu.Unlock()
	for _, observer := range observers {
		func() {
			// An observer's failure is its own; the next one still hears.
			defer func() { _ = recover() }()
			observer(SubagentTaskEvent{Body: body, At: at})
		}()
	}
}

func sortedHandles[V any](m map[int]V) []int {
	handles := make([]int, 0, len(m))
	for handle := range m {
		handles = append(handles, handle)
	}
	slices.Sort(handles)
	return handles
}

func (c *Subagents) received(report SubagentReport) {
	c.mu.Lock()
	var handlers []ReportHandler
	if c.reserved[report.ID] == 0 {
		for _, handle := range sortedHandles(c.reportHandlers) {
			handlers = append(handlers, c.reportHandlers[handle])
		}
	}
	c.mu.Unlock()
	handled := false
	for _, handler := range handlers {
		func() {
			// The next handler still gets it; a report no handler takes stays unread.
			defer func() { _ = recover() }()
			if handler(report) == nil {
				handled = true
			}
		}()
	}
	if handled {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.unread = append(c.unread, report)
	c.wakeLocked()
}

func (c *Subagents) freeIDLocked(spawn SpawnOptions) string {
	base := spawn.Name
	if base == "" {
		base = spawn.Runtime
	}
	if spawn.Name != "" && !c.agents.Has(base) {
		return base
	}
	n := 1
	for c.agents.Has(fmt.Sprintf("%s-%d", base, n)) {
		n++
	}
	return fmt.Sprintf("%s-%d", base, n)
}

func (c *Subagents) register(spawn SpawnOptions, runtime oar.Runtime, session oar.Session, log string, logged *progress) *Subagent {
	c.mu.Lock()
	id := c.freeIDLocked(spawn)
	agent := newSubagent(subagentIdentity{id: id, name: spawn.Name, runtime: runtime.ID, log: log, logged: logged}, session, subagentHooks{
		report: c.received,
		task:   c.emitTask,
		mayRun: func() bool {
			c.mu.Lock()
			defer c.mu.Unlock()
			return c.runningLocked() < c.maxRunning
		},
		closed: c.wakeAll,
	})
	c.agents = c.agents.With(id, agent)
	c.mu.Unlock()
	description := spawn.Name
	if description == "" {
		description = sliceUTF16(strings.Split(spawn.Task, "\n")[0], 120)
	}
	c.emitTask(oar.TaskStarted{TaskID: id, TaskType: "agent", NativeType: "oar-subagent", Description: description, ChildSessionID: session.ID(), Background: oar.Bool(true)})
	return agent
}

func (c *Subagents) open(ctx context.Context, spawn SpawnOptions, runtime oar.Runtime, installation oar.AvailableInstallation, registered func()) (SpawnResult, error) {
	cwd := spawn.Cwd
	if cwd == "" {
		cwd = c.cwd
	}
	if cwd == "" {
		var err error
		if cwd, err = os.Getwd(); err != nil {
			return SpawnResult{}, err
		}
	}
	env := map[string]*string{}
	for key, value := range c.env {
		env[key] = value
	}
	for key, value := range spawn.Env {
		env[key] = value
	}
	env[SubagentDepthEnv] = oar.String(fmt.Sprint(hostDepth() + 1))
	session, failure := sessionOf(ctx, runtime, installation, oar.SessionOptions{Cwd: cwd, Model: spawn.Model, Effort: spawn.Effort, ServiceTier: spawn.ServiceTier, Resume: spawn.Resume, Env: env})
	if session == nil {
		return SpawnResult{Kind: "refused", Code: "open_failed", Reason: failure}, nil
	}
	log := ""
	var logged *progress
	var logFailure error
	if c.logDir != "" {
		name := spawn.Name
		if name == "" {
			name = spawn.Runtime
		}
		log = filepath.Join(c.logDir, logName(name, session.ID()))
		logged, logFailure = attachLog(session, log, voyage.Header{Runtime: runtime.ID, Cwd: cwd, SessionID: session.ID(), StartedAt: time.Now().UnixMilli(), Recorder: "oar-subagents",
			Model: spawn.Model, Effort: spawn.Effort, ServiceTier: spawn.ServiceTier})
	}
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed || logFailure != nil {
		if err := session.Dispose(context.WithoutCancel(ctx)); err != nil {
			return SpawnResult{}, err
		}
		if logFailure == nil {
			return SpawnResult{Kind: "refused", Code: "closed", Reason: "the subagents were closed while this one opened"}, nil
		}
		return SpawnResult{Kind: "refused", Code: "open_failed", Reason: "cannot write the log: " + logFailure.Error()}, nil
	}
	agent := c.register(spawn, runtime, session, log, logged)
	registered()
	outcome, err := session.Prompt(ctx, spawn.Task, oar.InputOptions{})
	if err != nil {
		return SpawnResult{}, err
	}
	if !outcome.IsAccepted() {
		if err := agent.Close(ctx); err != nil {
			return SpawnResult{}, err
		}
		c.mu.Lock()
		c.agents = c.agents.Without(agent.ID)
		c.mu.Unlock()
		return SpawnResult{Kind: "refused", Code: "rejected", Reason: outcome.Reason}, nil
	}
	agent.started()
	return SpawnResult{Kind: "spawned", Agent: agent}, nil
}

// refusalLocked is why a spawn cannot start now; nil when it can.
func (c *Subagents) refusalLocked(spawn SpawnOptions) (*SpawnResult, oar.Runtime) {
	if c.closed {
		return &SpawnResult{Kind: "refused", Code: "closed", Reason: "the subagents are closed"}, oar.Runtime{}
	}
	var runtime oar.Runtime
	ok := false
	if c.registry != nil {
		runtime, ok = c.registry.Get(spawn.Runtime)
	}
	if !ok {
		return &SpawnResult{Kind: "refused", Code: "unknown_runtime", Reason: "unknown runtime: " + spawn.Runtime}, oar.Runtime{}
	}
	// A child carries its depth in env, so a runtime that refuses env cannot be one.
	if reason, refused := runtime.RefusedSessionOptions[oar.OptionEnv]; refused {
		return &SpawnResult{Kind: "refused", Code: "open_failed", Reason: fmt.Sprintf("%s cannot be a subagent: %s", spawn.Runtime, reason)}, oar.Runtime{}
	}
	if hostDepth()+1 > c.maxDepth {
		return &SpawnResult{Kind: "refused", Code: "depth_limit", Reason: fmt.Sprintf("subagents nest at most %d deep; do this task yourself", c.maxDepth)}, oar.Runtime{}
	}
	if c.runningLocked() >= c.maxRunning {
		return &SpawnResult{Kind: "refused", Code: "running_limit", Reason: fmt.Sprintf("%d subagents are already running; wait for one to finish rather than retrying", c.maxRunning)}, oar.Runtime{}
	}
	return nil, runtime
}

// Spawn starts a child on its runtime and prompts it with the task. A
// refusal is a "refused" result; a Go error means a control or probe could
// not be delivered.
func (c *Subagents) Spawn(ctx context.Context, spawn SpawnOptions) (SpawnResult, error) {
	c.mu.Lock()
	refused, runtime := c.refusalLocked(spawn)
	if refused != nil {
		c.mu.Unlock()
		return *refused, nil
	}
	// Counted from the refusal check until the child is registered, where its own state takes over.
	c.starting++
	c.inFlight.Add(1)
	c.mu.Unlock()
	defer c.inFlight.Done()
	var once sync.Once
	release := func() {
		once.Do(func() {
			c.mu.Lock()
			c.starting--
			c.mu.Unlock()
		})
	}
	defer release()
	installation, missing, err := installationOf(ctx, runtime)
	if err != nil {
		return SpawnResult{}, err
	}
	if missing != "" {
		return SpawnResult{Kind: "refused", Code: "not_installed", Reason: missing}, nil
	}
	return c.open(ctx, spawn, runtime, installation, release)
}

// Get finds a subagent by id.
func (c *Subagents) Get(id string) *Subagent {
	c.mu.Lock()
	defer c.mu.Unlock()
	agent, _ := c.agents.Get(id)
	return agent
}

// List is every subagent's info, in spawn order.
func (c *Subagents) List() []SubagentInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []SubagentInfo{}
	for _, agent := range c.agents.Values() {
		out = append(out, agent.Info())
	}
	return out
}

// takeLocked removes and returns the wanted unread reports: ids' when given,
// else every report of a subagent no Next is waiting on.
func (c *Subagents) takeLocked(ids []string) []SubagentReport {
	wanted := func(report SubagentReport) bool {
		if ids == nil {
			return c.reserved[report.ID] == 0
		}
		return slices.Contains(ids, report.ID)
	}
	taken := []SubagentReport{}
	kept := []SubagentReport{}
	for _, report := range c.unread {
		if wanted(report) {
			taken = append(taken, report)
		} else {
			kept = append(kept, report)
		}
	}
	c.unread = kept
	return taken
}

// Wait takes the unread reports, waiting up to the timeout for one when none
// are unread. Cancelling ctx stops waiting, taking nothing.
func (c *Subagents) Wait(ctx context.Context, options WaitOptions) []SubagentReport {
	timeout := options.Timeout
	if timeout == 0 {
		timeout = DefaultWait
	}
	deadline := time.Now().Add(timeout)
	for {
		c.mu.Lock()
		taken := c.takeLocked(options.IDs)
		over := c.closed || ctx.Err() != nil || !time.Now().Before(deadline)
		wake := c.wake
		c.mu.Unlock()
		if len(taken) > 0 || over {
			return taken
		}
		timer := time.NewTimer(time.Until(deadline))
		select {
		case <-wake:
		case <-timer.C:
		case <-ctx.Done():
		}
		timer.Stop()
	}
}

// Next takes one subagent's next report, waiting as long as it takes. While
// a Next waits, Wait calls that name no ids leave that subagent's reports
// alone. nil when it closes first or ctx ends.
func (c *Subagents) Next(ctx context.Context, id string) *SubagentReport {
	c.mu.Lock()
	c.reserved[id]++
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.reserved[id]--; c.reserved[id] <= 0 {
			delete(c.reserved, id)
		}
	}()
	for {
		c.mu.Lock()
		taken := c.takeLocked([]string{id})
		agent, _ := c.agents.Get(id)
		over := c.closed || ctx.Err() != nil || (agent != nil && agent.stateNow() == "closed")
		wake := c.wake
		c.mu.Unlock()
		if len(taken) > 0 {
			// As crew.ts `let [report] = take([id])`: every unread report of
			// id is taken and only the first returned.
			return &taken[0]
		}
		if over {
			return nil
		}
		timer := time.NewTimer(60 * time.Second)
		select {
		case <-wake:
		case <-timer.C:
		case <-ctx.Done():
		}
		timer.Stop()
	}
}

// Unread is the unread reports, without taking them.
func (c *Subagents) Unread() []SubagentReport {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]SubagentReport{}, c.unread...)
}

// OnTask observes task events for every subagent, live; Tasks folds them.
func (c *Subagents) OnTask(observer func(SubagentTaskEvent)) oar.Unsubscribe {
	c.mu.Lock()
	defer c.mu.Unlock()
	handle := c.nextHandle
	c.nextHandle++
	c.taskObservers[handle] = observer
	return func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		delete(c.taskObservers, handle)
	}
}

// Tasks is one row per subagent, in spawn order.
func (c *Subagents) Tasks() []observe.TaskView {
	c.mu.Lock()
	defer c.mu.Unlock()
	values := c.tasks.Values()
	if values == nil {
		values = []observe.TaskView{}
	}
	return values
}

// OnReport is the application's hook for reports: every report goes to the
// handlers instead of the unread list (a Next still gets its own first). A
// report every handler fails on (an error or a panic) stays unread.
func (c *Subagents) OnReport(handler ReportHandler) oar.Unsubscribe {
	c.mu.Lock()
	defer c.mu.Unlock()
	handle := c.nextHandle
	c.nextHandle++
	c.reportHandlers[handle] = handler
	return func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		delete(c.reportHandlers, handle)
	}
}

// Close closes every subagent, including spawns in flight, and refuses new
// ones. Pending waits return.
func (c *Subagents) Close(ctx context.Context) error {
	c.mu.Lock()
	c.closed = true
	c.wakeLocked()
	c.mu.Unlock()
	c.inFlight.Wait()
	c.mu.Lock()
	agents := c.agents.Values()
	c.mu.Unlock()
	errs := make([]error, len(agents))
	var group sync.WaitGroup
	for i, agent := range agents {
		group.Go(func() { errs[i] = agent.Close(ctx) })
	}
	group.Wait()
	c.wakeAll()
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}
