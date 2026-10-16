package claude

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// claudeContextBreakdownTimeout is how long claude gets to answer
// (context-breakdown.ts). It answered in 0.5 s, mid-turn too (2.1.292). No
// model call, but each read sends the provider a batch of count_tokens
// requests, so a host reads on demand and does not poll. A var for tests.
var claudeContextBreakdownTimeout = 10 * time.Second

var contextKinds = map[string]string{"used": "used", "deferred": "deferred", "buffer": "reserved", "free": "free"}

func contextItem(name, tokens any) []oar.ContextItem {
	text, ok := name.(string)
	count, counted := jsonx.AsNumber(tokens)
	if !ok || !counted {
		return nil
	}
	return []oar.ContextItem{{Name: text, Tokens: int64(count)}}
}

const (
	mcpLoaded   = "MCP tools"
	mcpDeferred = "MCP tools (deferred)"
)

// mcpItems puts claude's MCP tools under the MCP category its answer has.
// isLoaded does not follow the category on 2.1.292: with tool search off
// the only category is MCP tools, yet every tool says isLoaded false. So
// isLoaded splits them only when both categories are there.
func mcpItems(payload jsonx.Record, names map[string]bool) map[string][]oar.ContextItem {
	tools := jsonx.AsRecordList(payload["mcpTools"])
	listed := func(filter func(jsonx.Record) bool) []oar.ContextItem {
		var items []oar.ContextItem
		for _, tool := range tools {
			if filter(tool) {
				items = append(items, contextItem(tool["name"], tool["tokens"])...)
			}
		}
		return items
	}
	if names[mcpLoaded] && names[mcpDeferred] {
		return map[string][]oar.ContextItem{
			mcpLoaded:   listed(func(tool jsonx.Record) bool { return tool["isLoaded"] == true }),
			mcpDeferred: listed(func(tool jsonx.Record) bool { return tool["isLoaded"] != true }),
		}
	}
	only := mcpDeferred
	if names[mcpLoaded] {
		only = mcpLoaded
	}
	return map[string][]oar.ContextItem{only: listed(func(jsonx.Record) bool { return true })}
}

// itemsByCategory is claude's per-entry lists, under the category each one makes up.
func itemsByCategory(payload jsonx.Record, names map[string]bool) map[string][]oar.ContextItem {
	items := map[string][]oar.ContextItem{}
	for _, file := range jsonx.AsRecordList(payload["memoryFiles"]) {
		items["Memory files"] = append(items["Memory files"], contextItem(file["path"], file["tokens"])...)
	}
	for _, skill := range jsonx.AsRecordList(jsonx.AsRecord(payload["skills"])["skillFrontmatter"]) {
		items["Skills"] = append(items["Skills"], contextItem(skill["name"], skill["tokens"])...)
	}
	for _, agent := range jsonx.AsRecordList(payload["agents"]) {
		items["Custom agents"] = append(items["Custom agents"], contextItem(agent["agentType"], agent["tokens"])...)
	}
	for name, listed := range mcpItems(payload, names) {
		items[name] = listed
	}
	return items
}

// claudeContextBreakdown reads claude's get_context_usage (detail "full")
// answer: its categories in its order and words, with the lists that itemize them.
func claudeContextBreakdown(payload jsonx.Record) (*oar.ContextBreakdown, error) {
	tokens, tokensOK := jsonx.Num(payload, "totalTokens")
	contextWindow, windowOK := jsonx.Num(payload, "maxTokens")
	if !tokensOK || !windowOK {
		return nil, errors.New("claude's get_context_usage answer has no totalTokens or maxTokens")
	}
	native := jsonx.AsRecordList(payload["categories"])
	names := map[string]bool{}
	for _, category := range native {
		if name, ok := category["name"].(string); ok {
			names[name] = true
		}
	}
	items := itemsByCategory(payload, names)
	categories := []oar.ContextCategory{}
	for _, category := range native {
		name, ok := category["name"].(string)
		count, counted := jsonx.Num(category, "tokens")
		if !ok || !counted {
			continue
		}
		kind := "unknown"
		if nativeKind, ok := category["kind"].(string); ok {
			if known, ok := contextKinds[nativeKind]; ok {
				kind = known
			}
		}
		categories = append(categories, oar.ContextCategory{Name: name, Tokens: int64(count), Kind: kind, Items: items[name]})
	}
	return &oar.ContextBreakdown{Tokens: int64(tokens), ContextWindow: int64(contextWindow), Categories: categories}, nil
}

// readAnswer is a settled read-back: the answer, or gone (the process exited or stdin ended).
type readAnswer struct {
	record jsonx.Record
	gone   bool
}

type contextPending struct {
	id     string
	answer chan readAnswer
}

type contextFlight struct {
	done      chan struct{}
	breakdown *oar.ContextBreakdown
	err       error
}

// contextBreakdownReader is Session.ContextBreakdown for a live claude:
// asked over the control channel, its answer consumed here and never
// recorded. consume and exited run with the session lock held; read takes
// it itself.
type contextBreakdownReader struct {
	lock  sync.Locker
	child claudeProcess
	// stdinEnded reports (under lock) an ended stdin without a dispose: the abort fallback's kill.
	stdinEnded func() bool

	pending *contextPending
	flight  *contextFlight
	gone    bool
}

func newContextBreakdownReader(child claudeProcess, lock sync.Locker, stdinEnded func() bool) *contextBreakdownReader {
	return &contextBreakdownReader{lock: lock, child: child, stdinEnded: stdinEnded}
}

// consume is true for the answer to one of these queries, which then goes no further.
func (r *contextBreakdownReader) consume(message jsonx.Record) bool {
	id := claudeControlResponseID(message)
	if id == "" || !strings.HasPrefix(id, "oar-context-") {
		return false
	}
	if r.pending != nil && r.pending.id == id {
		// A response that is no object reads as no answer (TS asRecord null).
		response := jsonx.AsRecord(message["response"])
		settle(r.pending.answer, readAnswer{record: response, gone: response == nil})
	}
	return true
}

// exited: the process is gone, or its stdin ended for a dispose: a read in
// flight, and every later one, is nil.
func (r *contextBreakdownReader) exited() {
	r.gone = true
	if r.pending != nil {
		settle(r.pending.answer, readAnswer{gone: true})
	}
}

func settle(answer chan readAnswer, value readAnswer) {
	select {
	case answer <- value:
	default:
	}
}

func (r *contextBreakdownReader) read(ctx context.Context) (*oar.ContextBreakdown, error) {
	r.lock.Lock()
	if r.gone || r.stdinEnded() {
		r.lock.Unlock()
		return nil, nil
	}
	// Concurrent calls share the read in flight.
	if r.flight == nil {
		flight := &contextFlight{done: make(chan struct{})}
		r.flight = flight
		go func() {
			flight.breakdown, flight.err = r.ask()
			r.lock.Lock()
			r.flight = nil
			r.lock.Unlock()
			close(flight.done)
		}()
	}
	flight := r.flight
	r.lock.Unlock()
	select {
	case <-flight.done:
		return flight.breakdown, flight.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (r *contextBreakdownReader) ask() (*oar.ContextBreakdown, error) {
	pending := &contextPending{id: "oar-context-" + observe.NewUUID(), answer: make(chan readAnswer, 1)}
	r.lock.Lock()
	r.pending = pending
	if r.gone {
		settle(pending.answer, readAnswer{gone: true})
	} else {
		r.child.Write(jsonText(controlRequest{Type: "control_request", RequestID: pending.id, Request: map[string]any{"subtype": "get_context_usage", "detail": "full"}}) + "\n")
	}
	r.lock.Unlock()
	timer := time.NewTimer(claudeContextBreakdownTimeout)
	defer timer.Stop()
	var answer readAnswer
	select {
	case answer = <-pending.answer:
	case <-timer.C:
		answer = readAnswer{record: jsonx.Record{"subtype": "error", "error": "no answer within " + itoa(claudeContextBreakdownTimeout.Milliseconds()) + " ms"}}
	}
	r.lock.Lock()
	if r.pending == pending {
		r.pending = nil
	}
	r.lock.Unlock()
	if answer.gone {
		return nil, nil
	}
	response := answer.record
	if response["subtype"] != "success" {
		reason, ok := response["error"].(string)
		if !ok {
			reason = "error"
		}
		return nil, errors.New("claude did not answer get_context_usage: " + reason)
	}
	payload := jsonx.AsRecord(response["response"])
	if payload == nil {
		payload = jsonx.Record{}
	}
	return claudeContextBreakdown(payload)
}
