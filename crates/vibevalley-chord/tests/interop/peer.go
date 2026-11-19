// Run against the reference checkout so both ends use their own production codec.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/chord/link"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/watch"
)

func run(url string) error {
	ctx, stop := context.WithTimeout(context.Background(), 15*time.Second)
	defer stop()
	tr, _, err := link.DialWebSocket(ctx, url)
	if err != nil {
		return err
	}
	peer := link.NewLink(tr, link.Options{Principal: link.Principal{Kind: link.PrincipalMachineNode, ID: "go-oracle"}})
	entered := make(chan struct{})
	peer.HandleRPC("go.entered", func(context.Context, json.RawMessage) (any, error) { close(entered); return nil, nil })
	peer.HandleRPC("go.echo", func(ctx context.Context, params json.RawMessage) (any, error) {
		principal, _ := link.PrincipalFromContext(ctx)
		return map[string]any{"peer": principal.ID, "data": params}, nil
	})
	published, err := watch.NewDocument(map[string]any{"go": "初始"})
	if err != nil {
		return err
	}
	peer.PublishDocument("go.doc", published)
	if err := peer.Start(ctx); err != nil {
		return err
	}
	defer peer.Close()

	big := strings.Repeat("abc农", 50_000)
	var echo string
	if err := peer.Call(ctx, "rust.echo", big, &echo); err != nil {
		return err
	}
	if echo != big {
		return fmt.Errorf("bad %d-byte echo", len(echo))
	}

	events := make(chan link.WatchEvent, 2)
	sub, err := peer.OpenWatch(ctx, "rust.doc", 0, nil, func(_ context.Context, ev link.WatchEvent) { events <- ev }, nil)
	if err != nil {
		return err
	}
	defer sub.Stop()
	select {
	case ev := <-events:
		value, ok := ev.Snapshot.Get("count")
		if !ok || value != int64(7) {
			return fmt.Errorf("bad root: %v", value)
		}
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := peer.Call(ctx, "rust.next", nil, nil); err != nil {
		return err
	}
	select {
	case ev := <-events:
		value, ok := ev.Snapshot.Get("count")
		if !ok || value != int64(8) || ev.Rev != 2 || len(ev.Ops) != 1 {
			return fmt.Errorf("bad delta: %#v", ev)
		}
	case <-ctx.Done():
		return ctx.Err()
	}
	waitCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- peer.Call(waitCtx, "rust.block", nil, nil) }()
	select {
	case <-entered:
	case <-ctx.Done():
		return ctx.Err()
	}
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		return fmt.Errorf("cancelling rust.block: %w", err)
	}
	return peer.Call(ctx, "rust.ready", nil, nil)
}

func main() {
	var err error
	if os.Args[1] == "serve" {
		err = serve()
	} else if os.Args[1] == "product" || os.Args[1] == "approval" {
		err = product(os.Args[1] == "approval")
	} else {
		err = run(os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
