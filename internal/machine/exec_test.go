package machine

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func TestExecShellFreeAndDirContainment(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	env, err := NewLocalEnv(LocalEnvConfig{WorkDir: t.TempDir()})
	if err != nil {
		t.Fatalf("NewLocalEnv: %v", err)
	}
	defer env.Close()

	// Shell metacharacters must be passed verbatim without shell interpretation.
	res, err := env.Exec(ctx, contract.ExecSpec{
		Argv: []string{"/bin/echo", "$(id); echo INJECTED"},
	})
	if err != nil {
		t.Fatalf("Exec echo: %v", err)
	}
	if res.ExitCode != 0 || res.Interrupted {
		t.Fatalf("unexpected ExecResult: %+v", res)
	}
	if strings.TrimSpace(res.Stdout) != "$(id); echo INJECTED" {
		t.Fatalf("shell expansion occurred! stdout=%q", res.Stdout)
	}

	// Directory traversal in ExecSpec.Dir must fail.
	if _, err := env.Exec(ctx, contract.ExecSpec{
		Argv: []string{"/bin/pwd"},
		Dir:  "../",
	}); !errors.Is(err, ErrPathTraversal) {
		t.Fatalf("expected ErrPathTraversal for .. dir, got %v", err)
	}
	if _, err := env.Exec(ctx, contract.ExecSpec{
		Argv: []string{"/bin/pwd"},
		Dir:  "/tmp",
	}); !errors.Is(err, ErrPathTraversal) {
		t.Fatalf("expected ErrPathTraversal for absolute dir, got %v", err)
	}
}

func TestExecScrubsSecretEnv(t *testing.T) {
	ctx := context.Background()
	env, err := NewLocalEnv(LocalEnvConfig{WorkDir: t.TempDir()})
	if err != nil {
		t.Fatalf("NewLocalEnv: %v", err)
	}
	defer env.Close()

	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-should-not-leak")
	t.Setenv("VIBEVALLEY_VAULT_KEY", "vault-secret-should-not-leak")
	envRes, err := env.Exec(ctx, contract.ExecSpec{
		Argv: []string{"/usr/bin/env"},
		Env:  []string{"VIBE_SAFE_FLAG=ok"},
	})
	if err != nil {
		t.Fatalf("Exec env: %v", err)
	}
	if strings.Contains(envRes.Stdout, "sk-ant-should-not-leak") || strings.Contains(envRes.Stdout, "vault-secret-should-not-leak") {
		t.Fatalf("secret leaked into child env:\n%s", envRes.Stdout)
	}
	if !strings.Contains(envRes.Stdout, "VIBE_SAFE_FLAG=ok") {
		t.Fatalf("explicit safe env missing:\n%s", envRes.Stdout)
	}
}

func TestExecThreeLevelProcessTreeKilledWithin4s(t *testing.T) {
	t.Parallel()
	workDir := t.TempDir()
	env, err := NewLocalEnv(LocalEnvConfig{
		EnvID:   "env-tree-kill",
		WorkDir: workDir,
	})
	if err != nil {
		t.Fatalf("NewLocalEnv: %v", err)
	}
	defer env.Close()

	pidFile := filepath.Join(workDir, "pids.txt")
	// 3-level nested subprocesses (level 1 -> level 2 -> level 3) where levels 2 and 3
	// trap SIGTERM so only -pgid SIGKILL after the grace period terminates them.
	script := `
		echo $$ > pids.txt
		sh -c '
			trap "" TERM
			echo $$ >> pids.txt
			sh -c "
				trap \"\" TERM
				echo \$\$ >> pids.txt
				sleep 60
			" &
			wait
		' &
		wait
	`

	execCtx, cancelExec := context.WithCancel(context.Background())
	type execOutcome struct {
		res contract.ExecResult
		err error
	}
	done := make(chan execOutcome, 1)
	go func() {
		res, err := env.Exec(execCtx, contract.ExecSpec{
			Argv: []string{"/bin/sh", "-c", script},
		})
		done <- execOutcome{res: res, err: err}
	}()

	pids := waitForThreePIDs(t, pidFile, 3*time.Second)

	cancelStart := time.Now()
	cancelExec()

	select {
	case out := <-done:
		elapsed := time.Since(cancelStart)
		if elapsed >= 4*time.Second {
			t.Fatalf("3-level process tree took too long to terminate: %s", elapsed)
		}
		if !out.res.Interrupted {
			t.Fatalf("expected Interrupted=true, got %+v (err=%v)", out.res, out.err)
		}
		if !errors.Is(out.err, context.Canceled) {
			t.Fatalf("expected context.Canceled, got %v", out.err)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("Exec did not finish within 4s of cancellation")
	}

	assertAllPIDsDead(t, pids, 500*time.Millisecond)
}

func waitForThreePIDs(t *testing.T, pidFile string, timeout time.Duration) []int {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		raw, err := os.ReadFile(pidFile)
		if err == nil {
			lines := strings.Fields(string(raw))
			if len(lines) == 3 {
				pids := make([]int, 0, 3)
				valid := true
				for _, line := range lines {
					pid, err := strconv.Atoi(line)
					if err != nil || pid <= 0 {
						valid = false
						break
					}
					pids = append(pids, pid)
				}
				if valid {
					return pids
				}
			}
		}
		time.Sleep(15 * time.Millisecond)
	}
	raw, _ := os.ReadFile(pidFile)
	t.Fatalf("timed out waiting for 3 PIDs in %s; got %q", pidFile, string(raw))
	return nil
}

func assertAllPIDsDead(t *testing.T, pids []int, waitLimit time.Duration) {
	t.Helper()
	deadline := time.Now().Add(waitLimit)
	for {
		allDead := true
		for _, pid := range pids {
			err := syscall.Kill(pid, 0)
			if !errors.Is(err, syscall.ESRCH) {
				allDead = false
				break
			}
		}
		if allDead {
			return
		}
		if time.Now().After(deadline) {
			for _, pid := range pids {
				err := syscall.Kill(pid, 0)
				if !errors.Is(err, syscall.ESRCH) {
					t.Errorf("process pid=%d still alive after teardown (kill(0)=%v)", pid, err)
				}
			}
			t.FailNow()
		}
		time.Sleep(10 * time.Millisecond)
	}
}
