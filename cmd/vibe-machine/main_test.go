package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/machine"
)

const maxStaticBinaryBytes = 15 * 1024 * 1024 // 15 MiB

type fakeDialer struct {
	serverSide chan machine.LinkTransport
}

func (d *fakeDialer) Dial(_ context.Context, _, _ string) (machine.LinkTransport, error) {
	c, s := machine.PipeLinkPair()
	d.serverSide <- s
	return c, nil
}

func TestCLIFlagsAndZeroSecretValidation(t *testing.T) {
	t.Parallel()
	workRoot := filepath.Join(t.TempDir(), "work")
	var stdout, stderr bytes.Buffer

	opts, err := parseCLI([]string{
		"--server", "https://control.vibevalley.dev",
		"--work-root", workRoot,
		"--machine-id", "dev-mbp-01",
		"--label", "go,mac",
		"--mcp-target", "jira=http://127.0.0.1:8080/mcp",
		"--sync-interval", "15s",
		"--exec-grace", "2s",
	}, func(string) string { return "" }, &stderr)
	if err != nil {
		t.Fatalf("parseCLI: %v (stderr=%s)", err, stderr.String())
	}
	if opts.Config.ServerURL != "https://control.vibevalley.dev" ||
		opts.Config.WorkRoot != workRoot ||
		opts.Config.MachineID != "dev-mbp-01" ||
		len(opts.Config.Labels) != 2 ||
		len(opts.Config.MCPTargets) != 1 ||
		opts.Config.ExecGracePeriod != 2*time.Second {
		t.Fatalf("unexpected parsed options: %+v", opts)
	}

	// Embedded URL credentials must be rejected by zero-secret validation.
	err = run(context.Background(), []string{
		"--server", "https://user:secret@control.vibevalley.dev",
		"--work-root", workRoot,
		"--machine-id", "m1",
		"--check",
	}, func(string) string { return "" }, &stdout, &stderr, nil)
	if err == nil || !strings.Contains(err.Error(), "credentials") {
		t.Fatalf("expected credentials error, got %v", err)
	}

	// Exec grace > 3s must be rejected.
	if _, err := parseCLI([]string{"--exec-grace", "5s"}, func(string) string { return "" }, &stderr); err == nil {
		t.Fatal("expected --exec-grace > 3s to fail")
	}

	// --version prints version cleanly.
	stdout.Reset()
	if err := run(context.Background(), []string{"--version"}, func(string) string { return "" }, &stdout, &stderr, nil); err != nil {
		t.Fatalf("--version error: %v", err)
	}
	if !strings.Contains(stdout.String(), "vibe-machine") {
		t.Fatalf("unexpected --version output: %q", stdout.String())
	}

	// --check validates node startup without creating any secrets.
	stdout.Reset()
	if err := run(context.Background(), []string{
		"--server", "http://127.0.0.1:8787",
		"--work-root", workRoot,
		"--machine-id", "m-check",
		"--check",
	}, func(string) string { return "" }, &stdout, &stderr, nil); err != nil {
		t.Fatalf("--check error: %v", err)
	}
	if !strings.Contains(stdout.String(), "vibe-machine ready id=m-check") {
		t.Fatalf("unexpected --check output: %q", stdout.String())
	}

	// Outbound dialer loop serves LinkFrames and exits cleanly when context cancels.
	dialer := &fakeDialer{serverSide: make(chan machine.LinkTransport, 1)}
	runCtx, cancelRun := context.WithCancel(context.Background())
	defer cancelRun()
	runDone := make(chan error, 1)
	go func() {
		var out, errOut bytes.Buffer
		runDone <- run(runCtx, []string{
			"--server", "http://127.0.0.1:8787",
			"--work-root", workRoot,
			"--machine-id", "m-dial",
		}, func(string) string { return "" }, &out, &errOut, dialer)
	}()

	srv := <-dialer.serverSide
	defer srv.Close()
	if err := srv.WriteFrame(runCtx, machine.LinkFrame{ID: "p1", Kind: "ping"}); err != nil {
		t.Fatalf("ping write: %v", err)
	}
	pong, err := srv.ReadFrame(runCtx)
	if err != nil || pong.Kind != "pong" {
		t.Fatalf("expected pong, got %+v err=%v", pong, err)
	}
	cancelRun()
	if err := <-runDone; err != nil {
		t.Fatalf("expected clean exit on context cancel, got %v", err)
	}
}

func TestVibeMachineStaticBinaryUnder15MB(t *testing.T) {
	t.Parallel()
	outDir := t.TempDir()
	for _, tc := range []struct {
		name string
		args []string
	}{
		{"default", []string{"build", "-o", filepath.Join(outDir, "vibe-machine-default"), "."}},
		{"stripped", []string{"build", "-ldflags=-s -w", "-o", filepath.Join(outDir, "vibe-machine-stripped"), "."}},
	} {
		goBin := filepath.Join(runtime.GOROOT(), "bin", "go")
		cmd := exec.Command(goBin, tc.args...)
		cmd.Env = append(removeEnvKey(os.Environ(), "GOROOT"), "GOROOT="+runtime.GOROOT(), "CGO_ENABLED=0")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("go %v failed: %v\n%s", tc.args, err, string(out))
		}
		binPath := tc.args[len(tc.args)-2]
		info, err := os.Stat(binPath)
		if err != nil {
			t.Fatalf("stat built binary %s: %v", binPath, err)
		}
		t.Logf("vibe-machine %s static binary size: %d bytes (%.2f MB)", tc.name, info.Size(), float64(info.Size())/(1024*1024))
		if info.Size() <= 0 || info.Size() >= maxStaticBinaryBytes {
			t.Fatalf("%s binary size %d exceeds limit %d", tc.name, info.Size(), maxStaticBinaryBytes)
		}
	}
}

func removeEnvKey(env []string, key string) []string {
	prefix := key + "="
	out := make([]string, 0, len(env))
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			continue
		}
		out = append(out, entry)
	}
	return out
}
