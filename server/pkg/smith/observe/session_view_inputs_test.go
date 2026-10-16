package observe_test

import (
	"fmt"
	"strings"
	"testing"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Ports of tests/session-view-inputs.test.ts and tests/session-view-withdraw.test.ts:
// where an input enters the session view (#82) and where a withdrawn one leaves it.

// svRetry is another attempt at input `of` (same inputId), as deliver and steerOrQueue retry.
func svRetry(seq int64, id string, kind oar.RequestKind, of string) oar.RawEvent {
	return svRequestIn(svS1, seq, id, oar.ToRuntime, svInput(kind, of))
}

// svEcho is a native echo of input id (codex userMessage item, claude replay).
func svEcho(seq int64, id string) oar.RawEvent {
	return svFrame(seq, oar.UserMessage{Input: "input " + id, InputID: "input-" + id, NativeMessageID: "native-" + id, Evidence: "turn_item"})
}

func svWithdraw(seq int64, id, input string) oar.RawEvent {
	return svRequestIn(svS1, seq, id, oar.ToRuntime, oar.RequestBody{Kind: oar.RequestWithdraw, InputID: "input-" + input})
}

func svNotQueued(seq int64, requestID string) oar.RawEvent {
	return svResponseIn(svS1, seq, requestID, oar.Rejected(oar.CodeNotQueued, "no held input with this inputId is waiting"))
}

// svOutline is one line per message (markOpen: the open segment is marked), then the pending tray.
func svOutline(view observe.SessionView, markOpen, pendingState bool) []string {
	lines := []string{}
	for index, message := range view.Messages {
		switch message.Kind {
		case "input":
			lines = append(lines, fmt.Sprintf("input %s (%s)", message.Input.Input, message.Input.State))
		case "turn":
			parts := []string{}
			for _, section := range message.Sections {
				for _, part := range section.Parts {
					if part.Kind == "text" {
						parts = append(parts, part.Text)
					} else {
						parts = append(parts, part.Kind)
					}
				}
			}
			line := "turn [" + strings.Join(parts, " | ") + "]"
			if message.Outcome != nil {
				line += " " + message.Outcome.Kind
			}
			if markOpen && index == view.OpenTurn {
				line += " open"
			}
			lines = append(lines, line)
		case "notice":
			lines = append(lines, "notice "+message.Notice.Cause)
		}
	}
	pending := []string{}
	for _, input := range view.PendingInputs {
		if pendingState {
			pending = append(pending, fmt.Sprintf("%s (%s)", input.Input, input.State))
		} else {
			pending = append(pending, input.Input)
		}
	}
	return append(lines, "pending ["+strings.Join(pending, ", ")+"]")
}

func svInputsOutline(view observe.SessionView) []string { return svOutline(view, false, false) }

func svCat(records []oar.RawEvent, more ...oar.RawEvent) []oar.RawEvent {
	return append(append([]oar.RawEvent{}, records...), more...)
}

func TestSessionViewInputsSteerWaitsOnAnEchoingStream(t *testing.T) {
	records := []oar.RawEvent{
		svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"), svEcho(2, "r1"), svText(3, "working"),
		svReq(4, "s1", oar.RequestSteer), svAccepted(5, "s1"), svText(6, " still on it"),
	}
	before := svFold(records...)
	svStrings(t, "before", svInputsOutline(before), []string{"input input r1 (accepted)", "turn [working still on it]", "pending [input s1]"})
	if before.OpenTurn != 1 {
		t.Errorf("openTurn = %d", before.OpenTurn)
	}
	view := svFold(svCat(records, svEcho(7, "s1"), svText(8, "got s1"), svEnded(9))...)
	svStrings(t, "after", svInputsOutline(view), []string{
		"input input r1 (accepted)", "turn [working still on it]", "input input s1 (accepted)", "turn [got s1] completed", "pending []",
	})
}

func TestSessionViewInputsSteerEntersAtItsRequestWithoutEchoes(t *testing.T) {
	// pi echoes without an inputId; grok and kimi do not echo at all.
	unlinked := svFrame(2, oar.UserMessage{Input: "input r1", Evidence: "conversation"})
	view := svFold(svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"), unlinked, svText(3, "before"),
		svReq(4, "s1", oar.RequestSteer), svAccepted(5, "s1"), svText(6, "after"), svEnded(7))
	svStrings(t, "outline", svInputsOutline(view), []string{
		"input input r1 (accepted)", "turn [before]", "input input s1 (accepted)", "turn [after] completed", "pending []",
	})
}

func TestSessionViewInputsUnreadSteerStaysPendingUntilItsLateEcho(t *testing.T) {
	records := []oar.RawEvent{
		svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"), svEcho(2, "r1"), svText(3, "done"),
		svReq(4, "s1", oar.RequestSteer), svAccepted(5, "s1"), svEnded(6),
	}
	unread := svFold(records...)
	svStrings(t, "unread", svInputsOutline(unread), []string{"input input r1 (accepted)", "turn [done] completed", "pending [input s1]"})
	for _, message := range unread.Messages {
		if message.Kind == "input" && message.Input.Input == "input s1" {
			t.Error("s1 is already in messages")
		}
	}
	later := svFold(svCat(records, svReq(7, "r2", oar.RequestPrompt), svAccepted(8, "r2"), svEcho(9, "r2"), svText(10, "on r2"),
		svEcho(11, "s1"), svText(12, "and s1"), svEnded(13))...)
	svStrings(t, "later", svInputsOutline(later), []string{
		"input input r1 (accepted)", "turn [done] completed", "input input r2 (accepted)", "turn [on r2]",
		"input input s1 (accepted)", "turn [and s1] completed", "pending []",
	})
}

func TestSessionViewInputsQueuedInputWaitsForTheTurnThatTakesIt(t *testing.T) {
	view := svFold(
		svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"), svEcho(2, "r1"), svText(3, "first"),
		svReq(4, "q1", oar.RequestQueue), svAccepted(5, "q1"), svText(6, " still first"), svEnded(7),
		// The runtime drains its queue into a turn of its own: no prompt request.
		svEcho(8, "q1"), svText(9, "on q1"), svEnded(10),
	)
	svStrings(t, "outline", svInputsOutline(view), []string{
		"input input r1 (accepted)", "turn [first still first] completed", "input input q1 (accepted)", "turn [on q1] completed", "pending []",
	})
	if opened := svTurns(view)[1].OpenedBy; opened != "" {
		t.Errorf("openedBy = %q", opened)
	}
}

func TestSessionViewInputsRefusedSteerRetriedAsQueueRejoinsTheTurn(t *testing.T) {
	records := []oar.RawEvent{
		svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"), svEcho(2, "r1"), svText(3, "working"),
		svReq(4, "s1", oar.RequestSteer), svRejected(5, "s1"),
	}
	svStrings(t, "refused", svInputsOutline(svFold(records...)), []string{
		"input input r1 (accepted)", "turn [working]", "input input s1 (rejected)", "pending []",
	})
	// steerOrQueue: the same input id, now queued.
	view := svFold(svCat(records, svRetry(6, "q1", oar.RequestQueue, "s1"), svAccepted(7, "q1"), svText(8, " more"), svEnded(9))...)
	svStrings(t, "retried", svInputsOutline(view), []string{"input input r1 (accepted)", "turn [working more] completed", "pending [input s1]"})
}

func TestSessionViewInputsBusyPromptRetriedAsSteerWaitsForItsEcho(t *testing.T) {
	view := svFold(
		svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"), svEcho(2, "r1"), svText(3, "working"),
		svReq(4, "r2", oar.RequestPrompt), svRejected(5, "r2"),
		svRetry(6, "s2", oar.RequestSteer, "r2"), svAccepted(7, "s2"), svText(8, " more"),
		svEcho(9, "r2"), svText(10, "got r2"),
	)
	svStrings(t, "outline", svInputsOutline(view), []string{
		"input input r1 (accepted)", "turn [working more]", "input input r2 (accepted)", "turn [got r2]", "pending []",
	})
}

func TestSessionViewInputsExitDropsPendingInputAndAResumedEchoRestoresIt(t *testing.T) {
	exit := svResponseIn(svS1, 6, "", oar.ExitedBody(nil))
	view := observe.InitialSessionView()
	for _, record := range []oar.RawEvent{svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"), svEcho(2, "r1"), svText(3, "working"),
		svReq(4, "s1", oar.RequestSteer), svAccepted(5, "s1"), exit} {
		view = observe.ReduceSessionView(view, record, "a")
	}
	svEq(t, "pending", view.PendingInputs, `[]`)
	found := false
	for _, message := range view.Messages {
		if message.Kind == "input" && message.Input.InputID == "input-s1" {
			found = true
			svMatch(t, "dropped", message, `{"input":{"state":"dropped","reason":"runtime_exited"}}`)
		}
	}
	if !found {
		t.Fatal("s1 is not in messages")
	}
	for _, record := range []oar.RawEvent{svEcho(0, "s1"), svText(1, "resumed on s1"), svEnded(2)} {
		view = observe.ReduceSessionView(view, record, "b")
	}
	svStrings(t, "outline", svInputsOutline(view), []string{
		"input input r1 (accepted)", "turn [working] failed", "input input s1 (accepted)", "notice exited", "turn [resumed on s1] completed", "pending []",
	})
	var restored *observe.ConversationInput
	for _, input := range view.Conversation.Inputs.Values() {
		if input.InputID == "input-s1" {
			copied := input
			restored = &copied
		}
	}
	if restored == nil {
		t.Fatal("no restored input")
	}
	if len(restored.Observations) != 1 {
		t.Errorf("observations = %d", len(restored.Observations))
	}
	if svHas(restored, "reason") {
		t.Error("restored input keeps a reason")
	}
}

func TestSessionViewInputsRecordsFoldedTwiceChangeNothing(t *testing.T) {
	records := []oar.RawEvent{
		svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"), svEcho(2, "r1"), svText(3, "working"),
		svReq(4, "s1", oar.RequestSteer), svAccepted(5, "s1"), svEcho(6, "s1"),
		svReq(7, "s2", oar.RequestSteer), svAccepted(8, "s2"), svEnded(9),
	}
	once := observe.ViewOf(records, "")
	twice := observe.ViewOf(svCat(records, records...), "")
	svSame(t, "messages", twice.Messages, once.Messages)
	svSame(t, "pendingInputs", twice.PendingInputs, once.PendingInputs)
	svSame(t, "status", twice.Status, once.Status)
	svStrings(t, "outline", svInputsOutline(once), []string{
		"input input r1 (accepted)", "turn [working]", "input input s1 (accepted)", "turn [] completed", "pending [input s2]",
	})
}

// ─── tests/session-view-withdraw.test.ts ──────────────────────────────────

func svWithdrawOutline(view observe.SessionView) []string { return svOutline(view, true, true) }

// codex and claude echo input ids: a queued input waits in the tray until the runtime takes it.
func svEchoing() []oar.RawEvent {
	return []oar.RawEvent{svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"), svEcho(2, "r1"), svText(3, "working"), svReq(4, "q1", oar.RequestQueue), svAccepted(5, "q1")}
}

// pi, grok and kimi never echo an input id: a queued input enters messages at its request.
func svSilent() []oar.RawEvent {
	return []oar.RawEvent{svReq(0, "r1", oar.RequestPrompt), svAccepted(1, "r1"), svText(2, "working"), svReq(3, "q1", oar.RequestQueue), svAccepted(4, "q1")}
}

func TestSessionViewWithdrawOnAnEchoingStreamLeavesOnlyTheTray(t *testing.T) {
	svStrings(t, "before", svWithdrawOutline(observe.ViewOf(svEchoing(), "")), []string{"input input r1 (accepted)", "turn [working] open", "pending [input q1 (accepted)]"})
	view := observe.ViewOf(svCat(svEchoing(), svWithdraw(6, "w1", "q1"), svAccepted(7, "w1"), svText(8, " more"), svEnded(9)), "")
	svStrings(t, "after", svWithdrawOutline(view), []string{"input input r1 (accepted)", "turn [working more] completed", "pending []"})
	states := []string{}
	for _, input := range view.Conversation.Inputs.Values() {
		states = append(states, input.State)
	}
	svStrings(t, "states", states, []string{"accepted", "withdrawn"})
}

func TestSessionViewWithdrawRefusedNotQueuedLeavesTheInput(t *testing.T) {
	view := observe.ViewOf(svCat(svEchoing(), svWithdraw(6, "w1", "q1"), svNotQueued(7, "w1")), "")
	svStrings(t, "outline", svWithdrawOutline(view), []string{"input input r1 (accepted)", "turn [working] open", "pending [input q1 (accepted)]"})
}

func TestSessionViewWithdrawThenRequeueWaitsAgain(t *testing.T) {
	view := observe.ViewOf(svCat(svEchoing(), svWithdraw(6, "w1", "q1"), svAccepted(7, "w1"), svRetry(8, "q2", oar.RequestQueue, "q1"), svAccepted(9, "q2")), "")
	svStrings(t, "outline", svWithdrawOutline(view), []string{"input input r1 (accepted)", "turn [working] open", "pending [input q1 (accepted)]"})
}

func TestSessionViewWithdrawOnASilentStreamKeepsTheSealedSegment(t *testing.T) {
	placed := observe.ViewOf(svCat(svSilent(), svText(5, "more")), "")
	svStrings(t, "placed", svWithdrawOutline(placed), []string{
		"input input r1 (accepted)", "turn [working]", "input input q1 (accepted)", "turn [more] open", "pending []",
	})
	view := observe.ViewOf(svCat(svSilent(), svText(5, "more"), svWithdraw(6, "w1", "q1"), svAccepted(7, "w1"), svText(8, " and done"), svEnded(9)), "")
	svStrings(t, "withdrawn", svWithdrawOutline(view), []string{"input input r1 (accepted)", "turn [working]", "turn [more and done] completed", "pending []"})
}

func TestSessionViewWithdrawRightAfterItsRequestDoesNotReopen(t *testing.T) {
	view := observe.ViewOf(svCat(svSilent(), svWithdraw(5, "w1", "q1"), svAccepted(6, "w1")), "")
	svStrings(t, "outline", svWithdrawOutline(view), []string{"input input r1 (accepted)", "turn [working]", "pending []"})
	if view.OpenTurn != -1 {
		t.Errorf("openTurn = %d", view.OpenTurn)
	}
	continued := observe.ViewOf(svCat(svSilent(), svWithdraw(5, "w1", "q1"), svAccepted(6, "w1"), svText(7, "more"), svEnded(8)), "")
	svStrings(t, "continued", svWithdrawOutline(continued), []string{"input input r1 (accepted)", "turn [working]", "turn [more] completed", "pending []"})
}

func TestSessionViewWithdrawOfAnUnknownInputIsANoticeWhenRefused(t *testing.T) {
	view := observe.ViewOf(svCat(svSilent(), svWithdraw(5, "w1", "never"), svNotQueued(6, "w1")), "")
	svStrings(t, "outline", svWithdrawOutline(view), []string{
		"input input r1 (accepted)", "turn [working]", "input input q1 (accepted)", "notice control_rejected", "pending []",
	})
}
