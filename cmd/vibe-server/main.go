package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/vibevalleyhq/vibevalley/internal/config"
	"github.com/vibevalleyhq/vibevalley/internal/domain/artifact"
	"github.com/vibevalleyhq/vibevalley/internal/domain/gateway"
	"github.com/vibevalleyhq/vibevalley/internal/domain/issue"
	"github.com/vibevalleyhq/vibevalley/internal/domain/stack"
)

const (
	version            = "0.1.0-dev"
	defaultListenAddr  = "127.0.0.1:8787"
	defaultPreviewAddr = "127.0.0.1:0"
)

var serverFlagKeyMap = map[string]string{
	"addr":                  "server.addr",
	"preview-addr":          "server.preview_addr",
	"db":                    "server.db_path",
	"work-root":             "server.work_root",
	"web":                   "server.web_dist",
	"ready-json":            "server.ready_json",
	"allow-loopback-egress": "server.allow_loopback_egress",
}

// Config configures the headless VibeValley control-plane and isolated preview daemon.
type Config struct {
	Addr                string
	PreviewAddr         string
	DBPath              string
	WorkRoot            string
	HomeDir             string
	WebDist             string
	ArtifactDir         string
	MediaDir            string
	ReadyJSON           bool
	AllowLoopbackEgress bool
	AppConfig           *config.AppConfig
}

// ReadyInfo is serialized as one line when --ready-json is enabled after listeners bind.
type ReadyInfo struct {
	PID         int    `json:"pid"`
	URL         string `json:"url"`
	Addr        string `json:"addr"`
	PreviewAddr string `json:"preview_addr,omitempty"`
}

// Server wraps the assembled Platform Stack plus control-plane, protocol gateway, and isolated preview HTTP servers.
type Server struct {
	stack       *stack.Stack
	gw          *gateway.Handler
	mainLn      net.Listener
	mainSrv     *http.Server
	previewLn   net.Listener
	previewSrv  *http.Server
	serveErrCh  chan error
	shutdownCtx context.Context
	cancel      context.CancelFunc
	closeOnce   sync.Once
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "vibe-server: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) error {
	rootCmd := newRootCommand(getenv, stdout, stderr)
	if args == nil {
		args = []string{}
	}
	rootCmd.SetArgs(args)
	return rootCmd.ExecuteContext(ctx)
}

func newRootCommand(getenv func(string) string, stdout, stderr io.Writer) *cobra.Command {
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
		configFile          string
		showVersion         bool
		addr                string
		previewAddr         string
		dbPath              string
		workRoot            string
		webDist             string
		readyJSON           bool
		allowLoopbackEgress bool
	)

	rootCmd := &cobra.Command{
		Use:           "vibe-server",
		Short:         "VibeValley control-plane and isolated preview daemon",
		Version:       version,
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if showVersion {
				return printVersion(stdout)
			}
			return executeServe(cmd.Context(), cmd.Flags(), configFile, getenv, stdout)
		},
	}
	rootCmd.SetOut(stdout)
	rootCmd.SetErr(stderr)
	rootCmd.SetVersionTemplate("vibe-server {{.Version}}\n")

	pflags := rootCmd.PersistentFlags()
	pflags.StringVarP(&configFile, "config", "c", "", "path to vibevalley.yaml config file (or VIBE_CONFIG)")
	pflags.BoolVar(&showVersion, "version", false, "print version and exit")
	pflags.StringVar(&addr, "addr", defaults.Server.Addr, "HTTP and WebSocket control-plane listen address")
	pflags.StringVar(&previewAddr, "preview-addr", defaults.Server.PreviewAddr, "Isolated artifact preview HTTP listen address (set 'disabled' to turn off)")
	pflags.StringVar(&dbPath, "db", defaults.Server.DBPath, "SQLite WAL database path or :memory:")
	pflags.StringVar(&workRoot, "work-root", defaults.Server.WorkRoot, "Workspace root directory")
	pflags.StringVar(&webDist, "web", defaults.Server.WebDist, "Directory containing built web SPA assets to host at /")
	pflags.BoolVar(&readyJSON, "ready-json", defaults.Server.ReadyJSON, "Emit single-line readiness JSON once listeners are bound")
	pflags.BoolVar(&allowLoopbackEgress, "allow-loopback-egress", defaults.Server.AllowLoopbackEgress, "Allow vault egress proxy to target loopback addresses")

	serveCmd := &cobra.Command{
		Use:   "serve",
		Short: "Start the VibeValley control-plane and preview HTTP daemon",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if showVersion {
				return printVersion(stdout)
			}
			return executeServe(cmd.Context(), cmd.Flags(), configFile, getenv, stdout)
		},
	}

	migrateCmd := &cobra.Command{
		Use:   "migrate",
		Short: "Run SQLite schema migrations across all platform modules",
	}

	migrateUpCmd := &cobra.Command{
		Use:   "up",
		Short: "Apply pending migrations across all 10 SQLite scopes",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if showVersion {
				return printVersion(stdout)
			}
			_, _, srvCfg, err := loadServerConfig(cmd.Flags(), configFile, getenv)
			if err != nil {
				return err
			}
			results, err := stack.MigrateUp(cmd.Context(), srvCfg.DBPath)
			if err != nil {
				return err
			}
			for _, r := range results {
				if _, err := fmt.Fprintf(stdout, "migrate up scope=%s before=%d after=%d applied=%d pending=%d db=%s\n",
					r.Scope, r.BeforeVersion, r.AfterVersion, r.Applied, r.Pending, r.DBPath); err != nil {
					return err
				}
			}
			return nil
		},
	}

	var (
		downSteps int
		downAll   bool
	)
	migrateDownCmd := &cobra.Command{
		Use:   "down",
		Short: "Revert migrations across all 10 SQLite scopes",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if showVersion {
				return printVersion(stdout)
			}
			if downAll && cmd.Flags().Changed("steps") {
				return errors.New("cannot specify both --steps and --all")
			}
			if !downAll && downSteps < 0 {
				return fmt.Errorf("--steps must be non-negative, got %d", downSteps)
			}
			_, _, srvCfg, err := loadServerConfig(cmd.Flags(), configFile, getenv)
			if err != nil {
				return err
			}
			results, err := stack.MigrateDown(cmd.Context(), srvCfg.DBPath, downSteps, downAll)
			if err != nil {
				return err
			}
			for _, r := range results {
				if _, err := fmt.Fprintf(stdout, "migrate down scope=%s before=%d after=%d reverted=%d pending=%d db=%s\n",
					r.Scope, r.BeforeVersion, r.AfterVersion, r.Reverted, r.Pending, r.DBPath); err != nil {
					return err
				}
			}
			return nil
		},
	}
	migrateDownCmd.Flags().IntVar(&downSteps, "steps", 1, "number of migrations to revert per scope")
	migrateDownCmd.Flags().BoolVar(&downAll, "all", false, "revert all applied migrations per scope")

	migrateStatusCmd := &cobra.Command{
		Use:   "status",
		Short: "Show migration status across all 10 SQLite scopes",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if showVersion {
				return printVersion(stdout)
			}
			_, _, srvCfg, err := loadServerConfig(cmd.Flags(), configFile, getenv)
			if err != nil {
				return err
			}
			statuses, err := stack.MigrateStatus(cmd.Context(), srvCfg.DBPath)
			if err != nil {
				return err
			}
			for _, st := range statuses {
				if _, err := fmt.Fprintf(stdout, "scope=%s version=%d name=%s applied=%t\n",
					st.Scope, st.Version, st.Name, st.Applied); err != nil {
					return err
				}
			}
			return nil
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
			_, loadedPath, _, err := loadServerConfig(cmd.Flags(), configFile, getenv)
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
			cfg, _, _, err := loadServerConfig(cmd.Flags(), configFile, getenv)
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
		Short: "Print vibe-server version",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return printVersion(stdout)
		},
	}

	migrateCmd.AddCommand(migrateUpCmd, migrateDownCmd, migrateStatusCmd)
	configCmd.AddCommand(configCheckCmd, configPrintCmd)
	rootCmd.AddCommand(serveCmd, migrateCmd, configCmd, versionCmd)
	return rootCmd
}

func printVersion(stdout io.Writer) error {
	_, err := fmt.Fprintf(stdout, "vibe-server %s\n", version)
	return err
}

func loadServerConfig(flags *pflag.FlagSet, configFile string, getenv func(string) string) (*config.AppConfig, string, Config, error) {
	cfg, loadedPath, err := config.Load(config.LoadOptions{
		ConfigFile: configFile,
		Getenv:     getenv,
		FlagSet:    flags,
		FlagKeyMap: serverFlagKeyMap,
	})
	if err != nil {
		return nil, "", Config{}, err
	}
	homeDir := strings.TrimSpace(cfg.Server.HomeDir)
	if homeDir == "" {
		homeDir = strings.TrimSpace(cfg.HomeDir)
	}
	srvCfg := Config{
		Addr:                cfg.Server.Addr,
		PreviewAddr:         cfg.Server.PreviewAddr,
		DBPath:              cfg.Server.DBPath,
		WorkRoot:            cfg.Server.WorkRoot,
		HomeDir:             homeDir,
		WebDist:             cfg.Server.WebDist,
		ArtifactDir:         cfg.Server.ArtifactDir,
		MediaDir:            cfg.Server.MediaDir,
		ReadyJSON:           cfg.Server.ReadyJSON,
		AllowLoopbackEgress: cfg.Server.AllowLoopbackEgress,
		AppConfig:           cfg,
	}
	return cfg, loadedPath, srvCfg, nil
}

func executeServe(ctx context.Context, flags *pflag.FlagSet, configFile string, getenv func(string) string, stdout io.Writer) error {
	_, _, cfg, err := loadServerConfig(flags, configFile, getenv)
	if err != nil {
		return err
	}
	if strings.TrimSpace(cfg.HomeDir) == "" && getenv != nil {
		cfg.HomeDir = strings.TrimSpace(getenv("VIBEVALLEY_HOME"))
	}

	srv, err := NewServer(ctx, cfg)
	if err != nil {
		return err
	}

	url := "http://" + srv.Addr()
	pid := os.Getpid()
	cleanupServerJSON := writeHomeServerJSON(cfg.HomeDir, pid, srv.Port(), url)
	defer cleanupServerJSON()

	if cfg.ReadyJSON {
		readyBytes, err := json.Marshal(ReadyInfo{
			PID:         pid,
			URL:         url,
			Addr:        srv.Addr(),
			PreviewAddr: srv.PreviewAddr(),
		})
		if err != nil {
			_ = srv.Close()
			return err
		}
		_, _ = fmt.Fprintf(stdout, "%s\n", readyBytes)
	} else {
		_, _ = fmt.Fprintf(stdout, "vibe-server listening addr=%s preview=%s db=%s\n",
			srv.Addr(), srv.PreviewAddr(), cfg.DBPath)
	}

	select {
	case <-ctx.Done():
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutCtx)
	case serveErr := <-srv.ServeErr():
		_ = srv.Close()
		return serveErr
	}
}

type homeServerReceipt struct {
	PID  int    `json:"pid"`
	Port int    `json:"port"`
	URL  string `json:"url"`
}

func writeHomeServerJSON(homeDir string, pid, port int, serverURL string) func() {
	homeDir = strings.TrimSpace(homeDir)
	if homeDir == "" {
		return func() {}
	}
	if err := os.MkdirAll(homeDir, 0o700); err != nil {
		return func() {}
	}
	path := filepath.Join(homeDir, "server.json")
	raw, err := json.Marshal(homeServerReceipt{
		PID:  pid,
		Port: port,
		URL:  serverURL,
	})
	if err != nil {
		return func() {}
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0o600); err != nil {
		return func() {}
	}
	return func() {
		data, rErr := os.ReadFile(path)
		if rErr != nil {
			return
		}
		var receipt homeServerReceipt
		if json.Unmarshal(data, &receipt) == nil && receipt.PID == pid {
			_ = os.Remove(path)
		}
	}
}

// NewServer binds listeners, initializes the full VibeValley Platform Stack, and starts serving requests.
func NewServer(ctx context.Context, cfg Config) (*Server, error) {
	if strings.TrimSpace(cfg.Addr) == "" {
		cfg.Addr = defaultListenAddr
	}
	mainLn, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		return nil, fmt.Errorf("listen control plane %q: %w", cfg.Addr, err)
	}

	var previewLn net.Listener
	pAddr := strings.TrimSpace(cfg.PreviewAddr)
	if pAddr != "" && !strings.EqualFold(pAddr, "disabled") && !strings.EqualFold(pAddr, "off") && !strings.EqualFold(pAddr, "none") {
		previewLn, err = net.Listen("tcp", pAddr)
		if err != nil {
			_ = mainLn.Close()
			return nil, fmt.Errorf("listen preview %q: %w", pAddr, err)
		}
	}

	previewHost := ""
	if previewLn != nil {
		previewHost = previewLn.Addr().String()
	}

	stCfg := stack.Config{
		DBPath:              cfg.DBPath,
		WorkRoot:            cfg.WorkRoot,
		HomeDir:             cfg.HomeDir,
		Version:             version,
		ArtifactDir:         cfg.ArtifactDir,
		MediaDir:            cfg.MediaDir,
		ServerURL:           "http://" + mainLn.Addr().String(),
		PreviewHost:         previewHost,
		WorkbenchHosts:      []string{mainLn.Addr().String()},
		AllowLoopbackEgress: cfg.AllowLoopbackEgress,
		AppConfig:           cfg.AppConfig,
	}
	st, err := stack.New(ctx, stCfg)
	if err != nil {
		_ = mainLn.Close()
		if previewLn != nil {
			_ = previewLn.Close()
		}
		return nil, fmt.Errorf("initialize stack: %w", err)
	}

	var gwOpts []gateway.Option
	if strings.TrimSpace(cfg.WebDist) != "" {
		gwOpts = append(gwOpts, gateway.WithWebDist(cfg.WebDist))
	}
	gw := gateway.NewHandler(st, gwOpts...)

	shutCtx, cancel := context.WithCancel(context.Background())
	s := &Server{
		stack:       st,
		gw:          gw,
		mainLn:      mainLn,
		previewLn:   previewLn,
		serveErrCh:  make(chan error, 2),
		shutdownCtx: shutCtx,
		cancel:      cancel,
	}

	s.mainSrv = &http.Server{
		Handler:           s.newControlPlaneMux(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		if err := s.mainSrv.Serve(mainLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.serveErrCh <- err
		}
	}()

	if previewLn != nil {
		s.previewSrv = &http.Server{
			Handler:           s.stack.Artifacts.Preview,
			ReadHeaderTimeout: 10 * time.Second,
		}
		go func() {
			if err := s.previewSrv.Serve(previewLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
				s.serveErrCh <- err
			}
		}()
	}

	return s, nil
}

// Addr returns the bound control-plane host:port.
func (s *Server) Addr() string {
	if s.mainLn == nil {
		return ""
	}
	return s.mainLn.Addr().String()
}

// Port returns the bound TCP port of the control-plane listener.
func (s *Server) Port() int {
	if s.mainLn == nil {
		return 0
	}
	if tcpAddr, ok := s.mainLn.Addr().(*net.TCPAddr); ok {
		return tcpAddr.Port
	}
	return 0
}

// PreviewAddr returns the bound isolated preview host:port, or empty when disabled.
func (s *Server) PreviewAddr() string {
	if s.previewLn == nil {
		return ""
	}
	return s.previewLn.Addr().String()
}

// Stack returns the underlying assembled VibeValley runtime stack.
func (s *Server) Stack() *stack.Stack { return s.stack }

// ServeErr notifies callers if an HTTP server exits unexpectedly.
func (s *Server) ServeErr() <-chan error { return s.serveErrCh }

// Close immediately shuts down listeners and closes the stack.
func (s *Server) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return s.Shutdown(ctx)
}

// Shutdown gracefully drains HTTP servers and closes the assembled stack.
func (s *Server) Shutdown(ctx context.Context) error {
	var shutErr error
	s.closeOnce.Do(func() {
		s.cancel()
		if s.previewSrv != nil {
			shutErr = errors.Join(shutErr, s.previewSrv.Shutdown(ctx))
		}
		if s.mainSrv != nil {
			shutErr = errors.Join(shutErr, s.mainSrv.Shutdown(ctx))
		}
		if s.stack != nil {
			shutErr = errors.Join(shutErr, s.stack.Close())
		}
	})
	return shutErr
}

func (s *Server) newControlPlaneMux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc("/chord/ws", s.stack.HandleClientWebSocket)
	mux.HandleFunc("/machine/ws", s.stack.Machines.HandleWebSocket)
	mux.Handle("/egress", s.stack.Egress)
	mux.Handle("/egress/", s.stack.Egress)
	mux.HandleFunc("/api/v1/state", s.gw.HandleState)
	mux.HandleFunc("/api/v1/issues", s.handleAPIIssues)
	mux.HandleFunc("/api/v1/machines", s.handleAPIMachines)
	mux.HandleFunc("/api/v1/artifacts/publish", s.handleAPIArtifactPublish)
	mux.Handle("/", s.gw)
	return mux
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":              true,
		"addr":            s.Addr(),
		"preview_addr":    s.PreviewAddr(),
		"online_machines": s.stack.Machines.OnlineIDs(),
	})
}

func (s *Server) handleAPIMachines(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"machines": s.stack.Machines.ListOnline(),
	})
}

func (s *Server) handleAPIIssues(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		views, err := s.stack.Issues.ListIssueViews(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"issues": views})
	case http.MethodPost:
		var req struct {
			Issue    issue.Issue `json:"issue"`
			Dispatch bool        `json:"dispatch"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.Dispatch {
			iss, receipt, err := s.stack.CreateAndDispatchIssue(r.Context(), req.Issue)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			writeJSON(w, http.StatusCreated, map[string]any{"issue": iss, "receipt": receipt})
			return
		}
		iss, err := s.stack.Issues.CreateIssue(r.Context(), req.Issue)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = s.stack.SyncSpaceProjection(r.Context())
		writeJSON(w, http.StatusCreated, map[string]any{"issue": iss})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleAPIArtifactPublish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req artifact.PublishRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	res, err := s.stack.Artifacts.Deliverables.Publish(r.Context(), req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
