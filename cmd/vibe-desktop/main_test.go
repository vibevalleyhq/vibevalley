package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/vibevalleyhq/vibevalley/internal/config"
	"github.com/vibevalleyhq/vibevalley/internal/vault"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/link"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/watch"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

type fakeEmbeddedStack struct {
	rootKey      vault.RootKey
	serverURL    string
	closed       atomic.Bool
	resolvedTask string
	raisedMax    int64
}

func (f *fakeEmbeddedStack) LinkTransport() link.FrameTransport { return nil }
func (f *fakeEmbeddedStack) SpaceSource() watch.RawSource       { return nil }
func (f *fakeEmbeddedStack) ServerURL() string                  { return f.serverURL }
func (f *fakeEmbeddedStack) Close() error {
	f.closed.Store(true)
	return nil
}
func (f *fakeEmbeddedStack) ResolveApproval(_ context.Context, prompt contract.ApprovalPromptView, _ bool) error {
	f.resolvedTask = prompt.TaskID
	return nil
}
func (f *fakeEmbeddedStack) RaiseBudget(_ context.Context, _ BudgetAlert, newMax int64) error {
	f.raisedMax = newMax
	return nil
}

func TestCLIFlagsHeadlessCheckAndEmbeddedStackHook(t *testing.T) {
	t.Parallel()

	webDist := t.TempDir()
	if err := os.WriteFile(filepath.Join(webDist, "index.html"), []byte("<!doctype html><html><body>WebDist</body></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	repoDir := t.TempDir()

	var verOut, verErr bytes.Buffer
	if err := run(context.Background(), []string{"--version"}, func(string) string { return "" }, &verOut, &verErr, DesktopDeps{}); err != nil {
		t.Fatalf("--version failed: %v", err)
	}
	if !strings.Contains(verOut.String(), "vibe-desktop") {
		t.Fatalf("unexpected --version output: %q", verOut.String())
	}

	var stackRef *fakeEmbeddedStack
	var stdout, stderr bytes.Buffer
	err := run(context.Background(), []string{
		"--server", "http://127.0.0.1:8787",
		"--web-dist", webDist,
		"--repo-root", repoDir,
		"--headless-check",
	}, func(string) string { return "" }, &stdout, &stderr, DesktopDeps{
		Keychain:    NewMemoryKeychainDriver(),
		LiquidGlass: true,
		StackLauncher: func(_ context.Context, cfg DesktopConfig, rk vault.RootKey) (EmbeddedStack, error) {
			if cfg.ServerURL != "http://127.0.0.1:8787" || cfg.WebDistDir != webDist {
				t.Fatalf("unexpected DesktopConfig passed to StackLauncher: %+v", cfg)
			}
			stackRef = &fakeEmbeddedStack{rootKey: rk, serverURL: cfg.ServerURL}
			return stackRef, nil
		},
	})
	if err != nil {
		t.Fatalf("--headless-check failed: %v (stderr=%s)", err, stderr.String())
	}

	var checkRes struct {
		OK           bool    `json:"ok"`
		WebURL       string  `json:"webUrl"`
		RootKeyID    string  `json:"rootKeyId"`
		ColdInitMs   float64 `json:"coldInitMs"`
		FramePending bool    `json:"framePending"`
		UINodes      int     `json:"uiNodes"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &checkRes); err != nil {
		t.Fatalf("decode headless-check JSON %q: %v", stdout.String(), err)
	}
	if !checkRes.OK || checkRes.FramePending || checkRes.UINodes == 0 || checkRes.ColdInitMs >= 50 {
		t.Fatalf("unexpected headless-check result: %+v", checkRes)
	}
	if stackRef == nil || stackRef.rootKey.ID() != "desktop-master-v1" || !stackRef.closed.Load() {
		t.Fatalf("expected EmbeddedStack to receive RootKey and be closed on exit: %+v", stackRef)
	}
}

func mapGetenv(vars map[string]string) func(string) string {
	return func(key string) string {
		if vars == nil {
			return ""
		}
		return vars[key]
	}
}

func writeDesktopTestYAML(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestVibeDesktopCobraConfigPrecedenceAndSubcommands(t *testing.T) {
	t.Parallel()

	t.Run("precedence Flag > Env > vibevalley.yaml > Defaults", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		vibeHome := filepath.Join(tmp, "vibe-home")
		webDist := filepath.Join(tmp, "yaml-web")
		repoA := filepath.Join(tmp, "repo-a")
		repoB := filepath.Join(tmp, "repo-b")
		writeDesktopTestYAML(t, filepath.Join(vibeHome, "vibevalley.yaml"), `
desktop:
  server_url: https://yaml.vibevalley.dev
  web_dist: `+webDist+`
  scheme: vibeyaml
  automation_socket: /tmp/yaml-auto.sock
  repo_roots:
    - `+repoA+`
    - `+repoB+`
  root_key_id: yaml-root-key
  keychain_service: yaml.keychain.service
  db_path: `+filepath.Join(tmp, "yaml-desk.db")+`
`)
		getenv := mapGetenv(map[string]string{
			"VIBEVALLEY_HOME": vibeHome,
			"VIBE_SERVER_URL": "https://env.vibevalley.dev",
			"MYGO_AUTOMATION": "/tmp/env-auto.sock",
		})

		rootCmd := newRootCommand(getenv, io.Discard, io.Discard, DesktopDeps{})
		if err := rootCmd.ParseFlags([]string{
			"--scheme", "vibeflag",
			"--root-key-id", "flag-root-key",
		}); err != nil {
			t.Fatalf("ParseFlags: %v", err)
		}
		_, loadedPath, deskCfg, err := loadDesktopConfig(rootCmd.Flags(), "", getenv)
		if err != nil {
			t.Fatalf("loadDesktopConfig: %v", err)
		}
		if loadedPath != filepath.Join(vibeHome, "vibevalley.yaml") {
			t.Fatalf("loadedPath = %q", loadedPath)
		}
		if deskCfg.WebScheme != "vibeflag" || deskCfg.RootKeyID != "flag-root-key" {
			t.Fatalf("expected CLI flag overrides, got %+v", deskCfg)
		}
		if deskCfg.ServerURL != "https://env.vibevalley.dev" || deskCfg.AutomationSocket != "/tmp/env-auto.sock" {
			t.Fatalf("expected env overrides, got %+v", deskCfg)
		}
		if deskCfg.WebDistDir != webDist ||
			!reflect.DeepEqual(deskCfg.RepoRoots, []string{repoA, repoB}) ||
			deskCfg.KeychainService != "yaml.keychain.service" ||
			deskCfg.DBPath != filepath.Join(tmp, "yaml-desk.db") {
			t.Fatalf("expected YAML values when env/flag unset, got %+v", deskCfg)
		}
	})

	t.Run("version, config check, config print redaction, check, and run subcommands", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		vibeHome := filepath.Join(tmp, "vibe-home")
		webDist := filepath.Join(tmp, "web")
		if err := os.MkdirAll(webDist, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(webDist, "index.html"), []byte("<!doctype html><html><body>Web</body></html>"), 0o644); err != nil {
			t.Fatal(err)
		}
		yamlPath := filepath.Join(vibeHome, "vibevalley.yaml")
		writeDesktopTestYAML(t, yamlPath, `
desktop:
  web_dist: `+webDist+`
  scheme: vibe
deepseek:
  api_key: sk-desk-yaml-secret
secrets:
  mcp_token: tok-desk-yaml-secret
`)
		getenv := mapGetenv(map[string]string{
			"VIBEVALLEY_HOME":  vibeHome,
			"DEEPSEEK_API_KEY": "sk-desk-env-secret",
		})

		var out, errBuf bytes.Buffer
		if err := run(context.Background(), []string{"version"}, getenv, &out, &errBuf, DesktopDeps{}); err != nil {
			t.Fatalf("version failed: %v", err)
		}
		if !strings.Contains(out.String(), "vibe-desktop "+desktopVersion) {
			t.Fatalf("unexpected version output: %q", out.String())
		}

		out.Reset()
		if err := run(context.Background(), []string{"config", "check"}, getenv, &out, &errBuf, DesktopDeps{}); err != nil {
			t.Fatalf("config check failed: %v", err)
		}
		if !strings.Contains(out.String(), "config ok:") || !strings.Contains(out.String(), yamlPath) {
			t.Fatalf("unexpected config check output: %q", out.String())
		}

		out.Reset()
		if err := run(context.Background(), []string{"config", "print", "--scheme", "vibeoverride"}, getenv, &out, &errBuf, DesktopDeps{}); err != nil {
			t.Fatalf("config print failed: %v", err)
		}
		printed := out.String()
		for _, secret := range []string{"sk-desk-yaml-secret", "sk-desk-env-secret", "tok-desk-yaml-secret"} {
			if strings.Contains(printed, secret) {
				t.Fatalf("config print leaked secret %q:\n%s", secret, printed)
			}
		}
		if !strings.Contains(printed, config.RedactedValue) || !strings.Contains(printed, "vibeoverride") {
			t.Fatalf("unexpected config print output:\n%s", printed)
		}

		deps := DesktopDeps{
			Keychain: NewMemoryKeychainDriver(),
			StackLauncher: func(_ context.Context, cfg DesktopConfig, rk vault.RootKey) (EmbeddedStack, error) {
				return &fakeEmbeddedStack{rootKey: rk, serverURL: cfg.ServerURL}, nil
			},
		}

		out.Reset()
		if err := run(context.Background(), []string{"check"}, getenv, &out, &errBuf, deps); err != nil {
			t.Fatalf("check subcommand failed: %v", err)
		}
		var chk map[string]any
		if err := json.Unmarshal(out.Bytes(), &chk); err != nil || chk["ok"] != true {
			t.Fatalf("unexpected check output %q err=%v", out.String(), err)
		}

		out.Reset()
		if err := run(context.Background(), []string{"run", "--headless-check"}, getenv, &out, &errBuf, deps); err != nil {
			t.Fatalf("run --headless-check subcommand failed: %v", err)
		}
		chk = nil
		if err := json.Unmarshal(out.Bytes(), &chk); err != nil || chk["ok"] != true {
			t.Fatalf("unexpected run --headless-check output %q err=%v", out.String(), err)
		}
	})
}

func TestDesktopAppAutoResolvesBundledWebDistOutsideHeadlessCheck(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	tmp := t.TempDir()
	execPath := filepath.Join(tmp, "VibeValley.app", "Contents", "MacOS", "vibe-desktop")
	bundleWebDir := filepath.Join(tmp, "VibeValley.app", "Contents", "Resources", "web")
	if err := os.MkdirAll(bundleWebDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bundleWebDir, "index.html"), []byte("<!doctype html><html><body>Bundled UI</body></html>"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Non-headless launch resolves bundled web dist for both WebHandler and EmbeddedStack.
	var seenWebDist string
	app, err := NewDesktopApp(ctx, DesktopConfig{
		HomeDir:       filepath.Join(tmp, "home"),
		HeadlessCheck: false,
	}, DesktopDeps{
		Keychain: NewMemoryKeychainDriver(),
		ExecPath: execPath,
		WorkDir:  tmp,
		StackLauncher: func(_ context.Context, cfg DesktopConfig, rk vault.RootKey) (EmbeddedStack, error) {
			seenWebDist = cfg.WebDistDir
			return &fakeEmbeddedStack{rootKey: rk, serverURL: "chord://embedded"}, nil
		},
	})
	if err != nil {
		t.Fatalf("NewDesktopApp GUI bundle resolution: %v", err)
	}
	defer func() { _ = app.Close() }()

	if seenWebDist != bundleWebDir || app.Config.WebDistDir != bundleWebDir || app.WebConfig.DiskDir != bundleWebDir {
		t.Fatalf("bundled WebDistDir not propagated: seen=%q cfg=%q webCfg=%q want=%q", seenWebDist, app.Config.WebDistDir, app.WebConfig.DiskDir, bundleWebDir)
	}

	rec := httptest.NewRecorder()
	app.WebHandler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Bundled UI") {
		t.Fatalf("expected bundled index.html, got status=%d body=%q", rec.Code, rec.Body.String())
	}

	// Headless check keeps WebDistDir empty (uses lightweight embedded fallback) when not explicitly given.
	var headlessSeenWebDist string
	headlessApp, err := NewDesktopApp(ctx, DesktopConfig{
		HomeDir:       filepath.Join(tmp, "home-headless"),
		HeadlessCheck: true,
	}, DesktopDeps{
		Keychain: NewMemoryKeychainDriver(),
		ExecPath: execPath,
		WorkDir:  tmp,
		StackLauncher: func(_ context.Context, cfg DesktopConfig, rk vault.RootKey) (EmbeddedStack, error) {
			headlessSeenWebDist = cfg.WebDistDir
			return &fakeEmbeddedStack{rootKey: rk, serverURL: "chord://embedded"}, nil
		},
	})
	if err != nil {
		t.Fatalf("NewDesktopApp headless: %v", err)
	}
	defer func() { _ = headlessApp.Close() }()

	if headlessSeenWebDist != "" || headlessApp.Config.WebDistDir != "" {
		t.Fatalf("expected headless-check to skip auto web dist discovery, got seen=%q cfg=%q", headlessSeenWebDist, headlessApp.Config.WebDistDir)
	}
	var chk bytes.Buffer
	if err := headlessApp.RunHeadlessCheck(ctx, &chk); err != nil {
		t.Fatalf("RunHeadlessCheck: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(chk.Bytes(), &parsed); err != nil || parsed["ok"] != true {
		t.Fatalf("unexpected headless check JSON %q err=%v", chk.String(), err)
	}
}
