package acp_test

// Ported from tests/acp/acp-session.test.ts.

import (
	"context"
	"encoding/json"
	"testing"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

func sendNow(profile *acp.Profile) {
	profile.SteerSupersedesPrompt = true
	profile.SteerParams = func(string) jsonx.Record { return jsonx.Record{"_meta": map[string]any{"sendNow": true}} }
}

func mustSteer(t *testing.T, session oar.Session, input string, options oar.InputOptions) oar.ControlOutcome {
	t.Helper()
	if !session.CanSteer() {
		t.Fatal("this session has no steer")
	}
	outcome, err := session.Steer(context.Background(), input, options)
	if err != nil {
		t.Fatal(err)
	}
	return outcome
}

func TestSessionRecordsEveryUpdateVerbatimAndThePromptAnswerAsTheTurnEnd(t *testing.T) {
	session := start(t, nil)
	run := promptAndWait(t, session, "tool", observe.PromptRunOptions{})
	if run.Kind != "ended" {
		t.Fatalf("run %s", run.Kind)
	}
	jsonEqual(t, run.Outcome, map[string]any{"kind": "completed"})
	equalStrings(t, tail(session, run.Result.Request.Seq-1), []string{
		"request prompt",
		"response accepted",
		"event agent_thought_chunk → reasoning",
		"event tool_call → tool_call_started:Read",
		"event tool_call_update",
		"event tool_call_update → tool_call_ended",
		"event agent_message_chunk → text:tool-done",
		"event usage_update → usage",
		"event session/prompt → turn_ended:completed",
	})
	var toolEnded *oar.RawEvent
	for _, record := range session.Records() {
		for _, event := range record.Frame.Events {
			if _, ok := event.(oar.ToolCallEnded); ok && record.Kind == oar.KindFrame {
				copied := record
				toolEnded = &copied
			}
		}
	}
	if toolEnded == nil {
		t.Fatal("no tool_call_ended")
	}
	jsonEqual(t, toolEnded.Frame.Events, json.RawMessage(`[{"kind":"tool_call_ended","callId":"call-read","content":[{"type":"other","value":{"content":"fixture-value"}}],"result":"ok"}]`))
	// native is the whole notification, untouched
	jsonEqual(t, toolEnded.Frame.Native, json.RawMessage(`{"sessionId":"fake-session","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-read","status":"completed","rawOutput":{"content":"fixture-value"}}}`))
	jsonEqual(t, session.ContextUsage().Value, map[string]any{"tokens": 500, "contextWindow": 2000, "percent": 25})
	if err := session.Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
	records := session.Records()
	equalStrings(t, describeAll(records[len(records)-2:]), []string{"request dispose", "response exited"})
}

func TestSessionHandshakeAnswersAreEvents(t *testing.T) {
	session := start(t, nil)
	opening := describeAll(session.Records())
	equalStrings(t, opening[:3], []string{"event initialize", "event authenticate", "event session/new → model:fixture-model-x, effort:medium"})
	if model := session.Model().Value; model == nil || *model != "fixture-model-x" {
		t.Fatalf("model %v", model)
	}
	if effort := session.Effort().Value; effort == nil || *effort != "medium" {
		t.Fatalf("effort %v", effort)
	}
}

func prompt(t *testing.T, session oar.Session, input string, options oar.InputOptions) oar.ControlOutcome {
	t.Helper()
	outcome, err := session.Prompt(context.Background(), input, options)
	if err != nil {
		t.Fatal(err)
	}
	return outcome
}

func queue(t *testing.T, session oar.Session, input string, options oar.InputOptions) oar.ControlOutcome {
	t.Helper()
	outcome, err := session.Queue(context.Background(), input, options)
	if err != nil {
		t.Fatal(err)
	}
	return outcome
}

func abort(t *testing.T, session oar.Session) oar.ControlOutcome {
	t.Helper()
	outcome, err := session.Abort(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return outcome
}

func TestSessionRejectsASecondPromptBusyAndDrainsItsQueueAsASpontaneousTurn(t *testing.T) {
	session := start(t, nil)
	first := prompt(t, session, "hold", oar.InputOptions{})
	if first.Response.Response.Kind != oar.ResponseAccepted {
		t.Fatalf("first %v", first.Response.Response)
	}
	second := prompt(t, session, "must-be-busy", oar.InputOptions{})
	jsonEqual(t, second.Response.Response, map[string]any{"kind": "rejected", "code": "busy", "reason": "busy"})
	if session.Capabilities().QueueDurable {
		t.Fatal("queue must not be durable")
	}
	if queued := queue(t, session, "queued", oar.InputOptions{}); queued.Response.Response.Kind != oar.ResponseAccepted {
		t.Fatal("queue refused")
	}
	if aborted := abort(t, session); aborted.Response.Response.Kind != oar.ResponseAccepted {
		t.Fatal("abort refused")
	}
	jsonEqual(t, awaitTurnEnd(t, session, first.Request.Seq), map[string]any{"kind": "aborted"})
	// The queued input runs as its own turn: it has an end but no prompt request of its own.
	var endedSeq int64 = -1
	for _, record := range session.Records() {
		for _, event := range record.Frame.Events {
			if ended, ok := event.(oar.TurnEnded); ok && ended.Outcome.Kind == "aborted" && endedSeq < 0 {
				endedSeq = record.Seq
			}
		}
	}
	if endedSeq < 0 {
		t.Fatal("no aborted turn end")
	}
	jsonEqual(t, awaitTurnEnd(t, session, endedSeq), map[string]any{"kind": "completed"})
	prompts := 0
	for _, record := range session.Records() {
		if record.Kind == oar.KindRequest && record.Request.Kind == oar.RequestPrompt {
			prompts++
		}
	}
	if prompts != 2 {
		t.Fatalf("only the two explicit prompts are prompt requests, got %d", prompts)
	}
	if !contains(said(session), "echo:queued") {
		t.Fatalf("said %q", said(session))
	}
	late := abort(t, session)
	jsonEqual(t, late.Response.Response, map[string]any{"kind": "rejected", "code": "no_active_turn", "reason": "no active turn"})
}

func TestSessionNativeSteerFoldsBothPromptAnswersIntoOneTurn(t *testing.T) {
	session := start(t, sendNow)
	base := prompt(t, session, "steer-base", oar.InputOptions{})
	steered := mustSteer(t, session, "steer-new", oar.InputOptions{})
	if steered.Response.Response.Kind != oar.ResponseAccepted {
		t.Fatalf("steer %v", steered.Response.Response)
	}
	jsonEqual(t, awaitTurnEnd(t, session, base.Request.Seq), map[string]any{"kind": "completed"})
	var answers [][]string
	for _, record := range session.Records() {
		if record.Kind == oar.KindFrame && record.Frame.Type == "session/prompt" {
			kinds := []string{}
			for _, event := range record.Frame.Events {
				kinds = append(kinds, event.EventKind())
			}
			answers = append(answers, kinds)
		}
	}
	jsonEqual(t, answers, [][]string{{}, {"turn_ended"}}, "each prompt RPC answer is its own event")
	if !contains(said(session), "steer:steer-new") {
		t.Fatalf("said %q", said(session))
	}
}

func TestSessionWithoutInjectionHasNoSteerAndSteerOrQueueAndDeliverQueue(t *testing.T) {
	session := start(t, nil)
	if session.CanSteer() {
		t.Fatal("the session has no steer member")
	}
	held := prompt(t, session, "hold", oar.InputOptions{})
	steerOrQueue, err := session.SteerOrQueue(context.Background(), "later", oar.InputOptions{})
	if err != nil {
		t.Fatal(err)
	}
	delivered, err := session.Deliver(context.Background(), "now", oar.DeliverOptions{})
	if err != nil {
		t.Fatal(err)
	}
	equalStrings(t, []string{steerOrQueue.Landed, delivered.Landed}, []string{"queued", "queued"})
	for _, record := range session.Records() {
		if record.Kind == oar.KindRequest && record.Request.Kind == oar.RequestSteer {
			t.Fatal("nothing was steered")
		}
	}
	abort(t, session)
	jsonEqual(t, awaitTurnEnd(t, session, held.Request.Seq), map[string]any{"kind": "aborted"})
}

func TestSessionSteerWithNothingActiveIsRejected(t *testing.T) {
	session := start(t, sendNow)
	idle := mustSteer(t, session, "nothing active", oar.InputOptions{})
	jsonEqual(t, idle.Response.Response, map[string]any{"kind": "rejected", "code": "no_active_turn", "reason": "not_steerable: no active turn"})
}

func TestSessionRecordsReversePermissionRequestsWithTheYoloAnswer(t *testing.T) {
	session := start(t, nil)
	run := promptAndWait(t, session, "permission", observe.PromptRunOptions{})
	if run.Kind != "ended" {
		t.Fatalf("run %s", run.Kind)
	}
	equalStrings(t, tail(session, run.Result.Request.Seq-1), []string{
		"request prompt",
		"response accepted",
		"toApp session/request_permission",
		"response answered",
		"event agent_message_chunk → text:permission:always",
		"event session/prompt → turn_ended:completed",
	})
	var answered, asked *oar.RawEvent
	for _, record := range session.Records() {
		record := record
		if record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseAnswered && answered == nil {
			answered = &record
		}
		if record.Kind == oar.KindRequest && record.Direction == oar.ToApp && asked == nil {
			asked = &record
		}
	}
	jsonEqual(t, answered.Response.Native, map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": "always"}})
	if asked.ID != answered.RequestID {
		t.Fatal("the answer points at the runtime's request")
	}
}

func TestSessionPromptErrorsAreTheRuntimesWordAndAnExitIsOars(t *testing.T) {
	authSession := start(t, nil)
	auth := promptAndWait(t, authSession, "fail", observe.PromptRunOptions{})
	if auth.Kind != "ended" {
		t.Fatalf("run %s", auth.Kind)
	}
	jsonEqual(t, auth.Outcome, map[string]any{"failure": "auth", "kind": "failed", "reason": "Authentication required"})
	found := false
	for _, frame := range frames(authSession) {
		found = found || frame.Type == "session/prompt/error"
	}
	if !found {
		t.Fatal("no session/prompt/error frame")
	}

	exitSession := start(t, nil)
	exited := promptAndWait(t, exitSession, "exit", observe.PromptRunOptions{})
	if exited.Kind != "ended" {
		t.Fatalf("run %s", exited.Kind)
	}
	jsonEqual(t, exited.Outcome, map[string]any{"failure": "runtime_exited", "kind": "failed", "reason": "runtime exited"})
	var exit *oar.RawEvent
	for _, record := range exitSession.Records() {
		record := record
		if record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseExited {
			exit = &record
		}
	}
	if exit == nil || exit.Response.ExitCode == nil || *exit.Response.ExitCode != 9 {
		t.Fatalf("exit %+v", exit)
	}
	if exit.RequestID != "" {
		t.Fatal("an unrequested exit points at no request")
	}
	afterDeath := prompt(t, exitSession, "after death", oar.InputOptions{})
	jsonEqual(t, afterDeath.Response.Response, map[string]any{"kind": "rejected", "code": "runtime_exited", "reason": "runtime exited"}, "the kernel decides from the exited response")
}

func TestSessionResumeKeepsTheNativeIDAndRemainsUsable(t *testing.T) {
	first := start(t, nil)
	sessionID := first.ID()
	if err := first.Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
	resumed := startSession(t, baseProfile(), startOptions{resume: sessionID})
	if resumed.ID() != sessionID || resumed.Records()[0].SessionID != sessionID {
		t.Fatalf("resumed %s", resumed.ID())
	}
	run := promptAndWait(t, resumed, "after-resume", observe.PromptRunOptions{})
	if run.Kind != "ended" || run.Outcome.Kind != "completed" {
		t.Fatalf("run %+v", run)
	}
	if err := resumed.Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := resumed.Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func graphNodes(session oar.Session) []string {
	out := []string{}
	for _, node := range session.Graph().Nodes {
		out = append(out, node.ID)
	}
	return out
}

func TestSessionForeignSessionIDIsADerivedChild(t *testing.T) {
	session := start(t, nil)
	if run := promptAndWait(t, session, "spawn-child", observe.PromptRunOptions{}); run.Kind != "ended" {
		t.Fatal(run.Kind)
	}
	var child *oar.RawEvent
	for _, record := range session.Records() {
		record := record
		if record.SessionID == "fake-child" && child == nil {
			child = &record
		}
	}
	if child == nil || child.Kind != oar.KindFrame {
		t.Fatal("no child frame")
	}
	jsonEqual(t, child.Frame.Events, []any{map[string]any{"kind": "text_delta", "text": "child-says-hi"}})
	jsonEqual(t, child.AgentPath, []string{})
	equalStrings(t, graphNodes(session), []string{"fake-session", "fake-child"})
	// Not subscribed to the vendor lifecycle method: no edge can be claimed.
	jsonEqual(t, session.Graph().Edges, []any{})
}

func TestSessionSubscribedExtensionIsRecordedVerbatimAndLinksTheGraph(t *testing.T) {
	session := start(t, func(profile *acp.Profile) {
		profile.ExtensionNotifications = []string{"_x.ai/session_notification"}
	})
	if run := promptAndWait(t, session, "spawn-child", observe.PromptRunOptions{}); run.Kind != "ended" {
		t.Fatal(run.Kind)
	}
	var lifecycle *oar.FrameBody
	for _, frame := range frames(session) {
		frame := frame
		if frame.Type == "_x.ai/session_notification" && lifecycle == nil {
			lifecycle = &frame
		}
	}
	if lifecycle == nil {
		t.Fatal("no lifecycle frame")
	}
	jsonEqual(t, lifecycle.Native, map[string]any{"parentSessionId": "fake-session", "sessionId": "fake-child", "kind": "spawned"})
	jsonEqual(t, lifecycle.Events, []any{map[string]any{"kind": "session_linked", "parent": "fake-session", "child": "fake-child", "via": "tool_call"}})
	jsonEqual(t, session.Graph().Edges, []any{map[string]any{"parent": "fake-session", "child": "fake-child", "via": "tool_call"}})
}
