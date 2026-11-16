package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/config"
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
		if tc.name == "stripped" {
			vibeHome := t.TempDir()
			baseEnv := removeEnvKey(removeEnvKey(os.Environ(), "VIBEVALLEY_HOME"), "VIBE_CONFIG")
			subEnv := append(baseEnv, "VIBEVALLEY_HOME="+vibeHome)
			for _, subArgs := range [][]string{{"version"}, {"config", "check"}} {
				subCmd := exec.Command(binPath, subArgs...)
				subCmd.Env = subEnv
				subOut, err := subCmd.CombinedOutput()
				if err != nil {
					t.Fatalf("%s %v failed: %v\n%s", binPath, subArgs, err, string(subOut))
				}
			}
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

func mapGetenv(vars map[string]string) func(string) string {
	return func(key string) string {
		if vars == nil {
			return ""
		}
		return vars[key]
	}
}

func writeTestYAML(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestYAMLConfigPrecedenceAndSubcommands(t *testing.T) {
	t.Parallel()

	t.Run("auto-discovery and precedence Flag > Env > YAML > Defaults", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		vibeHome := filepath.Join(tmp, "vibe-home")
		yamlWork := filepath.Join(tmp, "yaml-work")
		writeTestYAML(t, filepath.Join(vibeHome, "vibevalley.yaml"), `
work_root: `+yamlWork+`
machine:
  server_url: https://yaml.vibevalley.dev
  machine_id: yaml-machine
  labels:
    - yaml-only
  mcp_targets:
    - id: jira
      endpoint: http://127.0.0.1:8080/mcp
  sync_interval: 25s
  flush_timeout: 45s
  exec_grace: 1500ms
`)
		getenv := mapGetenv(map[string]string{
			"VIBEVALLEY_HOME": vibeHome,
			"VIBE_SERVER_URL": "https://env.vibevalley.dev",
			"VIBE_MACHINE_ID": "env-machine",
		})

		var stderr bytes.Buffer
		opts, err := parseCLI([]string{
			"--machine-id", "cli-machine",
			"--label", "cli-go,cli-arm64",
			"--exec-grace", "2500ms",
		}, getenv, &stderr)
		if err != nil {
			t.Fatalf("parseCLI failed: %v (stderr=%s)", err, stderr.String())
		}

		// Changed CLI flags beat Env and YAML:
		if opts.Config.MachineID != "cli-machine" {
			t.Fatalf("MachineID = %q, want cli-machine", opts.Config.MachineID)
		}
		if !reflect.DeepEqual(opts.Config.Labels, []string{"cli-go", "cli-arm64"}) {
			t.Fatalf("Labels = %v, want [cli-go cli-arm64]", opts.Config.Labels)
		}
		if opts.Config.ExecGracePeriod != 2500*time.Millisecond {
			t.Fatalf("ExecGracePeriod = %s, want 2500ms", opts.Config.ExecGracePeriod)
		}

		// Env beats YAML when flag is unchanged:
		if opts.Config.ServerURL != "https://env.vibevalley.dev" {
			t.Fatalf("ServerURL = %q, want https://env.vibevalley.dev", opts.Config.ServerURL)
		}

		// YAML beats Defaults when flag and env are unset:
		if opts.Config.WorkRoot != yamlWork {
			t.Fatalf("WorkRoot = %q, want %q", opts.Config.WorkRoot, yamlWork)
		}
		if opts.Config.SyncInterval != 25*time.Second || opts.Config.FlushTimeout != 45*time.Second {
			t.Fatalf("unexpected YAML durations: sync=%s flush=%s", opts.Config.SyncInterval, opts.Config.FlushTimeout)
		}
		wantTargets := []machine.MCPTarget{{ID: "jira", Endpoint: "http://127.0.0.1:8080/mcp"}}
		if !reflect.DeepEqual(opts.Config.MCPTargets, wantTargets) {
			t.Fatalf("MCPTargets = %+v, want %+v", opts.Config.MCPTargets, wantTargets)
		}
	})

	t.Run("explicit --config, VIBE_CONFIG, errors, and --version bypass", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		vibeHome := filepath.Join(tmp, "vibe-home")
		customPath := filepath.Join(tmp, "custom.yaml")
		envPath := filepath.Join(tmp, "env.yaml")
		writeTestYAML(t, customPath, "machine:\n  machine_id: from-flag-config\n")
		writeTestYAML(t, envPath, "machine:\n  machine_id: from-env-config\n")

		var out, errBuf bytes.Buffer
		opts, err := parseCLI([]string{"-c", customPath}, mapGetenv(map[string]string{
			"VIBEVALLEY_HOME": vibeHome,
			"VIBE_CONFIG":     envPath,
		}), &errBuf)
		if err != nil {
			t.Fatalf("parseCLI -c failed: %v", err)
		}
		if opts.Config.MachineID != "from-flag-config" {
			t.Fatalf("MachineID = %q, want from-flag-config", opts.Config.MachineID)
		}

		opts, err = parseCLI(nil, mapGetenv(map[string]string{
			"VIBEVALLEY_HOME": vibeHome,
			"VIBE_CONFIG":     envPath,
		}), &errBuf)
		if err != nil {
			t.Fatalf("parseCLI VIBE_CONFIG failed: %v", err)
		}
		if opts.Config.MachineID != "from-env-config" {
			t.Fatalf("MachineID = %q, want from-env-config", opts.Config.MachineID)
		}

		missingPath := filepath.Join(tmp, "missing.yaml")
		if err := run(context.Background(), []string{"--config", missingPath}, mapGetenv(map[string]string{"VIBEVALLEY_HOME": vibeHome}), &out, &errBuf, nil); err == nil || !strings.Contains(err.Error(), missingPath) {
			t.Fatalf("expected missing --config error referencing %q, got %v", missingPath, err)
		}
		if err := run(context.Background(), nil, mapGetenv(map[string]string{"VIBEVALLEY_HOME": vibeHome, "VIBE_CONFIG": missingPath}), &out, &errBuf, nil); err == nil || !strings.Contains(err.Error(), missingPath) {
			t.Fatalf("expected missing VIBE_CONFIG error referencing %q, got %v", missingPath, err)
		}

		// --version and version subcommand must work even if --config or VIBE_CONFIG points to a missing file.
		out.Reset()
		if err := run(context.Background(), []string{"--version", "--config", missingPath}, mapGetenv(map[string]string{"VIBEVALLEY_HOME": vibeHome}), &out, &errBuf, nil); err != nil {
			t.Fatalf("--version with missing --config failed: %v", err)
		}
		if !strings.Contains(out.String(), "vibe-machine "+version) {
			t.Fatalf("unexpected --version output: %q", out.String())
		}

		out.Reset()
		if err := run(context.Background(), []string{"version", "--config", missingPath}, mapGetenv(map[string]string{"VIBEVALLEY_HOME": vibeHome}), &out, &errBuf, nil); err != nil {
			t.Fatalf("version subcommand failed: %v", err)
		}
		if !strings.Contains(out.String(), "vibe-machine "+version) {
			t.Fatalf("unexpected version subcommand output: %q", out.String())
		}
	})

	t.Run("config check and config print subcommands", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		vibeHome := filepath.Join(tmp, "vibe-home")
		yamlPath := filepath.Join(tmp, "machine.yaml")
		workRoot := filepath.Join(tmp, "work")
		writeTestYAML(t, yamlPath, `
work_root: `+workRoot+`
machine:
  server_url: https://yaml.vibevalley.dev
  machine_id: cfg-mach
  labels: [go, linux]
deepseek:
  api_key: sk-yaml-secret-value
secrets:
  github_token: ghp_secret_token_value
`)
		getenv := mapGetenv(map[string]string{
			"VIBEVALLEY_HOME":  vibeHome,
			"DEEPSEEK_API_KEY": "sk-env-secret-value",
		})

		var out, errBuf bytes.Buffer
		if err := run(context.Background(), []string{"config", "check", "--config", yamlPath}, getenv, &out, &errBuf, nil); err != nil {
			t.Fatalf("config check failed: %v", err)
		}
		if !strings.Contains(out.String(), "ok") || !strings.Contains(out.String(), yamlPath) {
			t.Fatalf("unexpected config check output: %q", out.String())
		}

		out.Reset()
		if err := run(context.Background(), []string{"config", "check"}, getenv, &out, &errBuf, nil); err != nil {
			t.Fatalf("config check defaults failed: %v", err)
		}
		if !strings.Contains(out.String(), "ok") {
			t.Fatalf("unexpected config check defaults output: %q", out.String())
		}

		badPath := filepath.Join(tmp, "bad.yaml")
		writeTestYAML(t, badPath, "machine:\n  exec_grace: 10s\n")
		if err := run(context.Background(), []string{"config", "check", "-c", badPath}, getenv, &out, &errBuf, nil); err == nil {
			t.Fatal("expected config check to fail on exec_grace > 3s")
		}

		out.Reset()
		if err := run(context.Background(), []string{"config", "print", "-c", yamlPath, "--server", "https://flag.vibevalley.dev"}, getenv, &out, &errBuf, nil); err != nil {
			t.Fatalf("config print failed: %v", err)
		}
		printed := out.String()
		for _, secret := range []string{"sk-yaml-secret-value", "sk-env-secret-value", "ghp_secret_token_value"} {
			if strings.Contains(printed, secret) {
				t.Fatalf("config print leaked secret %q:\n%s", secret, printed)
			}
		}
		if !strings.Contains(printed, config.RedactedValue) {
			t.Fatalf("config print missing %q:\n%s", config.RedactedValue, printed)
		}
		if !strings.Contains(printed, "https://flag.vibevalley.dev") {
			t.Fatalf("config print did not apply --server flag override:\n%s", printed)
		}
	})

	t.Run("check and serve subcommands", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		vibeHome := filepath.Join(tmp, "vibe-home")
		workRoot := filepath.Join(tmp, "work")
		yamlPath := filepath.Join(tmp, "serve.yaml")
		writeTestYAML(t, yamlPath, `
work_root: `+workRoot+`
machine:
  server_url: http://127.0.0.1:8787
  machine_id: subcmd-mach
`)
		getenv := mapGetenv(map[string]string{"VIBEVALLEY_HOME": vibeHome})

		var out, errBuf bytes.Buffer
		if err := run(context.Background(), []string{"check", "-c", yamlPath}, getenv, &out, &errBuf, nil); err != nil {
			t.Fatalf("check subcommand failed: %v", err)
		}
		if !strings.Contains(out.String(), "vibe-machine ready id=subcmd-mach") {
			t.Fatalf("unexpected check subcommand output: %q", out.String())
		}

		if err := run(context.Background(), []string{"check", "--server", "https://user:secret@control.vibevalley.dev", "--work-root", workRoot}, getenv, &out, &errBuf, nil); err == nil || !strings.Contains(err.Error(), "credentials") {
			t.Fatalf("expected credentials error from check subcommand, got %v", err)
		}

		dialer := &fakeDialer{serverSide: make(chan machine.LinkTransport, 1)}
		runCtx, cancelRun := context.WithCancel(context.Background())
		defer cancelRun()
		runDone := make(chan error, 1)
		go func() {
			var serveOut, serveErr bytes.Buffer
			runDone <- run(runCtx, []string{"serve", "-c", yamlPath}, getenv, &serveOut, &serveErr, dialer)
		}()

		srv := <-dialer.serverSide
		defer srv.Close()
		if err := srv.WriteFrame(runCtx, machine.LinkFrame{ID: "p1", Kind: "ping"}); err != nil {
			t.Fatalf("ping write: %v", err)
		}
		pong, err := srv.ReadFrame(runCtx)
		if err != nil || pong.Kind != "pong" {
			t.Fatalf("expected pong from serve subcommand, got %+v err=%v", pong, err)
		}
		cancelRun()
		if err := <-runDone; err != nil {
			t.Fatalf("expected clean serve exit on cancel, got %v", err)
		}
	})
}
