package codex

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Ports tests/codex/codex-pre-open.test.ts, codex-session-effort.test.ts,
// codex-session-resume-model.test.ts, codex-service-tier.test.ts (its
// session parts), codex-session-name.test.ts, codex-output-schema.test.ts,
// codex-session-mcp-servers.test.ts (its session parts),
// codex-open-errors.test.ts, codex-missing-resume.test.ts,
// codex-exit-diagnostics.test.ts and codex-startup-diagnostics.test.ts.
//
// Not ported: assertions on the error's structured `cause` where the
// error is plain (smith/GAPS.md, "Errors are strings"); the typed errors'
// Method and Native are asserted.

const preThread = "thread-pre"

func describeRecord(record oar.RawEvent) string {
	switch record.Kind {
	case oar.KindFrame:
		return "event " + record.Frame.Type
	case oar.KindRequest:
		if record.Request.Kind == oar.RequestNative {
			return string(record.Direction) + " " + record.Request.Type
		}
		return string(record.Direction) + " " + string(record.Request.Kind)
	case oar.KindResponse:
		if record.Response.Kind == oar.ResponseExited {
			code := "null"
			if record.Response.ExitCode != nil {
				code = fmt.Sprint(*record.Response.ExitCode)
			}
			return "response exited code=" + code + " for=" + jsonText(record.RequestID)
		}
		return "response " + string(record.Response.Kind)
	}
	return "?"
}

func describeRecords(records []oar.RawEvent) []string {
	described := []string{}
	for _, record := range records {
		described = append(described, describeRecord(record))
	}
	return described
}

func preOpenServer(t *testing.T, afterInitialize func(fake *fakeProcess, id any)) *fakeProcess {
	fake := newFakeProcess(func(text string, fake *fakeProcess) {
		message := jsonx.ParseRecord([]byte(text))
		id, ok := message["id"].(float64)
		if !ok {
			return
		}
		switch message["method"] {
		case "initialize":
			afterInitialize(fake, id)
		case "thread/start":
			fake.emitJSON(jsonx.Record{"id": id, "result": jsonx.Record{"thread": jsonx.Record{"id": preThread}, "model": "gpt-5.5"}})
		}
	})
	useFakes(t, fake)
	return fake
}

// The app-server talks before the thread exists: on 0.144.6 an unsolicited
// notification followed the initialize reply. Those frames are the runtime's
// words too, so the client holds them until the adapter's handler exists and
// the stream records them first, in arrival order, ahead of the open event.
func TestNotificationsAndServerRequestsSentBeforeThreadStartAreRecordedFirstInOrder(t *testing.T) {
	preOpenServer(t, func(fake *fakeProcess, id any) {
		fake.emitJSON(jsonx.Record{"id": id, "result": jsonx.Record{}})
		fake.emitJSON(jsonx.Record{"method": "remoteControl/status/changed", "params": jsonx.Record{"status": "off"}})
		fake.emitJSON(jsonx.Record{"id": "srv-1", "method": "account/login/required", "params": jsonx.Record{}})
	})
	session := mustOpen(t, oar.SessionOptions{})
	sameJSON(t, describeRecords(session.Records()[:3]), `["event remoteControl/status/changed","toApp account/login/required","event thread/start"]`)
}

func TestAServerRequestBeforeANotificationKeepsItsWireOrderAheadOfTheOpenEvent(t *testing.T) {
	preOpenServer(t, func(fake *fakeProcess, id any) {
		fake.emitJSON(jsonx.Record{"id": id, "result": jsonx.Record{}})
		fake.emitJSON(jsonx.Record{"id": "srv-1", "method": "account/login/required", "params": jsonx.Record{}})
		fake.emitJSON(jsonx.Record{"method": "remoteControl/status/changed", "params": jsonx.Record{"status": "off"}})
	})
	session := mustOpen(t, oar.SessionOptions{})
	sameJSON(t, describeRecords(session.Records()[:3]), `["toApp account/login/required","event remoteControl/status/changed","event thread/start"]`)
}

// The thread/start reply and thread/started often share one stdout chunk.
// The open event is marked at the reply's wire position, so the frame codex
// wrote right after the reply lands after the open event.
func TestTheOpenEventPrecedesAThreadStartedWrittenInTheSameChunkAsTheReply(t *testing.T) {
	fake := newFakeProcess(func(text string, fake *fakeProcess) {
		message := jsonx.ParseRecord([]byte(text))
		id, ok := message["id"].(float64)
		if !ok {
			return
		}
		switch message["method"] {
		case "initialize":
			fake.emitJSON(jsonx.Record{"id": id, "result": jsonx.Record{}})
		case "thread/start":
			fake.emit(jsonText(jsonx.Record{"id": id, "result": jsonx.Record{"thread": jsonx.Record{"id": preThread}, "model": "gpt-5.5"}}) + "\n" +
				jsonText(jsonx.Record{"method": "thread/started", "params": jsonx.Record{"thread": jsonx.Record{"id": preThread}}}) + "\n" +
				jsonText(jsonx.Record{"method": "thread/status/changed", "params": jsonx.Record{"threadId": preThread, "status": jsonx.Record{"type": "idle"}}}) + "\n")
		}
	})
	useFakes(t, fake)
	session := mustOpen(t, oar.SessionOptions{})
	attachSync(fake).wait(t)
	sameJSON(t, describeRecords(session.Records()[:3]), `["event thread/start","event thread/started","event thread/status/changed"]`)
}

func TestControlAfterTheAppServerDiedOnItsOwnIsRejectedAndALaterDisposeIsAnswered(t *testing.T) {
	fake := rpcServer(func(method string, _ jsonx.Record, _ *fakeProcess) jsonx.Record {
		if method == "initialize" {
			return jsonx.Record{"result": jsonx.Record{}}
		}
		return jsonx.Record{"result": jsonx.Record{"thread": jsonx.Record{"id": preThread}, "model": "gpt-5.5"}}
	})
	useFakes(t, fake)
	session := mustOpen(t, oar.SessionOptions{})
	fake.end(intPtr(137), "")
	<-fake.exited
	records := session.Records()
	sameJSON(t, describeRecords(records[len(records)-1:]), `["response exited code=137 for=\"\""]`)
	after := prompt(t, session, "hello?")
	sameJSON(t, responseBody(after), `{"kind":"rejected","code":"runtime_exited","reason":"runtime exited"}`)
	if err := session.Dispose(testContext(t)); err != nil {
		t.Fatal(err)
	}
	records = session.Records()
	sameJSON(t, describeRecords(records[len(records)-2:]), `["toRuntime dispose","response accepted"]`)
}

// ─── codex-session-effort.test.ts ───────────────────────────────────────────

const effortThread = "thread-123"

// effortServer is an app-server shaped after 0.155.1: the open replies
// report openEffort's answer as `reasoningEffort` (absent: the field is
// absent); thread/settings/update is answered `{}`, then
// thread/settings/updated with the pushed effort (or an RPC error).
type effortScript struct {
	openEffort func(params jsonx.Record) (any, bool)
	// The effort codex pushes, or an error; nil pushes the requested effort.
	settingsUpdate func(effort any) (pushed any, failure string)
}

func effortServer(t *testing.T, script effortScript) *fakeProcess {
	fake := rpcServer(func(method string, params jsonx.Record, fake *fakeProcess) jsonx.Record {
		if method == "thread/settings/update" {
			pushed, failure := params["effort"], ""
			if script.settingsUpdate != nil {
				pushed, failure = script.settingsUpdate(params["effort"])
			}
			if failure != "" {
				return jsonx.Record{"error": jsonx.Record{"code": -32_600, "message": failure}}
			}
			go func() {
				// After the reply, as codex pushes it.
				time.Sleep(time.Millisecond)
				notifyOn(fake, "thread/settings/updated", jsonx.Record{"threadId": effortThread, "threadSettings": jsonx.Record{"model": "gpt-5.5", "effort": pushed}})
			}()
			return jsonx.Record{"result": jsonx.Record{}}
		}
		if method == "initialize" {
			return jsonx.Record{"result": jsonx.Record{}}
		}
		opened := jsonx.Record{"thread": jsonx.Record{"id": effortThread}, "model": "gpt-5.5", "modelProvider": "openai"}
		if effort, present := script.openEffort(params); present {
			opened["reasoningEffort"] = effort
		}
		return jsonx.Record{"result": opened}
	})
	useFakes(t, fake)
	return fake
}

func reports(effort any) func(jsonx.Record) (any, bool) {
	return func(jsonx.Record) (any, bool) { return effort, true }
}

func echoedEffort(params jsonx.Record) (any, bool) {
	effort, present := jsonx.AsRecord(params["config"])["model_reasoning_effort"]
	if !present {
		return nil, true
	}
	return effort, true
}

func requestOf(fake *fakeProcess, method string) jsonx.Record {
	for _, request := range fake.requests() {
		if request["method"] == method {
			return request
		}
	}
	return nil
}

func methodsOf(fake *fakeProcess) []string {
	methods := []string{}
	for _, request := range fake.requests() {
		methods = append(methods, fmt.Sprint(request["method"]))
	}
	return methods
}

func TestANewThreadTakesEffortAsItsConfigOverrideAndTheOpenReplyIsReadBack(t *testing.T) {
	fake := effortServer(t, effortScript{openEffort: echoedEffort})
	started := mustOpen(t, oar.SessionOptions{Effort: "low"})
	matchJSON(t, requestOf(fake, "thread/start")["params"], `{"config":{"model_reasoning_effort":"low"}}`)
	if requestOf(fake, "thread/settings/update") != nil {
		t.Fatal("a new thread sent thread/settings/update")
	}
	if effort := started.Effort().Value; effort == nil || *effort != "low" {
		t.Fatalf("effort %v", effort)
	}
	matchJSON(t, started.Records()[0], `{"body":{"type":"thread/start","events":[{"kind":"model","model":"gpt-5.5"},{"kind":"effort","effort":"low"}]}}`)
}

// A config override on thread/resume would rebuild the thread's settings
// from config.toml, so a resume sets the level on the loaded thread.
func TestAResumeSetsAnotherLevelWithThreadSettingsUpdateNeverAConfigOverride(t *testing.T) {
	fake := effortServer(t, effortScript{openEffort: reports("low")})
	resumed := mustOpen(t, oar.SessionOptions{Resume: effortThread, Effort: "high"})
	if _, ok := jsonx.AsRecord(requestOf(fake, "thread/resume")["params"])["config"]; ok {
		t.Fatal("thread/resume carries a config")
	}
	updates := []any{}
	for _, request := range fake.requests() {
		if request["method"] == "thread/settings/update" {
			updates = append(updates, request["params"])
		}
	}
	sameJSON(t, updates, `[{"threadId":"thread-123","effort":"high"}]`)
	if effort := resumed.Effort().Value; effort == nil || *effort != "high" {
		t.Fatalf("effort %v", effort)
	}
	frames := []any{}
	for _, record := range resumed.Records() {
		if record.Kind == oar.KindFrame {
			frames = append(frames, []any{record.Frame.Type, record.Frame.Events})
		}
	}
	sameJSON(t, frames, `[
		["thread/resume",[{"kind":"model","model":"gpt-5.5"},{"kind":"effort","effort":"low"}]],
		["thread/settings/updated",[{"kind":"model","model":"gpt-5.5"},{"kind":"effort","effort":"high"}]]]`)
}

func TestAResumeAlreadyRunningTheRequestedLevelAsksNothingMore(t *testing.T) {
	fake := effortServer(t, effortScript{openEffort: reports("high")})
	resumed := mustOpen(t, oar.SessionOptions{Resume: effortThread, Effort: "high"})
	sameJSON(t, methodsOf(fake), `["initialize","thread/resume"]`)
	if effort := resumed.Effort().Value; effort == nil || *effort != "high" {
		t.Fatalf("effort %v", effort)
	}
}

// codex persists the level with the thread: a resume that asks for none
// runs the level the thread last ran with, and says so.
func TestWithoutAnEffortNothingExtraIsSentAndEffortIsWhateverCodexReports(t *testing.T) {
	fake := effortServer(t, effortScript{openEffort: reports("high")})
	resumed := mustOpen(t, oar.SessionOptions{Resume: effortThread})
	if _, ok := jsonx.AsRecord(requestOf(fake, "thread/resume")["params"])["config"]; ok {
		t.Fatal("thread/resume carries a config")
	}
	if effort := resumed.Effort().Value; effort == nil || *effort != "high" {
		t.Fatalf("effort %v", effort)
	}
	effortServer(t, effortScript{openEffort: reports(nil)})
	fresh := mustOpen(t, oar.SessionOptions{})
	if effort := fresh.Effort().Value; effort != nil {
		t.Fatalf("effort %v", *effort)
	}
}

func TestTheOpenIsRefusedAndTheAppServerStoppedWhenEffortIsNotConfirmed(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		script  effortScript
		resume  string
		message string
	}{
		{"thread/start keeps another level", effortScript{openEffort: reports("medium")}, "", "codex thread/start kept effort medium although effort low was requested"},
		{"thread/start reports no explicit level", effortScript{openEffort: reports(nil)}, "", "codex thread/start kept effort none (the model's default) although effort low was requested"},
		{"the reply has no reasoningEffort at all", effortScript{openEffort: func(jsonx.Record) (any, bool) { return nil, false }}, "", "codex thread/start reports no reasoningEffort although effort low was requested"},
		{"codex refuses the settings update", effortScript{openEffort: reports("medium"), settingsUpdate: func(any) (any, string) { return nil, "thread not loaded" }}, effortThread, "codex thread/settings/update effort=low failed: thread not loaded"},
		{"codex pushes another level", effortScript{openEffort: reports("medium"), settingsUpdate: func(any) (any, string) { return "medium", "" }}, effortThread, "codex thread/settings/update left effort medium although low was requested"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			fake := effortServer(t, testCase.script)
			_, err := openSession(t, oar.SessionOptions{Effort: "low", Resume: testCase.resume})
			if err == nil || !strings.Contains(err.Error(), testCase.message) {
				t.Fatalf("err %v", err)
			}
			if !fake.killed() {
				t.Fatal("app-server not stopped")
			}
		})
	}
}

func TestAResumeWithoutCodexsSettingsReportIsRefusedAtItsDeadline(t *testing.T) {
	previous := settingsReportTimeout
	settingsReportTimeout = 100 * time.Millisecond
	t.Cleanup(func() { settingsReportTimeout = previous })
	fake := rpcServer(func(method string, _ jsonx.Record, _ *fakeProcess) jsonx.Record {
		switch method {
		case "initialize", "thread/settings/update":
			return jsonx.Record{"result": jsonx.Record{}}
		}
		return jsonx.Record{"result": jsonx.Record{"thread": jsonx.Record{"id": effortThread}, "model": "gpt-5.5", "reasoningEffort": "medium"}}
	})
	useFakes(t, fake)
	_, err := openSession(t, oar.SessionOptions{Effort: "low", Resume: effortThread})
	if err == nil || err.Error() != "codex reported no thread/settings/updated within 100 ms, so effort low cannot be confirmed" {
		t.Fatalf("err %v", err)
	}
	if !fake.killed() {
		t.Fatal("app-server not stopped")
	}
}

// ─── codex-session-resume-model.test.ts ─────────────────────────────────────

func modelServer(t *testing.T, activeModel func(params jsonx.Record) string) *fakeProcess {
	fake := rpcServer(func(method string, params jsonx.Record, _ *fakeProcess) jsonx.Record {
		if method == "initialize" {
			return jsonx.Record{"result": jsonx.Record{}}
		}
		return jsonx.Record{"result": jsonx.Record{"thread": jsonx.Record{"id": effortThread}, "model": activeModel(params), "modelProvider": "openai"}}
	})
	useFakes(t, fake)
	return fake
}

func TestThreadResumeCarriesTheRequestedModelAndTheSessionResumesTheSameID(t *testing.T) {
	fake := modelServer(t, func(params jsonx.Record) string { return fmt.Sprint(params["model"]) })
	session := mustOpen(t, oar.SessionOptions{Resume: effortThread, Model: "gpt-5.5"})
	if session.ID() != effortThread {
		t.Fatalf("id %s", session.ID())
	}
	matchJSON(t, requestOf(fake, "thread/resume")["params"], `{"threadId":"thread-123","cwd":"/work","model":"gpt-5.5","approvalPolicy":"never"}`)
	if err := session.Dispose(testContext(t)); err != nil {
		t.Fatal(err)
	}
	if !fake.killed() {
		t.Fatal("not killed")
	}
}

func TestThreadResumeWithoutAModelDoesNotSendOne(t *testing.T) {
	fake := modelServer(t, func(jsonx.Record) string { return "whatever-was-saved" })
	mustOpen(t, oar.SessionOptions{Resume: effortThread})
	if _, ok := jsonx.AsRecord(requestOf(fake, "thread/resume")["params"])["model"]; ok {
		t.Fatal("a model was sent")
	}
}

// The runtime accepts the request but keeps the old model: ours must reject.
func TestResumeThatSilentlyKeepsTheOldModelIsRejected(t *testing.T) {
	fake := modelServer(t, func(jsonx.Record) string { return "gpt-5.4-mini" })
	_, err := openSession(t, oar.SessionOptions{Resume: effortThread, Model: "gpt-5.5"})
	if err == nil || !strings.Contains(err.Error(), "codex thread/resume kept model gpt-5.4-mini although gpt-5.5 was requested") {
		t.Fatalf("err %v", err)
	}
	if !fake.killed() {
		t.Fatal("not killed")
	}
}

func TestThreadStartThatReportsADifferentModelIsRejectedToo(t *testing.T) {
	modelServer(t, func(jsonx.Record) string { return "gpt-5.4-mini" })
	_, err := openSession(t, oar.SessionOptions{Model: "gpt-5.5"})
	if err == nil || !strings.Contains(err.Error(), "codex thread/start kept model gpt-5.4-mini although gpt-5.5 was requested") {
		t.Fatalf("err %v", err)
	}
}

func TestSessionModelReadsBackTheModelTheAppServerAnsweredWith(t *testing.T) {
	modelServer(t, func(jsonx.Record) string { return "gpt-5.4-mini" })
	resumed := mustOpen(t, oar.SessionOptions{Resume: effortThread})
	if model := resumed.Model().Value; model == nil || *model != "gpt-5.4-mini" {
		t.Fatalf("model %v", model)
	}
	modelServer(t, func(jsonx.Record) string { return "gpt-5.5" })
	started := mustOpen(t, oar.SessionOptions{Model: "gpt-5.5"})
	if model := started.Model().Value; model == nil || *model != "gpt-5.5" {
		t.Fatalf("model %v", model)
	}
}

func TestSessionModelIsNullWhenTheAppServerAnswerCarriesNoModel(t *testing.T) {
	useFakes(t, rpcServer(func(method string, _ jsonx.Record, _ *fakeProcess) jsonx.Record {
		if method == "initialize" {
			return jsonx.Record{"result": jsonx.Record{}}
		}
		return jsonx.Record{"result": jsonx.Record{"thread": jsonx.Record{"id": effortThread}}}
	}))
	session := mustOpen(t, oar.SessionOptions{})
	if model := session.Model().Value; model != nil {
		t.Fatalf("model %s", *model)
	}
}

// A refused resume names the method, and the app-server started for it does not outlive the failure.
func TestAThreadResumeTheAppServerRefusesRejectsNamingThreadResumeAndKillsTheChild(t *testing.T) {
	fake := rpcServer(func(method string, _ jsonx.Record, _ *fakeProcess) jsonx.Record {
		if method == "initialize" {
			return jsonx.Record{"result": jsonx.Record{}}
		}
		return jsonx.Record{"error": jsonx.Record{"message": "no rollout found for thread id thread-123"}}
	})
	useFakes(t, fake)
	_, err := openSession(t, oar.SessionOptions{Resume: effortThread})
	if err == nil || !strings.Contains(err.Error(), "codex thread/resume failed: no rollout found for thread id thread-123") {
		t.Fatalf("err %v", err)
	}
	if !fake.killed() {
		t.Fatal("not killed")
	}
}

func usageRecord(input, output int) jsonx.Record {
	return jsonx.Record{"total": jsonx.Record{"inputTokens": input, "outputTokens": output}}
}

// resumedThread is an app-server resuming a thread that ran one turn before
// (thread total 1000 / 5): right after the reply it re-reports that total
// under the old turn's id (rereport false: as before 0.151.0, it does not),
// and a prompt's turn adds 1200 / 7.
func resumedThread(t *testing.T, rereport bool) {
	useFakes(t, rpcServer(func(method string, _ jsonx.Record, fake *fakeProcess) jsonx.Record {
		emit := func(notifications ...jsonx.Record) {
			for _, notification := range notifications {
				params := jsonx.AsRecord(notification["params"])
				params["threadId"] = effortThread
				fake.emitJSON(notification)
			}
		}
		switch method {
		case "initialize":
			return jsonx.Record{"result": jsonx.Record{}}
		case "thread/resume":
			fake.emitJSON(jsonx.Record{"id": float64(2), "result": jsonx.Record{"thread": jsonx.Record{"id": effortThread}, "model": "gpt-5.5"}})
			if rereport {
				emit(jsonx.Record{"method": "thread/tokenUsage/updated", "params": jsonx.Record{"turnId": "turn-1", "tokenUsage": usageRecord(1000, 5)}})
			}
			return nil
		case "turn/start":
			id := float64(len(fake.requests()))
			fake.emitJSON(jsonx.Record{"id": id, "result": jsonx.Record{"turn": jsonx.Record{"id": "turn-2"}}})
			emit(
				jsonx.Record{"method": "turn/started", "params": jsonx.Record{"turn": jsonx.Record{"id": "turn-2"}}},
				jsonx.Record{"method": "thread/tokenUsage/updated", "params": jsonx.Record{"turnId": "turn-2", "tokenUsage": usageRecord(2200, 12)}},
				jsonx.Record{"method": "turn/completed", "params": jsonx.Record{"turn": jsonx.Record{"id": "turn-2", "status": "completed"}}},
			)
			return nil
		}
		return nil
	}))
}

func promptAndWait(t *testing.T, session oar.Session, input string) observe.PromptRun {
	t.Helper()
	run, err := observe.PromptAndWait(testContext(t), session, input, observe.PromptRunOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return run
}

// #169: usage() is THIS Session's, so a resumed Session subtracts the total
// codex re-reported before its first turn.
func TestAResumedSessionsUsageCountsFromWhenItOpened(t *testing.T) {
	resumedThread(t, true)
	session := mustOpen(t, oar.SessionOptions{Resume: effortThread})
	promptAndWait(t, session, "again")
	sameJSON(t, session.Usage().Value, `{"total":{"input":1200,"output":7}}`)
}

// Without the re-report this Session's share is unknown: no total.
func TestAResumedSessionWithoutCodexsReReportHasNoUsageTotal(t *testing.T) {
	resumedThread(t, false)
	session := mustOpen(t, oar.SessionOptions{Resume: effortThread})
	promptAndWait(t, session, "again")
	sameJSON(t, session.Usage().Value, `{"total":null}`)
}

// ─── codex-service-tier.test.ts (session parts) ─────────────────────────────

func tierServer(t *testing.T, reply jsonx.Record, openError string) *fakeProcess {
	fake := rpcServer(func(method string, _ jsonx.Record, _ *fakeProcess) jsonx.Record {
		if method == "initialize" {
			return jsonx.Record{"result": jsonx.Record{}}
		}
		if openError != "" && (method == "thread/start" || method == "thread/resume") {
			return jsonx.Record{"error": jsonx.Record{"code": -32_602, "message": openError}}
		}
		result := jsonx.Record{"thread": jsonx.Record{"id": "tier-thread"}, "model": "gpt-5.5"}
		if method == "turn/start" {
			result = jsonx.Record{"turn": jsonx.Record{"id": "turn"}}
		}
		for key, value := range reply {
			result[key] = value
		}
		return jsonx.Record{"result": result}
	})
	useFakes(t, fake)
	return fake
}

func TestTierIsAppliedToOpenReadBackAndNeverSetPerTurn(t *testing.T) {
	for _, resume := range []string{"", "tier-thread"} {
		t.Run("resume="+resume, func(t *testing.T) {
			fake := tierServer(t, jsonx.Record{"serviceTier": "priority"}, "")
			session := mustOpen(t, oar.SessionOptions{ServiceTier: "priority", Resume: resume})
			requests := fake.requests()
			method := "thread/start"
			if resume != "" {
				method = "thread/resume"
			}
			matchJSON(t, requests[len(requests)-1], `{"method":"`+method+`","params":{"serviceTier":"priority"}}`)
			if tier := session.ServiceTier().Value; tier == nil || *tier != "priority" {
				t.Fatalf("tier %v", tier)
			}
			prompt(t, session, "hello")
			if _, ok := jsonx.AsRecord(requestOf(fake, "turn/start")["params"])["serviceTier"]; ok {
				t.Fatal("a turn carries serviceTier")
			}
		})
	}
}

func TestSubstitutionAliasNullAndAbsentReportsFailBeforeOpen(t *testing.T) {
	for _, resume := range []string{"", "tier-thread"} {
		for _, testCase := range []struct {
			requested string
			reply     jsonx.Record
			reported  string
		}{
			{"priority", jsonx.Record{"serviceTier": "flex"}, "flex"},
			{"fast", jsonx.Record{"serviceTier": "priority"}, "priority"},
			{"priority", jsonx.Record{"serviceTier": nil}, "default"},
			{"priority", jsonx.Record{}, "unreported"},
		} {
			fake := tierServer(t, testCase.reply, "")
			_, err := openSession(t, oar.SessionOptions{ServiceTier: testCase.requested, Resume: resume})
			want := fmt.Sprintf("reports serviceTier %s although %s was requested", testCase.reported, testCase.requested)
			if err == nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("err %v, want %s", err, want)
			}
			if !fake.killed() {
				t.Fatal("not killed")
			}
		}
	}
}

func TestNativeOpenErrorsRetainTheRequestedTierAndReclaimTheChild(t *testing.T) {
	for _, resume := range []string{"", "tier-thread"} {
		fake := tierServer(t, jsonx.Record{}, "selection unavailable")
		_, err := openSession(t, oar.SessionOptions{ServiceTier: "priority", Resume: resume})
		if err == nil || !strings.Contains(err.Error(), "serviceTier priority could not be confirmed (actual unreported): selection unavailable") {
			t.Fatalf("err %v", err)
		}
		if !fake.killed() {
			t.Fatal("not killed")
		}
	}
}

func TestOmittingTierPreservesTheNativeSelectionAndNullMeansNoSpecialTier(t *testing.T) {
	fake := tierServer(t, jsonx.Record{"serviceTier": nil}, "")
	session := mustOpen(t, oar.SessionOptions{Resume: "tier-thread"})
	requests := fake.requests()
	if _, ok := jsonx.AsRecord(requests[len(requests)-1]["params"])["serviceTier"]; ok {
		t.Fatal("a tier was sent")
	}
	if tier := session.ServiceTier().Value; tier == nil || *tier != "default" {
		t.Fatalf("tier %v", tier)
	}
}

// ─── codex-session-name.test.ts ─────────────────────────────────────────────

// nameServer is an app-server whose opened thread carries name (nil: codex
// reports null for an unnamed one); nameSet answers thread/name/set.
func nameServer(t *testing.T, name any, nameSet jsonx.Record) *fakeProcess {
	fake := rpcServer(func(method string, _ jsonx.Record, _ *fakeProcess) jsonx.Record {
		switch method {
		case "thread/name/set":
			if nameSet != nil {
				return nameSet
			}
			return jsonx.Record{"result": jsonx.Record{}}
		case "thread/start":
			return jsonx.Record{"result": jsonx.Record{"thread": jsonx.Record{"id": "thread", "name": nil}}}
		case "thread/resume":
			return jsonx.Record{"result": jsonx.Record{"thread": jsonx.Record{"id": "thread", "name": name}}}
		}
		return jsonx.Record{"result": jsonx.Record{}}
	})
	useFakes(t, fake)
	return fake
}

func nameSets(fake *fakeProcess) []any {
	sets := []any{}
	for _, request := range fake.requests() {
		if request["method"] == "thread/name/set" {
			sets = append(sets, request["params"])
		}
	}
	return sets
}

func TestANewThreadGetsTheNameOnceItOpens(t *testing.T) {
	fake := nameServer(t, nil, nil)
	mustOpen(t, oar.SessionOptions{Name: oar.String("Raft · Otter")})
	sameJSON(t, nameSets(fake), `[{"threadId":"thread","name":"Raft · Otter"}]`)
	methods := methodsOf(fake)
	start, set := -1, -1
	for index, method := range methods {
		if method == "thread/start" {
			start = index
		}
		if method == "thread/name/set" {
			set = index
		}
	}
	if set != start+1 {
		t.Fatalf("methods %v", methods)
	}
}

func TestAResumedThreadIsNamedOnlyWhenItHasNone(t *testing.T) {
	for _, testCase := range []struct {
		current  any
		expected string
	}{
		{nil, `[{"threadId":"thread","name":"host name"}]`},
		{"", `[{"threadId":"thread","name":"host name"}]`},
		{"the user's own name", `[]`},
	} {
		fake := nameServer(t, testCase.current, nil)
		mustOpen(t, oar.SessionOptions{Resume: "thread", Name: oar.String("host name")})
		sameJSON(t, nameSets(fake), testCase.expected)
	}
}

func TestNoNameOptionSendsNoThreadNameSet(t *testing.T) {
	fake := nameServer(t, nil, nil)
	mustOpen(t, oar.SessionOptions{})
	sameJSON(t, nameSets(fake), `[]`)
}

func TestANameCodexRefusesFailsTheOpenWithCodexsWords(t *testing.T) {
	nameServer(t, nil, jsonx.Record{"error": jsonx.Record{"code": -32_600, "message": "name too long"}})
	_, err := openSession(t, oar.SessionOptions{Name: oar.String(strings.Repeat("x", 10))})
	if err == nil || !strings.Contains(err.Error(), "codex thread/name/set failed: name too long") {
		t.Fatalf("err %v", err)
	}
}

// ─── codex-output-schema.test.ts ────────────────────────────────────────────

var outputSchema = []byte(`{"type":"object","properties":{"answer":{"type":"integer"}},"required":["answer"]}`)

func schemaServer(t *testing.T) *fakeProcess {
	fake := rpcServer(func(method string, params jsonx.Record, fake *fakeProcess) jsonx.Record {
		switch method {
		case "thread/start", "thread/resume":
			return jsonx.Record{"result": jsonx.Record{"thread": jsonx.Record{"id": "thread"}, "model": "gpt-5.1"}}
		case "turn/start":
			id := float64(len(fake.requests()))
			fake.emitJSON(jsonx.Record{"id": id, "result": jsonx.Record{"turn": jsonx.Record{"id": "turn"}}})
			notifyOn(fake, "turn/started", jsonx.Record{"threadId": "thread", "turn": jsonx.Record{"id": "turn"}})
			if jsonx.AsRecord(jsonx.AsList(params["input"])[0])["text"] != "hold" {
				notifyOn(fake, "item/agentMessage/delta", jsonx.Record{"threadId": "thread", "turnId": "turn", "delta": "not JSON"})
				notifyOn(fake, "turn/completed", jsonx.Record{"threadId": "thread", "turn": jsonx.Record{"id": "turn", "status": "completed"}})
			}
			return nil
		}
		return jsonx.Record{"result": jsonx.Record{}}
	})
	useFakes(t, fake)
	return fake
}

func TestEveryPromptedTurnCarriesSchemaIncludingResumeAndOutputStaysText(t *testing.T) {
	for _, resume := range []string{"", "thread"} {
		t.Run("resume="+resume, func(t *testing.T) {
			fake := schemaServer(t)
			session := mustOpen(t, oar.SessionOptions{OutputSchema: outputSchema, Resume: resume})
			for _, input := range []string{"one", "two"} {
				run := promptAndWait(t, session, input)
				if run.Kind != "ended" || run.Text != "not JSON" || run.Outcome.Kind != "completed" {
					t.Fatalf("run %+v", run)
				}
			}
			schemas := []any{}
			for _, request := range fake.requests() {
				if request["method"] == "turn/start" {
					schemas = append(schemas, jsonx.AsRecord(request["params"])["outputSchema"])
				}
			}
			sameJSON(t, schemas, "["+string(outputSchema)+","+string(outputSchema)+"]")
			sameJSON(t, session.Status().Value, `{"kind":"idle","lastTurnOutcome":{"kind":"completed"}}`)
			queued, err := session.Queue(testContext(t), "queued", oar.InputOptions{})
			if err != nil || queued.Kind != oar.ResponseRejected || queued.Code != oar.CodeUnsupported || !strings.Contains(queued.Reason, "queued input cannot carry outputSchema") {
				t.Fatalf("queued %+v %v", queued, err)
			}
			if requestOf(fake, "thread/queue/add") != nil {
				t.Fatal("thread/queue/add was sent")
			}
		})
	}
}

func TestSteerStaysInTheExistingTurnAndASchemaFreeSessionKeepsNativeQueueSupport(t *testing.T) {
	fake := schemaServer(t)
	session := mustOpen(t, oar.SessionOptions{OutputSchema: outputSchema})
	prompt(t, session, "hold")
	steered, err := session.Steer(testContext(t), "change", oar.InputOptions{})
	if err != nil || steered.Kind != oar.ResponseAccepted {
		t.Fatalf("steer %+v %v", steered, err)
	}
	if _, ok := jsonx.AsRecord(requestOf(fake, "turn/steer")["params"])["outputSchema"]; ok {
		t.Fatal("a steer carries outputSchema")
	}
	next := schemaServer(t)
	plain := mustOpen(t, oar.SessionOptions{})
	queued, err := plain.Queue(testContext(t), "next", oar.InputOptions{})
	if err != nil || queued.Kind != oar.ResponseAccepted || requestOf(next, "thread/queue/add") == nil {
		t.Fatalf("queue %+v %v", queued, err)
	}
}

// ─── codex-session-mcp-servers.test.ts (session parts) ──────────────────────

func TestANameCodexWouldRefuseToStartOrOneGivenTwiceFailsTheOpenBeforeCodexStarts(t *testing.T) {
	spawner := useFakes(t, newFakeProcess(nil))
	_, err := openSession(t, oar.SessionOptions{MCPServers: []oar.McpServer{{Name: "my server", Command: "x"}}})
	if err == nil || err.Error() != `codex starts no MCP server named "my server": its names match ^[\w:@/.-]+$` {
		t.Fatalf("err %v", err)
	}
	_, err = openSession(t, oar.SessionOptions{MCPServers: []oar.McpServer{echoServer, echoServer}})
	if err == nil || err.Error() != `mcpServers names "echo" twice; names are unique within a session` {
		t.Fatalf("err %v", err)
	}
	if spawner.count() != 0 {
		t.Fatal("app-server started")
	}
}

func TestAnOpenFailureNeverCarriesAnEnvOrHeaderValueHoweverCodexWordsIt(t *testing.T) {
	useFakes(t, rpcServer(func(method string, _ jsonx.Record, _ *fakeProcess) jsonx.Record {
		if method == "initialize" {
			return jsonx.Record{"result": jsonx.Record{}}
		}
		return jsonx.Record{"error": jsonx.Record{"code": -32_600, "message": "bad config: env " + stdioToken + ", header " + headerSecret}}
	}))
	_, err := openSession(t, oar.SessionOptions{MCPServers: []oar.McpServer{echoServer, remoteServer}})
	if err == nil || err.Error() != "codex thread/start failed: bad config: env [redacted], header [redacted]" {
		t.Fatalf("err %v", err)
	}
}

func TestNorDoesACodexExitWhoseStderrTailTheErrorCarries(t *testing.T) {
	useFakes(t, newFakeProcess(func(text string, fake *fakeProcess) {
		if jsonx.ParseRecord([]byte(text))["method"] == "initialize" {
			fake.emitStderr("failed to start server with " + stdioToken + "\n")
			fake.end(intPtr(1), "")
		}
	}))
	_, err := openSession(t, oar.SessionOptions{MCPServers: []oar.McpServer{echoServer}})
	if err == nil || !strings.Contains(err.Error(), "[redacted]") || strings.Contains(err.Error(), stdioToken) {
		t.Fatalf("err %v", err)
	}
}

const privateUserConfigValue = "private-user-config-env-sentinel"

func TestConfigReadCredentialsStayPrivateWhenApplyingToolDenials(t *testing.T) {
	for _, resume := range []string{"", "saved-thread"} {
		t.Run("resume="+resume, func(t *testing.T) {
			fake := rpcServer(func(method string, _ jsonx.Record, _ *fakeProcess) jsonx.Record {
				switch method {
				case "config/read":
					return jsonx.Record{"result": jsonx.Record{"config": jsonx.Record{"mcp_servers": jsonx.Record{"saved": jsonx.Record{"command": "private-server", "env": jsonx.Record{"PRIVATE_TOKEN": privateUserConfigValue}, "disabled_tools": []any{"already"}}}}}}
				case "initialize":
					return jsonx.Record{"result": jsonx.Record{}}
				}
				return jsonx.Record{"result": jsonx.Record{"thread": jsonx.Record{"id": "saved-thread"}, "model": "gpt-5.5"}}
			})
			useFakes(t, fake)
			session := mustOpen(t, oar.SessionOptions{Resume: resume, DisallowedTools: []string{"mcp__saved__echo"}})
			method := "thread/start"
			if resume != "" {
				method = "thread/resume"
			}
			sameJSON(t, jsonx.AsRecord(requestOf(fake, method)["params"])["config"], `{"mcp_servers":{"saved":{"disabled_tools":["already","echo"]}}}`)
			if strings.Contains(jsonText(fake.writtenRecords()), privateUserConfigValue) || strings.Contains(jsonOf(t, session.Records()), privateUserConfigValue) {
				t.Fatal("the private config leaked")
			}
			types := []string{}
			for _, record := range session.Records() {
				if record.Kind == oar.KindFrame {
					types = append(types, record.Frame.Type)
				}
			}
			sameJSON(t, types, jsonText([]string{method}))
			if err := session.Dispose(testContext(t)); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(jsonOf(t, session.Records()), privateUserConfigValue) {
				t.Fatal("the private config leaked")
			}
		})
	}
}

// ─── codex-open-errors.test.ts ──────────────────────────────────────────────

const openErrorSecret = "open-error-env-sentinel"
const openErrorHeader = "Bearer open-error-header-sentinel"

func TestAnOpenFailureKeepsItsRedactedNativeErrorBeforeASessionExists(t *testing.T) {
	for _, method := range []string{"initialize", "thread/start", "thread/resume"} {
		t.Run(method, func(t *testing.T) {
			fake := rpcServer(func(requested string, _ jsonx.Record, _ *fakeProcess) jsonx.Record {
				if requested == method {
					return jsonx.Record{"error": jsonx.Record{"code": -32_603, "message": "refused " + openErrorSecret, "data": jsonx.Record{"detail": []any{openErrorHeader, jsonx.Record{openErrorSecret: openErrorSecret}}, "retryable": false}}}
				}
				return jsonx.Record{"result": jsonx.Record{}}
			})
			useFakes(t, fake)
			resume := ""
			if method == "thread/resume" {
				resume = "saved-thread"
			}
			_, err := openSession(t, oar.SessionOptions{Cwd: ".", Resume: resume, MCPServers: []oar.McpServer{
				{Name: "echo", Command: "echo", Env: map[string]string{"TOKEN": openErrorSecret}},
				{Name: "remote", Type: "http", URL: "http://127.0.0.1:9/mcp", Headers: map[string]string{"Authorization": openErrorHeader}},
			}})
			if err == nil {
				t.Fatal("the open succeeded")
			}
			var failure *rpcError
			if errors.As(err, &failure) {
				sameJSON(t, map[string]any{"method": failure.cause.Method, "native": failure.cause.Native}, `{"method":"`+method+`","native":{"code":-32603,"message":"refused [redacted]","data":{"detail":["[redacted]",{"[redacted]":"[redacted]"}],"retryable":false}}}`)
			}
			for _, output := range []string{fmt.Sprintf("%+v %#v", err, err), err.Error()} {
				if strings.Contains(output, openErrorSecret) || strings.Contains(output, openErrorHeader) {
					t.Fatalf("the error carries a secret: %s", output)
				}
			}
			if !fake.killed() {
				t.Fatal("app-server not stopped")
			}
		})
	}
}

// ─── codex-missing-resume.test.ts ───────────────────────────────────────────

func missingResumeNative(t *testing.T) jsonx.Record {
	data, err := os.ReadFile("../../testdata/fixtures/missing-resume-errors.json")
	if err != nil {
		t.Fatal(err)
	}
	return jsonx.AsRecord(jsonx.ParseRecord(data)["codex"])
}

func with(record jsonx.Record, key string, value any) jsonx.Record {
	copied := jsonx.Record{}
	for name, field := range record {
		copied[name] = field
	}
	copied[key] = value
	return copied
}

func faultServer(t *testing.T, native jsonx.Record, method string) *fakeProcess {
	fake := rpcServer(func(requested string, _ jsonx.Record, _ *fakeProcess) jsonx.Record {
		if requested == method {
			return jsonx.Record{"error": native}
		}
		return jsonx.Record{"result": jsonx.Record{}}
	})
	useFakes(t, fake)
	return fake
}

func TestRecordedMissingRolloutFailureIsTypedRetainingNativeCauseAndRedaction(t *testing.T) {
	secret := "00000000-0000-4000-8000-000000000294"
	fake := faultServer(t, missingResumeNative(t), "thread/resume")
	_, err := openSession(t, oar.SessionOptions{Cwd: ".", Resume: secret, ServiceTier: "flex", Env: map[string]*string{"API_KEY": oar.String(secret)}})
	var notFound *oar.SessionNotFoundError
	if !errors.As(err, &notFound) {
		t.Fatalf("err %T %v", err, err)
	}
	if notFound.SessionID != "[redacted]" || notFound.Method != "thread/resume" {
		t.Fatalf("not found %+v", notFound)
	}
	sameJSON(t, notFound.Native, `{"code":-32600,"message":"no rollout found for thread id [redacted]"}`)
	if strings.Contains(fmt.Sprintf("%+v %#v %s", err, err, notFound.Native), secret) {
		t.Fatal("the error carries the secret")
	}
	if !fake.killed() {
		t.Fatal("not killed")
	}
}

// [env] codex 0.162.0 (experiments/codex-session-name.ts): the same -32600, in other words.
func TestUnavailableRefusalsAreSessionUnavailableErrorsWithTheNativeCause(t *testing.T) {
	base := missingResumeNative(t)
	for _, testCase := range []struct {
		native jsonx.Record
		reason string
	}{
		{with(base, "message", "thread existing already has an active writer"), "in_use"},
		{with(base, "message", "session existing is archived. Run `codex unarchive existing` to unarchive it first."), "archived"},
	} {
		t.Run(testCase.reason, func(t *testing.T) {
			fake := faultServer(t, testCase.native, "thread/resume")
			_, err := openSession(t, oar.SessionOptions{Cwd: ".", Resume: "existing"})
			var unavailable *oar.SessionUnavailableError
			var notFound *oar.SessionNotFoundError
			if !errors.As(err, &unavailable) || errors.As(err, &notFound) {
				t.Fatalf("err %T %v", err, err)
			}
			if unavailable.SessionID != "existing" || unavailable.Reason != testCase.reason || unavailable.Message != "codex thread/resume failed: "+fmt.Sprint(testCase.native["message"]) || unavailable.Method != "thread/resume" {
				t.Fatalf("unavailable %+v", unavailable)
			}
			sameJSON(t, unavailable.Native, jsonText(testCase.native))
			if !fake.killed() {
				t.Fatal("not killed")
			}
		})
	}
}

func TestAnUnavailableTargetsIDIsRedactedLikeAMissingOnes(t *testing.T) {
	secret := "00000000-0000-4000-8000-000000000294"
	faultServer(t, with(missingResumeNative(t), "message", "thread "+secret+" already has an active writer"), "thread/resume")
	_, err := openSession(t, oar.SessionOptions{Cwd: ".", Resume: secret, Env: map[string]*string{"API_KEY": oar.String(secret)}})
	var unavailable *oar.SessionUnavailableError
	if !errors.As(err, &unavailable) || unavailable.SessionID != "[redacted]" || unavailable.Reason != "in_use" {
		t.Fatalf("err %v", err)
	}
	matchJSON(t, unavailable.Native, `{"message":"thread [redacted] already has an active writer"}`)
	if strings.Contains(fmt.Sprintf("%+v %#v %s", err, err, unavailable.Native), secret) {
		t.Fatal("the error carries the secret")
	}
}

func TestAnotherCodexRefusalStaysUnchanged(t *testing.T) {
	base := missingResumeNative(t)
	for _, native := range []jsonx.Record{
		with(base, "message", "cannot resume an unloaded multi-agent v2 sub-agent through its parent; resume the sub-agent directly"),
		with(base, "message", "other error: no rollout found for thread id missing"),
		with(base, "code", -32_603),
	} {
		fake := faultServer(t, native, "thread/resume")
		_, err := openSession(t, oar.SessionOptions{Cwd: ".", Resume: "existing"})
		var notFound *oar.SessionNotFoundError
		var unavailable *oar.SessionUnavailableError
		var failure *rpcError
		if err == nil || errors.As(err, &notFound) || errors.As(err, &unavailable) || !errors.As(err, &failure) {
			t.Fatalf("err %T %v", err, err)
		}
		sameJSON(t, map[string]any{"method": failure.cause.Method, "native": failure.cause.Native}, jsonText(map[string]any{"method": "thread/resume", "native": native}))
		if !fake.killed() {
			t.Fatal("not killed")
		}
	}
}

func TestOnlyThreadResumeMapsTheError(t *testing.T) {
	for _, method := range []string{"initialize", "thread/start"} {
		t.Run(method, func(t *testing.T) {
			fake := faultServer(t, missingResumeNative(t), method)
			_, err := openSession(t, oar.SessionOptions{Cwd: "."})
			var notFound *oar.SessionNotFoundError
			var failure *rpcError
			if errors.As(err, &notFound) || !errors.As(err, &failure) {
				t.Fatalf("err %T %v", err, err)
			}
			sameJSON(t, map[string]any{"method": failure.cause.Method, "native": failure.cause.Native}, jsonText(map[string]any{"method": method, "native": missingResumeNative(t)}))
			fake.Kill()
		})
	}
}

// ─── codex-exit-diagnostics.test.ts, codex-startup-diagnostics.test.ts ─────

func TestPendingAndLaterRPCsRetainTheNativeExitReasonAndStderr(t *testing.T) {
	fake := newFakeProcess(nil)
	useFakes(t, fake)
	client := startAppServerClient("codex", nil, nil, t.TempDir(), appServerProcessOptions{})
	pending := make(chan error, 1)
	go func() {
		_, err := client.request(testContext(t), "initialize", jsonx.Record{}, nil)
		pending <- err
	}()
	eventually(t, "the request", func() bool { return len(fake.requests()) == 1 })
	fake.emitStderr("startup failed\n")
	fake.end(intPtr(17), "")
	failure := <-pending
	if failure == nil || failure.Error() != "app-server exited: exit code 17; signal none\nstderr (tail):\nstartup failed\n" {
		t.Fatalf("failure %q", failure)
	}
	if _, err := client.request(testContext(t), "thread/start", jsonx.Record{}, nil); err != failure {
		t.Fatalf("later %v", err)
	}
}

func TestAnAppServerKilledByASignalReportsTheSignal(t *testing.T) {
	fake := newFakeProcess(nil)
	useFakes(t, fake)
	client := startAppServerClient("codex", nil, nil, t.TempDir(), appServerProcessOptions{})
	fake.emitStderr("native fatal error")
	fake.end(nil, "SIGKILL")
	<-fake.exited
	_, err := client.request(testContext(t), "initialize", jsonx.Record{}, nil)
	if err == nil || err.Error() != "app-server exited: exit code unavailable; signal SIGKILL\nstderr (tail):\nnative fatal error" {
		t.Fatalf("err %q", err)
	}
}

// Go spawns synchronously: the failure is the open's error, in Go's words
// for the spawn error (TS: Node's ENOENT wording; smith/GAPS.md).
func TestAFailedSpawnIsReportedThroughSessionInitialization(t *testing.T) {
	_, err := Session(testContext(t), oar.AvailableInstallation{Via: "executable", Command: "/nonexistent/oar-codex-startup-fixture"}, oar.SessionOptions{Cwd: "."})
	if err == nil || !strings.HasPrefix(err.Error(), "app-server exited: exit code unavailable; signal none; spawn /nonexistent/oar-codex-startup-fixture: ") {
		t.Fatalf("err %v", err)
	}
}
