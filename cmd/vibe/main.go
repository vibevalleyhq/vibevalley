package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/vibevalleyhq/vibevalley/internal/config"
)

const vibeVersion = "0.1.0-dev"

type resolvedEnv struct {
	HomeDir      string
	ServerURL    string
	ServerSource string
	Token        string
	TokenSource  string
	Config       *config.AppConfig
}

type appRuntime struct {
	getenv     func(string) string
	stdin      io.Reader
	stdout     io.Writer
	stderr     io.Writer
	httpClient *http.Client

	configFile string
	serverFlag string
	tokenFlag  string
	dryRun     bool
	formatFlag string
	jsonOut    bool
}

type dryRunPlan struct {
	DryRun bool   `json:"dryRun"`
	Method string `json:"method"`
	Path   string `json:"path"`
	Body   any    `json:"body,omitempty"`
}

func (rt *appRuntime) isJSON() bool {
	return rt.jsonOut || strings.EqualFold(strings.TrimSpace(rt.formatFlag), "json")
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Stderr, os.Getenv, nil); err != nil {
		fmt.Fprintf(os.Stderr, "vibe: %v\n", err)
		os.Exit(1)
	}
}

func run(
	ctx context.Context,
	args []string,
	stdin io.Reader,
	stdout, stderr io.Writer,
	getenv func(string) string,
	httpClient *http.Client,
) error {
	rt := &appRuntime{
		getenv:     getenv,
		stdin:      stdin,
		stdout:     stdout,
		stderr:     stderr,
		httpClient: httpClient,
	}
	if rt.getenv == nil {
		rt.getenv = os.Getenv
	}
	if rt.stdin == nil {
		rt.stdin = os.Stdin
	}
	if rt.stdout == nil {
		rt.stdout = os.Stdout
	}
	if rt.stderr == nil {
		rt.stderr = os.Stderr
	}
	if rt.httpClient == nil {
		rt.httpClient = &http.Client{Timeout: 30 * time.Second}
	}

	rootCmd := newRootCommand(rt)
	if args == nil {
		args = []string{}
	}
	rootCmd.SetArgs(args)
	err := rootCmd.ExecuteContext(ctx)
	if err != nil && rt.isJSON() {
		rt.writeJSONError(err)
	}
	return err
}

func newRootCommand(rt *appRuntime) *cobra.Command {
	rootCmd := &cobra.Command{
		Use:           "vibe",
		Short:         "VibeValley domain command-line interface",
		Version:       vibeVersion,
		SilenceUsage:  true,
		SilenceErrors: true,
		PersistentPreRunE: func(_ *cobra.Command, _ []string) error {
			if rt.jsonOut {
				rt.formatFlag = "json"
				return nil
			}
			f := strings.ToLower(strings.TrimSpace(rt.formatFlag))
			if f == "" {
				f = "text"
			}
			if f != "text" && f != "json" {
				return fmt.Errorf("invalid --format %q (expected text or json)", rt.formatFlag)
			}
			rt.formatFlag = f
			return nil
		},
	}
	rootCmd.SetOut(rt.stdout)
	rootCmd.SetErr(rt.stderr)
	rootCmd.SetVersionTemplate("vibe {{.Version}}\n")

	pflags := rootCmd.PersistentFlags()
	pflags.StringVarP(&rt.configFile, "config", "c", "", "path to vibevalley.yaml config file (or VIBE_CONFIG)")
	pflags.StringVar(&rt.serverFlag, "server", "", "control-plane server URL")
	pflags.StringVar(&rt.tokenFlag, "token", "", "bearer authentication token")
	pflags.BoolVar(&rt.dryRun, "dry-run", false, "preview mutating requests without executing them")
	pflags.StringVar(&rt.formatFlag, "format", "text", "output format (text|json)")
	pflags.BoolVar(&rt.jsonOut, "json", false, "output machine-readable JSON (overrides --format)")

	versionCmd := &cobra.Command{
		Use:   "version",
		Short: "Print vibe CLI version",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return rt.writeOutput(
				map[string]string{"name": "vibe", "version": vibeVersion},
				func() string { return "vibe " + vibeVersion },
			)
		},
	}

	rootCmd.AddCommand(
		newIssueCommand(rt),
		newRepoCommand(rt),
		newAgentCommand(rt),
		newSessionCommand(rt),
		newRuntimeCommand(rt),
		newMemoryCommand(rt),
		newCronCommand(rt),
		newArtifactCommand(rt),
		newWorkerCommand(rt),
		newChannelCommand(rt),
		newPKMCommand(rt),
		newAuthCommand(rt),
		newDoctorCommand(rt),
		newAppCommand(rt),
		newChatCommand(rt),
		versionCmd,
	)
	return rootCmd
}

func (rt *appRuntime) resolve() (resolvedEnv, error) {
	cfg, _, err := config.Load(config.LoadOptions{
		ConfigFile: rt.configFile,
		Getenv:     rt.getenv,
	})
	if err != nil {
		return resolvedEnv{}, err
	}

	homeDir := cfg.HomeDir
	serverURL, serverSrc := discoverServerURL(rt.serverFlag, rt.getenv, homeDir, cfg)
	token, tokenSrc := discoverToken(rt.tokenFlag, rt.getenv, homeDir, serverURL)

	return resolvedEnv{
		HomeDir:      homeDir,
		ServerURL:    serverURL,
		ServerSource: serverSrc,
		Token:        token,
		TokenSource:  tokenSrc,
		Config:       cfg,
	}, nil
}

func (rt *appRuntime) newClient() (*Client, resolvedEnv, error) {
	env, err := rt.resolve()
	if err != nil {
		return nil, resolvedEnv{}, err
	}
	return &Client{
		BaseURL: env.ServerURL,
		Token:   env.Token,
		HTTP:    rt.httpClient,
	}, env, nil
}

func (rt *appRuntime) writeJSON(v any) error {
	if raw, ok := v.(json.RawMessage); ok && len(bytes.TrimSpace(raw)) > 0 {
		var buf bytes.Buffer
		if err := json.Indent(&buf, bytes.TrimSpace(raw), "", "  "); err == nil {
			buf.WriteByte('\n')
			_, wErr := rt.stdout.Write(buf.Bytes())
			return wErr
		}
	}
	enc := json.NewEncoder(rt.stdout)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func (rt *appRuntime) writeOutput(jsonVal any, textFn func() string) error {
	if rt.isJSON() {
		return rt.writeJSON(jsonVal)
	}
	text := strings.TrimRight(textFn(), "\n")
	if text == "" {
		return nil
	}
	_, err := fmt.Fprintln(rt.stdout, text)
	return err
}

func (rt *appRuntime) writeDryRun(method, path string, body any) error {
	plan := dryRunPlan{
		DryRun: true,
		Method: method,
		Path:   path,
		Body:   body,
	}
	return rt.writeOutput(plan, func() string {
		var b strings.Builder
		fmt.Fprintf(&b, "DRY RUN: %s %s", method, path)
		if body != nil {
			encoded, err := json.MarshalIndent(body, "", "  ")
			if err == nil && len(encoded) > 0 && string(encoded) != "null" {
				b.WriteByte('\n')
				b.Write(encoded)
			}
		}
		return b.String()
	})
}

func (rt *appRuntime) callMutate(ctx context.Context, op string, reqBody, dst any) (json.RawMessage, bool, error) {
	if rt.dryRun {
		return nil, true, rt.writeDryRun(http.MethodPost, opPath(op), reqBody)
	}
	client, _, err := rt.newClient()
	if err != nil {
		return nil, false, err
	}
	raw, err := client.Call(ctx, op, reqBody, dst)
	return raw, false, err
}

func (rt *appRuntime) callMutateWithFallback(ctx context.Context, primaryOp, fallbackOp string, primaryBody, fallbackBody, dst any) (json.RawMessage, bool, error) {
	if rt.dryRun {
		return nil, true, rt.writeDryRun(http.MethodPost, opPath(primaryOp), primaryBody)
	}
	client, _, err := rt.newClient()
	if err != nil {
		return nil, false, err
	}
	raw, err := client.CallWithFallback(ctx, primaryOp, fallbackOp, primaryBody, fallbackBody, dst)
	return raw, false, err
}

func (rt *appRuntime) writeJSONError(err error) {
	payload := map[string]any{"message": err.Error()}
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		payload["bizCode"] = apiErr.BizCode
		payload["status"] = apiErr.HTTPStatus
		if apiErr.Op != "" {
			payload["op"] = apiErr.Op
		}
		if apiErr.Message != "" {
			payload["message"] = apiErr.Message
		}
		if apiErr.ErrorDetail != nil {
			payload["detail"] = apiErr.ErrorDetail
		}
	}
	b, mErr := json.Marshal(map[string]any{"error": payload})
	if mErr == nil {
		_, _ = fmt.Fprintf(rt.stderr, "%s\n", b)
	}
}

func (rt *appRuntime) readAllStdin() (string, error) {
	if rt.stdin == nil {
		return "", nil
	}
	if f, ok := rt.stdin.(*os.File); ok {
		if info, err := f.Stat(); err == nil && (info.Mode()&os.ModeCharDevice) != 0 {
			return "", nil
		}
	}
	b, err := io.ReadAll(io.LimitReader(rt.stdin, 2<<20))
	if err != nil {
		return "", err
	}
	return string(b), nil
}
