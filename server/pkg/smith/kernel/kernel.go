// Package kernel is the runtime-author SPI (packages/oar/src/kernel.ts): the
// record stream every adapter is built on (Kernel) and the API face derived
// over it (Seal). A custom runtime pairs them with oar.DefineRuntime and gets
// dense seq, cursor replay, the reachability rule and control recording.
package kernel

import (
	"context"
	"fmt"
	"sync"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// RecordAt says where a record sits: another session id for derived
// children, a sub-agent path, a runtime-native span id.
type RecordAt struct {
	SessionID string
	AgentPath []string
	SpanID    string
	// For Request only: a runtime-issued id (toApp requests keep their own).
	ID string
}

// Kernel is the one record stream of a session (shared/session-kernel.ts).
//
// Shared here, never re-implemented per adapter: the envelope (dense seq,
// receivedAt, attribution), the retained log behind Records and the cursor,
// observer fan-out, the session graph, the control shape (Control records
// the request, lets the adapter decide, records the response) and the
// reachability rule. Nothing here gates facts: every frame enters.
//
// Concurrency: the kernel lock is a leaf; the kernel never calls out while
// holding it. Observers run on per-subscription delivery goroutines (see
// oar.Session). Adapters keep their own state under their own lock and call
// the kernel from under it freely.
type Kernel struct {
	sessionID string
	redact    func(oar.RawEvent) oar.RawEvent

	mu       sync.Mutex
	log      []oar.RawEvent
	seq      int64
	exited   bool
	disposed bool
	graph    *observe.GraphBuilder
	subs     map[*subscription]struct{}
	notify   chan struct{}
	now      func() int64
}

type subscription struct {
	observer oar.RawEventObserver
	next     int
	running  bool
	closed   bool
}

// Option configures a kernel.
type Option func(*Kernel)

// WithRedactor runs before retention and observer delivery.
func WithRedactor(redact func(oar.RawEvent) oar.RawEvent) Option {
	return func(k *Kernel) { k.redact = redact }
}

// WithClock replaces the receivedAt clock (tests).
func WithClock(now func() int64) Option {
	return func(k *Kernel) { k.now = now }
}

// New starts a stream for sessionID (a fresh UUID when empty).
func New(sessionID string, options ...Option) *Kernel {
	if sessionID == "" {
		sessionID = observe.NewUUID()
	}
	k := &Kernel{
		sessionID: sessionID,
		graph:     observe.NewGraphBuilder(sessionID),
		subs:      map[*subscription]struct{}{},
		notify:    make(chan struct{}),
		now:       func() int64 { return time.Now().UnixMilli() },
	}
	for _, option := range options {
		option(k)
	}
	return k
}

// SessionID is the stream's root session.
func (k *Kernel) SessionID() string { return k.sessionID }

func (k *Kernel) append(build func(envelope oar.Envelope) oar.RawEvent, at RecordAt) oar.RawEvent {
	sessionID := at.SessionID
	if sessionID == "" {
		sessionID = k.sessionID
	}
	path := at.AgentPath
	if path == nil {
		path = []string{}
	}
	k.mu.Lock()
	envelope := oar.Envelope{SessionID: sessionID, AgentPath: path, SpanID: at.SpanID, Seq: k.seq, ReceivedAt: k.now()}
	record := build(envelope)
	k.seq++
	if k.redact != nil {
		record = k.redact(record)
	}
	k.log = append(k.log, record)
	k.graph.Record(record)
	if record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseExited {
		k.exited = true
	}
	if record.Kind == oar.KindRequest && record.Direction == oar.ToRuntime && record.Request.Kind == oar.RequestDispose {
		k.disposed = true
	}
	var start []*subscription
	for sub := range k.subs {
		if !sub.running && !sub.closed {
			sub.running = true
			start = append(start, sub)
		}
	}
	close(k.notify)
	k.notify = make(chan struct{})
	k.mu.Unlock()
	for _, sub := range start {
		go k.drain(sub)
	}
	return record
}

// drain delivers a subscription's pending records in order until it is caught up.
func (k *Kernel) drain(sub *subscription) {
	for {
		k.mu.Lock()
		if sub.closed || sub.next >= len(k.log) {
			sub.running = false
			k.mu.Unlock()
			return
		}
		record := k.log[sub.next]
		sub.next++
		k.mu.Unlock()
		deliver(sub.observer, record)
	}
}

func deliver(observer oar.RawEventObserver, record oar.RawEvent) {
	defer func() {
		// Observers are a side-tap; their failures must not touch the run.
		_ = recover()
	}()
	observer(record)
}

// Frame appends the runtime's frame.
func (k *Kernel) Frame(body oar.FrameBody, at RecordAt) oar.RawEvent {
	return k.append(func(envelope oar.Envelope) oar.RawEvent {
		return oar.RawEvent{Envelope: envelope, Kind: oar.KindFrame, Frame: body}
	}, at)
}

// Request appends a request; its id is at.ID or a fresh UUID.
func (k *Kernel) Request(direction oar.RequestDirection, body oar.RequestBody, at RecordAt) oar.RawEvent {
	id := at.ID
	if id == "" {
		id = observe.NewUUID()
	}
	return k.append(func(envelope oar.Envelope) oar.RawEvent {
		return oar.RawEvent{Envelope: envelope, Kind: oar.KindRequest, ID: id, Direction: direction, Request: body}
	}, at)
}

// Respond appends a response pointing at requestID.
func (k *Kernel) Respond(requestID string, body oar.ResponseBody, at RecordAt) oar.RawEvent {
	return k.append(func(envelope oar.Envelope) oar.RawEvent {
		return oar.RawEvent{Envelope: envelope, Kind: oar.KindResponse, RequestID: requestID, Response: body}
	}, at)
}

// Unreachable says why a control cannot reach the runtime any more, read off
// the stream: an exited response (runtime_exited) or a dispose request
// (disposed). nil while reachable.
func (k *Kernel) Unreachable() *oar.ResponseBody {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.exited {
		body := oar.Rejected(oar.CodeRuntimeExited, "runtime exited")
		return &body
	}
	if k.disposed {
		body := oar.Rejected(oar.CodeDisposed, "session disposed")
		return &body
	}
	return nil
}

// Decide is an adapter's control decision. A panic or error becomes a
// rejected `error` response carrying its message.
type Decide func(request oar.RawEvent) (oar.ResponseBody, error)

// Control records a toRuntime request, decides, and records the response.
// When the stream already says the runtime is unreachable, or the input is
// empty with no images, the request is rejected without consulting decide.
// decide runs on the calling goroutine.
func (k *Kernel) Control(body oar.RequestBody, decide Decide, at RecordAt) oar.ControlResult {
	blocked := k.Unreachable()
	issued := k.Request(oar.ToRuntime, body, at)
	var decided oar.ResponseBody
	switch {
	case blocked != nil:
		decided = *blocked
	case EmptyInputRefusal(body) != nil:
		decided = *EmptyInputRefusal(body)
	default:
		decided = settle(decide, issued)
	}
	response := k.Respond(issued.ID, decided, RecordAt{SessionID: at.SessionID, AgentPath: at.AgentPath, SpanID: at.SpanID})
	return oar.ControlResult{Request: issued, Response: response}
}

func settle(decide Decide, issued oar.RawEvent) (body oar.ResponseBody) {
	defer func() {
		if recovered := recover(); recovered != nil {
			body = oar.Rejected(oar.CodeError, fmt.Sprint(recovered))
		}
	}()
	decided, err := decide(issued)
	if err != nil {
		return oar.Rejected(oar.CodeError, err.Error())
	}
	return decided
}

// EmptyInputRefusal refuses an input with neither text nor images. Whitespace is left intact.
func EmptyInputRefusal(body oar.RequestBody) *oar.ResponseBody {
	if body.IsInput() && body.Input == "" && len(body.Images) == 0 {
		refused := oar.Rejected(oar.CodeUnsupported, "empty input: give text or images")
		return &refused
	}
	return nil
}

// RawEvents subscribes an observer. With a cursor, retained records after
// AfterSeq are replayed synchronously before this returns, then delivery
// continues live on a delivery goroutine. It panics when the cursor names
// another session.
func (k *Kernel) RawEvents(observer oar.RawEventObserver, cursor *oar.Cursor) oar.Unsubscribe {
	if cursor != nil && cursor.SessionID != k.sessionID {
		panic(fmt.Sprintf("cursor belongs to session %s, not %s", cursor.SessionID, k.sessionID))
	}
	sub := &subscription{observer: observer}
	k.mu.Lock()
	var replay []oar.RawEvent
	if cursor == nil {
		sub.next = len(k.log)
	} else {
		sub.next = len(k.log)
		for i, record := range k.log {
			if record.Seq > cursor.AfterSeq {
				replay = k.log[i:len(k.log):len(k.log)]
				break
			}
		}
		// Hold delivery: the replay runs here, synchronously.
		sub.running = true
	}
	k.subs[sub] = struct{}{}
	k.mu.Unlock()
	if cursor != nil {
		for _, record := range replay {
			k.mu.Lock()
			closed := sub.closed
			k.mu.Unlock()
			if closed {
				break
			}
			deliver(observer, record)
		}
		k.mu.Lock()
		catchUp := !sub.closed && sub.next < len(k.log)
		sub.running = catchUp
		k.mu.Unlock()
		if catchUp {
			go k.drain(sub)
		}
	}
	return func() {
		k.mu.Lock()
		sub.closed = true
		delete(k.subs, sub)
		k.mu.Unlock()
	}
}

// Records is every retained record in seq order: a snapshot; never modify it.
func (k *Kernel) Records() []oar.RawEvent {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.log[:len(k.log):len(k.log)]
}

// Len is the number of retained records (the next seq).
func (k *Kernel) Len() int {
	k.mu.Lock()
	defer k.mu.Unlock()
	return len(k.log)
}

// Graph is the session graph of true sessions.
func (k *Kernel) Graph() oar.SessionGraph {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.graph.Graph()
}

// Link reads lineage from a native frame: put the returned event in that frame's events.
func (k *Kernel) Link(edge oar.SessionEdge) oar.SessionLinked {
	return oar.SessionLinked{Parent: edge.Parent, Child: edge.Child, Via: edge.Via}
}

// WaitFor blocks until a record at index >= from matches, returning it, or
// until ctx ends. It is the wait primitive for adapter internals: it depends
// on the log, never on observer timing.
func (k *Kernel) WaitFor(ctx context.Context, from int, match func(oar.RawEvent) bool) (oar.RawEvent, error) {
	for {
		k.mu.Lock()
		for i := from; i < len(k.log); i++ {
			if match(k.log[i]) {
				record := k.log[i]
				k.mu.Unlock()
				return record, nil
			}
		}
		from = len(k.log)
		wake := k.notify
		k.mu.Unlock()
		select {
		case <-wake:
		case <-ctx.Done():
			return oar.RawEvent{}, ctx.Err()
		}
	}
}
