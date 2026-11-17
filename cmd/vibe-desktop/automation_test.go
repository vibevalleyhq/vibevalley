package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"image/png"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func TestAutomationEndpointInspectClickCaptureAndUnixSocket(t *testing.T) {
	approvedCh := make(chan string, 2)
	raisedCh := make(chan int64, 2)

	island := NewIslandController(IslandOptions{
		BudgetStepMicros: 5_000_000,
		Handlers: IslandHandlers{
			OnApproval: func(prompt contract.ApprovalPromptView, approved bool) {
				if approved {
					approvedCh <- prompt.TaskID
				}
			},
			OnBudgetRaise: func(_ BudgetAlert, newMaxCostMicros int64) {
				raisedCh <- newMaxCostMicros
			},
		},
	})
	island.SetApprovals([]contract.ApprovalPromptView{
		{
			TaskID:    "task-auto-1",
			SessionID: "sess-1",
			ToolName:  "write_file",
			Policy:    contract.PolicyAlwaysAsk,
			Summary:   "Update config.yaml",
		},
	})
	island.SetBudget(BudgetAlert{
		ID:     "conv-auto",
		TaskID: "task-auto-1",
		Title:  "Auto Session",
		Snapshot: contract.BudgetSnapshot{
			SpentMicros:   2_000_000,
			MaxCostMicros: 2_000_000,
			Reached:       true,
		},
	})

	terms := NewTerminalController(ExecTerminalFactory{})
	defer terms.CloseAll()

	auto := NewAutomationEndpoint(island, terms, WebViewConfig{Scheme: "vibe", Host: "localhost"})
	srv := httptest.NewServer(auto.Handler())
	defer srv.Close()

	// 1. HTTP /inspect
	resp, err := http.Get(srv.URL + "/inspect")
	if err != nil {
		t.Fatalf("GET /inspect: %v", err)
	}
	var snap InspectSnapshot
	if err := json.NewDecoder(resp.Body).Decode(&snap); err != nil {
		resp.Body.Close()
		t.Fatalf("decode inspect: %v", err)
	}
	resp.Body.Close()

	if snap.FramePending {
		t.Fatal("expected FramePending=false")
	}
	if snap.WebURL != "vibe://localhost/" || len(snap.Nodes) == 0 {
		t.Fatalf("unexpected inspect snapshot: webUrl=%q nodes=%d", snap.WebURL, len(snap.Nodes))
	}

	// 2. HTTP /click -> dispatches Approve callback through real ui.Tester rendering
	clickBody, _ := json.Marshal(map[string]string{"target": "approve:task-auto-1"})
	cResp, err := http.Post(srv.URL+"/click", "application/json", bytes.NewReader(clickBody))
	if err != nil {
		t.Fatalf("POST /click: %v", err)
	}
	var cRes ClickResult
	if err := json.NewDecoder(cResp.Body).Decode(&cRes); err != nil {
		cResp.Body.Close()
		t.Fatalf("decode click result: %v", err)
	}
	cResp.Body.Close()

	if cResp.StatusCode != http.StatusOK || cRes.DurationMs >= 20 {
		t.Fatalf("click status=%d durationMs=%v", cResp.StatusCode, cRes.DurationMs)
	}
	select {
	case taskID := <-approvedCh:
		if taskID != "task-auto-1" {
			t.Fatalf("approved taskID=%q, want task-auto-1", taskID)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for OnApproval from HTTP /click")
	}

	// 3. HTTP /capture.png
	pngResp, err := http.Get(srv.URL + "/capture.png")
	if err != nil {
		t.Fatalf("GET /capture.png: %v", err)
	}
	img, err := png.Decode(pngResp.Body)
	pngResp.Body.Close()
	if err != nil || img.Bounds().Empty() {
		t.Fatalf("invalid PNG capture: err=%v bounds=%v", err, img.Bounds())
	}

	// 4. Unix domain socket NDJSON automation protocol (`tree`, `act`, `idle`).
	sockDir, err := os.MkdirTemp("", "vv-auto-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(sockDir) })
	sockPath := filepath.Join(sockDir, "auto.sock")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ln, done, err := auto.ListenUnix(ctx, sockPath)
	if err != nil {
		t.Fatalf("ListenUnix: %v", err)
	}
	defer func() {
		cancel()
		_ = ln.Close()
		<-done
	}()

	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial unix %s: %v", sockPath, err)
	}
	defer conn.Close()
	r := bufio.NewReader(conn)

	sendRPC := func(id int, method string, params any) autoRPCResp {
		reqBytes, _ := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
		if _, err := conn.Write(append(reqBytes, '\n')); err != nil {
			t.Fatalf("write rpc: %v", err)
		}
		line, err := r.ReadBytes('\n')
		if err != nil {
			t.Fatalf("read rpc: %v", err)
		}
		var out autoRPCResp
		if err := json.Unmarshal(line, &out); err != nil {
			t.Fatalf("decode rpc %q: %v", line, err)
		}
		if out.Error != nil {
			t.Fatalf("rpc %s error: %+v", method, out.Error)
		}
		return out
	}

	sendRPC(1, "tree", nil)
	sendRPC(2, "act", map[string]string{"target": "Raise Budget"})
	select {
	case nextMax := <-raisedCh:
		if nextMax != 7_000_000 {
			t.Fatalf("raised budget=%d, want 7000000", nextMax)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for OnBudgetRaise from Unix socket act")
	}
	sendRPC(3, "idle", nil)
}
