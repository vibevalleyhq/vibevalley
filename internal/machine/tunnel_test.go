package machine

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func TestTunnelHandlerIntranetMCPAndSSRFGuards(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	var seenMethod, seenPath, seenSession, seenAuth, seenBody string
	intranetMCP := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/mcp/redirect" {
			http.Redirect(w, r, "http://169.254.169.254/latest/meta-data/", http.StatusFound)
			return
		}
		seenMethod = r.Method
		seenPath = r.URL.Path
		seenSession = r.Header.Get("Mcp-Session-Id")
		seenAuth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		seenBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Mcp-Session-Id", "mcp-sess-99")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}`))
	}))
	defer intranetMCP.Close()

	parsedURL, err := url.Parse(intranetMCP.URL)
	if err != nil {
		t.Fatalf("parse server URL: %v", err)
	}

	now := time.Unix(1_700_000_000, 0)
	node, err := NewNode(NodeConfig{
		MachineID: "m-intranet",
		WorkRoot:  t.TempDir(),
		MCPTargets: []MCPTarget{
			{
				ID:          "private-mcp",
				Endpoint:    intranetMCP.URL + "/mcp",
				AllowedPath: "/mcp",
				Headers:     map[string]string{"Authorization": "Bearer intranet-only"},
			},
		},
		Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewNode: %v", err)
	}
	defer node.Close()

	// Public Target metadata must never expose local Headers.
	targets := node.Tunnel().Targets()
	if len(targets) != 1 || len(targets[0].Headers) != 0 {
		t.Fatalf("target metadata leaked headers or missing target: %+v", targets)
	}

	machineSide, serverSide := PipeLinkPair()
	defer serverSide.Close()

	serveDone := make(chan error, 1)
	serveCtx, cancelServe := context.WithCancel(ctx)
	defer cancelServe()
	go func() {
		serveDone <- node.ServeLink(serveCtx, machineSide)
	}()

	reqPayload, _ := json.Marshal(TunnelHTTPRequest{
		RequestID: "r1",
		TargetID:  "private-mcp",
		Method:    http.MethodPost,
		Path:      "/tools/list",
		Headers:   map[string]string{"Mcp-Session-Id": "client-1", "Content-Type": "application/json"},
		Body:      []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`),
		Principal: &contract.Principal{
			Kind:         contract.PrincipalSessionToken,
			ID:           "tok-1",
			AllowedHosts: []string{parsedURL.Host},
			ExpiresAtMs:  now.Add(5 * time.Minute).UnixMilli(),
		},
	})
	if err := serverSide.WriteFrame(ctx, LinkFrame{ID: "f1", Kind: "mcp_http_req", Payload: reqPayload}); err != nil {
		t.Fatalf("WriteFrame mcp_http_req: %v", err)
	}
	reply, err := serverSide.ReadFrame(ctx)
	if err != nil {
		t.Fatalf("ReadFrame mcp_http_res: %v", err)
	}
	var mcpRes TunnelHTTPResponse
	if err := json.Unmarshal(reply.Payload, &mcpRes); err != nil {
		t.Fatalf("unmarshal mcp_http_res: %v", err)
	}
	if mcpRes.StatusCode != http.StatusOK || mcpRes.Error != "" {
		t.Fatalf("unexpected MCP response: %+v", mcpRes)
	}
	if seenMethod != http.MethodPost || seenPath != "/mcp/tools/list" || seenSession != "client-1" || seenAuth != "Bearer intranet-only" {
		t.Fatalf("unexpected forwarded request: method=%s path=%s sess=%s auth=%s", seenMethod, seenPath, seenSession, seenAuth)
	}
	if seenBody != `{"jsonrpc":"2.0","id":1,"method":"tools/list"}` {
		t.Fatalf("unexpected forwarded body: %s", seenBody)
	}
	if mcpRes.Headers["Mcp-Session-Id"] != "mcp-sess-99" {
		t.Fatalf("missing response header Mcp-Session-Id: %+v", mcpRes.Headers)
	}

	redirRes := node.Tunnel().HandleMCPRequest(ctx, TunnelHTTPRequest{
		RequestID: "r-redir",
		TargetID:  "private-mcp",
		Method:    http.MethodGet,
		Path:      "/redirect",
	})
	if redirRes.StatusCode != http.StatusFound {
		t.Fatalf("expected 302 without following redirect, got status=%d err=%q", redirRes.StatusCode, redirRes.Error)
	}

	acqPayload, _ := json.Marshal(LeaseRequest{SessionID: "sess-rpc"})
	if err := serverSide.WriteFrame(ctx, LinkFrame{ID: "l1", Kind: "env_lease_acquire_req", Payload: acqPayload}); err != nil {
		t.Fatalf("acquire write: %v", err)
	}
	acqFrame, err := serverSide.ReadFrame(ctx)
	if err != nil {
		t.Fatalf("acquire read: %v", err)
	}
	var rpcLease Lease
	if err := json.Unmarshal(acqFrame.Payload, &rpcLease); err != nil || rpcLease.ID == "" {
		t.Fatalf("invalid rpc lease: %s err=%v", acqFrame.Payload, err)
	}

	writePayload, _ := json.Marshal(envWritePayload{LeaseID: rpcLease.ID, RelPath: ".vibe/outputs/out.txt", Data: []byte("hello"), Perm: 0o644})
	if err := serverSide.WriteFrame(ctx, LinkFrame{ID: "w1", Kind: "env_write_req", Payload: writePayload}); err != nil {
		t.Fatalf("write req: %v", err)
	}
	if f, err := serverSide.ReadFrame(ctx); err != nil || f.Kind != "env_write_res" {
		t.Fatalf("write res: %+v err=%v", f, err)
	}

	editPayload, _ := json.Marshal(envEditPayload{LeaseID: rpcLease.ID, RelPath: ".vibe/outputs/out.txt", OldText: "hello", NewText: "hello-world"})
	if err := serverSide.WriteFrame(ctx, LinkFrame{ID: "e1", Kind: "env_edit_req", Payload: editPayload}); err != nil {
		t.Fatalf("edit req: %v", err)
	}
	if f, err := serverSide.ReadFrame(ctx); err != nil || f.Kind != "env_edit_res" {
		t.Fatalf("edit res: %+v err=%v", f, err)
	}

	readPayload, _ := json.Marshal(envReadPayload{LeaseID: rpcLease.ID, RelPath: ".vibe/outputs/out.txt"})
	if err := serverSide.WriteFrame(ctx, LinkFrame{ID: "rd1", Kind: "env_read_req", Payload: readPayload}); err != nil {
		t.Fatalf("read req: %v", err)
	}
	rdFrame, err := serverSide.ReadFrame(ctx)
	if err != nil {
		t.Fatalf("read res: %v", err)
	}
	var rdRes struct {
		Data []byte `json:"data"`
	}
	if err := json.Unmarshal(rdFrame.Payload, &rdRes); err != nil || string(rdRes.Data) != "hello-world" {
		t.Fatalf("unexpected env_read_res: %s err=%v", rdFrame.Payload, err)
	}

	harvestPayload, _ := json.Marshal(envLeasePayload{LeaseID: rpcLease.ID})
	if err := serverSide.WriteFrame(ctx, LinkFrame{ID: "h1", Kind: "env_harvest_req", Payload: harvestPayload}); err != nil {
		t.Fatalf("harvest req: %v", err)
	}
	hFrame, err := serverSide.ReadFrame(ctx)
	if err != nil {
		t.Fatalf("harvest res: %v", err)
	}
	var harvested []contract.HarvestedOutput
	if err := json.Unmarshal(hFrame.Payload, &harvested); err != nil || len(harvested) != 1 || harvested[0].RelPath != "out.txt" {
		t.Fatalf("unexpected env_harvest_res: %s err=%v", hFrame.Payload, err)
	}

	cases := []struct {
		name       string
		req        TunnelHTTPRequest
		wantStatus int
	}{
		{
			name:       "unregistered target",
			req:        TunnelHTTPRequest{TargetID: "metadata-service", Method: "GET"},
			wantStatus: http.StatusForbidden,
		},
		{
			name: "disallowed host in principal",
			req: TunnelHTTPRequest{
				TargetID:  "private-mcp",
				Method:    "POST",
				Principal: &contract.Principal{AllowedHosts: []string{"other.internal"}},
			},
			wantStatus: http.StatusForbidden,
		},
		{
			name: "expired principal",
			req: TunnelHTTPRequest{
				TargetID:  "private-mcp",
				Method:    "POST",
				Principal: &contract.Principal{ExpiresAtMs: now.Add(-time.Second).UnixMilli()},
			},
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "path traversal escape",
			req:        TunnelHTTPRequest{TargetID: "private-mcp", Method: "GET", Path: "/../admin"},
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "host override in path",
			req:        TunnelHTTPRequest{TargetID: "private-mcp", Method: "GET", Path: "http://evil.internal/mcp"},
			wantStatus: http.StatusForbidden,
		},
	}
	for _, tc := range cases {
		res := node.Tunnel().HandleMCPRequest(ctx, tc.req)
		if res.StatusCode != tc.wantStatus || res.Error == "" {
			t.Errorf("%s: got status=%d err=%q, want status=%d", tc.name, res.StatusCode, res.Error, tc.wantStatus)
		}
	}

	cancelServe()
	<-serveDone
}

func TestLinkDisconnectKillsThreeLevelSubprocessTreeWithin4s(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	node, err := NewNode(NodeConfig{
		MachineID: "m-disconnect-kill",
		WorkRoot:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("NewNode: %v", err)
	}
	defer node.Close()

	machineSide, serverSide := PipeLinkPair()
	serveDone := make(chan error, 1)
	go func() {
		serveDone <- node.ServeLink(ctx, machineSide)
	}()

	// Acquire lease over the link.
	leaseReq, _ := json.Marshal(LeaseRequest{SessionID: "sess-link-kill"})
	if err := serverSide.WriteFrame(ctx, LinkFrame{ID: "acq", Kind: "env_lease_acquire_req", Payload: leaseReq}); err != nil {
		t.Fatalf("WriteFrame acquire: %v", err)
	}
	acqReply, err := serverSide.ReadFrame(ctx)
	if err != nil {
		t.Fatalf("ReadFrame acquire: %v", err)
	}
	var lease Lease
	if err := json.Unmarshal(acqReply.Payload, &lease); err != nil || lease.ID == "" {
		t.Fatalf("invalid lease reply: %s err=%v", string(acqReply.Payload), err)
	}

	pidFile := filepath.Join(lease.WorkDir, "pids.txt")
	script := `
		echo $$ > pids.txt
		sh -c '
			trap "" TERM
			echo $$ >> pids.txt
			sh -c "
				trap \"\" TERM
				echo \$\$ >> pids.txt
				sleep 60
			" &
			wait
		' &
		wait
	`
	execPayload, _ := json.Marshal(envExecPayload{
		LeaseID: lease.ID,
		Spec:    contract.ExecSpec{Argv: []string{"/bin/sh", "-c", script}},
	})
	if err := serverSide.WriteFrame(ctx, LinkFrame{ID: "exec1", Kind: "env_exec_req", Payload: execPayload}); err != nil {
		t.Fatalf("WriteFrame exec: %v", err)
	}

	pids := waitForThreePIDs(t, pidFile, 3*time.Second)

	// Force link disconnect without cancelling caller context.
	disconnectAt := time.Now()
	_ = serverSide.Close()

	select {
	case serveErr := <-serveDone:
		elapsed := time.Since(disconnectAt)
		if elapsed >= 4*time.Second {
			t.Fatalf("link disconnect took too long to tear down subprocess tree: %s", elapsed)
		}
		if !errors.Is(serveErr, ErrLinkDisconnected) {
			t.Fatalf("expected ErrLinkDisconnected, got %v", serveErr)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("ServeLink did not exit within 4s after link disconnect")
	}

	assertAllPIDsDead(t, pids, 500*time.Millisecond)
}
