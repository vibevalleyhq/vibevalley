package main

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/delta"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/link"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/watch"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func TestChordBridgeMyGoBindingAndTypeScriptGeneration(t *testing.T) {
	bridge := NewChordBridge(nil)
	defer bridge.Close()

	if err := RegisterChordBridge(bridge); err != nil {
		t.Fatalf("RegisterChordBridge: %v", err)
	}
	// Second registration is idempotent.
	if err := RegisterChordBridge(bridge); err != nil {
		t.Fatalf("second RegisterChordBridge: %v", err)
	}

	ts, err := mygo.GenerateTypeScript()
	if err != nil {
		t.Fatalf("mygo.GenerateTypeScript: %v", err)
	}
	src := string(ts)
	for _, want := range []string{"ChordLink", "sendFrame", "streamFrames", "chord:frame"} {
		if !strings.Contains(src, want) {
			t.Fatalf("generated TypeScript missing %q:\n%s", want, src)
		}
	}
}

func TestInProcessChordLinkRPCAndWatchStreamingParity(t *testing.T) {
	t.Parallel()

	var outboundEvents [][]byte
	var mu sync.Mutex

	transport := NewBridgeTransport(BridgeTransportOptions{
		OnSend: func(pkt []byte) {
			mu.Lock()
			outboundEvents = append(outboundEvents, pkt)
			mu.Unlock()
		},
	})
	bridge := NewChordBridge(transport)
	defer bridge.Close()

	if got := bridge.Ping(context.Background()); got != "pong" {
		t.Fatalf("bridge.Ping = %q, want pong", got)
	}

	doc, err := watch.NewDocument(contract.SpaceView{
		Rev: 1,
		Issues: []contract.IssueView{
			{ID: "iss-1", Title: "Initial Issue", Status: contract.IssueQueued, RepoID: "r1"},
		},
	})
	if err != nil {
		t.Fatalf("NewDocument: %v", err)
	}

	srvLink := link.NewLink(bridge.ServerTransport(), link.Options{
		Principal: link.Principal{
			Kind:         link.PrincipalMachineNode,
			ID:           "desktop-server",
			Capabilities: []string{"space:read", "space:write"},
		},
		SidePrefix: "srv",
	})
	srvLink.HandleRPC("echoLarge", func(ctx context.Context, params json.RawMessage) (any, error) {
		var req struct {
			Payload string `json:"payload"`
		}
		if err := json.Unmarshal(params, &req); err != nil {
			return nil, err
		}
		return map[string]any{"len": len(req.Payload), "head": req.Payload[:8]}, nil
	})
	srvLink.PublishDocument("space", doc)

	clientLink := link.NewLink(bridge.ClientTransport(), link.Options{
		Principal: link.Principal{
			Kind:         link.PrincipalUserDevice,
			ID:           "webview-client",
			Capabilities: []string{"space:read"},
		},
		SidePrefix: "cli",
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	startErr := make(chan error, 2)
	go func() { startErr <- srvLink.Start(ctx) }()
	go func() { startErr <- clientLink.Start(ctx) }()
	for range 2 {
		if err := <-startErr; err != nil {
			t.Fatalf("link Start: %v", err)
		}
	}
	defer func() {
		_ = clientLink.Close()
		_ = srvLink.Close()
		clientLink.Wait()
		srvLink.Wait()
	}()

	if peer := srvLink.PeerPrincipal(); peer.ID != "webview-client" || peer.Kind != link.PrincipalUserDevice {
		t.Fatalf("unexpected server peer principal: %+v", peer)
	}

	// Verify >64KB chunked RPC over in-process bridge channels.
	large := strings.Repeat("vibe-chunk-", 8000) // ~88KB > 64KB MaxFrameBytes
	var echoRes struct {
		Len  int    `json:"len"`
		Head string `json:"head"`
	}
	if err := clientLink.Call(ctx, "echoLarge", map[string]string{"payload": large}, &echoRes); err != nil {
		t.Fatalf("chunked echoLarge RPC failed: %v", err)
	}
	if echoRes.Len != len(large) || echoRes.Head != "vibe-chu" {
		t.Fatalf("unexpected echoLarge response: %+v", echoRes)
	}

	// Verify Watch streaming over BridgeTransport receives initial snapshot and incremental updates.
	events := make(chan link.WatchEvent, 8)
	sub, err := clientLink.OpenWatch(ctx, "space", 0, nil, func(_ context.Context, ev link.WatchEvent) {
		events <- ev
	}, nil)
	if err != nil {
		t.Fatalf("OpenWatch: %v", err)
	}
	defer sub.Stop()

	select {
	case ev := <-events:
		if ev.Snapshot == nil || ev.Rev < 1 {
			t.Fatalf("unexpected initial watch event: %+v", ev)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for initial watch snapshot")
	}

	nextRev, err := doc.Mutate(func(d *delta.Draft) error {
		return d.Set([]string{"issues"}, []any{
			map[string]any{
				"id":          "iss-1",
				"title":       "Updated In-Flight",
				"status":      "in_progress",
				"repoId":      "r1",
				"updatedAtMs": int64(42),
			},
		})
	})
	if err != nil {
		t.Fatalf("doc.Mutate: %v", err)
	}

	deadline := time.After(3 * time.Second)
	for {
		select {
		case ev := <-events:
			if ev.Rev == nextRev {
				raw, _ := json.Marshal(ev.Snapshot.Value())
				if !strings.Contains(string(raw), "Updated In-Flight") {
					t.Fatalf("watch snapshot missing updated issue: %s", raw)
				}
				goto watched
			}
		case <-deadline:
			t.Fatalf("timed out waiting for watch rev %d", nextRev)
		}
	}

watched:
	mu.Lock()
	sentCount := len(outboundEvents)
	mu.Unlock()
	if sentCount == 0 {
		t.Fatal("expected OnSend hook to observe outbound Chord Link frames")
	}
}

func TestInProcessChordClientReconnectAndFromRevCatchup(t *testing.T) {
	t.Parallel()

	doc, err := watch.NewDocument(contract.SpaceView{
		Rev: 1,
		Issues: []contract.IssueView{
			{ID: "iss-1", Title: "First", Status: contract.IssueQueued, RepoID: "r1"},
		},
	})
	if err != nil {
		t.Fatalf("NewDocument: %v", err)
	}

	var mu sync.Mutex
	var connCount int
	var bridges []*ChordBridge
	var srvLinks []*link.Link

	dial := func(ctx context.Context) (link.FrameTransport, error) {
		mu.Lock()
		connCount++
		idx := connCount
		mu.Unlock()

		b := NewChordBridge(nil)
		srv := link.NewLink(b.ServerTransport(), link.Options{
			Principal:  link.Principal{Kind: link.PrincipalMachineNode, ID: "desktop-srv"},
			SidePrefix: "srv",
		})
		srv.HandleRPC("connIndex", func(_ context.Context, _ json.RawMessage) (any, error) {
			return map[string]int{"conn": idx}, nil
		})
		srv.PublishDocument("space", doc)
		go func() {
			if err := srv.Start(ctx); err != nil {
				_ = b.Close()
			}
		}()

		mu.Lock()
		bridges = append(bridges, b)
		srvLinks = append(srvLinks, srv)
		mu.Unlock()
		return b.ClientTransport(), nil
	}

	t.Cleanup(func() {
		mu.Lock()
		srvs := append([]*link.Link(nil), srvLinks...)
		bs := append([]*ChordBridge(nil), bridges...)
		mu.Unlock()
		for _, srv := range srvs {
			_ = srv.Close()
		}
		for _, b := range bs {
			_ = b.Close()
		}
		for _, srv := range srvs {
			srv.Wait()
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	client := link.NewClient(dial, link.ClientOptions{
		LinkOptions: link.Options{
			Principal:  link.Principal{Kind: link.PrincipalUserDevice, ID: "webview-1"},
			SidePrefix: "cli",
		},
		ReconnectMinDelay: 10 * time.Millisecond,
		ReconnectMaxDelay: 30 * time.Millisecond,
	})
	if err := client.Connect(ctx); err != nil {
		t.Fatalf("client.Connect: %v", err)
	}
	defer client.Close()

	revs := make(chan int64, 16)
	cw, err := client.Watch(ctx, "space", func(_ context.Context, ev link.WatchEvent) {
		revs <- ev.Rev
	})
	if err != nil {
		t.Fatalf("client.Watch: %v", err)
	}
	defer cw.Stop()

	waitRev := func(want int64) {
		t.Helper()
		deadline := time.After(3 * time.Second)
		for {
			select {
			case got := <-revs:
				if got >= want {
					return
				}
			case <-deadline:
				t.Fatalf("timed out waiting for rev >= %d", want)
			}
		}
	}

	waitRev(1)

	// Force disconnect of first in-process bridge and commit rev 2 while disconnected.
	mu.Lock()
	firstSrv := srvLinks[0]
	mu.Unlock()
	_ = firstSrv.Close()

	rev2, err := doc.Mutate(func(d *delta.Draft) error {
		return d.Set([]string{"issues"}, []any{
			map[string]any{"id": "iss-1", "title": "Second", "status": "in_progress", "repoId": "r1", "updatedAtMs": int64(2)},
		})
	})
	if err != nil {
		t.Fatalf("doc.Mutate: %v", err)
	}

	// ClientWatch automatically reconnects via BridgeTransport carrying fromRev and catches up to rev2.
	waitRev(rev2)

	var connRes struct {
		Conn int `json:"conn"`
	}
	if err := client.Call(ctx, "connIndex", nil, &connRes); err != nil {
		t.Fatalf("client.Call after reconnect: %v", err)
	}
	if connRes.Conn < 2 {
		t.Fatalf("expected reconnect connIndex >= 2, got %d", connRes.Conn)
	}
}
