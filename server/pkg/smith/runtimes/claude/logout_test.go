package claude

import (
	"context"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
)

// Ports tests/login/claude-logout.test.ts.

func fakeLogoutClaude(t *testing.T, state map[string]any) fakeCli {
	t.Helper()
	full := map[string]any{"version": "2.1.292", "email": "user@example.com", "loggedIn": true}
	for key, value := range state {
		full[key] = value
	}
	return fakeLoginClaude(t, full)
}

func logoutInstallation(fake fakeCli, version string) oar.AvailableInstallation {
	if version == "" {
		version = "2.1.292 (Claude Code)"
	}
	return oar.AvailableInstallation{Via: "executable", Command: fake.command, Version: version}
}

func logout(t *testing.T, installation oar.AvailableInstallation, timeout time.Duration) oar.LogoutResult {
	t.Helper()
	result, err := Logout(context.Background(), installation, oar.LogoutOptions{Timeout: timeout})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestLogoutSignsOutAndTheStatusReadsLoggedOutAgainWhenAlreadyOut(t *testing.T) {
	fake := fakeLogoutClaude(t, nil)
	assertJSON(t, logout(t, logoutInstallation(fake, ""), 0), `{"kind":"logged_out"}`)
	state := fake.read(t)
	if state["loggedIn"] != false || state["sawClaudeCode"] != false {
		t.Fatalf("state = %v", state)
	}
	// claude answers the same when nothing is stored; the status decides.
	assertJSON(t, logout(t, logoutInstallation(fake, ""), 0), `{"kind":"logged_out"}`)
}

func TestTheLogoutsStdinIsClosed(t *testing.T) {
	fake := fakeLogoutClaude(t, map[string]any{"logoutMode": "stdin"})
	assertJSON(t, logout(t, logoutInstallation(fake, ""), 5000*time.Millisecond), `{"kind":"logged_out"}`)
}

func TestAnAPIKeyInTheEnvironmentStillReadsLoggedIn(t *testing.T) {
	fake := fakeLogoutClaude(t, map[string]any{"envKey": true})
	assertJSON(t, logout(t, logoutInstallation(fake, ""), 0),
		`{"detail":"claude auth logout succeeded, yet claude auth status --json still reads logged in (api_key, from ANTHROPIC_API_KEY)","kind":"failed","reason":"still_logged_in"}`)
	// The stored login is gone all the same; the key is not claude's to remove.
	if fake.read(t)["loggedIn"] != false {
		t.Fatal("still logged in")
	}
}

func TestLogoutFailuresInClaudesWordsAndCrashesRedacted(t *testing.T) {
	var results []oar.LogoutResult
	for _, mode := range []string{"fail", "fail_after_clear", "crash"} {
		results = append(results, logout(t, logoutInstallation(fakeLogoutClaude(t, map[string]any{"logoutMode": mode}), ""), 0))
	}
	assertJSON(t, results, `[
		{"detail":"EACCES: permission denied, unlink '/home/user/.claude/.credentials.json'","kind":"failed","reason":"rejected"},
		{"kind":"logged_out"},
		{"detail":"TypeError: cannot read token [redacted]","kind":"failed","reason":"process_failed"}]`)
}

func TestAStatusThatCannotTellLeavesClaudesOwnReport(t *testing.T) {
	fake := fakeLogoutClaude(t, map[string]any{"statusBroken": true})
	assertJSON(t, logout(t, logoutInstallation(fake, ""), 0), `{"kind":"logged_out"}`)
	if fake.read(t)["loggedIn"] != false {
		t.Fatal("still logged in")
	}
	failing := fakeLogoutClaude(t, map[string]any{"statusBroken": true, "logoutMode": "fail"})
	assertJSON(t, logout(t, logoutInstallation(failing, ""), 0),
		`{"kind":"failed","reason":"rejected","detail":"EACCES: permission denied, unlink '/home/user/.claude/.credentials.json'"}`)
}

func TestPastTheDeadlineTheLogoutIsStoppedAndTheStatusDecides(t *testing.T) {
	fake := fakeLogoutClaude(t, map[string]any{"logoutMode": "hang"})
	assertJSON(t, logout(t, logoutInstallation(fake, ""), 1000*time.Millisecond), `{"detail":"claude auth logout did not finish within 1000 ms","kind":"failed","reason":"timed_out"}`)
	if !pidGone(fake.reportedPid(t, "pid"), 5*time.Second) {
		t.Fatal("claude auth logout outlived the deadline")
	}
	if !pidGone(fake.reportedPid(t, "workerPid"), 5*time.Second) {
		t.Fatal("a process claude started outlived the deadline")
	}
	// Logged out already: a logout that hangs still ends logged_out, since the status reads so.
	signedOut := fakeLogoutClaude(t, map[string]any{"logoutMode": "hang", "loggedIn": false})
	assertJSON(t, logout(t, logoutInstallation(signedOut, ""), 500*time.Millisecond), `{"kind":"logged_out"}`)
}

func TestAClaudeWithoutAuthLogoutOrNotAnExecutableOrMissingRunsNothing(t *testing.T) {
	fake := fakeLogoutClaude(t, nil)
	results := []oar.LogoutResult{
		logout(t, logoutInstallation(fake, "2.1.40 (Claude Code)"), 0),
		logout(t, oar.AvailableInstallation{Via: "bundled"}, 0),
		logout(t, oar.AvailableInstallation{Via: "executable", Command: "no-such-claude-for-oar-tests", Version: "2.1.292"}, 0),
	}
	assertJSON(t, results, `[
		{"detail":"claude 2.1.41 or later is required; this is 2.1.40","kind":"unsupported","reason":"version_unsupported"},
		{"detail":"not a machine-installed executable","kind":"unsupported","reason":"unsupported_installation"},
		{"detail":"claude executable not found: no-such-claude-for-oar-tests","kind":"failed","reason":"process_failed"}]`)
	if _, started := fake.read(t)["logoutStarted"]; started {
		t.Fatal("a logout started")
	}
}

func TestALogoutCommandThatCannotBeSpawnedFailsAtOnce(t *testing.T) {
	result := logout(t, oar.AvailableInstallation{Via: "executable", Command: "invalid\x00binary", Version: "2.1.292"}, 0)
	if result.Kind != "failed" || result.Reason != "process_failed" {
		t.Fatalf("result = %+v", result)
	}
}
