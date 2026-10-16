package acp

import "sync"

// Opening tracks the wire's opening boundary (opening.ts): whether a
// notification arrived after the answer to session/new, session/resume or
// session/load. TS needs it because the SDK routes notifications
// asynchronously; here one reader goroutine handles lines in wire order, so
// Incoming answers for each notification directly. Not safe for concurrent
// use, guarded by its own lock: Outgoing runs on the requesting goroutine,
// the rest on the reader.
type Opening struct {
	mu       sync.Mutex
	requests map[string]bool
	opened   bool
}

// NewOpening starts with nothing opened.
func NewOpening() *Opening { return &Opening{requests: map[string]bool{}} }

func isOpenMethod(method string) bool {
	return method == MethodSessionNew || method == MethodSessionResume || method == MethodSessionLoad
}

// Outgoing notes a request about to be written (id as its JSON text).
func (o *Opening) Outgoing(id, method string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if isOpenMethod(method) {
		o.requests[id] = true
	}
}

// Response notes a response read off the wire; result reports a success answer.
func (o *Opening) Response(id string, result bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.requests[id] {
		delete(o.requests, id)
		if result {
			o.opened = true
		}
	}
}

// Notification reports whether a notification read now arrived after an open answer.
func (o *Opening) Notification() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.opened
}
