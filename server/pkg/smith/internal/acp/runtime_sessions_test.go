package acp_test

// The fake agent's runtime replays under the real profiles: ported from
// tests/acp/acp-session-opencode.test.ts, acp-session-opencode-v2.test.ts,
// acp-steer-refusal.test.ts, grok-structured-output.test.ts,
// acp-grok-wire-shapes.test.ts and acp-kimi-wire-shapes.test.ts.

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
	"vibevalley/pkg/smith/runtimes/grok"
	"vibevalley/pkg/smith/runtimes/opencode"
)

func openWith(t *testing.T, profile acp.Profile, options oar.SessionOptions) (oar.Session, error) {
	t.Helper()
	if options.Cwd == "" {
		options.Cwd, _ = os.Getwd()
	}
	session, err := acp.Session(profile)(testContext(t), installation(t), options)
	if err == nil {
		t.Cleanup(func() { _ = session.Dispose(context.Background()) })
	}
	return session, err
}

func mustOpen(t *testing.T, profile acp.Profile, options oar.SessionOptions) oar.Session {
	t.Helper()
	session, err := openWith(t, profile, options)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return session
}

// control fails the test on a transport error: control(t)(session.Prompt(...)).
func control(t *testing.T) func(oar.ControlOutcome, error) oar.ControlOutcome {
	return func(outcome oar.ControlOutcome, err error) oar.ControlOutcome {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return outcome
	}
}

// ─── acp-session-opencode.test.ts ──────────────────────────────────────────

// The fixture's "opencode" mode replays `opencode acp` 1.18.30: a prompt sent
// mid-turn joins the running loop and both prompts are answered at idle, and
// `session/list` names each session's own directory. The real profile runs
// against it, with only the launch line swapped for the fixture's.
func opencodeOnFixture() acp.Profile {
	profile := opencode.Profile
	profile.Args = acp.StaticArgs(fixture, "opencode")
	return profile
}

func realTempDir(t *testing.T) string {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestOpencodeASteerJoinsTheRunningTurnWhichEndsOnceWithBothInputsAnswered(t *testing.T) {
	session := mustOpen(t, opencodeOnFixture(), oar.SessionOptions{})
	prompted := control(t)(session.Prompt(context.Background(), "hold", oar.InputOptions{}))
	if prompted.Kind != oar.ResponseAccepted {
		t.Fatal(prompted.Kind)
	}
	if steered := mustSteer(t, session, "more", oar.InputOptions{}); steered.Kind != oar.ResponseAccepted {
		t.Fatal(steered.Kind)
	}
	jsonEqual(t, awaitTurnEnd(t, session, prompted.Seq), map[string]any{"kind": "completed"})
	lines := describeAll(session.Records())
	var ended []string
	for _, line := range lines {
		if strings.Contains(line, "turn_ended") {
			ended = append(ended, line)
		}
	}
	equalStrings(t, ended, []string{"event session/prompt → turn_ended:completed"})
	if !contains(lines, "event agent_message_chunk → text:merged:hold+more") {
		t.Fatalf("%q", lines)
	}
}

func TestOpencodeAnIdleSessionHasNothingToSteerAndAPlainPromptRunsAsUsual(t *testing.T) {
	session := mustOpen(t, opencodeOnFixture(), oar.SessionOptions{})
	if early := mustSteer(t, session, "too early", oar.InputOptions{}); early.Kind != oar.ResponseRejected {
		t.Fatal(early.Kind)
	}
	run := promptAndWait(t, session, "hello", observe.PromptRunOptions{})
	if run.Kind != "ended" {
		t.Fatal(run.Kind)
	}
	jsonEqual(t, run.Outcome, map[string]any{"kind": "completed"})
}

func TestOpencodeAResumeIsRefusedOutsideTheSessionsOwnDirectoryAndOpensInsideIt(t *testing.T) {
	own, other := realTempDir(t), realTempDir(t)
	env := map[string]*string{"FAKE_ACP_SESSION_CWD": &own}
	_, err := openWith(t, opencodeOnFixture(), oar.SessionOptions{Cwd: other, Resume: "fake-session", Env: env})
	var unsupported *oar.UnsupportedOptionError
	if !errors.As(err, &unsupported) || unsupported.Option != "cwd" {
		t.Fatalf("%#v", err)
	}
	session := mustOpen(t, opencodeOnFixture(), oar.SessionOptions{Cwd: own, Resume: "fake-session", Env: env})
	if session.ID() != "fake-session" {
		t.Fatal(session.ID())
	}
}

func TestOpencodeAModelSwitchGoesThroughItsConfigOptionWhoseAnswerCarriesThatModelsEffortMenu(t *testing.T) {
	session := mustOpen(t, opencodeOnFixture(), oar.SessionOptions{Model: "requested-y", Effort: "high"})
	if lines := describeAll(session.Records()); !contains(lines, "event session/set_config_option → model:requested-y, effort:medium") {
		t.Fatalf("%q", lines)
	}
	if effort := session.Effort().Value; effort == nil || *effort != "high" {
		t.Fatal(effort)
	}
	// Without the switch the open model's menu is read, and it has none.
	_, err := openWith(t, opencodeOnFixture(), oar.SessionOptions{Effort: "high"})
	if err == nil || !strings.Contains(err.Error(), "session/new advertises no thought_level config option, so effort high cannot be applied") {
		t.Fatal(err)
	}
}

func TestTheOpencodeProfileOpensWithoutAuthenticate(t *testing.T) {
	session := mustOpen(t, opencodeOnFixture(), oar.SessionOptions{})
	if contains(describeAll(session.Records()), "event authenticate") {
		t.Fatal("authenticated")
	}
	if caps := session.Capabilities(); caps.QueueDurable || caps.Attribution != "opaque" {
		t.Fatalf("%+v", caps)
	}
}

func TestTheOpencodeInstallScriptsDirectoryIsAFallbackOnEachPlatform(t *testing.T) {
	equalStrings(t, opencode.InstalledExecutableCandidates("linux", "/home/u"), []string{"/home/u/.opencode/bin/opencode"})
	equalStrings(t, opencode.InstalledExecutableCandidates("windows", `C:\Users\u`), []string{`C:\Users\u\.opencode\bin\opencode.exe`})
}

// ─── acp-session-opencode-v2.test.ts ───────────────────────────────────────

func TestOpencodeV2OmitsSteerSteerOrQueueAndDeliverBothHoldInputForSubsequentTurns(t *testing.T) {
	profile := opencode.V2Profile
	profile.Args = acp.StaticArgs(fixture, "opencode")
	session := mustOpen(t, profile, oar.SessionOptions{})
	if session.CanSteer() {
		t.Fatal("v2 can steer")
	}
	jsonEqual(t, session.Capabilities(), `{"attribution": "nested", "images": true, "queue": {"durable": false}}`)
	control(t)(session.Prompt(context.Background(), "hold", oar.InputOptions{}))
	first, err := session.SteerOrQueue(context.Background(), "queued-one", oar.InputOptions{})
	if err != nil {
		t.Fatal(err)
	}
	second, err := session.Deliver(context.Background(), "queued-two", oar.DeliverOptions{When: "now"})
	if err != nil {
		t.Fatal(err)
	}
	equalStrings(t, []string{string(first.Landed), string(second.Landed)}, []string{"queued", "queued"})
	var kinds []string
	for _, record := range session.Records() {
		if record.Kind == oar.KindRequest {
			kinds = append(kinds, string(record.Request.Kind))
		}
	}
	equalStrings(t, kinds, []string{"prompt", "queue", "queue"})
	control(t)(session.Abort(context.Background()))
	if !eventually(func() bool {
		ended := 0
		for _, frame := range frames(session) {
			for _, event := range frame.Events {
				if _, ok := event.(oar.TurnEnded); ok {
					ended++
				}
			}
		}
		return ended == 3
	}, 10*time.Second) {
		t.Fatalf("%q", describeAll(session.Records()))
	}
	var texts []oar.EventBody
	for _, frame := range frames(session) {
		for _, event := range frame.Events {
			if _, ok := event.(oar.TextDelta); ok {
				texts = append(texts, event)
			}
		}
	}
	jsonEqual(t, texts, `[{"kind": "text_delta", "text": "echo:queued-one"}, {"kind": "text_delta", "text": "echo:queued-two"}]`)
}

// ─── acp-steer-refusal.test.ts ─────────────────────────────────────────────

const refusedInputID = "21785c6a-0777-49b2-a985-8cfe2ef441a3"

type droppedState struct {
	State    string   `json:"state"`
	Reason   *string  `json:"reason"`
	Attempts []string `json:"attempts"`
}

func droppedInput(session oar.Session) droppedState {
	for _, input := range observe.ConversationOf(session.Records()).Inputs.Values() {
		if input.InputID != refusedInputID {
			continue
		}
		state := droppedState{State: input.State, Attempts: []string{}}
		if input.Reason != "" {
			reason := input.Reason
			state.Reason = &reason
		}
		for _, attempt := range input.Attempts {
			state.Attempts = append(state.Attempts, attempt.State)
		}
		return state
	}
	return droppedState{}
}

func turnEndedEvents(session oar.Session) []oar.EventBody {
	out := []oar.EventBody{}
	for _, frame := range frames(session) {
		for _, event := range frame.Events {
			if _, ok := event.(oar.TurnEnded); ok {
				out = append(out, event)
			}
		}
	}
	return out
}

func TestARefusedSteerCannotFailTheTurn(t *testing.T) {
	sendNowProfile := profileWith(sendNow)
	for _, c := range []struct {
		name    string
		profile acp.Profile
		next    string
	}{
		{"opencode v1", opencodeOnFixture(), "more"},
		{"send-now", sendNowProfile, "steer-new"},
	} {
		for _, afterEnd := range []bool{false, true} {
			name := c.name + map[bool]string{false: " before", true: " after"}[afterEnd] + " the prompt answer"
			t.Run(name, func(t *testing.T) {
				session := mustOpen(t, c.profile, oar.SessionOptions{})
				prompt := control(t)(session.Prompt(context.Background(), "hold", oar.InputOptions{}))
				input := "refused-steer"
				if afterEnd {
					input = "refused-steer-after-end"
				}
				if steered := mustSteer(t, session, input, oar.InputOptions{InputID: refusedInputID}); steered.Kind != oar.ResponseAccepted {
					t.Fatal(steered.Kind)
				}
				if !eventually(func() bool { return droppedInput(session).State == "dropped" }, 10*time.Second) {
					t.Fatalf("%+v", droppedInput(session))
				}
				jsonEqual(t, droppedInput(session), map[string]any{"attempts": []string{"accepted"}, "reason": "runtime_refused", "state": "dropped"})
				var refusal json.RawMessage
				answered := false
				for _, frame := range frames(session) {
					if frame.Type == "session/prompt/error" && refusal == nil {
						refusal = frame.Native
					}
					if frame.Type == "session/prompt" {
						answered = true
					}
				}
				jsonEqual(t, refusal, `{"code": -32603, "data": {"service": "session"}, "message": "Internal error: Session already has an active ACP prompt: fake-session", "name": "RequestError"}`)
				// The original RPC answer was preserved, whichever one arrived first.
				if answered != afterEnd {
					t.Fatalf("session/prompt recorded: %v", answered)
				}
				if !afterEnd {
					if status := session.Status().Value.Kind; status != "running" {
						t.Fatal(status)
					}
					if continued := mustSteer(t, session, c.next, oar.InputOptions{}); continued.Kind != oar.ResponseAccepted {
						t.Fatal(continued.Kind)
					}
				}
				jsonEqual(t, awaitTurnEnd(t, session, prompt.Seq), map[string]any{"kind": "completed"})
				jsonEqual(t, turnEndedEvents(session), `[{"kind": "turn_ended", "outcome": {"kind": "completed"}}]`)
			})
		}
	}
}

func TestARefusedV1SteerArrivingDuringTheNextTurnCannotFinishOrFailThatTurn(t *testing.T) {
	session := mustOpen(t, opencodeOnFixture(), oar.SessionOptions{})
	first := control(t)(session.Prompt(context.Background(), "hold", oar.InputOptions{}))
	mustSteer(t, session, "refused-steer-after-end", oar.InputOptions{InputID: refusedInputID})
	jsonEqual(t, awaitTurnEnd(t, session, first.Seq), map[string]any{"kind": "completed"})
	second := control(t)(session.Prompt(context.Background(), "hold", oar.InputOptions{}))
	if !eventually(func() bool { return droppedInput(session).State == "dropped" }, 10*time.Second) {
		t.Fatalf("%+v", droppedInput(session))
	}
	if status := session.Status().Value.Kind; status != "running" {
		t.Fatal(status)
	}
	if n := len(turnEndedEvents(session)); n != 1 {
		t.Fatalf("%d turn ends", n)
	}
	// A dropped input is owned by the host again and can reuse its input ID.
	if retry := mustSteer(t, session, "more", oar.InputOptions{InputID: refusedInputID}); retry.Kind != oar.ResponseAccepted {
		t.Fatal(retry.Kind)
	}
	jsonEqual(t, awaitTurnEnd(t, session, second.Seq), map[string]any{"kind": "completed"})
	jsonEqual(t, droppedInput(session), map[string]any{"attempts": []string{"accepted", "accepted"}, "reason": nil, "state": "accepted"})
}

// ─── grok-structured-output.test.ts ────────────────────────────────────────

// Grok 1.0.50 + aimock, 2026-10-11. Native replies; session and prompt ids removed.
func grokReply(t *testing.T, mode string) jsonx.Record {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(replayFixtures, "grok-structured-output-"+mode+".raw.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	record := jsonx.ParseRecord(data)
	if record == nil {
		record = jsonx.Record{}
	}
	return record
}

func TestGrokNativeResultsHaveTheSameOutcomeLiveAndAfterJSONRetention(t *testing.T) {
	for _, mode := range []string{"valid", "invalid", "bad-schema"} {
		t.Run(mode, func(t *testing.T) {
			native := grokReply(t, mode)
			outcome := *grok.PromptOutcome(native)
			if mode == "valid" {
				jsonEqual(t, outcome, map[string]any{"kind": "completed", "structuredOutput": map[string]any{"answer": 4}})
			} else {
				if outcome.Kind != "failed" || outcome.Failure != oar.FailureOutputSchema {
					t.Fatalf("%+v", outcome)
				}
				jsonEqual(t, outcome.Reason, jsonx.AsRecord(native["_meta"])["structuredOutputError"])
			}
			session := start(t, func(profile *acp.Profile) {
				profile.PromptOutcome = func(jsonx.Record) *oar.TurnOutcome { copied := outcome; return &copied }
			})
			run := promptAndWait(t, session, "hello", observe.PromptRunOptions{})
			if run.Kind != "ended" {
				t.Fatal(run.Kind)
			}
			jsonEqual(t, run.Outcome, outcome)
			encoded, _ := json.Marshal(session.Records())
			var records []oar.RawEvent
			if err := json.Unmarshal(encoded, &records); err != nil {
				t.Fatal(err)
			}
			jsonEqual(t, observe.TurnEndAfter(records, -1, session.ID(), ""), outcome)
			var turn *observe.ViewMessage
			for _, message := range observe.ViewOf(records, "").Messages {
				if message.Kind == "turn" {
					copied := message
					turn = &copied
					break
				}
			}
			if turn == nil {
				t.Fatal("no turn")
			}
			jsonEqual(t, turn.Outcome, outcome)
		})
	}
}

func TestGrokForwardsSchemaOnPromptSendNowSteerAndHeldQueueDrain(t *testing.T) {
	outputSchema := json.RawMessage(`{"type":"object"}`)
	session := mustOpen(t, profileWith(func(profile *acp.Profile) {
		profile.PromptMeta = grok.Profile.PromptMeta
		profile.SteerParams = grok.Profile.SteerParams
		profile.SteerSupersedesPrompt = true
		profile.ExtensionNotifications = []string{"fixture/prompt-schema"}
	}), oar.SessionOptions{OutputSchema: outputSchema})
	first := control(t)(session.Prompt(context.Background(), "steer-base", oar.InputOptions{}))
	control(t)(session.Queue(context.Background(), "queued", oar.InputOptions{}))
	if steered := mustSteer(t, session, "steer-new", oar.InputOptions{}); steered.Kind != oar.ResponseAccepted {
		t.Fatal(steered.Kind)
	}
	awaitTurnEnd(t, session, first.Seq)
	endedSeq := int64(-1)
	for _, record := range session.Records() {
		if record.Seq <= first.Seq || record.Kind != oar.KindFrame {
			continue
		}
		for _, event := range record.Frame.Events {
			if _, ok := event.(oar.TurnEnded); ok && endedSeq < 0 {
				endedSeq = record.Seq
			}
		}
	}
	if endedSeq < 0 {
		t.Fatal("no turn end")
	}
	awaitTurnEnd(t, session, endedSeq)
	var sent []jsonx.Record
	for _, frame := range frames(session) {
		if frame.Type == "fixture/prompt-schema" {
			sent = append(sent, jsonx.ParseRecord(frame.Native))
		}
	}
	if len(sent) != 3 {
		t.Fatalf("%d schema frames", len(sent))
	}
	for _, params := range sent {
		jsonEqual(t, jsonx.AsRecord(params["_meta"])["outputSchema"], outputSchema)
	}
	if jsonx.AsRecord(sent[1]["_meta"])["sendNow"] != true {
		t.Fatalf("%v", sent[1])
	}
}

func TestGrokNeverParsesTextPreservesFalseyNativeValuesAndPrioritizesCancellation(t *testing.T) {
	jsonEqual(t, grok.PromptOutcome(jsonx.Record{"stopReason": "end_turn"}), map[string]any{"kind": "completed"})
	for _, value := range []any{nil, false, 0, ""} {
		jsonEqual(t, grok.PromptOutcome(jsonx.Record{"stopReason": "end_turn", "_meta": map[string]any{"structuredOutput": value}}), map[string]any{"kind": "completed", "structuredOutput": value})
	}
	cancelled := grokReply(t, "valid")
	cancelled["stopReason"] = "cancelled"
	jsonEqual(t, grok.PromptOutcome(cancelled), map[string]any{"kind": "aborted"})
}
