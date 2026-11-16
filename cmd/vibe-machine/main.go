package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/machine"
)

const version = "0.1.0-dev"

type stringSliceFlag []string

func (s *stringSliceFlag) String() string {
	return strings.Join(*s, ",")
}

func (s *stringSliceFlag) Set(value string) error {
	for part := range strings.SplitSeq(value, ",") {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			*s = append(*s, trimmed)
		}
	}
	return nil
}

type mcpTargetFlag []machine.MCPTarget

func (m *mcpTargetFlag) String() string {
	parts := make([]string, 0, len(*m))
	for _, t := range *m {
		parts = append(parts, t.ID+"="+t.Endpoint)
	}
	return strings.Join(parts, ",")
}

func (m *mcpTargetFlag) Set(value string) error {
	id, endpoint, ok := strings.Cut(value, "=")
	if !ok || strings.TrimSpace(id) == "" || strings.TrimSpace(endpoint) == "" {
		return fmt.Errorf("invalid --mcp-target %q: expected id=http(s)://url", value)
	}
	*m = append(*m, machine.MCPTarget{
		ID:       strings.TrimSpace(id),
		Endpoint: strings.TrimSpace(endpoint),
	})
	return nil
}

type cliOptions struct {
	ShowVersion  bool
	Config       machine.NodeConfig
	Dialer       machine.LinkDialer
	PrintAndExit bool
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr, nil); err != nil {
		fmt.Fprintf(os.Stderr, "vibe-machine: %v\n", err)
		os.Exit(1)
	}
}

func parseCLI(args []string, getenv func(string) string, stderr io.Writer) (cliOptions, error) {
	defaultWorkRoot := strings.TrimSpace(getenv("VIBEVALLEY_WORK_ROOT"))
	if defaultWorkRoot == "" {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			defaultWorkRoot = filepath.Join(home, ".vibevalley", "work")
		} else {
			defaultWorkRoot = "work"
		}
	}
	defaultMachineID := strings.TrimSpace(getenv("VIBE_MACHINE_ID"))
	if defaultMachineID == "" {
		if host, err := os.Hostname(); err == nil && host != "" {
			defaultMachineID = host
		} else {
			defaultMachineID = "vibe-machine"
		}
	}
	defaultServer := strings.TrimSpace(getenv("VIBE_SERVER_URL"))

	fs := flag.NewFlagSet("vibe-machine", flag.ContinueOnError)
	fs.SetOutput(stderr)

	var (
		showVersion  bool
		printReady   bool
		serverURL    string
		workRoot     string
		machineID    string
		labels       stringSliceFlag
		mcpTargets   mcpTargetFlag
		syncInterval time.Duration
		flushTimeout time.Duration
		execGrace    time.Duration
	)

	fs.BoolVar(&showVersion, "version", false, "print version and exit")
	fs.BoolVar(&printReady, "check", false, "validate zero-secret node config and exit")
	fs.StringVar(&serverURL, "server", defaultServer, "control-plane server URL for outbound link")
	fs.StringVar(&workRoot, "work-root", defaultWorkRoot, "workspace root directory for session leases")
	fs.StringVar(&machineID, "machine-id", defaultMachineID, "machine identifier advertised to control plane")
	fs.Var(&labels, "label", "capability label (repeatable or comma-separated)")
	fs.Var(&mcpTargets, "mcp-target", "private intranet MCP target as id=url (repeatable)")
	fs.DurationVar(&syncInterval, "sync-interval", machine.DefaultMountSyncInterval, "memory mount sync throttle interval")
	fs.DurationVar(&flushTimeout, "flush-timeout", machine.DefaultMountFlushTimeout, "turn-end memory sync flush timeout")
	fs.DurationVar(&execGrace, "exec-grace", 2*time.Second, "SIGTERM to SIGKILL grace period (<= 3s)")

	if err := fs.Parse(args); err != nil {
		return cliOptions{}, err
	}

	if execGrace <= 0 || execGrace > 3*time.Second {
		return cliOptions{}, fmt.Errorf("--exec-grace must be in (0s, 3s], got %s", execGrace)
	}

	return cliOptions{
		ShowVersion:  showVersion,
		PrintAndExit: printReady,
		Config: machine.NodeConfig{
			MachineID:       machineID,
			ServerURL:       serverURL,
			WorkRoot:        workRoot,
			Labels:          labels,
			MCPTargets:      mcpTargets,
			SyncInterval:    syncInterval,
			FlushTimeout:    flushTimeout,
			ExecGracePeriod: execGrace,
		},
	}, nil
}

func run(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer, dialer machine.LinkDialer) error {
	opts, err := parseCLI(args, getenv, stderr)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if opts.ShowVersion {
		_, err := fmt.Fprintf(stdout, "vibe-machine %s\n", version)
		return err
	}

	node, err := machine.NewNode(opts.Config)
	if err != nil {
		return err
	}
	defer node.Close()

	_, _ = fmt.Fprintf(stdout, "vibe-machine ready id=%s work_root=%s server=%s mcp_targets=%d\n",
		node.MachineID(), node.WorkRoot(), node.ServerURL(), len(node.Tunnel().Targets()))

	if opts.PrintAndExit {
		return nil
	}

	if dialer != nil && node.ServerURL() != "" {
		err := node.DialAndServe(ctx, dialer)
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil
		}
		return err
	}

	if node.ServerURL() != "" {
		return serveChordLinkWS(ctx, node, opts.Config.Labels)
	}

	<-ctx.Done()
	return nil
}
