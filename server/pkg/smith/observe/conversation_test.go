package observe_test

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
	"vibevalley/pkg/smith/observe"
)

// tests/conversation.test.ts

const cvInputID = "11111111-2222-4333-8444-555555555555"

func cvEnvelope(seq int64) oar.Envelope {
	return oar.Envelope{SessionID: "native", AgentPath: []string{}, Seq: seq, ReceivedAt: 1}
}

func cvRequest(seq int64, id string, action oar.RequestKind, inputID string) oar.RawEvent {
	if action == "" {
		action = oar.RequestSteer
	}
	if inputID == "" {
		inputID = cvInputID
	}
	return oar.RawEvent{Envelope: cvEnvelope(seq), Kind: oar.KindRequest, ID: id, Direction: oar.ToRuntime,
		Request: oar.RequestBody{Kind: action, Input: "same text", InputID: inputID}}
}

func cvResponse(seq int64, requestID string, accepted bool) oar.RawEvent {
	body := oar.Accepted()
	if !accepted {
		body = oar.Rejected(oar.CodeNoActiveTurn, "not_steerable")
	}
	return oar.RawEvent{Envelope: cvEnvelope(seq), Kind: oar.KindResponse, RequestID: requestID, Response: body}
}

func cvFrame(seq int64, kind string, events ...oar.EventBody) oar.RawEvent {
	return oar.RawEvent{Envelope: cvEnvelope(seq), Kind: oar.KindFrame, Frame: oar.FrameBody{Type: kind, Native: json.RawMessage(`{}`), Events: events}}
}

func cvEcho(seq int64) oar.RawEvent {
	return cvFrame(seq, "native-user", oar.UserMessage{InputID: cvInputID, Input: "same text", NativeMessageID: "native-message", Evidence: "turn_item", TurnID: "turn-1"})
}

func cvFold(state observe.ConversationState, records ...oar.RawEvent) observe.ConversationState {
	for _, record := range records {
		state = observe.ReduceConversation(state, record, "")
	}
	return state
}

func TestConversationInputBeforeResponseFallbackAndEchoUpdateOneInput(t *testing.T) {
	first := observe.ReduceConversation(observe.InitialConversation(), cvRequest(0, "r1", "", ""), "")
	fxMatch(t, first.Updates, `[{"kind":"input","input":{"state":"pending","input":"same text"}}]`)
	state := cvFold(first, cvResponse(1, "r1", false), cvRequest(2, "r2", oar.RequestQueue, ""), cvResponse(3, "r2", true), cvEcho(4))
	if state.Inputs.Len() != 1 {
		t.Fatalf("inputs = %d", state.Inputs.Len())
	}
	fxMatch(t, state.Inputs.Values()[0], `{"state":"accepted","attempts":[{"state":"rejected"},{"state":"accepted"}],"observations":[{"evidence":"turn_item","turnId":"turn-1"}]}`)
	if len(state.Updates) != 1 {
		t.Fatalf("updates = %d", len(state.Updates))
	}
}

func TestConversationInputShowsItsImages(t *testing.T) {
	withImages := cvRequest(0, "r", oar.RequestPrompt, "")
	withImages.Request = oar.RequestBody{Kind: oar.RequestPrompt, Input: "what is this?", InputID: cvInputID, Images: []oar.InputImage{{Path: "/tmp/shot.png"}}}
	input := observe.ConversationOf([]oar.RawEvent{withImages, cvResponse(1, "r", true)}).Inputs.Values()[0]
	fxMatch(t, input, `{"input":"what is this?","images":[{"path":"/tmp/shot.png"}],"state":"accepted"}`)
	if fxHas(t, observe.ConversationOf([]oar.RawEvent{cvRequest(0, "r", "", "")}).Inputs.Values()[0], "images") {
		t.Fatal("an input without images has no images")
	}
}

func TestConversationEchoBeforeAcknowledgementIsNotAcceptance(t *testing.T) {
	state := observe.ConversationOf([]oar.RawEvent{cvRequest(0, "r", "", ""), cvEcho(1)})
	fxMatch(t, state.Inputs.Values()[0], `{"state":"pending","observations":[{"nativeMessageId":"native-message"}]}`)
	if got := observe.ReduceConversation(state, cvResponse(2, "r", true), "").Inputs.Values()[0].State; got != "accepted" {
		t.Fatalf("state = %s", got)
	}
}

func TestConversationIdenticalTextAndChildRequestsDoNotAlias(t *testing.T) {
	child := cvRequest(2, "r", "", "")
	child.AgentPath = []string{"child"}
	state := observe.ConversationOf([]oar.RawEvent{cvRequest(0, "r", "", ""), cvRequest(1, "r2", "", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"), child, cvResponse(3, "r", true)})
	var states []string
	for _, input := range state.Inputs.Values() {
		states = append(states, input.State)
	}
	fxEqual(t, states, `["accepted","pending","pending"]`)
}

func TestConversationResumeStreamScopedAndEchoDeduplicated(t *testing.T) {
	state := observe.ConversationOf([]oar.RawEvent{cvRequest(0, "r", "", ""), cvResponse(1, "r", true), cvEcho(2)})
	fxEqual(t, observe.ReduceConversation(state, cvEcho(2), "").Updates, `[]`)
	state = observe.ReduceConversation(state, cvEcho(0), "resumed")
	fxEqual(t, state.Updates, `[]`)
	state = observe.ReduceConversation(state, cvRequest(1, "r", "", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"), "resumed")
	state = observe.ReduceConversation(state, cvResponse(2, "r", false), "resumed")
	var states []string
	for _, input := range state.Inputs.Values() {
		states = append(states, input.State)
	}
	fxEqual(t, states, `["accepted","rejected"]`)
}

func TestConversationUnlinkedMessagesNeverGuessConsumption(t *testing.T) {
	unlinked := cvFrame(2, "message_start", oar.UserMessage{Evidence: "conversation", Input: "same text"})
	state := observe.ConversationOf([]oar.RawEvent{cvRequest(0, "r", "", ""), cvResponse(1, "r", true), unlinked})
	fxMatch(t, state.Updates, `[{"kind":"event","event":{"kind":"user_message"}}]`)
	state = observe.ReduceConversation(state, cvFrame(3, "done", oar.TurnEnded{Outcome: oar.Completed()}), "")
	fxMatch(t, state.Inputs.Values()[0], `{"state":"accepted","observations":[]}`)
}

func TestConversationLiveObserverFoldsPrefixAfterCursor(t *testing.T) {
	runtime := oartest.Runtime(oartest.Options{Turn: func(turn *oartest.Turn) error {
		turn.Say("echo:" + turn.Input)
		return nil
	}})
	session, err := runtime.Session(fxCtx(t), oar.AvailableInstallation{Via: "bundled"}, oar.SessionOptions{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = session.Dispose(fxCtx(t)) }()
	if _, err := session.Steer(fxCtx(t), "before", oar.InputOptions{}); err != nil {
		t.Fatal(err)
	}
	records := session.Records()
	var mu sync.Mutex
	var views []observe.ConversationState
	off := observe.ObserveConversation(session, func(state observe.ConversationState) {
		mu.Lock()
		views = append(views, state)
		mu.Unlock()
	}, &oar.Cursor{SessionID: session.ID(), AfterSeq: records[len(records)-1].Seq})
	defer off()
	mu.Lock()
	if len(views) != 0 {
		t.Fatalf("views before any new record: %d", len(views))
	}
	mu.Unlock()
	queued, err := session.Queue(fxCtx(t), "after", oar.InputOptions{})
	if err != nil {
		t.Fatal(err)
	}
	// Wait until the observer has seen the queue's response.
	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		seen := len(views) > 0 && views[len(views)-1].Cursors.Values()[0] >= queued.Response.Seq
		mu.Unlock()
		if seen || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	last := views[len(views)-1]
	mu.Unlock()
	upTo := []oar.RawEvent{}
	for _, record := range session.Records() {
		if record.Seq <= last.Cursors.Values()[0] {
			upTo = append(upTo, record)
		}
	}
	if last.Inputs.Len() != 2 {
		t.Fatalf("inputs = %d", last.Inputs.Len())
	}
	fxEqual(t, last.Inputs, fxShow(fxAny(t, observe.ConversationOf(upTo).Inputs)))
}

func TestConversationUnchangedRecordKeepsPreviousMaps(t *testing.T) {
	before := observe.ConversationOf([]oar.RawEvent{cvRequest(0, "r", "", ""), cvResponse(1, "r", true)})
	text := cvFrame(2, "assistant", oar.TextDelta{Text: "hello"})
	after := observe.ReduceConversation(before, text, "")
	fxMatch(t, after.Updates, `[{"kind":"event","event":{"kind":"text_delta"}}]`)
	if after.Inputs != before.Inputs || after.Requests != before.Requests || after.Drops != before.Drops || after.Actions != before.Actions {
		t.Fatal("a record that changes no input must keep the previous maps")
	}
	// A write copies: the previous state is never mutated.
	steered := observe.ReduceConversation(after, cvRequest(3, "r2", "", "22222222-2222-4333-8444-555555555555"), "")
	if steered.Inputs == after.Inputs || after.Inputs.Len() != 1 || steered.Inputs.Len() != 2 {
		t.Fatalf("copy on write: same=%v after=%d steered=%d", steered.Inputs == after.Inputs, after.Inputs.Len(), steered.Inputs.Len())
	}
}
