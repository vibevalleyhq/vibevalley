package gateway_test

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/gateway"
	"github.com/vibevalleyhq/vibevalley/internal/domain/lan"
	"github.com/vibevalleyhq/vibevalley/internal/domain/stack"
	"github.com/vibevalleyhq/vibevalley/internal/domain/user"
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
		prevResp.Header.Get("Content-Security-Policy") != "sandbox allow-scripts" ||
		!strings.Contains(string(prevBody), `theme=dark data-print="1"`) ||
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
