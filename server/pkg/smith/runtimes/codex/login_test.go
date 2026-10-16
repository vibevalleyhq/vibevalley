//go:build !windows

package codex

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
)

// Ports tests/login/codex-login.test.ts and codex-logout.test.ts, driving
// tests/fixtures/fake-codex-login.mjs. The caller's AbortSignal is the
// login's context.
//
// Not ported: the half of "the app-server's stderr reaches neither the host's
// stderr nor the result" that spies on the host's stderr; the result half is.

type fakeCli struct {
	command   string
	stateFile string
}

var fakeCount struct {
	sync.Mutex
	n int
}

func newFakeCodexCli(t *testing.T, state map[string]any) fakeCli {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH")
	}
	node, _ = filepath.Abs(node)
	fakeCount.Lock()
	fakeCount.n++
	name := "codex-" + strconv.Itoa(fakeCount.n)
	fakeCount.Unlock()
	dir := t.TempDir()
	stateFile := filepath.Join(dir, name+".json")
	encoded, _ := json.Marshal(state)
	if err := os.WriteFile(stateFile, encoded, 0o644); err != nil {
		t.Fatal(err)
	}
	fixture, err := filepath.Abs(filepath.Join("..", "..", "testdata", "fixtures", "fake-codex-login.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	command := filepath.Join(dir, name)
	body := "#!/bin/sh\nexec \"" + node + "\" \"" + fixture + "\" \"${OAR_FAKE_STATE:-" + stateFile + "}\" \"$@\"\n"
	if err := os.WriteFile(command, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	// The first exec of a new file can take most of a second on macOS (its
	// security scan), which would eat a test's deadline: pay it here, against
	// a state file of its own so the fake's record stays untouched.
	warmState := filepath.Join(dir, name+"-warm.json")
	if err := os.WriteFile(warmState, []byte(`{"version":"0.0.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	warm := exec.Command(command, "--version")
	warm.Env = append(os.Environ(), "OAR_FAKE_STATE="+warmState)
	_ = warm.Run()
	return fakeCli{command: command, stateFile: stateFile}
}

func (f fakeCli) read(t *testing.T) map[string]any {
	t.Helper()
	data, err := os.ReadFile(f.stateFile)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func (f fakeCli) reportedPid(t *testing.T, key string) int {
	t.Helper()
	pid, ok := f.read(t)[key].(float64)
	if !ok {
		t.Fatalf("the fake reported no %s", key)
	}
	return int(pid)
}

// gone reports whether pid ends within the time; it SIGKILLs a survivor so a failed test does not leak.
func gone(pid int, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for {
		if err := syscall.Kill(pid, 0); err != nil && !errors.Is(err, syscall.EPERM) {
			return true
		}
		if time.Now().After(deadline) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func loginFake(t *testing.T, state map[string]any) fakeCli {
	full := map[string]any{"version": "0.160.0", "email": "user@example.com", "loggedIn": false, "mode": "success"}
	for key, value := range state {
		full[key] = value
	}
	return newFakeCodexCli(t, full)
}

func loginInstallation(fake fakeCli, version string) oar.AvailableInstallation {
	if version == "" {
		version = "codex-cli 0.160.0"
	}
	return oar.AvailableInstallation{Via: "executable", Command: fake.command, Version: version}
}

// recordedInteraction records what the driver showed; onEvent runs as each event is shown.
type recordedInteraction struct {
	mu      sync.Mutex
	events  []oar.ProviderLoginEvent
	onEvent func(oar.ProviderLoginEvent)
}

func (r *recordedInteraction) interaction() oar.ProviderLoginInteraction {
	return oar.ProviderLoginInteraction{
		OnEvent: func(event oar.ProviderLoginEvent) {
			r.mu.Lock()
			r.events = append(r.events, event)
			hook := r.onEvent
			r.mu.Unlock()
			if hook != nil {
				hook(event)
			}
		},
		Prompt: func(context.Context, oar.ProviderLoginPrompt) (string, error) {
			return "", errors.New("codex asks nothing")
		},
	}
}

func runLogin(t *testing.T, ctx context.Context, installation oar.AvailableInstallation, interaction oar.ProviderLoginInteraction, timeout time.Duration) oar.LoginResult {
	t.Helper()
	result, err := Login(ctx, installation, interaction, oar.LoginOptions{Timeout: timeout})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestTheDeviceCodeAndItsURLAreRelayedAndAccountReadNamesTheAccount(t *testing.T) {
	fake := loginFake(t, nil)
	interaction := &recordedInteraction{}
	result := runLogin(t, testContext(t), loginInstallation(fake, ""), interaction.interaction(), 0)
	sameJSON(t, map[string]any{"result": result, "events": interaction.events}, `{
		"events":[{"kind":"device_code","userCode":"ABCD-EFGH","verificationUri":"https://auth.openai.com/codex/device"},
			{"kind":"info","message":"Device code sign-in must be allowed in your ChatGPT security settings (for a workspace account, by its admin)."}],
		"result":{"account":{"email":"user@example.com","method":"chatgpt","plan":"plus"},"kind":"logged_in"}}`)
	state := fake.read(t)
	sameJSON(t, state["startParams"], `{"type":"chatgptDeviceCode"}`)
	// Never `codex login`, which clears the stored sign-in before the new one completes.
	sameJSON(t, state["invocations"], `["app-server --listen stdio://"]`)
}

func TestFailureRefusedStartCrashAndUnconfirmedSuccessAreReportedApart(t *testing.T) {
	results := make([]oar.LoginResult, 4)
	var wait sync.WaitGroup
	for index, mode := range []string{"failure", "start_error", "crash", "unverified"} {
		fake := loginFake(t, map[string]any{"mode": mode})
		wait.Add(1)
		go func() {
			defer wait.Done()
			results[index], _ = Login(testContext(t), loginInstallation(fake, ""), (&recordedInteraction{}).interaction(), oar.LoginOptions{})
		}()
	}
	wait.Wait()
	sameJSON(t, results, `[
		{"detail":"device code expired","kind":"failed","reason":"rejected"},
		{"detail":"device code login is not enabled for this workspace","kind":"failed","reason":"rejected"},
		{"detail":"codex app-server exited with code 3 before the sign-in completed","kind":"failed","reason":"process_failed"},
		{"detail":"codex reported success, yet account/read shows no account","kind":"failed","reason":"not_logged_in"}]`)
}

func TestTheAppServersStderrDoesNotReachTheResult(t *testing.T) {
	t.Setenv("OAR_CHILD_STDERR", "inherit")
	result := runLogin(t, testContext(t), loginInstallation(loginFake(t, map[string]any{"mode": "crash"}), ""), (&recordedInteraction{}).interaction(), 0)
	if strings.Contains(jsonText(result), "panicked") {
		t.Fatalf("result %s", jsonText(result))
	}
}

func TestOnceCodexReportsSuccessTheLoginStands(t *testing.T) {
	results := []oar.LoginResult{}
	for _, mode := range []string{"read_error", "early"} {
		results = append(results, runLogin(t, testContext(t), loginInstallation(loginFake(t, map[string]any{"mode": mode}), ""), (&recordedInteraction{}).interaction(), 0))
	}
	sameJSON(t, results, `[{"kind":"logged_in"},{"account":{"email":"user@example.com","method":"chatgpt","plan":"plus"},"kind":"logged_in"}]`)
}

func TestADeadlineAfterCodexReportedSuccessIsNotATimeout(t *testing.T) {
	result := runLogin(t, testContext(t), loginInstallation(loginFake(t, map[string]any{"readDelayMs": 1500}), ""), (&recordedInteraction{}).interaction(), time.Second)
	sameJSON(t, result, `{"account":{"email":"user@example.com","method":"chatgpt","plan":"plus"},"kind":"logged_in"}`)
}

func TestAnAbortAfterCodexReportedSuccessIsNotACancelAndStopsWaitingForAccountRead(t *testing.T) {
	ctx, cancel := context.WithCancel(testContext(t))
	interaction := &recordedInteraction{onEvent: func(oar.ProviderLoginEvent) { time.AfterFunc(500*time.Millisecond, cancel) }}
	result := runLogin(t, ctx, loginInstallation(loginFake(t, map[string]any{"readDelayMs": 60_000}), ""), interaction.interaction(), 0)
	sameJSON(t, result, `{"kind":"logged_in"}`)
}

func TestASuccessBeforeTheStartReplyShowsNothingMore(t *testing.T) {
	interaction := (&recordedInteraction{}).interaction()
	interaction.OnEvent = func(oar.ProviderLoginEvent) { panic("no screen") }
	result := runLogin(t, testContext(t), loginInstallation(loginFake(t, map[string]any{"mode": "early"}), ""), interaction, 0)
	if result.Kind != "logged_in" {
		t.Fatalf("result %+v", result)
	}
}

func TestACodexThatIsNoLongerThereFailsBeforeAnythingIsSpawned(t *testing.T) {
	pinned := filepath.Join(t.TempDir(), "removed", "codex")
	results := []oar.LoginResult{}
	for _, command := range []string{pinned, "no-such-codex-for-oar-tests"} {
		results = append(results, runLogin(t, testContext(t), oar.AvailableInstallation{Via: "executable", Command: command, Version: "codex-cli 0.160.0"}, (&recordedInteraction{}).interaction(), 0))
	}
	sameJSON(t, results, jsonText([]map[string]string{
		{"kind": "failed", "reason": "process_failed", "detail": "codex executable not found: " + pinned},
		{"kind": "failed", "reason": "process_failed", "detail": "codex executable not found: no-such-codex-for-oar-tests"},
	}))
}

func TestACommandThatCannotBeSpawnedFailsAtOnce(t *testing.T) {
	dir := t.TempDir()
	command := filepath.Join(dir, "codex")
	// Found, yet not startable: not executable.
	if err := os.WriteFile(command, []byte("not a program"), 0o644); err != nil {
		t.Fatal(err)
	}
	result := runLogin(t, testContext(t), oar.AvailableInstallation{Via: "executable", Command: command, Version: "codex-cli 0.160.0"}, (&recordedInteraction{}).interaction(), 0)
	if result.Kind != "failed" || result.Reason != "process_failed" {
		t.Fatalf("result %+v", result)
	}
}

func TestPastTheDeadlineTheAppServerIsStoppedWithEverythingItStarted(t *testing.T) {
	fake := loginFake(t, map[string]any{"mode": "hang"})
	result := runLogin(t, testContext(t), loginInstallation(fake, ""), (&recordedInteraction{}).interaction(), time.Second)
	sameJSON(t, result, `{"kind":"failed","reason":"timed_out","detail":"no sign-in within 1000 ms"}`)
	if !gone(fake.reportedPid(t, "pid"), 5*time.Second) {
		t.Fatal("the app-server outlived the deadline")
	}
	if !gone(fake.reportedPid(t, "workerPid"), 5*time.Second) {
		t.Fatal("a process the app-server started outlived the deadline")
	}
}

func TestAbortingCancelsTheLoginAndStopsTheAppServersProcessGroup(t *testing.T) {
	fake := loginFake(t, map[string]any{"mode": "hang"})
	ctx, cancel := context.WithCancel(testContext(t))
	interaction := &recordedInteraction{onEvent: func(oar.ProviderLoginEvent) { cancel() }}
	result := runLogin(t, ctx, loginInstallation(fake, ""), interaction.interaction(), 0)
	sameJSON(t, result, `{"kind":"cancelled"}`)
	if !gone(fake.reportedPid(t, "workerPid"), 5*time.Second) {
		t.Fatal("a process the app-server started outlived the cancel")
	}
}

func TestACodexWithoutTheDeviceCodeLoginStartsNothing(t *testing.T) {
	fake := loginFake(t, nil)
	result := runLogin(t, testContext(t), loginInstallation(fake, "codex-cli 0.117.0"), (&recordedInteraction{}).interaction(), 0)
	sameJSON(t, result, `{"detail":"codex 0.118.0 or later is required; this is 0.117.0","kind":"unsupported","reason":"version_unsupported"}`)
	if _, ok := fake.read(t)["invocations"]; ok {
		t.Fatal("codex ran")
	}
}

func TestAuthStatusReadsCodexLoginStatus(t *testing.T) {
	statuses := []oar.AuthStatus{}
	for _, state := range []map[string]any{{"loggedIn": true}, {"loggedIn": false}, {"status": "broken"}} {
		status, err := AuthStatus(testContext(t), loginInstallation(loginFake(t, state), ""), oar.AuthStatusOptions{})
		if err != nil {
			t.Fatal(err)
		}
		statuses = append(statuses, status)
	}
	sameJSON(t, statuses, `[
		{"account":{"method":"chatgpt"},"kind":"logged_in","source":"codex login status"},
		{"kind":"logged_out","source":"codex login status"},
		{"detail":"Error loading configuration: invalid TOML","kind":"unknown","source":"codex login status"}]`)
}

// ─── tests/login/codex-logout.test.ts ───────────────────────────────────────

func logoutFake(t *testing.T, state map[string]any) fakeCli {
	full := map[string]any{"version": "0.160.1", "email": "user@example.com", "loggedIn": true}
	for key, value := range state {
		full[key] = value
	}
	return newFakeCodexCli(t, full)
}

func logout(t *testing.T, installation oar.AvailableInstallation, timeout time.Duration) oar.LogoutResult {
	t.Helper()
	result, err := Logout(testContext(t), installation, oar.LogoutOptions{Timeout: timeout})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func logoutInstallation(fake fakeCli, version string) oar.AvailableInstallation {
	if version == "" {
		version = "codex-cli 0.160.1"
	}
	return oar.AvailableInstallation{Via: "executable", Command: fake.command, Version: version}
}

func TestCodexLogoutSignsOutAndCodexLoginStatusReadsLoggedOut(t *testing.T) {
	fake := logoutFake(t, nil)
	sameJSON(t, logout(t, logoutInstallation(fake, ""), 0), `{"kind":"logged_out"}`)
	if fake.read(t)["loggedIn"] != false {
		t.Fatal("still logged in")
	}
	// `Not logged in`, exit 0: the status decides.
	sameJSON(t, logout(t, logoutInstallation(fake, ""), 0), `{"kind":"logged_out"}`)
	sameJSON(t, fake.read(t)["invocations"], `["logout","login status","logout","login status"]`)
}

func TestCodexsLogoutFailureStillLoggedInAndAnUnreadableStatus(t *testing.T) {
	results := []oar.LogoutResult{}
	for _, state := range []map[string]any{{"logoutMode": "error"}, {"logoutMode": "keeps"}, {"status": "broken"}} {
		results = append(results, logout(t, logoutInstallation(logoutFake(t, state), ""), 0))
	}
	sameJSON(t, results, `[
		{"detail":"Error logging out: failed to delete /home/user/.codex/auth.json: Permission denied (os error 13)","kind":"failed","reason":"rejected"},
		{"detail":"codex logout succeeded, yet codex login status still reads logged in (chatgpt)","kind":"failed","reason":"still_logged_in"},
		{"kind":"logged_out"}]`)
}

func TestPastTheDeadlineTheLogoutIsStoppedWithEverythingItStarted(t *testing.T) {
	fake := logoutFake(t, map[string]any{"logoutMode": "hang"})
	sameJSON(t, logout(t, logoutInstallation(fake, ""), time.Second), `{"detail":"codex logout did not finish within 1000 ms","kind":"failed","reason":"timed_out"}`)
	if !gone(fake.reportedPid(t, "pid"), 5*time.Second) {
		t.Fatal("codex logout outlived the deadline")
	}
	if !gone(fake.reportedPid(t, "workerPid"), 5*time.Second) {
		t.Fatal("a process codex started outlived the deadline")
	}
}

func TestACodexWithoutLogoutABundledOrAMissingOneRunsNothing(t *testing.T) {
	fake := logoutFake(t, nil)
	results := []oar.LogoutResult{
		logout(t, logoutInstallation(fake, "codex-cli 0.14.0"), 0),
		logout(t, oar.AvailableInstallation{Via: "bundled"}, 0),
		logout(t, oar.AvailableInstallation{Via: "executable", Command: "no-such-codex-for-oar-tests", Version: "0.160.1"}, 0),
	}
	sameJSON(t, results, `[
		{"detail":"codex 0.15.0 or later is required; this is 0.14.0","kind":"unsupported","reason":"version_unsupported"},
		{"detail":"not a machine-installed executable","kind":"unsupported","reason":"unsupported_installation"},
		{"detail":"codex executable not found: no-such-codex-for-oar-tests","kind":"failed","reason":"process_failed"}]`)
	if _, ok := fake.read(t)["invocations"]; ok {
		t.Fatal("codex ran")
	}
}
