package observe

import (
	"sync"
	"time"

	"vibevalley/pkg/smith/oar"
)

// The composed observer (observe/observe-agent.ts): one subscription yields a
// unified derived view of the agent, fold state plus the clock overlay,
// pushed on every record (the fold advances) and on the silence edge (the
// clock crosses the threshold). ReduceStatus / StallOf stay exported for
// consumers with their own composition needs.

// AgentView is the status fold plus the stall overlay (nil when not stalled).
type AgentView struct {
	Status oar.AgentStatus `json:"status"`
	Stall  *Stall          `json:"stall"`
}

// ObserveAgentOptions for ObserveAgent.
type ObserveAgentOptions struct {
	StallAfter time.Duration
	// Clock injection for tests (epoch ms); time.Now by default.
	Now func() int64
	// Stall-edge poll interval; 1s by default.
	Tick time.Duration
}

// AgentObserver pushes AgentViews to its listeners.
type AgentObserver struct {
	mu          sync.Mutex
	now         func() int64
	stallAfter  int64
	status      oar.AgentStatus
	lastStalled bool
	listeners   map[int]func(AgentView)
	order       []int
	next        int
	unsubscribe oar.Unsubscribe
	stop        chan struct{}
	stopOnce    sync.Once
	// pushMu serializes pushes so listeners never run concurrently with themselves.
	pushMu sync.Mutex
}

// ObserveAgent subscribes to the session and starts the stall-edge ticker; Dispose stops both.
func ObserveAgent(session oar.Session, options ObserveAgentOptions) *AgentObserver {
	now := options.Now
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	tick := options.Tick
	if tick <= 0 {
		tick = time.Second
	}
	o := &AgentObserver{now: now, stallAfter: options.StallAfter.Milliseconds(), status: InitialStatus, listeners: map[int]func(AgentView){}, stop: make(chan struct{})}
	o.unsubscribe = session.RawEvents(func(record oar.RawEvent) {
		o.mu.Lock()
		o.status = ReduceStatus(o.status, record, session.ID())
		o.mu.Unlock()
		o.push()
	}, nil)
	ticker := time.NewTicker(tick)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-o.stop:
				return
			case <-ticker.C:
				// Push only on the silence EDGES, not every tick.
				o.mu.Lock()
				stalledNow := StallOf(o.status, o.now(), o.stallAfter) != nil
				changed := stalledNow != o.lastStalled
				o.mu.Unlock()
				if changed {
					o.push()
				}
			}
		}
	}()
	return o
}

func (o *AgentObserver) viewLocked() AgentView {
	return AgentView{Status: o.status, Stall: StallOf(o.status, o.now(), o.stallAfter)}
}

func (o *AgentObserver) push() {
	o.pushMu.Lock()
	defer o.pushMu.Unlock()
	o.mu.Lock()
	current := o.viewLocked()
	o.lastStalled = current.Stall != nil
	listeners := make([]func(AgentView), 0, len(o.order))
	for _, id := range o.order {
		listeners = append(listeners, o.listeners[id])
	}
	o.mu.Unlock()
	for _, listener := range listeners {
		callIsolated(listener, current)
	}
}

// callIsolated: one panicking listener never starves the rest.
func callIsolated(listener func(AgentView), view AgentView) {
	defer func() { _ = recover() }()
	listener(view)
}

// Subscribe pushes the current view immediately, then on every change; it returns the unsubscribe.
func (o *AgentObserver) Subscribe(listener func(AgentView)) func() {
	o.pushMu.Lock()
	defer o.pushMu.Unlock()
	o.mu.Lock()
	id := o.next
	o.next++
	o.listeners[id] = listener
	o.order = append(o.order, id)
	current := o.viewLocked()
	o.mu.Unlock()
	callIsolated(listener, current)
	return func() {
		o.mu.Lock()
		defer o.mu.Unlock()
		delete(o.listeners, id)
		for i, known := range o.order {
			if known == id {
				o.order = append(o.order[:i:i], o.order[i+1:]...)
				break
			}
		}
	}
}

// Dispose stops the ticker and the subscription and drops every listener.
func (o *AgentObserver) Dispose() {
	o.stopOnce.Do(func() { close(o.stop) })
	o.unsubscribe()
	o.mu.Lock()
	o.listeners = map[int]func(AgentView){}
	o.order = nil
	o.mu.Unlock()
}

// SimpleStateOf is the four-word collapse: "idle", "busy", "stuck" or
// "error". Stuck beats busy (a silent turn is a problem before it is
// progress); error means idle after a failed last turn, a report about
// history, never a running state.
func SimpleStateOf(view AgentView) string {
	if view.Stall != nil {
		return "stuck"
	}
	if view.Status.IsRunning() {
		return "busy"
	}
	if view.Status.LastTurnOutcome != nil && view.Status.LastTurnOutcome.Kind == "failed" {
		return "error"
	}
	return "idle"
}
