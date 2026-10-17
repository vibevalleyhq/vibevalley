package acp

import (
	"encoding/json"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
)

// How ACP wire traffic lands in the record stream (records.ts). Every frame
// is recorded verbatim; this only decides the envelope (which session id)
// and the events. Nothing is filtered: an update for a session id other than
// the root is a derived child session, recorded under ITS id and added to
// the graph (filtering by session id is the adapter red line).

func stringField(record jsonx.Record, names ...string) string {
	for _, name := range names {
		if value, ok := record[name].(string); ok && value != "" {
			return value
		}
	}
	return ""
}

// Lineage is a parent/child session pair.
type Lineage struct {
	Parent string
	Child  string
}

// LineageOf is the parent/child session pair a vendor notification names,
// in either spelling and at either depth; nil when none. grok 1.0.25 spells
// it `_x.ai/session_notification {sessionId: <parent>, update:
// {sessionUpdate: "subagent_spawned" | "subagent_progress",
// parent_session_id, child_session_id, …}}`: snake_case, nested under
// `update`; its `subagent_finished` carries only `child_session_id`, the
// parent being the envelope's `sessionId`. A flat camelCase
// `{parentSessionId, childSessionId | sessionId}` is the fixture spelling.
func LineageOf(params jsonx.Record) *Lineage {
	envelope := stringField(params, "sessionId")
	flatParent := stringField(params, "parentSessionId", "parent_session_id")
	flatChild := stringField(params, "childSessionId", "child_session_id")
	if flatChild == "" {
		flatChild = envelope
	}
	if flatParent != "" && flatChild != "" && flatParent != flatChild {
		return &Lineage{Parent: flatParent, Child: flatChild}
	}
	update := jsonx.AsRecord(params["update"])
	if update == nil {
		return nil
	}
	nestedChild := stringField(update, "childSessionId", "child_session_id")
	nestedParent := stringField(update, "parentSessionId", "parent_session_id")
	if nestedParent == "" {
		nestedParent = envelope
	}
	if nestedParent != "" && nestedChild != "" && nestedParent != nestedChild {
		return &Lineage{Parent: nestedParent, Child: nestedChild}
	}
	return nil
}

// Attribution is the session a vendor says an update belongs to, and its parent.
type Attribution struct {
	SessionID string
	Parent    string
}

// Recorder writes ACP traffic into the kernel. The session id is only known
// after the handshake, so everything recorded before Bind is queued in
// arrival order and appended then (kimi pushes its model
// config_option_update before session/set_model is answered). Callers
// serialize access (the session lock).
type Recorder struct {
	gate        *UsageGate
	attribute   func(notification jsonx.Record) *Attribution
	tokenUsage  *TokenUsage
	projections map[string]*ProjectionState
	bound       *kernel.Kernel
	queued      []func(*kernel.Kernel)
	// Profile.ModelName; nil keeps the agent's word.
	modelName func(value string) string
}

// named is events with each model report in the runtime's own naming (Profile.ModelName).
func (r *Recorder) named(events []oar.EventBody) []oar.EventBody {
	if r.modelName == nil {
		return events
	}
	for i, event := range events {
		if model, ok := event.(oar.Model); ok {
			events[i] = oar.Model{Model: r.modelName(model.Model)}
		}
	}
	return events
}

// NewRecorder records through gate, the profile's attribution and the token accumulator.
func NewRecorder(gate *UsageGate, attribute func(jsonx.Record) *Attribution, tokenUsage *TokenUsage) *Recorder {
	return &Recorder{gate: gate, attribute: attribute, tokenUsage: tokenUsage, projections: map[string]*ProjectionState{}}
}

func (r *Recorder) projectionFor(sessionID string) *ProjectionState {
	state := r.projections[sessionID]
	if state == nil {
		state = NewProjectionState()
		r.projections[sessionID] = state
	}
	return state
}

func (r *Recorder) write(do func(*kernel.Kernel)) {
	if r.bound == nil {
		r.queued = append(r.queued, do)
		return
	}
	do(r.bound)
}

// Bind attaches the kernel and appends what was queued.
func (r *Recorder) Bind(k *kernel.Kernel) {
	r.bound = k
	queued := r.queued
	r.queued = nil
	for _, do := range queued {
		do(k)
	}
}

func atSession(k *kernel.Kernel, sessionID string) kernel.RecordAt {
	if sessionID == k.SessionID() {
		return kernel.RecordAt{}
	}
	return kernel.RecordAt{SessionID: sessionID}
}

// Update records one `session/update` notification (its params, verbatim).
func (r *Recorder) Update(params json.RawMessage) {
	r.write(func(k *kernel.Kernel) {
		notification := jsonx.ParseRecord(params)
		var source *Attribution
		if r.attribute != nil {
			source = r.attribute(notification)
		}
		sessionID := jsonx.Str(notification, "sessionId")
		if source != nil {
			sessionID = source.SessionID
		}
		foreign := sessionID != k.SessionID()
		rawUpdate := jsonx.RawFields(params)["update"]
		update := jsonx.ParseRecord(rawUpdate)
		var events []oar.EventBody
		if update != nil {
			events = ProjectUpdate(r.projectionFor(sessionID), rawUpdate)
		}
		if source != nil && source.Parent != "" {
			for _, link := range shared.NewSessionLinks(k, []oar.SessionEdge{{Parent: source.Parent, Child: sessionID, Via: "tool_call"}}) {
				events = append(events, link)
			}
		}
		frameType := MethodSessionUpdate
		if kind, ok := update["sessionUpdate"].(string); ok {
			frameType = kind
		}
		k.Frame(oar.FrameBody{Type: frameType, Native: params, Events: r.named(events)}, atSession(k, sessionID))
		if !foreign {
			usage := false
			for _, event := range events {
				if _, ok := event.(oar.Usage); ok {
					usage = true
				}
			}
			r.gate.Observe(usage)
		}
	})
}

// Extension records a vendor extension notification, verbatim; a
// parent/child pair links the graph. afterOpen was captured on the wire.
func (r *Recorder) Extension(method string, params json.RawMessage, afterOpen bool) {
	r.write(func(k *kernel.Kernel) {
		record := jsonx.ParseRecord(params)
		// The envelope says whose frame this is: a child session pushes its
		// own `response_completed` / `turn_completed` on grok's vendor method
		// with ITS id in `sessionId`, so it is recorded under the child like
		// a foreign `session/update`. A frame that merely NAMES a child (the
		// parent's `subagent_*` lifecycle) keeps the parent's envelope.
		sessionID := stringField(record, "sessionId")
		at := kernel.RecordAt{}
		if sessionID != "" && sessionID != k.SessionID() {
			at.SessionID = sessionID
		}
		var events []oar.EventBody
		if lineage := LineageOf(record); lineage != nil {
			for _, link := range shared.NewSessionLinks(k, []oar.SessionEdge{{Parent: lineage.Parent, Child: lineage.Child, Via: "tool_call"}}) {
				events = append(events, link)
			}
		}
		if sessionID == k.SessionID() && r.tokenUsage != nil {
			if usage := r.tokenUsage.Extension(method, record, afterOpen); usage != nil {
				events = append(events, usage)
			}
		}
		k.Frame(oar.FrameBody{Type: method, Native: params, Events: r.named(events)}, at)
	})
}

// Step records a handshake answer (initialize, session/new|resume|load,
// session/set_model, session/set_config_option): the runtime's word, with
// its model and effort reports as events.
func (r *Recorder) Step(method string, response json.RawMessage) {
	r.write(func(k *kernel.Kernel) {
		record := jsonx.ParseRecord(response)
		var events []oar.EventBody
		if model, ok := ReportedModel(record); ok {
			events = append(events, oar.Model{Model: model})
		}
		if effort, ok := ReportedEffort(record); ok {
			events = append(events, oar.Effort{Effort: effort})
		}
		k.Frame(oar.FrameBody{Type: method, Native: response, Events: r.named(events)}, kernel.RecordAt{})
	})
}

// Requested records a runtime→app request, verbatim, under the runtime's own request id.
func (r *Recorder) Requested(id, method string, params json.RawMessage) {
	r.write(func(k *kernel.Kernel) {
		k.Request(oar.ToApp, oar.RequestBody{Kind: oar.RequestNative, Type: method, Native: params}, kernel.RecordAt{ID: id})
	})
}

// Answered records OAR's answer to a runtime→app request.
func (r *Recorder) Answered(id string, reply any) {
	native := json.RawMessage("null")
	if reply != nil {
		native = jsonx.Marshal(reply)
	}
	r.write(func(k *kernel.Kernel) {
		k.Respond(id, oar.ResponseBody{Kind: oar.ResponseAnswered, Native: native}, kernel.RecordAt{})
	})
}
