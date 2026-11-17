package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type stubCatalog struct {
	specs []ToolSpec
	call  func(ctx context.Context, caller CallerContext, name string, args json.RawMessage) (ToolResult, error)
}

func (s *stubCatalog) ListTools(_ context.Context, _ CallerContext) ([]ToolSpec, error) {
	return s.specs, nil
}

func (s *stubCatalog) CallTool(ctx context.Context, caller CallerContext, name string, args json.RawMessage) (ToolResult, error) {
	if s.call != nil {
		return s.call(ctx, caller, name, args)
	}
	return ToolResult{}, ErrToolNotFound
}

func TestMCPLoopbackOnlyAndStreamableHTTPMethods(t *testing.T) {
	t.Parallel()

	cat := &stubCatalog{
		specs: []ToolSpec{
			{
				Name:        "issue_list",
				Description: "List issues",
				InputSchema: json.RawMessage(`{"type":"object","properties":{"status":{"type":"string"}}}`),
			},
		},
		call: func(_ context.Context, caller CallerContext, name string, args json.RawMessage) (ToolResult, error) {
			if name != "issue_list" {
				return ToolResult{}, errors.New("not found with token " + caller.Token)
			}
			return ToolResult{
				Content: []ContentBlock{{Type: "text", Text: caller.SessionID + ":" + string(args)}},
			}, nil
		},
	}

	h := NewHandler(Config{
		ServerVersion: "1.2.3",
		Catalog:       cat,
		Authenticate: func(_ context.Context, token string) (string, bool) {
			if token == "sess-tok-1" {
				return "w1", true
			}
			return "", false
		},
	})
	defer func() { _ = h.Close() }()

	// Reject non-loopback RemoteAddr.
	remoteReq := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	remoteReq.RemoteAddr = "192.168.1.44:50000"
	remoteRec := httptest.NewRecorder()
	h.ServeHTTP(remoteRec, remoteReq)
	if remoteRec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for non-loopback RemoteAddr, got %d", remoteRec.Code)
	}

	// Reject loopback request marked as LAN-forwarded.
	lanReq := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	lanReq.RemoteAddr = "127.0.0.1:50000"
	lanReq.Header.Set("X-Vibevalley-Outside", "1")
	lanRec := httptest.NewRecorder()
	h.ServeHTTP(lanRec, lanReq)
	if lanRec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for X-Vibevalley-Outside, got %d", lanRec.Code)
	}

	// initialize returns 2025-03-26 protocolVersion and Mcp-Session-Id.
	initReq := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}`))
	initReq.RemoteAddr = "127.0.0.1:50001"
	initRec := httptest.NewRecorder()
	h.ServeHTTP(initRec, initReq)
	if initRec.Code != http.StatusOK {
		t.Fatalf("initialize expected 200, got %d (%s)", initRec.Code, initRec.Body.String())
	}
	sessID := initRec.Header().Get(SessionHeader)
	if sessID == "" {
		t.Fatalf("expected Mcp-Session-Id response header")
	}
	var initResp struct {
		Result struct {
			ProtocolVersion string `json:"protocolVersion"`
			ServerInfo      struct {
				Name    string `json:"name"`
				Version string `json:"version"`
			} `json:"serverInfo"`
		} `json:"result"`
	}
	if err := json.Unmarshal(initRec.Body.Bytes(), &initResp); err != nil {
		t.Fatal(err)
	}
	if initResp.Result.ProtocolVersion != ProtocolVersion || initResp.Result.ServerInfo.Version != "1.2.3" {
		t.Fatalf("unexpected initialize payload: %+v", initResp)
	}

	// notifications/initialized returns 202 Accepted.
	notifReq := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	notifReq.RemoteAddr = "[::1]:50002"
	notifRec := httptest.NewRecorder()
	h.ServeHTTP(notifRec, notifReq)
	if notifRec.Code != http.StatusAccepted {
		t.Fatalf("notifications/initialized expected 202, got %d", notifRec.Code)
	}

	// ping returns {}.
	pingReq := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":2,"method":"ping"}`))
	pingReq.RemoteAddr = "127.0.0.1:50003"
	pingRec := httptest.NewRecorder()
	h.ServeHTTP(pingRec, pingReq)
	if pingRec.Code != http.StatusOK || !strings.Contains(pingRec.Body.String(), `"result":{}`) {
		t.Fatalf("unexpected ping response: %d %s", pingRec.Code, pingRec.Body.String())
	}

	// tools/list returns catalog specs.
	listReq := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":3,"method":"tools/list"}`))
	listReq.RemoteAddr = "127.0.0.1:50004"
	listReq.Header.Set("Authorization", "Bearer sess-tok-1")
	listRec := httptest.NewRecorder()
	h.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK || !strings.Contains(listRec.Body.String(), `"issue_list"`) {
		t.Fatalf("unexpected tools/list response: %d %s", listRec.Code, listRec.Body.String())
	}

	// tools/call dispatches to ToolCatalog and passes authenticated SessionID.
	callReq := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"issue_list","arguments":{"status":"queued"}}}`))
	callReq.RemoteAddr = "127.0.0.1:50005"
	callReq.Header.Set("Authorization", "Bearer sess-tok-1")
	callRec := httptest.NewRecorder()
	h.ServeHTTP(callRec, callReq)
	if callRec.Code != http.StatusOK || !strings.Contains(callRec.Body.String(), `w1:{\"status\":\"queued\"}`) {
		t.Fatalf("unexpected tools/call response: %d %s", callRec.Code, callRec.Body.String())
	}

	// tools/call redacts caller token on error and rejects unknown tokens.
	badToolReq := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"missing_tool"}}`))
	badToolReq.RemoteAddr = "127.0.0.1:50006"
	badToolReq.Header.Set("Authorization", "Bearer sess-tok-1")
	badToolRec := httptest.NewRecorder()
	h.ServeHTTP(badToolRec, badToolReq)
	if strings.Contains(badToolRec.Body.String(), "sess-tok-1") || !strings.Contains(badToolRec.Body.String(), "[redacted]") {
		t.Fatalf("expected token redaction in tool error, got: %s", badToolRec.Body.String())
	}

	unauthCall := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"issue_list"}}`))
	unauthCall.RemoteAddr = "127.0.0.1:50007"
	unauthRec := httptest.NewRecorder()
	h.ServeHTTP(unauthRec, unauthCall)
	if !strings.Contains(unauthRec.Body.String(), `"isError":true`) {
		t.Fatalf("expected isError=true for unknown caller, got %s", unauthRec.Body.String())
	}

	// GET /mcp opens SSE stream on loopback and stops on cancel.
	ctx, cancel := context.WithCancel(context.Background())
	srv := httptest.NewServer(h)
	defer srv.Close()

	getReq, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/mcp", nil)
	getReq.Header.Set("Accept", "text/event-stream")
	getReq.Header.Set(SessionHeader, sessID)
	getResp, err := http.DefaultClient.Do(getReq)
	if err != nil {
		t.Fatalf("GET /mcp failed: %v", err)
	}
	if getResp.StatusCode != http.StatusOK || !strings.HasPrefix(getResp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("expected 200 SSE stream, got %d %q", getResp.StatusCode, getResp.Header.Get("Content-Type"))
	}
	line, err := bufio.NewReader(getResp.Body).ReadString('\n')
	if err != nil || !strings.Contains(line, "connected") {
		t.Fatalf("expected SSE connected comment, got %q (err=%v)", line, err)
	}
	cancel()
	_ = getResp.Body.Close()

	// DELETE /mcp terminates session.
	delReq, _ := http.NewRequest(http.MethodDelete, srv.URL+"/mcp", nil)
	delReq.Header.Set(SessionHeader, sessID)
	delResp, err := http.DefaultClient.Do(delReq)
	if err != nil {
		t.Fatalf("DELETE /mcp failed: %v", err)
	}
	_ = delResp.Body.Close()
	if delResp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 on DELETE /mcp, got %d", delResp.StatusCode)
	}
}
