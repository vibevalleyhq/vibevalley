package codex

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Ports the codex parts of tests/launch-args.test.ts,
// abort-takeover.test.ts and input-transport.test.ts.
//
// Not ported: abort-takeover's "late reply after exit" variant. Go's
// LineProcess reports the exit after the last stdout line, so no reply can
// follow it (TS: the stream may still drain after the exit event).

const launchSecret = "launch-arg-secret-sentinel"

func TestTheHostsFlagsGoAfterOarsOverridesAndBeforeListen(t *testing.T) {
	spawner := useFakes(t, rpcServer(func(method string, _ jsonx.Record, _ *fakeProcess) jsonx.Record {
		if method == "initialize" {
			return jsonx.Record{"result": jsonx.Record{}}
		}
		return jsonx.Record{"result": jsonx.Record{"thread": jsonx.Record{"id": "thread-1"}, "model": "gpt-5.5"}}
	}))
	launchArgs := []string{"-c", `service_tier="fast"`, "-c", `note="` + launchSecret + `"`}
	session := mustOpen(t, oar.SessionOptions{LaunchArgs: launchArgs})
	args := spawner.call(0).args
	sameJSON(t, args[:3], `["app-server","-c","sandbox_mode=\"danger-full-access\""]`)
	sameJSON(t, args[len(args)-2-len(launchArgs):], jsonText(append(append([]string{}, launchArgs...), "--listen", "stdio://")))
	if strings.Contains(jsonOf(t, session.Records()), launchSecret) {
		t.Fatal("launch args were recorded")
	}
}

func TestSandboxInheritSkipsTheOverride(t *testing.T) {
	t.Setenv("OAR_CODEX_SANDBOX", "inherit")
	spawner := useFakes(t, rpcServer(func(method string, _ jsonx.Record, _ *fakeProcess) jsonx.Record {
		if method == "initialize" {
			return jsonx.Record{"result": jsonx.Record{}}
		}
		return jsonx.Record{"result": jsonx.Record{"thread": jsonx.Record{"id": "thread-1"}}}
	}))
	mustOpen(t, oar.SessionOptions{})
	sameJSON(t, spawner.call(0).args, `["app-server","--listen","stdio://"]`)
}

// takeoverScript answers codex setup and prompt; interrupts remain unanswered.
func takeoverScript(text string, child *fakeProcess) {
	message := jsonx.ParseRecord([]byte(text))
	id, ok := message["id"].(float64)
	if !ok || message["method"] == "turn/interrupt" {
		return
	}
	result := jsonx.Record{}
	switch message["method"] {
	case "thread/start":
		result = jsonx.Record{"thread": jsonx.Record{"id": "thread"}, "model": "test"}
	case "turn/start":
		result = jsonx.Record{"turn": jsonx.Record{"id": "turn"}}
	}
	child.emitJSON(jsonx.Record{"id": id, "result": result})
}

func interruptID(fake *fakeProcess) any {
	return requestOf(fake, "turn/interrupt")["id"]
}

func TestFallbackAcceptsBeforeKilling(t *testing.T) {
	shortenAbortFallback(t, 100*time.Millisecond)
	fake := newFakeProcess(takeoverScript)
	useFakes(t, fake)
	var killed sync.Mutex
	kills := 0
	var lastAtKill oar.RawEvent
	session := mustOpen(t, oar.SessionOptions{})
	fake.mu.Lock()
	fake.killHook = func() {
		records := session.Records()
		killed.Lock()
		defer killed.Unlock()
		kills++
		lastAtKill = records[len(records)-1]
	}
	fake.mu.Unlock()
	started := prompt(t, session, "hold")
	result := abort(t, session)
	sameJSON(t, responseBody(result), `{"kind":"accepted"}`)
	eventually(t, "the kill", func() bool {
		killed.Lock()
		defer killed.Unlock()
		return kills == 1
	})
	killed.Lock()
	matchJSON(t, lastAtKill, `{"kind":"response","body":{"kind":"accepted"}}`)
	killed.Unlock()
	if session.Status().Value.Kind != "running" {
		t.Fatalf("status %+v", session.Status().Value)
	}
	for _, record := range session.Records() {
		if record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseExited {
			t.Fatal("an exit was recorded")
		}
	}
	repeated := abort(t, session)
	sameJSON(t, responseBody(repeated), `{"kind":"accepted"}`)
	killed.Lock()
	if kills != 1 {
		t.Fatalf("%d kills", kills)
	}
	killed.Unlock()
	sync := attachSync(fake)
	native := jsonx.Record{"code": -1, "message": "late refusal", "data": jsonx.Record{"why": "already stopping"}}
	fake.emitJSON(jsonx.Record{"id": interruptID(fake), "error": native})
	sync.wait(t)
	records := session.Records()
	matchJSON(t, records[len(records)-1], `{"kind":"frame","body":{"native":`+jsonText(native)+`,"events":[]}}`)
	if count := responsesFor(session, result.RequestID); count != 1 {
		t.Fatalf("%d responses", count)
	}
	fake.end(nil, "")
	sameJSON(t, awaitTurnEnd(t, session, started.Seq), `{"kind":"aborted"}`)
}

func TestALateRefusalRetainsErrorDetailsButRedactsMcpCredentialsInsideStrings(t *testing.T) {
	shortenAbortFallback(t, 100*time.Millisecond)
	fake := newFakeProcess(takeoverScript)
	fake.killHook = func() {}
	useFakes(t, fake)
	t.Cleanup(func() { fake.end(nil, "") })
	secret := "fake-token-with-\"quotes\"\nand-newline"
	session := mustOpen(t, oar.SessionOptions{MCPServers: []oar.McpServer{{Name: "echo", Command: "echo", Env: map[string]string{"TOKEN": secret}}}})
	prompt(t, session, "hold")
	abort(t, session)
	sync := attachSync(fake)
	fake.emitJSON(jsonx.Record{"id": interruptID(fake), "error": jsonx.Record{"code": -1, "message": "refused " + secret, "data": jsonx.Record{"credential": secret, "details": []any{secret}}}})
	sync.wait(t)
	records := session.Records()
	sameJSON(t, records[len(records)-1].Frame.Native, `{"code":-1,"data":{"credential":"[redacted]","details":["[redacted]"]},"message":"refused [redacted]"}`)
	fake.end(nil, "")
}

func transportServer(t *testing.T) *fakeProcess {
	fake := rpcServer(func(method string, _ jsonx.Record, _ *fakeProcess) jsonx.Record {
		switch method {
		case "thread/start":
			return jsonx.Record{"result": jsonx.Record{"thread": jsonx.Record{"id": "thread"}}}
		case "turn/start":
			return jsonx.Record{"result": jsonx.Record{"turn": jsonx.Record{"id": "turn"}}}
		}
		return jsonx.Record{"result": jsonx.Record{}}
	})
	useFakes(t, fake)
	return fake
}

func TestAnEmptyInputNeverWritesToTheProcess(t *testing.T) {
	for _, kind := range []string{"prompt", "steer", "queue"} {
		t.Run(kind, func(t *testing.T) {
			fake := transportServer(t)
			session := mustOpen(t, oar.SessionOptions{})
			before := len(fake.writtenRecords())
			var outcome oar.ControlOutcome
			var err error
			switch kind {
			case "prompt":
				outcome, err = session.Prompt(testContext(t), "", oar.InputOptions{Images: []oar.InputImage{}})
			case "steer":
				outcome, err = session.Steer(testContext(t), "", oar.InputOptions{Images: []oar.InputImage{}})
			default:
				outcome, err = session.Queue(testContext(t), "", oar.InputOptions{Images: []oar.InputImage{}})
			}
			if err != nil {
				t.Fatal(err)
			}
			sameJSON(t, responseBody(outcome), `{"kind":"rejected","code":"unsupported","reason":"empty input: give text or images"}`)
			if after := len(fake.writtenRecords()); after != before {
				t.Fatalf("%d writes", after-before)
			}
		})
	}
}

func TestAnImageOnlyPromptWritesNoTextBlock(t *testing.T) {
	dir := t.TempDir()
	image := filepath.Join(dir, "dot.png")
	if err := os.WriteFile(image, []byte("png"), 0o644); err != nil {
		t.Fatal(err)
	}
	fake := transportServer(t)
	session := mustOpen(t, oar.SessionOptions{Cwd: dir})
	result, err := session.Prompt(testContext(t), "", oar.InputOptions{Images: []oar.InputImage{{Path: image}}})
	if err != nil || result.Kind != oar.ResponseAccepted {
		t.Fatalf("result %+v %v", result, err)
	}
	sameJSON(t, jsonx.AsRecord(requestOf(fake, "turn/start")["params"])["input"], jsonText([]any{map[string]any{"type": "localImage", "path": image}}))
}

func TestTheRuntimeIsRegisteredWithEveryCapability(t *testing.T) {
	runtime := Runtime()
	if runtime.ID != "codex" || runtime.Brand.Name == "" || runtime.Session == nil || runtime.ListModels == nil || runtime.AccountUsage == nil || runtime.Login == nil || runtime.Logout == nil || runtime.AuthStatus == nil || runtime.CheckUpdate == nil || runtime.Upgrade == nil || runtime.Install == nil || runtime.InstallPlan == nil || runtime.Installation == nil {
		t.Fatalf("runtime %+v", runtime)
	}
	// claude and pi would open unnamed without a word, codex refuses a blank name before it starts.
	if len(runtime.RefusedSessionOptions) != 0 {
		t.Fatalf("refused %v", runtime.RefusedSessionOptions)
	}
}
