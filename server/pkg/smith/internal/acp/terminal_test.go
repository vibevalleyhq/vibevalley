package acp_test

// Ported from tests/acp/acp-terminal.test.ts.

import (
	"errors"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"syscall"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/acp"
)

func host(t *testing.T, options acp.TerminalHostOptions) *acp.TerminalHost {
	cwd, _ := os.Getwd()
	terminal := acp.NewTerminalHost(cwd, os.Environ(), options)
	t.Cleanup(terminal.Dispose)
	return terminal
}

func TestTerminalRunsWithCwdEnvAndTruncatesAtACharacterBoundary(t *testing.T) {
	terminal := host(t, acp.TerminalHostOptions{})
	cwd, _ := os.Getwd()
	limit := 7.0
	args := []string{"-e", "process.stdout.write((process.env.OAR_TERMINAL_VALUE ?? '') + ':αβγ')"}
	created, err := terminal.Create(acp.CreateTerminalRequest{SessionID: "session-one", Command: nodePath(t), Args: &args, Env: []acp.EnvVariable{{Name: "OAR_TERMINAL_VALUE", Value: "ok"}}, Cwd: &cwd, OutputByteLimit: &limit})
	if err != nil || created.TerminalID == "" {
		t.Fatalf("create: %v", err)
	}
	identity := acp.TerminalRequest{SessionID: "session-one", TerminalID: created.TerminalID}
	status, err := terminal.WaitForExit(identity)
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, status, map[string]any{"exitCode": 0, "signal": nil})
	output, err := terminal.Output(identity)
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, output, map[string]any{"output": ":αβγ", "truncated": true, "exitStatus": map[string]any{"exitCode": 0, "signal": nil}})
	released, err := terminal.Release(identity)
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, released, map[string]any{})
	if _, err := terminal.Output(identity); err == nil || !regexp.MustCompile(`Unknown ACP terminal`).MatchString(err.Error()) {
		t.Fatalf("output after release: %v", err)
	}
}

func TestTerminalHostDisposeKillsUnreleasedCommands(t *testing.T) {
	terminal := host(t, acp.TerminalHostOptions{})
	args := []string{"-e", "setInterval(() => {}, 1000)"}
	if _, err := terminal.Create(acp.CreateTerminalRequest{SessionID: "session-two", Command: nodePath(t), Args: &args}); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { terminal.Dispose(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("dispose did not settle")
	}
}

func TestTerminalSupportsGrokFullShellLine(t *testing.T) {
	terminal := host(t, acp.TerminalHostOptions{ShellCommand: true})
	created, err := terminal.Create(acp.CreateTerminalRequest{SessionID: "session-shell", Command: `"` + nodePath(t) + `" -e "process.stdout.write('shell-ok')"`})
	if err != nil {
		t.Fatal(err)
	}
	identity := acp.TerminalRequest{SessionID: "session-shell", TerminalID: created.TerminalID}
	if _, err := terminal.WaitForExit(identity); err != nil {
		t.Fatal(err)
	}
	output, _ := terminal.Output(identity)
	jsonEqual(t, output, map[string]any{"output": "shell-ok", "truncated": false, "exitStatus": map[string]any{"exitCode": 0, "signal": nil}})
}

func pidGone(pid int, within time.Duration) bool {
	return eventually(func() bool {
		err := syscall.Kill(pid, 0)
		return errors.Is(err, syscall.ESRCH)
	}, within)
}

// POSIX process groups: the shell's background job holds the output pipes,
// so a kill that reached only the shell left the release waiting on it.
func TestTerminalReleaseTakesDownWhatItsCommandStarted(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX process groups")
	}
	terminal := host(t, acp.TerminalHostOptions{ShellCommand: true})
	created, err := terminal.Create(acp.CreateTerminalRequest{SessionID: "session-tree", Command: "sleep 60 & echo $!; wait"})
	if err != nil {
		t.Fatal(err)
	}
	identity := acp.TerminalRequest{SessionID: "session-tree", TerminalID: created.TerminalID}
	job := func() int {
		output, _ := terminal.Output(identity)
		match := regexp.MustCompile(`^\d+`).FindString(output.Output)
		pid, _ := strconv.Atoi(match)
		return pid
	}
	if !eventually(func() bool { return job() != 0 }, 5*time.Second) {
		t.Fatal("the shell reported no background job")
	}
	tool := job()
	started := time.Now()
	if _, err := terminal.Release(identity); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed >= 2*time.Second {
		t.Fatalf("release settled %v after it was called", elapsed)
	}
	if !pidGone(tool, 5*time.Second) {
		t.Fatal("the background job is still running")
	}
}
