package gateway_test

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/vibevalleyhq/vibevalley/internal/domain/agent"
	"github.com/vibevalleyhq/vibevalley/internal/domain/gateway"
	"github.com/vibevalleyhq/vibevalley/internal/domain/lan"
	"github.com/vibevalleyhq/vibevalley/internal/domain/media"
	"github.com/vibevalleyhq/vibevalley/internal/domain/repo"
	"github.com/vibevalleyhq/vibevalley/internal/domain/stack"
	"github.com/vibevalleyhq/vibevalley/internal/domain/user"
	"github.com/vibevalleyhq/vibevalley/internal/domain/voice"
)

func newTestGateway(t *testing.T, opts ...gateway.Option) (*stack.Stack, *gateway.Handler, *httptest.Server) {
	t.Helper()
	ctx := t.Context()
	homeDir := filepath.Join(t.TempDir(), "home")
	st, err := stack.New(ctx, stack.Config{
		DBPath:   ":memory:",
		WorkRoot: filepath.Join(t.TempDir(), "work"),
		HomeDir:  homeDir,
		Version:  "0.1.0-test",
		Getenv:   func(string) string { return "" },
	})
	if err != nil {
		t.Fatalf("stack.New: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	gw := gateway.NewHandler(st, opts...)
	ts := httptest.NewServer(gw)
	t.Cleanup(ts.Close)
	return st, gw, ts
}

func doPOST(t *testing.T, baseURL, path string, body any, headers map[string]string) (*http.Response, []byte) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		rdr = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, baseURL+path, rdr)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do POST %s: %v", path, err)
	}
	rawResp, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatalf("ReadAll %s: %v", path, err)
	}
	return resp, rawResp
}

func mustSuccessEnvelope(t *testing.T, path string, resp *http.Response, raw []byte, out any) {
	t.Helper()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST %s: HTTP status %d, want 200; body=%s", path, resp.StatusCode, string(raw))
	}
	var env struct {
		BizCode int             `json:"bizCode"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("decode envelope for %s: %v (raw=%s)", path, err, string(raw))
	}
	if env.BizCode != 0 || env.Message != "ok" {
		t.Fatalf("POST %s: expected bizCode=0 message=ok, got %+v", path, env)
	}
	if out != nil && len(env.Data) > 0 {
		if err := json.Unmarshal(env.Data, out); err != nil {
			t.Fatalf("decode data for %s: %v (data=%s)", path, err, string(env.Data))
		}
	}
}

func assertErrorEnvelope(t *testing.T, resp *http.Response, raw []byte, wantStatus, wantBizCode int) {
	t.Helper()
	if resp.StatusCode != wantStatus {
		t.Fatalf("HTTP status %d, want %d; body=%s", resp.StatusCode, wantStatus, string(raw))
	}
	var env gateway.ErrorEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("decode error envelope: %v (raw=%s)", err, string(raw))
	}
	if env.BizCode != wantBizCode {
		t.Fatalf("bizCode=%d, want %d; body=%s", env.BizCode, wantBizCode, string(raw))
	}
}

func TestGatewayEnvelopesErrorsAndMethodGuards(t *testing.T) {
	t.Parallel()
	_, _, ts := newTestGateway(t)

	// 1. 200 success with data.
	resp, raw := doPOST(t, ts.URL, "/api/v1/server/health/get", nil, nil)
	var health map[string]any
	mustSuccessEnvelope(t, "/api/v1/server/health/get", resp, raw, &health)
	if health["ok"] != true {
		t.Fatalf("unexpected health data: %v", health)
	}

	// 2. 200 void success omits data key cleanly.
	resp, raw = doPOST(t, ts.URL, "/api/v1/orchestrator/open", nil, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("orchestrator/open status=%d body=%s", resp.StatusCode, string(raw))
	}
	var voidMap map[string]any
	if err := json.Unmarshal(raw, &voidMap); err != nil {
		t.Fatal(err)
	}
	if _, hasData := voidMap["data"]; hasData {
		t.Fatalf("expected void response to omit data key, got %s", string(raw))
	}

	// 3. Method not allowed (405).
	getResp, err := http.Get(ts.URL + "/api/v1/setting/get")
	if err != nil {
		t.Fatal(err)
	}
	getRaw, _ := io.ReadAll(getResp.Body)
	getResp.Body.Close()
	assertErrorEnvelope(t, getResp, getRaw, http.StatusMethodNotAllowed, gateway.BizMethodNotAllowed)

	// 4. Unknown API route (404).
	resp, raw = doPOST(t, ts.URL, "/api/v1/unknown/endpoint", nil, nil)
	assertErrorEnvelope(t, resp, raw, http.StatusNotFound, gateway.BizRouteNotFound)

	// 5. Invalid JSON (400).
	badReq, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.URL+"/api/v1/setting/validate", strings.NewReader("{bad"))
	badReq.Header.Set("Content-Type", "application/json")
	badResp, err := http.DefaultClient.Do(badReq)
	if err != nil {
		t.Fatal(err)
	}
	badRaw, _ := io.ReadAll(badResp.Body)
	badResp.Body.Close()
	assertErrorEnvelope(t, badResp, badRaw, http.StatusBadRequest, gateway.BizInvalidInput)

	// 6. Missing issue (404 BizIssueNotFound).
	resp, raw = doPOST(t, ts.URL, "/api/v1/issue/get", map[string]string{"id": "missing-id"}, nil)
	assertErrorEnvelope(t, resp, raw, http.StatusNotFound, gateway.BizIssueNotFound)

	// 7. Cross-origin rejection (403 BizForbidden).
	resp, raw = doPOST(t, ts.URL, "/api/v1/server/health/get", nil, map[string]string{
		"Origin": "https://evil.example.com",
	})
	assertErrorEnvelope(t, resp, raw, http.StatusForbidden, gateway.BizForbidden)

	// 8. Local-only API rejected across LAN boundary (403 BizLanForbidden).
	resp, raw = doPOST(t, ts.URL, "/api/v1/media/input/create", map[string]any{
		"kind": "audio", "name": "mic.wav", "mime": "audio/wav", "size": 10,
	}, map[string]string{
		lan.HeaderOutside: "1",
	})
	assertErrorEnvelope(t, resp, raw, http.StatusForbidden, gateway.BizLanForbidden)
}

func TestGatewaySPALocaleCacheAndLoopbackEndpoints(t *testing.T) {
	t.Parallel()
	webDist := t.TempDir()
	if err := os.MkdirAll(filepath.Join(webDist, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(webDist, "index.html"), []byte("<!doctype html><html><body>OK</body></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(webDist, "assets", "bundle.js"), []byte("export const x=1;"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, _, ts := newTestGateway(t, gateway.WithWebDist(webDist))

	// Default locale -> zh-Hans.
	r1, err := http.Get(ts.URL + "/channels/general")
	if err != nil {
		t.Fatal(err)
	}
	b1, _ := io.ReadAll(r1.Body)
	r1.Body.Close()
	if r1.StatusCode != http.StatusOK || !strings.Contains(string(b1), `<html lang="zh-Hans" data-locale="zh">`) {
		t.Fatalf("unexpected HTML rewrite status=%d body=%s", r1.StatusCode, string(b1))
	}

	// Update locale to "en" -> SPA rewrites HTML to lang="en" data-locale="en".
	resp, raw := doPOST(t, ts.URL, "/api/v1/setting/update", map[string]any{"locale": "en"}, nil)
	mustSuccessEnvelope(t, "/api/v1/setting/update", resp, raw, nil)

	r2, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	b2, _ := io.ReadAll(r2.Body)
	r2.Body.Close()
	if r2.StatusCode != http.StatusOK || !strings.Contains(string(b2), `<html lang="en" data-locale="en">`) {
		t.Fatalf("expected updated en HTML rewrite, status=%d body=%s", r2.StatusCode, string(b2))
	}

	// Immutable Cache-Control on /assets/*.
	assetResp, err := http.Get(ts.URL + "/assets/bundle.js")
	if err != nil {
		t.Fatal(err)
	}
	assetResp.Body.Close()
	if assetResp.StatusCode != http.StatusOK || !strings.Contains(assetResp.Header.Get("Cache-Control"), "immutable") {
		t.Fatalf("expected immutable Cache-Control, got %q", assetResp.Header.Get("Cache-Control"))
	}

	// Unknown /api/v1/* stays JSON 404, not SPA index.html.
	apiMiss, err := http.Get(ts.URL + "/api/v1/nonexistent/route")
	if err != nil {
		t.Fatal(err)
	}
	apiMissRaw, _ := io.ReadAll(apiMiss.Body)
	apiMiss.Body.Close()
	assertErrorEnvelope(t, apiMiss, apiMissRaw, http.StatusNotFound, gateway.BizRouteNotFound)

	// /mcp works locally and is blocked with X-Vibe-Outside=1.
	mcpReq, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`))
	mcpReq.Header.Set("Content-Type", "application/json")
	mcpResp, err := http.DefaultClient.Do(mcpReq)
	if err != nil {
		t.Fatal(err)
	}
	mcpResp.Body.Close()
	if mcpResp.StatusCode != http.StatusOK {
		t.Fatalf("local POST /mcp status=%d, want 200", mcpResp.StatusCode)
	}

	mcpOutside, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.URL+"/mcp", strings.NewReader(`{}`))
	mcpOutside.Header.Set(lan.HeaderOutside, "1")
	mcpOutResp, err := http.DefaultClient.Do(mcpOutside)
	if err != nil {
		t.Fatal(err)
	}
	mcpOutRaw, _ := io.ReadAll(mcpOutResp.Body)
	mcpOutResp.Body.Close()
	assertErrorEnvelope(t, mcpOutResp, mcpOutRaw, http.StatusForbidden, gateway.BizLanForbidden)

	// /v1/chat/completions blocked when remote.
	ccReq, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.URL+"/v1/chat/completions", strings.NewReader(`{}`))
	ccReq.Header.Set(lan.HeaderOutside, "1")
	ccResp, err := http.DefaultClient.Do(ccReq)
	if err != nil {
		t.Fatal(err)
	}
	ccRaw, _ := io.ReadAll(ccResp.Body)
	ccResp.Body.Close()
	assertErrorEnvelope(t, ccResp, ccRaw, http.StatusForbidden, gateway.BizLanForbidden)
}

func TestGatewaySSEAndSubscribeStreams(t *testing.T) {
	t.Parallel()
	st, _, ts := newTestGateway(t)

	// Create an issue + channel message first so streams have rich data.
	resp, raw := doPOST(t, ts.URL, "/api/v1/issue/create", map[string]any{
		"title": "SSE Test Issue",
	}, nil)
	var created struct {
		ID string `json:"id"`
	}
	mustSuccessEnvelope(t, "/api/v1/issue/create", resp, raw, &created)

	// 1. GET /api/v1/state non-SSE returns JSON {rev, space, frame}.
	stateJSON, err := http.Get(ts.URL + "/api/v1/state")
	if err != nil {
		t.Fatal(err)
	}
	var snapBody map[string]any
	_ = json.NewDecoder(stateJSON.Body).Decode(&snapBody)
	stateJSON.Body.Close()
	if snapBody["frame"] == nil || snapBody["space"] == nil || snapBody["rev"] == nil {
		t.Fatalf("missing frame/space/rev: %v", snapBody)
	}

	// 2. GET /api/v1/state SSE pushes initial frame + updates on NotifyStateChange.
	ctxSSE, cancelSSE := context.WithCancel(t.Context())
	defer cancelSSE()
	sseReq, _ := http.NewRequestWithContext(ctxSSE, http.MethodGet, ts.URL+"/api/v1/state", nil)
	sseReq.Header.Set("Accept", "text/event-stream")
	sseResp, err := http.DefaultClient.Do(sseReq)
	if err != nil {
		t.Fatal(err)
	}
	defer sseResp.Body.Close()
	if !strings.HasPrefix(sseResp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("expected text/event-stream, got %q", sseResp.Header.Get("Content-Type"))
	}
	sc := bufio.NewScanner(sseResp.Body)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	if !sc.Scan() || !strings.HasPrefix(sc.Text(), "data: ") {
		t.Fatalf("expected initial data frame, got %q err=%v", sc.Text(), sc.Err())
	}
	st.NotifyStateChange()
	// Read blank line + next data line.
	var secondData string
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "data: ") {
			secondData = line
			break
		}
	}
	if secondData == "" {
		t.Fatalf("expected state update SSE push after NotifyStateChange")
	}

	// 3. /api/v1/live emits initial : ping.
	ctxLive, cancelLive := context.WithCancel(t.Context())
	defer cancelLive()
	liveReq, _ := http.NewRequestWithContext(ctxLive, http.MethodGet, ts.URL+"/api/v1/live", nil)
	liveResp, err := http.DefaultClient.Do(liveReq)
	if err != nil {
		t.Fatal(err)
	}
	defer liveResp.Body.Close()
	liveSc := bufio.NewScanner(liveResp.Body)
	if !liveSc.Scan() || liveSc.Text() != ": ping" {
		t.Fatalf("expected initial : ping on /api/v1/live, got %q err=%v", liveSc.Text(), liveSc.Err())
	}

	// 4. /api/v1/events emits initial snapshot.
	ctxEv, cancelEv := context.WithCancel(t.Context())
	defer cancelEv()
	evReq, _ := http.NewRequestWithContext(ctxEv, http.MethodGet, ts.URL+"/api/v1/events", nil)
	evResp, err := http.DefaultClient.Do(evReq)
	if err != nil {
		t.Fatal(err)
	}
	defer evResp.Body.Close()
	evSc := bufio.NewScanner(evResp.Body)
	if !evSc.Scan() || !strings.Contains(evSc.Text(), `"type":"snapshot"`) {
		t.Fatalf("expected snapshot event on /api/v1/events, got %q err=%v", evSc.Text(), evSc.Err())
	}

	// 5. /api/v1/issue/watch/:id.
	ctxWatch, cancelWatch := context.WithCancel(t.Context())
	defer cancelWatch()
	wReq, _ := http.NewRequestWithContext(ctxWatch, http.MethodGet, ts.URL+"/api/v1/issue/watch/"+created.ID, nil)
	wResp, err := http.DefaultClient.Do(wReq)
	if err != nil {
		t.Fatal(err)
	}
	defer wResp.Body.Close()
	wSc := bufio.NewScanner(wResp.Body)
	if !wSc.Scan() || !strings.Contains(wSc.Text(), created.ID) {
		t.Fatalf("expected initial issue watch snapshot containing %s, got %q", created.ID, wSc.Text())
	}

	// 6. /api/v1/subscribe/channel.follow + bad payload rejection.
	badSub, err := http.Get(ts.URL + "/api/v1/subscribe/channel.follow?payload=not-json")
	if err != nil {
		t.Fatal(err)
	}
	badSubRaw, _ := io.ReadAll(badSub.Body)
	badSub.Body.Close()
	assertErrorEnvelope(t, badSub, badSubRaw, http.StatusBadRequest, gateway.BizInvalidInput)

	sendResp, sendRaw := doPOST(t, ts.URL, "/api/v1/channel/message/send", map[string]any{
		"id":   "general",
		"text": "hello channel follow",
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/channel/message/send", sendResp, sendRaw, nil)

	payload := url.QueryEscape(`{"id":"general","after":0}`)
	ctxSub, cancelSub := context.WithCancel(t.Context())
	defer cancelSub()
	subReq, _ := http.NewRequestWithContext(ctxSub, http.MethodGet, ts.URL+"/api/v1/subscribe/channel.follow?payload="+payload, nil)
	subResp, err := http.DefaultClient.Do(subReq)
	if err != nil {
		t.Fatal(err)
	}
	defer subResp.Body.Close()
	subSc := bufio.NewScanner(subResp.Body)
	var seenMsg bool
	for subSc.Scan() {
		line := subSc.Text()
		if strings.HasPrefix(line, "data: ") && strings.Contains(line, `"_tag":"Message"`) && strings.Contains(line, "hello channel follow") {
			seenMsg = true
			break
		}
	}
	if !seenMsg {
		t.Fatalf("expected Message event on channel.follow, err=%v", subSc.Err())
	}
}

func TestGatewayBinaryMediaAttachmentAndArtifactRoutes(t *testing.T) {
	t.Parallel()
	_, _, ts := newTestGateway(t)

	// 1. Attachments: HTML sandboxed, PDF unsandboxed.
	htmlBytes := []byte("<html><script>alert(1)</script></html>")
	resp, raw := doPOST(t, ts.URL, "/api/v1/attachment/create", map[string]any{
		"name": "evil.html",
		"type": "text/html",
		"data": base64.StdEncoding.EncodeToString(htmlBytes),
	}, nil)
	var attHTML struct {
		ID string `json:"id"`
	}
	mustSuccessEnvelope(t, "/api/v1/attachment/create", resp, raw, &attHTML)
	sum := sha256.Sum256(htmlBytes)
	if attHTML.ID != hex.EncodeToString(sum[:]) {
		t.Fatalf("expected SHA-256 id, got %q", attHTML.ID)
	}

	attResp, err := http.Get(ts.URL + "/api/v1/attachment/" + attHTML.ID)
	if err != nil {
		t.Fatal(err)
	}
	attResp.Body.Close()
	if attResp.Header.Get("Content-Security-Policy") != "sandbox" {
		t.Fatalf("expected CSP sandbox on HTML attachment, got %q", attResp.Header.Get("Content-Security-Policy"))
	}

	pdfBytes := []byte("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF")
	resp, raw = doPOST(t, ts.URL, "/api/v1/attachment/create", map[string]any{
		"name": "doc.pdf",
		"type": "application/pdf",
		"data": base64.StdEncoding.EncodeToString(pdfBytes),
	}, nil)
	var attPDF struct {
		ID string `json:"id"`
	}
	mustSuccessEnvelope(t, "/api/v1/attachment/create (pdf)", resp, raw, &attPDF)
	pdfResp, err := http.Get(ts.URL + "/api/v1/attachment/" + attPDF.ID)
	if err != nil {
		t.Fatal(err)
	}
	pdfResp.Body.Close()
	if pdfResp.Header.Get("Content-Security-Policy") != "" {
		t.Fatalf("expected no CSP sandbox on PDF attachment, got %q", pdfResp.Header.Get("Content-Security-Policy"))
	}

	// 2. Artifact HTML preview route with shell=1&theme=dark&print=1.
	resp, raw = doPOST(t, ts.URL, "/api/v1/artifact/create", map[string]any{
		"title":   "Demo Page",
		"kind":    "html",
		"display": "page",
		"content": "<h1>Hello Artifact</h1>",
	}, nil)
	var artCreated struct {
		ID string `json:"id"`
	}
	mustSuccessEnvelope(t, "/api/v1/artifact/create", resp, raw, &artCreated)

	prevResp, err := http.Get(fmt.Sprintf("%s/api/v1/artifact/%s/1?shell=1&theme=dark&print=1", ts.URL, artCreated.ID))
	if err != nil {
		t.Fatal(err)
	}
	prevBody, _ := io.ReadAll(prevResp.Body)
	prevResp.Body.Close()
	if prevResp.StatusCode != http.StatusOK ||
		!strings.Contains(prevResp.Header.Get("Content-Security-Policy"), "sandbox allow-scripts") ||
		!strings.Contains(prevResp.Header.Get("Content-Security-Policy"), "allow-modals") ||
		!strings.Contains(string(prevBody), "color-scheme:dark") ||
		!strings.Contains(string(prevBody), `vibevalley: "selection"`) ||
		!strings.Contains(string(prevBody), "<h1>Hello Artifact</h1>") {
		t.Fatalf("unexpected artifact preview status=%d csp=%q body=%s", prevResp.StatusCode, prevResp.Header.Get("Content-Security-Policy"), string(prevBody))
	}

	// 3. Media input PUT content & GET with HTTP Range (206 & 416).
	resp, raw = doPOST(t, ts.URL, "/api/v1/media/input/create", map[string]any{
		"kind": "audio",
		"name": "clip.bin",
		"mime": "application/octet-stream",
		"size": 10,
	}, nil)
	var mediaIn struct {
		ID string `json:"id"`
	}
	mustSuccessEnvelope(t, "/api/v1/media/input/create", resp, raw, &mediaIn)

	putReq, _ := http.NewRequestWithContext(t.Context(), http.MethodPut, ts.URL+"/api/v1/media/input/"+mediaIn.ID+"/content", strings.NewReader("0123456789"))
	putResp, err := http.DefaultClient.Do(putReq)
	if err != nil {
		t.Fatal(err)
	}
	putResp.Body.Close()
	if putResp.StatusCode != http.StatusOK {
		t.Fatalf("PUT media content status=%d", putResp.StatusCode)
	}

	rangeReq, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.URL+"/api/v1/media/input/"+mediaIn.ID+"/content", nil)
	rangeReq.Header.Set("Range", "bytes=2-5")
	rangeResp, err := http.DefaultClient.Do(rangeReq)
	if err != nil {
		t.Fatal(err)
	}
	rangeBody, _ := io.ReadAll(rangeResp.Body)
	rangeResp.Body.Close()
	if rangeResp.StatusCode != http.StatusPartialContent ||
		rangeResp.Header.Get("Content-Range") != "bytes 2-5/10" ||
		string(rangeBody) != "2345" {
		t.Fatalf("unexpected 206 response status=%d content-range=%q body=%q", rangeResp.StatusCode, rangeResp.Header.Get("Content-Range"), string(rangeBody))
	}

	badRangeReq, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.URL+"/api/v1/media/input/"+mediaIn.ID+"/content", nil)
	badRangeReq.Header.Set("Range", "bytes=99-120")
	badRangeResp, err := http.DefaultClient.Do(badRangeReq)
	if err != nil {
		t.Fatal(err)
	}
	badRangeResp.Body.Close()
	if badRangeResp.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("expected 416 for unsatisfiable range, got %d", badRangeResp.StatusCode)
	}

	// 4. Media speech NDJSON stream.
	resp, raw = doPOST(t, ts.URL, "/api/v1/media/speech/create", map[string]any{
		"id":   "speech-1",
		"text": "hello world",
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/media/speech/create", resp, raw, nil)
	spResp, err := http.Get(ts.URL + "/api/v1/media/speech/speech-1/stream")
	if err != nil {
		t.Fatal(err)
	}
	spBody, _ := io.ReadAll(spResp.Body)
	spResp.Body.Close()
	if spResp.StatusCode != http.StatusOK || !strings.Contains(spResp.Header.Get("Content-Type"), "application/x-ndjson") || !strings.Contains(string(spBody), `"type":"done"`) {
		t.Fatalf("unexpected speech stream status=%d ct=%q body=%s", spResp.StatusCode, spResp.Header.Get("Content-Type"), string(spBody))
	}
}

func TestGatewayLANListenerIsolationAndPairing(t *testing.T) {
	t.Parallel()
	st, _, ts := newTestGateway(t)

	openTrue := true
	portZero := 0
	resp, raw := doPOST(t, ts.URL, "/api/v1/lan/update", map[string]any{
		"open": openTrue,
		"port": portZero,
	}, nil)
	var lanStatus lan.LanStatus
	mustSuccessEnvelope(t, "/api/v1/lan/update", resp, raw, &lanStatus)
	if !lanStatus.Open || lanStatus.Port <= 0 {
		t.Fatalf("expected open LAN status with bound port, got %+v", lanStatus)
	}

	// Mount st.LAN.Handler() directly so middleware+upstream isolation is tested even on NIC-less CI hosts.
	lanTS := httptest.NewServer(st.LAN.Handler())
	t.Cleanup(lanTS.Close)

	// Unauthenticated LAN call to /api/v1/channel/list must be rejected (401/403).
	unauthResp, _ := doPOST(t, lanTS.URL, "/api/v1/channel/list", nil, nil)
	if unauthResp.StatusCode != http.StatusUnauthorized && unauthResp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected unauthenticated LAN request blocked, got %d", unauthResp.StatusCode)
	}

	var token string
	if lanStatus.URL != "" {
		resp, raw = doPOST(t, ts.URL, "/api/v1/lan/pairing/start", nil, nil)
		var pst lan.LanStatus
		mustSuccessEnvelope(t, "/api/v1/lan/pairing/start", resp, raw, &pst)
		if pst.Pairing == nil {
			t.Fatalf("expected pairing info")
		}
		resCh := make(chan lan.LanPaired, 1)
		errCh := make(chan error, 1)
		go func() {
			paired, pErr := st.LAN.PairWithCode(t.Context(), pst.Pairing.Code, "phone-test")
			if pErr != nil {
				errCh <- pErr
				return
			}
			resCh <- paired
		}()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if p := st.LAN.Get().Pairing; p != nil && p.Asking != "" {
				resp, raw = doPOST(t, ts.URL, "/api/v1/lan/pairing/answer", map[string]any{"allow": true}, nil)
				mustSuccessEnvelope(t, "/api/v1/lan/pairing/answer", resp, raw, nil)
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		select {
		case paired := <-resCh:
			token = paired.Key
		case pErr := <-errCh:
			t.Fatalf("PairWithCode failed: %v", pErr)
		case <-time.After(3 * time.Second):
			t.Fatal("timed out waiting for LAN pairing result")
		}
	} else {
		minted, err := st.User.MintDevice("phone-test", user.DeviceCamePaired)
		if err != nil {
			t.Fatalf("MintDevice: %v", err)
		}
		token = minted.Key
	}

	// Paired device can list channels across LAN!
	resp, raw = doPOST(t, lanTS.URL, "/api/v1/channel/list", nil, map[string]string{
		"Authorization": "Bearer " + token,
	})
	mustSuccessEnvelope(t, "LAN /api/v1/channel/list", resp, raw, nil)

	// Paired device STILL blocked from local-only media import, /mcp, and /v1/chat/completions over LAN.
	mediaLAN, _ := doPOST(t, lanTS.URL, "/api/v1/media/input/create", map[string]any{
		"kind": "audio", "name": "a.wav", "mime": "audio/wav", "size": 1,
	}, map[string]string{
		"Authorization": "Bearer " + token,
	})
	if mediaLAN.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for media/input/create over LAN, got %d", mediaLAN.StatusCode)
	}
	mcpLAN, _ := doPOST(t, lanTS.URL, "/mcp", map[string]any{}, map[string]string{
		"Authorization": "Bearer " + token,
	})
	if mcpLAN.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for /mcp over LAN even with valid token, got %d", mcpLAN.StatusCode)
	}
	ccLAN, _ := doPOST(t, lanTS.URL, "/v1/chat/completions", map[string]any{}, map[string]string{
		"Authorization": "Bearer " + token,
	})
	if ccLAN.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for /v1/chat/completions over LAN, got %d", ccLAN.StatusCode)
	}
}

func TestGatewaySQLiteRestartPersistenceAndDiskBlobs(t *testing.T) {
	ctx := t.Context()
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "platform.db")
	homeDir := filepath.Join(tmpDir, "home")
	workRoot := filepath.Join(tmpDir, "work")

	st1, err := stack.New(ctx, stack.Config{
		DBPath:   dbPath,
		HomeDir:  homeDir,
		WorkRoot: workRoot,
		Version:  "0.1.0-test",
		Getenv:   func(string) string { return "" },
	})
	if err != nil {
		t.Fatalf("stack.New(1): %v", err)
	}
	gw1 := gateway.NewHandler(st1)
	ts1 := httptest.NewServer(gw1)

	// Populate normalized gateway_* tables.
	resp, raw := doPOST(t, ts1.URL, "/api/v1/issue/create", map[string]any{
		"title": "Persist SQLc Issue",
		"text":  "Ensure overlay rows persist cleanly across restart.",
	}, nil)
	var iss gateway.ProtoIssue
	mustSuccessEnvelope(t, "/api/v1/issue/create", resp, raw, &iss)

	resp, raw = doPOST(t, ts1.URL, "/api/v1/channel/message/send", map[string]any{
		"id":   "general",
		"text": "hello persistent world",
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/channel/message/send", resp, raw, nil)

	resp, raw = doPOST(t, ts1.URL, "/api/v1/cron/create", map[string]any{
		"name":    "ny-cron",
		"text":    "run check",
		"channel": "general",
		"when":    map[string]any{"kind": "cron", "expr": "15 9 * * *"},
		"tz":      "America/New_York",
	}, nil)
	var cr gateway.ProtoCron
	mustSuccessEnvelope(t, "/api/v1/cron/create", resp, raw, &cr)

	resp, raw = doPOST(t, ts1.URL, "/api/v1/artifact/create", map[string]any{
		"title":   "Design Spec",
		"kind":    "html",
		"content": "<p>Hello</p>",
	}, nil)
	var artObj struct {
		ID string `json:"id"`
	}
	mustSuccessEnvelope(t, "/api/v1/artifact/create", resp, raw, &artObj)

	resp, raw = doPOST(t, ts1.URL, "/api/v1/pkm/comment/suggest", map[string]any{
		"block":   "inbox-b1",
		"comment": "Needs detail",
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/pkm/comment/suggest", resp, raw, nil)

	resp, raw = doPOST(t, ts1.URL, "/api/v1/pkm/clip/create", map[string]any{
		"url":   "https://example.com/spec",
		"title": "Spec",
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/pkm/clip/create", resp, raw, nil)

	// Upload raw binary bytes for media input; bytes must go to disk, not SQLite JSON.
	rawMediaBytes := []byte("PNG-RAW-BINARY-PAYLOAD-0123456789ABCDEF")
	resp, raw = doPOST(t, ts1.URL, "/api/v1/media/input/create", map[string]any{
		"kind": "image", "name": "pic.png", "mime": "image/png", "size": len(rawMediaBytes),
	}, nil)
	var mediaIn gateway.ProtoMediaInput
	mustSuccessEnvelope(t, "/api/v1/media/input/create", resp, raw, &mediaIn)

	putReq, _ := http.NewRequestWithContext(ctx, http.MethodPut, ts1.URL+"/api/v1/media/input/"+mediaIn.ID+"/content", bytes.NewReader(rawMediaBytes))
	putResp, err := http.DefaultClient.Do(putReq)
	if err != nil {
		t.Fatalf("PUT media content: %v", err)
	}
	putResp.Body.Close()
	if putResp.StatusCode != http.StatusOK {
		t.Fatalf("PUT media status=%d", putResp.StatusCode)
	}

	ts1.Close()
	if err := gw1.Close(); err != nil {
		t.Fatalf("gw1.Close: %v", err)
	}
	if err := st1.Close(); err != nil {
		t.Fatalf("st1.Close: %v", err)
	}

	// Verify durable_document has zero gateway.overlay rows.
	durDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open durable db: %v", err)
	}
	var docCount int
	if err := durDB.QueryRowContext(ctx, `SELECT COUNT(*) FROM durable_document WHERE doc_kind = 'gateway.overlay'`).Scan(&docCount); err != nil {
		_ = durDB.Close()
		t.Fatalf("query durable_document: %v", err)
	}
	_ = durDB.Close()
	if docCount != 0 {
		t.Fatalf("expected 0 gateway.overlay rows in durable_document, got %d", docCount)
	}

	// Inspect sidecar platform.gateway.db directly.
	gwDBPath := stack.ScopeDBPath(dbPath, "gateway")
	gwDB, err := sql.Open("sqlite", gwDBPath)
	if err != nil {
		t.Fatalf("open gateway db: %v", err)
	}
	for _, tbl := range []string{"gateway_kv", "gateway_issue", "gateway_channel", "gateway_cron", "gateway_artifact", "gateway_media_input", "gateway_pkm_comment", "gateway_pkm_clip"} {
		var cnt int
		if err := gwDB.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+tbl).Scan(&cnt); err != nil || cnt == 0 {
			_ = gwDB.Close()
			t.Fatalf("expected non-zero rows in %s: cnt=%d err=%v", tbl, cnt, err)
		}
	}
	var blobPath, payloadJSON string
	var nextRun sql.NullString
	if err := gwDB.QueryRowContext(ctx, `SELECT blob_path, payload_json FROM gateway_media_input WHERE id = ?`, mediaIn.ID).Scan(&blobPath, &payloadJSON); err != nil {
		_ = gwDB.Close()
		t.Fatalf("query gateway_media_input: %v", err)
	}
	if err := gwDB.QueryRowContext(ctx, `SELECT next_run_at FROM gateway_cron WHERE id = ?`, cr.ID).Scan(&nextRun); err != nil {
		_ = gwDB.Close()
		t.Fatalf("query gateway_cron: %v", err)
	}
	_ = gwDB.Close()

	if blobPath == "" {
		t.Fatal("expected non-empty blob_path on disk for media input")
	}
	diskBytes, err := os.ReadFile(blobPath)
	if err != nil || !bytes.Equal(diskBytes, rawMediaBytes) {
		t.Fatalf("expected disk blob %q to contain exact uploaded bytes; got=%q err=%v", blobPath, string(diskBytes), err)
	}
	if strings.Contains(payloadJSON, string(rawMediaBytes)) || strings.Contains(payloadJSON, base64.StdEncoding.EncodeToString(rawMediaBytes)) {
		t.Fatalf("media bytes leaked into gateway_media_input.payload_json: %s", payloadJSON)
	}
	if !nextRun.Valid || nextRun.String == "" {
		t.Fatalf("expected gateway_cron.next_run_at populated, got %+v", nextRun)
	}

	// Reopen Stack + Gateway against the same DBPath & HomeDir.
	st2, err := stack.New(ctx, stack.Config{
		DBPath:   dbPath,
		HomeDir:  homeDir,
		WorkRoot: workRoot,
		Version:  "0.1.0-test",
		Getenv:   func(string) string { return "" },
	})
	if err != nil {
		t.Fatalf("stack.New(2): %v", err)
	}
	defer func() { _ = st2.Close() }()
	gw2 := gateway.NewHandler(st2)
	defer func() { _ = gw2.Close() }()
	ts2 := httptest.NewServer(gw2)
	defer ts2.Close()

	resp, raw = doPOST(t, ts2.URL, "/api/v1/issue/get", map[string]any{"id": iss.ID}, nil)
	var reloadedIss gateway.ProtoIssue
	mustSuccessEnvelope(t, "restart /api/v1/issue/get", resp, raw, &reloadedIss)
	if reloadedIss.Title != "Persist SQLc Issue" || reloadedIss.Number != iss.Number {
		t.Fatalf("unexpected reloaded issue: %+v", reloadedIss)
	}

	resp, raw = doPOST(t, ts2.URL, "/api/v1/cron/list", nil, nil)
	var crons []gateway.ProtoCron
	mustSuccessEnvelope(t, "restart /api/v1/cron/list", resp, raw, &crons)
	if len(crons) != 1 || crons[0].ID != cr.ID || crons[0].TZ != "America/New_York" {
		t.Fatalf("unexpected reloaded crons: %+v", crons)
	}

	resp, raw = doPOST(t, ts2.URL, "/api/v1/artifact/list", nil, nil)
	var arts []struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	mustSuccessEnvelope(t, "restart /api/v1/artifact/list", resp, raw, &arts)
	if len(arts) != 1 || arts[0].ID != artObj.ID || arts[0].Title != "Design Spec" {
		t.Fatalf("unexpected reloaded artifacts: %+v", arts)
	}

	resp, raw = doPOST(t, ts2.URL, "/api/v1/pkm/comment/list", map[string]any{"page": "inbox"}, nil)
	var comments []gateway.ProtoPkmComment
	mustSuccessEnvelope(t, "restart /api/v1/pkm/comment/list", resp, raw, &comments)
	if len(comments) != 1 || comments[0].Body != "Needs detail" {
		t.Fatalf("unexpected reloaded pkm comments: %+v", comments)
	}

	getResp, err := http.Get(ts2.URL + "/api/v1/media/input/" + mediaIn.ID + "/content")
	if err != nil {
		t.Fatalf("GET restarted media input: %v", err)
	}
	gotBytes, _ := io.ReadAll(getResp.Body)
	getResp.Body.Close()
	if getResp.StatusCode != http.StatusOK || !bytes.Equal(gotBytes, rawMediaBytes) {
		t.Fatalf("restarted media GET status=%d bytes=%q", getResp.StatusCode, string(gotBytes))
	}

	// Deleting media input also cleans up disk blob.
	resp, raw = doPOST(t, ts2.URL, "/api/v1/media/input/delete", map[string]any{"id": mediaIn.ID}, nil)
	mustSuccessEnvelope(t, "/api/v1/media/input/delete", resp, raw, nil)
	if _, statErr := os.Stat(blobPath); !os.IsNotExist(statErr) {
		t.Fatalf("expected disk blob %q removed on delete, statErr=%v", blobPath, statErr)
	}
}

func TestCronComputeNextRunTimezonesAndExecution(t *testing.T) {
	// Verify pure-Go 5-field cron parser across UTC, Asia/Shanghai, America/New_York (including DST skip).
	utcNow := time.Date(2026, 5, 10, 8, 10, 0, 0, time.UTC)
	nextUTC, err := gateway.ComputeNextRun("*/15 9-17 * * 0", "UTC", utcNow)
	if err != nil {
		t.Fatalf("ComputeNextRun UTC: %v", err)
	}
	wantUTC := time.Date(2026, 5, 10, 9, 0, 0, 0, time.UTC)
	if !nextUTC.Equal(wantUTC) {
		t.Fatalf("UTC next=%v, want %v", nextUTC, wantUTC)
	}

	shLoc, _ := time.LoadLocation("Asia/Shanghai")
	nextSH, err := gateway.ComputeNextRun("30 14 * * *", "Asia/Shanghai", time.Date(2026, 5, 10, 6, 0, 0, 0, time.UTC)) // 14:00 CST
	if err != nil {
		t.Fatalf("ComputeNextRun Shanghai: %v", err)
	}
	wantSH := time.Date(2026, 5, 10, 14, 30, 0, 0, shLoc)
	if !nextSH.Equal(wantSH) {
		t.Fatalf("Shanghai next=%v, want %v", nextSH, wantSH)
	}

	// America/New_York DST spring forward on 2026-03-08: 02:30 does not exist, so next occurrence is 2026-03-09 02:30 EDT.
	nyLoc, _ := time.LoadLocation("America/New_York")
	dstNow := time.Date(2026, 3, 8, 1, 0, 0, 0, nyLoc)
	nextNY, err := gateway.ComputeNextRun("30 2 * * *", "America/New_York", dstNow)
	if err != nil {
		t.Fatalf("ComputeNextRun NY DST: %v", err)
	}
	wantNY := time.Date(2026, 3, 9, 2, 30, 0, 0, nyLoc)
	if !nextNY.Equal(wantNY) {
		t.Fatalf("NY DST next=%v, want %v", nextNY, wantNY)
	}

	if _, err := gateway.ComputeNextRun("bad expr", "UTC", utcNow); err == nil {
		t.Fatal("expected error for invalid 2-field cron expr")
	}
	if _, err := gateway.ComputeNextRun("* * * * *", "Invalid/Zone_XYZ", utcNow); err == nil {
		t.Fatal("expected error for invalid timezone")
	}

	// End-to-end RunCronNow (POST /api/v1/cron/run) and due tick execution.
	st, gw, ts := newTestGateway(t, gateway.WithCronTickInterval(15*time.Millisecond))
	_ = gw

	resp, raw := doPOST(t, ts.URL, "/api/v1/cron/create", map[string]any{
		"name":    "daily-check",
		"text":    "Check scheduled tasks",
		"channel": "general",
		"when":    map[string]any{"kind": "cron", "expr": "*/5 * * * *"},
		"tz":      "Asia/Shanghai",
	}, nil)
	var cr gateway.ProtoCron
	mustSuccessEnvelope(t, "/api/v1/cron/create", resp, raw, &cr)

	// Manual trigger via POST /api/v1/cron/run.
	resp, raw = doPOST(t, ts.URL, "/api/v1/cron/run", map[string]any{"id": cr.ID}, nil)
	var runRes gateway.CronRunResult
	mustSuccessEnvelope(t, "/api/v1/cron/run", resp, raw, &runRes)
	if !runRes.Ran || runRes.ID != cr.ID || runRes.IssueID == "" || runRes.LastRunAt <= 0 || runRes.NextRunAt <= runRes.LastRunAt {
		t.Fatalf("unexpected cron/run result: %+v", runRes)
	}

	// Verify issue created & channel posted.
	iss, err := st.Issues.GetIssue(t.Context(), runRes.IssueID)
	if err != nil || iss.Title != "daily-check" {
		t.Fatalf("expected cron issue created, got (%+v, %v)", iss, err)
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/channel/message/list", map[string]any{"id": "general"}, nil)
	var msgs []gateway.ProtoChatMessage
	mustSuccessEnvelope(t, "/api/v1/channel/message/list", resp, raw, &msgs)
	foundMsg := false
	for _, m := range msgs {
		if strings.Contains(m.Text, "Check scheduled tasks") {
			foundMsg = true
			break
		}
	}
	if !foundMsg {
		t.Fatalf("expected cron prompt posted to channel, got %+v", msgs)
	}

	// Due execution via RunDueCrons advancing time cleanly past NextRunAt.
	futureDue := time.UnixMilli(runRes.NextRunAt + 1000)
	fires, err := gw.RunDueCrons(t.Context(), futureDue)
	if err != nil || len(fires) != 1 || fires[0].ID != cr.ID || fires[0].NextRunAt <= futureDue.UnixMilli() {
		t.Fatalf("expected RunDueCrons to fire %s and advance nextRunAt; fires=%+v err=%v", cr.ID, fires, err)
	}
}

func TestConnectorWebhookChallengeAndInboundOutboundRoundtrip(t *testing.T) {
	t.Setenv("VIBEVALLEY_TEST_RUNTIMES", "")
	st, _, ts := newTestGateway(t)

	// 1. Feishu / Slack challenge verification JSON response.
	resp, raw := doPOST(t, ts.URL, "/api/v1/connector/webhook/feishu", map[string]any{
		"type":      "url_verification",
		"challenge": "chal-verify-123",
	}, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("challenge status=%d body=%s", resp.StatusCode, string(raw))
	}
	var chalOut map[string]string
	if err := json.Unmarshal(raw, &chalOut); err != nil || chalOut["challenge"] != "chal-verify-123" {
		t.Fatalf("unexpected challenge response: %s", string(raw))
	}

	// 2. Mock Telegram HTTP API server to capture outbound delivery.
	var (
		outMu      sync.Mutex
		outbound   []map[string]any
		outboundCh = make(chan struct{}, 2)
	)
	tgMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/botsecret-tok/getMe":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"result":{"id":123,"is_bot":true,"username":"vv_bot"}}`))
		case "/botsecret-tok/sendMessage":
			rawReq, _ := io.ReadAll(r.Body)
			var payload map[string]any
			_ = json.Unmarshal(rawReq, &payload)
			outMu.Lock()
			outbound = append(outbound, payload)
			outMu.Unlock()
			select {
			case outboundCh <- struct{}{}:
			default:
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":9001}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer tgMock.Close()

	// Create an offline-testable worker agent DM channel bound to Telegram connector.
	_, err := st.Agents.SaveProfile(t.Context(), agent.Profile{
		ID:      "webhook-bot",
		Name:    "WebhookBot",
		Role:    agent.RoleWorker,
		Runtime: "pi",
	})
	if err != nil {
		t.Fatalf("SaveProfile: %v", err)
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/channel/direct/create", map[string]any{"agent": "webhook-bot"}, nil)
	var dmID string
	mustSuccessEnvelope(t, "/api/v1/channel/direct/create", resp, raw, &dmID)

	resp, raw = doPOST(t, ts.URL, "/api/v1/connector/login", map[string]any{
		"id":         "telegram",
		"botToken":   "secret-tok",
		"apiBaseUrl": tgMock.URL,
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/connector/login", resp, raw, nil)

	resp, raw = doPOST(t, ts.URL, "/api/v1/connector/channel/set", map[string]any{
		"id":      "telegram",
		"channel": dmID,
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/connector/channel/set", resp, raw, nil)

	// Enable pi offline reply for deterministic responder output OR let an agent post a reply on the bound channel.
	// Also test outbound forwarding when an agent replies to the bound channel.
	t.Setenv("VIBEVALLEY_TEST_RUNTIMES", "1")
	resp, raw = doPOST(t, ts.URL, "/api/v1/connector/webhook/telegram", map[string]any{
		"update_id": 1001,
		"message": map[string]any{
			"message_id": 55,
			"from":       map[string]any{"id": 42, "username": "alice"},
			"chat":       map[string]any{"id": 777, "type": "private"},
			"text":       "status report please",
		},
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/connector/webhook/telegram", resp, raw, nil)

	select {
	case <-outboundCh:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for outbound connector delivery after inbound webhook")
	}

	outMu.Lock()
	defer outMu.Unlock()
	if len(outbound) != 1 {
		t.Fatalf("expected 1 outbound telegram message, got %d (%+v)", len(outbound), outbound)
	}
	if fmt.Sprint(outbound[0]["chat_id"]) != "777" || !strings.Contains(fmt.Sprint(outbound[0]["text"]), "status report please") {
		t.Fatalf("unexpected outbound telegram payload: %+v", outbound[0])
	}
}

func TestGatewayLiveMediaVendorRunnerAndRealtimeWS(t *testing.T) {
	t.Setenv("VIBEVALLEY_TEST_RUNTIMES", "")

	// Minimal valid 1x1 PNG for image generation response.
	samplePNG := base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\nfake-png-data"))
	sampleWAV := []byte("RIFF\x24\x00\x00\x00WAVEfmt ")

	var (
		mu         sync.Mutex
		seenPaths  []string
		wsAuthSeen string
	)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seenPaths = append(seenPaths, r.URL.Path)
		mu.Unlock()

		switch r.URL.Path {
		case "/v1/images/generations":
			if r.Header.Get("Authorization") != "Bearer test-live-key" {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprintf(w, `{"data":[{"b64_json":%q,"revised_prompt":"ok"}]}`, samplePNG)
		case "/v1/chat/completions":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"cmpl-1","model":"gpt-4o-mini","choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"Live image described accurately."}}],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}`))
		case "/v1/audio/speech":
			w.Header().Set("Content-Type", "audio/wav")
			_, _ = w.Write(sampleWAV)
		case "/v1/realtime":
			mu.Lock()
			wsAuthSeen = r.Header.Get("Authorization")
			mu.Unlock()
			hj, ok := w.(http.Hijacker)
			if !ok {
				http.Error(w, "hijack unsupported", http.StatusInternalServerError)
				return
			}
			key := r.Header.Get("Sec-WebSocket-Key")
			sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
			accept := base64.StdEncoding.EncodeToString(sum[:])
			conn, rw, err := hj.Hijack()
			if err != nil {
				return
			}
			defer conn.Close()
			_, _ = fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", accept)
			_ = rw.Flush()
			// Read one masked frame from client, echo an unmasked server text frame.
			op, msg, rErr := readTestWSFrame(rw.Reader)
			if rErr == nil && op == 0x1 {
				_ = writeTestWSFrame(conn, 0x1, []byte("upstream-echo:"+string(msg)))
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	vendorCfg := media.VendorConfig{
		BaseURL: upstream.URL + "/v1",
		APIKey:  "test-live-key",
		Model:   "gpt-live-1",
	}
	wsURL := "ws" + strings.TrimPrefix(upstream.URL, "http") + "/v1/realtime"
	_, _, ts := newTestGateway(t,
		gateway.WithMediaVendorConfig("image", vendorCfg),
		gateway.WithMediaVendorConfig("understanding", vendorCfg),
		gateway.WithMediaVendorConfig("speech", vendorCfg),
		gateway.WithRealtimeRelayConfig("live", voice.RelayConfig{
			UpstreamURL: wsURL,
			APIKey:      "test-ws-key",
		}),
	)

	// 1. Live Image generation.
	resp, raw := doPOST(t, ts.URL, "/api/v1/media/image/create", map[string]any{
		"id": "img-live-1", "prompt": "a sunset farm", "width": 512, "height": 512,
	}, nil)
	var imgJob struct {
		Phase      string         `json:"phase"`
		Attachment map[string]any `json:"attachment"`
	}
	mustSuccessEnvelope(t, "/api/v1/media/image/create", resp, raw, &imgJob)
	if imgJob.Phase != "ready" || imgJob.Attachment == nil {
		t.Fatalf("unexpected live image job: %s", string(raw))
	}

	// 2. Upload media input -> Authorize -> Start Understanding.
	resp, raw = doPOST(t, ts.URL, "/api/v1/media/input/create", map[string]any{
		"kind": "image", "name": "in.png", "mime": "image/png", "size": 4,
	}, nil)
	var mediaIn gateway.ProtoMediaInput
	mustSuccessEnvelope(t, "/api/v1/media/input/create", resp, raw, &mediaIn)

	putReq, _ := http.NewRequestWithContext(t.Context(), http.MethodPut, ts.URL+"/api/v1/media/input/"+mediaIn.ID+"/content", strings.NewReader("PNG!"))
	putResp, err := http.DefaultClient.Do(putReq)
	if err != nil {
		t.Fatalf("PUT input: %v", err)
	}
	putResp.Body.Close()

	resp, raw = doPOST(t, ts.URL, "/api/v1/media/understanding/authorize", map[string]any{
		"id": "und-live-1", "prompt": "describe", "inputs": []string{mediaIn.ID},
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/media/understanding/authorize", resp, raw, nil)

	resp, raw = doPOST(t, ts.URL, "/api/v1/media/understanding/start", map[string]any{"id": "und-live-1"}, nil)
	var undJob struct {
		Phase  string `json:"phase"`
		Result struct {
			Text string `json:"text"`
		} `json:"result"`
	}
	mustSuccessEnvelope(t, "/api/v1/media/understanding/start", resp, raw, &undJob)
	if undJob.Phase != "ready" || undJob.Result.Text != "Live image described accurately." {
		t.Fatalf("unexpected live understanding start result: %s", string(raw))
	}

	// 3. Live streaming speech synthesis.
	resp, raw = doPOST(t, ts.URL, "/api/v1/media/speech/create", map[string]any{
		"id": "sp-live-1", "text": "hello farm", "streaming": true, "format": "wav",
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/media/speech/create", resp, raw, nil)

	spResp, err := http.Get(ts.URL + "/api/v1/media/speech/sp-live-1/stream")
	if err != nil {
		t.Fatalf("GET speech stream: %v", err)
	}
	spBody, _ := io.ReadAll(spResp.Body)
	spResp.Body.Close()
	if spResp.StatusCode != http.StatusOK || !strings.Contains(string(spBody), `"type":"audio"`) || !strings.Contains(string(spBody), `"type":"done"`) {
		t.Fatalf("unexpected live speech stream status=%d body=%s", spResp.StatusCode, string(spBody))
	}

	// 4. Live realtime WebSocket proxy at /api/v1/voice/realtime.
	u, _ := url.Parse(ts.URL)
	conn, err := net.DialTimeout("tcp", u.Host, 3*time.Second)
	if err != nil {
		t.Fatalf("dial gateway WS: %v", err)
	}
	defer conn.Close()
	wsReq := fmt.Sprintf("GET /api/v1/voice/realtime HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n", u.Host)
	if _, err := conn.Write([]byte(wsReq)); err != nil {
		t.Fatalf("write ws handshake: %v", err)
	}
	br := bufio.NewReader(conn)
	statusLine, _ := br.ReadString('\n')
	if !strings.Contains(statusLine, "101") {
		t.Fatalf("expected 101 Switching Protocols, got %q", statusLine)
	}
	for {
		line, lErr := br.ReadString('\n')
		if lErr != nil || line == "\r\n" {
			break
		}
	}
	if err := writeMaskedTestWSFrame(conn, 0x1, []byte("ping-ws")); err != nil {
		t.Fatalf("write masked client ws frame: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	op, payload, err := readTestWSFrame(br)
	if err != nil || op != 0x1 || string(payload) != "upstream-echo:ping-ws" {
		t.Fatalf("unexpected proxied ws reply: op=%d payload=%q err=%v", op, string(payload), err)
	}

	mu.Lock()
	defer mu.Unlock()
	if wsAuthSeen != "Bearer test-ws-key" {
		t.Fatalf("expected upstream WS Authorization Bearer header, got %q", wsAuthSeen)
	}
}

func TestGatewayLiveRepoAndGitHubHelpers(t *testing.T) {
	t.Setenv("VIBEVALLEY_TEST_RUNTIMES", "")
	ctx := t.Context()

	gitDir := t.TempDir()
	runGit := func(args ...string) {
		t.Helper()
		cmd := exec.CommandContext(ctx, "git", args...)
		cmd.Dir = gitDir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v failed: %v\n%s", args, err, string(out))
		}
	}
	runGit("init", "-b", "main")
	runGit("config", "user.name", "Test Author")
	runGit("config", "user.email", "test@example.com")
	_ = os.WriteFile(filepath.Join(gitDir, "main.go"), []byte("package main\nfunc main() {}\n"), 0o644)
	_ = os.WriteFile(filepath.Join(gitDir, "app.ts"), []byte("export const x = 1;\n"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "initial commit")
	runGit("checkout", "-b", "feat/demo")
	_ = os.WriteFile(filepath.Join(gitDir, "extra.go"), []byte("package main\nfunc extra() int { return 2 }\n"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "add extra feature")

	st, _, ts := newTestGateway(t)
	if _, err := st.Repos.RegisterRepo(ctx, repo.Repository{
		ID:            "live-repo",
		Name:          "live-repo",
		RootPath:      gitDir,
		DefaultBranch: "main",
	}); err != nil {
		t.Fatalf("RegisterRepo: %v", err)
	}

	resp, raw := doPOST(t, ts.URL, "/api/v1/github/refresh", nil, nil)
	var ghStatus gateway.ProtoGitHubStatus
	mustSuccessEnvelope(t, "/api/v1/github/refresh", resp, raw, &ghStatus)
	if ghStatus.CheckedAt <= 0 {
		t.Fatalf("expected checkedAt set by ProbeGitHubCLI, got %+v", ghStatus)
	}

	resp, raw = doPOST(t, ts.URL, "/api/v1/repo/language/list", map[string]any{"id": "live-repo"}, nil)
	var langOut struct {
		Repo      string `json:"repo"`
		Languages []struct {
			Name  string `json:"name"`
			Files int    `json:"files"`
			Code  int    `json:"code"`
		} `json:"languages"`
	}
	mustSuccessEnvelope(t, "/api/v1/repo/language/list", resp, raw, &langOut)
	if len(langOut.Languages) < 2 {
		t.Fatalf("expected Go and TypeScript language stats, got %+v", langOut.Languages)
	}

	resp, raw = doPOST(t, ts.URL, "/api/v1/repo/activity/get", map[string]any{"id": "live-repo"}, nil)
	var actOut struct {
		Total   int `json:"total"`
		Days    []repo.DayCount
		Authors []repo.AuthorCount
	}
	mustSuccessEnvelope(t, "/api/v1/repo/activity/get", resp, raw, &actOut)
	if actOut.Total != 2 || len(actOut.Authors) == 0 || actOut.Authors[0].Name != "Test Author" {
		t.Fatalf("unexpected activity output: %+v", actOut)
	}

	resp, raw = doPOST(t, ts.URL, "/api/v1/repo/pr/submit", map[string]any{
		"cwd":    gitDir,
		"branch": "feat/demo",
		"base":   "main",
		"title":  "Add extra feature",
		"body":   "Summary",
		"dryRun": true,
	}, nil)
	var prOut struct {
		Check  string `json:"check"`
		Pushed bool   `json:"pushed"`
		SHA    string `json:"sha"`
		Branch string `json:"branch"`
	}
	mustSuccessEnvelope(t, "/api/v1/repo/pr/submit", resp, raw, &prOut)
	if prOut.Check != "preview" || prOut.Pushed || prOut.SHA == "" || prOut.Branch != "feat/demo" {
		t.Fatalf("unexpected dryRun PR submit output: %+v", prOut)
	}
}

func readTestWSFrame(r *bufio.Reader) (byte, []byte, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	op := hdr[0] & 0x0F
	masked := (hdr[1] & 0x80) != 0
	n := int(hdr[1] & 0x7F)
	switch n {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return 0, nil, err
		}
		n = int(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return 0, nil, err
		}
		n = int(binary.BigEndian.Uint64(ext[:]))
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return 0, nil, err
		}
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range buf {
			buf[i] ^= mask[i%4]
		}
	}
	return op, buf, nil
}

func writeTestWSFrame(w io.Writer, op byte, payload []byte) error {
	hdr := [2]byte{0x80 | (op & 0x0F), byte(len(payload))}
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

func writeMaskedTestWSFrame(w io.Writer, op byte, payload []byte) error {
	hdr := [2]byte{0x80 | (op & 0x0F), 0x80 | byte(len(payload))}
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	mask := [4]byte{1, 2, 3, 4}
	if _, err := w.Write(mask[:]); err != nil {
		return err
	}
	out := make([]byte, len(payload))
	for i := range payload {
		out[i] = payload[i] ^ mask[i%4]
	}
	_, err := w.Write(out)
	return err
}
