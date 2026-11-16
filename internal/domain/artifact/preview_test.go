package artifact_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/vibevalleyhq/vibevalley/internal/domain/artifact"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func TestIsolatedPreviewHandlerCSPOverHTTP(t *testing.T) {
	ctx := context.Background()

	// Spin up an independent mock workbench server to verify cross-origin separation.
	wbSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("workbench-secret-session"))
	}))
	defer wbSrv.Close()
	wbURL, _ := url.Parse(wbSrv.URL)

	svc, err := artifact.NewService(artifact.ServiceConfig{
		WorkbenchHosts:      []string{wbURL.Host, "workbench.local:8787"},
		AllowWorkbenchEmbed: true,
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	pub, err := svc.Deliverables.Publish(ctx, artifact.PublishRequest{
		ID:      "art-preview",
		Title:   "Preview Widget",
		Display: contract.ArtifactDisplaySlides,
		Bundle: &artifact.CompileRequest{
			Entry: "src/App.tsx",
			Files: map[string]string{
				"src/App.tsx": `
export const App = () => <section className="title"><h1>Isolated Deck</h1></section>;
const el = document.getElementById("root");
if (el) el.textContent = "Isolated Deck";
`,
			},
		},
	})
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}

	previewSrv := httptest.NewServer(svc.Preview)
	defer previewSrv.Close()
	previewURL, _ := url.Parse(previewSrv.URL)

	// Reconfigure with explicit PreviewHost matching the isolated preview listener.
	isolatedHandler := artifact.NewPreviewHandler(artifact.PreviewConfig{
		Store:               svc.Deliverables,
		CAS:                 svc.CAS,
		PreviewHost:         previewURL.Host,
		WorkbenchHosts:      []string{wbURL.Host, "workbench.local:8787"},
		AllowWorkbenchEmbed: false,
	})
	isolatedSrv := httptest.NewServer(isolatedHandler)
	defer isolatedSrv.Close()

	// Update isolated handler host expectation cleanly via direct PreviewHost check on second server.
	isoURL, _ := url.Parse(isolatedSrv.URL)
	strictHandler := artifact.NewPreviewHandler(artifact.PreviewConfig{
		Store:          svc.Deliverables,
		CAS:            svc.CAS,
		PreviewHost:    isoURL.Host,
		WorkbenchHosts: []string{wbURL.Host, "workbench.local:8787"},
	})
	strictSrv := httptest.NewServer(strictHandler)
	defer strictSrv.Close()
	strictURL, _ := url.Parse(strictSrv.URL)
	// Recreate strictHandler bound to strictSrv's actual port.
	strictHandler = artifact.NewPreviewHandler(artifact.PreviewConfig{
		Store:          svc.Deliverables,
		CAS:            svc.CAS,
		PreviewHost:    strictURL.Host,
		WorkbenchHosts: []string{wbURL.Host, "workbench.local:8787"},
	})
	strictSrv.Config.Handler = strictHandler

	paths := []string{
		artifact.SHA256PreviewPath(pub.Card.SHA256),
		artifact.ArtifactVersionPreviewPath("art-preview", 1),
		"/api/v1/artifact/art-preview/1",
	}

	for _, p := range paths {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, strictSrv.URL+p, nil)
		if err != nil {
			t.Fatalf("NewRequest %s: %v", p, err)
		}
		// Simulate cross-origin request originating from the workbench origin.
		req.Header.Set("Origin", wbSrv.URL)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET %s: %v", p, err)
		}
		bodyBytes, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status=%d body=%s", p, resp.StatusCode, string(bodyBytes))
		}
		body := string(bodyBytes)
		if !strings.Contains(body, "Isolated Deck") {
			t.Fatalf("GET %s missing compiled bundle content: %s", p, body)
		}

		csp := resp.Header.Get("Content-Security-Policy")
		for _, required := range []string{
			"default-src 'none'",
			"script-src 'unsafe-inline'",
			"style-src 'unsafe-inline'",
			"img-src data: blob:",
			"connect-src 'none'",
			"form-action 'none'",
			"base-uri 'none'",
			"sandbox allow-scripts",
		} {
			if !strings.Contains(csp, required) {
				t.Fatalf("GET %s CSP %q missing %q", p, csp, required)
			}
		}
		if strings.Contains(csp, "allow-same-origin") {
			t.Fatalf("GET %s CSP must NOT include allow-same-origin: %q", p, csp)
		}

		if got := resp.Header.Get("X-Content-Type-Options"); got != "nosniff" {
			t.Fatalf("expected nosniff, got %q", got)
		}
		if got := resp.Header.Get("Referrer-Policy"); got != "no-referrer" {
			t.Fatalf("expected no-referrer, got %q", got)
		}
		if got := resp.Header.Get("Cross-Origin-Opener-Policy"); got != "same-origin" {
			t.Fatalf("expected COOP same-origin, got %q", got)
		}
		if got := resp.Header.Get("Cross-Origin-Resource-Policy"); got != "same-origin" {
			t.Fatalf("expected CORP same-origin, got %q", got)
		}
		if got := resp.Header.Get("Origin-Agent-Cluster"); got != "?1" {
			t.Fatalf("expected Origin-Agent-Cluster ?1, got %q", got)
		}
		if resp.Header.Get("Access-Control-Allow-Origin") != "" || resp.Header.Get("Access-Control-Allow-Credentials") != "" {
			t.Fatalf("preview must never grant CORS access or credentials: %+v", resp.Header)
		}
		if !strings.Contains(resp.Header.Get("Cache-Control"), "immutable") {
			t.Fatalf("expected immutable cache-control, got %q", resp.Header.Get("Cache-Control"))
		}
		if resp.Header.Get("ETag") != `"`+pub.Card.SHA256+`"` {
			t.Fatalf("unexpected ETag: %q", resp.Header.Get("ETag"))
		}
	}

	// Verify 304 Not Modified via ETag.
	req304, _ := http.NewRequestWithContext(ctx, http.MethodGet, strictSrv.URL+artifact.SHA256PreviewPath(pub.Card.SHA256), nil)
	req304.Header.Set("If-None-Match", `"`+pub.Card.SHA256+`"`)
	resp304, err := http.DefaultClient.Do(req304)
	if err != nil {
		t.Fatalf("GET 304: %v", err)
	}
	resp304.Body.Close()
	if resp304.StatusCode != http.StatusNotModified {
		t.Fatalf("expected 304, got %d", resp304.StatusCode)
	}

	// Verify workbench host impersonation is rejected with 403 Forbidden.
	rec := httptest.NewRecorder()
	wbReq := httptest.NewRequest(http.MethodGet, "http://workbench.local:8787"+artifact.SHA256PreviewPath(pub.Card.SHA256), nil)
	wbReq.Host = "workbench.local:8787"
	strictHandler.ServeHTTP(rec, wbReq)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 when served on workbench host, got %d", rec.Code)
	}

	// Verify credentialed Authorization header is rejected with 403 Forbidden.
	recAuth := httptest.NewRecorder()
	authReq := httptest.NewRequest(http.MethodGet, "http://"+strictURL.Host+artifact.SHA256PreviewPath(pub.Card.SHA256), nil)
	authReq.Host = strictURL.Host
	authReq.Header.Set("Authorization", "Bearer workbench-secret-token")
	strictHandler.ServeHTTP(recAuth, authReq)
	if recAuth.Code != http.StatusForbidden {
		t.Fatalf("expected 403 when Authorization header supplied, got %d", recAuth.Code)
	}

	// Verify non-GET/HEAD methods are rejected with 405 Method Not Allowed.
	recPost := httptest.NewRecorder()
	postReq := httptest.NewRequest(http.MethodPost, "http://"+strictURL.Host+artifact.SHA256PreviewPath(pub.Card.SHA256), nil)
	postReq.Host = strictURL.Host
	strictHandler.ServeHTTP(recPost, postReq)
	if recPost.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 for POST, got %d", recPost.Code)
	}

	// Verify ?print=1 keeps strict network/origin CSP while adding allow-modals.
	recPrint := httptest.NewRecorder()
	printReq := httptest.NewRequest(http.MethodGet, "http://"+strictURL.Host+artifact.ArtifactVersionPreviewPath("art-preview", 1)+"?print=1", nil)
	printReq.Host = strictURL.Host
	strictHandler.ServeHTTP(recPrint, printReq)
	if recPrint.Code != http.StatusOK {
		t.Fatalf("expected 200 for print preview, got %d", recPrint.Code)
	}
	printCSP := recPrint.Header().Get("Content-Security-Policy")
	if !strings.Contains(printCSP, "allow-modals") || !strings.Contains(printCSP, "connect-src 'none'") || strings.Contains(printCSP, "allow-same-origin") {
		t.Fatalf("unexpected print CSP: %q", printCSP)
	}

	// Verify path traversal and invalid SHA return 404/400.
	for _, bad := range []string{"/preview/sha256/../secret", "/preview/sha256/not-a-sha", "/preview/artifact/art-preview/999"} {
		recBad := httptest.NewRecorder()
		badReq := httptest.NewRequest(http.MethodGet, "http://"+strictURL.Host+bad, nil)
		badReq.Host = strictURL.Host
		strictHandler.ServeHTTP(recBad, badReq)
		if recBad.Code != http.StatusBadRequest && recBad.Code != http.StatusNotFound {
			t.Fatalf("expected 400/404 for %q, got %d", bad, recBad.Code)
		}
	}
}
