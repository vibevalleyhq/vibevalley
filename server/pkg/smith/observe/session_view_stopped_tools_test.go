package observe_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Port of tests/session-view-stopped-tools.test.ts. The TS test drives a
// session kernel; svStream is the same envelope (dense seq, a session id,
// receivedAt from a clock) without a kernel's delivery goroutines.

type svStream struct {
	root    string
	records []oar.RawEvent
	ids     int
}

func svNewStream(root string) *svStream { return &svStream{root: root} }

func (s *svStream) lane(at svLane) svLane {
	if at.Session == "" {
		at.Session = s.root
	}
	at.At = int64(len(s.records))*10 + 5
	return at
}

func (s *svStream) frame(at svLane, events ...oar.EventBody) oar.RawEvent {
	record := svFrameIn(s.lane(at), int64(len(s.records)), events...)
	s.records = append(s.records, record)
	return record
}

func (s *svStream) request(at svLane, direction oar.RequestDirection, body oar.RequestBody) oar.RawEvent {
	s.ids++
	record := svRequestIn(s.lane(at), int64(len(s.records)), fmt.Sprintf("k%d", s.ids), direction, body)
	s.records = append(s.records, record)
	return record
}

func (s *svStream) respond(at svLane, requestID string, body oar.ResponseBody) oar.RawEvent {
	record := svResponseIn(s.lane(at), int64(len(s.records)), requestID, body)
	s.records = append(s.records, record)
	return record
}

func (s *svStream) snapshot() []oar.RawEvent { return append([]oar.RawEvent{}, s.records...) }

type svEnding string

var svEndings = []svEnding{"abort fallback", "dispose", "turn_ended"}

func svBegin(s *svStream) {
	prompt := s.request(svLane{}, oar.ToRuntime, oar.RequestBody{Kind: oar.RequestPrompt, Input: "work"})
	s.respond(svLane{}, prompt.ID, oar.Accepted())
}

func svFinish(s *svStream, ending svEnding) {
	if ending == "turn_ended" {
		s.frame(svLane{}, oar.TurnEnded{Outcome: oar.Completed()})
		return
	}
	kind := oar.RequestAbort
	if ending == "dispose" {
		kind = oar.RequestDispose
	}
	stop := s.request(svLane{}, oar.ToRuntime, oar.RequestBody{Kind: kind})
	if ending == "abort fallback" {
		s.respond(svLane{}, stop.ID, oar.Accepted())
	}
	code := 9
	s.respond(svLane{}, "", oar.ExitedBody(&code))
}

func svPick(row map[string]any, keys ...string) map[string]any {
	out := map[string]any{}
	for _, key := range keys {
		out[key] = row[key] // an absent key reads as nil, as TS destructuring reads undefined
	}
	return out
}

func TestSessionViewStoppedToolsEndUnresolvedRootToolsAcrossSegments(t *testing.T) {
	for _, ending := range svEndings {
		t.Run(string(ending), func(t *testing.T) {
			s := svNewStream("root")
			svBegin(s)
			s.frame(svLane{},
				oar.ToolCallStarted{CallID: "before", Tool: "Bash"},
				oar.ToolCallProgress{CallID: "before", Output: oar.String("partial output")},
				oar.ToolCallStarted{CallID: "settled", Tool: "Read"},
				oar.ToolCallEnded{CallID: "settled", Result: "failed", Content: []oar.ToolOutputPart{{Type: "text", Text: "missing file"}}},
				oar.TaskStarted{TaskID: "background", TaskType: "shell", Background: oar.Bool(true)},
			)
			s.frame(svLane{Path: []string{"child"}}, oar.ToolCallStarted{CallID: "before", Tool: "Bash"})
			s.frame(svLane{Session: "child-session"}, oar.ToolCallStarted{CallID: "before", Tool: "Bash"})
			steer := s.request(svLane{}, oar.ToRuntime, oar.RequestBody{Kind: oar.RequestSteer, Input: "more"})
			s.respond(svLane{}, steer.ID, oar.Accepted())
			s.frame(svLane{}, oar.ToolCallStarted{CallID: "after", Tool: "Bash"})
			before := observe.ViewOf(s.records, "")
			beforeJSON, _ := json.Marshal(before)
			cursor := len(s.records)
			svFinish(s, ending)
			after := before
			for _, record := range s.records[cursor:] {
				after = observe.ReduceSessionView(after, record, "")
			}
			if again, _ := json.Marshal(before); string(again) != string(beforeJSON) {
				t.Error("folding on changed the checkpoint view")
			}
			svSame(t, "incremental vs replay", after, observe.ViewOf(s.records, ""))
			running := 0
			for _, part := range svTools(before) {
				if part["result"] == "running" {
					running++
				}
			}
			if running != 4 {
				t.Errorf("running before = %d", running)
			}
			rows := []map[string]any{}
			for _, part := range svTools(after) {
				rows = append(rows, svPick(part, "sessionId", "agentPath", "callId", "result", "content", "output"))
			}
			svEq(t, "tools", rows, `[
				{"agentPath":[],"callId":"before","content":null,"output":"partial output","result":"ended","sessionId":"root"},
				{"agentPath":[],"callId":"settled","content":[{"text":"missing file","type":"text"}],"output":null,"result":"failed","sessionId":"root"},
				{"agentPath":["child"],"callId":"before","content":null,"output":null,"result":"running","sessionId":"root"},
				{"agentPath":[],"callId":"before","content":null,"output":null,"result":"running","sessionId":"child-session"},
				{"agentPath":[],"callId":"after","content":null,"output":null,"result":"ended","sessionId":"root"}]`)
			for _, part := range svTools(after) {
				if _, has := part["endedAt"]; part["result"] == "ended" && has {
					t.Errorf("an inferred end has endedAt: %v", part)
				}
			}
			want := "stopped"
			if ending == "turn_ended" {
				want = "running"
			}
			if status := observe.TasksOf(s.records, "").Value[0].Status; status != want {
				t.Errorf("task status = %q, want %q", status, want)
			}
		})
	}
}

func TestSessionViewStoppedToolsLateResultReplacesTheInferredEnd(t *testing.T) {
	for _, ending := range svEndings {
		t.Run(string(ending), func(t *testing.T) {
			s := svNewStream("root")
			svBegin(s)
			s.frame(svLane{}, oar.ToolCallStarted{CallID: "call", Tool: "Bash"})
			svFinish(s, ending)
			ended := observe.ViewOf(s.records, "")
			s.frame(svLane{}, oar.ToolCallProgress{CallID: "call", Output: oar.String("late output")})
			progressed := observe.ViewOf(s.records, "")
			svMatch(t, "progressed", svTools(progressed)[0], `{"result":"ended","output":"late output"}`)
			s.frame(svLane{}, oar.ToolCallEnded{CallID: "call", Result: "ok", Content: []oar.ToolOutputPart{{Type: "text", Text: "actual result"}}})
			final := observe.ViewOf(s.records, "")
			if len(final.Messages) != len(ended.Messages) {
				t.Errorf("messages %d, want %d", len(final.Messages), len(ended.Messages))
			}
			tool := svTools(final)[0]
			svMatch(t, "final", tool, `{"result":"ok","content":[{"type":"text","text":"actual result"}]}`)
			if _, has := tool["output"]; has {
				t.Errorf("output kept: %v", tool["output"])
			}
			if tool["endedAt"] != float64(s.records[len(s.records)-1].ReceivedAt) {
				t.Errorf("endedAt = %v", tool["endedAt"])
			}
		})
	}
}

func TestSessionViewStoppedToolsChildEndAndExitLeaveTheRootTool(t *testing.T) {
	for _, scope := range []svLane{{Path: []string{"child"}}, {Session: "child-session"}} {
		t.Run(fmt.Sprintf("%+v", scope), func(t *testing.T) {
			s := svNewStream("root")
			svBegin(s)
			s.frame(svLane{}, oar.ToolCallStarted{CallID: "call", Tool: "Bash"})
			s.frame(scope, oar.TurnEnded{Outcome: oar.Completed()})
			code := 0
			s.respond(scope, "", oar.ExitedBody(&code))
			if result := svTools(observe.ViewOf(s.records, ""))[0]["result"]; result != "running" {
				t.Errorf("result = %v", result)
			}
		})
	}
}

func TestSessionViewStoppedToolsNewPromptEndsOnlyItsTools(t *testing.T) {
	s := svNewStream("root")
	svBegin(s)
	s.frame(svLane{}, oar.ToolCallStarted{CallID: "older", Tool: "Bash"})
	svBegin(s)
	s.frame(svLane{}, oar.ToolCallStarted{CallID: "current", Tool: "Bash"})
	svFinish(s, "turn_ended")
	rows := [][]any{}
	for _, part := range svTools(observe.ViewOf(s.records, "")) {
		rows = append(rows, []any{part["callId"], part["result"]})
	}
	svEq(t, "tools", rows, `[["older","running"],["current","ended"]]`)
}

func TestSessionViewStoppedToolsFlatEventsEndRootTools(t *testing.T) {
	for _, kind := range []string{"turn_ended", "exited"} {
		t.Run(kind, func(t *testing.T) {
			lane := svLane{Session: "root", At: 1}
			started := observe.ReduceSessionViewEvent(observe.InitialSessionView(), oar.Event{Envelope: lane.env(0), Body: oar.ToolCallStarted{CallID: "call", Tool: "Bash"}}, "")
			var body oar.EventBody = oar.TurnEnded{Outcome: oar.Completed()}
			if kind == "exited" {
				body = oar.Exited{}
			}
			ended := observe.ReduceSessionViewEvent(started, oar.Event{Envelope: lane.env(1), Body: body}, "")
			svEq(t, "tool", svTools(ended)[0], `{"agentPath":[],"callId":"call","kind":"tool","result":"ended","sessionId":"root","startedAt":1,"tool":"Bash"}`)
		})
	}
}
