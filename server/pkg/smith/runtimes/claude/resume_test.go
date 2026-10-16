//go:build wip_b

package claude

import (
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Ports tests/claude/claude-resume.test.ts.

var resumeInstallation = oar.AvailableInstallation{Via: "executable", Command: "claude"}

const resumeSecret = "claude-resume-secret-sentinel"

// b_missingResume is what claude 2.1.292 and 2.1.295 report before exiting, without an initialize answer.
func b_missingResume(t *testing.T) jsonx.Record {
	return b_readJSONFile(t, filepath.Join("../../testdata/fixtures", "claude-missing-resume.json"))
}

func b_cwd(t *testing.T) string {
	t.Helper()
	dir, err := filepath.Abs(".")
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestResumeRejectsOnTheNativeMissingSessionResultWithItsRedactedCause(t *testing.T) {
	missing := b_missingResume(t)
	fake := newFakeProcess(func(_ string, child *fakeProcess) { child.emitJSON(missing) })
	useFakeSpawner(t, fake)
	_, err := Session(testContext(t), resumeInstallation, oar.SessionOptions{Cwd: b_cwd(t), Resume: resumeSecret, Env: map[string]*string{"API_KEY": oar.String(resumeSecret)}})
	defer fake.Kill()
	var notFound *oar.SessionNotFoundError
	if !errors.As(err, &notFound) {
		t.Fatalf("error = %T %v", err, err)
	}
	if notFound.SessionID != "[redacted]" || notFound.Message != "No conversation found with session ID: [redacted]" || notFound.Method != "initialize" {
		t.Fatalf("error = %+v", notFound)
	}
	want := jsonx.Record{}
	for key, value := range missing {
		want[key] = value
	}
	want["errors"] = []any{"No conversation found with session ID: [redacted]"}
	want["session_id"] = "[redacted]"
	if !b_sameJSON(jsonx.ParseRecord(notFound.Native), want) {
		t.Fatalf("native = %s", notFound.Native)
	}
	if strings.Contains(fmt.Sprintf("%+v %s", notFound, notFound.Native), resumeSecret) {
		t.Fatal("the secret leaked")
	}
	if !fake.killed() {
		t.Fatal("claude was not stopped")
	}
}

func TestResumeDoesNotResolveUntilItsOwnInitializeSucceedsAndKeepsTheAnswerPrivate(t *testing.T) {
	fake := newFakeProcess(nil)
	useFakeSpawner(t, fake)
	type opened struct {
		session oar.Session
		err     error
	}
	done := make(chan opened, 1)
	go func() {
		session, err := Session(testContext(t), resumeInstallation, oar.SessionOptions{Cwd: b_cwd(t), Resume: "existing-session"})
		done <- opened{session, err}
	}()
	eventually(t, "initialize", func() bool { return len(fake.writes()) == 1 })
	request := b_requestOf(fake.writes()[0])
	if !b_sameJSON(request["request"], map[string]any{"subtype": "initialize"}) {
		t.Fatalf("request = %v", request)
	}
	fake.emitJSON(b_controlSuccess("unrelated", map[string]any{}))
	select {
	case <-done:
		t.Fatal("opened on an unrelated answer")
	case <-time.After(50 * time.Millisecond):
	}
	answer := b_controlSuccess(request["request_id"], map[string]any{"fast_mode_state": "off"})
	fake.emitJSON(answer)
	// Then the token baseline (#282), its answer private as well.
	eventually(t, "get_usage", func() bool { return len(fake.writes()) == 2 })
	usage := b_requestOf(fake.writes()[1])
	if !b_sameJSON(usage["request"], map[string]any{"subtype": "get_usage", "skip_behaviors": true}) {
		t.Fatalf("usage request = %v", usage)
	}
	usageAnswer := b_controlSuccess(usage["request_id"], map[string]any{"session": map[string]any{"model_usage": map[string]any{}}})
	fake.emitJSON(usageAnswer)
	result := <-done
	if result.err != nil {
		t.Fatal(result.err)
	}
	session := result.session
	if session.ID() != "existing-session" {
		t.Fatalf("id = %s", session.ID())
	}
	for _, record := range session.Records() {
		if record.Kind == oar.KindFrame && (b_sameJSON(jsonx.ParseRecord(record.Frame.Native), answer) || b_sameJSON(jsonx.ParseRecord(record.Frame.Native), usageAnswer)) {
			t.Fatal("a private answer was recorded")
		}
	}
	if len(fake.writes()) != 2 {
		t.Fatalf("writes = %v", fake.writes())
	}
	_ = session.Dispose(testContext(t))
}

// b_emitOnSubscribe delivers a frame the moment a line handler subscribes,
// before the subscribe returns (TS: emitted synchronously inside onLine).
type b_emitOnSubscribe struct {
	*fakeProcess
	frame jsonx.Record
}

func (e b_emitOnSubscribe) OnLine(handler func(string)) {
	e.fakeProcess.OnLine(handler)
	handler(jsonText(e.frame))
}

func TestMissingSessionResultBeforeTheReadbackStartsStillRejectsOpening(t *testing.T) {
	missing := b_missingResume(t)
	fake := newFakeProcess(nil)
	previous := spawnLineProcess
	spawnLineProcess = func(string, []string, executable.LineOptions) (claudeProcess, error) {
		return b_emitOnSubscribe{fake, missing}, nil
	}
	t.Cleanup(func() { spawnLineProcess = previous })
	_, err := Session(testContext(t), resumeInstallation, oar.SessionOptions{Cwd: b_cwd(t), Resume: "missing"})
	var notFound *oar.SessionNotFoundError
	if !errors.As(err, &notFound) {
		t.Fatalf("error = %T %v", err, err)
	}
	if notFound.Method != "initialize" || !b_sameJSON(jsonx.ParseRecord(notFound.Native), missing) {
		t.Fatalf("cause = %s %s", notFound.Method, notFound.Native)
	}
	if len(fake.writes()) != 0 {
		t.Fatalf("writes = %v", fake.writes())
	}
	if !fake.killed() {
		t.Fatal("claude was not stopped")
	}
}

func TestExitBeforeInitializeWithoutAResultNamesTheObservedExit(t *testing.T) {
	fake := newFakeProcess(func(_ string, child *fakeProcess) { child.end(intPtr(1)) })
	useFakeSpawner(t, fake)
	_, err := Session(testContext(t), resumeInstallation, oar.SessionOptions{Cwd: b_cwd(t), Resume: "missing"})
	if err == nil || err.Error() != "claude exited (code 1) before answering initialize, so resume missing cannot be confirmed" {
		t.Fatalf("error = %v", err)
	}
	var readback *readbackError
	if errors.As(err, &readback) {
		t.Fatal("an exit carries no native cause")
	}
}

func TestNativeInitializeRefusalRejectsAResumeAndRetainsItsErrorResponse(t *testing.T) {
	fake := newFakeProcess(func(text string, child *fakeProcess) {
		request := b_requestOf(text)
		child.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "error", "request_id": request["request_id"], "error": "resume refused"}})
	})
	useFakeSpawner(t, fake)
	_, err := Session(testContext(t), resumeInstallation, oar.SessionOptions{Cwd: b_cwd(t), Resume: "old-id"})
	cause := b_asReadbackError(t, err)
	if cause.Method != "initialize" || cause.Native["subtype"] != "error" || cause.Native["error"] != "resume refused" {
		t.Fatalf("cause = %+v", cause)
	}
	if !fake.killed() {
		t.Fatal("claude was not stopped")
	}
}

func TestResumeInitializeHasTheReadbackDeadlineAndKillsAnUnresponsiveProcess(t *testing.T) {
	b_shorten(t, &claudeEffortReadback, 200*time.Millisecond)
	fake := newFakeProcess(nil)
	useFakeSpawner(t, fake)
	_, err := Session(testContext(t), resumeInstallation, oar.SessionOptions{Cwd: b_cwd(t), Resume: "old-id"})
	want := fmt.Sprintf("claude did not answer initialize within %d ms, so resume old-id cannot be confirmed", claudeEffortReadback.Milliseconds())
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v", err)
	}
	if !fake.killed() {
		t.Fatal("claude was not stopped")
	}
}

func TestResumeConfirmsInitializeBeforeEffortAndReusesThatAnswerForTheServiceTier(t *testing.T) {
	var methods []any
	fake := newFakeProcess(func(text string, child *fakeProcess) {
		request := b_requestOf(text)
		method := jsonx.AsRecord(request["request"])["subtype"]
		methods = append(methods, method)
		response := map[string]any{"applied": map[string]any{"effort": "low"}}
		if method == "initialize" {
			response = map[string]any{"fast_mode_state": "on"}
		}
		child.emitJSON(b_controlSuccess(request["request_id"], response))
	})
	useFakeSpawner(t, fake)
	session, err := Session(testContext(t), resumeInstallation, oar.SessionOptions{Cwd: b_cwd(t), Resume: "old-id", Effort: "low", ServiceTier: "fast"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(methods, []any{"initialize", "get_settings", "get_usage"}) {
		t.Fatalf("methods = %v", methods)
	}
	if session.ServiceTier().Value != nil {
		t.Fatalf("service tier = %v", *session.ServiceTier().Value)
	}
	_ = session.Dispose(testContext(t))
}

func TestFreshOpenWithoutReadbackOptionsSendsNoInitialize(t *testing.T) {
	fake := newFakeProcess(nil)
	useFakeSpawner(t, fake)
	session, err := Session(testContext(t), resumeInstallation, oar.SessionOptions{Cwd: b_cwd(t)})
	if err != nil {
		t.Fatal(err)
	}
	if len(fake.writes()) != 0 {
		t.Fatalf("writes = %v", fake.writes())
	}
	_ = session.Dispose(testContext(t))
}

func TestOtherClaudeResultErrorsNeverMeanAMissingSession(t *testing.T) {
	for index, change := range []jsonx.Record{
		{"errors": []any{"Authentication failed"}},
		{"errors": []any{"Provider unavailable", "No conversation found with session ID: missing"}},
		{"errors": []any{"unexpected: No conversation found with session ID: missing"}},
		{"subtype": "error_during_tool_execution"},
	} {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			frame := b_missingResume(t)
			for key, value := range change {
				frame[key] = value
			}
			fake := newFakeProcess(func(_ string, child *fakeProcess) {
				child.emitJSON(frame)
				child.end(intPtr(1))
			})
			useFakeSpawner(t, fake)
			_, err := Session(testContext(t), resumeInstallation, oar.SessionOptions{Cwd: b_cwd(t), Resume: "missing"})
			var notFound *oar.SessionNotFoundError
			if err == nil || errors.As(err, &notFound) {
				t.Fatalf("error = %T %v", err, err)
			}
		})
	}
}

func TestClaudeNeverMapsAMissingSessionLookingResultOnAFreshOpen(t *testing.T) {
	missing := b_missingResume(t)
	fake := newFakeProcess(func(_ string, child *fakeProcess) { child.emitJSON(missing) })
	useFakeSpawner(t, fake)
	_, err := Session(testContext(t), resumeInstallation, oar.SessionOptions{Cwd: b_cwd(t), ServiceTier: "default"})
	var notFound *oar.SessionNotFoundError
	if errors.As(err, &notFound) {
		t.Fatal("a fresh open reported a missing session")
	}
	cause := b_asReadbackError(t, err)
	if cause.Method != "initialize" || !b_sameJSON(cause.Native, missing) {
		t.Fatalf("cause = %+v", cause)
	}
}

func TestMissingLookingResultAfterInitializeSucceedsIsNotAMissingResume(t *testing.T) {
	missing := b_missingResume(t)
	fake := newFakeProcess(func(text string, child *fakeProcess) {
		request := b_requestOf(text)
		method := jsonx.AsRecord(request["request"])["subtype"]
		response := map[string]any{}
		if method == "get_settings" {
			response = map[string]any{"applied": map[string]any{"effort": "low"}}
		}
		child.emitJSON(b_controlSuccess(request["request_id"], response))
		if method == "initialize" {
			child.emitJSON(missing)
		}
	})
	useFakeSpawner(t, fake)
	_, err := Session(testContext(t), resumeInstallation, oar.SessionOptions{Cwd: b_cwd(t), Resume: "existing", Effort: "low"})
	var notFound *oar.SessionNotFoundError
	if errors.As(err, &notFound) {
		t.Fatal("reported a missing session")
	}
	cause := b_asReadbackError(t, err)
	if cause.Method != "get_settings" || !b_sameJSON(cause.Native, missing) {
		t.Fatalf("cause = %+v", cause)
	}
}
