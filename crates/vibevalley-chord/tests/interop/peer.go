// Run against the reference checkout so both ends use their own production codec.
package main

import (
	"context"
	"encoding/json"
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
	return peer.Call(ctx, "rust.ready", nil, nil)
}

func main() {
	if err := run(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
