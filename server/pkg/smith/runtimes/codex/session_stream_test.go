package codex

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Ports tests/codex/codex-session-stream.test.ts.

const streamThread = "thread-123"

type scriptOptions struct {
	interruptFails, interruptHangs, interruptAckOnly bool
}

func notifyOn(fake *fakeProcess, method string, params jsonx.Record) {
	fake.emitJSON(jsonx.Record{"method": method, "params": params})
}

// scriptTurnStart: turn/start replies, starts turn-1, and (unless the prompt
// is "hold") streams a delta and completes; "ask" first sends a SERVER
// request (an approval).
func scriptTurnStart(fake *fakeProcess, params jsonx.Record) {
	input := jsonx.AsRecord(jsonx.AsList(params["input"])[0])["text"]
	notifyOn(fake, "turn/started", jsonx.Record{"threadId": streamThread, "turn": jsonx.Record{"id": "turn-1"}})
	if input == "ask" {
		fake.emitJSON(jsonx.Record{"id": "srv-7", "method": "item/commandExecution/requestApproval", "params": jsonx.Record{"threadId": streamThread, "turnId": "turn-1", "itemId": "exec-1"}})
	}
	if input != "hold" {
		notifyOn(fake, "item/agentMessage/delta", jsonx.Record{"threadId": streamThread, "turnId": "turn-1", "delta": "ok"})
		notifyOn(fake, "turn/completed", jsonx.Record{"threadId": streamThread, "turn": jsonx.Record{"id": "turn-1", "status": "completed"}})
	}
}

func replyFor(method string, params jsonx.Record, interruptFails bool) jsonx.Record {
	switch method {
	case "thread/start", "thread/resume":
		return jsonx.Record{"thread": jsonx.Record{"id": streamThread}, "model": "gpt-5.5"}
	case "turn/start":
		return jsonx.Record{"turn": jsonx.Record{"id": "turn-1"}}
	case "turn/interrupt":
		if interruptFails {
			return nil
		}
		return jsonx.Record{}
	case "turn/steer":
		return jsonx.Record{"turnId": params["expectedTurnId"]}
	case "thread/queue/add":
		return jsonx.Record{"submissionId": "sub-9"}
	}
	return jsonx.Record{}
}

func answerStream(fake *fakeProcess, id any, method string, params jsonx.Record, interruptFails bool) {
	result := replyFor(method, params, interruptFails)
	if result == nil {
		fake.emitJSON(jsonx.Record{"id": id, "error": jsonx.Record{"message": "turn already finished"}})
		return
	}
	fake.emitJSON(jsonx.Record{"id": id, "result": result})
	if method == "turn/start" {
		scriptTurnStart(fake, params)
	} else if method == "turn/interrupt" {
		notifyOn(fake, "turn/completed", jsonx.Record{"threadId": streamThread, "turn": jsonx.Record{"id": "turn-1", "status": "interrupted"}})
	}
}

// scriptedAppServer is a scripted app-server for the stream shape.
func scriptedAppServer(t *testing.T, options scriptOptions) *fakeProcess {
	fake := newFakeProcess(func(text string, fake *fakeProcess) {
		message := jsonx.ParseRecord([]byte(text))
		id, ok := message["id"].(float64)
		method, isString := message["method"].(string)
		if !ok || !isString {
			return
		}
		fake.mu.Lock()
		ended := fake.ended
		fake.mu.Unlock()
		if ended {
			return
		}
		if method == "turn/interrupt" && (options.interruptHangs || options.interruptAckOnly) {
			if options.interruptAckOnly {
				fake.emitJSON(jsonx.Record{"id": id, "result": jsonx.Record{}})
			}
			return
		}
		params := jsonx.AsRecord(message["params"])
		answerStream(fake, id, method, params, options.interruptFails)
	})
	useFakes(t, fake)
	return fake
}

func skeleton(records []oar.RawEvent) []string {
	lines := []string{}
	for _, record := range records {
		switch record.Kind {
		case oar.KindRequest:
			line := string(record.Direction) + " " + string(record.Request.Kind)
			if record.Request.Kind == oar.RequestNative {
				line += ":" + record.Request.Type
			}
			lines = append(lines, line)
		case oar.KindResponse:
			lines = append(lines, "response "+string(record.Response.Kind))
		case oar.KindFrame:
			line := "event " + record.Frame.Type
			if record.SpanID != "" {
				line += " span=" + record.SpanID
			}
			if len(record.Frame.Events) > 0 {
				line += " → " + strings.Join(kindsOf(record.Frame.Events), ",")
			}
			lines = append(lines, line)
		}
	}
	return lines
}

func awaitTurnEnd(t *testing.T, session oar.Session, seq int64) oar.TurnOutcome {
	t.Helper()
	outcome, err := observe.AwaitTurnEnd(testContext(t), session, seq, "")
	if err != nil {
		t.Fatal(err)
	}
	return outcome
}

func prompt(t *testing.T, session oar.Session, input string) oar.ControlOutcome {
	t.Helper()
	outcome, err := session.Prompt(testContext(t), input, oar.InputOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return outcome
}

func abort(t *testing.T, session oar.Session) oar.ControlOutcome {
	t.Helper()
	outcome, err := session.Abort(testContext(t))
	if err != nil {
		t.Fatal(err)
	}
	return outcome
}

func responseBody(outcome oar.ControlOutcome) oar.ResponseBody {
	return outcome.ControlResult.Response.Response
}

func TestAPromptIsOneRequestResponsePairTheTurnEndsOnCodexsOwnTurnCompleted(t *testing.T) {
	fake := scriptedAppServer(t, scriptOptions{})
	session := mustOpen(t, oar.SessionOptions{})
	result := prompt(t, session, "hi")
	sameJSON(t, responseBody(result), `{"kind":"accepted","native":{"turn":{"id":"turn-1"}}}`)
	sameJSON(t, awaitTurnEnd(t, session, result.Seq), `{"kind":"completed"}`)
	if model := session.Model().Value; model == nil || *model != "gpt-5.5" {
		t.Fatalf("model %v", model)
	}
	if err := session.Dispose(testContext(t)); err != nil {
		t.Fatal(err)
	}
	sameJSON(t, skeleton(session.Records()), `[
		"event thread/start → model", "toRuntime prompt", "response accepted",
		"event turn/started span=turn-1 → turn_active", "event item/agentMessage/delta span=turn-1 → text_delta",
		"event turn/completed span=turn-1 → turn_ended", "toRuntime dispose", "response exited"]`)
	if !fake.killed() {
		t.Fatal("not killed")
	}
}

func TestCodexEmitsAnEdgeOnceInAFreshStream(t *testing.T) {
	for _, resume := range []string{"", streamThread} {
		t.Run("resume="+resume, func(t *testing.T) {
			fake := scriptedAppServer(t, scriptOptions{})
			session := mustOpen(t, oar.SessionOptions{Resume: resume})
			sync := attachSync(fake)
			item := jsonx.Record{"type": "collabAgentToolCall", "id": "spawn", "senderThreadId": streamThread, "receiverThreadIds": []any{"child", "child", "other"}}
			from := len(session.Records())
			sync.notify(t, "item/started", jsonx.Record{"threadId": streamThread, "turnId": "t1", "item": item})
			sync.notify(t, "item/completed", jsonx.Record{"threadId": streamThread, "turnId": "t1", "item": item})
			waitItem := jsonx.Record{"type": "collabAgentToolCall", "id": "wait", "senderThreadId": streamThread, "receiverThreadIds": []any{"child", "child", "other"}}
			sync.notify(t, "item/started", jsonx.Record{"threadId": streamThread, "turnId": "t2", "item": waitItem})
			live := session.Records()[from:]
			sameJSON(t, eventsOfKind(recordEvents(live), "session_linked"), `[
				{"kind":"session_linked","parent":"thread-123","child":"child","via":"tool_call"},
				{"kind":"session_linked","parent":"thread-123","child":"other","via":"tool_call"}]`)
			bodies := []any{}
			for _, record := range live {
				bodies = append(bodies, record.Frame)
			}
			matchJSON(t, bodies, `[
				{"type":"item/started","native":{"item":`+jsonText(item)+`},"events":[{"kind":"session_linked"},{"kind":"session_linked"}]},
				{"type":"item/completed","native":{"item":`+jsonText(item)+`},"events":[]},
				{"type":"item/started","native":{"item":`+jsonText(waitItem)+`},"events":[]}]`)
			var replayed []oar.RawEvent
			session.RawEvents(func(record oar.RawEvent) { replayed = append(replayed, record) }, &oar.Cursor{SessionID: session.ID(), AfterSeq: -1})()
			sameJSON(t, replayed, jsonOf(t, session.Records()))
			sameJSON(t, observe.GraphOf(replayed), jsonOf(t, session.Graph()))
		})
	}
}

// bodiesOf runs several control calls concurrently and gives their response bodies, in call order.
func bodiesOf(t *testing.T, calls ...func() (oar.ControlOutcome, error)) []oar.ResponseBody {
	t.Helper()
	type result struct {
		outcome oar.ControlOutcome
		err     error
	}
	channels := make([]chan result, len(calls))
	for index, call := range calls {
		channels[index] = make(chan result, 1)
		go func(call func() (oar.ControlOutcome, error), out chan result) {
			outcome, err := call()
			out <- result{outcome, err}
		}(call, channels[index])
	}
	bodies := []oar.ResponseBody{}
	for _, channel := range channels {
		got := <-channel
		if got.err != nil {
			t.Fatal(got.err)
		}
		bodies = append(bodies, responseBody(got.outcome))
	}
	return bodies
}

func promptCall(t *testing.T, session oar.Session, input string) func() (oar.ControlOutcome, error) {
	return func() (oar.ControlOutcome, error) { return session.Prompt(testContext(t), input, oar.InputOptions{}) }
}

func steerCall(t *testing.T, session oar.Session, input string) func() (oar.ControlOutcome, error) {
	return func() (oar.ControlOutcome, error) {
		if !session.CanSteer() {
			t.Fatal("this session has no steer")
		}
		return session.Steer(testContext(t), input, oar.InputOptions{})
	}
}

func queueCall(t *testing.T, session oar.Session, input string) func() (oar.ControlOutcome, error) {
	return func() (oar.ControlOutcome, error) { return session.Queue(testContext(t), input, oar.InputOptions{}) }
}

func abortCall(t *testing.T, session oar.Session) func() (oar.ControlOutcome, error) {
	return func() (oar.ControlOutcome, error) { return session.Abort(testContext(t)) }
}

func TestBusyWhileATurnRunsSteerQueueAndAbortAnswerThroughTheRPCReplies(t *testing.T) {
	scriptedAppServer(t, scriptOptions{})
	session := mustOpen(t, oar.SessionOptions{})
	held := prompt(t, session, "hold")
	if held.Kind != oar.ResponseAccepted {
		t.Fatalf("held %+v", held)
	}
	// TS starts the four calls in one tick, so each one is decided in call
	// order; Go runs them one after another to keep that order.
	bodies := []oar.ResponseBody{}
	for _, call := range []func() (oar.ControlOutcome, error){promptCall(t, session, "again"), steerCall(t, session, "more"), queueCall(t, session, "later"), abortCall(t, session)} {
		bodies = append(bodies, bodiesOf(t, call)...)
	}
	sameJSON(t, bodies, `[
		{"kind":"rejected","code":"busy","reason":"busy"},
		{"kind":"accepted","native":{"turnId":"turn-1"}},
		{"kind":"accepted","native":{"submissionId":"sub-9"}},
		{"kind":"accepted","native":{}}]`)
	// The queue is codex's own (thread/queue/add): OAR offers no withdraw until thread/queue/delete is verified.
	if session.CanWithdraw() {
		t.Fatal("codex sessions have no withdraw")
	}
	sameJSON(t, awaitTurnEnd(t, session, held.Seq), `{"kind":"aborted"}`)
	var steerID string
	for _, record := range session.Records() {
		if record.Kind == oar.KindRequest && record.Request.Kind == oar.RequestSteer {
			steerID = record.Request.InputID
		}
	}
	sameJSON(t, eventsOfKind(recordEvents(session.Records()), "input_dropped"), `[{"kind":"input_dropped","inputId":"`+steerID+`","reason":"turn_interrupted"}]`)
	sameJSON(t, bodiesOf(t, abortCall(t, session), steerCall(t, session, "late")), `[
		{"kind":"rejected","code":"no_active_turn","reason":"no active turn"},
		{"kind":"rejected","code":"no_active_turn","reason":"not_steerable: no active turn"}]`)
	if err := session.Dispose(testContext(t)); err != nil {
		t.Fatal(err)
	}
	// dispose awaited the exit, so the stream holds an exited response and
	// the kernel's reachability answer reads that first.
	sameJSON(t, bodiesOf(t, promptCall(t, session, "dead")), `[{"kind":"rejected","code":"runtime_exited","reason":"runtime exited"}]`)
}

func shortenAbortFallback(t *testing.T, timeout time.Duration) {
	previous := abortFallbackTimeout
	abortFallbackTimeout = timeout
	t.Cleanup(func() { abortFallbackTimeout = previous })
}

func TestAnInterruptTheRuntimeRefusesIsARejectedAbortNotAnError(t *testing.T) {
	shortenAbortFallback(t, 100*time.Millisecond)
	fake := scriptedAppServer(t, scriptOptions{interruptFails: true})
	session := mustOpen(t, oar.SessionOptions{})
	prompt(t, session, "hold")
	aborted := abort(t, session)
	sameJSON(t, responseBody(aborted), `{"kind":"rejected","code":"runtime_refused","reason":"turn already finished"}`)
	time.Sleep(300 * time.Millisecond)
	if fake.killed() {
		t.Fatal("a refused interrupt kept its fallback")
	}
}

func TestDeliverPromptsWhenCodexRefusesItsSteerBecauseTheTurnEndedInFlight(t *testing.T) {
	// codex 0.158.0 answers turn/steer for a completed turn with an RPC
	// error, "no active turn to steer"; here the turn completes while the
	// steer is on the wire.
	fake := newFakeProcess(func(text string, fake *fakeProcess) {
		message := jsonx.ParseRecord([]byte(text))
		id, ok := message["id"].(float64)
		method, isString := message["method"].(string)
		if !ok || !isString {
			return
		}
		if method == "turn/steer" {
			notifyOn(fake, "turn/completed", jsonx.Record{"threadId": streamThread, "turn": jsonx.Record{"id": "turn-1", "status": "completed"}})
			fake.emitJSON(jsonx.Record{"id": id, "error": jsonx.Record{"message": "no active turn to steer"}})
			return
		}
		answerStream(fake, id, method, jsonx.AsRecord(message["params"]), false)
	})
	useFakes(t, fake)
	session := mustOpen(t, oar.SessionOptions{})
	prompt(t, session, "hold")
	delivered, err := session.Deliver(testContext(t), "report", oar.DeliverOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if delivered.Landed != "prompted" {
		t.Fatalf("landed %s", delivered.Landed)
	}
	attempts := []string{}
	for _, record := range session.Records() {
		if record.Kind == oar.KindRequest && record.Request.Input == "report" && (record.Request.Kind == oar.RequestSteer || record.Request.Kind == oar.RequestPrompt) {
			attempts = append(attempts, string(record.Request.Kind)+":"+record.Request.InputID)
		}
	}
	sameJSON(t, attempts, jsonText([]string{"steer:" + delivered.InputID, "prompt:" + delivered.InputID}))
}

func TestAServerInitiatedRequestIsRecordedVerbatimAsAToAppRequestAndLeftUnanswered(t *testing.T) {
	scriptedAppServer(t, scriptOptions{})
	session := mustOpen(t, oar.SessionOptions{})
	result := prompt(t, session, "ask")
	awaitTurnEnd(t, session, result.Seq)
	var toApp *oar.RawEvent
	for _, record := range session.Records() {
		if record.Kind == oar.KindRequest && record.Direction == oar.ToApp {
			copied := record
			toApp = &copied
		}
		if record.Kind == oar.KindResponse && record.RequestID == "srv-7" {
			t.Fatal("the server request was answered")
		}
	}
	if toApp == nil {
		t.Fatal("no toApp request")
	}
	matchJSON(t, toApp, `{"kind":"request","id":"srv-7","direction":"toApp","body":{"kind":"native","type":"item/commandExecution/requestApproval","native":{"threadId":"thread-123","turnId":"turn-1","itemId":"exec-1"}}}`)
}

func TestAnUnrequestedAppServerExitIsRecordedAsAnExitPointingAtNoRequest(t *testing.T) {
	fake := scriptedAppServer(t, scriptOptions{})
	session := mustOpen(t, oar.SessionOptions{})
	held := prompt(t, session, "hold")
	fake.end(intPtr(2), "")
	sameJSON(t, awaitTurnEnd(t, session, held.Seq), `{"kind":"failed","reason":"runtime exited","failure":"runtime_exited"}`)
	<-fake.exited
	records := session.Records()
	matchJSON(t, records[len(records)-1], `{"kind":"response","requestId":"","body":{"kind":"exited","code":2}}`)
	after := prompt(t, session, "after")
	sameJSON(t, responseBody(after), `{"kind":"rejected","code":"runtime_exited","reason":"runtime exited"}`)
}

func responsesFor(session oar.Session, requestID string) int {
	count := 0
	for _, record := range session.Records() {
		if record.Kind == oar.KindResponse && record.RequestID == requestID {
			count++
		}
	}
	return count
}

func TestAnInterruptPendingAtExitIsRuntimeExitedNotANativeRefusal(t *testing.T) {
	fake := scriptedAppServer(t, scriptOptions{interruptHangs: true})
	session := mustOpen(t, oar.SessionOptions{})
	started := prompt(t, session, "hold")
	sync := attachSync(fake)
	abort := make(chan oar.ControlOutcome, 1)
	go func() {
		outcome, _ := session.Abort(testContext(t))
		abort <- outcome
	}()
	eventually(t, "the interrupt", func() bool {
		for _, request := range fake.requests() {
			if request["method"] == "turn/interrupt" {
				return true
			}
		}
		return false
	})
	sync.wait(t)
	fake.end(intPtr(9), "")
	result := <-abort
	matchJSON(t, responseBody(result), `{"kind":"rejected","code":"runtime_exited"}`)
	<-fake.exited
	if count := responsesFor(session, result.RequestID); count != 1 {
		t.Fatalf("%d responses", count)
	}
	matchJSON(t, awaitTurnEnd(t, session, started.Seq), `{"failure":"runtime_exited"}`)
}

// The fallback deadline is shortened (TS: fake timers): 600 ms stands for 10 s.
func TestAStuckAbortedTurnIsKilledEvenWhenInterruptWasAcknowledged(t *testing.T) {
	for _, acknowledge := range []bool{false, true} {
		t.Run(fmt.Sprint(acknowledge), func(t *testing.T) {
			shortenAbortFallback(t, 600*time.Millisecond)
			fake := scriptedAppServer(t, scriptOptions{interruptHangs: !acknowledge, interruptAckOnly: acknowledge})
			session := mustOpen(t, oar.SessionOptions{})
			started := prompt(t, session, "hold")
			begun := time.Now()
			abort := make(chan oar.ControlOutcome, 1)
			go func() {
				outcome, _ := session.Abort(testContext(t))
				abort <- outcome
			}()
			time.Sleep(300 * time.Millisecond)
			repeated := make(chan struct{})
			go func() {
				_, _ = session.Abort(testContext(t))
				close(repeated)
			}()
			time.Sleep(time.Until(begun.Add(450 * time.Millisecond)))
			if fake.killed() {
				t.Fatal("killed before the first deadline")
			}
			eventually(t, "the kill", fake.killed)
			if elapsed := time.Since(begun); elapsed < 550*time.Millisecond {
				t.Fatalf("killed after %s", elapsed)
			}
			result := <-abort
			<-repeated
			matchJSON(t, responseBody(result), `{"kind":"accepted"}`)
			if count := responsesFor(session, result.RequestID); count != 1 {
				t.Fatalf("%d responses", count)
			}
			<-fake.exited
			exited := false
			for _, record := range session.Records() {
				exited = exited || (record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseExited)
			}
			if !exited {
				t.Fatal("no exit recorded")
			}
			sameJSON(t, awaitTurnEnd(t, session, started.Seq), `{"kind":"aborted"}`)
		})
	}
}

func TestACompletedTurnCancelsTheAbortDeadlineBeforeAnotherTurnStarts(t *testing.T) {
	shortenAbortFallback(t, 200*time.Millisecond)
	fake := scriptedAppServer(t, scriptOptions{interruptAckOnly: true})
	session := mustOpen(t, oar.SessionOptions{})
	sync := attachSync(fake)
	prompt(t, session, "hold")
	abort(t, session)
	sync.notify(t, "turn/completed", jsonx.Record{"threadId": streamThread, "turn": jsonx.Record{"id": "turn-1", "status": "interrupted"}})
	prompt(t, session, "hold")
	time.Sleep(500 * time.Millisecond)
	if fake.killed() {
		t.Fatal("a cleared deadline killed the app-server")
	}
}

func TestNativeActivityAdoptsATurnWhileChildActivityDoesNotStartTheRoot(t *testing.T) {
	fake := scriptedAppServer(t, scriptOptions{})
	session := mustOpen(t, oar.SessionOptions{})
	sync := attachSync(fake)
	sync.notify(t, "turn/started", jsonx.Record{"threadId": "child", "turn": jsonx.Record{"id": "child-turn"}})
	sameJSON(t, session.Status().Value, `{"kind":"idle"}`)
	sync.notify(t, "turn/started", jsonx.Record{"threadId": streamThread, "turn": jsonx.Record{"id": "native-turn"}})
	records := session.Records()
	last := records[len(records)-1]
	sameJSON(t, session.Status().Value, fmt.Sprintf(`{"kind":"running","phase":"waiting_model","sinceSeq":%d,"lastEventAt":%d}`, last.Seq, last.ReceivedAt))
	for _, record := range records {
		if record.Kind == oar.KindRequest {
			t.Fatal("a native turn fabricated a request")
		}
	}
	turns := 0
	for _, message := range observe.ViewOf(records, session.ID()).Messages {
		if message.Kind == "turn" {
			turns++
		}
	}
	if turns != 1 {
		t.Fatalf("%d turns", turns)
	}
	sync.notify(t, "turn/completed", jsonx.Record{"threadId": streamThread, "turn": jsonx.Record{"id": "native-turn", "status": "completed"}})
	sameJSON(t, session.Status().Value, `{"kind":"idle","lastTurnOutcome":{"kind":"completed"}}`)
}

func TestCollaborationPutsLineageOnItsSourceFrameAndUsageReplaysWithoutTheLiveGraph(t *testing.T) {
	fake := scriptedAppServer(t, scriptOptions{})
	session := mustOpen(t, oar.SessionOptions{})
	sync := attachSync(fake)
	graphs := make(chan oar.SessionGraph, 4)
	session.RawEvents(func(record oar.RawEvent) {
		if record.Kind == oar.KindFrame && len(eventsOfKind(record.Frame.Events, "session_linked")) > 0 {
			graphs <- session.Graph()
		}
	}, nil)
	sync.notify(t, "thread/tokenUsage/updated", jsonx.Record{"threadId": streamThread, "tokenUsage": jsonx.Record{"total": jsonx.Record{"inputTokens": 10, "outputTokens": 1}}})
	sync.notify(t, "thread/tokenUsage/updated", jsonx.Record{"threadId": "child", "tokenUsage": jsonx.Record{"total": jsonx.Record{"inputTokens": 20, "outputTokens": 2}}})
	sync.notify(t, "item/started", jsonx.Record{"threadId": streamThread, "turnId": "turn-1", "item": jsonx.Record{"type": "collabAgentToolCall", "id": "spawn", "senderThreadId": streamThread, "receiverThreadIds": []any{"child"}}})
	records := session.Records()
	matchJSON(t, records[len(records)-1], `{"kind":"frame","body":{"type":"item/started","events":[{"kind":"session_linked","parent":"thread-123","child":"child","via":"tool_call"}]}}`)
	// Replaying the records a host persists is the assertion under test.
	var persisted []oar.RawEvent
	if err := json.Unmarshal([]byte(jsonOf(t, records)), &persisted); err != nil {
		t.Fatal(err)
	}
	select {
	case graph := <-graphs:
		sameJSON(t, graph, jsonOf(t, observe.GraphOf(persisted)))
	case <-time.After(5 * time.Second):
		t.Fatal("no linked frame observed")
	}
	sameJSON(t, session.Graph(), jsonOf(t, observe.GraphOf(persisted)))
	sameJSON(t, session.Usage().Value.WithChildren, `{"input":30,"output":3}`)
	sameJSON(t, observe.UsageOf(persisted, session.ID(), nil), jsonOf(t, session.Usage()))
	sameJSON(t, observe.ViewOf(persisted, "").Usage, jsonOf(t, session.Usage().Value))
}
