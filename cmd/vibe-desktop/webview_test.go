package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/egoist/mygo"
)

func TestWebViewAssetHandlerDiskEmbeddedAndProtocol(t *testing.T) {
	t.Parallel()

	// 1. Default embedded fallback works cleanly when no disk dir is specified.
	fbFS, err := NewWebAssetFS("", nil)
	if err != nil {
		t.Fatalf("NewWebAssetFS fallback: %v", err)
	}
	fbHandler, err := NewWebAssetHandler(fbFS)
	if err != nil {
		t.Fatalf("NewWebAssetHandler fallback: %v", err)
	}
	rec := httptest.NewRecorder()
	fbHandler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "VibeValley") {
		t.Fatalf("fallback response status=%d body=%q", rec.Code, rec.Body.String())
	}

	// 2. Explicit non-existent disk dir fails cleanly.
	if _, err := NewWebAssetFS(filepath.Join(t.TempDir(), "does-not-exist"), nil); err == nil {
		t.Fatal("expected error for missing web-dist directory")
	}

	// 3. Disk apps/web/dist layout: index.html, assets, SPA fallback, 404 missing asset, traversal block.
	distDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(distDir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(distDir, "index.html"), []byte("<!doctype html><html><body>SPA Root</body></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(distDir, "assets", "index-abc.js"), []byte("console.log('vibe');"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(distDir, "assets", "app-abc.css"), []byte("body{color:#000}"), 0o644); err != nil {
		t.Fatal(err)
	}

	diskFS, err := NewWebAssetFS(distDir, nil)
	if err != nil {
		t.Fatalf("NewWebAssetFS disk: %v", err)
	}
	diskHandler, err := NewWebAssetHandler(diskFS)
	if err != nil {
		t.Fatalf("NewWebAssetHandler disk: %v", err)
	}

	cases := []struct {
		method      string
		target      string
		wantCode    int
		wantTypeSub string
		wantBodySub string
	}{
		{http.MethodGet, "/", http.StatusOK, "text/html", "SPA Root"},
		{http.MethodGet, "/assets/index-abc.js", http.StatusOK, "text/javascript", "console.log"},
		{http.MethodGet, "/assets/app-abc.css", http.StatusOK, "text/css", "body{color"},
		{http.MethodGet, "/issues/iss-42", http.StatusOK, "text/html", "SPA Root"},
		{http.MethodGet, "/assets/missing.js", http.StatusNotFound, "", ""},
		{http.MethodGet, "/../secret.txt", http.StatusNotFound, "", ""},
		{http.MethodPost, "/", http.StatusMethodNotAllowed, "", ""},
	}
	for _, tc := range cases {
		rr := httptest.NewRecorder()
		diskHandler.ServeHTTP(rr, httptest.NewRequest(tc.method, tc.target, nil))
		if rr.Code != tc.wantCode {
			t.Errorf("%s %s: status=%d, want %d", tc.method, tc.target, rr.Code, tc.wantCode)
		}
		if tc.wantTypeSub != "" && !strings.Contains(rr.Header().Get("Content-Type"), tc.wantTypeSub) {
			t.Errorf("%s %s: Content-Type=%q, want substr %q", tc.method, tc.target, rr.Header().Get("Content-Type"), tc.wantTypeSub)
		}
		if tc.wantBodySub != "" && !strings.Contains(rr.Body.String(), tc.wantBodySub) {
			t.Errorf("%s %s: body=%q, want substr %q", tc.method, tc.target, rr.Body.String(), tc.wantBodySub)
		}
	}

	// 4. Register custom scheme with MyGo Protocol and verify WorkbenchWindowOptions.
	if err := RegisterWebProtocol("vibetest", diskHandler); err != nil {
		t.Fatalf("RegisterWebProtocol: %v", err)
	}
	t.Cleanup(func() { mygo.Protocol.Unhandle("vibetest") })
	if !mygo.Protocol.IsHandled("vibetest") {
		t.Fatal("expected vibetest scheme to be registered in mygo.Protocol")
	}

	winOpts := WorkbenchWindowOptions(WebViewConfig{Scheme: "vibetest", Host: "localhost"})
	if winOpts.URL != "vibetest://localhost/" {
		t.Fatalf("WindowOptions.URL = %q, want vibetest://localhost/", winOpts.URL)
	}
	if !strings.Contains(winOpts.Page.PreloadScript, "__vibevalleyChordTransport") {
		t.Fatal("WindowOptions missing Chord Bridge preload script")
	}
}

func TestResolveBundledWebDistDiscovery(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	appMacOSDir := filepath.Join(root, "VibeValley.app", "Contents", "MacOS")
	appWebDir := filepath.Join(root, "VibeValley.app", "Contents", "Resources", "web")
	repoWebDir := filepath.Join(root, "repo", "apps", "web", "dist")
	execPath := filepath.Join(appMacOSDir, "vibe-desktop")
	cwd := filepath.Join(root, "repo")

	// Nothing exists yet -> "".
	if got := ResolveBundledWebDist("", execPath, cwd); got != "" {
		t.Fatalf("expected empty when no web dist exists, got %q", got)
	}
	if got := ResolveBundledWebDist("", "", ""); got != "" {
		t.Fatalf("expected empty for blank execPath and cwd, got %q", got)
	}

	// Repository apps/web/dist fallback when only cwd has index.html.
	if err := os.MkdirAll(repoWebDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoWebDir, "index.html"), []byte("<html>repo</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := ResolveBundledWebDist("", execPath, cwd); got != repoWebDir {
		t.Fatalf("expected repo web dist %q, got %q", repoWebDir, got)
	}

	// .app/Contents/Resources/web without index.html is skipped in favor of cwd/apps/web/dist.
	if err := os.MkdirAll(appWebDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := ResolveBundledWebDist("", execPath, cwd); got != repoWebDir {
		t.Fatalf("expected repo fallback when bundle web lacks index.html, got %q", got)
	}

	// .app/Contents/Resources/web with index.html takes priority over cwd/apps/web/dist.
	if err := os.WriteFile(filepath.Join(appWebDir, "index.html"), []byte("<html>bundle</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := ResolveBundledWebDist("", execPath, cwd); got != appWebDir {
		t.Fatalf("expected bundle web dist %q, got %q", appWebDir, got)
	}

	// Explicit override always wins.
	explicit := filepath.Join(root, "custom-web")
	if got := ResolveBundledWebDist(explicit, execPath, cwd); got != explicit {
		t.Fatalf("expected explicit web dist %q, got %q", explicit, got)
	}
}
