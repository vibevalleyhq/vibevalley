package observe_test

import (
	"testing"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Port of tests/session-view.test.ts.

var svS1 = svLane{Session: "s1", At: 1}

func svReq(seq int64, id string, kind oar.RequestKind) oar.RawEvent {
	return svRequestIn(svS1, seq, id, oar.ToRuntime, svInput(kind, id))
}
func svAccepted(seq int64, requestID string) oar.RawEvent {
	return svResponseIn(svS1, seq, requestID, oar.Accepted())
}
func svRejected(seq int64, requestID string) oar.RawEvent {
	return svResponseIn(svS1, seq, requestID, oar.Rejected(oar.CodeBusy, "busy"))
}
func svFrame(seq int64, events ...oar.EventBody) oar.RawEvent { return svFrameIn(svS1, seq, events...) }
func svText(seq int64, value string) oar.RawEvent {
	return svFrame(seq, oar.TextDelta{Text: value})
}
func svEnded(seq int64) oar.RawEvent {
	return svFrame(seq, oar.TurnEnded{Outcome: oar.Completed()})
}

func TestSessionViewPromptTurnGroupsTextAndToolUnderOneLane(t *testing.T) {
	view := svFold(
		svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"), svText(2, "Hello"),
		svFrame(3, oar.ToolCallStarted{CallID: "c1", Tool: "Read", Input: oar.String("f.ts")}),
		svFrame(4, oar.ToolCallEnded{CallID: "c1", Content: []oar.ToolOutputPart{{Type: "text", Text: "contents"}}, Result: "ok"}),
		svEnded(5),
	)
	svEq(t, "kinds", svKinds(view), `["input","turn"]`)
	turn := svTurns(view)[0]
	svEq(t, "outcome", turn.Outcome, `{"kind":"completed"}`)
	if turn.OpenedBy != "r1" {
		t.Errorf("openedBy = %q", turn.OpenedBy)
	}
	if len(turn.Sections) != 1 {
		t.Fatalf("sections = %d", len(turn.Sections))
	}
	svEq(t, "parts", turn.Sections[0].Parts, `[{"kind":"text","text":"Hello"},
		{"kind":"tool","callId":"c1","tool":"Read","input":"f.ts","content":[{"type":"text","text":"contents"}],"result":"ok","startedAt":1,"endedAt":1}]`)
}

// codex can send a command's last outputDelta after turn/completed (issue #39).
func TestSessionViewProgressAfterTurnEndSettlesItsOwnPart(t *testing.T) {
	view := svFold(
		svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"),
		svFrame(2, oar.ToolCallStarted{CallID: "c1", Tool: "Bash", Input: oar.String("ls")}),
		svEnded(3),
		svFrame(4, oar.ToolCallProgress{CallID: "c1", Output: oar.String("a.ts")}),
		svReq(5, "r2", oar.RequestPrompt), svAccepted(6, "r2"),
		svFrame(7, oar.ToolCallEnded{CallID: "c1", Content: []oar.ToolOutputPart{{Type: "text", Text: "a.ts b.ts"}}, Result: "ok"}),
		svFrame(8, oar.ToolCallProgress{CallID: "c9", Output: oar.String("unseen")}),
	)
	svEq(t, "kinds", svKinds(view), `["input","turn","input","turn"]`)
	turns := svTurns(view)
	svEq(t, "first outcome", turns[0].Outcome, `{"kind":"completed"}`)
	svEq(t, "first parts", svTurnParts(turns[0]), `[{"kind":"tool","callId":"c1","tool":"Bash","input":"ls","content":[{"type":"text","text":"a.ts b.ts"}],"result":"ok","startedAt":1,"endedAt":1}]`)
	svEq(t, "second parts", svTurnParts(turns[1]), `[{"kind":"tool","callId":"c9","tool":"?","output":"unseen","result":"running"}]`)
}

func TestSessionViewRejectedPromptRemovesTheEmptyTurn(t *testing.T) {
	view := svFold(svReq(0, "r1", oar.RequestPrompt), svRejected(1, "r1"))
	svEq(t, "kinds", svKinds(view), `["input"]`)
	svMatch(t, "input", view.Messages[0], `{"kind":"input","input":{"state":"rejected"}}`)
	if view.OpenTurn != -1 {
		t.Errorf("openTurn = %d", view.OpenTurn)
	}
}

func TestSessionViewMidTurnInputSealsTheSegment(t *testing.T) {
	view := svFold(
		svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"), svText(2, "before"),
		svReq(3, "r2", oar.RequestSteer), svAccepted(4, "r2"), svText(5, "after"), svEnded(6),
	)
	svEq(t, "kinds", svKinds(view), `["input","turn","input","turn"]`)
	turns := svTurns(view)
	if turns[0].Outcome != nil {
		t.Errorf("first outcome = %+v", turns[0].Outcome)
	}
	svEq(t, "first", turns[0].Sections[0].Parts, `[{"kind":"text","text":"before"}]`)
	svEq(t, "second outcome", turns[1].Outcome, `{"kind":"completed"}`)
	svEq(t, "second", turns[1].Sections[0].Parts, `[{"kind":"text","text":"after"}]`)
}

func TestSessionViewSubAgentNestsAsASection(t *testing.T) {
	view := svFold(
		svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"),
		svFrame(2, oar.ToolCallStarted{CallID: "c1", Tool: "Task"}),
		svFrameIn(svLane{Session: "s1", Path: []string{"child-1"}, At: 1}, 3, oar.TextDelta{Text: "child says"}),
		svFrame(4, oar.ToolCallEnded{CallID: "c1", Result: "ok"}),
		svEnded(5),
	)
	turn := svTurns(view)[0]
	if len(turn.Sections) != 2 {
		t.Fatalf("sections = %d", len(turn.Sections))
	}
	svEq(t, "root path", turn.Sections[0].AgentPath, `[]`)
	svEq(t, "root parts", turn.Sections[0].Parts, `[{"kind":"tool","callId":"c1","tool":"Task","result":"ok","startedAt":1,"endedAt":1}]`)
	svEq(t, "child path", turn.Sections[1].AgentPath, `["child-1"]`)
	svEq(t, "child parts", turn.Sections[1].Parts, `[{"kind":"text","text":"child says"}]`)
}

func TestSessionViewChildSessionTurnEndIsANotice(t *testing.T) {
	view := svFold(
		svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"), svText(2, "root working"),
		svFrameIn(svLane{Session: "child-session", At: 1}, 3, oar.TurnEnded{Outcome: oar.Completed()}),
		svText(4, "still root"), svEnded(5),
	)
	turns := svTurns(view)
	if len(turns) != 1 {
		t.Fatalf("turns = %d", len(turns))
	}
	turn := turns[0]
	if len(turn.Sections) != 3 {
		t.Fatalf("sections = %d", len(turn.Sections))
	}
	if turn.Sections[1].SessionID != "child-session" {
		t.Errorf("section 1 session = %q", turn.Sections[1].SessionID)
	}
	svEq(t, "notice", turn.Sections[1].Parts, `[{"kind":"notice","notice":{"cause":"child_turn_ended","outcome":{"kind":"completed"}}}]`)
	svEq(t, "outcome", turn.Outcome, `{"kind":"completed"}`)
}

func TestSessionViewEventsWithoutAPromptOpenAnAdoptedTurn(t *testing.T) {
	view := svFold(svText(0, "queued work started"), svEnded(1))
	turn := svTurns(view)[0]
	if turn.OpenedBy != "" {
		t.Errorf("openedBy = %q", turn.OpenedBy)
	}
	svEq(t, "outcome", turn.Outcome, `{"kind":"completed"}`)
}

func TestSessionViewRuntimeRequestPendingUntilAnswered(t *testing.T) {
	ask := svRequestIn(svS1, 2, "req9", oar.ToApp, oar.RequestBody{Kind: oar.RequestNative, Type: "approval", Native: []byte(`{"command":"rm -rf"}`)})
	answer := svResponseIn(svS1, 3, "req9", oar.ResponseBody{Kind: oar.ResponseAnswered, Native: []byte(`{"allow":true}`)})
	mid := svFold(svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"), ask)
	svEq(t, "pending", mid.PendingRequests, `[{"requestId":"req9","type":"approval","sessionId":"s1","agentPath":[],"seq":2,"body":{"command":"rm -rf"}}]`)
	view := observe.ReduceSessionView(mid, answer, "")
	svEq(t, "pending after", view.PendingRequests, `[]`)
	svEq(t, "parts", svTurns(view)[0].Sections[0].Parts, `[{"kind":"app_request","requestId":"req9","type":"approval","answered":true,"body":{"command":"rm -rf"}}]`)
}

func TestSessionViewUnrequestedExitDerivesAFailedOutcome(t *testing.T) {
	code := 1
	exit := svResponseIn(svS1, 3, "", oar.ExitedBody(&code))
	view := svFold(svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"), svText(2, "partial"), exit)
	svEq(t, "exited", view.Exited, `{"code":1}`)
	svEq(t, "outcome", svTurns(view)[0].Outcome, `{"failure":"runtime_exited","kind":"failed","reason":"runtime exited"}`)
	svMatch(t, "last", view.Messages[len(view.Messages)-1], `{"kind":"notice","notice":{"cause":"exited","code":1}}`)
}

func TestSessionViewModelEffortContextAndUsage(t *testing.T) {
	view := svFold(
		svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"),
		svFrame(2,
			oar.Model{Model: "test-model"},
			oar.Effort{Effort: "high"},
			oar.Usage{Usage: oar.UsageReport{
				Context: &oar.ContextUsage{Tokens: oar.Int64(1000), ContextWindow: oar.Int64(2000), Percent: oar.Float(50)},
				Tokens:  &oar.TokenTotals{Input: 10, Output: 5, CacheRead: oar.Int64(6), CacheWrite: oar.Int64(0)},
			}},
		),
		svFrameIn(svLane{Session: "s1", Path: []string{"child"}, At: 1}, 3, oar.Usage{Usage: oar.UsageReport{Tokens: &oar.TokenTotals{Input: 3, Output: 1}}}),
	)
	svEq(t, "model", view.Model, `"test-model"`)
	svEq(t, "effort", view.Effort, `"high"`)
	svEq(t, "context", view.Context, `{"tokens":1000,"contextWindow":2000,"percent":50}`)
	// A cache part sums over the agents that reported it (#161); the child reported none.
	svEq(t, "usage", view.Usage, `{"total":{"input":13,"output":6,"cacheRead":6,"cacheWrite":0},
		"byAgent":[{"agentPath":[],"tokens":{"input":10,"output":5,"cacheRead":6,"cacheWrite":0}},{"agentPath":["child"],"tokens":{"input":3,"output":1}}]}`)
}

func TestSessionViewReplayAndIncrementalAgree(t *testing.T) {
	records := []oar.RawEvent{
		svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"), svText(2, "Hello"),
		svFrame(3, oar.Reasoning{Content: oar.ReasoningContent{Kind: "text", Text: "thinking"}}),
		svEnded(4),
	}
	svSame(t, "fold vs viewOf", svFold(records...), observe.ViewOf(records, ""))
}

func TestSessionViewFlatEventEntry(t *testing.T) {
	env := func(seq int64) oar.Envelope { return svS1.env(seq) }
	view := observe.InitialSessionView()
	for _, event := range []oar.Event{
		{Envelope: env(0), Body: oar.TurnStarted{RequestID: "r1", Input: "go"}},
		{Envelope: env(1), Body: oar.TextDelta{Text: "hi"}},
		{Envelope: env(2), Body: oar.TurnEnded{Outcome: oar.Completed()}},
	} {
		view = observe.ReduceSessionViewEvent(view, event, "")
	}
	turn := svTurns(view)[0]
	if turn.OpenedBy != "r1" {
		t.Errorf("openedBy = %q", turn.OpenedBy)
	}
	svEq(t, "parts", turn.Sections[0].Parts, `[{"kind":"text","text":"hi"}]`)
	svEq(t, "outcome", turn.Outcome, `{"kind":"completed"}`)
}

func TestSessionViewToolPartCarriesOrderedResultParts(t *testing.T) {
	content := []oar.ToolOutputPart{{Type: "text", Text: "shot"}, {Type: "image", MediaType: "image/png", Data: "iVBOR"}}
	view := svFold(
		svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"),
		svFrame(2, oar.ToolCallStarted{CallID: "c1", Tool: "Read", Input: oar.String("a.png")}),
		svFrame(3, oar.ToolCallEnded{CallID: "c1", Content: content, Result: "ok"}),
		svFrame(4, oar.ToolCallEnded{CallID: "c2", Content: content, Result: "ok"}),
	)
	contentJSON := `[{"type":"text","text":"shot"},{"type":"image","mediaType":"image/png","data":"iVBOR"}]`
	svMatch(t, "parts", svTurnParts(svTurns(view)[0]), `[{"kind":"tool","callId":"c1","content":`+contentJSON+`,"result":"ok"},
		{"kind":"tool","callId":"c2","tool":"?","content":`+contentJSON+`,"result":"ok"}]`)
}

func TestSessionViewToolPartCarriesObservedStartAndEnd(t *testing.T) {
	at := func(receivedAt int64, record oar.RawEvent) oar.RawEvent {
		record.ReceivedAt = receivedAt
		return record
	}
	view := svFold(
		svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"),
		at(1000, svFrame(2, oar.ToolCallStarted{CallID: "c1", Tool: "sleep", Input: oar.String(`{"durationMs":50000}`)})),
		at(8500, svFrame(3, oar.ToolCallEnded{CallID: "c1"})),
		at(9000, svFrame(4, oar.ToolCallStarted{CallID: "c2", Tool: "Bash"})),
		at(9500, svFrame(5, oar.ToolCallEnded{CallID: "c3", Result: "ok"})),
	)
	svEq(t, "parts", svTurnParts(svTurns(view)[0]), `[
		{"kind":"tool","callId":"c1","tool":"sleep","input":"{\"durationMs\":50000}","result":"ended","startedAt":1000,"endedAt":8500},
		{"kind":"tool","callId":"c2","tool":"Bash","result":"running","startedAt":9000},
		{"kind":"tool","callId":"c3","tool":"?","result":"ok","endedAt":9500}]`)
}

func TestSessionViewNamedTextStartsNewPartsUnnamedJoinsTheLast(t *testing.T) {
	say := func(seq int64, value, messageID string) oar.RawEvent {
		return svFrame(seq, oar.TextDelta{Text: value, MessageID: messageID})
	}
	view := svFold(svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"),
		say(2, "Got it", "m1"), say(3, ".", "m1"), say(4, "Waited", "m2"), say(5, " 100 s.", ""))
	svEq(t, "parts", svTurns(view)[0].Sections[0].Parts, `[{"kind":"text","text":"Got it.","messageId":"m1"},{"kind":"text","text":"Waited 100 s.","messageId":"m2"}]`)
}
