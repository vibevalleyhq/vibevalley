package shared

import (
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// SpawnLoginProcess (shared/login.ts spawnLoginProcess). The TS suite covers
// it only through the host-exit backstop (process-host-exit.test.ts), which
// Go does not have for a login process (GAPS.md); these pin the documented
// behavior of the process itself.

type loginOutput struct {
	mu       sync.Mutex
	lines    []string
	partials []string
}

func (o *loginOutput) handlers() LoginOutputHandlers {
	return LoginOutputHandlers{
		OnLine: func(line string, stream LoginStream) {
			o.mu.Lock()
			defer o.mu.Unlock()
			o.lines = append(o.lines, string(stream)+":"+line)
		},
		OnPartial: func(text string, stream LoginStream) {
			o.mu.Lock()
			defer o.mu.Unlock()
			o.partials = append(o.partials, string(stream)+":"+text)
		},
	}
}

func (o *loginOutput) snapshot() ([]string, []string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.lines...), append([]string(nil), o.partials...)
}

func waitLoginExit(t *testing.T, process *LoginProcess, within time.Duration) LoginProcessExit {
	t.Helper()
	select {
	case <-process.Exited():
		return process.Exit()
	case <-time.After(within):
		t.Fatal("the login command did not exit")
		return LoginProcessExit{}
	}
}

func TestLoginProcessReadsBothStreamsBeforeItsExit(t *testing.T) {
	posixOnly(t)
	dir := t.TempDir()
	command := script(t, dir, "login", "printf 'one\\n\\033[1mtwo\\033[0m\\n'\nprintf 'oops\\n' >&2\nprintf 'Paste code here > '\nexit 3\n")
	output := &loginOutput{}
	process := SpawnLoginProcess(command, nil, nil, output.handlers())
	exit := waitLoginExit(t, process, 5*time.Second)
	if exit.ExitCode == nil || *exit.ExitCode != 3 || exit.Signal != "" || exit.Error != "" {
		t.Fatalf("exit = %+v", exit)
	}
	lines, partials := output.snapshot()
	stdout := []string{}
	stderr := []string{}
	for _, line := range lines {
		if strings.HasPrefix(line, "stdout:") {
			stdout = append(stdout, line)
		} else {
			stderr = append(stderr, line)
		}
	}
	// The unterminated prompt is a partial while it waits, and the stream's last line at its end.
	if !reflect.DeepEqual(stdout, []string{"stdout:one", "stdout:two", "stdout:Paste code here >"}) || !reflect.DeepEqual(stderr, []string{"stderr:oops"}) {
		t.Fatalf("lines = %q", lines)
	}
	found := false
	for _, partial := range partials {
		if partial == "stdout:Paste code here > " {
			found = true
		}
	}
	if !found {
		t.Fatalf("partials = %q", partials)
	}
}

func TestLoginProcessWritesStdinUntilItsInputCloses(t *testing.T) {
	posixOnly(t)
	dir := t.TempDir()
	command := script(t, dir, "login", "read first\necho \"got:$first\"\nwhile read more; do echo \"more:$more\"; done\necho done\n")
	output := &loginOutput{}
	process := SpawnLoginProcess(command, nil, nil, output.handlers())
	process.Write("code#state\n")
	process.CloseInput()
	process.Write("dropped\n")
	waitLoginExit(t, process, 5*time.Second)
	lines, _ := output.snapshot()
	if !reflect.DeepEqual(lines, []string{"stdout:got:code#state", "stdout:done"}) {
		t.Fatalf("lines = %q", lines)
	}
	// After the exit a write is a no-op, never a panic.
	process.Write("late\n")
}

func TestLoginProcessStopEndsItsProcessGroup(t *testing.T) {
	posixOnly(t)
	t.Setenv("OAR_KILL_GRACE_MS", "300")
	dir := t.TempDir()
	pidFile := dir + "/worker.pid"
	// The worker ignores SIGTERM: only the group's SIGKILL after the grace ends it.
	command := script(t, dir, "login", "sh -c 'trap \"\" TERM; echo $$ > "+pidFile+"; while :; do sleep 1; done' &\nwait\n")
	process := SpawnLoginProcess(command, nil, nil, (&loginOutput{}).handlers())
	var worker int
	deadline := time.Now().Add(5 * time.Second)
	for worker == 0 {
		if data, err := os.ReadFile(pidFile); err == nil {
			worker, _ = strconv.Atoi(strings.TrimSpace(string(data)))
		}
		if time.Now().After(deadline) {
			t.Fatal("the worker did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	process.Stop()
	process.Stop()
	exit := waitLoginExit(t, process, 10*time.Second)
	if exit.ExitCode != nil || exit.Signal != "SIGTERM" {
		t.Fatalf("exit = %+v", exit)
	}
	deadline = time.Now().Add(5 * time.Second)
	for syscall.Kill(worker, 0) == nil {
		if time.Now().After(deadline) {
			_ = syscall.Kill(worker, syscall.SIGKILL)
			t.Fatal("a process the login started outlived the stop")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestLoginProcessThatCannotStartEndsAtOnce(t *testing.T) {
	process := SpawnLoginProcess(t.TempDir()+"/missing-login", nil, nil, (&loginOutput{}).handlers())
	exit := waitLoginExit(t, process, time.Second)
	if exit.ExitCode != nil || exit.Error == "" || !strings.Contains(exit.Error, "missing-login") {
		t.Fatalf("exit = %+v", exit)
	}
	process.Write("x\n")
	process.Stop()
}

func TestLoginProcessExitIsReportedWhileADescendantHoldsTheOutput(t *testing.T) {
	posixOnly(t)
	dir := t.TempDir()
	command := script(t, dir, "login", "echo before\nsleep 30 &\nexit 0\n")
	output := &loginOutput{}
	started := time.Now()
	process := SpawnLoginProcess(command, nil, nil, output.handlers())
	t.Cleanup(func() { _ = syscall.Kill(-process.cmd.Process.Pid, syscall.SIGKILL) })
	exit := waitLoginExit(t, process, 10*time.Second)
	if exit.ExitCode == nil || *exit.ExitCode != 0 {
		t.Fatalf("exit = %+v", exit)
	}
	if elapsed := time.Since(started); elapsed > 8*time.Second {
		t.Fatalf("the exit waited %s for the held pipes", elapsed)
	}
	lines, _ := output.snapshot()
	if !reflect.DeepEqual(lines, []string{"stdout:before"}) {
		t.Fatalf("lines = %q", lines)
	}
}
