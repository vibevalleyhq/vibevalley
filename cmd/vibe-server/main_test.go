package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/config"
	"github.com/vibevalleyhq/vibevalley/internal/domain/artifact"
	"github.com/vibevalleyhq/vibevalley/internal/domain/issue"
	"github.com/vibevalleyhq/vibevalley/internal/domain/media"
	"github.com/vibevalleyhq/vibevalley/internal/machine"
	"github.com/vibevalleyhq/vibevalley/internal/vault"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/delta"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/link"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func buildGoBinary(t *testing.T, pkg, outName string) string {
	t.Helper()
	if runtime.GOOS == "windows" && !strings.HasSuffix(outName, ".exe") {
		outName += ".exe"
	}
	binPath := filepath.Join(t.TempDir(), outName)
	goBin := filepath.Join(runtime.GOROOT(), "bin", "go")
	cmd := exec.Command(goBin, "build", "-o", binPath, pkg)
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOROOT="+runtime.GOROOT())
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build %s failed: %v\n%s", pkg, err, string(out))
	}
	return binPath
}

func isolatedVibeEnv(vibeHome string) []string {
	base := os.Environ()
	out := make([]string, 0, len(base)+1)
	for _, entry := range base {
		if strings.HasPrefix(entry, "VIBEVALLEY_HOME=") || strings.HasPrefix(entry, "VIBE_CONFIG=") {
			continue
		}
		out = append(out, entry)
	}
	return append(out, "VIBEVALLEY_HOME="+vibeHome)
}

func TestVibeServerSubprocessReadyJSONAndMachineConnect(t *testing.T) {
	serverBin := buildGoBinary(t, "./", "vibe-server")
	machineBin := buildGoBinary(t, "../vibe-machine", "vibe-machine")

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	tmp := t.TempDir()
	dbPath := filepath.Join(tmp, "srv.db")
	workRoot := filepath.Join(tmp, "work")

	srvCmd := exec.CommandContext(ctx, serverBin,
		"--addr", "127.0.0.1:0",
		"--preview-addr", "127.0.0.1:0",
		"--db", dbPath,
		"--work-root", workRoot,
		"--ready-json",
	)
	srvCmd.Env = isolatedVibeEnv(filepath.Join(tmp, "srv-home"))
	stdout, err := srvCmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderrBuf bytes.Buffer
	srvCmd.Stderr = &stderrBuf
	if err := srvCmd.Start(); err != nil {
		t.Fatalf("start vibe-server: %v", err)
	}
	var srvWaitErr error
	srvWaitDone := make(chan struct{})
	go func() {
		srvWaitErr = srvCmd.Wait()
		close(srvWaitDone)
	}()
	defer func() {
		select {
		case <-srvWaitDone:
		default:
			if srvCmd.Process != nil {
				_ = srvCmd.Process.Kill()
			}
			<-srvWaitDone
		}
	}()

	readyLineCh := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		if sc.Scan() {
			readyLineCh <- sc.Text()
		}
	}()

	var ready ReadyInfo
	select {
	case line := <-readyLineCh:
		if err := json.Unmarshal([]byte(line), &ready); err != nil {
			t.Fatalf("decode ready json %q: %v", line, err)
		}
	case <-ctx.Done():
		t.Fatalf("timed out waiting for --ready-json; stderr=%s", stderrBuf.String())
	}
	if ready.Addr == "" || ready.PreviewAddr == "" || ready.Addr == ready.PreviewAddr {
		t.Fatalf("expected distinct bound addr and preview_addr, got %+v", ready)
	}

	resp, err := http.Get("http://" + ready.Addr + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on /healthz, got %d", resp.StatusCode)
	}

	// Start real vibe-machine subprocess pointing at --addr.
	machWork := filepath.Join(tmp, "mach-work")
	machCmd := exec.CommandContext(ctx, machineBin,
		"--server", "ws://"+ready.Addr+"/machine/ws",
		"--machine-id", "mach-subproc-1",
		"--work-root", machWork,
		"--label", "e2e",
	)
	machCmd.Env = isolatedVibeEnv(filepath.Join(tmp, "mach-home"))
	machOut, err := machCmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var machErr bytes.Buffer
	machCmd.Stderr = &machErr
	if err := machCmd.Start(); err != nil {
		t.Fatalf("start vibe-machine: %v", err)
	}
	defer func() {
		if machCmd.Process != nil {
			_ = machCmd.Process.Kill()
		}
		_ = machCmd.Wait()
	}()

	machReadyCh := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(machOut)
		if sc.Scan() {
			machReadyCh <- sc.Text()
		}
	}()
	select {
	case line := <-machReadyCh:
		if !strings.Contains(line, "vibe-machine ready") {
			t.Fatalf("unexpected machine banner: %q", line)
		}
	case <-ctx.Done():
		t.Fatalf("timed out waiting for vibe-machine ready; stderr=%s", machErr.String())
	}

	// Poll /api/v1/machines until mach-subproc-1 appears online.
	for {
		r, err := http.Get("http://" + ready.Addr + "/api/v1/machines")
		if err == nil {
			var payload struct {
				Machines []struct {
					MachineID string `json:"machineId"`
				} `json:"machines"`
			}
			_ = json.NewDecoder(r.Body).Decode(&payload)
			r.Body.Close()
			for _, m := range payload.Machines {
				if m.MachineID == "mach-subproc-1" {
					goto connected
				}
			}
		}
		select {
		case <-ctx.Done():
			t.Fatalf("timed out waiting for mach-subproc-1 to register; machErr=%s", machErr.String())
		case <-time.After(15 * time.Millisecond):
		}
	}
connected:
	// Signal graceful shutdown to server (SIGTERM on Unix, os.Interrupt on Windows).
	if runtime.GOOS != "windows" {
		if err := sendGracefulStop(srvCmd.Process); err != nil {
			t.Fatalf("signal graceful stop: %v", err)
		}
		select {
		case <-srvWaitDone:
			if srvWaitErr != nil {
				t.Fatalf("expected clean graceful shutdown exit 0, got %v (stderr=%s)", srvWaitErr, stderrBuf.String())
			}
		case <-ctx.Done():
			t.Fatalf("timed out waiting for server graceful shutdown")
		}
	}
}

func TestVibeServerChordWatchCatchupMachineEgressAndPreview(t *testing.T) {
	machineBin := buildGoBinary(t, "../vibe-machine", "vibe-machine")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tmp := t.TempDir()
	srv, err := NewServer(ctx, Config{
		Addr:                "127.0.0.1:0",
		PreviewAddr:         "127.0.0.1:0",
		DBPath:              filepath.Join(tmp, "srv.db"),
		WorkRoot:            filepath.Join(tmp, "work"),
		AllowLoopbackEgress: true,
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	defer func() { _ = srv.Close() }()

	// 1. Chord WebSocket client: Watch SpaceView, disconnect, mutate server, reconnect catchup.
	wsURL := "ws://" + srv.Addr() + "/chord/ws"
	var snapMu sync.Mutex
	var curSnap *delta.Snapshot
	var lastRev int64
	notifySpace := make(chan contract.SpaceView, 32)

	ws1, _, err := link.DialWebSocket(ctx, wsURL)
	if err != nil {
		t.Fatalf("DialWebSocket(1): %v", err)
	}
	cLink1 := link.NewLink(ws1, link.Options{
		Principal:  link.Principal{Kind: link.PrincipalUserDevice, ID: "web-1"},
		SidePrefix: "web",
	})
	if err := cLink1.Start(ctx); err != nil {
		t.Fatalf("cLink1.Start: %v", err)
	}

	sub1, err := cLink1.OpenWatch(ctx, "space", 0, nil, func(_ context.Context, ev link.WatchEvent) {
		snapMu.Lock()
		defer snapMu.Unlock()
		if ev.Snapshot != nil {
			curSnap = ev.Snapshot
		} else if len(ev.Ops) > 0 && curSnap != nil {
			if next, err := curSnap.Apply(ev.Ops...); err == nil {
				curSnap = next
			}
		}
		if ev.Rev > lastRev {
			lastRev = ev.Rev
		}
		if curSnap != nil {
			b, _ := json.Marshal(curSnap.Value())
			var sv contract.SpaceView
			if json.Unmarshal(b, &sv) == nil {
				notifySpace <- sv
			}
		}
	}, nil)
	if err != nil {
		t.Fatalf("OpenWatch(1): %v", err)
	}

	var pingRes map[string]any
	if err := cLink1.Call(ctx, "health.ping", map[string]any{}, &pingRes); err != nil {
		t.Fatalf("health.ping RPC: %v", err)
	}

	// Wait initial SpaceView snapshot then drop connection and create an issue while offline.
	<-notifySpace
	snapMu.Lock()
	savedRev := lastRev
	savedSnap := curSnap
	snapMu.Unlock()

	sub1.Stop()
	_ = cLink1.Close()

	if _, _, err := srv.Stack().CreateAndDispatchIssue(ctx, issue.Issue{
		ID:     "iss-catchup-1",
		Title:  "Catchup test",
		RepoID: "repo-1",
	}); err != nil {
		t.Fatalf("CreateAndDispatchIssue: %v", err)
	}

	// Reconnect on new WebSocket passing savedRev + savedSnap!
	ws2, _, err := link.DialWebSocket(ctx, wsURL)
	if err != nil {
		t.Fatalf("DialWebSocket(2): %v", err)
	}
	cLink2 := link.NewLink(ws2, link.Options{
		Principal:  link.Principal{Kind: link.PrincipalUserDevice, ID: "web-1"},
		SidePrefix: "web",
	})
	if err := cLink2.Start(ctx); err != nil {
		t.Fatalf("cLink2.Start: %v", err)
	}
	defer func() { _ = cLink2.Close() }()

	sub2, err := cLink2.OpenWatch(ctx, "space", savedRev, savedSnap, func(_ context.Context, ev link.WatchEvent) {
		snapMu.Lock()
		defer snapMu.Unlock()
		if ev.Snapshot != nil {
			curSnap = ev.Snapshot
		} else if len(ev.Ops) > 0 && curSnap != nil {
			if next, err := curSnap.Apply(ev.Ops...); err == nil {
				curSnap = next
			}
		}
		if curSnap != nil {
			b, _ := json.Marshal(curSnap.Value())
			var sv contract.SpaceView
			if json.Unmarshal(b, &sv) == nil {
				notifySpace <- sv
			}
		}
	}, nil)
	if err != nil {
		t.Fatalf("OpenWatch(2): %v", err)
	}
	defer sub2.Stop()

	for {
		select {
		case sv := <-notifySpace:
			for _, iss := range sv.Issues {
				if iss.ID == "iss-catchup-1" {
					goto caughtUp
				}
			}
		case <-ctx.Done():
			t.Fatalf("timed out waiting for caught-up SpaceView issue")
		}
	}
caughtUp:

	// 2. Real machine binary connecting to /machine/ws + lazy lease + exec + output harvest.
	machCmd := exec.CommandContext(ctx, machineBin,
		"--server", "ws://"+srv.Addr()+"/machine/ws",
		"--machine-id", "mach-srv-exec",
		"--work-root", filepath.Join(tmp, "mach-exec-work"),
		"--label", "linux-or-mac",
	)
	machCmd.Env = isolatedVibeEnv(filepath.Join(tmp, "mach-exec-home"))
	if err := machCmd.Start(); err != nil {
		t.Fatalf("start vibe-machine: %v", err)
	}
	defer func() {
		if machCmd.Process != nil {
			_ = machCmd.Process.Kill()
		}
		_ = machCmd.Wait()
	}()

	if _, err := srv.Stack().Machines.WaitOnline(ctx, 1); err != nil {
		t.Fatalf("Machines.WaitOnline: %v", err)
	}
	lazy := srv.Stack().Machines.NewLazyEnv(machine.LeaseRequest{SessionID: "sess-srv-1"})
	defer func() { _ = lazy.Close() }()
	if err := lazy.WriteAtomic(ctx, ".vibe/outputs/report.txt", []byte("server-harvest-ok"), 0o644); err != nil {
		t.Fatalf("lazy.WriteAtomic: %v", err)
	}
	ing, err := srv.Stack().Machines.HarvestToMedia(ctx, lazy, media.IngestMetadata{SessionID: "sess-srv-1"})
	if err != nil || len(ing.Items) != 1 {
		t.Fatalf("HarvestToMedia: ing=%+v err=%v", ing, err)
	}

	// 3. Vault /egress proxy secret injection + disallowed host 403 block.
	var gotAuth string
	allowedUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_, _ = io.WriteString(w, "upstream-ok")
	}))
	defer allowedUpstream.Close()

	blockedUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "should-be-blocked")
	}))
	defer blockedUpstream.Close()

	au, _ := url.Parse(allowedUpstream.URL)
	if err := srv.Stack().Vault.Put(ctx, vault.Credential{
		ID:           "cred-up",
		Kind:         vault.KindProviderAPIKey,
		Name:         "allowed-up",
		TargetHosts:  []string{au.Host},
		HeaderName:   "Authorization",
		HeaderPrefix: "Bearer ",
		Value:        vault.NewSecret("top-secret-token-xyz"),
	}); err != nil {
		t.Fatalf("Vault.Put: %v", err)
	}
	tok, err := srv.Stack().IssueEgressToken(ctx, "mach-srv-exec", "sess-srv-1", []string{au.Host}, []string{"cred-up"}, 10*time.Minute)
	if err != nil {
		t.Fatalf("IssueEgressToken: %v", err)
	}
	proxyURL, _ := url.Parse("http://" + srv.Addr() + "/egress")
	rt, err := vault.NewProxyClientTransport(proxyURL, tok.Token, nil)
	if err != nil {
		t.Fatalf("NewProxyClientTransport: %v", err)
	}
	egClient := &http.Client{Transport: rt}

	resOK, err := egClient.Get(allowedUpstream.URL + "/v1/ping")
	if err != nil {
		t.Fatalf("egress allowed GET: %v", err)
	}
	resOK.Body.Close()
	if resOK.StatusCode != http.StatusOK || gotAuth != "Bearer top-secret-token-xyz" {
		t.Fatalf("egress failed: status=%d auth=%q", resOK.StatusCode, gotAuth)
	}

	resDeny, err := egClient.Get(blockedUpstream.URL + "/steal")
	if err != nil {
		t.Fatalf("egress denied GET: %v", err)
	}
	resDeny.Body.Close()
	if resDeny.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for disallowed host, got %d", resDeny.StatusCode)
	}

	// 4. Isolated origin preview + strict CSP headers + host rejection on workbench host.
	pubRes, err := srv.Stack().Artifacts.Deliverables.Publish(ctx, artifact.PublishRequest{
		ID:      "art-srv-1",
		Title:   "Server TS Bundle",
		Display: contract.ArtifactDisplayPage,
		Bundle: &artifact.CompileRequest{
			Entry: "index.ts",
			Files: map[string]string{
				"index.ts": `export const msg: string = "isolated preview works"; document.body.textContent = msg;`,
			},
		},
	})
	if err != nil {
		t.Fatalf("Publish artifact: %v", err)
	}

	prevResp, err := http.Get("http://" + srv.PreviewAddr() + artifact.ArtifactVersionPreviewPath(pubRes.Deliverable.ID, pubRes.Version.Version))
	if err != nil {
		t.Fatalf("GET preview: %v", err)
	}
	bodyBytes, _ := io.ReadAll(prevResp.Body)
	prevResp.Body.Close()
	if prevResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on preview, got %d (%s)", prevResp.StatusCode, string(bodyBytes))
	}
	if csp := prevResp.Header.Get("Content-Security-Policy"); csp != artifact.StrictPreviewCSP {
		t.Fatalf("CSP mismatch:\n got: %s\nwant: %s", csp, artifact.StrictPreviewCSP)
	}
	if !strings.Contains(string(bodyBytes), "isolated preview works") {
		t.Fatalf("expected compiled TS output in preview HTML, got: %s", string(bodyBytes))
	}

	// Host mismatch (control-plane Host targeting preview handler) must return 403.
	badHostReq, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+srv.PreviewAddr()+artifact.ArtifactVersionPreviewPath(pubRes.Deliverable.ID, pubRes.Version.Version), nil)
	badHostReq.Host = srv.Addr()
	badResp, err := http.DefaultClient.Do(badHostReq)
	if err != nil {
		t.Fatalf("GET preview with bad host: %v", err)
	}
	badResp.Body.Close()
	if badResp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 when workbench Host hits preview listener, got %d", badResp.StatusCode)
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

func writeServerTestYAML(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestVibeServerCobraConfigMigrateAndServeSubcommands(t *testing.T) {
	t.Parallel()

	t.Run("precedence Flag > Env > vibevalley.yaml > Defaults", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		vibeHome := filepath.Join(tmp, "vibe-home")
		yamlWork := filepath.Join(tmp, "yaml-work")
		yamlDB := filepath.Join(tmp, "yaml.db")
		writeServerTestYAML(t, filepath.Join(vibeHome, "vibevalley.yaml"), `
work_root: `+yamlWork+`
server:
  addr: 127.0.0.1:9111
  preview_addr: 127.0.0.1:9112
  db_path: `+yamlDB+`
  ready_json: true
  allow_loopback_egress: false
`)
		getenv := mapGetenv(map[string]string{
			"VIBEVALLEY_HOME":            vibeHome,
			"VIBE_PREVIEW_ADDR":          "127.0.0.1:9222",
			"VIBE_ALLOW_LOOPBACK_EGRESS": "true",
		})

		rootCmd := newRootCommand(getenv, io.Discard, io.Discard)
		if err := rootCmd.ParseFlags([]string{
			"--addr", "127.0.0.1:9333",
		}); err != nil {
			t.Fatalf("ParseFlags: %v", err)
		}
		_, loadedPath, srvCfg, err := loadServerConfig(rootCmd.Flags(), "", getenv)
		if err != nil {
			t.Fatalf("loadServerConfig: %v", err)
		}
		if loadedPath != filepath.Join(vibeHome, "vibevalley.yaml") {
			t.Fatalf("loadedPath = %q", loadedPath)
		}
		if srvCfg.Addr != "127.0.0.1:9333" {
			t.Fatalf("Addr = %q, want CLI override 127.0.0.1:9333", srvCfg.Addr)
		}
		if srvCfg.PreviewAddr != "127.0.0.1:9222" || !srvCfg.AllowLoopbackEgress {
			t.Fatalf("expected env overrides for PreviewAddr and AllowLoopbackEgress, got %+v", srvCfg)
		}
		if srvCfg.DBPath != yamlDB || srvCfg.WorkRoot != yamlWork || !srvCfg.ReadyJSON {
			t.Fatalf("expected YAML values when env/flag unset, got %+v", srvCfg)
		}
	})

	t.Run("version, config check, and config print redaction", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		vibeHome := filepath.Join(tmp, "vibe-home")
		yamlPath := filepath.Join(vibeHome, "vibevalley.yaml")
		dbPath := filepath.Join(tmp, "srv.db")
		writeServerTestYAML(t, yamlPath, `
server:
  addr: 127.0.0.1:8899
  db_path: `+dbPath+`
deepseek:
  api_key: sk-yaml-secret-srv
secrets:
  github_token: ghp-yaml-token-srv
`)
		getenv := mapGetenv(map[string]string{
			"VIBEVALLEY_HOME":  vibeHome,
			"DEEPSEEK_API_KEY": "sk-env-secret-srv",
		})

		var out, errBuf bytes.Buffer
		missingPath := filepath.Join(tmp, "missing.yaml")
		if err := run(context.Background(), []string{"--version", "--config", missingPath}, getenv, &out, &errBuf); err != nil {
			t.Fatalf("--version with missing --config failed: %v", err)
		}
		if !strings.Contains(out.String(), "vibe-server "+version) {
			t.Fatalf("unexpected --version output: %q", out.String())
		}

		out.Reset()
		if err := run(context.Background(), []string{"version"}, getenv, &out, &errBuf); err != nil {
			t.Fatalf("version subcommand failed: %v", err)
		}
		if !strings.Contains(out.String(), "vibe-server "+version) {
			t.Fatalf("unexpected version subcommand output: %q", out.String())
		}

		out.Reset()
		if err := run(context.Background(), []string{"config", "check"}, getenv, &out, &errBuf); err != nil {
			t.Fatalf("config check failed: %v", err)
		}
		if !strings.Contains(out.String(), "config ok:") || !strings.Contains(out.String(), yamlPath) {
			t.Fatalf("unexpected config check output: %q", out.String())
		}

		badYAML := filepath.Join(tmp, "bad.yaml")
		writeServerTestYAML(t, badYAML, "server:\n  addr: not-a-host-port\n")
		if err := run(context.Background(), []string{"config", "check", "-c", badYAML}, getenv, &out, &errBuf); err == nil {
			t.Fatal("expected config check to reject invalid server.addr")
		}

		out.Reset()
		if err := run(context.Background(), []string{"config", "print", "--addr", "127.0.0.1:9444"}, getenv, &out, &errBuf); err != nil {
			t.Fatalf("config print failed: %v", err)
		}
		printed := out.String()
		for _, secret := range []string{"sk-yaml-secret-srv", "sk-env-secret-srv", "ghp-yaml-token-srv"} {
			if strings.Contains(printed, secret) {
				t.Fatalf("config print leaked secret %q:\n%s", secret, printed)
			}
		}
		if !strings.Contains(printed, config.RedactedValue) {
			t.Fatalf("config print missing %q:\n%s", config.RedactedValue, printed)
		}
		if !strings.Contains(printed, "127.0.0.1:9444") {
			t.Fatalf("config print missing flag override addr:\n%s", printed)
		}
	})

	t.Run("migrate up, status, down --all, up", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		vibeHome := filepath.Join(tmp, "vibe-home")
		dbPath := filepath.Join(tmp, "mig.db")
		getenv := mapGetenv(map[string]string{"VIBEVALLEY_HOME": vibeHome})

		var out, errBuf bytes.Buffer
		if err := run(context.Background(), []string{"migrate", "up", "--db", dbPath}, getenv, &out, &errBuf); err != nil {
			t.Fatalf("migrate up failed: %v", err)
		}
		if !strings.Contains(out.String(), "scope=platform") || !strings.Contains(out.String(), "after=11") || !strings.Contains(out.String(), "applied=11") {
			t.Fatalf("unexpected migrate up output:\n%s", out.String())
		}

		out.Reset()
		if err := run(context.Background(), []string{"migrate", "status", "--db", dbPath}, getenv, &out, &errBuf); err != nil {
			t.Fatalf("migrate status failed: %v", err)
		}
		if strings.Count(out.String(), "scope=platform") != 11 || strings.Count(out.String(), "applied=true") != 11 {
			t.Fatalf("expected 11 applied=true platform status lines:\n%s", out.String())
		}

		if err := run(context.Background(), []string{"migrate", "down", "--db", dbPath, "--all", "--steps", "1"}, getenv, &out, &errBuf); err == nil {
			t.Fatal("expected error combining --all and --steps")
		}

		out.Reset()
		if err := run(context.Background(), []string{"migrate", "down", "--db", dbPath, "--all"}, getenv, &out, &errBuf); err != nil {
			t.Fatalf("migrate down --all failed: %v", err)
		}
		if !strings.Contains(out.String(), "scope=platform") || !strings.Contains(out.String(), "after=0") || !strings.Contains(out.String(), "reverted=11") {
			t.Fatalf("unexpected migrate down --all output:\n%s", out.String())
		}

		out.Reset()
		if err := run(context.Background(), []string{"migrate", "status", "--db", dbPath}, getenv, &out, &errBuf); err != nil {
			t.Fatalf("migrate status after down failed: %v", err)
		}
		if strings.Count(out.String(), "scope=platform") != 11 || strings.Count(out.String(), "applied=false") != 11 {
			t.Fatalf("expected 11 applied=false platform status lines after down --all:\n%s", out.String())
		}

		out.Reset()
		if err := run(context.Background(), []string{"migrate", "up", "--db", dbPath}, getenv, &out, &errBuf); err != nil {
			t.Fatalf("migrate re-up failed: %v", err)
		}
		if !strings.Contains(out.String(), "scope=platform") || !strings.Contains(out.String(), "after=11") || !strings.Contains(out.String(), "applied=11") {
			t.Fatalf("unexpected migrate re-up output:\n%s", out.String())
		}

		sidecars, globErr := filepath.Glob(filepath.Join(tmp, "mig.*.db*"))
		if globErr != nil {
			t.Fatalf("glob sidecar dbs: %v", globErr)
		}
		if len(sidecars) != 0 {
			t.Fatalf("expected zero sidecar DB files alongside %s, found %v", dbPath, sidecars)
		}
	})

	t.Run("serve --ready-json subcommand", func(t *testing.T) {
		t.Parallel()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()

		tmp := t.TempDir()
		vibeHome := filepath.Join(tmp, "vibe-home")
		yamlPath := filepath.Join(vibeHome, "vibevalley.yaml")
		dbPath := filepath.Join(tmp, "serve.db")
		workRoot := filepath.Join(tmp, "serve-work")
		writeServerTestYAML(t, yamlPath, `
work_root: `+workRoot+`
server:
  addr: 127.0.0.1:0
  preview_addr: 127.0.0.1:0
  db_path: `+dbPath+`
`)
		getenv := mapGetenv(map[string]string{"VIBEVALLEY_HOME": vibeHome})

		pr, pw := io.Pipe()
		var errBuf bytes.Buffer
		runCtx, stopRun := context.WithCancel(ctx)
		defer stopRun()

		doneCh := make(chan error, 1)
		go func() {
			err := run(runCtx, []string{"serve", "--ready-json"}, getenv, pw, &errBuf)
			_ = pw.Close()
			doneCh <- err
		}()

		sc := bufio.NewScanner(pr)
		if !sc.Scan() {
			t.Fatalf("expected ready json line from serve --ready-json; err=%v stderr=%s", sc.Err(), errBuf.String())
		}
		var ready ReadyInfo
		if err := json.Unmarshal(sc.Bytes(), &ready); err != nil {
			t.Fatalf("decode ready json %q: %v", sc.Text(), err)
		}
		if ready.Addr == "" || ready.PreviewAddr == "" || ready.PID <= 0 || ready.URL != "http://"+ready.Addr {
			t.Fatalf("expected bound addr, preview_addr, pid, and url, got %+v", ready)
		}

		// Verify $VIBEVALLEY_HOME/server.json was written while running.
		serverJSONPath := filepath.Join(vibeHome, "server.json")
		rawReceipt, err := os.ReadFile(serverJSONPath)
		if err != nil {
			t.Fatalf("expected server.json at %s: %v", serverJSONPath, err)
		}
		var receipt struct {
			PID  int    `json:"pid"`
			Port int    `json:"port"`
			URL  string `json:"url"`
		}
		if err := json.Unmarshal(rawReceipt, &receipt); err != nil {
			t.Fatalf("decode server.json: %v", err)
		}
		if receipt.PID != ready.PID || receipt.Port <= 0 || receipt.URL != ready.URL {
			t.Fatalf("unexpected server.json receipt: %+v vs ready=%+v", receipt, ready)
		}

		resp, err := http.Get("http://" + ready.Addr + "/healthz")
		if err != nil {
			t.Fatalf("GET /healthz: %v", err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET /healthz status = %d", resp.StatusCode)
		}

		stopRun()
		if err := <-doneCh; err != nil {
			t.Fatalf("serve subcommand shutdown error: %v", err)
		}
		if _, err := os.Stat(serverJSONPath); !os.IsNotExist(err) {
			t.Fatalf("expected server.json removed on clean shutdown, stat err=%v", err)
		}
	})

	t.Run("serve --web SPA hosting and gateway /api/v1/state negotiation", func(t *testing.T) {
		t.Parallel()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()

		tmp := t.TempDir()
		vibeHome := filepath.Join(tmp, "vibe-home")
		webDir := filepath.Join(tmp, "web-dist")
		if err := os.MkdirAll(filepath.Join(webDir, "assets"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(webDir, "index.html"), []byte("<!doctype html><html><body>SPA</body></html>"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(webDir, "assets", "app.js"), []byte("console.log('ok');"), 0o644); err != nil {
			t.Fatal(err)
		}
		getenv := mapGetenv(map[string]string{
			"VIBEVALLEY_HOME": vibeHome,
			"VIBE_DB_PATH":    ":memory:",
			"VIBE_WORK_ROOT":  filepath.Join(tmp, "work"),
		})

		pr, pw := io.Pipe()
		var errBuf bytes.Buffer
		runCtx, stopRun := context.WithCancel(ctx)
		defer stopRun()
		doneCh := make(chan error, 1)
		go func() {
			err := run(runCtx, []string{"--addr", "127.0.0.1:0", "--preview-addr", "disabled", "--web", webDir, "--ready-json"}, getenv, pw, &errBuf)
			_ = pw.Close()
			doneCh <- err
		}()

		sc := bufio.NewScanner(pr)
		if !sc.Scan() {
			t.Fatalf("expected ready json; err=%v stderr=%s", sc.Err(), errBuf.String())
		}
		var ready ReadyInfo
		if err := json.Unmarshal(sc.Bytes(), &ready); err != nil {
			t.Fatalf("decode ready json: %v", err)
		}

		// SPA HTML root + locale rewriting.
		htmlResp, err := http.Get(ready.URL + "/issues/1")
		if err != nil {
			t.Fatalf("GET SPA route: %v", err)
		}
		htmlBytes, _ := io.ReadAll(htmlResp.Body)
		htmlResp.Body.Close()
		if htmlResp.StatusCode != http.StatusOK || !strings.Contains(string(htmlBytes), `data-locale="zh"`) {
			t.Fatalf("unexpected SPA fallback response status=%d body=%s", htmlResp.StatusCode, string(htmlBytes))
		}

		// Asset immutable cache header.
		assetResp, err := http.Get(ready.URL + "/assets/app.js")
		if err != nil {
			t.Fatalf("GET asset: %v", err)
		}
		assetResp.Body.Close()
		if assetResp.StatusCode != http.StatusOK || !strings.Contains(assetResp.Header.Get("Cache-Control"), "immutable") {
			t.Fatalf("expected immutable Cache-Control on asset, got %q", assetResp.Header.Get("Cache-Control"))
		}

		// Non-SSE /api/v1/state returns JSON with rev + space + frame.
		stateResp, err := http.Get(ready.URL + "/api/v1/state")
		if err != nil {
			t.Fatalf("GET /api/v1/state: %v", err)
		}
		var stateBody map[string]any
		_ = json.NewDecoder(stateResp.Body).Decode(&stateBody)
		stateResp.Body.Close()
		if stateBody["frame"] == nil || stateBody["space"] == nil || stateBody["rev"] == nil {
			t.Fatalf("expected rev, space, frame on non-SSE /api/v1/state, got %v", stateBody)
		}

		// SSE /api/v1/state streams StateFrame data line.
		sseReq, _ := http.NewRequestWithContext(ctx, http.MethodGet, ready.URL+"/api/v1/state", nil)
		sseReq.Header.Set("Accept", "text/event-stream")
		sseResp, err := http.DefaultClient.Do(sseReq)
		if err != nil {
			t.Fatalf("GET SSE /api/v1/state: %v", err)
		}
		sseSc := bufio.NewScanner(sseResp.Body)
		if !sseSc.Scan() || !strings.HasPrefix(sseSc.Text(), "data: ") {
			sseResp.Body.Close()
			t.Fatalf("expected initial SSE data line, got %q err=%v", sseSc.Text(), sseSc.Err())
		}
		sseResp.Body.Close()

		stopRun()
		if err := <-doneCh; err != nil {
			t.Fatalf("serve shutdown error: %v", err)
		}
	})
}

func TestVibeServerRegressionShutdownCancelsActiveSSE(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	tmp := t.TempDir()
	srv, err := NewServer(ctx, Config{
		Addr:        "127.0.0.1:0",
		PreviewAddr: "127.0.0.1:0",
		DBPath:      ":memory:",
		WorkRoot:    filepath.Join(tmp, "work"),
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	defer func() { _ = srv.Close() }()

	client := &http.Client{}
	defer client.CloseIdleConnections()

	sseReq, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+srv.Addr()+"/api/v1/state", nil)
	if err != nil {
		t.Fatalf("NewRequestWithContext: %v", err)
	}
	sseReq.Header.Set("Accept", "text/event-stream")
	sseResp, err := client.Do(sseReq)
	if err != nil {
		t.Fatalf("GET SSE /api/v1/state: %v", err)
	}
	defer sseResp.Body.Close()

	sseSc := bufio.NewScanner(sseResp.Body)
	if !sseSc.Scan() || !strings.HasPrefix(sseSc.Text(), "data: ") {
		t.Fatalf("expected initial SSE data line, got %q err=%v", sseSc.Text(), sseSc.Err())
	}

	// Regression: Shutdown must cancel active request contexts via BaseContext
	// so open SSE handlers exit without waiting for the shutdown deadline.
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer shutCancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		t.Fatalf("Shutdown with active SSE client failed: %v", err)
	}
	for sseSc.Scan() {
		if line := sseSc.Text(); line != "" {
			t.Fatalf("expected no extra SSE frames after Shutdown, got %q", line)
		}
	}
	if err := sseSc.Err(); err != nil {
		t.Fatalf("expected clean SSE EOF after Shutdown, got err=%v", err)
	}
}

func TestVibeServerRegressionShutdownWithIdleNewConn(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	tmp := t.TempDir()
	srv, err := NewServer(ctx, Config{
		Addr:        "127.0.0.1:0",
		PreviewAddr: "127.0.0.1:0",
		DBPath:      ":memory:",
		WorkRoot:    filepath.Join(tmp, "work"),
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	defer func() { _ = srv.Close() }()

	// Hold an unused TCP connection open (0 bytes sent) to reproduce StateNew sockets
	// left by browser preconnects or net/http Transport dial-vs-idle races.
	rawConn, err := net.DialTimeout("tcp", srv.Addr(), 2*time.Second)
	if err != nil {
		t.Fatalf("net.DialTimeout: %v", err)
	}
	defer rawConn.Close()

	for {
		srv.newConnsMu.Lock()
		count := len(srv.newConns)
		srv.newConnsMu.Unlock()
		if count > 0 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("timed out waiting for StateNew connection tracking")
		case <-time.After(5 * time.Millisecond):
		}
	}

	shutCtx, shutCancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer shutCancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		t.Fatalf("Shutdown with idle StateNew conn failed: %v", err)
	}
}
