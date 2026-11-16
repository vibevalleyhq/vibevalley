package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"

	"github.com/egoist/mygo"
	"github.com/vibevalleyhq/vibevalley/internal/vault"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/link"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/watch"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

const desktopVersion = "0.1.0-dev"

type stringListFlag []string

func (s *stringListFlag) String() string { return strings.Join(*s, ",") }

func (s *stringListFlag) Set(val string) error {
	for part := range strings.SplitSeq(val, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			*s = append(*s, trimmed)
		}
	}
	return nil
}

// DesktopConfig holds parsed CLI and environment configuration for vibe-desktop.
type DesktopConfig struct {
	ServerURL        string
	WebDistDir       string
	WebScheme        string
	AutomationSocket string
	RepoRoots        []string
	HeadlessCheck    bool
	ShowVersion      bool
	RootKeyID        string
	KeychainService  string
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
	Automation *AutomationEndpoint
	Stack      EmbeddedStack

	closeOnce sync.Once
	autoLn    io.Closer
	autoDone  <-chan struct{}
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr, DesktopDeps{LiquidGlass: true}); err != nil {
		fmt.Fprintf(os.Stderr, "vibe-desktop: %v\n", err)
		os.Exit(1)
	}
}

func parseCLI(args []string, getenv func(string) string, stderr io.Writer) (DesktopConfig, error) {
	fsFlags := flag.NewFlagSet("vibe-desktop", flag.ContinueOnError)
	fsFlags.SetOutput(stderr)

	var (
		cfg       DesktopConfig
		repoRoots stringListFlag
	)
	fsFlags.StringVar(&cfg.ServerURL, "server", strings.TrimSpace(getenv("VIBE_SERVER_URL")), "remote or local control-plane server URL")
	fsFlags.StringVar(&cfg.WebDistDir, "web-dist", strings.TrimSpace(getenv("VIBE_WEB_DIST")), "path to built apps/web/dist directory")
	fsFlags.StringVar(&cfg.WebScheme, "scheme", defaultWebScheme, "custom MyGo URL scheme for workbench assets")
	fsFlags.StringVar(&cfg.AutomationSocket, "automation-socket", strings.TrimSpace(getenv("MYGO_AUTOMATION")), "optional Unix domain socket path for automation endpoint")
	fsFlags.Var(&repoRoots, "repo-root", "allowed repository/worktree root path for terminal sessions (repeatable)")
	fsFlags.BoolVar(&cfg.HeadlessCheck, "headless-check", false, "verify island, IPC, webview assets, keychain, and automation without opening windows")
	fsFlags.BoolVar(&cfg.ShowVersion, "version", false, "print version and exit")
	fsFlags.StringVar(&cfg.RootKeyID, "root-key-id", "desktop-master-v1", "Vault root key identifier stored in system keychain")
	fsFlags.StringVar(&cfg.KeychainService, "keychain-service", defaultKeychainService, "system keychain service namespace")

	if err := fsFlags.Parse(args); err != nil {
		return DesktopConfig{}, err
	}
	cfg.RepoRoots = []string(repoRoots)
	return cfg, nil
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
		if cfg.ServerURL == "" && stack.ServerURL() != "" {
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
				_ = stack.RaiseBudget(ctx, alert, newMax)
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

	app := &DesktopApp{
		Config:     cfg,
		RootKey:    rootKey,
		KeyStore:   keyStore,
		Island:     island,
		Bridge:     bridge,
		WebHandler: webHandler,
		WebConfig:  webCfg,
		Terminals:  terms,
		Automation: auto,
		Stack:      stack,
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
	rec := httptest.NewRecorder()
	a.WebHandler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		return fmt.Errorf("headless-check: web handler returned status %d", rec.Code)
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

// RunGUI registers MyGo IPC/scheme handlers, creates the Workbench & Notch Island windows, and runs App.Run.
func (a *DesktopApp) RunGUI(ctx context.Context) error {
	if err := RegisterChordBridge(a.Bridge); err != nil {
		return err
	}
	if err := RegisterWebProtocol(a.WebConfig.Scheme, a.WebHandler); err != nil {
		return err
	}

	mygo.App.SetName("VibeValley")
	mygo.App.WhenReady(func() {
		displayWidth := mygo.Screen.PrimaryDisplay().Bounds.Width
		mainWin := mygo.NewWindow(WorkbenchWindowOptions(a.WebConfig))
		a.Bridge.ServerTransport().AttachWindow(mainWin)

		islandWin := mygo.NewWindow(a.Island.WindowOptions(displayWidth))
		a.Island.SetWindow(islandWin)

		if a.Config.AutomationSocket != "" {
			ln, done, err := a.Automation.ListenUnix(ctx, a.Config.AutomationSocket)
			if err == nil {
				a.autoLn = ln
				a.autoDone = done
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
		if err := a.Terminals.CloseAll(); err != nil && closeErr == nil {
			closeErr = err
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

func run(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer, deps DesktopDeps) error {
	cfg, err := parseCLI(args, getenv, stderr)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if cfg.ShowVersion {
		_, err := fmt.Fprintf(stdout, "vibe-desktop %s\n", desktopVersion)
		return err
	}

	app, err := NewDesktopApp(ctx, cfg, deps)
	if err != nil {
		return err
	}
	defer app.Close()

	if cfg.HeadlessCheck {
		return app.RunHeadlessCheck(ctx, stdout)
	}
	return app.RunGUI(ctx)
}
