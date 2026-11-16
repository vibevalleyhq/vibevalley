//go:build !thin_desktop

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/stack"
	"github.com/vibevalleyhq/vibevalley/internal/durable"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
	"github.com/vibevalleyhq/vibevalley/internal/vault"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/link"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func TestDesktopDefaultEmbeddedStackZeroTCPAndGovernance(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// 1. Default run() in --headless-check auto-launches embedded stack via init() registration.
	webDist := t.TempDir()
	if err := os.WriteFile(filepath.Join(webDist, "index.html"), []byte("<!doctype html><html><body>WebDist</body></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	var out, errBuf bytes.Buffer
	err := run(ctx, []string{
		"--web-dist", webDist,
		"--headless-check",
	}, func(string) string { return "" }, &out, &errBuf, DesktopDeps{
		Keychain:    NewMemoryKeychainDriver(),
		LiquidGlass: true,
	})
	if err != nil {
		t.Fatalf("headless run failed: %v (stderr=%s)", err, errBuf.String())
	}
	var chk map[string]any
	if err := json.Unmarshal(out.Bytes(), &chk); err != nil || chk["ok"] != true {
		t.Fatalf("unexpected headless-check output: %q err=%v", out.String(), err)
	}

	// 2. Full in-process desktop + embedded stack + Island + Automation roundtrip over 0 TCP sockets.
	permCfg := durable.DefaultPermissionConfig()
	permCfg.Overrides = map[string]contract.PermissionPolicy{
		"danger": contract.PolicyAlwaysAsk,
	}
	model := &desktopGovModel{}
	var capturedSt *stack.Stack

	app, err := NewDesktopApp(ctx, DesktopConfig{
		WebDistDir:    webDist,
		HeadlessCheck: true,
	}, DesktopDeps{
		Keychain:    NewMemoryKeychainDriver(),
		LiquidGlass: false,
		StackLauncher: func(lCtx context.Context, _ DesktopConfig, rk vault.RootKey) (EmbeddedStack, error) {
			rkCopy := rk
			st, err := stack.New(lCtx, stack.Config{
				DBPath:           ":memory:",
				VaultRootKey:     &rkCopy,
				ServerURL:        "chord://embedded",
				PermissionConfig: &permCfg,
				Model:            model,
				Tools: durable.ToolExecutorFunc(func(_ context.Context, _ string, _ durable.ToolCall) (json.RawMessage, error) {
					return json.RawMessage(`{"ok":true}`), nil
				}),
			})
			if err != nil {
				return nil, err
			}
			capturedSt = st
			return newEmbeddedStackFromRuntime(st), nil
		},
	})
	if err != nil {
		t.Fatalf("NewDesktopApp: %v", err)
	}
	defer func() { _ = app.Close() }()

	if app.Config.ServerURL != "chord://embedded" {
		t.Fatalf("expected chord://embedded ServerURL, got %q", app.Config.ServerURL)
	}

	// Connect an in-process WebView peer over Bridge.ClientTransport() (0 TCP sockets!).
	peerLink := link.NewLink(app.Bridge.ClientTransport(), link.Options{
		Principal:  link.Principal{Kind: link.PrincipalUserDevice, ID: "webview-1"},
		SidePrefix: "web",
	})
	if err := peerLink.Start(ctx); err != nil {
		t.Fatalf("peerLink.Start: %v", err)
	}
	defer func() { _ = peerLink.Close() }()

	var ping map[string]any
	if err := peerLink.Call(ctx, "health.ping", map[string]any{}, &ping); err != nil {
		t.Fatalf("in-process Bridge health.ping: %v", err)
	}
	if ping["serverUrl"] != "chord://embedded" {
		t.Fatalf("unexpected health.ping result: %+v", ping)
	}

	// Trigger permission park -> Island receives ApprovalPromptView via SpaceView -> approve via Island!
	if _, err := capturedSt.Store.CreateConversation(ctx, store.Conversation{ID: "conv-desk-perm"}); err != nil {
		t.Fatal(err)
	}
	cpBytes, _ := json.Marshal(durable.GenerationCheckpoint{
		ConversationID: "conv-desk-perm",
		TaskPrompt:     "test desktop approval",
		Tools:          []durable.ToolSpec{{Name: "danger"}},
	})
	if _, err := capturedSt.Scheduler.StartTask(ctx, store.Task{
		ID:             "task-desk-perm",
		ConversationID: "conv-desk-perm",
		Kind:           durable.TaskKindGeneration,
		PhaseName:      durable.PhaseGenerate,
		IsModelTask:    true,
		CheckpointJSON: cpBytes,
	}); err != nil {
		t.Fatal(err)
	}

	// Wait deterministically for Island to reflect the parked approval via SpaceSource WatchRaw!
	islandSubCh := make(chan IslandState, 16)
	unsubIsland := app.Island.SubscribeStateChange(func(st IslandState) {
		select {
		case islandSubCh <- st:
		default:
		}
	})
	defer unsubIsland()

	for {
		st := app.Island.State()
		if len(st.Approvals) == 1 && st.Approvals[0].TaskID == "task-desk-perm" {
			break
		}
		select {
		case <-islandSubCh:
		case <-ctx.Done():
			t.Fatalf("timed out waiting for Island ApprovalPromptView")
		}
	}

	// Trigger click via AutomationEndpoint to verify inspect/capture & approve via Island handler!
	snap, err := app.Automation.Inspect(ctx)
	if err != nil || snap.FramePending {
		t.Fatalf("Automation.Inspect failed: %+v err=%v", snap, err)
	}
	if _, err := app.Automation.Click(ctx, "approve:task-desk-perm"); err != nil {
		t.Fatalf("Automation.Click approve failed: %v", err)
	}
	doneTask, err := capturedSt.Scheduler.WaitTask(ctx, "task-desk-perm")
	if err != nil || doneTask.Status != store.TaskTerminal || doneTask.TerminalReason != store.ReasonCompleted {
		t.Fatalf("expected task-desk-perm completed after Island approval, got %+v err=%v", doneTask, err)
	}

	// Trigger budget alert -> Island receives BudgetAlert -> raise budget via Automation Click -> task completes!
	if _, err := capturedSt.Store.CreateConversation(ctx, store.Conversation{ID: "conv-desk-budget"}); err != nil {
		t.Fatal(err)
	}
	if _, err := capturedSt.Budget.SetBudget(ctx, "conv-desk-budget", contract.BudgetSpec{MaxCostMicros: 50}); err != nil {
		t.Fatal(err)
	}
	cost100 := int64(100)
	if _, err := capturedSt.Budget.RecordUsage(ctx, "conv-desk-budget", contract.UsageTotals{CostMicros: &cost100}); err != nil {
		t.Fatal(err)
	}
	bcp, _ := json.Marshal(durable.GenerationCheckpoint{
		ConversationID: "conv-desk-budget",
		TaskPrompt:     "test desktop budget",
	})
	if _, err := capturedSt.Scheduler.StartTask(ctx, store.Task{
		ID:             "task-desk-budget",
		ConversationID: "conv-desk-budget",
		Kind:           durable.TaskKindGeneration,
		PhaseName:      durable.PhaseGenerate,
		IsModelTask:    true,
		CheckpointJSON: bcp,
	}); err != nil {
		t.Fatal(err)
	}

	for {
		st := app.Island.State()
		if len(st.Budgets) == 1 && st.Budgets[0].ConversationID == "conv-desk-budget" {
			break
		}
		select {
		case <-islandSubCh:
		case <-ctx.Done():
			t.Fatalf("timed out waiting for Island BudgetAlert")
		}
	}

	if _, err := app.Automation.Click(ctx, "budget-raise:conv-desk-budget"); err != nil {
		t.Fatalf("Automation.Click raise budget: %v", err)
	}
	doneBudgetTask, err := capturedSt.Scheduler.WaitTask(ctx, "task-desk-budget")
	if err != nil || doneBudgetTask.Status != store.TaskTerminal || doneBudgetTask.TerminalReason != store.ReasonCompleted {
		t.Fatalf("expected task-desk-budget completed after Island raise, got %+v err=%v", doneBudgetTask, err)
	}
}

func TestVibeDesktopStaticBinarySizesAndCrossCompile(t *testing.T) {
	goBin := filepath.Join(runtime.GOROOT(), "bin", "go")
	tmpDir := t.TempDir()

	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}

	// Default full embedded-stack static binary (< 40 MiB).
	fullBin := filepath.Join(tmpDir, "vibe-desktop-full"+ext)
	buildFull := exec.Command(goBin, "build", "-trimpath", "-ldflags=-s -w", "-o", fullBin, "./")
	buildFull.Env = append(os.Environ(), "CGO_ENABLED=0", "GOROOT="+runtime.GOROOT())
	if out, err := buildFull.CombinedOutput(); err != nil {
		t.Fatalf("build default vibe-desktop: %v\n%s", err, string(out))
	}
	fullInfo, err := os.Stat(fullBin)
	if err != nil {
		t.Fatal(err)
	}
	const maxFullBytes = 40 * 1024 * 1024
	t.Logf("vibe-desktop full stripped static binary size: %d bytes (%.2f MiB)", fullInfo.Size(), float64(fullInfo.Size())/(1024*1024))
	if fullInfo.Size() >= maxFullBytes {
		t.Fatalf("vibe-desktop full stripped binary %d bytes exceeds 40 MiB limit (%d)", fullInfo.Size(), maxFullBytes)
	}

	// Remote-only thin_desktop static binary (< 18 MiB, accommodating cobra + koanf/yaml config).
	thinBin := filepath.Join(tmpDir, "vibe-desktop-thin"+ext)
	buildThin := exec.Command(goBin, "build", "-tags", "thin_desktop", "-trimpath", "-ldflags=-s -w", "-o", thinBin, "./")
	buildThin.Env = append(os.Environ(), "CGO_ENABLED=0", "GOROOT="+runtime.GOROOT())
	if out, err := buildThin.CombinedOutput(); err != nil {
		t.Fatalf("build thin_desktop vibe-desktop: %v\n%s", err, string(out))
	}
	thinInfo, err := os.Stat(thinBin)
	if err != nil {
		t.Fatal(err)
	}
	const maxThinBytes = 18 * 1024 * 1024
	t.Logf("vibe-desktop thin_desktop stripped static binary size: %d bytes (%.2f MiB)", thinInfo.Size(), float64(thinInfo.Size())/(1024*1024))
	if thinInfo.Size() >= maxThinBytes {
		t.Fatalf("vibe-desktop thin_desktop stripped binary %d bytes exceeds 18 MiB limit (%d)", thinInfo.Size(), maxThinBytes)
	}

	for _, target := range []struct{ goos, goarch string }{
		{"darwin", "arm64"},
		{"linux", "amd64"},
		{"windows", "amd64"},
	} {
		cmd := exec.Command(goBin, "build", "-o", os.DevNull, "./")
		cmd.Env = append(os.Environ(),
			"CGO_ENABLED=0",
			"GOOS="+target.goos,
			"GOARCH="+target.goarch,
			"GOROOT="+runtime.GOROOT(),
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("cross-compile %s/%s failed: %v\n%s", target.goos, target.goarch, err, string(out))
		}
	}
}

type desktopGovModel struct{}

func (m *desktopGovModel) Generate(_ context.Context, req durable.ModelRequest, _ func(string)) (durable.ModelResponse, error) {
	cost := int64(10)
	if strings.Contains(req.ConversationID, "perm") && len(req.Transcript.Entries) <= 1 {
		args, _ := json.Marshal(map[string]any{"action": "ask"})
		return durable.ModelResponse{
			ToolCalls: []durable.ToolCall{
				{ID: "call-desk-1", ToolName: "danger", ArgsJSON: args},
			},
			Usage: &contract.UsageTotals{CostMicros: &cost},
		}, nil
	}
	return durable.ModelResponse{
		Text:  "desktop done",
		Usage: &contract.UsageTotals{CostMicros: &cost},
	}, nil
}

func TestVibeDesktopEmbeddedMigrateSubcommands(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	tmp := t.TempDir()
	dbPath := filepath.Join(tmp, "desktop-mig.db")
	getenv := mapGetenv(map[string]string{"VIBEVALLEY_HOME": filepath.Join(tmp, "home")})

	var out, errBuf bytes.Buffer
	if err := run(ctx, []string{"migrate", "up", "--db", dbPath}, getenv, &out, &errBuf, DesktopDeps{}); err != nil {
		t.Fatalf("vibe-desktop migrate up failed: %v", err)
	}
	for _, scope := range stack.MigrationScopes() {
		if !strings.Contains(out.String(), "scope="+scope) {
			t.Fatalf("migrate up missing scope %s:\n%s", scope, out.String())
		}
	}

	out.Reset()
	if err := run(ctx, []string{"migrate", "status", "--db", dbPath}, getenv, &out, &errBuf, DesktopDeps{}); err != nil {
		t.Fatalf("vibe-desktop migrate status failed: %v", err)
	}
	if strings.Count(out.String(), "applied=true") != len(stack.MigrationScopes()) {
		t.Fatalf("expected all scopes applied=true:\n%s", out.String())
	}

	out.Reset()
	if err := run(ctx, []string{"migrate", "down", "--db", dbPath, "--all"}, getenv, &out, &errBuf, DesktopDeps{}); err != nil {
		t.Fatalf("vibe-desktop migrate down --all failed: %v", err)
	}
	if strings.Count(out.String(), "reverted=1") != len(stack.MigrationScopes()) {
		t.Fatalf("expected all scopes reverted=1:\n%s", out.String())
	}

	out.Reset()
	if err := run(ctx, []string{"migrate", "up", "--db", dbPath}, getenv, &out, &errBuf, DesktopDeps{}); err != nil {
		t.Fatalf("vibe-desktop migrate re-up failed: %v", err)
	}
	if strings.Count(out.String(), "applied=1") != len(stack.MigrationScopes()) {
		t.Fatalf("expected all scopes applied=1 on re-up:\n%s", out.String())
	}
}
