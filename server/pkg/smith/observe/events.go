package observe

import (
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"vibevalley/pkg/smith/oar"
)

// KnownControl is a toRuntime request as EventsOf reads its response against
// it: the action, and for a withdraw the inputId it named.
type KnownControl struct {
	Action  oar.ControlAction
	InputID string
}

// KnownControlOf is what EventsOf keeps of a request body; false for a runtime→app body.
func KnownControlOf(body oar.RequestBody) (KnownControl, bool) {
	if body.Kind == oar.RequestNative {
		return KnownControl{}, false
	}
	known := KnownControl{Action: oar.ControlAction(body.Kind)}
	if body.Kind == oar.RequestWithdraw {
		known.InputID = body.InputID
	}
	return known, true
}

// EventsOf reads the flat, attributed events out of one record
// (observe/events.ts). actions holds the toRuntime requests seen so far
// (ControlActionsOf builds it from a log).
func EventsOf(record oar.RawEvent, actions map[string]KnownControl) []oar.Event {
	envelope := record.Envelope
	event := func(body oar.EventBody) oar.Event { return oar.Event{Envelope: envelope, Body: body} }
	switch record.Kind {
	case oar.KindFrame:
		events := make([]oar.Event, 0, len(record.Frame.Events))
		for _, body := range record.Frame.Events {
			if ended, ok := body.(oar.ToolCallEnded); ok {
				body = ended.Upgraded()
			}
			events = append(events, event(body))
		}
		return events
	case oar.KindRequest:
		if record.Direction == oar.ToApp {
			kind := string(record.Request.Kind)
			if record.Request.Kind == oar.RequestNative {
				kind = record.Request.Type
			}
			return []oar.Event{event(oar.AppRequest{RequestID: record.ID, Type: kind})}
		}
		if record.Request.Kind == oar.RequestPrompt {
			return []oar.Event{event(oar.TurnStarted{RequestID: record.ID, Input: record.Request.Input})}
		}
		return nil
	case oar.KindResponse:
		switch record.Response.Kind {
		case oar.ResponseExited:
			return []oar.Event{event(oar.Exited{Code: record.Response.ExitCode})}
		case oar.ResponseAnswered:
			return []oar.Event{event(oar.AppAnswered{RequestID: record.RequestID})}
		}
		known, ok := actions[record.RequestID]
		if !ok {
			return nil
		}
		if record.Response.Kind == oar.ResponseRejected {
			return []oar.Event{event(oar.ControlRejected{RequestID: record.RequestID, Action: known.Action, Code: record.Response.Code, Reason: record.Response.Reason})}
		}
		if known.Action == oar.ActionWithdraw {
			return []oar.Event{event(oar.InputWithdrawn{RequestID: record.RequestID, InputID: known.InputID})}
		}
	}
	return nil
}

// ControlActionsOf indexes every toRuntime request in a log by id.
func ControlActionsOf(records []oar.RawEvent) map[string]KnownControl {
	actions := map[string]KnownControl{}
	for _, record := range records {
		remember(actions, record)
	}
	return actions
}

func remember(actions map[string]KnownControl, record oar.RawEvent) {
	if record.Kind == oar.KindRequest && record.Direction == oar.ToRuntime {
		if known, ok := KnownControlOf(record.Request); ok {
			actions[record.ID] = known
		}
	}
}

// EventsReader turns a raw-event observer stream into events (eventsReader).
// It is stateful: give each subscription its own.
func EventsReader(observer oar.EventObserver) oar.RawEventObserver {
	actions := map[string]KnownControl{}
	return func(record oar.RawEvent) {
		remember(actions, record)
		for _, event := range EventsOf(record, actions) {
			observer(event)
		}
		if record.Kind == oar.KindResponse {
			delete(actions, record.RequestID)
		}
	}
}

func textOf(event oar.Event) (string, bool) {
	switch body := event.Body.(type) {
	case oar.TextDelta:
		return body.Text, true
	case oar.Reasoning:
		if body.Content.Kind == "text" {
			return body.Content.Text, true
		}
	}
	return "", false
}

func withText(event oar.Event, text string) oar.Event {
	switch body := event.Body.(type) {
	case oar.TextDelta:
		body.Text = text
		event.Body = body
	case oar.Reasoning:
		body.Content = oar.ReasoningContent{Kind: "text", Text: text}
		event.Body = body
	}
	return event
}

func messageIDOf(event oar.Event) string {
	switch body := event.Body.(type) {
	case oar.TextDelta:
		return body.MessageID
	case oar.Reasoning:
		return body.MessageID
	}
	return ""
}

func sameLane(held, next oar.Event) bool {
	return held.Kind() == next.Kind() && held.SessionID == next.SessionID &&
		slices.Equal(held.AgentPath, next.AgentPath) && messageIDOf(held) == messageIDOf(next)
}

// CoalesceText wraps an observer so consecutive text (or readable reasoning)
// pieces of one agent arrive as one event carrying the last piece's
// envelope. It flushes on a lane change, a non-text event, or (maxHold > 0)
// after the stream is quiet that long. The returned observer and its timer
// flush are serialized, so the wrapped observer never runs concurrently
// with itself.
func CoalesceText(observer oar.EventObserver, maxHold time.Duration) oar.EventObserver {
	input, _, _ := coalesceText(observer, maxHold)
	return input
}

func coalesceText(observer oar.EventObserver, maxHold time.Duration) (input oar.EventObserver, flush, cancel func()) {
	var mu sync.Mutex
	var held *oar.Event
	var canceled atomic.Bool
	var timer *time.Timer
	generation := 0
	unlock := func() {
		if canceled.Load() {
			if timer != nil {
				timer.Stop()
				timer = nil
			}
			held = nil
		}
		mu.Unlock()
	}
	flushLocked := func() {
		if timer != nil {
			timer.Stop()
			timer = nil
		}
		if held != nil {
			event := *held
			held = nil
			if !canceled.Load() {
				observer(event)
			}
		}
	}
	arm := func() {
		if maxHold <= 0 {
			return
		}
		if timer != nil {
			timer.Stop()
		}
		generation++
		mine := generation
		timer = time.AfterFunc(maxHold, func() {
			mu.Lock()
			defer unlock()
			if generation == mine {
				flushLocked()
			}
		})
	}
	input = func(event oar.Event) {
		mu.Lock()
		defer unlock()
		if canceled.Load() {
			return
		}
		if text, ok := textOf(event); ok {
			if held != nil {
				if previous, heldText := textOf(*held); heldText && sameLane(*held, event) {
					merged := withText(event, previous+text)
					held = &merged
					arm()
					return
				}
			}
			flushLocked()
			copied := event
			held = &copied
			arm()
			return
		}
		flushLocked()
		if !canceled.Load() {
			observer(event)
		}
	}
	flush = func() {
		mu.Lock()
		defer unlock()
		flushLocked()
	}
	cancel = func() {
		canceled.Store(true)
		// Cancellation is also safe inside the consumer callback.
		if mu.TryLock() {
			if timer != nil {
				timer.Stop()
				timer = nil
			}
			held = nil
			mu.Unlock()
		}
	}
	return input, flush, cancel
}
