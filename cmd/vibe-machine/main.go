package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/vibevalleyhq/vibevalley/internal/config"
	"github.com/vibevalleyhq/vibevalley/internal/machine"
)

const version = "0.1.0-dev"

var machineFlagKeyMap = map[string]string{
	"server":        "machine.server_url",
	"work-root":     "machine.work_root",
	"machine-id":    "machine.machine_id",
	"label":         "machine.labels",
	"mcp-target":    "machine.mcp_targets",
	"sync-interval": "machine.sync_interval",
	"flush-timeout": "machine.flush_timeout",
	"exec-grace":    "machine.exec_grace",
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

func newRootCommand(getenv func(string) string, stdout, stderr io.Writer, dialer machine.LinkDialer) *cobra.Command {
	if getenv == nil {
		getenv = os.Getenv
	}
	if stdout == nil {
		stdout = os.Stdout
	}
	if stderr == nil {
		stderr = os.Stderr
	}

	defaults := config.DefaultConfig(getenv)

	var (
		configFile   string
		showVersion  bool
		checkOnly    bool
		serverURL    string
		workRoot     string
		machineID    string
		labels       []string
		mcpTargets   []string
		syncInterval time.Duration
		flushTimeout time.Duration
		execGrace    time.Duration
	)

	rootCmd := &cobra.Command{
		Use:           "vibe-machine",
		Short:         "VibeValley zero-secret remote execution node",
		Version:       version,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if showVersion {
				return printVersion(stdout)
			}
			return executeMachine(cmd.Context(), cmd.Flags(), configFile, getenv, stdout, dialer, checkOnly)
		},
	}
	rootCmd.SetOut(stdout)
	rootCmd.SetErr(stderr)
	rootCmd.SetVersionTemplate("vibe-machine {{.Version}}\n")

	pflags := rootCmd.PersistentFlags()
	pflags.StringVarP(&configFile, "config", "c", "", "path to vibevalley.yaml config file (or VIBE_CONFIG)")
	pflags.BoolVar(&showVersion, "version", false, "print version and exit")
	pflags.StringVar(&serverURL, "server", defaults.Machine.ServerURL, "control-plane server URL for outbound link")
	pflags.StringVar(&workRoot, "work-root", defaults.Machine.WorkRoot, "workspace root directory for session leases")
	pflags.StringVar(&machineID, "machine-id", defaults.Machine.MachineID, "machine identifier advertised to control plane")
	pflags.StringSliceVar(&labels, "label", nil, "capability label (repeatable or comma-separated)")
	pflags.StringArrayVar(&mcpTargets, "mcp-target", nil, "private intranet MCP target as id=url (repeatable)")
	pflags.DurationVar(&syncInterval, "sync-interval", defaults.Machine.SyncInterval, "memory mount sync throttle interval")
	pflags.DurationVar(&flushTimeout, "flush-timeout", defaults.Machine.FlushTimeout, "turn-end memory sync flush timeout")
	pflags.DurationVar(&execGrace, "exec-grace", defaults.Machine.ExecGrace, "SIGTERM to SIGKILL grace period (<= 3s)")

	rootCmd.Flags().BoolVar(&checkOnly, "check", false, "validate zero-secret node config and exit")

	serveCmd := &cobra.Command{
		Use:   "serve",
		Short: "Start the vibe-machine outbound link and lease daemon",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if showVersion {
				return printVersion(stdout)
			}
			return executeMachine(cmd.Context(), cmd.Flags(), configFile, getenv, stdout, dialer, false)
		},
	}

	checkCmd := &cobra.Command{
		Use:   "check",
		Short: "Validate configuration and zero-secret node startup",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if showVersion {
				return printVersion(stdout)
			}
			return executeMachine(cmd.Context(), cmd.Flags(), configFile, getenv, stdout, dialer, true)
		},
	}

	configCmd := &cobra.Command{
		Use:   "config",
		Short: "Inspect and validate resolved configuration",
	}

	configCheckCmd := &cobra.Command{
		Use:   "check",
		Short: "Validate resolved configuration",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if showVersion {
				return printVersion(stdout)
			}
			_, loadedPath, _, err := loadMachineConfig(cmd.Flags(), configFile, getenv)
			if err != nil {
				return err
			}
			if loadedPath != "" {
				_, err = fmt.Fprintf(stdout, "config ok: %s\n", loadedPath)
				return err
			}
			_, err = fmt.Fprintln(stdout, "config ok: defaults (no yaml file)")
			return err
		},
	}

	configPrintCmd := &cobra.Command{
		Use:   "print",
		Short: "Print resolved configuration as YAML with secrets redacted",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if showVersion {
				return printVersion(stdout)
			}
			cfg, _, _, err := loadMachineConfig(cmd.Flags(), configFile, getenv)
			if err != nil {
				return err
			}
			rawYAML, err := config.MarshalRedactedYAML(cfg)
			if err != nil {
				return err
			}
			if _, err := stdout.Write(rawYAML); err != nil {
				return err
			}
			if len(rawYAML) > 0 && !bytes.HasSuffix(rawYAML, []byte("\n")) {
				_, err = io.WriteString(stdout, "\n")
				return err
			}
			return nil
		},
	}

	versionCmd := &cobra.Command{
		Use:   "version",
		Short: "Print vibe-machine version",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return printVersion(stdout)
		},
	}

	configCmd.AddCommand(configCheckCmd, configPrintCmd)
	rootCmd.AddCommand(serveCmd, checkCmd, configCmd, versionCmd)
	return rootCmd
}

func printVersion(stdout io.Writer) error {
	_, err := fmt.Fprintf(stdout, "vibe-machine %s\n", version)
	return err
}

func loadMachineConfig(flags *pflag.FlagSet, configFile string, getenv func(string) string) (*config.AppConfig, string, machine.NodeConfig, error) {
	cfg, loadedPath, err := config.Load(config.LoadOptions{
		ConfigFile: configFile,
		Getenv:     getenv,
		FlagSet:    flags,
		FlagKeyMap: machineFlagKeyMap,
	})
	if err != nil {
		return nil, "", machine.NodeConfig{}, err
	}

	parsedTargets, err := cfg.Machine.ParsedMCPTargets()
	if err != nil {
		return nil, "", machine.NodeConfig{}, err
	}
	mcpTargets := make([]machine.MCPTarget, 0, len(parsedTargets))
	for _, target := range parsedTargets {
		mcpTargets = append(mcpTargets, machine.MCPTarget{
			ID:       target.ID,
			Endpoint: target.Endpoint,
		})
	}

	labels := make([]string, 0, len(cfg.Machine.Labels))
	for _, lbl := range cfg.Machine.Labels {
		if trimmed := strings.TrimSpace(lbl); trimmed != "" {
			labels = append(labels, trimmed)
		}
	}

	nodeCfg := machine.NodeConfig{
		MachineID:       cfg.Machine.MachineID,
		ServerURL:       cfg.Machine.ServerURL,
		WorkRoot:        cfg.Machine.WorkRoot,
		Labels:          labels,
		MCPTargets:      mcpTargets,
		SyncInterval:    cfg.Machine.SyncInterval,
		FlushTimeout:    cfg.Machine.FlushTimeout,
		ExecGracePeriod: cfg.Machine.ExecGrace,
	}
	return cfg, loadedPath, nodeCfg, nil
}

func executeMachine(ctx context.Context, flags *pflag.FlagSet, configFile string, getenv func(string) string, stdout io.Writer, dialer machine.LinkDialer, checkOnly bool) error {
	_, _, nodeCfg, err := loadMachineConfig(flags, configFile, getenv)
	if err != nil {
		return err
	}

	node, err := machine.NewNode(nodeCfg)
	if err != nil {
		return err
	}
	defer func() { _ = node.Close() }()

	_, _ = fmt.Fprintf(stdout, "vibe-machine ready id=%s work_root=%s server=%s mcp_targets=%d\n",
		node.MachineID(), node.WorkRoot(), node.ServerURL(), len(node.Tunnel().Targets()))

	if checkOnly {
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
		return serveChordLinkWS(ctx, node, nodeCfg.Labels)
	}

	<-ctx.Done()
	return nil
}

func parseCLI(args []string, getenv func(string) string, stderr io.Writer) (cliOptions, error) {
	rootCmd := newRootCommand(getenv, io.Discard, stderr, nil)
	rootCmd.InitDefaultHelpFlag()
	if err := rootCmd.ParseFlags(args); err != nil {
		return cliOptions{}, err
	}
	if rest := rootCmd.Flags().Args(); len(rest) > 0 {
		return cliOptions{}, fmt.Errorf("unexpected arguments: %v", rest)
	}

	showVersion, _ := rootCmd.Flags().GetBool("version")
	if showVersion {
		return cliOptions{ShowVersion: true}, nil
	}
	checkOnly, _ := rootCmd.Flags().GetBool("check")
	configFile, _ := rootCmd.Flags().GetString("config")
	_, _, nodeCfg, err := loadMachineConfig(rootCmd.Flags(), configFile, getenv)
	if err != nil {
		return cliOptions{}, err
	}

	return cliOptions{
		ShowVersion:  showVersion,
		PrintAndExit: checkOnly,
		Config:       nodeCfg,
	}, nil
}

func run(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer, dialer machine.LinkDialer) error {
	rootCmd := newRootCommand(getenv, stdout, stderr, dialer)
	if args == nil {
		args = []string{}
	}
	rootCmd.SetArgs(args)
	return rootCmd.ExecuteContext(ctx)
}
