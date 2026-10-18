package handler_test

import (
	"context"
	"database/sql"
	"errors"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"go.uber.org/fx"
	"vibevalley/internal/base"
	"vibevalley/internal/handler"
	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/internal/testkit/fixture"
)

func TestServerIsReachableBeforeReadyWork(t *testing.T) {
	cfg := fixture.Config(t.TempDir(), t.TempDir(), ":memory:")
	cfg.Port, cfg.Voice.Line.Port, cfg.Lan.Port = 0, 0, 0
	var sessions *session.Service
	seen := ""
	life, cancel := context.WithCancel(context.Background())
	defer cancel()
	running, err := handler.Listen(life, cfg, fx.Populate(&sessions), base.BeforeReady(func(ctx context.Context) error {
		seen = sessions.FarmURL()
		client := &http.Client{Timeout: 2 * time.Second}
		req, err := http.NewRequestWithContext(ctx, "POST", seen, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ready-test","version":"1"}}}`))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		response, err := client.Do(req)
		if err != nil {
			return err
		}
		response.Body.Close()
		if response.StatusCode != 200 {
			return errors.New(response.Status)
		}
		return nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); _ = running.Wait() }()
	if seen != "http://"+running.Address()+"/mcp" {
		t.Fatalf("ready used %s; actual %s", seen, running.Address())
	}
	c := protocol.Client{Base: "http://" + running.Address()}
	health, err := c.ServerHealth(context.Background())
	if err != nil || !health.Ok {
		t.Fatalf("health: %+v %v", health, err)
	}
	cancel()
	if err := running.Wait(); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", running.Address())
	if err != nil {
		t.Fatalf("listener leaked: %v", err)
	}
	listener.Close()
}
func TestFailedReadyReleasesTransportAndFarm(t *testing.T) {
	reserved, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := reserved.Addr().String()
	cfg := fixture.Config(t.TempDir(), t.TempDir(), ":memory:")
	cfg.Port = reserved.Addr().(*net.TCPAddr).Port
	cfg.Voice.Line.Port, cfg.Lan.Port = 0, 0
	reserved.Close()
	failed := errors.New("cannot prepare")
	var db *sql.DB
	if _, err := handler.Listen(context.Background(), cfg, fx.Populate(&db), base.BeforeReady(func(context.Context) error { return failed })); !errors.Is(err, failed) {
		t.Fatal(err)
	}
	if db == nil || db.Ping() == nil {
		t.Fatal("failed startup kept database open")
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatalf("failed startup kept port: %v", err)
	}
	listener.Close()
}
