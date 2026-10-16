package claude

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
)

// Ports tests/login/claude-login.test.ts. The caller's AbortSignal is the
// login's context.

const loginCode = "fixture-authorization-code#fixture-state"

var loginFakes struct {
	sync.Mutex
	count int
}

func fakeLoginClaude(t *testing.T, state map[string]any) fakeCli {
	t.Helper()
	loginFakes.Lock()
	loginFakes.count++
	name := "claude-" + strconv.Itoa(loginFakes.count)
	loginFakes.Unlock()
	full := map[string]any{"version": "2.1.288", "code": loginCode, "email": "user@example.com", "loggedIn": false, "mode": "paste"}
	for key, value := range state {
		full[key] = value
	}
	return newFakeLoginCli(t, t.TempDir(), name, "fake-claude-login.mjs", full)
}

func loginInstallation(fake fakeCli, version string) oar.AvailableInstallation {
	if version == "" {
		version = "2.1.288 (Claude Code)"
	}
	return oar.AvailableInstallation{Via: "executable", Command: fake.command, Version: version}
}

func loginCtx(t *testing.T) (context.Context, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx, cancel
}

func login(t *testing.T, ctx context.Context, installation oar.AvailableInstallation, interaction *recordedInteraction, timeout time.Duration) oar.LoginResult {
	t.Helper()
	result, err := Login(ctx, installation, interaction.interaction(), oar.LoginOptions{Timeout: timeout})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestLoginRelaysTheURLWritesThePastedCodeAndTheStatusNamesTheAccount(t *testing.T) {
	ctx, _ := loginCtx(t)
	fake := fakeLoginClaude(t, nil)
	interaction := newRecordedInteraction(loginCode)
	result := login(t, ctx, loginInstallation(fake, ""), interaction, 0)
	events, prompts := interaction.recorded()
	assertJSON(t, map[string]any{"result": result, "events": events, "prompts": prompts}, `{
		"events":[{"instructions":"Open this URL and sign in; if the page then shows a code, paste it back.","kind":"auth_url","url":"https://claude.com/cai/oauth/authorize?code=true&client_id=fixture&state=fixture-state"}],
		"prompts":[{"kind":"manual_code","message":"Paste the code shown after signing in","placeholder":"code#state"}],
		"result":{"account":{"email":"user@example.com","method":"claude.ai","plan":"pro"},"kind":"logged_in"}}`)
	state := fake.read(t)
	assertJSON(t, state["received"], `["`+loginCode+`"]`)
	if state["sawClaudeCode"] != false {
		t.Fatalf("sawClaudeCode = %v", state["sawClaudeCode"])
	}
	leaksNothing(t, loginCode, events, prompts, result)
}

func TestAnInvalidCodeAsksAgainAndTheNextCodeSignsIn(t *testing.T) {
	ctx, _ := loginCtx(t)
	fake := fakeLoginClaude(t, nil)
	interaction := newRecordedInteraction("fixture-code-without-state", " "+loginCode+"\n")
	result := login(t, ctx, loginInstallation(fake, ""), interaction, 0)
	if result.Kind != "logged_in" {
		t.Fatalf("result = %+v", result)
	}
	events, prompts := interaction.recorded()
	var messages []string
	for _, prompt := range prompts {
		messages = append(messages, prompt.Message)
	}
	if !reflect.DeepEqual(messages, []string{"Paste the code shown after signing in", "That code was not accepted. Paste the full code shown after signing in"}) {
		t.Fatalf("prompts = %q", messages)
	}
	assertJSON(t, fake.read(t)["received"], `["fixture-code-without-state","`+loginCode+`"]`)
	leaksNothing(t, loginCode, events, prompts, result)
	leaksNothing(t, "fixture-code-without-state", events, prompts, result)
}

func TestAFailedExchangeIsRejectedInClaudesWordsWithTheCodeRedacted(t *testing.T) {
	ctx, _ := loginCtx(t)
	interaction := newRecordedInteraction(loginCode)
	result := login(t, ctx, loginInstallation(fakeLoginClaude(t, map[string]any{"mode": "reject"}), ""), interaction, 0)
	assertJSON(t, result, `{"detail":"invalid_grant for code [redacted]","kind":"failed","reason":"rejected"}`)
	events, _ := interaction.recorded()
	leaksNothing(t, loginCode, events, result)
}

func TestASignInFinishedInTheBrowserEndsTheLoginWhileThePromptIsOpen(t *testing.T) {
	ctx, _ := loginCtx(t)
	fake := fakeLoginClaude(t, map[string]any{"mode": "browser"})
	result := login(t, ctx, loginInstallation(fake, ""), newRecordedInteraction("never"), 0)
	if result.Kind != "logged_in" {
		t.Fatalf("result = %+v", result)
	}
	assertJSON(t, fake.read(t)["received"], `[]`)
}

func TestSuccessThatClaudesOwnStatusDoesNotConfirmIsNotALogin(t *testing.T) {
	ctx, _ := loginCtx(t)
	result := login(t, ctx, loginInstallation(fakeLoginClaude(t, map[string]any{"mode": "unverified"}), ""), newRecordedInteraction(loginCode), 0)
	assertJSON(t, result, `{"detail":"claude auth login reported success, yet claude auth status says logged out","kind":"failed","reason":"not_logged_in"}`)
}

func TestAFailureInClaudesOwnWordsIsReportedInThem(t *testing.T) {
	ctx, _ := loginCtx(t)
	ownWords := newRecordedInteraction(loginCode)
	verifier := newRecordedInteraction(loginCode)
	results := []oar.LoginResult{
		login(t, ctx, loginInstallation(fakeLoginClaude(t, map[string]any{"mode": "own_words"}), ""), ownWords, 0),
		login(t, ctx, loginInstallation(fakeLoginClaude(t, map[string]any{"mode": "verifier"}), ""), verifier, 0),
	}
	assertJSON(t, results, `[{"detail":"This organization does not allow logging in to Claude Code.","kind":"failed","reason":"rejected"},{"detail":"Invalid code verifier","kind":"failed","reason":"rejected"}]`)
	if _, prompts := ownWords.recorded(); len(prompts) != 1 {
		t.Fatalf("own words prompts = %d", len(prompts))
	}
	if _, prompts := verifier.recorded(); len(prompts) != 1 {
		t.Fatalf("verifier prompts = %d", len(prompts))
	}
}

func TestADeadlineAfterLoginSuccessfulIsNotATimeout(t *testing.T) {
	ctx, _ := loginCtx(t)
	fake := fakeLoginClaude(t, map[string]any{"mode": "linger"})
	result := login(t, ctx, loginInstallation(fake, ""), newRecordedInteraction(loginCode), 1500*time.Millisecond)
	assertJSON(t, result, `{"account":{"email":"user@example.com","method":"claude.ai","plan":"pro"},"kind":"logged_in"}`)
	if !pidGone(fake.reportedPid(t, "pid"), 5*time.Second) {
		t.Fatal("claude auth login outlived the deadline")
	}
}

func TestACancelAfterLoginSuccessfulIsNotACancel(t *testing.T) {
	ctx, cancel := loginCtx(t)
	fake := fakeLoginClaude(t, map[string]any{"mode": "linger"})
	interaction := newRecordedInteraction(loginCode)
	interaction.onPrompt = func(oar.ProviderLoginPrompt) { time.AfterFunc(time.Second, cancel) }
	result := login(t, ctx, loginInstallation(fake, ""), interaction, 0)
	assertJSON(t, result, `{"kind":"logged_in"}`)
}

// The probe's own lookup decides (a pinned path must exist, a bare name must be on PATH), not a spawn.
func TestAClaudeThatIsNoLongerThereFailsBeforeAnythingIsSpawned(t *testing.T) {
	ctx, _ := loginCtx(t)
	pinned := filepath.Join(t.TempDir(), "removed", "claude")
	var results []oar.LoginResult
	for _, command := range []string{pinned, "no-such-claude-for-oar-tests"} {
		results = append(results, login(t, ctx, oar.AvailableInstallation{Via: "executable", Command: command, Version: "2.1.288 (Claude Code)"}, newRecordedInteraction(), 0))
	}
	assertJSON(t, results, `[{"kind":"failed","reason":"process_failed","detail":"claude executable not found: `+pinned+`"},
		{"kind":"failed","reason":"process_failed","detail":"claude executable not found: no-such-claude-for-oar-tests"}]`)
}

func TestALoginCommandThatCannotBeSpawnedFailsAtOnce(t *testing.T) {
	ctx, _ := loginCtx(t)
	result := login(t, ctx, oar.AvailableInstallation{Via: "executable", Command: "invalid\x00binary", Version: "2.1.288"}, newRecordedInteraction(), 0)
	if result.Kind != "failed" || result.Reason != "process_failed" {
		t.Fatalf("result = %+v", result)
	}
}

func TestPastTheDeadlineTheLoginIsStoppedWithEverythingItStarted(t *testing.T) {
	ctx, _ := loginCtx(t)
	fake := fakeLoginClaude(t, map[string]any{"mode": "hang"})
	result := login(t, ctx, loginInstallation(fake, ""), newRecordedInteraction("never"), 1000*time.Millisecond)
	assertJSON(t, result, `{"detail":"no sign-in within 1000 ms","kind":"failed","reason":"timed_out"}`)
	if !pidGone(fake.reportedPid(t, "pid"), 5*time.Second) {
		t.Fatal("claude auth login outlived the deadline")
	}
	if !pidGone(fake.reportedPid(t, "workerPid"), 5*time.Second) {
		t.Fatal("a process claude started outlived the deadline")
	}
}

func TestCancellingCancelsTheLoginAndStopsItsProcessGroup(t *testing.T) {
	ctx, cancel := loginCtx(t)
	fake := fakeLoginClaude(t, map[string]any{"mode": "hang"})
	interaction := newRecordedInteraction("never")
	interaction.onPrompt = func(oar.ProviderLoginPrompt) { cancel() }
	result := login(t, ctx, loginInstallation(fake, ""), interaction, 0)
	assertJSON(t, result, `{"kind":"cancelled"}`)
	if !pidGone(fake.reportedPid(t, "workerPid"), 5*time.Second) {
		t.Fatal("a process claude started outlived the cancel")
	}
}

func TestAPromptOrAnEventHandlerThatFailsStopsTheLogin(t *testing.T) {
	ctx, _ := loginCtx(t)
	result := login(t, ctx, loginInstallation(fakeLoginClaude(t, nil), ""), newRecordedInteraction(errors.New("terminal closed")), 0)
	assertJSON(t, result, `{"kind":"failed","reason":"interaction_failed","detail":"terminal closed"}`)
	// TS: an onEvent that throws; Go: one that panics.
	throwing := newRecordedInteraction(loginCode)
	fake := fakeLoginClaude(t, nil)
	interaction := throwing.interaction()
	interaction.OnEvent = func(oar.ProviderLoginEvent) { panic(errors.New("no browser to show the URL in")) }
	thrown, err := Login(ctx, loginInstallation(fake, ""), interaction, oar.LoginOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, thrown, `{"kind":"failed","reason":"interaction_failed","detail":"no browser to show the URL in"}`)
	if fake.read(t)["loggedIn"] != false {
		t.Fatal("the login went on after the event handler failed")
	}
}

func TestAClaudeThatCannotReadAPastedCodeOrACancelledContextStartsNothing(t *testing.T) {
	ctx, _ := loginCtx(t)
	fake := fakeLoginClaude(t, nil)
	assertJSON(t, login(t, ctx, loginInstallation(fake, "2.1.100 (Claude Code)"), newRecordedInteraction(), 0),
		`{"detail":"claude 2.1.126 or later is required; this is 2.1.100","kind":"unsupported","reason":"version_unsupported"}`)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	assertJSON(t, login(t, cancelled, loginInstallation(fake, ""), newRecordedInteraction(), 0), `{"kind":"cancelled"}`)
	if _, started := fake.read(t)["loginStarted"]; started {
		t.Fatal("a login started")
	}
}

func TestAuthStatusReadsClaudeAuthStatusJSON(t *testing.T) {
	var statuses []oar.AuthStatus
	for _, state := range []map[string]any{{"loggedIn": true}, {"loggedIn": false}, {"statusBroken": true}} {
		status, err := AuthStatus(context.Background(), loginInstallation(fakeLoginClaude(t, state), ""), oar.AuthStatusOptions{})
		if err != nil {
			t.Fatal(err)
		}
		statuses = append(statuses, status)
	}
	assertJSON(t, statuses, `[
		{"account":{"email":"user@example.com","method":"claude.ai","plan":"pro"},"kind":"logged_in","source":"claude auth status --json"},
		{"kind":"logged_out","source":"claude auth status --json"},
		{"detail":"claude auth status ended without an answer (exit 2)","kind":"unknown","source":"claude auth status --json"}]`)
}
