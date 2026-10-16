//go:build !windows

package executable

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Ported from tests/executable-diagnostics.test.ts and
// tests/executable-version-diagnostics.test.ts. The version tests' mocked
// runner is replaced by real sh scripts that fail the same way.

const diagnosticTail = "native startup failed\n"

func TestRunInRequestedDirectory(t *testing.T) {
	dir := t.TempDir()
	result := Run(context.Background(), "sh", []string{"-c", "pwd -P"}, RunOptions{Dir: dir})
	if !result.OK {
		t.Fatalf("result = %+v", result)
	}
	want, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, err := filepath.EvalSymlinks(strings.TrimSpace(result.Stdout))
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("cwd = %q, want %q", got, want)
	}
}

func TestRunFailureKeepsExitCodeAndBoundedStderrTail(t *testing.T) {
	dir := t.TempDir()
	payload := filepath.Join(dir, "stderr")
	if err := os.WriteFile(payload, []byte(strings.Repeat("x", 65536)+diagnosticTail), 0o644); err != nil {
		t.Fatal(err)
	}
	result := Run(context.Background(), "sh", []string{"-c", `cat "$1" >&2; exit 7`, "sh", payload}, RunOptions{})
	if result.OK {
		t.Fatal("a nonzero exit must not be ok")
	}
	d := result.Diagnostics
	want := strings.Repeat("x", 8192-len(diagnosticTail)) + diagnosticTail
	if d == nil || d.ExitCode == nil || *d.ExitCode != 7 || d.Signal != "" || d.Stderr != want || d.Timeout != 0 || d.Error != "" {
		t.Fatalf("diagnostics = %+v", d)
	}
}

func TestRunTimeoutRetainsCallerDeadline(t *testing.T) {
	t.Setenv("OAR_KILL_GRACE_MS", "100")
	result := Run(context.Background(), "sh", []string{"-c", "sleep 10"}, RunOptions{Timeout: 100 * time.Millisecond})
	if result.OK || result.Diagnostics == nil || result.Diagnostics.Timeout != 100*time.Millisecond {
		t.Fatalf("result = %+v diagnostics = %+v", result, result.Diagnostics)
	}
}

func TestRunExternalSignalIsNotATimeout(t *testing.T) {
	result := Run(context.Background(), "sh", []string{"-c", "printf signal-tail >&2; kill -TERM $$"}, RunOptions{})
	d := result.Diagnostics
	if d == nil || d.ExitCode != nil || d.Signal != "SIGTERM" || d.Stderr != "signal-tail" || d.Timeout != 0 || d.Error != "" {
		t.Fatalf("diagnostics = %+v", d)
	}
}

func TestRunMissingExecutableRetainsSpawnError(t *testing.T) {
	result := Run(context.Background(), "/nonexistent/oar-diagnostic-fixture", nil, RunOptions{})
	if result.OK || result.Diagnostics == nil {
		t.Fatalf("result = %+v", result)
	}
	// TS: {code: "ENOENT", message: "spawn /nonexistent/oar-diagnostic-fixture ENOENT"}.
	if got := result.Diagnostics.Error; got != "spawn /nonexistent/oar-diagnostic-fixture: no such file or directory" {
		t.Fatalf("error = %q", got)
	}
}

func TestRunMaxBufferIsNotATimeout(t *testing.T) {
	result := Run(context.Background(), "sh", []string{"-c", `head -c 3145728 /dev/zero | tr '\0' x >&2`}, RunOptions{})
	d := result.Diagnostics
	if result.OK || d == nil {
		t.Fatalf("result = %+v", result)
	}
	if d.Timeout != 0 || !strings.HasPrefix(d.Error, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") || result.ExitCode != nil || len(d.Stderr) != 8192 {
		t.Fatalf("diagnostics = timeout %v error %q exit %v stderr %d bytes", d.Timeout, d.Error, result.ExitCode, len(d.Stderr))
	}
}

func TestRunInvalidCommandRetainsTheError(t *testing.T) {
	// TS: ERR_INVALID_ARG_VALUE for a NUL in the command.
	result := Run(context.Background(), "invalid\x00binary", nil, RunOptions{})
	if result.OK || result.Diagnostics == nil || result.Diagnostics.Error == "" {
		t.Fatalf("result = %+v", result)
	}
}

func TestRunInvalidTimeoutFailsBeforeSpawning(t *testing.T) {
	for _, timeout := range []time.Duration{-time.Millisecond, 1500 * time.Microsecond} {
		result := Run(context.Background(), "sh", []string{"-c", "sleep 10"}, RunOptions{Timeout: timeout})
		if result.OK || result.Diagnostics == nil || !strings.HasPrefix(result.Diagnostics.Error, "ERR_OUT_OF_RANGE") {
			t.Fatalf("timeout %v: result = %+v", timeout, result)
		}
	}
}

func TestRunCancelledRetainsAbortError(t *testing.T) {
	t.Setenv("OAR_KILL_GRACE_MS", "100")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result := Run(ctx, "sh", []string{"-c", "sleep 10"}, RunOptions{})
	d := result.Diagnostics
	if result.OK || result.ExitCode != nil || d == nil || !strings.HasPrefix(d.Error, "ABORT_ERR") || d.Timeout != 0 {
		t.Fatalf("result = %+v diagnostics = %+v", result, d)
	}
}

func TestLineProcessDrainsStderrAndKeepsItsLast8KiB(t *testing.T) {
	dir := t.TempDir()
	payload := filepath.Join(dir, "stderr")
	if err := os.WriteFile(payload, []byte(strings.Repeat("x", 1024*1024)+diagnosticTail), 0o644); err != nil {
		t.Fatal(err)
	}
	p, err := Spawn("sh", []string{"-c", `cat "$1" >&2; echo drained; exit 7`, "sh", payload}, LineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var lines []string
	p.OnLine(func(line string) { mu.Lock(); lines = append(lines, line); mu.Unlock() })
	waitExited(t, p, 10*time.Second)
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(lines, ",") != "drained" {
		t.Fatalf("lines = %q", lines)
	}
	d := p.Diagnostics()
	want := strings.Repeat("x", 8192-len(diagnosticTail)) + diagnosticTail
	if d.ExitCode == nil || *d.ExitCode != 7 || d.Signal != "" || d.Stderr != want {
		t.Fatalf("diagnostics = exit %v signal %q stderr %d bytes", d.ExitCode, d.Signal, len(d.Stderr))
	}
}

func TestLineProcessDiagnosticsPreserveExitSignal(t *testing.T) {
	p, err := Spawn("sh", []string{"-c", "printf signal-tail >&2; kill -TERM $$"}, LineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	waitExited(t, p, 5*time.Second)
	// The stderr reader may still be appending the last chunk.
	if !eventually(func() bool { return p.Diagnostics().Stderr == "signal-tail" }, 2*time.Second) {
		t.Fatalf("stderr = %q", p.Diagnostics().Stderr)
	}
	d := p.Diagnostics()
	if d.ExitCode != nil || d.Signal != "SIGTERM" {
		t.Fatalf("diagnostics = %+v", d)
	}
}

// The helper side of TestStderrPassthroughStillCapturesTheTail: spawn with
// OAR_CHILD_STDERR=inherit and print the captured tail on stdout.
func TestStderrPassthroughHelper(t *testing.T) {
	if os.Getenv("OAR_EXECUTABLE_PASSTHROUGH_HELPER") != "1" {
		t.Skip("helper process only")
	}
	p, err := Spawn("sh", []string{"-c", "printf passthrough-tail >&2"}, LineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	waitExited(t, p, 5*time.Second)
	eventually(func() bool { return p.Diagnostics().Stderr == "passthrough-tail" }, 2*time.Second)
	// Let the forwarding write land before the helper reports.
	time.Sleep(100 * time.Millisecond)
	_, _ = os.Stdout.WriteString("captured:" + p.Diagnostics().Stderr + "\n")
}

func TestStderrPassthroughStillCapturesTheTail(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestStderrPassthroughHelper$", "-test.count=1")
	cmd.Env = append(os.Environ(), "OAR_EXECUTABLE_PASSTHROUGH_HELPER=1", "OAR_CHILD_STDERR=inherit")
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("helper: %v\n%s\n%s", err, stdout.String(), stderr.String())
	}
	if !strings.Contains(stdout.String(), "captured:passthrough-tail\n") {
		t.Fatalf("helper stdout = %q", stdout.String())
	}
	if stderr.String() != "passthrough-tail" {
		t.Fatalf("forwarded stderr = %q", stderr.String())
	}
}

func TestStderrTruncationKeepsWholeUTF8Characters(t *testing.T) {
	dir := t.TempDir()
	payload := filepath.Join(dir, "stderr")
	if err := os.WriteFile(payload, []byte(strings.Repeat("🌊", 3000)+"END"), 0o644); err != nil {
		t.Fatal(err)
	}
	p, err := Spawn("sh", []string{"-c", `cat "$1" >&2`, "sh", payload}, LineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	waitExited(t, p, 5*time.Second)
	want := strings.Repeat("🌊", 2047) + "END"
	if !eventually(func() bool { return p.Diagnostics().Stderr == want }, 2*time.Second) {
		t.Fatalf("stderr = %d bytes", len(p.Diagnostics().Stderr))
	}
	if len(p.Diagnostics().Stderr) > 8192 {
		t.Fatal("over 8 KiB")
	}
}

// ─── Version probes (executable-version-diagnostics.test.ts) ───────────────

func TestVersionProbeRetainsSpawnError(t *testing.T) {
	dir := t.TempDir()
	// Not executable: the spawn itself fails (TS mocks EINVAL).
	runtime := filepath.Join(dir, "runtime")
	if err := os.WriteFile(runtime, []byte("#!/bin/sh\necho 1.0.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	version, err := ReadVersion(context.Background(), runtime, 5*time.Second, nil)
	want := "Failed to run " + runtime + " --version: exit code unavailable; signal none; spawn " + runtime + ": permission denied"
	if version != "" || err == nil || err.Error() != want {
		t.Fatalf("version %q err %v, want %q", version, err, want)
	}
}

func TestVersionTimeoutIsAnError(t *testing.T) {
	t.Setenv("OAR_KILL_GRACE_MS", "100")
	runtime := script(t, t.TempDir(), "runtime", "[ \"$1\" = warm ] && exit 0\nprintf 'still starting' >&2\nsleep 10\n")
	// The first exec of a new file can take seconds on a busy macOS (the system scans it): run it once so the
	// timeout below measures the script, not the scan.
	if err := exec.Command(runtime, "warm").Run(); err != nil {
		t.Fatal(err)
	}
	version, err := ReadVersion(context.Background(), runtime, 3*time.Second, nil)
	want := "Failed to run " + runtime + " --version: exit code unavailable; signal SIGTERM; timeout after 3000 ms\nstderr (tail):\nstill starting"
	if version != "" || err == nil || err.Error() != want {
		t.Fatalf("version %q err %v, want %q", version, err, want)
	}
}

func TestVersionProbeTerminatedBySignalPreservesIt(t *testing.T) {
	runtime := script(t, t.TempDir(), "runtime", "printf terminated >&2\nkill -TERM $$\n")
	version, err := ReadVersion(context.Background(), runtime, 5*time.Second, nil)
	want := "Failed to run " + runtime + " --version: exit code unavailable; signal SIGTERM\nstderr (tail):\nterminated"
	if version != "" || err == nil || err.Error() != want {
		t.Fatalf("version %q err %v, want %q", version, err, want)
	}
}

func TestVersionNonzeroExitIsAnUnavailableVersion(t *testing.T) {
	dir := t.TempDir()
	argsFile := filepath.Join(dir, "args")
	runtime := script(t, dir, "runtime", `printf '%s' "$*" > "`+argsFile+`"`+"\necho 'unsupported flag' >&2\nexit 2\n")
	version, err := ReadVersion(context.Background(), runtime, 5*time.Second, nil)
	if version != "" || err != nil {
		t.Fatalf("version %q err %v", version, err)
	}
	args, _ := os.ReadFile(argsFile)
	if string(args) != "--version" {
		t.Fatalf("args = %q", args)
	}
}

func TestVersionReadsFirstLineOrWhatTheReaderPicks(t *testing.T) {
	runtime := script(t, t.TempDir(), "runtime", "echo '  fake 1.2.3  '\necho second\n")
	if version, err := ReadVersion(context.Background(), runtime, 5*time.Second, nil); err != nil || version != "fake 1.2.3" {
		t.Fatalf("version %q err %v", version, err)
	}
	last := func(stdout string) string {
		lines := strings.Split(strings.TrimSpace(stdout), "\n")
		return lines[len(lines)-1]
	}
	if version, err := ReadVersion(context.Background(), runtime, 5*time.Second, last); err != nil || version != "second" {
		t.Fatalf("version %q err %v", version, err)
	}
}

// ─── A descendant holding the pipes (executable-probe-pipes.test.ts) ───────

func TestProbeWithDescendantHoldingStdoutSettles(t *testing.T) {
	node := requireNode(t)
	background := fixture(t, "probe-background-child.mjs")
	for _, mode := range []string{"exited", "running", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("OAR_KILL_GRACE_MS", "100")
			probe := newTreeProbe(t, treeProbeOptions{})
			early := "1"
			if mode == "running" {
				early = "0"
			}
			timeout := 2 * time.Second
			if mode == "cancelled" {
				timeout = 60 * time.Second
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan Result, 1)
			go func() {
				done <- Run(ctx, node, []string{background}, RunOptions{Env: append(append([]string{}, probe.env...), "OAR_FIXTURE_EARLY_EXIT="+early), Timeout: timeout})
			}()
			tree := probe.tree()
			if mode != "running" && !gone(tree.Agent, 5*time.Second) {
				t.Fatal("the leader did not exit")
			}
			if mode == "cancelled" {
				cancel()
			}
			var result Result
			select {
			case result = <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("the probe did not settle")
			}
			d := result.Diagnostics
			if result.OK || result.ExitCode != nil || d == nil {
				t.Fatalf("result = %+v", result)
			}
			if mode == "cancelled" {
				if !strings.HasPrefix(d.Error, "ABORT_ERR") {
					t.Fatalf("diagnostics = %+v", d)
				}
			} else if d.Timeout != 2*time.Second {
				t.Fatalf("diagnostics = %+v", d)
			}
			if !gone(tree.Grandchild, 5*time.Second) {
				t.Fatalf("grandchild %s survived", strconv.Itoa(tree.Grandchild))
			}
		})
	}
}
