package shared

import (
	"context"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
)

func intp(value int) *int { return &value }

func TestCommandLogout(t *testing.T) {
	failure := regexp.MustCompile(`^Error: (.+)$`)
	cases := []struct {
		end  LogoutCommandEnd
		want NativeLogout
	}{
		{LogoutCommandEnd{Kind: "timed_out"}, NativeLogout{Kind: "failed", Reason: "timed_out", Detail: "fake did not finish within 2000 ms"}},
		{LogoutCommandEnd{Kind: "exit", ExitCode: intp(0)}, NativeLogout{Kind: "done"}},
		{LogoutCommandEnd{Kind: "exit", ExitCode: intp(1), Stderr: []string{"Error: not logged in", "at frame"}}, NativeLogout{Kind: "failed", Reason: "rejected", Detail: "not logged in"}},
		{LogoutCommandEnd{Kind: "exit", ExitCode: intp(1), Stderr: []string{"first", "last sk-ant-oat01-abcdefghijklmnopqrstuvwxyz"}}, NativeLogout{Kind: "failed", Reason: "rejected", Detail: "last [redacted]"}},
		{LogoutCommandEnd{Kind: "exit", ExitCode: intp(2), Stderr: []string{"boom"}}, NativeLogout{Kind: "failed", Reason: "process_failed", Detail: "boom"}},
		{LogoutCommandEnd{Kind: "exit", ExitCode: intp(1)}, NativeLogout{Kind: "failed", Reason: "process_failed", Detail: "fake exited with code 1"}},
		{LogoutCommandEnd{Kind: "exit", Signal: "SIGTERM"}, NativeLogout{Kind: "failed", Reason: "process_failed", Detail: "fake exited with signal SIGTERM"}},
		{LogoutCommandEnd{Kind: "exit"}, NativeLogout{Kind: "failed", Reason: "process_failed", Detail: "fake exited with signal unknown"}},
	}
	for _, c := range cases {
		if got := CommandLogout(c.end, "fake", 2*time.Second, failure); got != c.want {
			t.Errorf("%+v: got %+v, want %+v", c.end, got, c.want)
		}
	}
}

func TestConfirmedLogout(t *testing.T) {
	done := NativeLogout{Kind: "done"}
	failed := NativeLogout{Kind: "failed", Reason: "rejected", Detail: "no"}
	loggedIn := oar.AuthStatus{Kind: "logged_in", Source: "fake auth status", Account: &oar.LoginAccount{Method: "oauth", Email: "a@example.test"}}
	cases := []struct {
		native NativeLogout
		status oar.AuthStatus
		want   oar.LogoutResult
	}{
		{failed, oar.AuthStatus{Kind: "logged_out"}, oar.LogoutResult{Kind: "logged_out"}},
		{failed, oar.AuthStatus{Kind: "unknown"}, oar.LogoutResult{Kind: "failed", Reason: "rejected", Detail: "no"}},
		{done, oar.AuthStatus{Kind: "unknown"}, oar.LogoutResult{Kind: "logged_out"}},
		{done, loggedIn, oar.LogoutResult{Kind: "failed", Reason: "still_logged_in", Detail: "fake logout succeeded, yet fake auth status still reads logged in (oauth, a@example.test, ANTHROPIC_API_KEY)"}},
	}
	for _, c := range cases {
		if got := ConfirmedLogout(c.native, c.status, "fake logout", []string{"ANTHROPIC_API_KEY"}); got != c.want {
			t.Errorf("got %+v, want %+v", got, c.want)
		}
	}
	if got := ConfirmedLogout(done, oar.AuthStatus{Kind: "logged_in", Source: "s"}, "c", nil); got.Detail != "c succeeded, yet s still reads logged in" {
		t.Errorf("got %+v", got)
	}
}

func TestRunLogoutCommand(t *testing.T) {
	posixOnly(t)
	dir := t.TempDir()
	ok := script(t, dir, "ok", "read line; echo out; exit 0\n")
	end := RunLogoutCommand(context.Background(), ok, nil, nil, 5*time.Second)
	if end.Kind != "exit" || end.ExitCode == nil || *end.ExitCode != 0 || len(end.Stderr) != 0 {
		t.Fatalf("end = %+v", end)
	}
	lines := script(t, dir, "lines", "i=0; while [ $i -lt 25 ]; do printf '\\033[31mline %s\\033[0m\\n\\n' $i >&2; i=$((i+1)); done; exit 1\n")
	end = RunLogoutCommand(context.Background(), lines, nil, nil, 5*time.Second)
	if end.Kind != "exit" || *end.ExitCode != 1 || len(end.Stderr) != 20 || end.Stderr[0] != "line 5" || end.Stderr[19] != "line 24" {
		t.Fatalf("end = %+v", end)
	}
	t.Setenv("OAR_KILL_GRACE_MS", "100")
	hang := script(t, dir, "hang", "sleep 30\n")
	started := time.Now()
	end = RunLogoutCommand(context.Background(), hang, nil, nil, 200*time.Millisecond)
	if end.Kind != "timed_out" || time.Since(started) > 5*time.Second {
		t.Fatalf("end = %+v", end)
	}
	signalled := script(t, dir, "signalled", "kill -TERM $$\n")
	end = RunLogoutCommand(context.Background(), signalled, nil, nil, 5*time.Second)
	if end.Kind != "exit" || end.ExitCode != nil || end.Signal != "SIGTERM" {
		t.Fatalf("end = %+v", end)
	}
	missing := RunLogoutCommand(context.Background(), "/nonexistent/oar-logout", nil, nil, 5*time.Second)
	if missing.Kind != "not_started" || !strings.Contains(missing.Detail, "/nonexistent/oar-logout") {
		t.Fatalf("end = %+v", missing)
	}
	if !reflect.DeepEqual(CommandLogout(end, "signalled", time.Second, nil), NativeLogout{Kind: "failed", Reason: "process_failed", Detail: "signalled exited with signal SIGTERM"}) {
		t.Fatal("a signalled logout is process_failed")
	}
}
