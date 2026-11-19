package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/chord/link"
)

// The acceptance sandbox supplies both values and removes its work directory on exit.
func product(approval bool) error {
	address := os.Getenv("VIBEVALLEY_SERVER")
	cli := os.Getenv("VIBEVALLEY_VERIFY_CLI")
	u, err := url.Parse(address)
	if err != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") || (!approval && cli == "") {
		return fmt.Errorf("run inside the verify-server sandbox")
	}
	u.Scheme = "ws"
	u.Path = "/chord/ws"
	ctx, stop := context.WithTimeout(context.Background(), 15*time.Second)
	defer stop()
	dial := func(kind link.PrincipalKind) (*link.Link, error) {
		tr, _, err := link.DialWebSocket(ctx, u.String())
		if err != nil {
			return nil, err
		}
		peer := link.NewLink(tr, link.Options{Principal: link.Principal{Kind: kind, ID: "acceptance"}})
		if err := peer.Start(ctx); err != nil {
			_ = peer.Close()
			return nil, err
		}
		return peer, nil
	}
	if denied, err := dial(link.PrincipalMachineNode); err == nil {
		_ = denied.Close()
		return fmt.Errorf("unexpected machine principal accepted by the workbench")
	}
	peer, err := dial(link.PrincipalUserDevice)
	if err != nil {
		return err
	}
	defer peer.Close()
	var health struct {
		Ok        bool
		ServerURL string
	}
	if err := peer.Call(ctx, "health.ping", nil, &health); err != nil {
		return err
	}
	if !health.Ok || health.ServerURL != address || peer.PeerPrincipal().ID != "vibe-server" {
		return fmt.Errorf("unexpected health or identity: %+v", health)
	}
	changes := make(chan link.WatchEvent, 8)
	watch, err := peer.OpenWatch(ctx, "space", 0, nil, func(c context.Context, e link.WatchEvent) {
		select {
		case changes <- e:
		case <-c.Done():
		}
	}, nil)
	if err != nil {
		return err
	}
	defer watch.Stop()
	if approval {
		return approve(ctx, peer, changes)
	}
	var initial int64
	select {
	case e := <-changes:
		initial = e.Rev
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := channelHistory(ctx, peer, cli); err != nil {
		return err
	}
	const title = "Chord interoperability smoke"
	if out, err := exec.CommandContext(ctx, cli, "issue", "create", title, "--format", "json").CombinedOutput(); err != nil {
		return fmt.Errorf("create issue: %w: %s", err, out)
	}
	for {
		select {
		case e := <-changes:
			if e.Rev <= initial || len(e.Ops) == 0 {
				continue
			}
			issues, ok := e.Snapshot.Get("issues")
			if !ok {
				return fmt.Errorf("space snapshot has no issues")
			}
			bytes, err := json.Marshal(issues)
			if err != nil {
				return err
			}
			type issue struct{ ID, Title, Status string }
			var rows []issue
			if err = json.Unmarshal(bytes, &rows); err != nil {
				return err
			}
			var hit issue
			for _, r := range rows {
				if r.Title == title {
					hit = r
					break
				}
			}
			if hit.ID == "" {
				continue
			}
			var filtered []issue
			if err := peer.Call(ctx, "issue.list", map[string]any{"statuses": []string{hit.Status}}, &filtered); err != nil {
				return err
			}
			var snapshot struct {
				Rev  int64
				View struct{ Issues []issue }
			}
			if err := peer.Call(ctx, "space.snapshot", nil, &snapshot); err != nil {
				return err
			}
			includes := func(all []issue) bool {
				for _, r := range all {
					if r == hit {
						return true
					}
				}
				return false
			}
			if !includes(filtered) || !includes(snapshot.View.Issues) || snapshot.Rev < e.Rev {
				return fmt.Errorf("RPC snapshot and issue filter disagree with watch")
			}
			fmt.Printf("Go client -> Rust /chord/ws: machine denied, user authenticated, health.ping, space.watch rev %d -> %d, issue.list and space.snapshot matched issue %s\n", initial, e.Rev, hit.ID)
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func approve(ctx context.Context, peer *link.Link, changes <-chan link.WatchEvent) error {
	var requested int64
	var target string
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case e := <-changes:
			data, err := json.Marshal(e.Snapshot.Value())
			if err != nil {
				return err
			}
			var view struct {
				Approvals []struct{ TaskID, SessionID, ToolName string }
				Issues    []struct{ ID, Title string }
			}
			if err := json.Unmarshal(data, &view); err != nil {
				return err
			}
			if target == "" {
				for _, card := range view.Approvals {
					if card.ToolName != "issue_create" {
						continue
					}
					target = card.TaskID
					if target == "" || card.SessionID == "" {
						return fmt.Errorf("approval lacks task/conversation")
					}
					var ack struct{ OK bool }
					if err := peer.Call(ctx, "approval.resolve", map[string]any{"taskId": target, "conversationId": card.SessionID, "approved": true}, &ack); err != nil {
						return err
					}
					if !ack.OK {
						return fmt.Errorf("approval not acknowledged")
					}
					var budget struct {
						SpentMicros   *int64
						MaxCostMicros *int64
						Reached       *bool
					}
					if err := peer.Call(ctx, "budget.raise", map[string]any{"taskId": target, "conversationId": card.SessionID, "newMaxCostMicros": 10_000}, &budget); err != nil {
						return err
					}
					if budget.SpentMicros == nil || budget.MaxCostMicros == nil || *budget.MaxCostMicros != 10_000 || budget.Reached == nil {
						return fmt.Errorf("incomplete budget acknowledgement")
					}
					requested = e.Rev
					break
				}
				continue
			}
			if e.Rev <= requested || len(view.Approvals) != 0 {
				continue
			}
			for _, issue := range view.Issues {
				if issue.Title == "Approved work" {
					fmt.Printf("Go approval.resolve created %s, pending card removed, space rev %d -> %d\n", issue.ID, requested, e.Rev)
					return nil
				}
			}
		}
	}
}

func channelHistory(ctx context.Context, peer *link.Link, cli string) error {
	out, err := exec.CommandContext(ctx, cli, "channel", "list", "--format", "json").Output()
	if err != nil {
		return err
	}
	var channels []struct {
		ID      string
		Default bool
	}
	if err := json.Unmarshal(out, &channels); err != nil {
		return err
	}
	var id string
	for _, c := range channels {
		if c.Default {
			id = c.ID
			break
		}
	}
	if id == "" {
		return fmt.Errorf("default channel missing")
	}

	type event struct {
		ChannelID, AuthorID, Kind, Text string
		Seq, CreatedAtMs                int64
	}
	var initial []event
	if err := peer.Call(ctx, "channel.events", map[string]any{"channelId": id}, &initial); err != nil {
		return err
	}
	var after int64
	if len(initial) > 0 {
		after = initial[len(initial)-1].Seq
	}
	texts := []string{"Chord first", "Chord second"}
	for _, text := range texts {
		if out, err := exec.CommandContext(ctx, cli, "channel", "message", "send", id, text).CombinedOutput(); err != nil {
			return fmt.Errorf("send message: %w: %s", err, out)
		}
	}
	received := 0
	for {
		var page []event
		if err := peer.Call(ctx, "channel.events", map[string]any{"channelId": id, "afterSeq": after, "limit": 1}, &page); err != nil {
			return err
		}
		if len(page) == 0 {
			break
		}
		if len(page) != 1 || page[0].Seq != after+1 || page[0].ChannelID != id || page[0].CreatedAtMs <= 0 {
			return fmt.Errorf("unexpected channel.events page after %d: %+v", after, page)
		}
		row := page[0]
		if row.AuthorID == "user" {
			if row.Kind != "message" || received >= len(texts) || row.Text != texts[received] {
				return fmt.Errorf("unexpected user message at seq %d: %+v", row.Seq, row)
			}
			received++
		}
		after = row.Seq
	}
	if received != len(texts) {
		return fmt.Errorf("received %d of %d CLI messages", received, len(texts))
	}
	fmt.Printf("Go channel.events: two CLI messages in channel %s, one-row pages through seq %d, empty tail\n", id, after)
	return nil
}
