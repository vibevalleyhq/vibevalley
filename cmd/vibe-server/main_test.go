package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
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
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	serverBin := buildGoBinary(t, "./", "vibe-server")
	machineBin := buildGoBinary(t, "../vibe-machine", "vibe-machine")

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
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
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
	machineBin := buildGoBinary(t, "../vibe-machine", "vibe-machine")
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
