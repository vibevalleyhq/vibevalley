package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

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
