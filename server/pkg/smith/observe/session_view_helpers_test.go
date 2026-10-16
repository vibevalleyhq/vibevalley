package observe_test

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Record builders and JSON matchers for the session-view tests (ports of
// tests/session-view*.test.ts and the tool-input/output tests).

// svLane is where a record sits: its session, agent path and arrival time.
type svLane struct {
	Session string
	Path    []string
	At      int64
}

func (l svLane) env(seq int64) oar.Envelope {
	path := l.Path
	if path == nil {
		path = []string{}
	}
	return oar.Envelope{SessionID: l.Session, AgentPath: path, Seq: seq, ReceivedAt: l.At}
}

func svFrameIn(lane svLane, seq int64, events ...oar.EventBody) oar.RawEvent {
	return oar.RawEvent{Envelope: lane.env(seq), Kind: oar.KindFrame, Frame: oar.FrameBody{Type: "native", Native: json.RawMessage("{}"), Events: events}}
}

func svRequestIn(lane svLane, seq int64, id string, direction oar.RequestDirection, body oar.RequestBody) oar.RawEvent {
	return oar.RawEvent{Envelope: lane.env(seq), Kind: oar.KindRequest, ID: id, Direction: direction, Request: body}
}

func svResponseIn(lane svLane, seq int64, requestID string, body oar.ResponseBody) oar.RawEvent {
	return oar.RawEvent{Envelope: lane.env(seq), Kind: oar.KindResponse, RequestID: requestID, Response: body}
}

// svInput is a prompt/steer/queue body with input "input <id>" and inputId "input-<id>".
func svInput(kind oar.RequestKind, of string) oar.RequestBody {
	return oar.RequestBody{Kind: kind, Input: "input " + of, InputID: "input-" + of}
}

func svFold(records ...oar.RawEvent) observe.SessionView {
	view := observe.InitialSessionView()
	for _, record := range records {
		view = observe.ReduceSessionView(view, record, "")
	}
	return view
}

func svTurns(view observe.SessionView) []observe.ViewMessage {
	var turns []observe.ViewMessage
	for _, message := range view.Messages {
		if message.Kind == "turn" {
			turns = append(turns, message)
		}
	}
	return turns
}

func svKinds(view observe.SessionView) []string {
	kinds := []string{}
	for _, message := range view.Messages {
		kinds = append(kinds, message.Kind)
	}
	return kinds
}

func svTurnParts(turn observe.ViewMessage) []observe.ViewPart {
	parts := []observe.ViewPart{}
	for _, section := range turn.Sections {
		parts = append(parts, section.Parts...)
	}
	return parts
}

// svTools is every tool part with its lane, as the TS tests' tools(view) helper.
func svTools(view observe.SessionView) []map[string]any {
	out := []map[string]any{}
	for _, message := range view.Messages {
		if message.Kind != "turn" {
			continue
		}
		for _, section := range message.Sections {
			for _, part := range section.Parts {
				if part.Kind != "tool" {
					continue
				}
				row := svObject(part)
				row["sessionId"] = section.SessionID
				row["agentPath"] = svObject2(section.AgentPath)
				out = append(out, row)
			}
		}
	}
	return out
}

func svObject(value any) map[string]any {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		panic(err)
	}
	return out
}

func svObject2(value any) any {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var out any
	if err := json.Unmarshal(data, &out); err != nil {
		panic(err)
	}
	return out
}

// svEq requires got, as JSON, to equal want (a JSON literal).
func svEq(t *testing.T, label string, got any, want string) {
	t.Helper()
	g := svObject2(got)
	var w any
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatalf("%s: bad want JSON: %v", label, err)
	}
	if !reflect.DeepEqual(g, w) {
		gotJSON, _ := json.Marshal(g)
		t.Errorf("%s:\n got  %s\n want %s", label, gotJSON, want)
	}
}

// svSame requires a and b to marshal to the same JSON value.
func svSame(t *testing.T, label string, a, b any) {
	t.Helper()
	if !reflect.DeepEqual(svObject2(a), svObject2(b)) {
		aj, _ := json.Marshal(a)
		bj, _ := json.Marshal(b)
		t.Errorf("%s differ:\n %s\n %s", label, svClip(aj), svClip(bj))
	}
}

func svClip(data []byte) string {
	if len(data) > 1500 {
		return string(data[:1500]) + "…"
	}
	return string(data)
}

// svMatch is toMatchObject: every key of want is in got with a matching
// value; arrays match element by element with equal length.
func svMatch(t *testing.T, label string, got any, want string) {
	t.Helper()
	var w any
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatalf("%s: bad want JSON: %v", label, err)
	}
	g := svObject2(got)
	if problem := svSubset("", w, g); problem != "" {
		gotJSON, _ := json.Marshal(g)
		t.Errorf("%s: %s\n got  %s\n want %s", label, problem, svClip(gotJSON), want)
	}
}

func svSubset(path string, want, got any) string {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return fmt.Sprintf("%s: not an object", path)
		}
		for key, value := range w {
			gv, present := g[key]
			if !present {
				return fmt.Sprintf("%s.%s: missing", path, key)
			}
			if problem := svSubset(path+"."+key, value, gv); problem != "" {
				return problem
			}
		}
		return ""
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return fmt.Sprintf("%s: array length differs", path)
		}
		for i := range w {
			if problem := svSubset(fmt.Sprintf("%s[%d]", path, i), w[i], g[i]); problem != "" {
				return problem
			}
		}
		return ""
	default:
		if !reflect.DeepEqual(want, got) {
			return fmt.Sprintf("%s: %v != %v", path, got, want)
		}
		return ""
	}
}

// svHas reports whether value, as a JSON object, has key.
func svHas(value any, key string) bool {
	_, ok := svObject(value)[key]
	return ok
}

func svStrings(t *testing.T, label string, got, want []string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s:\n got  %s\n want %s", label, strings.Join(got, "\n      "), strings.Join(want, "\n      "))
	}
}
