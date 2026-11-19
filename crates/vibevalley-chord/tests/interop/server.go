package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/chord/delta"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/link"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/watch"
)

type heartbeatObserver struct {
	link.FrameTransport
	ping, pong chan struct{}
}

func (h *heartbeatObserver) Recv(ctx context.Context) ([]byte, error) {
	data, err := h.FrameTransport.Recv(ctx)
	var frame struct{ Kind string }
	if err == nil && json.Unmarshal(data, &frame) == nil {
		switch frame.Kind {
		case "ping":
			select {
			case h.ping <- struct{}{}:
			default:
			}
		case "pong":
			select {
			case h.pong <- struct{}{}:
			default:
			}
		}
	}
	return data, err
}

func serve() error {
	doc, err := watch.NewDocument(map[string]int64{"count": 0}, watch.WithHistorySize[map[string]int64](2), watch.WithMaxPendingOpsPerWatch[map[string]int64](2))
	if err != nil {
		return err
	}
	advance := func(n int) (int64, error) {
		var rev int64
		var err error
		for range n {
			_, value, _ := doc.State()
			rev, err = doc.Mutate(func(d *delta.Draft) error { return d.Set([]string{"count"}, value["count"]+1) })
			if err != nil {
				return 0, err
			}
		}
		return rev, nil
	}
	var lifetime sync.Mutex
	accepted := func(tr *link.WebSocketTransport, r *http.Request) {
		// Commit the disconnected edits before the next peer can open its watch.
		lifetime.Lock()
		defer lifetime.Unlock()
		heartbeats := &heartbeatObserver{FrameTransport: tr, ping: make(chan struct{}, 1), pong: make(chan struct{}, 1)}
		peer := link.NewLink(heartbeats, link.Options{HeartbeatInterval: 20 * time.Millisecond, HeartbeatTimeout: 5 * time.Second, Principal: link.Principal{Kind: link.PrincipalMachineNode, ID: "go-reference"}, Authenticate: func(_ context.Context, p link.Principal) error {
			if p.Kind == link.PrincipalUserDevice && p.ID == "rust-client" {
				return nil
			}
			return fmt.Errorf("unexpected principal %s", p.ID)
		}})
		peer.HandleRPC("go.heartbeat", func(ctx context.Context, _ json.RawMessage) (any, error) {
			for _, frame := range []chan struct{}{heartbeats.ping, heartbeats.pong} {
				select {
				case <-frame:
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			return true, nil
		})
		peer.PublishDocument("go.doc", doc)
		peer.HandleRPC("go.reverse", func(ctx context.Context, input json.RawMessage) (any, error) {
			var reply json.RawMessage
			err := peer.Call(ctx, "rust.callback", input, &reply)
			return reply, err
		})
		cancelled := make(chan struct{})
		peer.HandleRPC("go.block", func(ctx context.Context, input json.RawMessage) (any, error) {
			if err := peer.Call(ctx, "rust.entered", nil, nil); err != nil && ctx.Err() == nil {
				return nil, err
			}
			<-ctx.Done()
			close(cancelled)
			return nil, ctx.Err()
		})
		peer.HandleRPC("go.cancelled", func(ctx context.Context, _ json.RawMessage) (any, error) {
			select {
			case <-cancelled:
				return true, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		})
		peer.HandleRPC("go.advance", func(_ context.Context, input json.RawMessage) (any, error) {
			var steps int
			if err := json.Unmarshal(input, &steps); err != nil {
				return nil, err
			}
			return advance(steps)
		})
		var pending atomic.Int32
		peer.HandleRPC("go.advanceOnDisconnect", func(_ context.Context, input json.RawMessage) (any, error) {
			var steps int32
			if err := json.Unmarshal(input, &steps); err != nil {
				return nil, err
			}
			pending.Store(steps)
			return true, nil
		})
		peer.HandleRPC("go.overflow", func(context.Context, json.RawMessage) (any, error) {
			return doc.Mutate(func(d *delta.Draft) error {
				for _, key := range []string{"a", "b", "c"} {
					if err := d.Set([]string{key}, int64(1)); err != nil {
						return err
					}
				}
				return nil
			})
		})
		peer.HandleRPC("go.retire", func(context.Context, json.RawMessage) (any, error) { return doc.Retire(), nil })
		peer.HandleRPC("go.rebuild", func(context.Context, json.RawMessage) (any, error) { return doc.Rebuild(map[string]int64{"count": 0}) })
		if err := peer.Start(r.Context()); err != nil {
			_ = peer.Close()
			return
		}
		<-peer.Done()
		if _, err := advance(int(pending.Load())); err != nil {
			panic(err)
		}
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	fmt.Printf("ws://%s/chord/ws\n", listener.Addr())
	mux := http.NewServeMux()
	mux.HandleFunc("/chord/ws", link.WebSocketHandler(accepted))
	return http.Serve(listener, mux)
}
