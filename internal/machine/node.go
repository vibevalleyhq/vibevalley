package machine

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

// LinkDialer establishes an outbound LinkTransport connection from vibe-machine to vibe-server.
type LinkDialer interface {
	Dial(ctx context.Context, serverURL, machineID string) (LinkTransport, error)
}

// NodeConfig configures a standalone zero-secret vibe-machine execution node.
type NodeConfig struct {
	MachineID       string
	ServerURL       string
	WorkRoot        string
	Labels          []string
	MCPTargets      []MCPTarget
	SyncInterval    time.Duration
	FlushTimeout    time.Duration
	ExecGracePeriod time.Duration
	MountRemote     MountRemote
	HTTPClient      *http.Client
	Now             func() time.Time
}

// Node coordinates workspace leases, mount sync scheduling, process execution, and MCP reverse tunneling.
type Node struct {
	machineID    string
	serverURL    string
	workRoot     string
	syncInterval time.Duration
	flushTimeout time.Duration
	leases       *LeaseTracker
	tunnel       *TunnelHandler
}

// NewNode constructs and validates a zero-secret vibe-machine Node.
func NewNode(cfg NodeConfig) (*Node, error) {
	if strings.TrimSpace(cfg.ServerURL) != "" {
		u, err := url.Parse(strings.TrimSpace(cfg.ServerURL))
		if err != nil {
			return nil, fmt.Errorf("machine: invalid server url: %w", err)
		}
		if u.User != nil {
			return nil, errors.New("machine: server url must not embed credentials")
		}
		switch u.Scheme {
		case "http", "https", "ws", "wss":
		default:
			return nil, fmt.Errorf("machine: unsupported server url scheme %q", u.Scheme)
		}
		if u.Host == "" {
			return nil, errors.New("machine: server url must include host")
		}
	}

	machineID := strings.TrimSpace(cfg.MachineID)
	if machineID == "" {
		if host, err := os.Hostname(); err == nil && host != "" {
			machineID = host
		} else {
			machineID = "vibe-machine"
		}
	}

	leases, err := NewLeaseTracker(LeaseTrackerConfig{
		MachineID:       machineID,
		WorkRoot:        cfg.WorkRoot,
		Labels:          cfg.Labels,
		ExecGracePeriod: cfg.ExecGracePeriod,
		MountRemote:     cfg.MountRemote,
		Now:             cfg.Now,
	})
	if err != nil {
		return nil, err
	}

	tunnel, err := NewTunnelHandler(TunnelHandlerConfig{
		Targets:    cfg.MCPTargets,
		HTTPClient: cfg.HTTPClient,
		Now:        cfg.Now,
	})
	if err != nil {
		return nil, err
	}

	syncInterval := cfg.SyncInterval
	if syncInterval <= 0 {
		syncInterval = DefaultMountSyncInterval
	}
	flushTimeout := cfg.FlushTimeout
	if flushTimeout <= 0 {
		flushTimeout = DefaultMountFlushTimeout
	}

	return &Node{
		machineID:    machineID,
		serverURL:    strings.TrimSpace(cfg.ServerURL),
		workRoot:     leases.workRoot,
		syncInterval: syncInterval,
		flushTimeout: flushTimeout,
		leases:       leases,
		tunnel:       tunnel,
	}, nil
}

// MachineID returns the configured machine identifier.
func (n *Node) MachineID() string {
	return n.machineID
}

// ServerURL returns the configured control-plane server URL.
func (n *Node) ServerURL() string {
	return n.serverURL
}

// WorkRoot returns the resolved work root directory.
func (n *Node) WorkRoot() string {
	return n.workRoot
}

// Leases returns the node's workspace lease tracker.
func (n *Node) Leases() *LeaseTracker {
	return n.leases
}

// Tunnel returns the node's intranet MCP reverse-tunnel handler.
func (n *Node) Tunnel() *TunnelHandler {
	return n.tunnel
}

// NewLazyEnv builds a lazy ExecutionEnv bound to this node's LeaseTracker.
func (n *Node) NewLazyEnv(req LeaseRequest) *LazyEnv {
	return NewLazyEnv(req, n.leases)
}

// NewMountSyncer wraps env with this node's configured throttle interval and flush timeout.
func (n *Node) NewMountSyncer(env contract.ExecutionEnv) *MountSyncer {
	return NewMountSyncer(env, MountSyncerConfig{
		ThrottleInterval: n.syncInterval,
		FlushTimeout:     n.flushTimeout,
	})
}

// DialAndServe dials outbound to the control plane and serves frames with bounded backoff until ctx cancels.
func (n *Node) DialAndServe(ctx context.Context, dialer LinkDialer) error {
	if dialer == nil {
		return errors.New("machine: nil link dialer")
	}
	backoff := 250 * time.Millisecond
	const maxBackoff = 15 * time.Second

	for {
		if err := ctx.Err(); err != nil {
			return err
		}

		transport, err := dialer.Dial(ctx, n.serverURL, n.machineID)
		if err == nil {
			backoff = 250 * time.Millisecond
			n.leases.ReconnectAll()
			serveErr := n.ServeLink(ctx, transport)
			if ctx.Err() != nil {
				return ctx.Err()
			}
			_ = serveErr
		} else if ctx.Err() != nil {
			return ctx.Err()
		}

		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

// Close terminates active leased environments and releases node resources.
func (n *Node) Close() error {
	return n.leases.CloseAll()
}
