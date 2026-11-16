package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/machine"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/link"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func resolveMachineWSURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("invalid server url %q: %w", raw, err)
	}
	switch strings.ToLower(u.Scheme) {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("unsupported server url scheme %q", u.Scheme)
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = "/machine/ws"
	}
	return u.String(), nil
}

func serveChordLinkWS(ctx context.Context, node *machine.Node, labels []string) error {
	wsURL, err := resolveMachineWSURL(node.ServerURL())
	if err != nil {
		return err
	}

	backoff := 100 * time.Millisecond
	for {
		if ctx.Err() != nil {
			return nil
		}

		client := newMachineChordClient(wsURL, node, labels)
		err := client.Connect(ctx)
		if err != nil {
			_ = client.Close()
			if ctx.Err() != nil {
				return nil
			}
			timer := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil
			case <-timer.C:
			}
			if backoff < 2*time.Second {
				backoff *= 2
			}
			continue
		}

		<-ctx.Done()
		_ = client.Close()
		return nil
	}
}

func newMachineChordClient(wsURL string, node *machine.Node, labels []string) *link.Client {
	dial := func(dialCtx context.Context) (link.FrameTransport, error) {
		ws, _, err := link.DialWebSocket(dialCtx, wsURL)
		return ws, err
	}

	client := link.NewClient(dial, link.ClientOptions{
		LinkOptions: link.Options{
			Principal: link.Principal{
				Kind: link.PrincipalMachineNode,
				ID:   node.MachineID(),
			},
			SidePrefix: "mach",
		},
		ReconnectMinDelay: 100 * time.Millisecond,
		ReconnectMaxDelay: 2 * time.Second,
		OnConnect: func(_ *link.Link) {
			node.Leases().ReconnectAll()
		},
		OnDisconnect: func(err error) {
			if err == nil {
				err = machine.ErrLinkDisconnected
			}
			node.Leases().DisconnectAll(err)
		},
	})

	registerMachineRPCs(client, node, labels)
	return client
}

func registerMachineRPCs(client *link.Client, node *machine.Node, labels []string) {
	client.HandleRPC("machine.info", func(_ context.Context, _ json.RawMessage) (any, error) {
		return map[string]any{
			"machineId":  node.MachineID(),
			"workRoot":   node.WorkRoot(),
			"labels":     labels,
			"mcpTargets": node.Tunnel().Targets(),
		}, nil
	})

	client.HandleRPC("ping", func(_ context.Context, _ json.RawMessage) (any, error) {
		return map[string]any{"pong": true, "machineId": node.MachineID()}, nil
	})

	client.HandleRPC("mcp.http", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var req machine.TunnelHTTPRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, err
		}
		return node.Tunnel().HandleMCPRequest(ctx, req), nil
	})

	client.HandleRPC("env.lease.acquire", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var req machine.LeaseRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, err
		}
		lease, _, err := node.Leases().Acquire(ctx, req)
		if err != nil {
			return nil, err
		}
		return lease, nil
	})

	client.HandleRPC("env.lease.release", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			LeaseID string `json:"leaseId"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		if err := node.Leases().Release(ctx, machine.Lease{ID: p.LeaseID}); err != nil {
			return nil, err
		}
		return map[string]bool{"released": true}, nil
	})

	client.HandleRPC("env.write", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			LeaseID string `json:"leaseId"`
			RelPath string `json:"relPath"`
			Data    []byte `json:"data"`
			Perm    uint32 `json:"perm"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		_, env, ok := node.Leases().Get(p.LeaseID)
		if !ok {
			return nil, machine.ErrLeaseNotFound
		}
		if err := env.WriteAtomic(ctx, p.RelPath, p.Data, p.Perm); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	})

	client.HandleRPC("env.edit", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			LeaseID string `json:"leaseId"`
			RelPath string `json:"relPath"`
			OldText string `json:"oldText"`
			NewText string `json:"newText"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		_, env, ok := node.Leases().Get(p.LeaseID)
		if !ok {
			return nil, machine.ErrLeaseNotFound
		}
		if err := env.EditPatch(ctx, p.RelPath, p.OldText, p.NewText); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	})

	client.HandleRPC("env.read", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			LeaseID string `json:"leaseId"`
			RelPath string `json:"relPath"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		_, env, ok := node.Leases().Get(p.LeaseID)
		if !ok {
			return nil, machine.ErrLeaseNotFound
		}
		data, err := env.ReadFile(ctx, p.RelPath)
		if err != nil {
			return nil, err
		}
		return map[string][]byte{"data": data}, nil
	})

	client.HandleRPC("env.exec", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			LeaseID string            `json:"leaseId"`
			Spec    contract.ExecSpec `json:"spec"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		_, env, ok := node.Leases().Get(p.LeaseID)
		if !ok {
			return nil, machine.ErrLeaseNotFound
		}
		res, err := env.Exec(ctx, p.Spec)
		if err != nil {
			return struct {
				contract.ExecResult
				Error string `json:"error,omitempty"`
			}{
				ExecResult: res,
				Error:      err.Error(),
			}, nil
		}
		return res, nil
	})

	client.HandleRPC("env.sync", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			LeaseID string                    `json:"leaseId"`
			Req     contract.MountSyncRequest `json:"req"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		_, env, ok := node.Leases().Get(p.LeaseID)
		if !ok {
			return nil, machine.ErrLeaseNotFound
		}
		return env.SyncMounts(ctx, p.Req)
	})

	client.HandleRPC("env.harvest", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			LeaseID string `json:"leaseId"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		_, env, ok := node.Leases().Get(p.LeaseID)
		if !ok {
			return nil, machine.ErrLeaseNotFound
		}
		return env.HarvestOutputs(ctx)
	})
}
