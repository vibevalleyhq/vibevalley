package claude

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Ports the claude cases of tests/input-transport.test.ts,
// tests/launch-args.test.ts and tests/abort-takeover.test.ts.

func TestEmptyInputNeverWritesToTheProcess(t *testing.T) {
	for _, kind := range []string{"prompt", "steer", "queue"} {
		t.Run(kind, func(t *testing.T) {
			ctx := testContext(t)
			cwd, _ := os.Getwd()
			fake, session := openFake(t, oar.SessionOptions{Cwd: cwd})
			defer func() { _ = session.Dispose(ctx) }()
			before := fake.writes()
			var outcome oar.ControlOutcome
			var err error
			options := oar.InputOptions{Images: []oar.InputImage{}}
			switch kind {
			case "prompt":
				outcome, err = session.Prompt(ctx, "", options)
			case "steer":
				outcome, err = session.Steer(ctx, "", options)
			case "queue":
				outcome, err = session.Queue(ctx, "", options)
			}
			if err != nil {
				t.Fatal(err)
			}
			assertJSON(t, outcome.Response.Response, `{"kind":"rejected","code":"unsupported","reason":"empty input: give text or images"}`)
			if after := fake.writes(); !reflect.DeepEqual(after, before) {
				t.Fatalf("written %v, before %v", after, before)
			}
		})
	}
}

func TestAnImageOnlyPromptWritesNoTextBlock(t *testing.T) {
	ctx := testContext(t)
	dir := t.TempDir()
	image := filepath.Join(dir, "dot.png")
	if err := os.WriteFile(image, []byte("png"), 0o600); err != nil {
		t.Fatal(err)
	}
	fake, session := openFake(t, oar.SessionOptions{Cwd: dir})
	defer func() { _ = session.Dispose(ctx) }()
	outcome, err := session.Prompt(ctx, "", oar.InputOptions{Images: []oar.InputImage{{Path: image}}})
	if err != nil || !outcome.IsAccepted() {
		t.Fatalf("prompt = %v %v", outcome.Kind, err)
	}
	writes := fake.writes()
	message := jsonx.ParseRecord([]byte(writes[len(writes)-1]))
	assertJSON(t, jsonx.AsRecord(message["message"])["content"],
		`[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"`+base64.StdEncoding.EncodeToString([]byte("png"))+`"}}]`)
}

// SessionOptions.LaunchArgs (oar#250): the host's own flags, passed
// unchecked where the CLI takes options, and never recorded.
func TestClaudeHostFlagsGoAfterOarsOwnAndBeforeTheVariadicFlags(t *testing.T) {
	const secret = "launch-arg-secret-sentinel"
	ctx := testContext(t)
	fake := newFakeProcess(nil)
	spawner := useFakeSpawner(t, fake)
	launchArgs := []string{"--add-dir", "/extra", "--settings", `{"token":"` + secret + `"}`}
	session, err := Session(ctx, oar.AvailableInstallation{Via: "executable", Command: "claude", Version: "2.1.293"}, oar.SessionOptions{Cwd: "/work", LaunchArgs: launchArgs, DisallowedTools: []string{"Bash"}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = session.Dispose(ctx) }()
	args := spawner.call(0).args
	at := slices.Index(args, launchArgs[0])
	if at < 0 || !reflect.DeepEqual(args[at:at+len(launchArgs)], launchArgs) {
		t.Fatalf("args = %v", args)
	}
	if at <= slices.Index(args, "--dangerously-skip-permissions") || at >= slices.Index(args, "--disallowed-tools") {
		t.Fatalf("launch args misplaced: %v", args)
	}
	encoded, _ := json.Marshal(session.Records())
	if strings.Contains(string(encoded), secret) {
		t.Fatal("launch args were recorded")
	}
}

// cKillSpyProcess is a fakeProcess whose Kill only counts (TS: vi.spyOn(fake, "kill")).
type cKillSpyProcess struct {
	*fakeProcess
	mu     sync.Mutex
	kills  int
	onKill func()
}

func (p *cKillSpyProcess) Kill() {
	p.mu.Lock()
	p.kills++
	onKill := p.onKill
	p.mu.Unlock()
	if onKill != nil {
		onKill()
	}
}

func (p *cKillSpyProcess) killCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.kills
}

// cDeliverNow hands a line to the handlers at once, past an ended stdout
// (TS: fake.stdout.emit("data", ...)).
func (f *fakeProcess) cDeliverNow(line string) {
	f.mu.Lock()
	handlers := append([]func(string){}, f.lineHandlers...)
	f.mu.Unlock()
	for _, handler := range handlers {
		handler(line)
	}
}

func TestClaudeAbortFallbackAcceptsBeforeKilling(t *testing.T) {
	for _, replyAfterExit := range []bool{false, true} {
		t.Run(map[bool]string{false: "late reply before exit", true: "late reply after exit"}[replyAfterExit], func(t *testing.T) {
			ctx := testContext(t)
			previousTimeout := abortFallbackTimeout
			abortFallbackTimeout = 100 * time.Millisecond
			t.Cleanup(func() { abortFallbackTimeout = previousTimeout })
			spy := &cKillSpyProcess{fakeProcess: newFakeProcess(nil)}
			previous := spawnLineProcess
			spawnLineProcess = func(string, []string, executable.LineOptions) (claudeProcess, error) { return spy, nil }
			t.Cleanup(func() { spawnLineProcess = previous })
			session, err := Session(ctx, oar.AvailableInstallation{Via: "executable", Command: "claude", Version: "test"}, oar.SessionOptions{Cwd: "/work"})
			if err != nil {
				t.Fatal(err)
			}
			var killErr string
			spy.mu.Lock()
			spy.onKill = func() {
				records := session.Records()
				last := records[len(records)-1]
				if last.Kind != oar.KindResponse || last.Response.Kind != oar.ResponseAccepted {
					spy.mu.Lock()
					killErr = "the kill came before the accepted answer: " + jsonText(last)
					spy.mu.Unlock()
				}
			}
			spy.mu.Unlock()
			prompt, _ := session.Prompt(ctx, "hold", oar.InputOptions{})
			result, err := session.Abort(ctx)
			if err != nil {
				t.Fatal(err)
			}
			assertJSON(t, result.Response.Response, `{"kind":"accepted"}`)
			// The fallback answers, then kills, under the session lock: the kill may follow the answer's return.
			eventually(t, "the fallback's kill", func() bool { return spy.killCount() == 1 })
			spy.mu.Lock()
			failure := killErr
			spy.mu.Unlock()
			if failure != "" {
				t.Fatal(failure)
			}
			if kind := session.Status().Value.Kind; kind != "running" {
				t.Fatalf("status = %s", kind)
			}
			for _, record := range session.Records() {
				if record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseExited {
					t.Fatal("an exit was recorded")
				}
			}
			repeated, err := session.Abort(ctx)
			if err != nil {
				t.Fatal(err)
			}
			assertJSON(t, repeated.Response.Response, `{"kind":"accepted"}`)
			if spy.killCount() != 1 {
				t.Fatalf("kills = %d", spy.killCount())
			}
			if replyAfterExit {
				spy.end(nil)
				<-spy.Exited()
			}
			native := map[string]any{"type": "control_response", "response": map[string]any{"subtype": "error", "request_id": result.Request.ID}}
			spy.cDeliverNow(jsonText(native))
			records := session.Records()
			last := records[len(records)-1]
			cAssertMatches(t, last, `{"kind":"frame","body":{"native":`+jsonText(native)+`,"events":[]}}`)
			var answers []oar.RawEvent
			for _, record := range records {
				if record.Kind == oar.KindResponse && record.RequestID == result.Request.ID {
					answers = append(answers, record)
				}
			}
			if len(answers) != 1 || answers[0].Seq != result.Response.Seq {
				t.Fatalf("answers = %v", answers)
			}
			spy.end(nil)
			outcome, err := observe.AwaitTurnEnd(ctx, session, prompt.Seq, "")
			if err != nil || outcome.Kind != "aborted" {
				t.Fatalf("turn end = %v %v", outcome, err)
			}
			_ = session.Dispose(ctx)
		})
	}
}
