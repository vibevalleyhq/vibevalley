package config_test

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/spf13/pflag"

	"github.com/vibevalleyhq/vibevalley/internal/config"
)

func mapGetenv(vars map[string]string) func(string) string {
	return func(key string) string {
		if vars == nil {
			return ""
		}
		return vars[key]
	}
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestDefaultsWithoutYAML(t *testing.T) {
	t.Parallel()

	fakeHome := t.TempDir()
	getenv := mapGetenv(map[string]string{"HOME": fakeHome})

	want := config.DefaultConfig(getenv)
	got, loadedPath, err := config.Load(config.LoadOptions{Getenv: getenv})
	if err != nil {
		t.Fatalf("Load defaults failed: %v", err)
	}
	if loadedPath != "" {
		t.Fatalf("expected empty loadedPath without yaml, got %q", loadedPath)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Load defaults mismatch:\n got: %+v\nwant: %+v", got, want)
	}

	expectedHome := filepath.Join(fakeHome, ".vibevalley")
	if got.HomeDir != expectedHome {
		t.Fatalf("HomeDir = %q, want %q", got.HomeDir, expectedHome)
	}
	if got.WorkRoot != filepath.Join(expectedHome, "work") {
		t.Fatalf("WorkRoot = %q, want %q", got.WorkRoot, filepath.Join(expectedHome, "work"))
	}
	if got.Server.Addr != "127.0.0.1:8787" ||
		got.Server.PreviewAddr != "127.0.0.1:0" ||
		got.Server.DBPath != ":memory:" ||
		got.Server.WorkRoot != "" ||
		got.Server.ReadyJSON ||
		got.Server.AllowLoopbackEgress {
		t.Fatalf("unexpected default Server section: %+v", got.Server)
	}
	if got.Machine.WorkRoot != filepath.Join(expectedHome, "work") ||
		got.Machine.MachineID == "" ||
		got.Machine.SyncInterval != 15*time.Second ||
		got.Machine.FlushTimeout != 30*time.Second ||
		got.Machine.ExecGrace != 2*time.Second {
		t.Fatalf("unexpected default Machine section: %+v", got.Machine)
	}
	if got.Desktop.Scheme != "vibe" ||
		got.Desktop.RootKeyID != "desktop-master-v1" ||
		got.Desktop.KeychainService != "com.vibevalley.desktop.vault" ||
		got.Desktop.DBPath != ":memory:" {
		t.Fatalf("unexpected default Desktop section: %+v", got.Desktop)
	}
}

func TestLoadDoesNotLeakProcessEnv(t *testing.T) {
	poisonHome := filepath.Join(t.TempDir(), "poison-home")
	poisonConfig := filepath.Join(t.TempDir(), "nonexistent-poison.yaml")
	t.Setenv("VIBEVALLEY_HOME", poisonHome)
	t.Setenv("VIBEVALLEY_WORK_ROOT", "/poison/work")
	t.Setenv("VIBE_CONFIG", poisonConfig)
	t.Setenv("VIBE_SERVER_ADDR", "10.0.0.9:9999")
	t.Setenv("VIBE_DB_PATH", "/poison/db.sqlite")
	t.Setenv("VIBE_ALLOW_LOOPBACK_EGRESS", "true")
	t.Setenv("VIBE_SERVER_URL", "https://poison.example.com")
	t.Setenv("VIBE_MACHINE_ID", "poison-machine")
	t.Setenv("DEEPSEEK_API_KEY", "sk-poison-leak")

	isolatedHome := filepath.Join(t.TempDir(), "isolated-home")
	cfg, loadedPath, err := config.Load(config.LoadOptions{
		Getenv: mapGetenv(map[string]string{"VIBEVALLEY_HOME": isolatedHome}),
	})
	if err != nil {
		t.Fatalf("Load with isolated getenv failed: %v", err)
	}
	if loadedPath != "" {
		t.Fatalf("expected no YAML loaded, got %q", loadedPath)
	}
	if cfg.HomeDir != isolatedHome {
		t.Fatalf("HomeDir leaked process env: got %q, want %q", cfg.HomeDir, isolatedHome)
	}
	if cfg.Server.Addr != "127.0.0.1:8787" ||
		cfg.Server.DBPath != ":memory:" ||
		cfg.Server.AllowLoopbackEgress ||
		cfg.Machine.ServerURL != "" ||
		cfg.DeepSeek.APIKey != "" {
		t.Fatalf("process env leaked into loaded config: %+v", cfg)
	}
}

func TestResolvePathAutoDiscoveryAndYAMLErrors(t *testing.T) {
	t.Parallel()

	vibeHome := filepath.Join(t.TempDir(), "vibe-home")
	autoPath := filepath.Join(vibeHome, "vibevalley.yaml")
	writeTestFile(t, autoPath, `
server:
  addr: 127.0.0.1:9100
  ready_json: true
`)

	getenv := mapGetenv(map[string]string{"VIBEVALLEY_HOME": vibeHome})
	resolved, explicit := config.ResolvePath("", getenv)
	if resolved != autoPath || explicit {
		t.Fatalf("ResolvePath auto = (%q, %v), want (%q, false)", resolved, explicit, autoPath)
	}

	cfg, loadedPath, err := config.Load(config.LoadOptions{Getenv: getenv})
	if err != nil {
		t.Fatalf("auto-discovery Load failed: %v", err)
	}
	if loadedPath != autoPath {
		t.Fatalf("loadedPath = %q, want %q", loadedPath, autoPath)
	}
	if cfg.Server.Addr != "127.0.0.1:9100" || !cfg.Server.ReadyJSON {
		t.Fatalf("unexpected auto-discovered server config: %+v", cfg.Server)
	}

	// Explicit --config missing -> must return error referencing path.
	missingPath := filepath.Join(t.TempDir(), "does-not-exist.yaml")
	if resolved, explicit := config.ResolvePath(missingPath, getenv); resolved != missingPath || !explicit {
		t.Fatalf("ResolvePath explicit = (%q, %v), want (%q, true)", resolved, explicit, missingPath)
	}
	if _, _, err := config.Load(config.LoadOptions{ConfigFile: missingPath, Getenv: getenv}); err == nil || !strings.Contains(err.Error(), missingPath) {
		t.Fatalf("expected missing explicit config error containing %q, got %v", missingPath, err)
	}

	// Explicit VIBE_CONFIG missing -> must return error referencing path.
	envWithMissing := mapGetenv(map[string]string{
		"VIBEVALLEY_HOME": vibeHome,
		"VIBE_CONFIG":     missingPath,
	})
	if _, _, err := config.Load(config.LoadOptions{Getenv: envWithMissing}); err == nil || !strings.Contains(err.Error(), missingPath) {
		t.Fatalf("expected missing VIBE_CONFIG error containing %q, got %v", missingPath, err)
	}

	// Malformed YAML syntax -> error wrapped with path.
	malformedPath := filepath.Join(t.TempDir(), "malformed.yaml")
	writeTestFile(t, malformedPath, "server:\n  addr: [unclosed\n")
	if _, _, err := config.Load(config.LoadOptions{ConfigFile: malformedPath, Getenv: getenv}); err == nil || !strings.Contains(err.Error(), malformedPath) {
		t.Fatalf("expected malformed YAML error containing %q, got %v", malformedPath, err)
	}

	// Unknown top-level and nested YAML keys -> rejected cleanly with path & key.
	unknownTopPath := filepath.Join(t.TempDir(), "unknown-top.yaml")
	writeTestFile(t, unknownTopPath, "bogus_section:\n  foo: bar\n")
	if _, _, err := config.Load(config.LoadOptions{ConfigFile: unknownTopPath, Getenv: getenv}); err == nil || !strings.Contains(err.Error(), unknownTopPath) || !strings.Contains(err.Error(), "bogus_section") {
		t.Fatalf("expected unknown top-level key error, got %v", err)
	}

	unknownNestedPath := filepath.Join(t.TempDir(), "unknown-nested.yaml")
	writeTestFile(t, unknownNestedPath, "server:\n  addr: 127.0.0.1:8080\n  unknown_opt: true\n")
	if _, _, err := config.Load(config.LoadOptions{ConfigFile: unknownNestedPath, Getenv: getenv}); err == nil || !strings.Contains(err.Error(), unknownNestedPath) || !strings.Contains(err.Error(), "server.unknown_opt") {
		t.Fatalf("expected unknown nested key error, got %v", err)
	}

	// Non-map YAML root, invalid bool, invalid duration -> rejected cleanly with path.
	nonMapPath := filepath.Join(t.TempDir(), "list-root.yaml")
	writeTestFile(t, nonMapPath, "- item1\n- item2\n")
	if _, _, err := config.Load(config.LoadOptions{ConfigFile: nonMapPath, Getenv: getenv}); err == nil || !strings.Contains(err.Error(), nonMapPath) {
		t.Fatalf("expected non-map YAML error containing %q, got %v", nonMapPath, err)
	}

	badDurationPath := filepath.Join(t.TempDir(), "bad-duration.yaml")
	writeTestFile(t, badDurationPath, "machine:\n  sync_interval: not-a-duration\n")
	if _, _, err := config.Load(config.LoadOptions{ConfigFile: badDurationPath, Getenv: getenv}); err == nil || !strings.Contains(err.Error(), badDurationPath) {
		t.Fatalf("expected bad duration error containing %q, got %v", badDurationPath, err)
	}

	badBoolPath := filepath.Join(t.TempDir(), "bad-bool.yaml")
	writeTestFile(t, badBoolPath, "server:\n  ready_json: maybe\n")
	if _, _, err := config.Load(config.LoadOptions{ConfigFile: badBoolPath, Getenv: getenv}); err == nil || !strings.Contains(err.Error(), badBoolPath) {
		t.Fatalf("expected bad bool error containing %q, got %v", badBoolPath, err)
	}

	// Comment-only/empty YAML file -> valid, loads defaults cleanly.
	emptyYAMLPath := filepath.Join(t.TempDir(), "empty.yaml")
	writeTestFile(t, emptyYAMLPath, "# comment only\n")
	emptyCfg, loadedEmpty, err := config.Load(config.LoadOptions{ConfigFile: emptyYAMLPath, Getenv: getenv})
	if err != nil {
		t.Fatalf("expected empty YAML to succeed, got %v", err)
	}
	if loadedEmpty != emptyYAMLPath || emptyCfg.Server.Addr != "127.0.0.1:8787" {
		t.Fatalf("unexpected empty YAML result: loaded=%q cfg=%+v", loadedEmpty, emptyCfg)
	}

	// Invalid VIBE_ALLOW_LOOPBACK_EGRESS env var -> explicit error.
	if _, _, err := config.Load(config.LoadOptions{
		Getenv: mapGetenv(map[string]string{
			"VIBEVALLEY_HOME":            vibeHome,
			"VIBE_ALLOW_LOOPBACK_EGRESS": "not-a-bool",
		}),
	}); err == nil || !strings.Contains(err.Error(), "VIBE_ALLOW_LOOPBACK_EGRESS") {
		t.Fatalf("expected VIBE_ALLOW_LOOPBACK_EGRESS error, got %v", err)
	}
}

func TestStrictPrecedenceFlagOverEnvOverYAMLOverDefaults(t *testing.T) {
	t.Parallel()

	tmp := t.TempDir()
	vibeHome := filepath.Join(tmp, "home")
	yamlWork := filepath.Join(tmp, "yaml-work")
	yamlSrvWork := filepath.Join(tmp, "yaml-srv-work")
	envWork := filepath.Join(tmp, "env-work")
	flagSrvWork := filepath.Join(tmp, "flag-srv-work")
	yamlPath := filepath.Join(tmp, "custom.yaml")

	writeTestFile(t, yamlPath, `
work_root: `+yamlWork+`
server:
  addr: 127.0.0.1:9001
  preview_addr: 127.0.0.1:9002
  db_path: /yaml/server.db
  work_root: `+yamlSrvWork+`
  artifact_dir: /yaml/artifacts
  allow_loopback_egress: false
machine:
  server_url: https://yaml.example.com
  machine_id: yaml-machine
  labels:
    - yaml-label
  sync_interval: 20s
desktop:
  server_url: https://yaml-desktop.example.com
  web_dist: /yaml/web-dist
  automation_socket: /yaml/auto.sock
  db_path: /yaml/desktop.db
deepseek:
  api_key: sk-yaml-key
secrets:
  github_token: ghp-yaml-token
`)

	getenv := mapGetenv(map[string]string{
		"VIBEVALLEY_HOME":            vibeHome,
		"VIBEVALLEY_WORK_ROOT":       envWork,
		"VIBE_SERVER_ADDR":           "127.0.0.1:9101",
		"VIBE_DB_PATH":               "/env/shared.db",
		"VIBE_ALLOW_LOOPBACK_EGRESS": "true",
		"VIBE_SERVER_URL":            "https://env.example.com",
		"VIBE_MACHINE_ID":            "env-machine",
		"MYGO_AUTOMATION":            "/env/auto.sock",
		"DEEPSEEK_API_KEY":           "sk-env-key",
	})

	fs := pflag.NewFlagSet("test-cli", pflag.ContinueOnError)
	fs.String("addr", "127.0.0.1:7777", "")
	fs.String("preview-addr", "127.0.0.1:7778", "")
	fs.String("work-root", "/unchanged/work", "")
	fs.String("db", "/unchanged/db.sqlite", "")
	fs.Bool("allow-loopback-egress", false, "")
	fs.String("machine-id", "unchanged-machine", "")
	fs.StringSlice("label", []string{"unchanged-label"}, "")
	fs.String("deepseek-key", "sk-unchanged", "")
	fs.String("config", "", "")

	// Only --addr, --work-root, and --label are passed; all other flags remain unchanged!
	if err := fs.Parse([]string{
		"--addr", "127.0.0.1:9201",
		"--work-root", flagSrvWork,
		"--label", "flag-go,flag-arm64",
	}); err != nil {
		t.Fatalf("fs.Parse failed: %v", err)
	}

	cfg, loadedPath, err := config.Load(config.LoadOptions{
		ConfigFile: yamlPath,
		Getenv:     getenv,
		FlagSet:    fs,
		FlagKeyMap: map[string]string{
			"addr":                  "server.addr",
			"preview-addr":          "server.preview_addr",
			"work-root":             "server.work_root",
			"db":                    "server.db_path",
			"allow-loopback-egress": "server.allow_loopback_egress",
			"machine-id":            "machine.machine_id",
			"label":                 "machine.labels",
			"deepseek-key":          "deepseek.api_key",
		},
	})
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if loadedPath != yamlPath {
		t.Fatalf("loadedPath = %q, want %q", loadedPath, yamlPath)
	}

	// Changed CLI flags beat Env and YAML:
	if cfg.Server.Addr != "127.0.0.1:9201" {
		t.Fatalf("Server.Addr = %q, want changed flag 127.0.0.1:9201", cfg.Server.Addr)
	}
	if cfg.Server.WorkRoot != flagSrvWork {
		t.Fatalf("Server.WorkRoot = %q, want changed flag %q", cfg.Server.WorkRoot, flagSrvWork)
	}
	if !reflect.DeepEqual(cfg.Machine.Labels, []string{"flag-go", "flag-arm64"}) {
		t.Fatalf("Machine.Labels = %v, want [flag-go flag-arm64]", cfg.Machine.Labels)
	}

	// Env beats YAML (and UNCHANGED CLI flags MUST NOT clobber Env or YAML):
	if cfg.WorkRoot != envWork {
		t.Fatalf("WorkRoot = %q, want env %q", cfg.WorkRoot, envWork)
	}
	if cfg.Machine.WorkRoot != envWork {
		t.Fatalf("Machine.WorkRoot = %q, want env %q", cfg.Machine.WorkRoot, envWork)
	}
	if cfg.Server.DBPath != "/env/shared.db" || cfg.Desktop.DBPath != "/env/shared.db" {
		t.Fatalf("DBPath = (%q, %q), want env /env/shared.db", cfg.Server.DBPath, cfg.Desktop.DBPath)
	}
	if !cfg.Server.AllowLoopbackEgress {
		t.Fatal("Server.AllowLoopbackEgress = false, want env true (unchanged flag must not clobber)")
	}
	if cfg.Machine.ServerURL != "https://env.example.com" || cfg.Desktop.ServerURL != "https://env.example.com" {
		t.Fatalf("ServerURL = (%q, %q), want env https://env.example.com", cfg.Machine.ServerURL, cfg.Desktop.ServerURL)
	}
	if cfg.Machine.MachineID != "env-machine" {
		t.Fatalf("Machine.MachineID = %q, want env-machine (unchanged flag must not clobber)", cfg.Machine.MachineID)
	}
	if cfg.Desktop.AutomationSocket != "/env/auto.sock" {
		t.Fatalf("Desktop.AutomationSocket = %q, want /env/auto.sock", cfg.Desktop.AutomationSocket)
	}
	if cfg.DeepSeek.APIKey != "sk-env-key" {
		t.Fatalf("DeepSeek.APIKey = %q, want sk-env-key (unchanged flag must not clobber)", cfg.DeepSeek.APIKey)
	}

	// YAML beats Defaults (and UNCHANGED CLI flags MUST NOT clobber YAML):
	if cfg.Server.PreviewAddr != "127.0.0.1:9002" {
		t.Fatalf("Server.PreviewAddr = %q, want yaml 127.0.0.1:9002 (unchanged flag must not clobber)", cfg.Server.PreviewAddr)
	}
	if cfg.Server.ArtifactDir != "/yaml/artifacts" {
		t.Fatalf("Server.ArtifactDir = %q, want /yaml/artifacts", cfg.Server.ArtifactDir)
	}
	if cfg.Machine.SyncInterval != 20*time.Second {
		t.Fatalf("Machine.SyncInterval = %s, want 20s", cfg.Machine.SyncInterval)
	}
	if cfg.Desktop.WebDist != "/yaml/web-dist" {
		t.Fatalf("Desktop.WebDist = %q, want /yaml/web-dist", cfg.Desktop.WebDist)
	}
	if cfg.Secrets["github_token"] != "ghp-yaml-token" {
		t.Fatalf("Secrets[github_token] = %q, want ghp-yaml-token", cfg.Secrets["github_token"])
	}

	// Defaults fill remaining unset fields:
	if cfg.Machine.FlushTimeout != 30*time.Second || cfg.Machine.ExecGrace != 2*time.Second {
		t.Fatalf("unexpected Machine duration defaults: flush=%s grace=%s", cfg.Machine.FlushTimeout, cfg.Machine.ExecGrace)
	}
	if cfg.Desktop.Scheme != "vibe" || cfg.Desktop.RootKeyID != "desktop-master-v1" {
		t.Fatalf("unexpected Desktop defaults: %+v", cfg.Desktop)
	}
}

func TestDurationSlicesWorkRootInheritanceAndMCPTargets(t *testing.T) {
	t.Parallel()

	tmp := t.TempDir()
	yamlPath := filepath.Join(tmp, "vibevalley.yaml")
	writeTestFile(t, yamlPath, `
work_root: /shared/space
machine:
  labels:
    - darwin
    - arm64
  mcp_targets:
    - id: jira
      endpoint: http://127.0.0.1:8080/mcp
    - wiki=https://wiki.internal/mcp
  sync_interval: 15s
  flush_timeout: 45s
  exec_grace: 2500ms
desktop:
  repo_roots: /repos/one,/repos/two
`)

	cfg, _, err := config.Load(config.LoadOptions{
		ConfigFile: yamlPath,
		Getenv:     mapGetenv(map[string]string{"HOME": tmp}),
	})
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if cfg.Server.WorkRoot != "/shared/space" || cfg.Machine.WorkRoot != "/shared/space" {
		t.Fatalf("top-level work_root did not propagate: server=%q machine=%q", cfg.Server.WorkRoot, cfg.Machine.WorkRoot)
	}
	if cfg.Machine.SyncInterval != 15*time.Second || cfg.Machine.FlushTimeout != 45*time.Second || cfg.Machine.ExecGrace != 2500*time.Millisecond {
		t.Fatalf("unexpected parsed durations: %+v", cfg.Machine)
	}
	if !reflect.DeepEqual(cfg.Machine.Labels, []string{"darwin", "arm64"}) {
		t.Fatalf("Labels = %v, want [darwin arm64]", cfg.Machine.Labels)
	}
	if !reflect.DeepEqual(cfg.Desktop.RepoRoots, []string{"/repos/one", "/repos/two"}) {
		t.Fatalf("RepoRoots = %v, want [/repos/one /repos/two]", cfg.Desktop.RepoRoots)
	}
	wantRawTargets := []string{"jira=http://127.0.0.1:8080/mcp", "wiki=https://wiki.internal/mcp"}
	if !reflect.DeepEqual(cfg.Machine.MCPTargets, wantRawTargets) {
		t.Fatalf("MCPTargets = %v, want %v", cfg.Machine.MCPTargets, wantRawTargets)
	}
	parsedTargets, err := cfg.Machine.ParsedMCPTargets()
	if err != nil {
		t.Fatalf("ParsedMCPTargets failed: %v", err)
	}
	wantTargets := []config.MCPTargetConfig{
		{ID: "jira", Endpoint: "http://127.0.0.1:8080/mcp"},
		{ID: "wiki", Endpoint: "https://wiki.internal/mcp"},
	}
	if !reflect.DeepEqual(parsedTargets, wantTargets) {
		t.Fatalf("ParsedMCPTargets = %+v, want %+v", parsedTargets, wantTargets)
	}

	// Single string mcp_targets in YAML also works cleanly.
	singleTargetPath := filepath.Join(tmp, "single.yaml")
	writeTestFile(t, singleTargetPath, `
machine:
  mcp_targets: docs=http://127.0.0.1:9090/mcp
`)
	singleCfg, _, err := config.Load(config.LoadOptions{
		ConfigFile: singleTargetPath,
		Getenv:     mapGetenv(map[string]string{"HOME": tmp}),
	})
	if err != nil {
		t.Fatalf("Load single-string mcp_targets failed: %v", err)
	}
	if !reflect.DeepEqual(singleCfg.Machine.MCPTargets, []string{"docs=http://127.0.0.1:9090/mcp"}) {
		t.Fatalf("single-string MCPTargets = %v", singleCfg.Machine.MCPTargets)
	}

	// Repeatable --mcp-target and --repo-root flags + --sync-interval duration flag.
	fs := pflag.NewFlagSet("machine-desktop", pflag.ContinueOnError)
	fs.StringArray("mcp-target", nil, "")
	fs.StringSlice("repo-root", nil, "")
	fs.Duration("sync-interval", 10*time.Second, "")
	fs.Bool("allow-loopback-egress", false, "")
	if err := fs.Parse([]string{
		"--mcp-target", "ops=https://ops.internal/mcp",
		"--mcp-target", "git=http://127.0.0.1:7000/mcp",
		"--repo-root", "/repo/a,/repo/b",
		"--sync-interval", "45s",
	}); err != nil {
		t.Fatalf("fs.Parse failed: %v", err)
	}

	yamlTrueLoopback := filepath.Join(tmp, "loopback.yaml")
	writeTestFile(t, yamlTrueLoopback, "server:\n  allow_loopback_egress: true\n")
	flagCfg, _, err := config.Load(config.LoadOptions{
		ConfigFile: yamlTrueLoopback,
		Getenv: mapGetenv(map[string]string{
			"HOME":                       tmp,
			"VIBE_ALLOW_LOOPBACK_EGRESS": "false",
		}),
		FlagSet: fs,
		FlagKeyMap: map[string]string{
			"mcp-target":            "machine.mcp_targets",
			"repo-root":             "desktop.repo_roots",
			"sync-interval":         "machine.sync_interval",
			"allow-loopback-egress": "server.allow_loopback_egress",
		},
	})
	if err != nil {
		t.Fatalf("Load with repeatable flags failed: %v", err)
	}
	if !reflect.DeepEqual(flagCfg.Machine.MCPTargets, []string{"ops=https://ops.internal/mcp", "git=http://127.0.0.1:7000/mcp"}) {
		t.Fatalf("MCPTargets from flags = %v", flagCfg.Machine.MCPTargets)
	}
	if !reflect.DeepEqual(flagCfg.Desktop.RepoRoots, []string{"/repo/a", "/repo/b"}) {
		t.Fatalf("RepoRoots from flags = %v", flagCfg.Desktop.RepoRoots)
	}
	if flagCfg.Machine.SyncInterval != 45*time.Second {
		t.Fatalf("SyncInterval from flag = %s, want 45s", flagCfg.Machine.SyncInterval)
	}
	if flagCfg.Server.AllowLoopbackEgress {
		t.Fatal("expected env VIBE_ALLOW_LOOPBACK_EGRESS=false to override YAML true when flag unchanged")
	}
}

func TestValidationRejectsInvalidFields(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		mutate  func(*config.AppConfig)
		wantErr string
	}{
		{
			name:    "nil config",
			mutate:  nil,
			wantErr: "nil",
		},
		{
			name:    "invalid server addr",
			mutate:  func(c *config.AppConfig) { c.Server.Addr = "not-host-port" },
			wantErr: "server.addr",
		},
		{
			name:    "invalid server port",
			mutate:  func(c *config.AppConfig) { c.Server.Addr = "127.0.0.1:70000" },
			wantErr: "invalid port",
		},
		{
			name:    "machine url with embedded credentials",
			mutate:  func(c *config.AppConfig) { c.Machine.ServerURL = "https://user:secret@control.vibevalley.dev" },
			wantErr: "credentials",
		},
		{
			name:    "machine url unsupported scheme",
			mutate:  func(c *config.AppConfig) { c.Machine.ServerURL = "ftp://control.vibevalley.dev" },
			wantErr: "scheme",
		},
		{
			name:    "invalid mcp target syntax",
			mutate:  func(c *config.AppConfig) { c.Machine.MCPTargets = []string{"bad-target"} },
			wantErr: "mcp_targets",
		},
		{
			name: "duplicate mcp target id",
			mutate: func(c *config.AppConfig) {
				c.Machine.MCPTargets = []string{"jira=http://127.0.0.1:8080", "jira=http://127.0.0.1:8081"}
			},
			wantErr: "duplicate",
		},
		{
			name:    "exec_grace exceeds 3s",
			mutate:  func(c *config.AppConfig) { c.Machine.ExecGrace = 5 * time.Second },
			wantErr: "exec_grace",
		},
		{
			name:    "exec_grace non-positive",
			mutate:  func(c *config.AppConfig) { c.Machine.ExecGrace = 0 },
			wantErr: "exec_grace",
		},
		{
			name:    "desktop url with credentials",
			mutate:  func(c *config.AppConfig) { c.Desktop.ServerURL = "http://admin:pw@127.0.0.1:8787" },
			wantErr: "credentials",
		},
		{
			name:    "invalid desktop scheme",
			mutate:  func(c *config.AppConfig) { c.Desktop.Scheme = "123invalid" },
			wantErr: "desktop.scheme",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			var cfg *config.AppConfig
			if tc.mutate != nil {
				cfg = config.DefaultConfig(mapGetenv(map[string]string{"HOME": t.TempDir()}))
				tc.mutate(cfg)
			}
			err := config.Validate(cfg)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("Validate() = %v, want error containing %q", err, tc.wantErr)
			}
		})
	}

	// PreviewAddr "disabled" must be valid.
	cfg := config.DefaultConfig(mapGetenv(map[string]string{"HOME": t.TempDir()}))
	cfg.Server.PreviewAddr = "disabled"
	if err := config.Validate(cfg); err != nil {
		t.Fatalf("expected preview_addr=disabled to be valid, got %v", err)
	}
}

func TestRedactAndMarshalRedactedYAML(t *testing.T) {
	t.Parallel()

	tmp := t.TempDir()
	cfg := config.DefaultConfig(mapGetenv(map[string]string{"VIBEVALLEY_HOME": tmp}))
	cfg.DeepSeek.APIKey = "sk-deepseek-super-secret-value"
	cfg.Secrets = map[string]string{
		"github_token":  "ghp_super_secret_token",
		"client_secret": "sec_value_123",
		"custom_entry":  "raw_secret_value",
		"vault_api_key": "vk_live_secret",
	}

	redacted := config.Redact(cfg)
	if redacted == cfg {
		t.Fatal("Redact returned original pointer instead of deep copy")
	}
	if redacted.DeepSeek.APIKey != config.RedactedValue {
		t.Fatalf("redacted DeepSeek.APIKey = %q, want %q", redacted.DeepSeek.APIKey, config.RedactedValue)
	}
	for k, v := range redacted.Secrets {
		if v != config.RedactedValue {
			t.Fatalf("redacted Secrets[%q] = %q, want %q", k, v, config.RedactedValue)
		}
	}
	// Original config must remain untouched.
	if cfg.DeepSeek.APIKey != "sk-deepseek-super-secret-value" || cfg.Secrets["github_token"] != "ghp_super_secret_token" {
		t.Fatal("Redact mutated original AppConfig")
	}
	// Non-secret identifiers must remain intact.
	if redacted.Desktop.RootKeyID != "desktop-master-v1" || redacted.Desktop.KeychainService != "com.vibevalley.desktop.vault" {
		t.Fatalf("non-secret identifiers were altered: %+v", redacted.Desktop)
	}

	yamlBytes, err := config.MarshalRedactedYAML(cfg)
	if err != nil {
		t.Fatalf("MarshalRedactedYAML failed: %v", err)
	}
	out := string(yamlBytes)
	for _, secretVal := range []string{
		"sk-deepseek-super-secret-value",
		"ghp_super_secret_token",
		"sec_value_123",
		"raw_secret_value",
		"vk_live_secret",
	} {
		if strings.Contains(out, secretVal) {
			t.Fatalf("redacted YAML leaked secret %q:\n%s", secretVal, out)
		}
	}
	if !strings.Contains(out, config.RedactedValue) {
		t.Fatalf("expected %q in redacted YAML:\n%s", config.RedactedValue, out)
	}
	if !strings.Contains(out, "sync_interval: 15s") {
		t.Fatalf("expected duration formatted as 15s in YAML:\n%s", out)
	}

	// Redacted YAML must round-trip cleanly through Load.
	roundTripPath := filepath.Join(tmp, "redacted.yaml")
	writeTestFile(t, roundTripPath, out)
	roundTripped, _, err := config.Load(config.LoadOptions{
		ConfigFile: roundTripPath,
		Getenv:     mapGetenv(map[string]string{"VIBEVALLEY_HOME": tmp}),
	})
	if err != nil {
		t.Fatalf("round-trip Load(MarshalRedactedYAML) failed: %v", err)
	}
	if roundTripped.DeepSeek.APIKey != config.RedactedValue {
		t.Fatalf("round-trip DeepSeek.APIKey = %q, want %q", roundTripped.DeepSeek.APIKey, config.RedactedValue)
	}

	// Empty DeepSeek.APIKey stays empty when redacted.
	emptyCfg := config.DefaultConfig(mapGetenv(map[string]string{"VIBEVALLEY_HOME": tmp}))
	if got := config.Redact(emptyCfg); got.DeepSeek.APIKey != "" {
		t.Fatalf("expected empty DeepSeek.APIKey to remain empty, got %q", got.DeepSeek.APIKey)
	}
	if config.Redact(nil) != nil {
		t.Fatal("Redact(nil) should return nil")
	}
	if _, err := config.MarshalRedactedYAML(nil); err == nil {
		t.Fatal("MarshalRedactedYAML(nil) should return error")
	}
}

func TestEmptyGetenvDoesNotFallbackToOSUserHomeDir(t *testing.T) {
	fakeHostHome := t.TempDir()
	hostYAML := filepath.Join(fakeHostHome, ".vibevalley", "vibevalley.yaml")
	writeTestFile(t, hostYAML, "bogus_section:\n  fail: true\n")
	t.Setenv("HOME", fakeHostHome)
	t.Setenv("USERPROFILE", fakeHostHome)

	emptyEnv := func(string) string { return "" }
	resolved, explicit := config.ResolvePath("", emptyEnv)
	if explicit {
		t.Fatalf("expected explicit=false, got true (path=%q)", resolved)
	}
	if strings.HasPrefix(resolved, fakeHostHome) {
		t.Fatalf("ResolvePath with empty Getenv leaked host home %q: %q", fakeHostHome, resolved)
	}

	def := config.DefaultConfig(emptyEnv)
	if strings.HasPrefix(def.HomeDir, fakeHostHome) {
		t.Fatalf("DefaultConfig with empty Getenv leaked host home %q: %q", fakeHostHome, def.HomeDir)
	}

	cfg, loadedPath, err := config.Load(config.LoadOptions{Getenv: emptyEnv})
	if err != nil {
		t.Fatalf("Load with empty Getenv unexpectedly read host YAML %q: %v", hostYAML, err)
	}
	if loadedPath != "" || strings.HasPrefix(cfg.HomeDir, fakeHostHome) {
		t.Fatalf("Load with empty Getenv leaked host home: loaded=%q cfg=%+v", loadedPath, cfg)
	}

	// nil Getenv uses process env / os.UserHomeDir normally.
	nilResolved, _ := config.ResolvePath("", nil)
	if nilResolved != hostYAML {
		t.Fatalf("ResolvePath with nil Getenv = %q, want %q", nilResolved, hostYAML)
	}
}

func TestOfficialTSVibeValleyYAMLCompatibilityAndStrictTypoChecks(t *testing.T) {
	t.Parallel()

	tmp := t.TempDir()
	vibeHome := filepath.Join(tmp, "vibe-home")
	getenv := mapGetenv(map[string]string{"VIBEVALLEY_HOME": vibeHome})

	tsYAML := filepath.Join(tmp, "ts-vibevalley.yaml")
	writeTestFile(t, tsYAML, `
port: 9091
db: memory
web: /srv/web/dist
tokei: /usr/local/bin/tokei
cny_per_usd: 7.25
git_emails:
  - dev@vibevalley.dev
  - ci@vibevalley.dev
database:
  url: postgres://localhost/vibevalley
agent:
  model: deepseek-chat
  starters: [architect, reviewer]
agora:
  app_id: app-123
  app_certificate: cert-456
voice:
  id: v1
  line:
    port: 8788
    url: ""
lan:
  port: 8790
patrol:
  heartbeat_minutes: 10
cron:
  tick_ms: 20000
session:
  stall_seconds: 240
  trajectory_days: 30
repo:
  max_sessions: 3
  check_timeout_seconds: 1200
github:
  pr_repos: [vibevalleyhq/vibevalley]
  pr_poll_seconds: 180
chat:
  notice_batch_ms: 3000
  retry_wake_ms: 3000
otlp:
  url: http://127.0.0.1:4318
pkm:
  root: /tmp/pkm
`)
	cfg, loadedPath, err := config.Load(config.LoadOptions{ConfigFile: tsYAML, Getenv: getenv})
	if err != nil {
		t.Fatalf("Load official TS YAML failed: %v", err)
	}
	if loadedPath != tsYAML {
		t.Fatalf("loadedPath = %q, want %q", loadedPath, tsYAML)
	}
	if cfg.Server.Addr != "127.0.0.1:9091" {
		t.Fatalf("Server.Addr = %q, want 127.0.0.1:9091", cfg.Server.Addr)
	}
	if cfg.Server.DBPath != ":memory:" {
		t.Fatalf("Server.DBPath = %q, want :memory:", cfg.Server.DBPath)
	}
	if cfg.Desktop.WebDist != "/srv/web/dist" {
		t.Fatalf("Desktop.WebDist = %q, want /srv/web/dist", cfg.Desktop.WebDist)
	}

	// Explicit canonical server/desktop fields take precedence over top-level port/db/web.
	overrideYAML := filepath.Join(tmp, "override.yaml")
	writeTestFile(t, overrideYAML, `
port: 9091
db: /ts/pglite
web: /ts/web
server:
  addr: 127.0.0.1:9999
  db_path: /canonical/server.db
desktop:
  web_dist: /canonical/web
`)
	overrideCfg, _, err := config.Load(config.LoadOptions{ConfigFile: overrideYAML, Getenv: getenv})
	if err != nil {
		t.Fatalf("Load override YAML failed: %v", err)
	}
	if overrideCfg.Server.Addr != "127.0.0.1:9999" ||
		overrideCfg.Server.DBPath != "/canonical/server.db" ||
		overrideCfg.Desktop.WebDist != "/canonical/web" {
		t.Fatalf("canonical section fields were overwritten by TS top-level aliases: %+v", overrideCfg)
	}

	// Non-"memory" db maps verbatim to server.db_path when server.db_path is unset.
	pathDBYAML := filepath.Join(tmp, "path-db.yaml")
	writeTestFile(t, pathDBYAML, "db: /data/pglite-dir\n")
	pathDBCfg, _, err := config.Load(config.LoadOptions{ConfigFile: pathDBYAML, Getenv: getenv})
	if err != nil {
		t.Fatalf("Load path db YAML failed: %v", err)
	}
	if pathDBCfg.Server.DBPath != "/data/pglite-dir" {
		t.Fatalf("Server.DBPath = %q, want /data/pglite-dir", pathDBCfg.Server.DBPath)
	}

	// Typos and non-mapping auxiliary sections must still fail cleanly.
	for _, bad := range []struct {
		name    string
		yaml    string
		wantErr string
	}{
		{"unknown top-level", "bogus_section:\n  foo: bar\n", "bogus_section"},
		{"unknown nested server", "server:\n  unknown_opt: true\n", "server.unknown_opt"},
		{"non-map voice section", "voice: scalar\n", "voice"},
		{"invalid port out of range", "port: 70000\n", "port"},
	} {
		badPath := filepath.Join(tmp, bad.name+".yaml")
		writeTestFile(t, badPath, bad.yaml)
		if _, _, err := config.Load(config.LoadOptions{ConfigFile: badPath, Getenv: getenv}); err == nil || !strings.Contains(err.Error(), bad.wantErr) {
			t.Fatalf("%s: expected error containing %q, got %v", bad.name, bad.wantErr, err)
		}
	}
}
