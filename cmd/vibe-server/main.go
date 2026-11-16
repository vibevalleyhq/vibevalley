package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/artifact"
	"github.com/vibevalleyhq/vibevalley/internal/domain/issue"
	"github.com/vibevalleyhq/vibevalley/internal/domain/stack"
)

const (
	defaultListenAddr  = "127.0.0.1:8787"
	defaultPreviewAddr = "127.0.0.1:0"
)

// Config configures the headless VibeValley control-plane and isolated preview daemon.
type Config struct {
	Addr                string
	PreviewAddr         string
	DBPath              string
	WorkRoot            string
	ReadyJSON           bool
	AllowLoopbackEgress bool
}

// ReadyInfo is serialized as one line when --ready-json is enabled after listeners bind.
type ReadyInfo struct {
	Addr        string `json:"addr"`
	PreviewAddr string `json:"preview_addr,omitempty"`
}

// Server wraps the assembled Platform Stack plus control-plane and isolated preview HTTP servers.
type Server struct {
	stack       *stack.Stack
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
	cfg, helpText, showHelp, err := parseArgs(args, getenv)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, helpText)
		return err
	}
	if showHelp {
		_, _ = fmt.Fprintln(stdout, helpText)
		return nil
	}

	srv, err := NewServer(ctx, cfg)
	if err != nil {
		return err
	}

	if cfg.ReadyJSON {
		readyBytes, err := json.Marshal(ReadyInfo{
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

func parseArgs(args []string, getenv func(string) string) (Config, string, bool, error) {
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	defaultAddr := strings.TrimSpace(getenv("VIBE_SERVER_ADDR"))
	if defaultAddr == "" {
		defaultAddr = defaultListenAddr
	}
	defaultPreview := strings.TrimSpace(getenv("VIBE_PREVIEW_ADDR"))
	if defaultPreview == "" {
		defaultPreview = defaultPreviewAddr
	}
	defaultDB := strings.TrimSpace(getenv("VIBE_DB_PATH"))
	if defaultDB == "" {
		defaultDB = ":memory:"
	}
	defaultWork := strings.TrimSpace(getenv("VIBEVALLEY_WORK_ROOT"))
	defaultLoopback := strings.TrimSpace(getenv("VIBE_ALLOW_LOOPBACK_EGRESS")) == "1"

	fs := flag.NewFlagSet("vibe-server", flag.ContinueOnError)
	var helpBuf strings.Builder
	fs.SetOutput(&helpBuf)

	var cfg Config
	fs.StringVar(&cfg.Addr, "addr", defaultAddr, "HTTP and WebSocket control-plane listen address")
	fs.StringVar(&cfg.PreviewAddr, "preview-addr", defaultPreview, "Isolated artifact preview HTTP listen address (set 'disabled' to turn off)")
	fs.StringVar(&cfg.DBPath, "db", defaultDB, "SQLite WAL database path or :memory:")
	fs.StringVar(&cfg.WorkRoot, "work-root", defaultWork, "Workspace root directory")
	fs.BoolVar(&cfg.ReadyJSON, "ready-json", false, "Emit single-line readiness JSON once listeners are bound")
	fs.BoolVar(&cfg.AllowLoopbackEgress, "allow-loopback-egress", defaultLoopback, "Allow vault egress proxy to target loopback addresses")

	err := fs.Parse(args)
	if errors.Is(err, flag.ErrHelp) {
		fs.PrintDefaults()
		return Config{}, helpBuf.String(), true, nil
	}
	if err != nil {
		fs.PrintDefaults()
		return Config{}, helpBuf.String(), false, err
	}
	return cfg, "", false, nil
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
		ServerURL:           "http://" + mainLn.Addr().String(),
		PreviewHost:         previewHost,
		WorkbenchHosts:      []string{mainLn.Addr().String()},
		AllowLoopbackEgress: cfg.AllowLoopbackEgress,
	}
	st, err := stack.New(ctx, stCfg)
	if err != nil {
		_ = mainLn.Close()
		if previewLn != nil {
			_ = previewLn.Close()
		}
		return nil, fmt.Errorf("initialize stack: %w", err)
	}

	shutCtx, cancel := context.WithCancel(context.Background())
	s := &Server{
		stack:       st,
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
	mux.HandleFunc("/api/v1/state", s.handleAPIState)
	mux.HandleFunc("/api/v1/issues", s.handleAPIIssues)
	mux.HandleFunc("/api/v1/machines", s.handleAPIMachines)
	mux.HandleFunc("/api/v1/artifacts/publish", s.handleAPIArtifactPublish)
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

func (s *Server) handleAPIState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rev, view := s.stack.Game.Snapshot()
	writeJSON(w, http.StatusOK, map[string]any{
		"rev":   rev,
		"space": view,
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
