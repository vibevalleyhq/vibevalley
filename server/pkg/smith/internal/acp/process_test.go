package acp_test

// Ported from tests/acp/acp-process.test.ts.

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
)

func startRPC(t *testing.T, app *acp.ClientApp) *acp.Process {
	t.Helper()
	if app == nil {
		app = acp.NewClient()
	}
	process, err := acp.StartProcess(nodePath(t), []string{fixture, "rpc"}, app, acp.ProcessOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		process.Kill()
		<-process.Exited()
	})
	return process
}

func rpc(t *testing.T, process *acp.Process, method string, params any) json.RawMessage {
	t.Helper()
	result, err := process.Request(context.Background(), method, params, 500*time.Millisecond)
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	return result
}

func TestProcessHandlesRequestsNotificationsAndReverseRequests(t *testing.T) {
	var mu sync.Mutex
	var notifications []any
	app := acp.NewClient().
		OnRequest("fixture/reverse", acp.Handle(func(params json.RawMessage) (any, error) {
			return map[string]any{"method": "fixture/reverse", "answer": jsonx.ParseRecord(params)["question"]}, nil
		})).
		OnNotification("fixture/notification", func(params json.RawMessage, _ bool) {
			mu.Lock()
			notifications = append(notifications, map[string]any{"method": "fixture/notification", "params": params})
			mu.Unlock()
		})
	process := startRPC(t, app)
	jsonEqual(t, rpc(t, process, "test/echo", map[string]any{"value": 42}), map[string]any{"value": 42})
	rpc(t, process, "test/notify", map[string]any{})
	reverse := rpc(t, process, "test/reverse", map[string]any{})
	mu.Lock()
	defer mu.Unlock()
	jsonEqual(t, map[string]any{"notifications": notifications, "reverse": reverse}, json.RawMessage(`{
		"notifications": [{"method": "fixture/notification", "params": {"value": 42}}],
		"reverse": {"reverse": {"answer": "answer me", "method": "fixture/reverse"}}
	}`))
}

func TestProcessDeadlineCancelsOneRequestWithoutKillingTheProcess(t *testing.T) {
	process := startRPC(t, nil)
	_, err := process.Request(context.Background(), "test/timeout", map[string]any{}, 30*time.Millisecond)
	var acpErr *acp.Error
	if !errors.As(err, &acpErr) || acpErr.Kind != acp.KindTimeout || acpErr.Method != "test/timeout" || acpErr.Timeout != 30*time.Millisecond {
		t.Fatalf("want a timeout error, got %#v", err)
	}
	if acpErr.Message != "ACP request test/timeout timed out after 30ms" {
		t.Fatalf("message %q", acpErr.Message)
	}
	jsonEqual(t, rpc(t, process, "test/echo", map[string]any{"alive": true}), map[string]any{"alive": true})
}

func TestProcessExitRejectsInFlightWorkWithTheExitCode(t *testing.T) {
	process := startRPC(t, nil)
	_, err := process.Request(context.Background(), "test/exit", map[string]any{}, 0)
	var acpErr *acp.Error
	if !errors.As(err, &acpErr) || acpErr.Kind != acp.KindProcessExited || acpErr.ExitCode == nil || *acpErr.ExitCode != 7 {
		t.Fatalf("want a process-exited error with code 7, got %#v", err)
	}
	<-process.Exited()
	if code := process.ExitCode(); code == nil || *code != 7 {
		t.Fatalf("exit code %v", code)
	}
	if !process.Closed() {
		t.Fatal("the process should be closed")
	}
}

func TestProcessRecoversAfterAnInvalidFrame(t *testing.T) {
	process := startRPC(t, nil)
	jsonEqual(t, rpc(t, process, "test/invalid", map[string]any{}), map[string]any{"recovered": true})
	if process.Closed() {
		t.Fatal("the process should still be open")
	}
}
