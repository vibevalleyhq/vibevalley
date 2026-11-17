package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"github.com/egoist/mygo"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/vibevalleyhq/vibevalley/internal/config"
	"github.com/vibevalleyhq/vibevalley/internal/vault"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/link"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/watch"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

var desktopVersion = "0.1.0-dev"

var desktopFlagKeyMap = map[string]string{
	"server":            "desktop.server_url",
	"web-dist":          "desktop.web_dist",
	"scheme":            "desktop.scheme",
	"automation-socket": "desktop.automation_socket",
	"repo-root":         "desktop.repo_roots",
	"headless-check":    "desktop.headless_check",
	"root-key-id":       "desktop.root_key_id",
	"keychain-service":  "desktop.keychain_service",
	"db":                "desktop.db_path",
}

// DesktopConfig holds parsed CLI, environment, and YAML configuration for vibe-desktop.
type DesktopConfig struct {
	ServerURL        string
	WebDistDir       string
	WebScheme        string
	HomeDir          string
	ControlSocket    string
	AutomationSocket string
	RepoRoots        []string
	HeadlessCheck    bool
	ShowVersion      bool
	RootKeyID        string
	KeychainService  string
	DBPath           string
	dbExplicit       bool
}

// EmbeddedStack is the optional in-process VibeValley server/durable/vault runtime
// wired by standalone packaging or platform-e2e integration tests.
type EmbeddedStack interface {
	LinkTransport() link.FrameTransport
	SpaceSource() watch.RawSource
	ResolveApproval(ctx context.Context, prompt contract.ApprovalPromptView, approved bool) error
	RaiseBudget(ctx context.Context, alert BudgetAlert, newMaxCostMicros int64) error
	ServerURL() string
	Close() error
}

// StackLauncher constructs an optional EmbeddedStack during desktop initialization.
type StackLauncher func(ctx context.Context, cfg DesktopConfig, rootKey vault.RootKey) (EmbeddedStack, error)

// DesktopDeps injects optional drivers and embedded stack launchers for tests and E2E wiring.
type DesktopDeps struct {
	Keychain        KeychainDriver
	TerminalFactory TerminalSessionFactory
	EmbeddedWebFS   fs.FS
	StackLauncher   StackLauncher
	LiquidGlass     bool
	ExecPath        string
	WorkDir         string
}

var defaultStackLauncher StackLauncher

// RegisterStackLauncher installs a global StackLauncher used when DesktopDeps.StackLauncher is nil.
func RegisterStackLauncher(launcher StackLauncher) {
	defaultStackLauncher = launcher
}

// DesktopApp wires the Notch Island, in-process Chord Link IPC, WebView asset handler,
// Keychain Vault root key store, multi-repo terminal controller, and automation endpoint.
type DesktopApp struct {
	Config     DesktopConfig
	RootKey    vault.RootKey
	KeyStore   *VaultRootKeyStore
	Island     *IslandController
	Bridge     *ChordBridge
	WebHandler http.Handler
	WebConfig  WebViewConfig
	Terminals  *TerminalController
	Host       *DesktopHostService
	Automation *AutomationEndpoint
	Stack      EmbeddedStack

	closeOnce   sync.Once
	autoLn      io.Closer
	autoDone    <-chan struct{}
	ctrlLn      io.Closer
	ctrlDone    <-chan struct{}
	detachStack func()
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr, DesktopDeps{LiquidGlass: true}); err != nil {
		fmt.Fprintf(os.Stderr, "vibe-desktop: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer, deps DesktopDeps) error {
	rootCmd := newRootCommand(getenv, stdout, stderr, deps)
	if args == nil {
		args = []string{}
	}
	rootCmd.SetArgs(args)
	return rootCmd.ExecuteContext(ctx)
}

func newRootCommand(getenv func(string) string, stdout, stderr io.Writer, deps DesktopDeps) *cobra.Command {
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
		configFile       string
		showVersion      bool
		serverURL        string
		webDist          string
		scheme           string
		automationSocket string
		repoRoots        []string
		headlessCheck    bool
		rootKeyID        string
		keychainService  string
		dbPath           string
	)

	rootCmd := &cobra.Command{
		Use:           "vibe-desktop",
		Short:         "VibeValley desktop GUI host and embedded runtime",
		Version:       desktopVersion,
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if showVersion {
				return printDesktopVersion(stdout)
			}
			return executeDesktop(cmd.Context(), cmd.Flags(), configFile, getenv, stdout, deps, false)
		},
	}
	rootCmd.SetOut(stdout)
	rootCmd.SetErr(stderr)
	rootCmd.SetVersionTemplate("vibe-desktop {{.Version}}\n")

	pflags := rootCmd.PersistentFlags()
	pflags.StringVarP(&configFile, "config", "c", "", "path to vibevalley.yaml config file (or VIBE_CONFIG)")
	pflags.BoolVar(&showVersion, "version", false, "print version and exit")
	pflags.StringVar(&serverURL, "server", defaults.Desktop.ServerURL, "remote or local control-plane server URL")
	pflags.StringVar(&webDist, "web-dist", defaults.Desktop.WebDist, "path to built apps/web/dist directory")
	pflags.StringVar(&scheme, "scheme", defaults.Desktop.Scheme, "custom MyGo URL scheme for workbench assets")
	pflags.StringVar(&automationSocket, "automation-socket", defaults.Desktop.AutomationSocket, "optional Unix domain socket path for automation endpoint")
	pflags.StringSliceVar(&repoRoots, "repo-root", nil, "allowed repository/worktree root path for terminal sessions (repeatable or comma-separated)")
	pflags.BoolVar(&headlessCheck, "headless-check", defaults.Desktop.HeadlessCheck, "verify island, IPC, webview assets, keychain, and automation without opening windows")
	pflags.StringVar(&rootKeyID, "root-key-id", defaults.Desktop.RootKeyID, "Vault root key identifier stored in system keychain")
	pflags.StringVar(&keychainService, "keychain-service", defaults.Desktop.KeychainService, "system keychain service namespace")
	pflags.StringVar(&dbPath, "db", defaults.Desktop.DBPath, "SQLite WAL database path or :memory:")

	runCmd := &cobra.Command{
		Use:   "run",
		Short: "Launch the VibeValley desktop workbench and notch island",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if showVersion {
				return printDesktopVersion(stdout)
			}
			return executeDesktop(cmd.Context(), cmd.Flags(), configFile, getenv, stdout, deps, false)
		},
	}

	checkCmd := &cobra.Command{
		Use:   "check",
		Short: "Run headless subsystem validation without opening GUI windows",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if showVersion {
				return printDesktopVersion(stdout)
			}
			return executeDesktop(cmd.Context(), cmd.Flags(), configFile, getenv, stdout, deps, true)
		},
	}

	migrateCmd := &cobra.Command{
		Use:   "migrate",
		Short: "Run SQLite schema migrations for the embedded desktop stack",
	}

	migrateUpCmd := &cobra.Command{
		Use:   "up",
		Short: "Apply pending migrations across all 10 embedded SQLite scopes",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if showVersion {
				return printDesktopVersion(stdout)
			}
			_, _, deskCfg, err := loadDesktopConfig(cmd.Flags(), configFile, getenv)
			if err != nil {
				return err
			}
			return runDesktopMigrateUp(cmd.Context(), deskCfg.DBPath, stdout)
		},
	}

	var (
		downSteps int
		downAll   bool
	)
	migrateDownCmd := &cobra.Command{
		Use:   "down",
		Short: "Revert migrations across all 10 embedded SQLite scopes",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if showVersion {
				return printDesktopVersion(stdout)
			}
			if downAll && cmd.Flags().Changed("steps") {
				return errors.New("cannot specify both --steps and --all")
			}
			if !downAll && downSteps < 0 {
				return fmt.Errorf("--steps must be non-negative, got %d", downSteps)
			}
			_, _, deskCfg, err := loadDesktopConfig(cmd.Flags(), configFile, getenv)
			if err != nil {
				return err
			}
			return runDesktopMigrateDown(cmd.Context(), deskCfg.DBPath, downSteps, downAll, stdout)
		},
	}
	migrateDownCmd.Flags().IntVar(&downSteps, "steps", 1, "number of migrations to revert per scope")
	migrateDownCmd.Flags().BoolVar(&downAll, "all", false, "revert all applied migrations per scope")

	migrateStatusCmd := &cobra.Command{
		Use:   "status",
		Short: "Show migration status across all 10 embedded SQLite scopes",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if showVersion {
				return printDesktopVersion(stdout)
			}
			_, _, deskCfg, err := loadDesktopConfig(cmd.Flags(), configFile, getenv)
			if err != nil {
				return err
			}
			return runDesktopMigrateStatus(cmd.Context(), deskCfg.DBPath, stdout)
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
				return printDesktopVersion(stdout)
			}
			_, loadedPath, _, err := loadDesktopConfig(cmd.Flags(), configFile, getenv)
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
				return printDesktopVersion(stdout)
			}
			cfg, _, _, err := loadDesktopConfig(cmd.Flags(), configFile, getenv)
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
		Short: "Print vibe-desktop version",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return printDesktopVersion(stdout)
		},
	}

	migrateCmd.AddCommand(migrateUpCmd, migrateDownCmd, migrateStatusCmd)
	configCmd.AddCommand(configCheckCmd, configPrintCmd)
	rootCmd.AddCommand(runCmd, checkCmd, migrateCmd, configCmd, versionCmd)
	return rootCmd
}

func printDesktopVersion(stdout io.Writer) error {
	_, err := fmt.Fprintf(stdout, "vibe-desktop %s\n", desktopVersion)
	return err
}

func loadDesktopConfig(flags *pflag.FlagSet, configFile string, getenv func(string) string) (*config.AppConfig, string, DesktopConfig, error) {
	cfg, loadedPath, err := config.Load(config.LoadOptions{
		ConfigFile: configFile,
		Getenv:     getenv,
		FlagSet:    flags,
		FlagKeyMap: desktopFlagKeyMap,
	})
	if err != nil {
		return nil, "", DesktopConfig{}, err
	}

	repoRoots := make([]string, 0, len(cfg.Desktop.RepoRoots))
	for _, r := range cfg.Desktop.RepoRoots {
		if trimmed := strings.TrimSpace(r); trimmed != "" {
			repoRoots = append(repoRoots, trimmed)
		}
	}

	dbExplicit := (flags != nil && flags.Changed("db")) || strings.TrimSpace(getenv("VIBE_DB_PATH")) != ""
	deskCfg := DesktopConfig{
		ServerURL:        cfg.Desktop.ServerURL,
		WebDistDir:       cfg.Desktop.WebDist,
		WebScheme:        cfg.Desktop.Scheme,
		HomeDir:          cfg.HomeDir,
		ControlSocket:    strings.TrimSpace(getenv("VIBEVALLEY_DESKTOP_SOCKET")),
		AutomationSocket: cfg.Desktop.AutomationSocket,
		RepoRoots:        repoRoots,
		HeadlessCheck:    cfg.Desktop.HeadlessCheck,
		RootKeyID:        cfg.Desktop.RootKeyID,
		KeychainService:  cfg.Desktop.KeychainService,
		DBPath:           cfg.Desktop.DBPath,
		dbExplicit:       dbExplicit,
	}
	return cfg, loadedPath, deskCfg, nil
}

func executeDesktop(ctx context.Context, flags *pflag.FlagSet, configFile string, getenv func(string) string, stdout io.Writer, deps DesktopDeps, forceHeadlessCheck bool) error {
	_, _, deskCfg, err := loadDesktopConfig(flags, configFile, getenv)
	if err != nil {
		return err
	}
	if forceHeadlessCheck {
		deskCfg.HeadlessCheck = true
	}

	app, err := NewDesktopApp(ctx, deskCfg, deps)
	if err != nil {
		return err
	}
	defer func() { _ = app.Close() }()

	if deskCfg.HeadlessCheck {
		return app.RunHeadlessCheck(ctx, stdout)
	}
	return app.RunGUI(ctx)
}

// NewDesktopApp initializes all desktop subsystems cleanly without starting the GUI event loop.
func NewDesktopApp(ctx context.Context, cfg DesktopConfig, deps DesktopDeps) (*DesktopApp, error) {
	if cfg.WebScheme == "" {
		cfg.WebScheme = defaultWebScheme
	}
	if cfg.RootKeyID == "" {
		cfg.RootKeyID = "desktop-master-v1"
	}
	if cfg.KeychainService == "" {
		cfg.KeychainService = defaultKeychainService
	}

	execPath := strings.TrimSpace(deps.ExecPath)
	if execPath == "" {
		if exe, exeErr := os.Executable(); exeErr == nil {
			execPath = exe
		}
	}
	cwd := strings.TrimSpace(deps.WorkDir)
	if cwd == "" {
		if wd, wdErr := os.Getwd(); wdErr == nil {
			cwd = wd
		}
	}
	if !cfg.HeadlessCheck && strings.TrimSpace(cfg.WebDistDir) == "" && deps.EmbeddedWebFS == nil {
		cfg.WebDistDir = ResolveBundledWebDist(cfg.WebDistDir, execPath, cwd)
	}

	assetFS, err := NewWebAssetFS(cfg.WebDistDir, deps.EmbeddedWebFS)
	if err != nil {
		return nil, err
	}
	webHandler, err := NewWebAssetHandler(assetFS)
	if err != nil {
		return nil, err
	}

	keyDriver := deps.Keychain
	if keyDriver == nil {
		if cfg.HeadlessCheck {
			keyDriver = NewMemoryKeychainDriver()
		} else {
			keyDriver = NewPlatformKeychainDriver()
		}
	}
	keyStore := NewVaultRootKeyStore(cfg.KeychainService, keyDriver)
	rootKey, _, err := keyStore.EnsureRootKey(ctx, cfg.RootKeyID)
	if err != nil {
		return nil, fmt.Errorf("vault root key: %w", err)
	}

	launcher := deps.StackLauncher
	if launcher == nil {
		launcher = defaultStackLauncher
	}
	var stack EmbeddedStack
	if launcher != nil {
		stack, err = launcher(ctx, cfg, rootKey)
		if err != nil {
			return nil, fmt.Errorf("embedded stack launcher: %w", err)
		}
		if stack != nil && cfg.ServerURL == "" && stack.ServerURL() != "" {
			cfg.ServerURL = stack.ServerURL()
		}
	}

	transport := NewBridgeTransport(BridgeTransportOptions{})
	bridge := NewChordBridge(transport)
	terms := NewTerminalController(deps.TerminalFactory, cfg.RepoRoots...)

	island := NewIslandController(IslandOptions{
		UseLiquidGlass: deps.LiquidGlass,
	})
	if stack != nil {
		island.SetHandlers(IslandHandlers{
			OnApproval: func(prompt contract.ApprovalPromptView, approved bool) {
				_ = stack.ResolveApproval(ctx, prompt, approved)
			},
			OnBudgetRaise: func(alert BudgetAlert, newMax int64) {
				if stack.RaiseBudget(ctx, alert, newMax) == nil {
					island.ClearBudget(alert.ID)
				}
			},
		})
	}

	webCfg := WebViewConfig{
		Scheme:    cfg.WebScheme,
		Host:      "localhost",
		DiskDir:   cfg.WebDistDir,
		ServerURL: cfg.ServerURL,
		PreloadJS: ChordBridgePreloadScript(),
	}
	auto := NewAutomationEndpoint(island, terms, webCfg)
	host := NewDesktopHostService(island, terms, DesktopHostConfig{
		Version:          desktopVersion,
		Channel:          defaultChannel,
		ServerURL:        cfg.ServerURL,
		BasePageURL:      WorkbenchURL(webCfg),
		HomeDir:          cfg.HomeDir,
		RepoRoots:        cfg.RepoRoots,
		HasEmbeddedStack: stack != nil,
		ExecPath:         execPath,
		WorkDir:          cwd,
	})

	app := &DesktopApp{
		Config:     cfg,
		RootKey:    rootKey,
		KeyStore:   keyStore,
		Island:     island,
		Bridge:     bridge,
		WebHandler: webHandler,
		WebConfig:  webCfg,
		Terminals:  terms,
		Host:       host,
		Automation: auto,
		Stack:      stack,
	}
	app.detachStack = attachEmbeddedStackToApp(app)
	if app.Stack != nil {
		serverURL := app.Config.ServerURL
		if serverURL == "" {
			serverURL = app.Stack.ServerURL()
		}
		host.SyncStack(true, serverURL)
	}

	if cfg.AutomationSocket != "" && cfg.HeadlessCheck {
		ln, done, err := auto.ListenUnix(ctx, cfg.AutomationSocket)
		if err != nil {
			_ = app.Close()
			return nil, err
		}
		app.autoLn = ln
		app.autoDone = done
	}

	return app, nil
}

// RunHeadlessCheck runs deterministic self-checks across all desktop subsystems without opening windows.
func (a *DesktopApp) RunHeadlessCheck(ctx context.Context, out io.Writer) error {
	snap, err := a.Automation.Inspect(ctx)
	if err != nil {
		return err
	}
	if snap.FramePending {
		return errors.New("headless-check: island view failed to settle")
	}
	if a.Bridge.Ping(ctx) != "pong" {
		return errors.New("headless-check: chord bridge ping failed")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "/", nil)
	if err != nil {
		return err
	}
	rec := &headlessResponseRecorder{header: make(http.Header)}
	a.WebHandler.ServeHTTP(rec, req)
	if rec.code != http.StatusOK {
		return fmt.Errorf("headless-check: web handler returned status %d", rec.code)
	}
	payload := map[string]any{
		"ok":           true,
		"version":      desktopVersion,
		"webUrl":       snap.WebURL,
		"rootKeyId":    a.RootKey.ID(),
		"coldInitMs":   float64(a.Island.ColdInitDuration().Microseconds()) / 1000.0,
		"framePending": snap.FramePending,
		"uiNodes":      len(snap.Nodes),
	}
	return json.NewEncoder(out).Encode(payload)
}

type headlessResponseRecorder struct {
	header http.Header
	code   int
}

func (r *headlessResponseRecorder) Header() http.Header { return r.header }
func (r *headlessResponseRecorder) Write(p []byte) (int, error) {
	if r.code == 0 {
		r.code = http.StatusOK
	}
	return len(p), nil
}
func (r *headlessResponseRecorder) WriteHeader(statusCode int) {
	if r.code == 0 {
		r.code = statusCode
	}
}

// RunGUI registers MyGo IPC/scheme handlers, creates the Workbench & Notch Island windows, and runs App.Run.
func (a *DesktopApp) RunGUI(ctx context.Context) error {
	if err := RegisterChordBridge(a.Bridge); err != nil {
		return err
	}
	if a.Host != nil {
		if err := RegisterDesktopHost(a.Host); err != nil {
			return err
		}
	}
	if err := RegisterWebProtocol(a.WebConfig.Scheme, a.WebHandler); err != nil {
		return err
	}

	mygo.App.SetName("VibeValley")
	mygo.App.WhenReady(func() {
		displayWidth := mygo.Screen.PrimaryDisplay().Bounds.Width
		mainWin := mygo.NewWindow(WorkbenchWindowOptions(a.WebConfig))
		a.Bridge.ServerTransport().AttachWindow(mainWin)
		if a.Host != nil {
			a.Host.AttachWindow(mainWin)
			_ = a.Host.RegisterVoiceShortcut()
		}

		islandWin := mygo.NewWindow(a.Island.WindowOptions(displayWidth))
		a.Island.SetWindow(islandWin)

		if a.Config.AutomationSocket != "" {
			ln, done, err := a.Automation.ListenUnix(ctx, a.Config.AutomationSocket)
			if err == nil {
				a.autoLn = ln
				a.autoDone = done
			}
		}
		if a.Host != nil {
			ctrlSock := a.Config.ControlSocket
			if ctrlSock == "" && a.Config.HomeDir != "" {
				ctrlSock = filepath.Join(a.Config.HomeDir, "desktop.sock")
			}
			if ctrlSock != "" {
				ln, done, err := a.Host.ListenControlUnix(ctx, ctrlSock)
				if err == nil {
					a.ctrlLn = ln
					a.ctrlDone = done
				}
			}
		}
	})
	mygo.App.OnQuit(func() {
		_ = a.Close()
	})
	return mygo.App.Run()
}

// Close releases all desktop subsystems, terminals, embedded stack, and automation listeners.
func (a *DesktopApp) Close() error {
	var closeErr error
	a.closeOnce.Do(func() {
		if a.autoLn != nil {
			_ = a.autoLn.Close()
		}
		if a.autoDone != nil {
			<-a.autoDone
		}
		if a.ctrlLn != nil {
			_ = a.ctrlLn.Close()
		}
		if a.ctrlDone != nil {
			<-a.ctrlDone
		}
		if a.Host != nil {
			a.Host.Close()
		}
		if err := a.Terminals.CloseAll(); err != nil && closeErr == nil {
			closeErr = err
		}
		if a.detachStack != nil {
			a.detachStack()
		}
		if err := a.Bridge.Close(); err != nil && closeErr == nil {
			closeErr = err
		}
		if a.Stack != nil {
			if err := a.Stack.Close(); err != nil && closeErr == nil {
				closeErr = err
			}
		}
	})
	return closeErr
}
