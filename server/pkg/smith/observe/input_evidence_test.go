package observe_test

import (
	"encoding/json"
	"testing"

	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// tests/input-dropped.test.ts, tests/input-queued.test.ts,
// tests/native-turn-active.test.ts and tests/turn-active.test.ts.

type ieInputOptions struct {
	kind       oar.RequestKind
	unanswered bool
}

func ieInput(k *kernel.Kernel, id string, options ieInputOptions) oar.RawEvent {
	kind := options.kind
	if kind == "" {
		kind = oar.RequestSteer
	}
	request := k.Request(oar.ToRuntime, oar.RequestBody{Kind: kind, InputID: id, Input: "text " + id}, kernel.RecordAt{})
	if !options.unanswered {
		k.Respond(request.ID, oar.Accepted(), kernel.RecordAt{})
	}
	return request
}

func ieFrame(k *kernel.Kernel, events ...oar.EventBody) oar.RawEvent {
	return k.Frame(oar.FrameBody{Type: "native", Native: json.RawMessage(`{}`), Events: events}, kernel.RecordAt{SpanID: "turn-1"})
}

func ieStart() *kernel.Kernel {
	k := kernel.New("thread-1")
	ieInput(k, "prompt", ieInputOptions{kind: oar.RequestPrompt})
	ieFrame(k, oar.UserMessage{InputID: "prompt", Input: "text prompt", Evidence: "turn_item"})
	ieFrame(k, oar.ToolCallStarted{CallID: "cmd-1", Tool: "commandExecution"})
	return k
}

func ieDropped(k *kernel.Kernel, inputID string) {
	ieFrame(k, oar.InputDropped{InputID: inputID, Reason: "turn_interrupted"}, oar.TurnEnded{Outcome: oar.AbortedOutcome()})
}

func ieKinds(view observe.SessionView) []string {
	kinds := []string{}
	for _, message := range view.Messages {
		kinds = append(kinds, message.Kind)
	}
	return kinds
}

func ieExit(k *kernel.Kernel, code int, at kernel.RecordAt) oar.RawEvent {
	return k.Respond("", oar.ExitedBody(&code), at)
}

func TestInputDroppedInterruptedSteerLeavesTray(t *testing.T) {
	k := ieStart()
	request := ieInput(k, "steer", ieInputOptions{})
	ieDropped(k, "steer")
	view := observe.ViewOf(k.Records(), "")
	fxEqual(t, view.PendingInputs, `[]`)
	fxEqual(t, ieKinds(view), `["input","turn","input","turn"]`)
	fxMatch(t, view.Messages[2], `{"kind":"input","input":{"inputId":"steer","state":"dropped","reason":"turn_interrupted","attempts":[{"request":`+fxShow(fxAny(t, request))+`,"state":"accepted"}]}}`)
	fxMatch(t, view.Messages[len(view.Messages)-1], `{"outcome":{"kind":"aborted"}}`)
}

func TestInputDroppedTurnAloneNeverDropsUnreadInput(t *testing.T) {
	for _, outcome := range []oar.TurnOutcome{oar.Completed(), oar.AbortedOutcome()} {
		k := ieStart()
		ieInput(k, "still-owned", ieInputOptions{})
		ieFrame(k, oar.TurnEnded{Outcome: outcome})
		fxMatch(t, observe.ViewOf(k.Records(), "").PendingInputs, `[{"state":"accepted","inputId":"still-owned"}]`, outcome.Kind)
	}
}

func TestInputDroppedExitDropsAcceptedAndUnanswered(t *testing.T) {
	k := ieStart()
	ieInput(k, "steer", ieInputOptions{})
	ieInput(k, "held", ieInputOptions{kind: oar.RequestQueue})
	unanswered := ieInput(k, "unanswered", ieInputOptions{unanswered: true})
	ieExit(k, 9, kernel.RecordAt{})
	k.Respond(unanswered.ID, oar.Accepted(), kernel.RecordAt{})
	view := observe.ViewOf(k.Records(), "")
	fxEqual(t, view.PendingInputs, `[]`)
	rows := [][]string{}
	for _, entry := range view.Conversation.Inputs.Values()[1:] {
		rows = append(rows, []string{entry.InputID, entry.State, entry.Reason})
	}
	fxEqual(t, rows, `[["steer","dropped","runtime_exited"],["held","dropped","runtime_exited"],["unanswered","dropped","runtime_exited"]]`)
}

func TestInputDroppedChildExitDoesNotDropRootInput(t *testing.T) {
	k := ieStart()
	ieInput(k, "root", ieInputOptions{})
	ieExit(k, 1, kernel.RecordAt{AgentPath: []string{"child"}})
	fxMatch(t, observe.ViewOf(k.Records(), "").PendingInputs, `[{"inputId":"root","state":"accepted"}]`)
}

func TestInputDroppedNoEchoStreamsHaveNothingWaiting(t *testing.T) {
	k := kernel.New("no-echo")
	ieInput(k, "steer", ieInputOptions{})
	ieExit(k, 1, kernel.RecordAt{})
	fxMatch(t, observe.ConversationOf(k.Records()).Inputs.Values()[0], `{"inputId":"steer","state":"accepted"}`)
}

func TestInputDroppedRetryClearsDropReason(t *testing.T) {
	k := ieStart()
	ieInput(k, "retry", ieInputOptions{})
	ieDropped(k, "retry")
	request := ieInput(k, "retry", ieInputOptions{unanswered: true})
	fxMatch(t, observe.ViewOf(k.Records(), "").PendingInputs, `[{"inputId":"retry","state":"pending"}]`)
	k.Respond(request.ID, oar.Rejected(oar.CodeNoActiveTurn, "idle"), kernel.RecordAt{})
	var retried *observe.ConversationInput
	for _, entry := range observe.ConversationOf(k.Records()).Inputs.Values() {
		if entry.InputID == "retry" {
			copied := entry
			retried = &copied
		}
	}
	fxMatch(t, retried, `{"state":"rejected","attempts":[{"state":"accepted"},{"state":"rejected"}]}`)
	if fxHas(t, retried, "reason") {
		t.Fatal("a retried input keeps no drop reason")
	}
}

func TestInputDroppedDistinctFromAcceptanceAndObservedInput(t *testing.T) {
	k := ieStart()
	ieInput(k, "read", ieInputOptions{})
	ieFrame(k, oar.UserMessage{InputID: "read", Input: "text read", Evidence: "turn_item"})
	ieInput(k, "unread", ieInputOptions{})
	ieDropped(k, "unread")
	rows := [][]string{}
	for _, entry := range observe.ConversationOf(k.Records()).Inputs.Values() {
		rows = append(rows, []string{entry.InputID, entry.State})
	}
	fxEqual(t, rows, `[["prompt","accepted"],["read","accepted"],["unread","dropped"]]`)
}

func TestInputDroppedRefusalUsesContractDetails(t *testing.T) {
	cases := []struct {
		failure oar.FailureClass
		message string
		want    string
	}{
		{"", "", `{"kind":"failed","failure":"unknown","reason":"runtime refused the input"}`},
		{oar.FailureInvalidRequest, "native refusal", `{"kind":"failed","failure":"invalid_request","reason":"native refusal"}`},
	}
	for _, c := range cases {
		k := kernel.New("root")
		request := ieInput(k, "owned", ieInputOptions{kind: oar.RequestPrompt})
		ieFrame(k, oar.InputDropped{InputID: "other", Reason: "runtime_refused", Failure: c.failure, Message: c.message})
		if got := observe.TurnEndAfter(k.Records(), request.Seq, "root", "owned"); got != nil {
			t.Fatalf("another input's refusal ended the turn: %+v", got)
		}
		ieFrame(k, oar.InputDropped{InputID: "owned", Reason: "runtime_refused", Failure: c.failure, Message: c.message})
		fxEqual(t, observe.TurnEndAfter(k.Records(), request.Seq, "root", "owned"), c.want)
		if got := observe.TurnEndAfter(k.Records(), request.Seq, "root", ""); got != nil {
			t.Fatalf("without the inputId the refusal is not a turn end: %+v", got)
		}
	}
}

// ─── tests/input-queued.test.ts ────────────────────────────────────────────

func iqFrame(k *kernel.Kernel, events ...oar.EventBody) oar.RawEvent {
	return k.Frame(oar.FrameBody{Type: "native", Native: json.RawMessage(`{}`), Events: events}, kernel.RecordAt{})
}

func iqPrompt(k *kernel.Kernel) oar.RawEvent {
	return k.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestPrompt, Input: "own", InputID: "own"}, kernel.RecordAt{})
}

func TestInputQueuedEvidenceSurvivesUnrelatedTurnsAndCheckpoint(t *testing.T) {
	k := kernel.New("root")
	request := iqPrompt(k)
	k.Respond(request.ID, oar.Accepted(), kernel.RecordAt{})
	queued := iqFrame(k, oar.InputQueued{InputID: "own"})
	beforeCheckpoint := observe.StatusOf(k.Records(), "root").Value
	serialized, err := json.Marshal(beforeCheckpoint)
	if err != nil {
		t.Fatal(err)
	}
	var checkpoint oar.AgentStatus
	if err := json.Unmarshal(serialized, &checkpoint); err != nil {
		t.Fatal(err)
	}
	fxEqual(t, checkpoint, string(serialized))
	fxMatch(t, checkpoint, `{"kind":"running","pendingPrompt":{"inputId":"own","requestId":"`+request.ID+`"}}`)
	iqFrame(k, oar.TurnActive{}, oar.TextDelta{Text: "notice"})
	iqFrame(k, oar.TurnEnded{Outcome: oar.Failed(oar.FailureUnknown, "notice failed")})
	fxMatch(t, observe.TurnEndAfter(k.Records(), request.Seq, "root", ""), `{"kind":"failed"}`)
	if got := observe.TurnEndAfter(k.Records(), queued.Seq, "root", "own"); got != nil {
		t.Fatalf("own turn not ended yet: %+v", got)
	}
	pending := []string{}
	for _, input := range observe.ViewOf(k.Records(), "").PendingInputs {
		pending = append(pending, input.InputID)
	}
	fxEqual(t, pending, `["own"]`)
	iqFrame(k, oar.TurnActive{InputID: "own"})
	iqFrame(k, oar.TextDelta{Text: "answer"})
	iqFrame(k, oar.TurnEnded{Outcome: oar.Completed()})
	fxEqual(t, observe.TurnEndAfter(k.Records(), queued.Seq, "root", "own"), `{"kind":"completed"}`)
	status := checkpoint
	for _, record := range k.Records() {
		if record.Seq > queued.Seq {
			status = observe.ReduceStatus(status, record, "root")
		}
	}
	fxEqual(t, status, fxShow(fxAny(t, observe.StatusOf(k.Records(), "root").Value)))
	fxMatch(t, observe.ConversationOf(k.Records()).Inputs.Values()[0], `{"state":"accepted","turn":{"state":"active"}}`)
	view := observe.ViewOf(k.Records(), "")
	fxEqual(t, ieKinds(view), `["turn","input","turn"]`)
	if view.Messages[0].OpenedBy != "" {
		t.Fatalf("the notification turn has no openedBy: %q", view.Messages[0].OpenedBy)
	}
	fxMatch(t, view.Messages[2], `{"openedBy":"`+request.ID+`"}`)
}

func TestInputQueuedChildQueueAndStartCannotChangeRootAttribution(t *testing.T) {
	k := kernel.New("root")
	request := iqPrompt(k)
	k.Respond(request.ID, oar.Accepted(), kernel.RecordAt{})
	iqFrame(k, oar.InputQueued{InputID: "own"})
	k.Frame(oar.FrameBody{Type: "child", Native: json.RawMessage(`{}`), Events: []oar.EventBody{oar.TurnActive{InputID: "own"}, oar.TurnEnded{Outcome: oar.Completed()}}}, kernel.RecordAt{AgentPath: []string{"child"}})
	fxMatch(t, observe.StatusOf(k.Records(), "root").Value, `{"kind":"running","pendingPrompt":{"inputId":"own"}}`)
	if got := observe.TurnEndAfter(k.Records(), request.Seq, "root", "own"); got != nil {
		t.Fatalf("turn end = %+v", got)
	}
	if n := len(observe.ViewOf(k.Records(), "").PendingInputs); n != 0 {
		t.Fatalf("pending = %d", n)
	}
}

func TestInputQueuedExitReleasesWaitBeforeNativeStart(t *testing.T) {
	for _, dispose := range []bool{false, true} {
		k := kernel.New("root")
		request := iqPrompt(k)
		iqFrame(k, oar.InputQueued{InputID: "own"})
		if dispose {
			k.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestDispose}, kernel.RecordAt{})
		}
		ieExit(k, 1, kernel.RecordAt{})
		want := `{"kind":"failed"}`
		if dispose {
			want = `{"kind":"aborted"}`
		}
		fxMatch(t, observe.TurnEndAfter(k.Records(), request.Seq, "root", "own"), want, "dispose=", dispose)
		if observe.StatusOf(k.Records(), "root").Value.PendingPrompt != nil {
			t.Errorf("dispose=%v: pendingPrompt survives exit", dispose)
		}
	}
}

func TestInputQueuedAbortBeforeQueueEvidenceStaysCorrelated(t *testing.T) {
	k := kernel.New("root")
	request := iqPrompt(k)
	abort := k.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestAbort}, kernel.RecordAt{})
	iqFrame(k, oar.InputQueued{InputID: "own"})
	k.Respond(abort.ID, oar.Accepted(), kernel.RecordAt{})
	ieExit(k, 1, kernel.RecordAt{})
	fxEqual(t, observe.TurnEndAfter(k.Records(), request.Seq, "root", "own"), `{"kind":"aborted"}`)
}

func TestInputQueuedResumedEchoRestoresWithoutRevivingQueue(t *testing.T) {
	k := kernel.New("root")
	request := iqPrompt(k)
	k.Respond(request.ID, oar.Accepted(), kernel.RecordAt{})
	iqFrame(k, oar.InputQueued{InputID: "own"})
	ieExit(k, 1, kernel.RecordAt{})
	view := observe.ViewOf(k.Records(), "first")
	if len(view.PendingInputs) != 0 {
		t.Fatalf("pending = %d", len(view.PendingInputs))
	}
	fxMatch(t, view.Conversation.Inputs.Values()[0], `{"state":"dropped","reason":"runtime_exited"}`)
	resumed := kernel.New("root")
	echo := iqFrame(resumed, oar.UserMessage{InputID: "own", Input: "own", Evidence: "acknowledged"})
	restored := observe.ReduceSessionView(view, echo, "resumed")
	if len(restored.PendingInputs) != 0 {
		t.Fatalf("restored pending = %d", len(restored.PendingInputs))
	}
	fxMatch(t, restored.Conversation.Inputs.Values()[0], `{"state":"accepted"}`)
	fxEqual(t, restored.Conversation, fxShow(fxAny(t, observe.ReduceConversation(view.Conversation, echo, "resumed"))))
}

// ─── tests/native-turn-active.test.ts (fold half) ──────────────────────────
//
// The TS test reads each runtime's native start through its projection
// (claude system/init, codex turn/started, pi agent_start); each yields one
// frame carrying a bare turn_active, which is what these fold checks use.

type ntaClock struct{ now int64 }

func (c *ntaClock) option() kernel.Option { return kernel.WithClock(func() int64 { return c.now }) }

func TestNativeTurnActiveAdoptsWithoutFabricatingRequest(t *testing.T) {
	for _, runtime := range []string{"claude", "codex", "pi"} {
		clock := &ntaClock{}
		k := kernel.New("root", clock.option())
		frame := k.Frame(oar.FrameBody{Type: runtime + "/start", Native: json.RawMessage(`{}`), Events: []oar.EventBody{oar.TurnActive{}}}, kernel.RecordAt{})
		kinds := []string{}
		for _, event := range observe.EventsOf(frame, nil) {
			kinds = append(kinds, event.Kind())
		}
		fxEqual(t, kinds, `["turn_active"]`, runtime)
		fxEqual(t, observe.StatusOf(k.Records(), "root").Value, `{"kind":"running","lastEventAt":0,"phase":"waiting_model","sinceSeq":0}`, runtime)
		for _, record := range k.Records() {
			if record.Kind != oar.KindFrame {
				t.Errorf("%s: a non-frame record was fabricated", runtime)
			}
		}
		if turns := ntaTurns(observe.ViewOf(k.Records(), "")); turns != 1 {
			t.Errorf("%s: turns = %d", runtime, turns)
		}
	}
}

func ntaTurns(view observe.SessionView) int {
	n := 0
	for _, message := range view.Messages {
		if message.Kind == "turn" {
			n++
		}
	}
	return n
}

func TestNativeTurnActivePreservesPromptPhaseAndSegment(t *testing.T) {
	for _, runtime := range []string{"claude", "codex", "pi"} {
		clock := &ntaClock{}
		k := kernel.New("root", clock.option())
		k.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestPrompt, Input: "go"}, kernel.RecordAt{ID: "prompt"})
		k.Frame(oar.FrameBody{Type: "tool", Native: json.RawMessage(`{}`), Events: []oar.EventBody{oar.ToolCallStarted{CallID: "call", Tool: "shell"}}}, kernel.RecordAt{})
		clock.now = 10
		k.Frame(oar.FrameBody{Type: runtime + "/start", Native: json.RawMessage(`{}`), Events: []oar.EventBody{oar.TurnActive{}}}, kernel.RecordAt{})
		fxEqual(t, observe.StatusOf(k.Records(), "root").Value, `{"kind":"running","lastEventAt":10,"phase":{"callId":"call","tool":"shell"},"requestId":"prompt","sinceSeq":0}`, runtime)
		if turns := ntaTurns(observe.ViewOf(k.Records(), "")); turns != 1 {
			t.Errorf("%s: turns = %d", runtime, turns)
		}
	}
}

// ─── tests/turn-active.test.ts ─────────────────────────────────────────────

func TestTurnActiveAdoptsAndRepeatedObservationsPreservePhase(t *testing.T) {
	k := kernel.New("conversation")
	active := k.Frame(oar.FrameBody{Type: "snapshot", Native: json.RawMessage(`{"run":{}}`), Events: []oar.EventBody{oar.TurnActive{}}}, kernel.RecordAt{})
	adopted := observe.ReduceStatus(observe.InitialStatus, active, "")
	fxMatch(t, adopted, `{"kind":"running","phase":"waiting_model","sinceSeq":0}`)
	if fxHas(t, adopted, "requestId") {
		t.Fatal("an adopted turn has no requestId")
	}
	k.Frame(oar.FrameBody{Type: "tool", Native: json.RawMessage(`{}`), Events: []oar.EventBody{oar.ToolCallStarted{CallID: "call", Tool: "read"}}}, kernel.RecordAt{})
	k.Frame(oar.FrameBody{Type: "snapshot", Native: json.RawMessage(`{}`), Events: []oar.EventBody{oar.TurnActive{}}}, kernel.RecordAt{})
	fxMatch(t, observe.StatusOf(k.Records(), "").Value, `{"kind":"running","phase":{"callId":"call","tool":"read"},"sinceSeq":0}`)
}

func TestTurnActivePromptAndNativeShareOneTurn(t *testing.T) {
	k := kernel.New("root")
	k.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestPrompt, Input: "hello"}, kernel.RecordAt{})
	k.Frame(oar.FrameBody{Type: "run_start", Native: json.RawMessage(`{}`), Events: []oar.EventBody{oar.TurnActive{}}}, kernel.RecordAt{})
	if turns := ntaTurns(observe.ViewOf(k.Records(), "")); turns != 1 {
		t.Fatalf("turns = %d", turns)
	}
	child := kernel.New("root")
	event := child.Frame(oar.FrameBody{Type: "run_start", Native: json.RawMessage(`{}`), Events: []oar.EventBody{oar.TurnActive{}}}, kernel.RecordAt{AgentPath: []string{"child"}})
	fxEqual(t, observe.ReduceStatus(observe.InitialStatus, event, "root"), fxShow(fxAny(t, observe.InitialStatus)))
}
